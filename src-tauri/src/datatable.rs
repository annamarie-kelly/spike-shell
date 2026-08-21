// datatable.rs — SQLite-backed interactive data tables ("Spike tables").
//
// The product surface: a Notion-DB / Google-Sheets-flavored grid the user (or
// the agent) can sort, filter, and edit inline — including the *schema* (add /
// rename / retype / reorder / delete columns), not just the rows.
//
// Source of truth vs. mirror (the "Supabase-lowkey, but stays plain-text"
// contract the feature was scoped around):
//   • Source of truth is a real local SQLite DB, one file per table, hidden at
//     `<dir>/.spike/tables/<stem>.db`. Typed, transactional, and queryable from
//     a shell (`sqlite3 …`).
//   • On EVERY mutation we re-export the human-facing `<dir>/<stem>.csv` mirror
//     so the data stays git-diffable and grep-able. That csv is what the file
//     tree shows and what the agent writes when it "generates a table".
//
// Adoption: the agent (or a person) just drops a plain `<stem>.csv`. Opening it
// with no backing DB yields `Err("not a table")`; the frontend then offers
// "Make interactive" → `table_import_csv`, which infers column types and builds
// the DB. From then on the DB leads and the csv follows.
//
// Row storage is a JSON blob per row (`rows.data`) keyed by stable column ids
// (c1, c2, …) rather than one real SQL column per field. That keeps schema edits
// (add/retype/delete column) cheap — no ALTER TABLE churn — at v1 scale. The csv
// mirror still materializes real named columns for the terminal/grep story, and
// json_extract keeps the DB itself queryable. Values are stored as strings; the
// column `type` governs the editor widget and sort order, not the storage.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;

use crate::state::AppState;

// ── shapes returned to the frontend ─────────────────────────────────────────

#[derive(Serialize)]
pub struct Column {
    pub key: String,
    pub name: String,
    #[serde(rename = "type")]
    pub col_type: String,
    pub options: Vec<String>,
    /// number display: plain | comma | usd | eur | gbp | percent
    pub format: String,
    /// per-option metadata keyed by option value: `{ "<value>": { color, group } }`.
    /// `color` is a chosen hex (overrides the hash-derived hue); `group` is a
    /// status bucket (todo | active | done), only meaningful for `status` columns.
    #[serde(rename = "optionMeta")]
    pub option_meta: Value,
}

/// Input shape for `table_set_options` — one option's value + its chosen color
/// and (for status columns) its group bucket.
#[derive(serde::Deserialize)]
pub struct OptionMeta {
    pub value: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub group: Option<String>,
}

/// A number column whose name reads like money → default to a currency format.
fn is_currency_name(name: &str) -> bool {
    let n = name.to_lowercase();
    ["salary", "price", "amount", "cost", "revenue", "pay", "budget", "comp", "income", "fee", "arr", "mrr", "spend", "wage"]
        .iter()
        .any(|k| n.contains(k))
}

#[derive(Serialize)]
pub struct Row {
    pub id: i64,
    pub cells: BTreeMap<String, String>,
}

/// A saved view: a layout (table/board/gallery/list/calendar) plus its own
/// sort/filter/group state (config is opaque JSON the frontend owns).
#[derive(Serialize)]
pub struct View {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub config: Value,
}

#[derive(Serialize)]
pub struct TableDoc {
    pub path: String,
    pub columns: Vec<Column>,
    pub rows: Vec<Row>,
    pub views: Vec<View>,
    /// display metadata (title, icon) — opaque key/value the frontend owns.
    pub meta: BTreeMap<String, String>,
}

const TYPES: &[&str] = &[
    "text",
    "number",
    "date",
    "checkbox",
    "select",
    "multiselect",
    "status",
    "place",
    "url",
];

/// The single/multi option column types whose picked values are also remembered
/// as reusable options on the column (Notion-style: typing a new value creates it).
/// `status` behaves like a single-select whose options carry a group bucket.
fn is_option_type(t: &str) -> bool {
    t == "select" || t == "multiselect" || t == "status"
}

/// A multiselect cell stores its values as a JSON array of strings. Parse one
/// tolerantly: JSON array, or a comma-separated fallback.
fn parse_multi(raw: &str) -> Vec<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return vec![];
    }
    if let Ok(v) = serde_json::from_str::<Vec<String>>(raw) {
        return v.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    }
    raw.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
}

/// A text column named like a link → default to the `url` type.
fn is_url_name(name: &str) -> bool {
    let n = name.to_lowercase();
    ["url", "link", "website", "site", "homepage", "web"].iter().any(|k| n.contains(k))
}

/// A column whose name reads like a location → default to the `place` type
/// (map-pin + in-app location picker) instead of plain text.
fn is_place_name(name: &str) -> bool {
    let n = name.to_lowercase();
    ["location", "address", "city", "place", "hq", "office", "based"]
        .iter()
        .any(|k| n.contains(k))
}
const VIEW_KINDS: &[&str] = &["table", "board", "gallery", "list", "calendar"];

// ── file model ───────────────────────────────────────────────────────────────
//
// A `.spiketable` file IS a real SQLite database — the source of truth, opened
// directly (so `sqlite3 investors.spiketable` just works). CSV is no longer a
// shadow mirror; it's an explicit, on-demand Export (table_export_csv) that
// writes a sibling `<stem>.csv`. Adoption goes the other way: a plain `<stem>.csv`
// (what an agent can author) is imported into a sibling `<stem>.spiketable`.

const TABLE_EXT: &str = "spiketable";

fn is_table_path(p: &str) -> bool {
    Path::new(p)
        .extension()
        .map(|e| e.eq_ignore_ascii_case(TABLE_EXT))
        .unwrap_or(false)
}

fn sibling(path: &str, new_ext: &str) -> Result<PathBuf, String> {
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err("bad target".into());
    }
    let dir = p.parent().ok_or_else(|| "bad target".to_string())?;
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "bad target".to_string())?;
    Ok(dir.join(format!("{stem}.{new_ext}")))
}

/// The `.spiketable` db path for any input: a `.spiketable` path is itself; a
/// `.csv` (or anything else) maps to its `<stem>.spiketable` sibling.
fn db_path_for(path: &str) -> Result<PathBuf, String> {
    if is_table_path(path) {
        let p = Path::new(path);
        if !p.is_absolute() {
            return Err("bad target".into());
        }
        Ok(p.to_path_buf())
    } else {
        sibling(path, TABLE_EXT)
    }
}

fn schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS cols (
           pos     INTEGER NOT NULL,
           key     TEXT PRIMARY KEY,
           name    TEXT NOT NULL,
           type    TEXT NOT NULL DEFAULT 'text',
           options TEXT NOT NULL DEFAULT '[]'
         );
         CREATE TABLE IF NOT EXISTS rows (
           id   INTEGER PRIMARY KEY AUTOINCREMENT,
           pos  INTEGER NOT NULL,
           data TEXT NOT NULL DEFAULT '{}'
         );
         CREATE TABLE IF NOT EXISTS views (
           pos    INTEGER NOT NULL,
           id     TEXT PRIMARY KEY,
           name   TEXT NOT NULL,
           kind   TEXT NOT NULL DEFAULT 'table',
           config TEXT NOT NULL DEFAULT '{}'
         );
         CREATE TABLE IF NOT EXISTS meta (
           key   TEXT PRIMARY KEY,
           value TEXT NOT NULL DEFAULT ''
         );",
    )
    .map_err(|e| format!("db init: {e}"))?;
    // Migration for tables created before the `format` column existed — ignore
    // the error when it's already there (SQLite has no ADD COLUMN IF NOT EXISTS).
    let _ = conn.execute("ALTER TABLE cols ADD COLUMN format TEXT NOT NULL DEFAULT 'plain'", []);
    // Same lazy migration for per-option color/group metadata (older files read '{}').
    let _ = conn.execute("ALTER TABLE cols ADD COLUMN option_meta TEXT NOT NULL DEFAULT '{}'", []);
    Ok(())
}

/// Open (creating parent dirs + schema). Does NOT verify the table already has
/// content — callers that require an existing table check `is_backed` first.
fn open_db(csv: &str) -> Result<Connection, String> {
    let dbp = db_path_for(csv)?;
    if let Some(parent) = dbp.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "db init: mkdir failed".to_string())?;
    }
    let conn = Connection::open(&dbp).map_err(|e| format!("db open: {e}"))?;
    schema(&conn)?;
    Ok(conn)
}

fn is_backed(csv: &str) -> bool {
    db_path_for(csv).map(|p| p.exists()).unwrap_or(false)
}

// ── read ─────────────────────────────────────────────────────────────────────

fn read_doc(conn: &Connection, csv: &str) -> Result<TableDoc, String> {
    let mut cols_stmt = conn
        .prepare("SELECT key, name, type, options, format, option_meta FROM cols ORDER BY pos, key")
        .map_err(|e| format!("db read: {e}"))?;
    let columns = cols_stmt
        .query_map([], |r| {
            let opts_raw: String = r.get(3)?;
            let options: Vec<String> = serde_json::from_str(&opts_raw).unwrap_or_default();
            let name: String = r.get(1)?;
            let mut col_type: String = r.get(2)?;
            let mut format: String = r.get::<_, Option<String>>(4)?.unwrap_or_else(|| "plain".into());
            let ometa_raw: String = r.get::<_, Option<String>>(5)?.unwrap_or_else(|| "{}".into());
            let option_meta: Value = serde_json::from_str(&ometa_raw).unwrap_or_else(|_| json!({}));
            // Retroactive: a plain-text column named like a location becomes a
            // `place`; a plain number named like money defaults to currency.
            // In-memory only (non-destructive) — also upgrades older tables.
            if col_type == "text" && is_place_name(&name) {
                col_type = "place".to_string();
            } else if col_type == "text" && is_url_name(&name) {
                col_type = "url".to_string();
            }
            if col_type == "number" && format == "plain" && is_currency_name(&name) {
                format = "usd".to_string();
            }
            Ok(Column {
                key: r.get(0)?,
                name,
                col_type,
                options,
                format,
                option_meta,
            })
        })
        .map_err(|e| format!("db read: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("db read: {e}"))?;

    let mut rows_stmt = conn
        .prepare("SELECT id, data FROM rows ORDER BY pos, id")
        .map_err(|e| format!("db read: {e}"))?;
    let rows = rows_stmt
        .query_map([], |r| {
            let id: i64 = r.get(0)?;
            let data_raw: String = r.get(1)?;
            let map: BTreeMap<String, String> = serde_json::from_str(&data_raw).unwrap_or_default();
            Ok(Row { id, cells: map })
        })
        .map_err(|e| format!("db read: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("db read: {e}"))?;

    // Ensure at least the default Table view exists, so per-view state has a home.
    conn.execute(
        "INSERT OR IGNORE INTO views (pos, id, name, kind, config) VALUES (0, 'default', 'Table', 'table', '{}')",
        [],
    )
    .map_err(|e| format!("db read: {e}"))?;
    let mut views_stmt = conn
        .prepare("SELECT id, name, kind, config FROM views ORDER BY pos, id")
        .map_err(|e| format!("db read: {e}"))?;
    let views = views_stmt
        .query_map([], |r| {
            let cfg_raw: String = r.get(3)?;
            Ok(View {
                id: r.get(0)?,
                name: r.get(1)?,
                kind: r.get(2)?,
                config: serde_json::from_str(&cfg_raw).unwrap_or_else(|_| json!({})),
            })
        })
        .map_err(|e| format!("db read: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("db read: {e}"))?;

    // display metadata (title, icon, …) — tolerate the table not existing on
    // older files (schema() creates it, but a read may predate a migration).
    let mut meta: BTreeMap<String, String> = BTreeMap::new();
    if let Ok(mut mstmt) = conn.prepare("SELECT key, value FROM meta") {
        if let Ok(rows) = mstmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
            for kv in rows.flatten() {
                meta.insert(kv.0, kv.1);
            }
        }
    }

    Ok(TableDoc {
        path: csv.to_string(),
        columns,
        rows,
        views,
        meta,
    })
}

// ── csv export (on demand) ─────────────────────────────────────────────────────

fn csv_field(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// Write a plain `<stem>.csv` beside the `.spiketable`, from the DB. Explicit,
/// one-shot (the "Export CSV" action) — NOT a live mirror. Returns the csv path.
fn write_csv(conn: &Connection, table_path: &str, state: &AppState) -> Result<String, String> {
    let doc = read_doc(conn, table_path)?;
    let mut out = String::new();
    out.push_str(
        &doc.columns
            .iter()
            .map(|c| csv_field(&c.name))
            .collect::<Vec<_>>()
            .join(","),
    );
    out.push('\n');
    for row in &doc.rows {
        let line = doc
            .columns
            .iter()
            .map(|c| csv_field(row.cells.get(&c.key).map(String::as_str).unwrap_or("")))
            .collect::<Vec<_>>()
            .join(",");
        out.push_str(&line);
        out.push('\n');
    }
    let csv = sibling(table_path, "csv")?;
    std::fs::write(&csv, out.as_bytes()).map_err(|_| "write failed".to_string())?;
    state.mark_self_write(&csv);
    Ok(csv.to_string_lossy().into_owned())
}

// ── csv parse (RFC4180-ish: quotes, "" escapes, embedded commas/newlines) ─────

pub(crate) fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let mut records: Vec<Vec<String>> = Vec::new();
    let mut field = String::new();
    let mut record: Vec<String> = Vec::new();
    let mut in_quotes = false;
    let mut chars = text.chars().peekable();
    let mut any = false;
    while let Some(c) = chars.next() {
        any = true;
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(c);
            }
        } else {
            match c {
                '"' => in_quotes = true,
                ',' => {
                    record.push(std::mem::take(&mut field));
                }
                '\r' => { /* swallow; \n handles the break */ }
                '\n' => {
                    record.push(std::mem::take(&mut field));
                    records.push(std::mem::take(&mut record));
                }
                _ => field.push(c),
            }
        }
    }
    // trailing field/record (file not ending in newline)
    if any && (!field.is_empty() || !record.is_empty()) {
        record.push(field);
        records.push(record);
    }
    // drop a trailing all-empty record produced by a final newline
    records.retain(|r| !(r.len() == 1 && r[0].is_empty()));
    records
}

fn infer_type(values: &[String]) -> &'static str {
    let non_empty: Vec<&String> = values.iter().filter(|v| !v.trim().is_empty()).collect();
    if non_empty.is_empty() {
        return "text";
    }
    if non_empty
        .iter()
        .all(|v| v.trim().replace([',', '$', '%'], "").parse::<f64>().is_ok())
    {
        return "number";
    }
    let bools = ["true", "false", "yes", "no", "y", "n", "✓", "x"];
    if non_empty
        .iter()
        .all(|v| bools.contains(&v.trim().to_lowercase().as_str()))
    {
        return "checkbox";
    }
    "text"
}

/// A text column that looks like a category (few distinct short single-token
/// values, mostly filled) → render as select/tag-pills. Conservative on purpose:
/// free-text columns must stay text. Returns the sorted option set when it fits.
fn infer_select(values: &[String], nrows: usize) -> Option<Vec<String>> {
    if nrows < 5 {
        return None;
    }
    let non_empty: Vec<&str> = values.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    if non_empty.len() < nrows / 2 {
        return None; // mostly blank → not a reliable category
    }
    if non_empty.iter().any(|v| v.chars().count() > 24 || v.contains(',')) {
        return None; // long / multi-part values read as free text, not labels
    }
    let mut distinct: Vec<String> = non_empty.iter().map(|s| s.to_string()).collect();
    distinct.sort();
    distinct.dedup();
    if distinct.len() >= 2 && distinct.len() <= 6 {
        Some(distinct)
    } else {
        None
    }
}

// ── column-key allocation ─────────────────────────────────────────────────────

fn next_col_key(conn: &Connection) -> Result<String, String> {
    let mut stmt = conn
        .prepare("SELECT key FROM cols")
        .map_err(|e| format!("db: {e}"))?;
    let max = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| format!("db: {e}"))?
        .filter_map(|k| k.ok())
        .filter_map(|k| k.strip_prefix('c').and_then(|n| n.parse::<u32>().ok()))
        .max()
        .unwrap_or(0);
    Ok(format!("c{}", max + 1))
}

fn next_row_pos(conn: &Connection) -> i64 {
    conn.query_row("SELECT COALESCE(MAX(pos), -1) + 1 FROM rows", [], |r| r.get(0))
        .unwrap_or(0)
}

fn norm_type(t: &str) -> String {
    if TYPES.contains(&t) {
        t.to_string()
    } else {
        "text".to_string()
    }
}

// ── commands ──────────────────────────────────────────────────────────────────

/// Read an existing Spike table. Accepts the `.spiketable` path (or a `.csv`,
/// resolved to its sibling). `Err("not a table")` when there's no table yet.
#[tauri::command]
pub fn table_read(path: String) -> Result<TableDoc, String> {
    if !is_backed(&path) {
        return Err("not a table".into());
    }
    let table = db_path_for(&path)?;
    let table_str = table.to_string_lossy().into_owned();
    let conn = open_db(&table_str)?;
    read_doc(&conn, &table_str)
}

/// Cheap probe: does a `.spiketable` exist for this path, and what is it? Lets
/// the frontend open the grid directly, or offer "Make interactive" for a plain
/// csv that hasn't been adopted yet.
#[tauri::command]
pub fn table_status(path: String) -> Result<Value, String> {
    let table = db_path_for(&path)?;
    Ok(json!({
        "backed": table.exists(),
        "tablePath": table.to_string_lossy(),
        "isTable": is_table_path(&path),
    }))
}

/// Write a plain `<stem>.csv` beside the table (the on-demand "Export CSV"
/// action). Returns the csv path.
#[tauri::command]
pub fn table_export_csv(state: State<'_, AppState>, path: String) -> Result<String, String> {
    if !is_backed(&path) {
        return Err("not a table".into());
    }
    let table = db_path_for(&path)?;
    let table_str = table.to_string_lossy().into_owned();
    let conn = open_db(&table_str)?;
    write_csv(&conn, &table_str, &state)
}

/// Adopt an existing plain `<stem>.csv` into a DB-backed table, inferring column
/// types from the data. Rebuilds if already backed (re-ingests the csv).
#[tauri::command]
pub fn table_import_csv(state: State<'_, AppState>, path: String) -> Result<TableDoc, String> {
    import_core(&state, &path)
}

fn import_core(state: &AppState, path: &str) -> Result<TableDoc, String> {
    let text = std::fs::read_to_string(path).map_err(|_| "read failed".to_string())?;
    let records = parse_csv(&text);
    let conn = open_db(path)?;
    conn.execute_batch("DELETE FROM cols; DELETE FROM rows;")
        .map_err(|e| format!("db: {e}"))?;

    let header: Vec<String> = records
        .first()
        .cloned()
        .unwrap_or_else(|| vec!["Column 1".to_string()]);
    let body = if records.len() > 1 { &records[1..] } else { &[] };

    // Per-column values, for type inference.
    for (i, name) in header.iter().enumerate() {
        let col_vals: Vec<String> = body
            .iter()
            .map(|r| r.get(i).cloned().unwrap_or_default())
            .collect();
        let base = infer_type(&col_vals);
        // text → place (location-named), else select (few short repeated labels).
        let (ctype, opts) = if base == "text" {
            if is_place_name(name) {
                ("place".to_string(), "[]".to_string())
            } else {
                match infer_select(&col_vals, body.len()) {
                    Some(o) => ("select".to_string(), serde_json::to_string(&o).unwrap_or_else(|_| "[]".into())),
                    None => ("text".to_string(), "[]".to_string()),
                }
            }
        } else {
            (base.to_string(), "[]".to_string())
        };
        let display = if name.trim().is_empty() {
            format!("Column {}", i + 1)
        } else {
            name.clone()
        };
        conn.execute(
            "INSERT INTO cols (pos, key, name, type, options) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![i as i64, format!("c{}", i + 1), display, ctype, opts],
        )
        .map_err(|e| format!("db: {e}"))?;
    }

    for (ri, rec) in body.iter().enumerate() {
        let mut cells = serde_json::Map::new();
        for (ci, _name) in header.iter().enumerate() {
            let key = format!("c{}", ci + 1);
            let raw = rec.get(ci).cloned().unwrap_or_default();
            cells.insert(key, Value::String(raw));
        }
        conn.execute(
            "INSERT INTO rows (pos, data) VALUES (?1, ?2)",
            rusqlite::params![ri as i64, Value::Object(cells).to_string()],
        )
        .map_err(|e| format!("db: {e}"))?;
    }

    // The source of truth is the sibling `.spiketable`; return its path so the
    // frontend opens + mutates the table, not the csv it was adopted from.
    let table_path = db_path_for(path)?;
    let table_str = table_path.to_string_lossy().into_owned();
    state.mark_self_write(&table_path);
    read_doc(&conn, &table_str)
}

/// Create a brand-new empty `.spiketable` (the "New table" path): three text
/// columns and three blank rows.
#[tauri::command]
pub fn table_create(state: State<'_, AppState>, path: String) -> Result<TableDoc, String> {
    if is_backed(&path) {
        return table_read(path);
    }
    let conn = open_db(&path)?;
    for (i, name) in ["Name", "Notes", "Status"].iter().enumerate() {
        conn.execute(
            "INSERT INTO cols (pos, key, name, type, options) VALUES (?1, ?2, ?3, 'text', '[]')",
            rusqlite::params![i as i64, format!("c{}", i + 1), name],
        )
        .map_err(|e| format!("db: {e}"))?;
    }
    for i in 0..3 {
        conn.execute(
            "INSERT INTO rows (pos, data) VALUES (?1, '{}')",
            rusqlite::params![i as i64],
        )
        .map_err(|e| format!("db: {e}"))?;
    }
    state.mark_self_write(std::path::Path::new(&path));
    read_doc(&conn, &path)
}

#[tauri::command]
pub fn table_set_cell(
    state: State<'_, AppState>,
    path: String,
    row_id: i64,
    col_key: String,
    value: String,
) -> Result<TableDoc, String> {
    set_cell_core(&state, &path, row_id, &col_key, &value)
}

fn set_cell_core(
    state: &AppState,
    path: &str,
    row_id: i64,
    col_key: &str,
    value: &str,
) -> Result<TableDoc, String> {
    let conn = open_db(path)?;
    // json_set on the row's blob keeps other cells intact. The '$."c1"' path form
    // is quoted so a key is always treated as a literal member name.
    conn.execute(
        "UPDATE rows SET data = json_set(data, '$.' || json_quote(?1), ?2) WHERE id = ?3",
        rusqlite::params![col_key, value, row_id],
    )
    .map_err(|e| format!("db: {e}"))?;
    // For select/multiselect columns, remember any newly-typed value as a reusable
    // option on the column so it shows in the dropdown, board lanes, and every view.
    let ctype: Option<String> = conn
        .query_row(
            "SELECT type FROM cols WHERE key = ?1",
            rusqlite::params![col_key],
            |r| r.get(0),
        )
        .ok();
    if let Some(t) = ctype.as_deref() {
        if is_option_type(t) {
            let incoming: Vec<String> = if t == "multiselect" {
                parse_multi(value)
            } else if value.trim().is_empty() {
                vec![]
            } else {
                vec![value.trim().to_string()]
            };
            if !incoming.is_empty() {
                let cur_raw: String = conn
                    .query_row(
                        "SELECT options FROM cols WHERE key = ?1",
                        rusqlite::params![col_key],
                        |r| r.get(0),
                    )
                    .unwrap_or_else(|_| "[]".into());
                let mut opts: Vec<String> = serde_json::from_str(&cur_raw).unwrap_or_default();
                let mut changed = false;
                for v in incoming {
                    if !opts.iter().any(|o| o == &v) {
                        opts.push(v);
                        changed = true;
                    }
                }
                if changed {
                    let json = serde_json::to_string(&opts).unwrap_or_else(|_| "[]".into());
                    let _ = conn.execute(
                        "UPDATE cols SET options = ?1 WHERE key = ?2",
                        rusqlite::params![json, col_key],
                    );
                }
            }
        }
    }
    state.mark_self_write(std::path::Path::new(path));
    read_doc(&conn, path)
}

#[tauri::command]
pub fn table_add_row(state: State<'_, AppState>, path: String) -> Result<TableDoc, String> {
    let conn = open_db(&path)?;
    let pos = next_row_pos(&conn);
    conn.execute(
        "INSERT INTO rows (pos, data) VALUES (?1, '{}')",
        rusqlite::params![pos],
    )
    .map_err(|e| format!("db: {e}"))?;
    state.mark_self_write(std::path::Path::new(&path));
    read_doc(&conn, &path)
}

#[tauri::command]
pub fn table_delete_row(
    state: State<'_, AppState>,
    path: String,
    row_id: i64,
) -> Result<TableDoc, String> {
    let conn = open_db(&path)?;
    conn.execute("DELETE FROM rows WHERE id = ?1", rusqlite::params![row_id])
        .map_err(|e| format!("db: {e}"))?;
    state.mark_self_write(std::path::Path::new(&path));
    read_doc(&conn, &path)
}

#[tauri::command]
pub fn table_add_column(
    state: State<'_, AppState>,
    path: String,
    name: String,
    col_type: String,
    options: Option<Vec<String>>,
) -> Result<TableDoc, String> {
    let conn = open_db(&path)?;
    let key = next_col_key(&conn)?;
    let pos: i64 = conn
        .query_row("SELECT COALESCE(MAX(pos), -1) + 1 FROM cols", [], |r| r.get(0))
        .unwrap_or(0);
    let opts = serde_json::to_string(&options.unwrap_or_default()).unwrap_or_else(|_| "[]".into());
    let display = if name.trim().is_empty() {
        format!("Column {}", pos + 1)
    } else {
        name
    };
    conn.execute(
        "INSERT INTO cols (pos, key, name, type, options) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![pos, key, display, norm_type(&col_type), opts],
    )
    .map_err(|e| format!("db: {e}"))?;
    state.mark_self_write(std::path::Path::new(&path));
    read_doc(&conn, &path)
}

#[tauri::command]
pub fn table_rename_column(
    state: State<'_, AppState>,
    path: String,
    col_key: String,
    name: String,
) -> Result<TableDoc, String> {
    let conn = open_db(&path)?;
    conn.execute(
        "UPDATE cols SET name = ?1 WHERE key = ?2",
        rusqlite::params![name, col_key],
    )
    .map_err(|e| format!("db: {e}"))?;
    state.mark_self_write(std::path::Path::new(&path));
    read_doc(&conn, &path)
}

#[tauri::command]
pub fn table_retype_column(
    state: State<'_, AppState>,
    path: String,
    col_key: String,
    col_type: String,
    options: Option<Vec<String>>,
) -> Result<TableDoc, String> {
    let conn = open_db(&path)?;
    let opts = serde_json::to_string(&options.unwrap_or_default()).unwrap_or_else(|_| "[]".into());
    conn.execute(
        "UPDATE cols SET type = ?1, options = ?2 WHERE key = ?3",
        rusqlite::params![norm_type(&col_type), opts, col_key],
    )
    .map_err(|e| format!("db: {e}"))?;
    state.mark_self_write(std::path::Path::new(&path));
    read_doc(&conn, &path)
}

#[tauri::command]
pub fn table_delete_column(
    state: State<'_, AppState>,
    path: String,
    col_key: String,
) -> Result<TableDoc, String> {
    let conn = open_db(&path)?;
    conn.execute("DELETE FROM cols WHERE key = ?1", rusqlite::params![col_key])
        .map_err(|e| format!("db: {e}"))?;
    // Strip the field from every row blob so exports drop the column too.
    conn.execute(
        "UPDATE rows SET data = json_remove(data, '$.' || json_quote(?1))",
        rusqlite::params![col_key],
    )
    .map_err(|e| format!("db: {e}"))?;
    state.mark_self_write(std::path::Path::new(&path));
    read_doc(&conn, &path)
}

/// Set a number column's display format (plain | comma | usd | eur | gbp | percent).
#[tauri::command]
pub fn table_set_column_format(
    state: State<'_, AppState>,
    path: String,
    col_key: String,
    format: String,
) -> Result<TableDoc, String> {
    let allowed = ["plain", "comma", "usd", "eur", "gbp", "percent"];
    let fmt = if allowed.contains(&format.as_str()) { format } else { "plain".to_string() };
    let conn = open_db(&path)?;
    conn.execute(
        "UPDATE cols SET format = ?1 WHERE key = ?2",
        rusqlite::params![fmt, col_key],
    )
    .map_err(|e| format!("db: {e}"))?;
    state.mark_self_write(std::path::Path::new(&path));
    read_doc(&conn, &path)
}

/// Rewrite the value of one column across every row via `f` (old cell → new cell,
/// or `None` to leave it). Used by the option rename/delete sweeps.
fn map_col_cells(
    conn: &Connection,
    col_key: &str,
    f: impl Fn(&str) -> Option<String>,
) -> Result<(), String> {
    let rows: Vec<(i64, String)> = {
        let mut stmt = conn
            .prepare("SELECT id, data FROM rows")
            .map_err(|e| format!("db: {e}"))?;
        let mapped = stmt
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| format!("db: {e}"))?;
        mapped.flatten().collect()
    };
    for (id, data_raw) in rows {
        let mut map: BTreeMap<String, String> = serde_json::from_str(&data_raw).unwrap_or_default();
        let cur = map.get(col_key).cloned().unwrap_or_default();
        if cur.is_empty() {
            continue;
        }
        if let Some(nv) = f(&cur) {
            if nv != cur {
                map.insert(col_key.to_string(), nv);
                let nj = serde_json::to_string(&map).unwrap_or_default();
                let _ = conn.execute(
                    "UPDATE rows SET data = ?1 WHERE id = ?2",
                    rusqlite::params![nj, id],
                );
            }
        }
    }
    Ok(())
}

/// Set the full ordered option list for a select/multiselect/status column, with
/// each option's chosen color and (status) group bucket. Handles reorder, recolor,
/// regroup, add, and delete in one call: `options` is the new authoritative
/// membership+order, and any value dropped from it is cleared from every row cell
/// (Notion behavior — removing an option removes the tag). Renames go through
/// `table_rename_option` instead (a bare list can't express old→new).
#[tauri::command]
pub fn table_set_options(
    state: State<'_, AppState>,
    path: String,
    col_key: String,
    options: Vec<OptionMeta>,
) -> Result<TableDoc, String> {
    set_options_core(&state, &path, &col_key, options)
}

fn set_options_core(
    state: &AppState,
    path: &str,
    col_key: &str,
    options: Vec<OptionMeta>,
) -> Result<TableDoc, String> {
    let conn = open_db(path)?;
    // De-dupe by value, preserving first occurrence order.
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut values: Vec<String> = Vec::new();
    let mut metamap = serde_json::Map::new();
    for o in &options {
        let v = o.value.trim();
        if v.is_empty() || !seen.insert(v.to_string()) {
            continue;
        }
        values.push(v.to_string());
        let mut entry = serde_json::Map::new();
        if let Some(c) = o.color.as_deref().filter(|s| !s.is_empty()) {
            entry.insert("color".into(), json!(c));
        }
        if let Some(g) = o.group.as_deref().filter(|s| !s.is_empty()) {
            entry.insert("group".into(), json!(g));
        }
        if !entry.is_empty() {
            metamap.insert(v.to_string(), Value::Object(entry));
        }
    }
    let opts_json = serde_json::to_string(&values).unwrap_or_else(|_| "[]".into());
    let meta_json = serde_json::to_string(&Value::Object(metamap)).unwrap_or_else(|_| "{}".into());
    conn.execute(
        "UPDATE cols SET options = ?1, option_meta = ?2 WHERE key = ?3",
        rusqlite::params![opts_json, meta_json, col_key],
    )
    .map_err(|e| format!("db: {e}"))?;
    // Clear any dropped values from row cells.
    let keep: std::collections::HashSet<String> = values.into_iter().collect();
    let is_multi = conn
        .query_row(
            "SELECT type FROM cols WHERE key = ?1",
            rusqlite::params![col_key],
            |r| r.get::<_, String>(0),
        )
        .map(|t| t == "multiselect")
        .unwrap_or(false);
    map_col_cells(&conn, col_key, |cur| {
        if is_multi {
            let kept: Vec<String> = parse_multi(cur).into_iter().filter(|v| keep.contains(v)).collect();
            Some(if kept.is_empty() { String::new() } else { serde_json::to_string(&kept).unwrap_or_default() })
        } else if keep.contains(cur) {
            None
        } else {
            Some(String::new())
        }
    })?;
    state.mark_self_write(Path::new(path));
    read_doc(&conn, path)
}

/// Rename an option value `from`→`to`: updates the column's `options` entry in
/// place (preserving position), moves its color/group metadata, and rewrites every
/// row cell that held `from` (select/status: exact; multiselect: within the array).
#[tauri::command]
pub fn table_rename_option(
    state: State<'_, AppState>,
    path: String,
    col_key: String,
    from: String,
    to: String,
) -> Result<TableDoc, String> {
    rename_option_core(&state, &path, &col_key, &from, &to)
}

fn rename_option_core(
    state: &AppState,
    path: &str,
    col_key: &str,
    from: &str,
    to: &str,
) -> Result<TableDoc, String> {
    let conn = open_db(path)?;
    let from = from.trim().to_string();
    let to = to.trim().to_string();
    if from.is_empty() || to.is_empty() || from == to {
        return read_doc(&conn, path);
    }
    // options[] in place, de-duped if `to` already existed.
    let cur_raw: String = conn
        .query_row("SELECT options FROM cols WHERE key = ?1", rusqlite::params![col_key], |r| r.get(0))
        .unwrap_or_else(|_| "[]".into());
    let mut opts: Vec<String> = serde_json::from_str(&cur_raw).unwrap_or_default();
    for o in opts.iter_mut() {
        if *o == from {
            *o = to.clone();
        }
    }
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    opts.retain(|o| seen.insert(o.clone()));
    let opts_json = serde_json::to_string(&opts).unwrap_or_else(|_| "[]".into());
    // move the color/group metadata key from→to.
    let meta_raw: String = conn
        .query_row(
            "SELECT option_meta FROM cols WHERE key = ?1",
            rusqlite::params![col_key],
            |r| r.get::<_, Option<String>>(0).map(|o| o.unwrap_or_else(|| "{}".into())),
        )
        .unwrap_or_else(|_| "{}".into());
    let mut mm: serde_json::Map<String, Value> = serde_json::from_str(&meta_raw).unwrap_or_default();
    if let Some(v) = mm.remove(&from) {
        mm.entry(to.clone()).or_insert(v);
    }
    let meta_json = serde_json::to_string(&Value::Object(mm)).unwrap_or_else(|_| "{}".into());
    conn.execute(
        "UPDATE cols SET options = ?1, option_meta = ?2 WHERE key = ?3",
        rusqlite::params![opts_json, meta_json, col_key],
    )
    .map_err(|e| format!("db: {e}"))?;
    // rewrite row cells.
    let is_multi = conn
        .query_row(
            "SELECT type FROM cols WHERE key = ?1",
            rusqlite::params![col_key],
            |r| r.get::<_, String>(0),
        )
        .map(|t| t == "multiselect")
        .unwrap_or(false);
    map_col_cells(&conn, col_key, |cur| {
        if is_multi {
            let mut changed = false;
            let mut out: Vec<String> = Vec::new();
            for v in parse_multi(cur) {
                let nv = if v == from { changed = true; to.clone() } else { v };
                if !out.contains(&nv) {
                    out.push(nv);
                }
            }
            if changed {
                Some(serde_json::to_string(&out).unwrap_or_default())
            } else {
                None
            }
        } else if cur == from {
            Some(to.clone())
        } else {
            None
        }
    })?;
    state.mark_self_write(Path::new(path));
    read_doc(&conn, path)
}

/// Duplicate a column (def + every row's value), inserted right after the source.
#[tauri::command]
pub fn table_duplicate_column(
    state: State<'_, AppState>,
    path: String,
    col_key: String,
) -> Result<TableDoc, String> {
    let conn = open_db(&path)?;
    let (name, ctype, opts, ometa): (String, String, String, Option<String>) = conn
        .query_row(
            "SELECT name, type, options, option_meta FROM cols WHERE key = ?1",
            rusqlite::params![col_key],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(|_| "no such column".to_string())?;
    let ometa = ometa.unwrap_or_else(|| "{}".into());
    let src_pos: i64 = conn
        .query_row("SELECT pos FROM cols WHERE key = ?1", rusqlite::params![col_key], |r| r.get(0))
        .unwrap_or(0);
    let new_key = next_col_key(&conn)?;
    conn.execute("UPDATE cols SET pos = pos + 1 WHERE pos > ?1", rusqlite::params![src_pos])
        .map_err(|e| format!("db: {e}"))?;
    conn.execute(
        "INSERT INTO cols (pos, key, name, type, options, option_meta) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![src_pos + 1, new_key, format!("{name} copy"), ctype, opts, ometa],
    )
    .map_err(|e| format!("db: {e}"))?;
    // copy each row's value from the source field into the new one
    conn.execute(
        "UPDATE rows SET data = json_set(data, '$.' || json_quote(?1), json_extract(data, '$.' || json_quote(?2)))",
        rusqlite::params![new_key, col_key],
    )
    .map_err(|e| format!("db: {e}"))?;
    state.mark_self_write(std::path::Path::new(&path));
    read_doc(&conn, &path)
}

/// Reorder columns to match `keys` (left→right). Keys not present are ignored;
/// any existing column absent from `keys` is appended after, preserving order.
#[tauri::command]
pub fn table_reorder_columns(
    state: State<'_, AppState>,
    path: String,
    keys: Vec<String>,
) -> Result<TableDoc, String> {
    let conn = open_db(&path)?;
    let mut pos: i64 = 0;
    for k in &keys {
        let n = conn
            .execute(
                "UPDATE cols SET pos = ?1 WHERE key = ?2",
                rusqlite::params![pos, k],
            )
            .map_err(|e| format!("db: {e}"))?;
        if n > 0 {
            pos += 1;
        }
    }
    state.mark_self_write(std::path::Path::new(&path));
    read_doc(&conn, &path)
}

// ── views (saved layouts + per-view sort/filter/group) ──────────────────────

fn norm_view_kind(k: &str) -> String {
    if VIEW_KINDS.contains(&k) { k.to_string() } else { "table".to_string() }
}

#[tauri::command]
pub fn table_add_view(
    state: State<'_, AppState>,
    path: String,
    name: String,
    kind: String,
) -> Result<TableDoc, String> {
    let conn = open_db(&path)?;
    let pos: i64 = conn
        .query_row("SELECT COALESCE(MAX(pos), -1) + 1 FROM views", [], |r| r.get(0))
        .unwrap_or(0);
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM views", [], |r| r.get(0)).unwrap_or(0);
    let id = format!("v{}", n + 1);
    let display = if name.trim().is_empty() { norm_view_kind(&kind) } else { name };
    conn.execute(
        "INSERT INTO views (pos, id, name, kind, config) VALUES (?1, ?2, ?3, ?4, '{}')",
        rusqlite::params![pos, id, display, norm_view_kind(&kind)],
    )
    .map_err(|e| format!("db: {e}"))?;
    state.mark_self_write(std::path::Path::new(&path));
    read_doc(&conn, &path)
}

#[tauri::command]
pub fn table_update_view(
    state: State<'_, AppState>,
    path: String,
    id: String,
    name: Option<String>,
    config: Option<Value>,
    kind: Option<String>,
) -> Result<TableDoc, String> {
    let conn = open_db(&path)?;
    if let Some(nm) = name {
        conn.execute("UPDATE views SET name = ?1 WHERE id = ?2", rusqlite::params![nm, id])
            .map_err(|e| format!("db: {e}"))?;
    }
    // "Display as" — switch the view's layout (table/board/gallery/list/calendar).
    if let Some(k) = kind {
        conn.execute("UPDATE views SET kind = ?1 WHERE id = ?2", rusqlite::params![norm_view_kind(&k), id])
            .map_err(|e| format!("db: {e}"))?;
    }
    if let Some(cfg) = config {
        conn.execute(
            "UPDATE views SET config = ?1 WHERE id = ?2",
            rusqlite::params![cfg.to_string(), id],
        )
        .map_err(|e| format!("db: {e}"))?;
    }
    state.mark_self_write(std::path::Path::new(&path));
    read_doc(&conn, &path)
}

#[tauri::command]
pub fn table_delete_view(
    state: State<'_, AppState>,
    path: String,
    id: String,
) -> Result<TableDoc, String> {
    let conn = open_db(&path)?;
    // Never delete the last view — a table always has at least one.
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM views", [], |r| r.get(0)).unwrap_or(0);
    if n > 1 {
        conn.execute("DELETE FROM views WHERE id = ?1", rusqlite::params![id])
            .map_err(|e| format!("db: {e}"))?;
    }
    state.mark_self_write(std::path::Path::new(&path));
    read_doc(&conn, &path)
}

/// Set (or clear) a display-metadata key — e.g. "title" or "icon". An empty
/// value removes the key so the frontend falls back to the filename / default.
#[tauri::command]
pub fn table_set_meta(
    state: State<'_, AppState>,
    path: String,
    key: String,
    value: String,
) -> Result<TableDoc, String> {
    let conn = open_db(&path)?;
    if value.is_empty() {
        conn.execute("DELETE FROM meta WHERE key = ?1", rusqlite::params![key])
            .map_err(|e| format!("db: {e}"))?;
    } else {
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![key, value],
        )
        .map_err(|e| format!("db: {e}"))?;
    }
    state.mark_self_write(std::path::Path::new(&path));
    read_doc(&conn, &path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    // A unique temp csv path per test (no Date/rand needed — pid + counter).
    fn tmp_csv() -> String {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("spike-dt-{}-{}", std::process::id(), n));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("people.csv").to_string_lossy().into_owned()
    }

    #[test]
    fn parse_csv_handles_quotes_commas_and_newlines() {
        let text = "Name,Note\n\"Doe, Jane\",\"line1\nline2\"\nAda,\"say \"\"hi\"\"\"\n";
        let recs = parse_csv(text);
        assert_eq!(recs.len(), 3);
        assert_eq!(recs[1], vec!["Doe, Jane".to_string(), "line1\nline2".to_string()]);
        assert_eq!(recs[2], vec!["Ada".to_string(), "say \"hi\"".to_string()]);
    }

    #[test]
    fn infer_type_detects_number_and_checkbox() {
        assert_eq!(infer_type(&["1".into(), "2.5".into(), "$3,000".into()]), "number");
        assert_eq!(infer_type(&["true".into(), "no".into(), "".into()]), "checkbox");
        assert_eq!(infer_type(&["hi".into(), "2".into()]), "text");
        assert_eq!(infer_type(&["".into(), "".into()]), "text");
    }

    #[test]
    fn csv_field_quotes_only_when_needed() {
        assert_eq!(csv_field("plain"), "plain");
        assert_eq!(csv_field("a,b"), "\"a,b\"");
        assert_eq!(csv_field("say \"hi\""), "\"say \"\"hi\"\"\"");
    }

    #[test]
    fn db_path_derivation() {
        assert!(is_table_path("/x/y.spiketable"));
        assert!(!is_table_path("/x/y.csv"));
        assert_eq!(db_path_for("/x/people.csv").unwrap(), Path::new("/x/people.spiketable"));
        assert_eq!(db_path_for("/x/people.spiketable").unwrap(), Path::new("/x/people.spiketable"));
    }

    #[test]
    fn import_creates_spiketable_edit_persists_and_export_is_on_demand() {
        let state = AppState::default();
        let csv = tmp_csv();
        std::fs::write(&csv, "Name,Score,Warm\nReed,30,false\nChen,5,true\n").unwrap();

        // Adopt: builds a sibling .spiketable (source of truth), infers types.
        // The returned doc.path is the .spiketable, NOT the csv.
        let doc = import_core(&state, &csv).unwrap();
        assert!(doc.path.ends_with("people.spiketable"), "doc.path is the table: {}", doc.path);
        assert_eq!(doc.columns.len(), 3);
        assert_eq!(doc.rows.len(), 2);
        assert_eq!(doc.columns.iter().find(|c| c.name == "Score").unwrap().col_type, "number");
        assert_eq!(doc.columns.iter().find(|c| c.name == "Warm").unwrap().col_type, "checkbox");
        let table = doc.path.clone();
        assert!(Path::new(&table).exists(), "the .spiketable file exists");

        // No silent csv mirror: import must NOT have rewritten the source csv.
        assert_eq!(std::fs::read_to_string(&csv).unwrap(), "Name,Score,Warm\nReed,30,false\nChen,5,true\n");

        // Edit a cell against the TABLE path; persists to disk (re-read confirms).
        let name_key = doc.columns.iter().find(|c| c.name == "Name").unwrap().key.clone();
        let reed_id = doc.rows[0].id;
        let doc2 = set_cell_core(&state, &table, reed_id, &name_key, "Reed Jr").unwrap();
        assert_eq!(doc2.rows[0].cells.get(&name_key).unwrap(), "Reed Jr");
        let reread = table_read(table.clone()).unwrap();
        assert_eq!(reread.rows[0].cells.get(&name_key).unwrap(), "Reed Jr");

        // On-demand export writes a sibling csv reflecting the edit.
        let conn = open_db(&table).unwrap();
        let csv_out = write_csv(&conn, &table, &state).unwrap();
        assert!(csv_out.ends_with("people.csv"));
        let exported = std::fs::read_to_string(&csv_out).unwrap();
        assert!(exported.starts_with("Name,Score,Warm\n"), "header: {exported:?}");
        assert!(exported.contains("Reed Jr,30,false"), "edit exported: {exported:?}");

        let _ = std::fs::remove_dir_all(Path::new(&csv).parent().unwrap());
    }

    #[test]
    fn setting_a_select_cell_remembers_the_value_as_a_column_option() {
        let state = AppState::default();
        let csv = tmp_csv();
        std::fs::write(&csv, "Name,Industry\nAmy,\n").unwrap();
        let doc = import_core(&state, &csv).unwrap();
        let table = doc.path.clone();
        let ind = doc.columns.iter().find(|c| c.name == "Industry").unwrap().key.clone();
        let amy = doc.rows[0].id;

        // make it a select column, then type a brand-new value into the cell
        open_db(&table).unwrap().execute("UPDATE cols SET type='select' WHERE key=?1", rusqlite::params![ind]).unwrap();
        let d = set_cell_core(&state, &table, amy, &ind, "VC").unwrap();
        let col = d.columns.iter().find(|c| c.key == ind).unwrap();
        assert!(col.options.contains(&"VC".to_string()), "typed value becomes an option: {:?}", col.options);

        // re-reading from disk keeps the option (it persisted, not just in-memory)
        let reread = table_read(table.clone()).unwrap();
        let col2 = reread.columns.iter().find(|c| c.key == ind).unwrap();
        assert!(col2.options.contains(&"VC".to_string()));

        let _ = std::fs::remove_dir_all(Path::new(&csv).parent().unwrap());
    }

    #[test]
    fn multiselect_cell_merges_each_tag_into_options() {
        let state = AppState::default();
        let csv = tmp_csv();
        std::fs::write(&csv, "Name,Tags\nAmy,\n").unwrap();
        let doc = import_core(&state, &csv).unwrap();
        let table = doc.path.clone();
        let tags = doc.columns.iter().find(|c| c.name == "Tags").unwrap().key.clone();
        let amy = doc.rows[0].id;

        open_db(&table).unwrap().execute("UPDATE cols SET type='multiselect' WHERE key=?1", rusqlite::params![tags]).unwrap();
        let d = set_cell_core(&state, &table, amy, &tags, r#"["VC","Seed"]"#).unwrap();
        let col = d.columns.iter().find(|c| c.key == tags).unwrap();
        assert!(col.options.contains(&"VC".to_string()) && col.options.contains(&"Seed".to_string()),
            "both tags become options: {:?}", col.options);

        let _ = std::fs::remove_dir_all(Path::new(&csv).parent().unwrap());
    }

    #[test]
    fn set_options_persists_colors_groups_and_clears_dropped_values() {
        let state = AppState::default();
        let csv = tmp_csv();
        std::fs::write(&csv, "Name,Stage\nAmy,Seed\nBo,VC\nCy,Seed\n").unwrap();
        let doc = import_core(&state, &csv).unwrap();
        let table = doc.path.clone();
        let stage = doc.columns.iter().find(|c| c.name == "Stage").unwrap().key.clone();
        open_db(&table).unwrap().execute("UPDATE cols SET type='select' WHERE key=?1", rusqlite::params![stage]).unwrap();

        // Recolor + regroup the two options; drop nothing yet.
        let d = set_options_core(&state, &table, &stage, vec![
            OptionMeta { value: "Seed".into(), color: Some("#6FA96A".into()), group: None },
            OptionMeta { value: "VC".into(), color: Some("#5A8FC2".into()), group: Some("active".into()) },
        ]).unwrap();
        let col = d.columns.iter().find(|c| c.key == stage).unwrap();
        assert_eq!(col.options, vec!["Seed".to_string(), "VC".to_string()]);
        assert_eq!(col.option_meta["Seed"]["color"], json!("#6FA96A"));
        assert_eq!(col.option_meta["VC"]["group"], json!("active"));

        // Survives a fresh read from disk.
        let reread = table_read(table.clone()).unwrap();
        let col2 = reread.columns.iter().find(|c| c.key == stage).unwrap();
        assert_eq!(col2.option_meta["VC"]["color"], json!("#5A8FC2"));

        // Dropping "Seed" clears it from every row cell (Notion behavior).
        let d2 = set_options_core(&state, &table, &stage, vec![
            OptionMeta { value: "VC".into(), color: Some("#5A8FC2".into()), group: None },
        ]).unwrap();
        let seed_cells = d2.rows.iter().filter(|r| r.cells.get(&stage).map(String::as_str) == Some("Seed")).count();
        assert_eq!(seed_cells, 0, "dropped option is removed from cells");
        assert_eq!(d2.rows.iter().filter(|r| r.cells.get(&stage).map(String::as_str) == Some("VC")).count(), 1);

        let _ = std::fs::remove_dir_all(Path::new(&csv).parent().unwrap());
    }

    #[test]
    fn rename_option_migrates_cells_and_metadata() {
        let state = AppState::default();
        let csv = tmp_csv();
        std::fs::write(&csv, "Name,Stage\nAmy,Seed\nBo,Seed\n").unwrap();
        let doc = import_core(&state, &csv).unwrap();
        let table = doc.path.clone();
        let stage = doc.columns.iter().find(|c| c.name == "Stage").unwrap().key.clone();
        open_db(&table).unwrap().execute("UPDATE cols SET type='select' WHERE key=?1", rusqlite::params![stage]).unwrap();
        set_options_core(&state, &table, &stage, vec![
            OptionMeta { value: "Seed".into(), color: Some("#6FA96A".into()), group: None },
        ]).unwrap();

        let d = rename_option_core(&state, &table, &stage, "Seed", "Pre-seed").unwrap();
        let col = d.columns.iter().find(|c| c.key == stage).unwrap();
        assert_eq!(col.options, vec!["Pre-seed".to_string()], "option renamed in place");
        assert_eq!(col.option_meta["Pre-seed"]["color"], json!("#6FA96A"), "color follows the rename");
        assert!(col.option_meta.get("Seed").is_none());
        assert_eq!(d.rows.iter().filter(|r| r.cells.get(&stage).map(String::as_str) == Some("Pre-seed")).count(), 2, "every cell migrated");

        let _ = std::fs::remove_dir_all(Path::new(&csv).parent().unwrap());
    }

    #[test]
    fn status_is_an_option_type_and_merges_typed_values() {
        assert!(is_option_type("status"));
        assert!(TYPES.contains(&"status"));
        let state = AppState::default();
        let csv = tmp_csv();
        std::fs::write(&csv, "Name,State\nAmy,\n").unwrap();
        let doc = import_core(&state, &csv).unwrap();
        let table = doc.path.clone();
        let st = doc.columns.iter().find(|c| c.name == "State").unwrap().key.clone();
        let amy = doc.rows[0].id;
        // status behaves like single-select: typing a value remembers it as an option
        open_db(&table).unwrap().execute("UPDATE cols SET type='status' WHERE key=?1", rusqlite::params![st]).unwrap();
        let d = set_cell_core(&state, &table, amy, &st, "In progress").unwrap();
        let col = d.columns.iter().find(|c| c.key == st).unwrap();
        assert_eq!(col.col_type, "status");
        assert!(col.options.contains(&"In progress".to_string()));

        let _ = std::fs::remove_dir_all(Path::new(&csv).parent().unwrap());
    }

    #[test]
    fn table_meta_title_and_icon_persist_and_clear() {
        let state = AppState::default();
        let csv = tmp_csv();
        std::fs::write(&csv, "Name\nAmy\n").unwrap();
        let doc = import_core(&state, &csv).unwrap();
        let table = doc.path.clone();
        assert!(doc.meta.is_empty(), "fresh table has no meta");

        let d = table_set_meta_core(&state, &table, "title", "Team Roster").unwrap();
        let d = table_set_meta_core(&state, &table, "icon", "🚀").unwrap_or(d);
        assert_eq!(d.meta.get("title").map(String::as_str), Some("Team Roster"));
        assert_eq!(d.meta.get("icon").map(String::as_str), Some("🚀"));

        // survives a fresh read from disk
        let reread = table_read(table.clone()).unwrap();
        assert_eq!(reread.meta.get("title").map(String::as_str), Some("Team Roster"));

        // empty value clears the key (falls back to the filename on the frontend)
        let cleared = table_set_meta_core(&state, &table, "title", "").unwrap();
        assert!(cleared.meta.get("title").is_none(), "empty value removes the key");

        let _ = std::fs::remove_dir_all(Path::new(&csv).parent().unwrap());
    }

    // Test shim mirroring the table_set_meta command body (the command needs a
    // tauri State we can't build in a unit test).
    fn table_set_meta_core(state: &AppState, path: &str, key: &str, value: &str) -> Result<TableDoc, String> {
        let conn = open_db(path)?;
        if value.is_empty() {
            conn.execute("DELETE FROM meta WHERE key = ?1", rusqlite::params![key]).map_err(|e| format!("db: {e}"))?;
        } else {
            conn.execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                rusqlite::params![key, value],
            ).map_err(|e| format!("db: {e}"))?;
        }
        state.mark_self_write(std::path::Path::new(path));
        read_doc(&conn, path)
    }
}
