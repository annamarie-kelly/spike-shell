// workstore.rs — the Company OS work store: durable entities, their aliases,
// relationships, facts, and interactions, plus the FTS5 index that makes `@`
// resolve without a model call.
//
// OWNER: company-os. See `docs/plans/company-os-work-kernel-recon.md` for why
// this is a NEW module rather than an extension of datatable.rs.
//
// ── What lives here, and what deliberately does not ──────────────────────────
// This is the first slice: the *spine* of the work kernel — the part that has to
// exist before `@Amy` can resolve to a real object. Entities, aliases,
// relationships, facts, interactions. Not here yet, on purpose: WorkItem, Run,
// the ActionEvent ledger, verification contracts, acceptance. Those arrive once
// the `@` flow has proved it earns them.
//
// ── Storage ──────────────────────────────────────────────────────────────────
// One database, `~/.spike/work/work.db`. Not a file per project (work spans
// repos), not a sibling of the user's documents (different lifecycle), not the
// per-table `.spiketable` pattern datatable.rs uses (those are user documents;
// this is Spike's own state).
//
// Conventions here differ from datatable.rs ON PURPOSE, and the differences are
// the point:
//   • schema changes go through a numbered migration runner keyed on
//     `PRAGMA user_version`, applied in a transaction — never a bare
//     `ALTER TABLE` with the error swallowed;
//   • `PRAGMA foreign_keys = ON` on every connection, so a dangling alias or
//     interaction is a write error rather than a silent orphan;
//   • one long-lived connection behind a Mutex in AppState, not a fresh
//     `Connection::open` per command.
//
// ── Scope and visibility ─────────────────────────────────────────────────────
// Every row carries `workspace_id` (the durable `ws_…` from fs_ops::ensure_ws_id,
// NOT the frontend's counter) and every entity carries `visibility`. The filter
// is applied INSIDE the ranking query rather than to its results, so a hidden or
// out-of-scope entity cannot leak through result counts, ordering, or timing.
// That is the whole of the authority model today — one local user, workspace
// scope, an explicit hide. It is smaller than a real ACL and says so.
//
// ── Idempotency ──────────────────────────────────────────────────────────────
// Imports are re-runnable. Every entity and interaction has a `natural_key`
// unique within its workspace, so importing the same CSV twice updates in place
// instead of duplicating. That is what lets a person re-import a spreadsheet
// they just edited without curating the store by hand.

use std::collections::HashMap;
use std::path::PathBuf;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};

use crate::fs_ops::now_parts;

// ── ids ──────────────────────────────────────────────────────────────────────

/// `<prefix>_<ms base36>_<random base36>`. Same shape and rationale as
/// fs_ops::mint_ws_id: sortable by mint time, unique without a new dependency.
fn mint_id(prefix: &str) -> String {
    use std::hash::{BuildHasher, Hasher};
    fn base36(mut n: u128) -> String {
        const D: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
        if n == 0 {
            return "0".into();
        }
        let mut out = Vec::new();
        while n > 0 {
            out.push(D[(n % 36) as usize]);
            n /= 36;
        }
        out.reverse();
        String::from_utf8(out).unwrap_or_default()
    }
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let rand = std::collections::hash_map::RandomState::new()
        .build_hasher()
        .finish();
    format!("{prefix}_{}_{}", base36(ms), base36(rand as u128))
}

// ── normalization ────────────────────────────────────────────────────────────

/// The key an import matches on: lowercased, punctuation-stripped, whitespace
/// collapsed. `"Sarah Guo"`, `"sarah  guo"`, and `"Sarah Guo."` are one person.
///
/// Deliberately NOT clever. No nickname table, no fuzzy distance, no "S. Guo"
/// handling — the spec's rule is that Spike never silently merges two things
/// that might be different people, and every unit of cleverness here is a unit
/// of silent merging. Ambiguity is surfaced at lookup time instead.
pub(crate) fn normalize_key(s: &str) -> String {
    let mut out = String::new();
    let mut prev_space = true; // leading space is skipped
    for c in s.trim().chars() {
        if c.is_alphanumeric() {
            for lc in c.to_lowercase() {
                out.push(lc);
            }
            prev_space = false;
        } else if !prev_space {
            out.push(' ');
            prev_space = true;
        }
    }
    out.trim_end().to_string()
}

/// A company name stripped of its legal suffix, so `Acme, Inc.` also answers to
/// `Acme`. Returns None when stripping would leave nothing (or change nothing).
pub(crate) fn short_company_name(name: &str) -> Option<String> {
    const SUFFIXES: &[&str] = &[
        "inc", "inc.", "llc", "l.l.c.", "ltd", "ltd.", "limited", "corp", "corp.",
        "corporation", "co", "co.", "company", "gmbh", "plc", "partners",
        "ventures", "capital", "holdings", "group", "labs", "technologies",
    ];
    let cleaned = name.trim().trim_end_matches(|c: char| c == '.' || c == ',');
    let words: Vec<&str> = cleaned.split_whitespace().collect();
    if words.len() < 2 {
        return None;
    }
    let last = words[words.len() - 1].to_lowercase();
    if !SUFFIXES.contains(&last.as_str()) {
        return None;
    }
    let short = words[..words.len() - 1]
        .join(" ")
        .trim_end_matches(',')
        .to_string();
    if short.trim().is_empty() {
        None
    } else {
        Some(short)
    }
}

// ── schema ───────────────────────────────────────────────────────────────────

/// Numbered, forward-only migrations. Append; never edit a shipped entry.
/// Each runs inside a transaction and bumps `user_version` on success, so a
/// half-applied schema is not a reachable state.
const MIGRATIONS: &[&str] = &[
    // 1 — the entity spine.
    r#"
    CREATE TABLE entity (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      kind         TEXT NOT NULL CHECK (kind IN ('person','company')),
      name         TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'active',
      visibility   TEXT NOT NULL DEFAULT 'normal' CHECK (visibility IN ('normal','hidden')),
      natural_key  TEXT NOT NULL,
      source       TEXT NOT NULL DEFAULT '',
      version      INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      UNIQUE (workspace_id, kind, natural_key)
    );
    CREATE INDEX entity_ws ON entity (workspace_id, visibility);

    CREATE TABLE entity_alias (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id TEXT NOT NULL REFERENCES entity (id) ON DELETE CASCADE,
      alias     TEXT NOT NULL,
      norm      TEXT NOT NULL,
      kind      TEXT NOT NULL DEFAULT 'alias' CHECK (kind IN ('canonical','alias')),
      UNIQUE (entity_id, norm)
    );
    CREATE INDEX entity_alias_norm ON entity_alias (norm);

    CREATE TABLE relationship (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      from_id      TEXT NOT NULL REFERENCES entity (id) ON DELETE CASCADE,
      to_id        TEXT NOT NULL REFERENCES entity (id) ON DELETE CASCADE,
      kind         TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      UNIQUE (from_id, to_id, kind)
    );

    CREATE TABLE entity_fact (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id  TEXT NOT NULL REFERENCES entity (id) ON DELETE CASCADE,
      key        TEXT NOT NULL,
      value      TEXT NOT NULL,
      source_ref TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      UNIQUE (entity_id, key)
    );

    CREATE TABLE interaction (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      entity_id    TEXT NOT NULL REFERENCES entity (id) ON DELETE CASCADE,
      kind         TEXT NOT NULL,
      occurred_at  TEXT NOT NULL,
      summary      TEXT NOT NULL DEFAULT '',
      source_ref   TEXT NOT NULL DEFAULT '',
      natural_key  TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      UNIQUE (workspace_id, natural_key)
    );
    CREATE INDEX interaction_entity ON interaction (entity_id, occurred_at DESC);
    "#,
    // 2 — the mention index. `remove_diacritics 2` is pinned explicitly: the
    // default (1) does not fold every case, and changing it later means
    // rebuilding the index. Triggers keep it in step with entity_alias, so no
    // write path can forget to reindex.
    r#"
    CREATE VIRTUAL TABLE mention_fts USING fts5 (
      alias,
      entity_id UNINDEXED,
      tokenize = "unicode61 remove_diacritics 2"
    );

    CREATE TRIGGER entity_alias_ai AFTER INSERT ON entity_alias BEGIN
      INSERT INTO mention_fts (rowid, alias, entity_id)
      VALUES (new.id, new.alias, new.entity_id);
    END;

    CREATE TRIGGER entity_alias_ad AFTER DELETE ON entity_alias BEGIN
      DELETE FROM mention_fts WHERE rowid = old.id;
    END;

    CREATE TRIGGER entity_alias_au AFTER UPDATE ON entity_alias BEGIN
      DELETE FROM mention_fts WHERE rowid = old.id;
      INSERT INTO mention_fts (rowid, alias, entity_id)
      VALUES (new.id, new.alias, new.entity_id);
    END;
    "#,
];

/// Apply every migration the database has not seen yet. Idempotent: running it
/// against an up-to-date database is a `user_version` read and nothing else.
pub(crate) fn migrate(conn: &mut Connection) -> Result<(), String> {
    let current: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| format!("work store: read version: {e}"))?;
    let target = MIGRATIONS.len() as i64;
    if current > target {
        // A newer Spike wrote this file. Refuse rather than run against a schema
        // we do not understand — the alternative is silent data loss.
        return Err(format!(
            "work store: database is at version {current}, this build understands {target}. \
             Update Spike."
        ));
    }
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        let tx = conn
            .transaction()
            .map_err(|e| format!("work store: begin: {e}"))?;
        tx.execute_batch(sql)
            .map_err(|e| format!("work store: migration {}: {e}", i + 1))?;
        // pragma does not accept a bound parameter
        tx.pragma_update(None, "user_version", (i + 1) as i64)
            .map_err(|e| format!("work store: set version: {e}"))?;
        tx.commit()
            .map_err(|e| format!("work store: commit migration {}: {e}", i + 1))?;
    }
    Ok(())
}

fn db_path() -> PathBuf {
    let dir = crate::state::spike_dir().join("work");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("work.db")
}

/// Open a connection with the pragmas this store depends on, and migrate it.
/// `foreign_keys` is per-connection in SQLite — it must be set here, not in a
/// migration, or constraints silently stop being enforced.
pub(crate) fn open_at(path: &std::path::Path) -> Result<Connection, String> {
    let mut conn = Connection::open(path).map_err(|e| format!("work store: open: {e}"))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| format!("work store: foreign_keys: {e}"))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("work store: wal: {e}"))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("work store: busy_timeout: {e}"))?;
    migrate(&mut conn)?;
    Ok(conn)
}

/// The process-wide store, opened lazily on first use and held open after.
/// Callers run `with_db(|conn| …)`; the lock is held for the duration of the
/// closure, which is correct for a single-user local app and keeps every write
/// serialized without a second locking scheme.
pub(crate) fn with_db<T>(
    state: &crate::state::AppState,
    f: impl FnOnce(&mut Connection) -> Result<T, String>,
) -> Result<T, String> {
    let mut slot = state
        .work
        .lock()
        .map_err(|_| "work store: lock poisoned".to_string())?;
    if slot.is_none() {
        *slot = Some(open_at(&db_path())?);
    }
    let conn = slot.as_mut().expect("just opened");
    f(conn)
}

// ── shapes returned to the frontend ──────────────────────────────────────────

/// One `@` autocomplete row. `matched_on` is what the person actually typed
/// against, so the popover can show *why* a result is there ("North Star ·
/// matched alias 'NS'") instead of an unexplained list.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MentionHit {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub matched_on: String,
    /// Disambiguating line — a person's company, a company's own summary.
    pub detail: String,
    /// Deterministic rank bucket (0 = best). Exposed so the UI can group
    /// exact matches above fuzzy ones without re-deriving the rule.
    pub rank: i64,
    /// True when another entity in scope answers to the same typed text. The
    /// popover must make these distinguishable rather than pick one.
    pub ambiguous: bool,
}

// ── mention lookup ───────────────────────────────────────────────────────────

/// Rank buckets, lowest wins. Deterministic and explainable — no scoring
/// function nobody can predict.
const RANK_EXACT_NAME: i64 = 0;
const RANK_PREFIX_NAME: i64 = 1;
const RANK_EXACT_ALIAS: i64 = 2;
const RANK_PREFIX_ALIAS: i64 = 3;
const RANK_FTS: i64 = 4;

/// Escape a user's keystrokes into a safe FTS5 prefix query. Everything that is
/// not a word character becomes whitespace, each token is quoted and suffixed
/// with `*`. Without this a stray `"` or `NEAR(` is a syntax error at best and
/// a surprise query at worst — the person is typing a name, not a query
/// language.
fn fts_prefix_query(q: &str) -> Option<String> {
    let tokens: Vec<String> = q
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{}\"*", t.replace('"', "")))
        .collect();
    if tokens.is_empty() {
        None
    } else {
        Some(tokens.join(" "))
    }
}

/// The exclusive upper bound of a prefix range: `"sar"` → `"sas"`.
///
/// Why not `LIKE 'sar%'`: SQLite's LIKE is case-insensitive for ASCII by
/// default, so the planner refuses to use a BINARY index for it and scans every
/// alias row instead. At 100k entities that measured 140ms — three times the
/// autocomplete budget. `norm` is already lowercased at write time, so a plain
/// `>= 'sar' AND < 'sas'` range is both equivalent and index-driven.
///
/// Returns None when no bound exists (a prefix at the top of the code space),
/// in which case the caller falls back to LIKE — correct, just slower, and
/// unreachable for anything a person types.
fn prefix_upper(p: &str) -> Option<String> {
    let mut chars: Vec<char> = p.chars().collect();
    while let Some(last) = chars.pop() {
        // Step past the surrogate hole rather than stopping at it.
        for next in (last as u32 + 1)..=(last as u32 + 0x800) {
            if let Some(c) = char::from_u32(next) {
                chars.push(c);
                return Some(chars.into_iter().collect());
            }
        }
    }
    None
}

/// Resolve `@`-typed text to candidate entities.
///
/// Permission scope is applied INSIDE this query (the `workspace_id` /
/// `visibility` predicates sit in the same SELECT as the match), so an entity
/// out of scope cannot influence ordering, counts, or how long the call takes.
/// No network, no model, no filesystem — one indexed local read.
pub(crate) fn lookup(
    conn: &Connection,
    workspace_id: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<MentionHit>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let norm = normalize_key(q);
    let limit = limit.clamp(1, 50);

    // Rank in SQL so ordering is decided by the same pass that applies the
    // scope filter. The prefix match is an index-driven range (see prefix_upper),
    // not a LIKE — the difference is a scan of every alias row.
    let upper = match prefix_upper(&norm) {
        Some(u) => u,
        // No representable bound: fall back to a LIKE scan rather than
        // returning nothing. Escape LIKE's own wildcards on the way.
        None => format!(
            "{}\u{10FFFF}",
            norm.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
        ),
    };

    let mut rows: Vec<(String, String, String, String, i64)> = Vec::new();
    let mut seen: HashMap<String, usize> = HashMap::new();

    // Pass 1 — exact/prefix over the normalized alias column. This is the path
    // that answers a two-keystroke `@ac`, and it never touches FTS.
    {
        let mut stmt = conn
            .prepare(
                "SELECT e.id, e.name, e.kind, a.alias,
                        CASE
                          WHEN a.kind = 'canonical' AND a.norm = ?2 THEN ?4
                          WHEN a.kind = 'canonical' THEN ?5
                          WHEN a.norm = ?2 THEN ?6
                          ELSE ?7
                        END AS rank
                   FROM entity_alias a
                   JOIN entity e ON e.id = a.entity_id
                  WHERE a.norm >= ?2 AND a.norm < ?3
                    AND e.workspace_id = ?1
                    AND e.visibility = 'normal'
                  ORDER BY rank, length(e.name), e.name
                  LIMIT ?8",
            )
            .map_err(|e| format!("work store: lookup prepare: {e}"))?;
        let mapped = stmt
            .query_map(
                params![
                    workspace_id,
                    norm,
                    upper,
                    RANK_EXACT_NAME,
                    RANK_PREFIX_NAME,
                    RANK_EXACT_ALIAS,
                    RANK_PREFIX_ALIAS,
                    limit as i64,
                ],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, i64>(4)?,
                    ))
                },
            )
            .map_err(|e| format!("work store: lookup: {e}"))?;
        for row in mapped {
            let row = row.map_err(|e| format!("work store: lookup row: {e}"))?;
            if let Some(&i) = seen.get(&row.0) {
                // Same entity matched by two aliases — keep the better rank.
                if row.4 < rows[i].4 {
                    rows[i] = row;
                }
                continue;
            }
            seen.insert(row.0.clone(), rows.len());
            rows.push(row);
        }
    }

    // Pass 2 — FTS5, for mid-name and multi-token matches ("guo", "north star")
    // that a left-anchored prefix cannot reach. Only runs if pass 1 left room,
    // so the common case never pays for it.
    if rows.len() < limit {
        if let Some(fts_q) = fts_prefix_query(q) {
            let mut stmt = conn
                .prepare(
                    "SELECT e.id, e.name, e.kind, m.alias
                       FROM mention_fts m
                       JOIN entity e ON e.id = m.entity_id
                      WHERE mention_fts MATCH ?2
                        AND e.workspace_id = ?1
                        AND e.visibility = 'normal'
                      ORDER BY bm25(mention_fts), e.name
                      LIMIT ?3",
                )
                .map_err(|e| format!("work store: fts prepare: {e}"))?;
            let mapped = stmt
                .query_map(params![workspace_id, fts_q, limit as i64], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        RANK_FTS,
                    ))
                })
                .map_err(|e| format!("work store: fts: {e}"))?;
            for row in mapped {
                let row = row.map_err(|e| format!("work store: fts row: {e}"))?;
                if seen.contains_key(&row.0) {
                    continue;
                }
                seen.insert(row.0.clone(), rows.len());
                rows.push(row);
                if rows.len() >= limit {
                    break;
                }
            }
        }
    }

    rows.truncate(limit);

    // Ambiguity: does the TYPED TEXT itself name more than one entity in scope?
    //
    // Note this is asked of the query, not of which alias happened to win the
    // ranking. "Matrix" is an exact alias of both Matrix Partners and Matrix
    // Labs even though each result is displayed under its own canonical name —
    // keying off the displayed match would call that unambiguous, which is the
    // exact silent-merge the spec forbids.
    let ambiguous_ids: std::collections::HashSet<String> = {
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT a.entity_id
                   FROM entity_alias a
                   JOIN entity e ON e.id = a.entity_id
                  WHERE a.norm = ?2
                    AND e.workspace_id = ?1
                    AND e.visibility = 'normal'",
            )
            .map_err(|e| format!("work store: ambiguity prepare: {e}"))?;
        let ids = stmt
            .query_map(params![workspace_id, norm], |r| r.get::<_, String>(0))
            .map_err(|e| format!("work store: ambiguity: {e}"))?
            .collect::<Result<std::collections::HashSet<String>, _>>()
            .map_err(|e| format!("work store: ambiguity row: {e}"))?;
        // One match is not ambiguous; only a genuine collision is.
        if ids.len() > 1 {
            ids
        } else {
            std::collections::HashSet::new()
        }
    };

    let mut out = Vec::with_capacity(rows.len());
    for (id, name, kind, matched, rank) in rows {
        let ambiguous = ambiguous_ids.contains(&id);
        let detail = detail_for(conn, &id, &kind).unwrap_or_default();
        out.push(MentionHit {
            id,
            name,
            kind,
            matched_on: matched,
            detail,
            rank,
            ambiguous,
        });
    }
    Ok(out)
}

/// The one-line disambiguator under a result: a person's company, or a
/// company's own headline fact. Cheap enough to run per visible row.
fn detail_for(conn: &Connection, entity_id: &str, kind: &str) -> Result<String, String> {
    if kind == "person" {
        let company: Option<String> = conn
            .query_row(
                "SELECT c.name
                   FROM relationship r
                   JOIN entity c ON c.id = r.to_id
                  WHERE r.from_id = ?1 AND r.kind = 'works_at' AND c.visibility = 'normal'
                  ORDER BY r.created_at
                  LIMIT 1",
                params![entity_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| format!("work store: detail: {e}"))?;
        if let Some(c) = company {
            return Ok(c);
        }
    }
    let fact: Option<String> = conn
        .query_row(
            "SELECT value FROM entity_fact
              WHERE entity_id = ?1 AND key IN ('focus','stage','role','industry')
              ORDER BY key LIMIT 1",
            params![entity_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| format!("work store: detail fact: {e}"))?;
    Ok(fact.unwrap_or_default())
}

/// The degraded path: a bounded LIKE scan used when the FTS index is missing or
/// unreadable. Still local, still bounded, still no model — the spec's rule is
/// that a broken index degrades to a smaller local lookup, never to an agent
/// search.
pub(crate) fn lookup_fallback(
    conn: &Connection,
    workspace_id: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<MentionHit>, String> {
    let norm = normalize_key(query);
    if norm.is_empty() {
        return Ok(Vec::new());
    }
    let upper = prefix_upper(&norm).unwrap_or_else(|| format!("{norm}\u{10FFFF}"));
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT e.id, e.name, e.kind
               FROM entity e
               JOIN entity_alias a ON a.entity_id = e.id
              WHERE e.workspace_id = ?1
                AND e.visibility = 'normal'
                AND a.norm >= ?2 AND a.norm < ?4
              ORDER BY length(e.name), e.name
              LIMIT ?3",
        )
        .map_err(|e| format!("work store: fallback prepare: {e}"))?;
    let rows = stmt
        .query_map(params![workspace_id, norm, limit.clamp(1, 50) as i64, upper], |r| {
            Ok(MentionHit {
                id: r.get(0)?,
                name: r.get(1)?,
                kind: r.get(2)?,
                matched_on: r.get(1)?,
                detail: String::new(),
                rank: RANK_PREFIX_ALIAS,
                ambiguous: false,
            })
        })
        .map_err(|e| format!("work store: fallback: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("work store: fallback row: {e}"))
}

// ── writes ───────────────────────────────────────────────────────────────────

/// Create or update one entity by its natural key, returning its id. The
/// canonical name is always registered as an alias, so lookup has exactly one
/// path to search rather than a name column plus an alias table that can
/// disagree.
pub(crate) fn upsert_entity(
    conn: &Connection,
    workspace_id: &str,
    kind: &str,
    name: &str,
    source: &str,
) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("entity needs a name".into());
    }
    let key = normalize_key(name);
    if key.is_empty() {
        return Err("entity name has no searchable characters".into());
    }
    let (ts, _) = now_parts();

    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM entity
              WHERE workspace_id = ?1 AND kind = ?2 AND natural_key = ?3",
            params![workspace_id, kind, key],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| format!("work store: entity lookup: {e}"))?;

    let id = match existing {
        Some(id) => {
            // Touch, don't churn: bump the version so a stale projection can be
            // detected, but keep the id every other row points at.
            conn.execute(
                "UPDATE entity SET name = ?2, updated_at = ?3, version = version + 1
                  WHERE id = ?1",
                params![id, name, ts],
            )
            .map_err(|e| format!("work store: entity update: {e}"))?;
            id
        }
        None => {
            let id = mint_id("ent");
            conn.execute(
                "INSERT INTO entity
                   (id, workspace_id, kind, name, natural_key, source, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                params![id, workspace_id, kind, name, key, source, ts],
            )
            .map_err(|e| format!("work store: entity insert: {e}"))?;
            id
        }
    };

    add_alias(conn, &id, name, "canonical")?;
    // A company also answers to its name without the legal suffix.
    if kind == "company" {
        if let Some(short) = short_company_name(name) {
            add_alias(conn, &id, &short, "alias")?;
        }
    }
    Ok(id)
}

/// Register an alias. Idempotent on (entity, normalized alias) — re-importing
/// never grows the alias list.
pub(crate) fn add_alias(
    conn: &Connection,
    entity_id: &str,
    alias: &str,
    kind: &str,
) -> Result<(), String> {
    let alias = alias.trim();
    let norm = normalize_key(alias);
    if norm.is_empty() {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO entity_alias (entity_id, alias, norm, kind)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (entity_id, norm) DO UPDATE SET
           alias = excluded.alias,
           kind  = CASE WHEN excluded.kind = 'canonical' THEN 'canonical' ELSE entity_alias.kind END",
        params![entity_id, alias, norm, kind],
    )
    .map_err(|e| format!("work store: alias: {e}"))?;
    Ok(())
}

/// Link two entities. Idempotent on (from, to, kind).
pub(crate) fn relate(
    conn: &Connection,
    workspace_id: &str,
    from_id: &str,
    to_id: &str,
    kind: &str,
) -> Result<(), String> {
    let (ts, _) = now_parts();
    conn.execute(
        "INSERT OR IGNORE INTO relationship (workspace_id, from_id, to_id, kind, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![workspace_id, from_id, to_id, kind, ts],
    )
    .map_err(|e| format!("work store: relate: {e}"))?;
    Ok(())
}

/// Set one typed fact, with the source it came from. Last write wins per key,
/// which is what makes a re-import of a corrected spreadsheet do the right thing.
pub(crate) fn set_fact(
    conn: &Connection,
    entity_id: &str,
    key: &str,
    value: &str,
    source_ref: &str,
) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(());
    }
    let (ts, _) = now_parts();
    conn.execute(
        "INSERT INTO entity_fact (entity_id, key, value, source_ref, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (entity_id, key) DO UPDATE SET
           value = excluded.value, source_ref = excluded.source_ref, updated_at = excluded.updated_at",
        params![entity_id, key, value, source_ref, ts],
    )
    .map_err(|e| format!("work store: fact: {e}"))?;
    Ok(())
}

/// Record something that happened. `natural_key` is what makes the import
/// idempotent — same entity, same kind, same date, same source row is one
/// interaction however many times it is imported.
pub(crate) fn upsert_interaction(
    conn: &Connection,
    workspace_id: &str,
    entity_id: &str,
    kind: &str,
    occurred_at: &str,
    summary: &str,
    source_ref: &str,
) -> Result<String, String> {
    let natural = format!("{entity_id}|{kind}|{occurred_at}|{}", normalize_key(summary));
    let (ts, _) = now_parts();
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM interaction WHERE workspace_id = ?1 AND natural_key = ?2",
            params![workspace_id, natural],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| format!("work store: interaction lookup: {e}"))?;
    if let Some(id) = existing {
        conn.execute(
            "UPDATE interaction SET summary = ?2, source_ref = ?3 WHERE id = ?1",
            params![id, summary, source_ref],
        )
        .map_err(|e| format!("work store: interaction update: {e}"))?;
        return Ok(id);
    }
    let id = mint_id("int");
    conn.execute(
        "INSERT INTO interaction
           (id, workspace_id, entity_id, kind, occurred_at, summary, source_ref, natural_key, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![id, workspace_id, entity_id, kind, occurred_at, summary, source_ref, natural, ts],
    )
    .map_err(|e| format!("work store: interaction insert: {e}"))?;
    Ok(id)
}

// ── reads for the context card ───────────────────────────────────────────────

/// Everything the card projector needs about one entity, as canonical rows.
/// The *shaping* of this into a card is deliberately not done here — it happens
/// in a pure TypeScript projector (src/work/card.ts) that can be unit-tested
/// without a database. This function only answers "what do the records say".
///
/// Returns None when the entity does not exist, is out of scope, or is hidden —
/// the same shape for all three, so an unauthorized caller cannot tell which.
pub(crate) fn entity_records(
    conn: &Connection,
    workspace_id: &str,
    entity_id: &str,
) -> Result<Option<Value>, String> {
    let base: Option<(String, String, String, String, i64, String)> = conn
        .query_row(
            "SELECT id, kind, name, status, version, updated_at
               FROM entity
              WHERE id = ?1 AND workspace_id = ?2 AND visibility = 'normal'",
            params![entity_id, workspace_id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            },
        )
        .optional()
        .map_err(|e| format!("work store: entity read: {e}"))?;

    let Some((id, kind, name, status, version, updated_at)) = base else {
        return Ok(None);
    };

    let mut aliases: Vec<String> = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT alias FROM entity_alias WHERE entity_id = ?1 ORDER BY kind, alias")
            .map_err(|e| format!("work store: alias read: {e}"))?;
        let rows = stmt
            .query_map(params![id], |r| r.get::<_, String>(0))
            .map_err(|e| format!("work store: alias rows: {e}"))?;
        for a in rows {
            aliases.push(a.map_err(|e| e.to_string())?);
        }
    }

    let mut facts: Vec<Value> = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT key, value, source_ref FROM entity_fact
                  WHERE entity_id = ?1 ORDER BY key",
            )
            .map_err(|e| format!("work store: fact read: {e}"))?;
        let rows = stmt
            .query_map(params![id], |r| {
                Ok(json!({
                    "key": r.get::<_, String>(0)?,
                    "value": r.get::<_, String>(1)?,
                    "sourceRef": r.get::<_, String>(2)?,
                }))
            })
            .map_err(|e| format!("work store: fact rows: {e}"))?;
        for f in rows {
            facts.push(f.map_err(|e| e.to_string())?);
        }
    }

    let mut related: Vec<Value> = Vec::new();
    {
        // Both directions, so a company sees its people and a person sees theirs.
        let mut stmt = conn
            .prepare(
                "SELECT o.id, o.name, o.kind, r.kind, CASE WHEN r.from_id = ?1 THEN 'out' ELSE 'in' END
                   FROM relationship r
                   JOIN entity o ON o.id = CASE WHEN r.from_id = ?1 THEN r.to_id ELSE r.from_id END
                  WHERE (r.from_id = ?1 OR r.to_id = ?1)
                    AND o.workspace_id = ?2
                    AND o.visibility = 'normal'
                  ORDER BY o.name",
            )
            .map_err(|e| format!("work store: rel read: {e}"))?;
        let rows = stmt
            .query_map(params![id, workspace_id], |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "name": r.get::<_, String>(1)?,
                    "kind": r.get::<_, String>(2)?,
                    "relation": r.get::<_, String>(3)?,
                    "direction": r.get::<_, String>(4)?,
                }))
            })
            .map_err(|e| format!("work store: rel rows: {e}"))?;
        for x in rows {
            related.push(x.map_err(|e| e.to_string())?);
        }
    }

    let mut interactions: Vec<Value> = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT id, kind, occurred_at, summary, source_ref FROM interaction
                  WHERE entity_id = ?1 ORDER BY occurred_at DESC, created_at DESC LIMIT 20",
            )
            .map_err(|e| format!("work store: interaction read: {e}"))?;
        let rows = stmt
            .query_map(params![id], |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "kind": r.get::<_, String>(1)?,
                    "occurredAt": r.get::<_, String>(2)?,
                    "summary": r.get::<_, String>(3)?,
                    "sourceRef": r.get::<_, String>(4)?,
                }))
            })
            .map_err(|e| format!("work store: interaction rows: {e}"))?;
        for x in rows {
            interactions.push(x.map_err(|e| e.to_string())?);
        }
    }

    Ok(Some(json!({
        "id": id,
        "kind": kind,
        "name": name,
        "status": status,
        "version": version,
        "updatedAt": updated_at,
        "aliases": aliases,
        "facts": facts,
        "related": related,
        "interactions": interactions,
    })))
}

// ── csv import ───────────────────────────────────────────────────────────────
//
// The supply line. Spike's Company OS is worthless empty, and the data a person
// already has about their relationships is almost always a spreadsheet. This
// turns one into entities, relationships, facts, and interactions — idempotently,
// so re-importing an edited sheet corrects the store instead of doubling it.
//
// What it does NOT do: guess. There is no fuzzy matching against existing
// entities beyond exact normalized-name equality, and no merging of two rows
// that look similar. A misspelled name becomes a second entity, visible and
// fixable, rather than a silent merge into the wrong person.

/// How one column is interpreted. Column intent is inferred from the header;
/// anything unrecognized becomes a plain fact under its own header name, so no
/// data is silently dropped just because we did not anticipate the column.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ColRole {
    PersonName,
    CompanyName,
    Date,
    Summary,
    Fact(String),
    Ignore,
}

/// Infer what a header column means. Deliberately a small, readable table
/// rather than anything clever — a person can read this and predict the import.
pub(crate) fn classify_header(header: &str) -> ColRole {
    let h = normalize_key(header);
    match h.as_str() {
        "" => ColRole::Ignore,
        "name" | "person" | "contact" | "full name" => ColRole::PersonName,
        "firm" | "company" | "organization" | "organisation" | "org" | "employer" => {
            ColRole::CompanyName
        }
        "meeting date" | "date" | "last contact" | "met on" => ColRole::Date,
        "biggest takeaways" | "takeaways" | "notes" | "summary" | "note" => ColRole::Summary,
        other => ColRole::Fact(other.to_string()),
    }
}

/// Normalize the many ways a spreadsheet says yes. Returns None when the value
/// is not boolean-ish, so a column of real text is never mangled into a flag.
fn boolish(v: &str) -> Option<bool> {
    match normalize_key(v).as_str() {
        "true" | "yes" | "y" | "1" | "warm" => Some(true),
        "false" | "no" | "n" | "0" | "cold" => Some(false),
        _ => None,
    }
}

/// An ISO date if the cell holds one, else None. Only `YYYY-MM-DD` is accepted:
/// guessing between `03/04/2026` as March 4th or April 3rd is exactly the kind
/// of silent wrongness this store is supposed to avoid.
fn iso_date(v: &str) -> Option<String> {
    let t = v.trim();
    let b = t.as_bytes();
    if b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[8..].iter().all(u8::is_ascii_digit)
    {
        Some(t.to_string())
    } else {
        None
    }
}

/// What an import did, for the confirmation the UI shows afterwards. Counting
/// created vs updated separately is what makes "run it twice" legible: the
/// second run should report zero created.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub source: String,
    pub rows: usize,
    pub people_created: usize,
    pub companies_created: usize,
    pub interactions: usize,
    pub facts: usize,
    pub skipped: usize,
    /// Row-level complaints, capped — a malformed sheet should explain itself
    /// without producing a thousand-line error.
    pub warnings: Vec<String>,
}

const MAX_WARNINGS: usize = 20;

/// Import one CSV into the work store. Runs in a single transaction: either the
/// whole sheet lands or none of it does, so a failure halfway through cannot
/// leave a half-described company behind.
pub(crate) fn import_csv(
    conn: &mut Connection,
    workspace_id: &str,
    path: &str,
    text: &str,
) -> Result<ImportReport, String> {
    let source = std::path::Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());

    let records = crate::datatable::parse_csv(text);
    let mut report = ImportReport {
        source: source.clone(),
        ..Default::default()
    };
    let Some(headers) = records.first() else {
        return Err("empty file".into());
    };
    let roles: Vec<ColRole> = headers.iter().map(|h| classify_header(h)).collect();

    if !roles.iter().any(|r| matches!(r, ColRole::PersonName | ColRole::CompanyName)) {
        return Err(
            "no name column found — expected a header like Name, Person, Company, or Firm".into(),
        );
    }

    let tx = conn
        .transaction()
        .map_err(|e| format!("work store: import begin: {e}"))?;

    for (i, row) in records.iter().enumerate().skip(1) {
        // `#N` is the spreadsheet row number a person would see, header included.
        let source_ref = format!("{source}#{}", i + 1);
        report.rows += 1;

        let cell = |role: &ColRole| -> Option<&str> {
            roles
                .iter()
                .position(|r| r == role)
                .and_then(|idx| row.get(idx))
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
        };

        let person_name = cell(&ColRole::PersonName);
        let company_name = cell(&ColRole::CompanyName);

        if person_name.is_none() && company_name.is_none() {
            report.skipped += 1;
            continue;
        }

        // The entity the row's facts hang off: the person when there is one,
        // otherwise the company.
        let mut subject: Option<String> = None;
        let mut company_id: Option<String> = None;

        if let Some(name) = company_name {
            let existed = entity_exists(&tx, workspace_id, "company", name)?;
            let id = upsert_entity(&tx, workspace_id, "company", name, &source_ref)?;
            if !existed {
                report.companies_created += 1;
            }
            company_id = Some(id);
        }
        if let Some(name) = person_name {
            let existed = entity_exists(&tx, workspace_id, "person", name)?;
            let id = upsert_entity(&tx, workspace_id, "person", name, &source_ref)?;
            if !existed {
                report.people_created += 1;
            }
            if let Some(c) = &company_id {
                relate(&tx, workspace_id, &id, c, "works_at")?;
            }
            subject = Some(id);
        }
        let subject = match subject.or(company_id.clone()) {
            Some(s) => s,
            None => {
                report.skipped += 1;
                continue;
            }
        };

        // Facts: every column we did not spend on identity or the interaction.
        for (idx, role) in roles.iter().enumerate() {
            let ColRole::Fact(key) = role else { continue };
            let Some(raw) = row.get(idx).map(|s| s.trim()).filter(|s| !s.is_empty()) else {
                continue;
            };
            // Store booleans in one canonical form so a card can rely on them.
            let value = match boolish(raw) {
                Some(true) => "yes".to_string(),
                Some(false) => "no".to_string(),
                None => raw.to_string(),
            };
            set_fact(&tx, &subject, key, &value, &source_ref)?;
            report.facts += 1;
        }

        // An interaction, when the row carries a date. A takeaway with no date
        // is a fact about the relationship, not an event in it — so it is kept
        // as a fact rather than being stamped with a date we invented.
        let date_cell = cell(&ColRole::Date);
        let summary = cell(&ColRole::Summary).unwrap_or_default();
        match date_cell {
            Some(d) => match iso_date(d) {
                Some(iso) => {
                    upsert_interaction(
                        &tx,
                        workspace_id,
                        &subject,
                        "meeting",
                        &iso,
                        summary,
                        &source_ref,
                    )?;
                    report.interactions += 1;
                }
                None => {
                    if report.warnings.len() < MAX_WARNINGS {
                        report.warnings.push(format!(
                            "{source_ref}: date {d:?} is not YYYY-MM-DD — imported as a fact, not a meeting"
                        ));
                    }
                    set_fact(&tx, &subject, "date", d, &source_ref)?;
                    report.facts += 1;
                }
            },
            None => {
                if !summary.is_empty() {
                    set_fact(&tx, &subject, "notes", summary, &source_ref)?;
                    report.facts += 1;
                }
            }
        }
    }

    tx.commit()
        .map_err(|e| format!("work store: import commit: {e}"))?;
    Ok(report)
}

/// Does this entity already exist? Asked before the upsert so the report can
/// distinguish created from updated — which is how a person confirms that a
/// second import changed nothing.
fn entity_exists(
    conn: &Connection,
    workspace_id: &str,
    kind: &str,
    name: &str,
) -> Result<bool, String> {
    let key = normalize_key(name);
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM entity WHERE workspace_id = ?1 AND kind = ?2 AND natural_key = ?3",
            params![workspace_id, kind, key],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| format!("work store: exists: {e}"))?;
    Ok(found.is_some())
}

// ── tauri commands ───────────────────────────────────────────────────────────
//
// The whole boundary. No SQL crosses it and the frontend never names a table:
// the webview asks for a lookup, a card, or an import, and every one of those
// applies workspace scope and visibility on this side. That is deliberate — the
// moment the renderer can compose its own query, the permission filter stops
// being a guarantee and becomes a convention.

/// Resolve a workspace NAME (what the frontend knows) to the durable `ws_…` id
/// (what the store keys on).
///
/// Two sources, in order. A real Spike workspace carries its id in its group
/// file, so that one wins and stays in step with the rest of the app. But Home
/// is a launcher — a person can be on it with no group selected at all — and
/// that case still needs a stable place to put entities rather than silently
/// dropping them. Those names fall back to a small `name → id` map, so the
/// personal workspace survives restarts exactly like a group does.
#[tauri::command]
pub fn work_workspace_id(name: String) -> Result<String, String> {
    if let Ok(id) = crate::fs_ops::ensure_ws_id(&name) {
        return Ok(id);
    }
    workspace_id_from_map(&name)
}

/// `~/.spike/work/workspaces.json` — `{ "<name>": "ws_…" }` for workspaces with
/// no group file behind them. Read-modify-write so a new name never clobbers
/// the ids already in the map.
fn workspace_id_from_map(name: &str) -> Result<String, String> {
    let key = name.trim();
    if key.is_empty() {
        return Err("workspace needs a name".into());
    }
    let dir = crate::state::spike_dir().join("work");
    std::fs::create_dir_all(&dir).map_err(|e| format!("work store: mkdir: {e}"))?;
    let path = dir.join("workspaces.json");
    let mut map: serde_json::Map<String, Value> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    if let Some(id) = map.get(key).and_then(|v| v.as_str()) {
        if !id.trim().is_empty() {
            return Ok(id.to_string());
        }
    }
    let id = mint_id("ws");
    map.insert(key.to_string(), Value::String(id.clone()));
    let out = serde_json::to_string_pretty(&Value::Object(map)).map_err(|e| e.to_string())?;
    std::fs::write(&path, out).map_err(|e| format!("work store: write workspaces.json: {e}"))?;
    Ok(id)
}

/// `@` autocomplete. Never calls a model and never touches the network — one
/// indexed local read, with a bounded local fallback if the index is unusable.
#[tauri::command]
pub fn work_mention_lookup(
    state: tauri::State<'_, crate::state::AppState>,
    workspace_id: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<MentionHit>, String> {
    let limit = limit.unwrap_or(8);
    with_db(&state, |conn| {
        match lookup(conn, &workspace_id, &query, limit) {
            Ok(hits) => Ok(hits),
            // A corrupt or missing FTS index must degrade to a smaller local
            // lookup — never to an unbounded search and never to an agent.
            Err(_) => lookup_fallback(conn, &workspace_id, &query, limit),
        }
    })
}

/// The canonical records behind one entity, for the card projector. Returns
/// `null` for absent, hidden, and out-of-scope alike.
#[tauri::command]
pub fn work_entity_card(
    state: tauri::State<'_, crate::state::AppState>,
    workspace_id: String,
    entity_id: String,
) -> Result<Option<Value>, String> {
    with_db(&state, |conn| {
        entity_records(conn, &workspace_id, &entity_id)
    })
}

/// Import a CSV of people/companies. The path is whatever the person picked;
/// it is read here rather than in the webview so the renderer never needs
/// filesystem reach it would not otherwise have.
#[tauri::command]
pub fn work_import_csv(
    state: tauri::State<'_, crate::state::AppState>,
    workspace_id: String,
    path: String,
) -> Result<ImportReport, String> {
    let p = std::path::Path::new(&path);
    if !p.is_absolute() {
        return Err("import needs an absolute path".into());
    }
    let text = std::fs::read_to_string(p).map_err(|e| format!("read {path}: {e}"))?;
    with_db(&state, |conn| {
        import_csv(conn, &workspace_id, &path, &text)
    })
}

/// Everything in scope, for the "what does Spike know" surface and for the
/// empty state's "you have no entities yet" decision. Bounded.
#[tauri::command]
pub fn work_entities(
    state: tauri::State<'_, crate::state::AppState>,
    workspace_id: String,
    limit: Option<usize>,
) -> Result<Vec<Value>, String> {
    let limit = limit.unwrap_or(200).clamp(1, 1000);
    with_db(&state, |conn| {
        let mut stmt = conn
            .prepare(
                "SELECT e.id, e.name, e.kind, e.updated_at,
                        (SELECT count(*) FROM interaction i WHERE i.entity_id = e.id)
                   FROM entity e
                  WHERE e.workspace_id = ?1 AND e.visibility = 'normal'
                  ORDER BY e.kind, e.name
                  LIMIT ?2",
            )
            .map_err(|e| format!("work store: list prepare: {e}"))?;
        let rows = stmt
            .query_map(params![workspace_id, limit as i64], |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "name": r.get::<_, String>(1)?,
                    "kind": r.get::<_, String>(2)?,
                    "updatedAt": r.get::<_, String>(3)?,
                    "interactions": r.get::<_, i64>(4)?,
                }))
            })
            .map_err(|e| format!("work store: list: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("work store: list row: {e}"))
    })
}

/// Hide or unhide an entity. The only authority verb in the first slice, and
/// the one the non-disclosure tests exercise.
#[tauri::command]
pub fn work_set_visibility(
    state: tauri::State<'_, crate::state::AppState>,
    workspace_id: String,
    entity_id: String,
    hidden: bool,
) -> Result<(), String> {
    let vis = if hidden { "hidden" } else { "normal" };
    with_db(&state, |conn| {
        conn.execute(
            "UPDATE entity SET visibility = ?3 WHERE id = ?1 AND workspace_id = ?2",
            params![entity_id, workspace_id, vis],
        )
        .map_err(|e| format!("work store: visibility: {e}"))?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    /// A fresh migrated database on disk (not :memory:, so the migration runner
    /// and its pragmas are exercised the way they run in the app).
    fn db() -> Connection {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("spike-work-{}-{}", std::process::id(), n));
        std::fs::create_dir_all(&dir).unwrap();
        open_at(&dir.join("work.db")).unwrap()
    }

    const WS: &str = "ws_test";

    #[test]
    fn migrations_apply_once_and_are_idempotent() {
        let mut conn = db();
        let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, MIGRATIONS.len() as i64);
        // running again is a no-op, not an error
        migrate(&mut conn).unwrap();
        let v2: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, v2);
    }

    #[test]
    fn refuses_a_database_from_a_newer_build() {
        let mut conn = db();
        conn.pragma_update(None, "user_version", 999i64).unwrap();
        let err = migrate(&mut conn).unwrap_err();
        assert!(err.contains("Update Spike"), "{err}");
    }

    #[test]
    fn foreign_keys_are_enforced() {
        let conn = db();
        let err = conn
            .execute(
                "INSERT INTO entity_alias (entity_id, alias, norm) VALUES ('nope','x','x')",
                [],
            )
            .unwrap_err();
        assert!(err.to_string().to_lowercase().contains("foreign key"), "{err}");
    }

    #[test]
    fn normalize_folds_case_punctuation_and_spacing() {
        assert_eq!(normalize_key("Sarah  Guo"), "sarah guo");
        assert_eq!(normalize_key("Sarah Guo."), "sarah guo");
        assert_eq!(normalize_key("  O'Brien, Inc. "), "o brien inc");
        assert_eq!(normalize_key("!!!"), "");
    }

    #[test]
    fn company_short_name_strips_only_legal_suffixes() {
        assert_eq!(short_company_name("Acme, Inc."), Some("Acme".into()));
        assert_eq!(short_company_name("Boldstart Ventures"), Some("Boldstart".into()));
        assert_eq!(short_company_name("Conviction"), None);
        assert_eq!(short_company_name("Inc"), None);
    }

    #[test]
    fn upsert_is_idempotent_and_keeps_the_id() {
        let conn = db();
        let a = upsert_entity(&conn, WS, "person", "Sarah Guo", "test").unwrap();
        let b = upsert_entity(&conn, WS, "person", "sarah  guo", "test").unwrap();
        assert_eq!(a, b, "same person by normalized key");
        let n: i64 = conn
            .query_row("SELECT count(*) FROM entity", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        let aliases: i64 = conn
            .query_row("SELECT count(*) FROM entity_alias", [], |r| r.get(0))
            .unwrap();
        assert_eq!(aliases, 1, "re-import must not grow the alias list");
    }

    #[test]
    fn ranking_puts_exact_name_above_prefix_above_alias() {
        let conn = db();
        let acme = upsert_entity(&conn, WS, "company", "Acme", "t").unwrap();
        let acme_holdings = upsert_entity(&conn, WS, "company", "Acme Holdings", "t").unwrap();
        let other = upsert_entity(&conn, WS, "company", "Northwind", "t").unwrap();
        add_alias(&conn, &other, "AC Partners", "alias").unwrap();

        let hits = lookup(&conn, WS, "Acme", 10).unwrap();
        assert_eq!(hits[0].id, acme, "exact canonical name wins");
        assert_eq!(hits[0].rank, RANK_EXACT_NAME);
        assert!(hits.iter().any(|h| h.id == acme_holdings));

        let pre = lookup(&conn, WS, "ac", 10).unwrap();
        assert!(pre.iter().any(|h| h.id == acme));
        assert!(pre.iter().any(|h| h.id == other), "alias prefix still matches");
        let acme_rank = pre.iter().find(|h| h.id == acme).unwrap().rank;
        let other_rank = pre.iter().find(|h| h.id == other).unwrap().rank;
        assert!(acme_rank < other_rank, "canonical prefix beats alias prefix");
    }

    #[test]
    fn diacritics_fold_in_the_index() {
        let conn = db();
        let e = upsert_entity(&conn, WS, "company", "Acmé Holdings", "t").unwrap();
        let hits = lookup(&conn, WS, "acme", 10).unwrap();
        assert!(hits.iter().any(|h| h.id == e), "é must fold to e");
    }

    #[test]
    fn fts_finds_a_mid_name_token() {
        let conn = db();
        let e = upsert_entity(&conn, WS, "person", "Sarah Guo", "t").unwrap();
        // "guo" is not a left-anchored prefix of "sarah guo" — only FTS reaches it
        let hits = lookup(&conn, WS, "guo", 10).unwrap();
        assert!(hits.iter().any(|h| h.id == e));
    }

    #[test]
    fn duplicate_aliases_return_distinct_candidates() {
        let conn = db();
        let a = upsert_entity(&conn, WS, "company", "Matrix Partners", "t").unwrap();
        let b = upsert_entity(&conn, WS, "company", "Matrix Labs", "t").unwrap();
        add_alias(&conn, &a, "Matrix", "alias").unwrap();
        add_alias(&conn, &b, "Matrix", "alias").unwrap();

        let hits = lookup(&conn, WS, "Matrix", 10).unwrap();
        let ids: Vec<&str> = hits.iter().map(|h| h.id.as_str()).collect();
        assert!(ids.contains(&a.as_str()) && ids.contains(&b.as_str()), "never silently merged");
        assert!(
            hits.iter().filter(|h| h.ambiguous).count() >= 2,
            "both must be flagged ambiguous so the UI disambiguates"
        );
    }

    #[test]
    fn hidden_and_out_of_scope_entities_never_surface() {
        let conn = db();
        let visible = upsert_entity(&conn, WS, "company", "Acme", "t").unwrap();
        let hidden = upsert_entity(&conn, WS, "company", "Acme Secret", "t").unwrap();
        conn.execute(
            "UPDATE entity SET visibility = 'hidden' WHERE id = ?1",
            params![hidden],
        )
        .unwrap();
        let other_ws = upsert_entity(&conn, "ws_other", "company", "Acme Elsewhere", "t").unwrap();

        let hits = lookup(&conn, WS, "acme", 50).unwrap();
        let ids: Vec<&str> = hits.iter().map(|h| h.id.as_str()).collect();
        assert!(ids.contains(&visible.as_str()));
        assert!(!ids.contains(&hidden.as_str()), "hidden entity leaked into results");
        assert!(!ids.contains(&other_ws.as_str()), "cross-workspace leak");
        assert_eq!(hits.len(), 1, "counts must not reveal the hidden rows either");

        // …and the card is the same 'not found' shape for hidden, foreign, and absent.
        assert!(entity_records(&conn, WS, &hidden).unwrap().is_none());
        assert!(entity_records(&conn, WS, &other_ws).unwrap().is_none());
        assert!(entity_records(&conn, WS, "ent_does_not_exist").unwrap().is_none());
    }

    #[test]
    fn lookup_survives_fts_metacharacters() {
        let conn = db();
        upsert_entity(&conn, WS, "company", "Acme", "t").unwrap();
        // none of these may raise — a person typing is not writing a query
        for q in ["\"", "NEAR(", "a*", "^x", "-", "AND", "()"] {
            lookup(&conn, WS, q, 10).unwrap_or_else(|e| panic!("query {q:?} errored: {e}"));
        }
    }

    #[test]
    fn fallback_is_bounded_and_scoped() {
        let conn = db();
        for i in 0..100 {
            upsert_entity(&conn, WS, "company", &format!("Acme {i}"), "t").unwrap();
        }
        let hits = lookup_fallback(&conn, WS, "acme", 5).unwrap();
        assert_eq!(hits.len(), 5, "fallback must stay bounded");
        let none = lookup_fallback(&conn, "ws_nope", "acme", 5).unwrap();
        assert!(none.is_empty(), "fallback must respect workspace scope");
    }

    #[test]
    fn interactions_are_idempotent_per_source_row() {
        let conn = db();
        let e = upsert_entity(&conn, WS, "person", "Peter Co", "t").unwrap();
        let a = upsert_interaction(&conn, WS, &e, "meeting", "2026-08-18", "Need AI advice", "team.csv#3").unwrap();
        let b = upsert_interaction(&conn, WS, &e, "meeting", "2026-08-18", "Need AI advice", "team.csv#3").unwrap();
        assert_eq!(a, b);
        let n: i64 = conn
            .query_row("SELECT count(*) FROM interaction", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn entity_records_carry_relations_facts_and_interactions() {
        let conn = db();
        let p = upsert_entity(&conn, WS, "person", "Sarah Guo", "t").unwrap();
        let c = upsert_entity(&conn, WS, "company", "Conviction", "t").unwrap();
        relate(&conn, WS, &p, &c, "works_at").unwrap();
        set_fact(&conn, &p, "stage", "Seed", "investors.csv#1").unwrap();
        upsert_interaction(&conn, WS, &p, "meeting", "2026-08-11", "intro call", "team.csv#1").unwrap();

        let rec = entity_records(&conn, WS, &p).unwrap().unwrap();
        assert_eq!(rec["name"], "Sarah Guo");
        assert_eq!(rec["related"][0]["name"], "Conviction");
        assert_eq!(rec["facts"][0]["key"], "stage");
        assert_eq!(rec["facts"][0]["sourceRef"], "investors.csv#1");
        assert_eq!(rec["interactions"][0]["occurredAt"], "2026-08-11");

        // the company sees the person back, without a second relationship row
        let back = entity_records(&conn, WS, &c).unwrap().unwrap();
        assert_eq!(back["related"][0]["name"], "Sarah Guo");
        assert_eq!(back["related"][0]["direction"], "in");
    }

    // ── import ───────────────────────────────────────────────────────────────

    /// The real shape of the user's team.csv — people, firms, meeting dates,
    /// takeaways. Used verbatim so the test breaks if the importer stops
    /// handling the file it was built for.
    const TEAM_CSV: &str = "Name,Role,Meeting Date,Industry,Biggest Takeaways\n\
Amy Lin,Venture,2026-08-11,VC,FDE\n\
Justin Moore,Venture,2026-08-15,VC,100 meetings\n\
Peter Co,CEO,2026-08-18,GovTech,Need advice on AI transformation\n";

    const INVESTORS_CSV: &str = "Name,Firm,Stage,Check size,Warm,Website\n\
Sarah Guo,Conviction,Seed,$1500000,true,https://conviction.com\n\
Ilya Sukhar,Matrix Partners,Series A,$5000000,false,https://matrix.vc\n";

    #[test]
    fn headers_classify_into_roles() {
        assert_eq!(classify_header("Name"), ColRole::PersonName);
        assert_eq!(classify_header("Firm"), ColRole::CompanyName);
        assert_eq!(classify_header("Meeting Date"), ColRole::Date);
        assert_eq!(classify_header("Biggest Takeaways"), ColRole::Summary);
        // anything unrecognized is kept as a fact rather than dropped
        assert_eq!(classify_header("Check size"), ColRole::Fact("check size".into()));
        assert_eq!(classify_header(""), ColRole::Ignore);
    }

    #[test]
    fn imports_people_meetings_and_facts() {
        let mut conn = db();
        let rep = import_csv(&mut conn, WS, "/x/team.csv", TEAM_CSV).unwrap();
        assert_eq!(rep.rows, 3);
        assert_eq!(rep.people_created, 3);
        assert_eq!(rep.interactions, 3);
        assert!(rep.warnings.is_empty(), "{:?}", rep.warnings);

        let hits = lookup(&conn, WS, "amy", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].name, "Amy Lin");

        let rec = entity_records(&conn, WS, &hits[0].id).unwrap().unwrap();
        assert_eq!(rec["interactions"][0]["occurredAt"], "2026-08-11");
        assert_eq!(rec["interactions"][0]["summary"], "FDE");
        // provenance survives: the card can point back at the exact source row
        assert_eq!(rec["interactions"][0]["sourceRef"], "team.csv#2");
        let roles: Vec<&str> = rec["facts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["key"].as_str().unwrap())
            .collect();
        assert!(roles.contains(&"role") && roles.contains(&"industry"));
    }

    #[test]
    fn imports_person_company_relationships_and_normalizes_booleans() {
        let mut conn = db();
        let rep = import_csv(&mut conn, WS, "/x/investors.csv", INVESTORS_CSV).unwrap();
        assert_eq!(rep.people_created, 2);
        assert_eq!(rep.companies_created, 2);
        assert_eq!(rep.interactions, 0, "no date column → no invented meetings");

        let sarah = &lookup(&conn, WS, "sarah guo", 5).unwrap()[0];
        let rec = entity_records(&conn, WS, &sarah.id).unwrap().unwrap();
        assert_eq!(rec["related"][0]["name"], "Conviction");
        assert_eq!(rec["related"][0]["relation"], "works_at");

        let warm = rec["facts"].as_array().unwrap().iter()
            .find(|f| f["key"] == "warm").unwrap();
        assert_eq!(warm["value"], "yes", "true/yes/1 all normalize to one form");

        // the company answers to its short name too
        let short = lookup(&conn, WS, "matrix", 10).unwrap();
        assert!(short.iter().any(|h| h.name == "Matrix Partners"));
        // and the person's popover line names their firm
        let ilya = lookup(&conn, WS, "ilya", 5).unwrap();
        assert_eq!(ilya[0].detail, "Matrix Partners");
    }

    #[test]
    fn a_second_import_creates_nothing() {
        let mut conn = db();
        import_csv(&mut conn, WS, "/x/team.csv", TEAM_CSV).unwrap();
        let again = import_csv(&mut conn, WS, "/x/team.csv", TEAM_CSV).unwrap();
        assert_eq!(again.people_created, 0, "re-import must not duplicate people");
        assert_eq!(again.rows, 3);

        let people: i64 = conn
            .query_row("SELECT count(*) FROM entity", [], |r| r.get(0))
            .unwrap();
        assert_eq!(people, 3);
        let ints: i64 = conn
            .query_row("SELECT count(*) FROM interaction", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ints, 3, "same meeting re-imported is still one meeting");
    }

    #[test]
    fn a_corrected_row_updates_in_place() {
        let mut conn = db();
        import_csv(&mut conn, WS, "/x/t.csv", "Name,Firm,Stage\nSarah Guo,Conviction,Seed\n").unwrap();
        import_csv(&mut conn, WS, "/x/t.csv", "Name,Firm,Stage\nSarah Guo,Conviction,Series A\n").unwrap();
        let sarah = &lookup(&conn, WS, "sarah", 5).unwrap()[0];
        let rec = entity_records(&conn, WS, &sarah.id).unwrap().unwrap();
        let stage = rec["facts"].as_array().unwrap().iter()
            .find(|f| f["key"] == "stage").unwrap();
        assert_eq!(stage["value"], "Series A", "last write wins for a corrected sheet");
    }

    #[test]
    fn an_ambiguous_date_becomes_a_fact_with_a_warning() {
        let mut conn = db();
        let rep = import_csv(
            &mut conn,
            WS,
            "/x/t.csv",
            "Name,Meeting Date\nAmy Lin,03/04/2026\n",
        )
        .unwrap();
        assert_eq!(rep.interactions, 0, "never guess between D/M and M/D");
        assert_eq!(rep.warnings.len(), 1);
        assert!(rep.warnings[0].contains("YYYY-MM-DD"), "{:?}", rep.warnings);
    }

    #[test]
    fn a_sheet_with_no_name_column_is_refused() {
        let mut conn = db();
        let err = import_csv(&mut conn, WS, "/x/t.csv", "Colour,Size\nred,big\n").unwrap_err();
        assert!(err.contains("no name column"), "{err}");
    }

    #[test]
    fn a_misspelled_name_becomes_a_visible_second_entity() {
        let mut conn = db();
        import_csv(&mut conn, WS, "/x/t.csv", "Name\nSarah Guo\nSarah Guoo\n").unwrap();
        let hits = lookup(&conn, WS, "sarah gu", 10).unwrap();
        assert_eq!(hits.len(), 2, "never silently merged into one person");
    }

    #[test]
    fn import_is_atomic() {
        let mut conn = db();
        // A row whose company name normalizes to nothing fails the upsert; the
        // rows before it must not survive the failed transaction.
        let bad = "Name,Firm\nAmy Lin,Conviction\n!!!,???\n";
        let res = import_csv(&mut conn, WS, "/x/t.csv", bad);
        assert!(res.is_err(), "expected the bad row to fail the import");
        let n: i64 = conn
            .query_row("SELECT count(*) FROM entity", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "a failed import must leave nothing behind");
    }

    // ── scale ────────────────────────────────────────────────────────────────

    /// How big can this get before local stops being viable?
    ///
    /// Not a unit test — a measurement, kept in the repo so the answer can be
    /// re-derived on a real machine instead of argued about. Ignored by default:
    ///
    ///   cargo test --lib scale_ -- --ignored --nocapture
    #[test]
    #[ignore]
    fn scale_100k_entities_stays_interactive() {
        let mut conn = db();
        let n = 100_000;

        let t0 = std::time::Instant::now();
        {
            let tx = conn.transaction().unwrap();
            for i in 0..n {
                // Realistic-ish spread: a first name from a small pool plus a
                // unique surname, so prefix queries actually have to discriminate.
                const FIRST: &[&str] = &[
                    "Sarah", "Sam", "Amy", "Justin", "Peter", "Ada", "Chen", "Reed",
                    "Ilya", "Elad", "Guillermo", "Rick",
                ];
                let name = format!("{} Sur{}", FIRST[i % FIRST.len()], i);
                let id = upsert_entity(&tx, WS, "person", &name, "bench").unwrap();
                if i % 3 == 0 {
                    set_fact(&tx, &id, "stage", "Seed", "bench.csv#1").unwrap();
                }
            }
            tx.commit().unwrap();
        }
        let write = t0.elapsed();

        let size = std::fs::metadata(conn.path().unwrap()).map(|m| m.len()).unwrap_or(0);

        // Warm, then time the query a person actually types.
        let _ = lookup(&conn, WS, "sa", 8).unwrap();
        let mut times: Vec<u128> = Vec::new();
        for q in ["s", "sa", "sar", "sarah", "am", "guil", "sur9", "pete"] {
            for _ in 0..25 {
                let t = std::time::Instant::now();
                let hits = lookup(&conn, WS, q, 8).unwrap();
                times.push(t.elapsed().as_micros());
                assert!(hits.len() <= 8);
            }
        }
        times.sort_unstable();
        let p50 = times[times.len() / 2];
        let p95 = times[times.len() * 95 / 100];
        let max = times[times.len() - 1];

        eprintln!(
            "SCALE n={n} write={:.1}s db={:.1}MB lookup p50={:.2}ms p95={:.2}ms max={:.2}ms",
            write.as_secs_f64(),
            size as f64 / 1_048_576.0,
            p50 as f64 / 1000.0,
            p95 as f64 / 1000.0,
            max as f64 / 1000.0,
        );

        // The budget the spec set for autocomplete. If this ever fails, the
        // answer is an index or a query fix — not a server.
        assert!(p95 < 50_000, "p95 {p95}µs blew the 50ms autocomplete budget");
    }

    #[test]
    fn deleting_an_entity_cleans_its_index() {
        let conn = db();
        let e = upsert_entity(&conn, WS, "company", "Acme", "t").unwrap();
        assert!(!lookup(&conn, WS, "acme", 10).unwrap().is_empty());
        conn.execute("DELETE FROM entity WHERE id = ?1", params![e]).unwrap();
        assert!(
            lookup(&conn, WS, "acme", 10).unwrap().is_empty(),
            "cascade + trigger must clear the mention index"
        );
        let orphans: i64 = conn
            .query_row("SELECT count(*) FROM mention_fts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(orphans, 0);
    }
}
