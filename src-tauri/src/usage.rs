// usage.rs — Claude Code token-usage accounting, read-only.
//
// Claude Code writes one JSONL transcript per session under
// ~/.claude/projects/<encoded-cwd>/<session>.jsonl. Every assistant turn
// carries a `message.usage` block (input/output/cache token counts) and a
// `message.model`. We walk those files, sum tokens per day / model / project,
// and derive a NOTIONAL dollar cost from a static price table.
//
// "Notional" is load-bearing: on a Pro/Max subscription these tokens are not
// billed per-use, so the cost is what the same usage WOULD cost at API list
// price — a sense of weight, not an invoice. The UI says so.
//
// No network, no API key, no writes. Pure local file parsing, same spirit as
// fs_ops::path_stats.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{json, Value};

// ── pricing ─────────────────────────────────────────────────────────────────
// USD per million tokens, API list price. Cache-write is billed at 1.25× the
// input rate (5-minute TTL) and cache-read at 0.1× — the standard Anthropic
// ratios — so we derive both from the input rate rather than tabulating them.
// Unknown / synthetic models price at zero (we don't fabricate a number for a
// model we don't recognize; their token counts still show in the breakdown).
struct Price {
    input: f64,
    output: f64,
}

fn price_for(model: &str) -> Price {
    let m = model.to_lowercase();
    if m.contains("opus") {
        Price { input: 15.0, output: 75.0 }
    } else if m.contains("haiku") {
        Price { input: 0.80, output: 4.0 }
    } else if m.contains("sonnet") {
        Price { input: 3.0, output: 15.0 }
    } else {
        Price { input: 0.0, output: 0.0 }
    }
}

// ── running tallies ───────────────────────────────────────────────────────────
#[derive(Default, Clone)]
struct Tally {
    input: u64,
    output: u64,
    cache_create: u64,
    cache_read: u64,
    cost: f64,
    messages: u64,
}

impl Tally {
    fn add(&mut self, input: u64, output: u64, cc: u64, cr: u64, cost: f64) {
        self.input += input;
        self.output += output;
        self.cache_create += cc;
        self.cache_read += cr;
        self.cost += cost;
        self.messages += 1;
    }
    fn to_json(&self) -> Value {
        json!({
            "input": self.input,
            "output": self.output,
            "cacheCreate": self.cache_create,
            "cacheRead": self.cache_read,
            "cost": self.cost,
            "messages": self.messages,
        })
    }
}

fn projects_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/"))
        .join(".claude")
        .join("projects")
}

fn u64_at(usage: &Value, key: &str) -> u64 {
    usage.get(key).and_then(|v| v.as_u64()).unwrap_or(0)
}

/// Scan ~/.claude/projects for token usage and return aggregated totals plus
/// per-model, per-day, and per-project breakdowns. Read-only; never errors on a
/// malformed line or unreadable file — it just skips them.
#[tauri::command]
pub fn usage_scan() -> Result<Value, String> {
    let root = projects_dir();
    let mut totals = Tally::default();
    let mut by_model: HashMap<String, Tally> = HashMap::new();
    let mut by_day: HashMap<String, Tally> = HashMap::new();
    let mut by_project: HashMap<String, Tally> = HashMap::new();
    // Dedup: a single assistant message (same id + request) can recur across
    // resumed sessions / sidechain copies. Count each billable turn once.
    let mut seen: HashSet<String> = HashSet::new();
    let mut scanned_files: u64 = 0;
    let mut sessions: u64 = 0;

    let project_dirs = match std::fs::read_dir(&root) {
        Ok(e) => e,
        // No ~/.claude/projects yet → empty report, not an error.
        Err(_) => return Ok(empty_report()),
    };

    for pd in project_dirs.flatten() {
        if !pd.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let project = pd.file_name().to_string_lossy().into_owned();
        let files = match std::fs::read_dir(pd.path()) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for fe in files.flatten() {
            let path = fe.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let file = match std::fs::File::open(&path) {
                Ok(f) => f,
                Err(_) => continue,
            };
            scanned_files += 1;
            let mut session_had_usage = false;
            for line in BufReader::new(file).lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => continue,
                };
                if line.trim().is_empty() {
                    continue;
                }
                let rec: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let msg = match rec.get("message") {
                    Some(m) if m.is_object() => m,
                    _ => continue,
                };
                let usage = match msg.get("usage") {
                    Some(u) if u.is_object() => u,
                    _ => continue,
                };

                // dedup key: message id + request id; fall back to neither so a
                // record missing both still counts (just can't be deduped).
                let mid = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let rid = rec.get("requestId").and_then(|v| v.as_str()).unwrap_or("");
                if !mid.is_empty() || !rid.is_empty() {
                    let key = format!("{mid}:{rid}");
                    if !seen.insert(key) {
                        continue;
                    }
                }

                let input = u64_at(usage, "input_tokens");
                let output = u64_at(usage, "output_tokens");
                let cc = u64_at(usage, "cache_creation_input_tokens");
                let cr = u64_at(usage, "cache_read_input_tokens");
                if input == 0 && output == 0 && cc == 0 && cr == 0 {
                    continue;
                }

                let model = msg
                    .get("model")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                let p = price_for(&model);
                let cost = input as f64 / 1e6 * p.input
                    + output as f64 / 1e6 * p.output
                    + cc as f64 / 1e6 * (p.input * 1.25)
                    + cr as f64 / 1e6 * (p.input * 0.1);

                let day = iso_day(rec.get("timestamp").and_then(|v| v.as_str()));

                totals.add(input, output, cc, cr, cost);
                by_model.entry(model).or_default().add(input, output, cc, cr, cost);
                by_day.entry(day).or_default().add(input, output, cc, cr, cost);
                by_project
                    .entry(project.clone())
                    .or_default()
                    .add(input, output, cc, cr, cost);
                session_had_usage = true;
            }
            if session_had_usage {
                sessions += 1;
            }
        }
    }

    // ── shape the breakdowns ──
    // by model: descending cost
    let mut models: Vec<Value> = by_model
        .into_iter()
        .map(|(model, t)| {
            let mut o = t.to_json();
            o["model"] = json!(model);
            o
        })
        .collect();
    models.sort_by(|a, b| cost_of(b).partial_cmp(&cost_of(a)).unwrap_or(std::cmp::Ordering::Equal));

    // by day: chronological (the chart wants left→right time)
    let mut days: Vec<Value> = by_day
        .into_iter()
        .map(|(day, t)| {
            let mut o = t.to_json();
            o["day"] = json!(day);
            o
        })
        .collect();
    days.sort_by(|a, b| {
        a.get("day").and_then(|v| v.as_str()).unwrap_or("")
            .cmp(b.get("day").and_then(|v| v.as_str()).unwrap_or(""))
    });

    // by project: descending cost, top 12 (the rest fold into nothing — the UI
    // notes the count so truncation isn't silent)
    let project_count = by_project.len();
    let mut projects: Vec<Value> = by_project
        .into_iter()
        .map(|(project, t)| {
            let mut o = t.to_json();
            o["project"] = json!(project);
            o
        })
        .collect();
    projects.sort_by(|a, b| cost_of(b).partial_cmp(&cost_of(a)).unwrap_or(std::cmp::Ordering::Equal));
    let truncated_projects = project_count.saturating_sub(12);
    projects.truncate(12);

    let mut out = totals.to_json();
    out["sessions"] = json!(sessions);
    out["scannedFiles"] = json!(scanned_files);
    Ok(json!({
        "totals": out,
        "byModel": models,
        "byDay": days,
        "byProject": projects,
        "truncatedProjects": truncated_projects,
    }))
}

/// How the user is signed in to Claude Code, for the Usage pane's framing.
/// Read from ~/.claude.json's `oauthAccount` block (no secrets returned — only
/// plan tier + billing type; never the email/UUIDs/tokens). Lets the pane
/// auto-detect the plan and switch between subscription (notional) and API
/// (actual-cost) framing.
///
///   authType: "subscription" | "api" | "unknown"
///   plan:     "max_20x" | "max_5x" | "pro" | null
///   planUsd:  monthly plan price (200/100/20) | null
#[tauri::command]
pub fn claude_account() -> Result<Value, String> {
    let has_api_key = std::env::var("ANTHROPIC_API_KEY")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);

    let path = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/"))
        .join(".claude.json");
    let oa: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|d| d.get("oauthAccount").cloned())
        .unwrap_or_else(|| json!({}));

    let billing = oa.get("billingType").and_then(|v| v.as_str()).unwrap_or("");
    let org_type = oa.get("organizationType").and_then(|v| v.as_str()).unwrap_or("");
    let rate_tier = oa
        .get("organizationRateLimitTier")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .or_else(|| oa.get("userRateLimitTier").and_then(|v| v.as_str()))
        .unwrap_or("");

    // plan price from the rate-limit tier slug (e.g. "default_claude_max_20x")
    let (plan, plan_usd): (Option<&str>, Option<u32>) = if rate_tier.contains("max_20x") {
        (Some("max_20x"), Some(200))
    } else if rate_tier.contains("max_5x") {
        (Some("max_5x"), Some(100))
    } else if rate_tier.contains("pro") || org_type.contains("pro") {
        (Some("pro"), Some(20))
    } else {
        (None, None)
    };

    // API key wins (Claude Code uses it when present); otherwise a stripe
    // subscription oauthAccount means subscription billing.
    let auth_type = if has_api_key {
        "api"
    } else if billing == "stripe_subscription" {
        "subscription"
    } else if !oa.as_object().map(|o| o.is_empty()).unwrap_or(true) {
        "subscription" // signed-in Claude account, non-stripe (team/enterprise)
    } else {
        "unknown"
    };

    Ok(json!({
        "authType": auth_type,
        "plan": plan,
        "planUsd": plan_usd,
        "organizationType": org_type,
        "subscriptionCreatedAt": oa.get("subscriptionCreatedAt").cloned().unwrap_or(Value::Null),
    }))
}

fn cost_of(v: &Value) -> f64 {
    v.get("cost").and_then(|c| c.as_f64()).unwrap_or(0.0)
}

/// UTC day from an ISO-8601 timestamp ("2026-06-01T..." → "2026-06-01"), or
/// "unknown" when it's absent or too short. Uses `get(..10)` (not `s[..10]`): the
/// timestamp comes from arbitrary JSONL under ~/.claude/projects, so a corrupt or
/// crafted line whose 10th byte lands mid-UTF-8 must yield "unknown", not panic
/// the whole scan.
fn iso_day(ts: Option<&str>) -> String {
    ts.and_then(|s| s.get(..10))
        .map(str::to_string)
        .unwrap_or_else(|| "unknown".to_string())
}

fn empty_report() -> Value {
    json!({
        "totals": {
            "input": 0, "output": 0, "cacheCreate": 0, "cacheRead": 0,
            "cost": 0.0, "messages": 0, "sessions": 0, "scannedFiles": 0,
        },
        "byModel": [],
        "byDay": [],
        "byProject": [],
        "truncatedProjects": 0,
    })
}

// ── Codex ───────────────────────────────────────────────────────────────────
// Codex writes cumulative token snapshots to rollout JSONL files. Unlike the
// Claude records above, cached input is a subset of input and reasoning output
// is a subset of output; neither may be added again when displaying totals.
// We turn cumulative snapshots into per-request deltas so repeated snapshots
// and resumed turns do not inflate the report.

#[derive(Default, Clone, Copy)]
struct CodexCounts {
    input: u64,
    cached_input: u64,
    output: u64,
    reasoning_output: u64,
}

impl CodexCounts {
    fn from_usage(v: &Value) -> Self {
        Self {
            input: u64_at(v, "input_tokens"),
            cached_input: u64_at(v, "cached_input_tokens"),
            output: u64_at(v, "output_tokens"),
            reasoning_output: u64_at(v, "reasoning_output_tokens"),
        }
    }

    fn delta_from(self, previous: Option<Self>) -> Self {
        let Some(p) = previous else { return self };
        // A reset is unusual but legal across format/version boundaries. Treat
        // the new snapshot as a fresh baseline rather than losing that usage.
        if self.input < p.input
            || self.cached_input < p.cached_input
            || self.output < p.output
            || self.reasoning_output < p.reasoning_output
        {
            return self;
        }
        Self {
            input: self.input - p.input,
            cached_input: self.cached_input - p.cached_input,
            output: self.output - p.output,
            reasoning_output: self.reasoning_output - p.reasoning_output,
        }
    }

    fn is_empty(self) -> bool {
        self.input == 0 && self.output == 0 && self.cached_input == 0
    }
}

struct CodexPrice {
    input_credits: f64,
    cached_input_credits: f64,
    output_credits: f64,
}

// Credits per million tokens from the Codex rate card. Unknown models remain
// visible with zero estimated cost and are called out in `unpricedModels`.
fn codex_price_for(model: &str) -> Option<CodexPrice> {
    let m = model.to_lowercase();
    if m.contains("gpt-5.6-sol") {
        Some(CodexPrice {
            input_credits: 125.0,
            cached_input_credits: 12.5,
            output_credits: 750.0,
        })
    } else if m.contains("gpt-5.6-terra") {
        Some(CodexPrice {
            input_credits: 62.5,
            cached_input_credits: 6.25,
            output_credits: 375.0,
        })
    } else {
        None
    }
}

#[derive(Default, Clone)]
struct CodexTally {
    input: u64,
    cached_input: u64,
    output: u64,
    reasoning_output: u64,
    credits: f64,
    cost: f64,
    requests: u64,
}

impl CodexTally {
    fn add(&mut self, counts: CodexCounts, price: Option<&CodexPrice>) {
        let cached = counts.cached_input.min(counts.input);
        self.input += counts.input;
        self.cached_input += cached;
        self.output += counts.output;
        self.reasoning_output += counts.reasoning_output.min(counts.output);
        if let Some(p) = price {
            let uncached = counts.input.saturating_sub(cached);
            let credits = uncached as f64 / 1e6 * p.input_credits
                + cached as f64 / 1e6 * p.cached_input_credits
                + counts.output as f64 / 1e6 * p.output_credits;
            self.credits += credits;
            // OpenAI credits are denominated at 25 credits per USD. For a
            // ChatGPT login this is a notional value; for API auth it is still
            // an estimate based on the same token rate card.
            self.cost += credits / 25.0;
        }
        self.requests += 1;
    }

    fn merge(&mut self, other: &Self) {
        self.input += other.input;
        self.cached_input += other.cached_input;
        self.output += other.output;
        self.reasoning_output += other.reasoning_output;
        self.credits += other.credits;
        self.cost += other.cost;
        self.requests += other.requests;
    }

    fn to_json(&self) -> Value {
        json!({
            "input": self.input,
            "cachedInput": self.cached_input,
            "output": self.output,
            "reasoningOutput": self.reasoning_output,
            "credits": self.credits,
            "cost": self.cost,
            "requests": self.requests,
        })
    }
}

struct CodexSession {
    id: String,
    project: String,
    totals: CodexTally,
    by_model: HashMap<String, CodexTally>,
    by_day: HashMap<String, CodexTally>,
}

fn parse_codex_session(path: &std::path::Path) -> Option<CodexSession> {
    let file = std::fs::File::open(path).ok()?;
    let mut id = String::new();
    let mut project = "unknown".to_string();
    let mut model = "unknown".to_string();
    let mut previous: Option<CodexCounts> = None;
    let mut totals = CodexTally::default();
    let mut by_model: HashMap<String, CodexTally> = HashMap::new();
    let mut by_day: HashMap<String, CodexTally> = HashMap::new();

    for line in BufReader::new(file).lines().flatten() {
        if line.trim().is_empty() {
            continue;
        }
        let rec: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let record_type = rec.get("type").and_then(Value::as_str).unwrap_or("");
        let payload = rec.get("payload").unwrap_or(&Value::Null);

        if record_type == "session_meta" {
            id = payload
                .get("id")
                .or_else(|| payload.get("session_id"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            project = payload
                .get("cwd")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            continue;
        }
        if record_type == "turn_context" {
            if let Some(m) = payload.get("model").and_then(Value::as_str) {
                model = m.to_string();
            }
            continue;
        }
        if payload.get("type").and_then(Value::as_str) != Some("token_count") {
            continue;
        }
        let usage = match payload.get("info").and_then(|i| i.get("total_token_usage")) {
            Some(v) if v.is_object() => v,
            _ => continue,
        };
        let current = CodexCounts::from_usage(usage);
        let delta = current.delta_from(previous);
        previous = Some(current);
        if delta.is_empty() {
            continue;
        }
        let price = codex_price_for(&model);
        let day = iso_day(rec.get("timestamp").and_then(Value::as_str));
        totals.add(delta, price.as_ref());
        by_model.entry(model.clone()).or_default().add(delta, price.as_ref());
        by_day.entry(day).or_default().add(delta, price.as_ref());
    }

    if totals.requests == 0 {
        return None;
    }
    if id.is_empty() {
        id = path.to_string_lossy().into_owned();
    }
    Some(CodexSession { id, project, totals, by_model, by_day })
}

fn collect_jsonl(root: &std::path::Path, out: &mut Vec<PathBuf>) {
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let kind = match entry.file_type() {
            Ok(kind) => kind,
            Err(_) => continue,
        };
        if kind.is_dir() {
            collect_jsonl(&path, out);
        } else if kind.is_file() && path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

fn codex_session_roots() -> Vec<PathBuf> {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    let mut roots = vec![
        home.join(".codex").join("sessions"),
        home.join(".codex").join("archived_sessions"),
    ];
    if let Ok(entries) = std::fs::read_dir(home.join(".spike").join("codex-homes")) {
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                roots.push(entry.path().join("sessions"));
                roots.push(entry.path().join("archived_sessions"));
            }
        }
    }
    roots
}

fn scan_codex_roots(roots: &[PathBuf]) -> Value {
    let mut files = Vec::new();
    for root in roots {
        collect_jsonl(root, &mut files);
    }
    files.sort();

    let scanned_files = files.len() as u64;
    let mut seen_sessions = HashSet::new();
    let mut totals = CodexTally::default();
    let mut by_model: HashMap<String, CodexTally> = HashMap::new();
    let mut by_day: HashMap<String, CodexTally> = HashMap::new();
    let mut by_project: HashMap<String, CodexTally> = HashMap::new();

    for path in files {
        let Some(session) = parse_codex_session(&path) else { continue };
        if !seen_sessions.insert(session.id) {
            continue;
        }
        totals.merge(&session.totals);
        by_project.entry(session.project).or_default().merge(&session.totals);
        for (model, tally) in session.by_model {
            by_model.entry(model).or_default().merge(&tally);
        }
        for (day, tally) in session.by_day {
            by_day.entry(day).or_default().merge(&tally);
        }
    }

    let mut unpriced_models: Vec<String> = by_model
        .keys()
        .filter(|model| codex_price_for(model).is_none())
        .cloned()
        .collect();
    unpriced_models.sort();

    let mut models: Vec<Value> = by_model
        .into_iter()
        .map(|(model, tally)| {
            let mut value = tally.to_json();
            value["model"] = json!(model);
            value
        })
        .collect();
    models.sort_by(|a, b| cost_of(b).partial_cmp(&cost_of(a)).unwrap_or(std::cmp::Ordering::Equal));

    let mut days: Vec<Value> = by_day
        .into_iter()
        .map(|(day, tally)| {
            let mut value = tally.to_json();
            value["day"] = json!(day);
            value
        })
        .collect();
    days.sort_by(|a, b| {
        a.get("day").and_then(Value::as_str).unwrap_or("")
            .cmp(b.get("day").and_then(Value::as_str).unwrap_or(""))
    });

    let project_count = by_project.len();
    let mut projects: Vec<Value> = by_project
        .into_iter()
        .map(|(project, tally)| {
            let mut value = tally.to_json();
            value["project"] = json!(project);
            value
        })
        .collect();
    projects.sort_by(|a, b| cost_of(b).partial_cmp(&cost_of(a)).unwrap_or(std::cmp::Ordering::Equal));
    let truncated_projects = project_count.saturating_sub(12);
    projects.truncate(12);

    let mut total_value = totals.to_json();
    total_value["sessions"] = json!(seen_sessions.len());
    total_value["scannedFiles"] = json!(scanned_files);
    json!({
        "totals": total_value,
        "byModel": models,
        "byDay": days,
        "byProject": projects,
        "truncatedProjects": truncated_projects,
        "unpricedModels": unpriced_models,
    })
}

/// Scan normal Codex CLI sessions plus Spike's isolated per-tab CODEX_HOMEs.
/// Read-only; duplicate session IDs are counted once across all roots.
#[tauri::command]
pub fn codex_usage_scan() -> Result<Value, String> {
    Ok(scan_codex_roots(&codex_session_roots()))
}

/// Return only the Codex auth mode. No account IDs, emails, keys, or tokens
/// leave the backend.
#[tauri::command]
pub fn codex_account() -> Result<Value, String> {
    let env_api_key = std::env::var("OPENAI_API_KEY")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    let auth_mode = dirs::home_dir()
        .and_then(|home| std::fs::read_to_string(home.join(".codex").join("auth.json")).ok())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.get("auth_mode").and_then(Value::as_str).map(str::to_string));
    let auth_type = if env_api_key
        || matches!(auth_mode.as_deref(), Some("api") | Some("api_key") | Some("apikey"))
    {
        "api"
    } else if auth_mode.as_deref() == Some("chatgpt") {
        "chatgpt"
    } else {
        "unknown"
    };
    Ok(json!({ "authType": auth_type }))
}

// ── live context occupancy ────────────────────────────────────────────────────
// "How full is this session's context window?" — distinct from usage_scan's
// cumulative billing tally. Context occupancy is a POINT-IN-TIME reading: the
// most recent assistant turn's non-output token footprint (input + both cache
// tiers), which is what Claude Code itself carries forward as the live context.
// Output tokens are excluded — they're the reply, not part of the prompt that
// re-enters the window next turn.

/// The context window (in tokens) a model's transcript should be measured
/// against. The transcript does not record the live window, so we map it from
/// the model id. The current generation (Opus 4.x, Sonnet/Opus 5, Haiku 4.x,
/// Fable 5) ships a 1M window — verified against Claude Code's own `/context`,
/// which reports `…/1m` for claude-opus-4-8. Legacy Claude 3.x models are 200K.
/// Unknown ids default to 1M, since a live Spike session runs a current model.
///
/// This is a static map and will drift if a model's window changes; keep it in
/// step with Claude Code's model registry.
fn context_window_for(model: &str) -> u64 {
    let m = model.to_lowercase();
    // Legacy Claude 3 / 3.5 / 3.7 — 200K. Checked first so the "-5" in
    // "claude-3-5-sonnet" doesn't get mistaken for the 5-family below.
    if m.contains("claude-3") || m.contains("-3-5-") || m.contains("-3-7-") {
        return 200_000;
    }
    // Everything current is 1M (incl. the explicit "[1m]" long-context tag).
    1_000_000
}

/// Read a single Claude Code transcript (by its session/run id — the JSONL
/// filename stem) and report how full its context window is right now.
///
/// Returns `{ tokens, contextWindow, percent, model, found }`. `found:false`
/// (with zeroed fields) means no transcript for that id exists yet or it has no
/// usage-bearing turn — a fresh session that hasn't produced a turn. Read-only;
/// never errors on a bad line or unreadable file, matching usage_scan's spirit.
#[tauri::command]
pub fn session_context(run_id: String, cwd: Option<String>) -> Result<Value, String> {
    Ok(read_session_context(
        &projects_dir(),
        &codex_session_roots(),
        &run_id,
        cwd.as_deref(),
    ))
}

// Testable core of session_context. Works for both engines.
//
// Primary key is the run_id an agent event carries:
//   • Claude — run_id IS the transcript stem: <claude_root>/*/<run_id>.jsonl.
//   • Codex  — run_id is the session UUID embedded in the rollout filename
//     (rollout-<ts>-<uuid>.jsonl), found by recursive search of codex_roots.
//
// The cwd fallback is ONLY for a session with no id of its own. A run_id is an
// identity claim: it names THIS session's transcript, so if that file has no
// usage yet the honest reading is "no context yet" — blank. Guessing from the
// cwd at that point is how a fresh lane inherits a stranger's ring (the folder's
// newest transcript belongs to whatever ran there last, not to us). Claude lanes
// carry a Spike-minted --session-id from spawn, so they always take the exact
// path; the fallback is left for lanes we don't own the identity of (Codex
// before its first agent event, sessions started outside Spike), where a cwd
// guess is still better than nothing.
//
// The fallback itself: Claude Code slugs the cwd into its project dir name, and
// Codex records cwd in session_meta, so we can find the most recently modified
// transcript for that directory and read its occupancy.
//
// Split out so it can be exercised against temp dirs without touching the real
// ~/.claude or ~/.codex.
fn read_session_context(
    claude_root: &std::path::Path,
    codex_roots: &[PathBuf],
    run_id: &str,
    cwd: Option<&str>,
) -> Value {
    if !run_id.is_empty() {
        if let Some(v) = read_claude_context(claude_root, run_id) {
            return v;
        }
        if let Some(v) = read_codex_context(codex_roots, run_id) {
            return v;
        }
        return not_found();
    }
    if let Some(dir) = cwd.filter(|c| !c.is_empty()) {
        if let Some(v) = read_claude_context_by_cwd(claude_root, dir) {
            return v;
        }
        if let Some(v) = read_codex_context_by_cwd(codex_roots, dir) {
            return v;
        }
    }
    not_found()
}

// Claude encodes a session's cwd into its project-dir name by replacing every
// '/' and '.' with '-' (e.g. /Users/x/.claude → -Users-x--claude). Resolve that
// dir and read the most-recently-modified transcript that carries usage.
fn read_claude_context_by_cwd(root: &std::path::Path, cwd: &str) -> Option<Value> {
    let slug: String = cwd
        .chars()
        .map(|c| if c == '/' || c == '.' { '-' } else { c })
        .collect();
    let dir = root.join(&slug);
    // Read the NEWEST transcript in the folder (regardless of usage) and report
    // only if IT has a usage-bearing turn. This is what keeps a brand-new
    // session blank: Claude writes its transcript at session start with only
    // meta records (no usage until the first turn), and that file is the newest,
    // so it reads as "no context yet" — even when older sibling transcripts in
    // the same folder are full. An established/restored session's own transcript
    // is the newest AND has usage, so it lights up immediately.
    let newest = newest_jsonl_with(&dir, |_| true)?;
    read_claude_file_context(&newest)
}

// Codex rollouts don't slug the cwd into a path; instead each carries it in its
// session_meta record. Scan all rollouts, keep those whose cwd matches, and read
// the most recently modified one.
fn read_codex_context_by_cwd(roots: &[PathBuf], cwd: &str) -> Option<Value> {
    let mut files: Vec<PathBuf> = Vec::new();
    for root in roots {
        collect_jsonl(root, &mut files);
    }
    let mut matches: Vec<PathBuf> = files
        .into_iter()
        .filter(|p| codex_file_cwd(p).as_deref() == Some(cwd))
        .collect();
    matches.sort_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok());
    let newest = matches.into_iter().next_back()?;
    read_codex_file_context(&newest)
}

// The cwd recorded in a Codex rollout's session_meta, if any (reads only the
// head of the file — session_meta is the first record).
fn codex_file_cwd(path: &std::path::Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    for line in BufReader::new(file).lines().flatten().take(20) {
        if line.trim().is_empty() {
            continue;
        }
        let rec: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if rec.get("type").and_then(Value::as_str) == Some("session_meta") {
            return rec
                .get("payload")
                .and_then(|p| p.get("cwd"))
                .and_then(Value::as_str)
                .map(|s| s.to_string());
        }
    }
    None
}

// Newest *.jsonl directly under `dir` satisfying `pred`, by mtime.
fn newest_jsonl_with(dir: &std::path::Path, pred: impl Fn(&std::path::Path) -> bool) -> Option<PathBuf> {
    let mut cands: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("jsonl") && pred(p))
        .collect();
    cands.sort_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok());
    cands.into_iter().next_back()
}

// Claude transcript occupancy: the latest usage-bearing turn's non-output token
// footprint (input + both cache tiers) over the model's context window.
fn read_claude_context(root: &std::path::Path, run_id: &str) -> Option<Value> {
    read_claude_file_context(&find_claude_transcript(root, run_id)?)
}

/// The transcript file for a Claude session id, if one exists on disk.
///
/// It lives under ~/.claude/projects/<encoded-cwd>/<run_id>.jsonl, but the cwd
/// slug isn't recoverable from the id alone — scan the project dirs for a file
/// with the matching stem (one shallow level, same as usage_scan).
///
/// Also the existence check the spawn path needs: `claude --resume <id>` errors
/// out when the transcript is gone, so pty.rs asks here first and falls back to
/// starting fresh under the same id. (Public for that caller.)
pub fn find_claude_transcript(root: &std::path::Path, run_id: &str) -> Option<PathBuf> {
    if run_id.is_empty() {
        return None;
    }
    // Remember where a session's transcript lives.
    //
    // The lookup below scans every project directory under ~/.claude/projects
    // because the cwd slug isn't recoverable from the id alone. That was fine
    // when this ran on a turn boundary; the chat view polls roughly once a
    // second, and a working machine accumulates a hundred-plus project dirs,
    // so it became ~100 directory reads per second per open chat view. The
    // mapping is stable for the life of a session, so cache it — and still
    // confirm the file is there, so a deleted transcript re-resolves instead
    // of being served from a stale entry.
    if let Some(hit) = TRANSCRIPT_PATHS.lock().ok().and_then(|mut c| c.get(run_id).cloned()) {
        if hit.is_file() {
            return Some(hit);
        }
    }
    let found = scan_for_transcript(root, run_id)?;
    if let Ok(mut cache) = TRANSCRIPT_PATHS.lock() {
        cache.insert(run_id.to_string(), found.clone());
    }
    Some(found)
}

/// run_id → transcript path. Unbounded, but one small entry per session Spike
/// has looked at in this process; a long day is a few dozen.
static TRANSCRIPT_PATHS: Mutex<Option<HashMap<String, PathBuf>>> = Mutex::new(None);

trait PathCache {
    fn get(&mut self, k: &str) -> Option<&PathBuf>;
    fn insert(&mut self, k: String, v: PathBuf);
}
impl PathCache for std::sync::MutexGuard<'_, Option<HashMap<String, PathBuf>>> {
    fn get(&mut self, k: &str) -> Option<&PathBuf> {
        self.get_or_insert_with(HashMap::new).get(k)
    }
    fn insert(&mut self, k: String, v: PathBuf) {
        self.get_or_insert_with(HashMap::new).insert(k, v);
    }
}

fn scan_for_transcript(root: &std::path::Path, run_id: &str) -> Option<PathBuf> {
    let file_name = format!("{run_id}.jsonl");
    for pd in std::fs::read_dir(root).ok()?.flatten() {
        if !pd.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let candidate = pd.path().join(&file_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Does a Claude transcript exist for this session id? (`projects_dir`-rooted
/// wrapper over `find_claude_transcript` for callers outside this module.)
pub fn claude_transcript_exists(run_id: &str) -> bool {
    find_claude_transcript(&projects_dir(), run_id).is_some()
}

// Read one Claude transcript file's occupancy: the LAST usage-bearing turn's
// non-output token footprint over the model's window. None if the file has no
// usage-bearing turn (a fresh transcript with only meta records).
fn read_claude_file_context(path: &std::path::Path) -> Option<Value> {
    let file = std::fs::File::open(path).ok()?;
    let mut last: Option<(u64, String)> = None;
    for line in BufReader::new(file).lines().flatten() {
        if line.trim().is_empty() {
            continue;
        }
        let rec: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let msg = match rec.get("message") {
            Some(m) if m.is_object() => m,
            _ => continue,
        };
        let usage = match msg.get("usage") {
            Some(u) if u.is_object() => u,
            _ => continue,
        };
        let input = u64_at(usage, "input_tokens");
        let cc = u64_at(usage, "cache_creation_input_tokens");
        let cr = u64_at(usage, "cache_read_input_tokens");
        let tokens = input + cc + cr;
        if tokens == 0 {
            continue;
        }
        let model = msg
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        last = Some((tokens, model));
    }

    let (tokens, model) = last?;
    let window = context_window_for(&model);
    Some(occupancy_json(tokens, window, &model))
}

// Codex rollout occupancy. Codex sends the whole conversation each turn and
// reports, in every `token_count` event, both the running usage and the model's
// context window. The latest event's `last_token_usage.total_tokens` over
// `model_context_window` is exactly what Codex's own TUI shows as context used.
// The rollout file is found by the session UUID (run_id) embedded in its name.
fn read_codex_context(roots: &[PathBuf], run_id: &str) -> Option<Value> {
    if run_id.is_empty() {
        return None;
    }
    let mut files: Vec<PathBuf> = Vec::new();
    for root in roots {
        collect_jsonl(root, &mut files);
    }
    let path = files.into_iter().find(|p| {
        p.file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.contains(run_id))
            .unwrap_or(false)
    })?;
    read_codex_file_context(&path)
}

// Read one Codex rollout's occupancy: the LAST token_count event's
// last_token_usage.total_tokens over model_context_window.
fn read_codex_file_context(path: &std::path::Path) -> Option<Value> {
    let file = std::fs::File::open(path).ok()?;
    // Track the LAST token_count reading and the most recent model seen.
    let mut model = "unknown".to_string();
    let mut last: Option<(u64, u64)> = None; // (tokens_in_context, window)
    for line in BufReader::new(file).lines().flatten() {
        if line.trim().is_empty() {
            continue;
        }
        let rec: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let payload = rec.get("payload").unwrap_or(&Value::Null);
        if rec.get("type").and_then(Value::as_str) == Some("turn_context") {
            if let Some(m) = payload.get("model").and_then(Value::as_str) {
                model = m.to_string();
            }
            continue;
        }
        if payload.get("type").and_then(Value::as_str) != Some("token_count") {
            continue;
        }
        let info = match payload.get("info") {
            Some(i) if i.is_object() => i,
            _ => continue,
        };
        let window = u64_at(info, "model_context_window");
        let last_usage = info.get("last_token_usage").unwrap_or(&Value::Null);
        // total_tokens = full prompt (incl. cached) + this turn's output — the
        // conversation state occupying the window. Fall back to input_tokens if
        // an older rollout omits total_tokens.
        let mut tokens = u64_at(last_usage, "total_tokens");
        if tokens == 0 {
            tokens = u64_at(last_usage, "input_tokens");
        }
        if window == 0 || tokens == 0 {
            continue;
        }
        last = Some((tokens, window));
    }

    let (tokens, window) = last?;
    Some(occupancy_json(tokens, window, &model))
}

// Shared shaping for a found reading: percent is clamped to 100 (a resumed or
// window-shrunk session can briefly read over) and never divides by zero.
fn occupancy_json(tokens: u64, window: u64, model: &str) -> Value {
    let percent = if window == 0 {
        0.0
    } else {
        ((tokens as f64 / window as f64) * 100.0).min(100.0)
    };
    json!({
        "tokens": tokens,
        "contextWindow": window,
        "percent": percent,
        "model": model,
        "found": true,
    })
}

fn not_found() -> Value {
    json!({
        "tokens": 0,
        "contextWindow": 0,
        "percent": 0.0,
        "model": "",
        "found": false,
    })
}

// ─── transcript tail ────────────────────────────────────────────────────────
//
// The chat view (src/web/chatview.ts) renders a lane's conversation from the
// transcript the agent CLI already writes, rather than trying to reconstruct
// meaning from the PTY's redrawing TUI. That needs one thing this module was
// nearly able to do already: hand the frontend the raw lines, incrementally.
//
// Incremental matters. A working session's transcript reaches tens of MB —
// re-reading it on every poll would be a file copy per second. So the caller
// keeps a byte offset and gets only what was appended since.

/// Largest slice returned in one call (8 MiB). A first read of a long-running
/// session gets the tail rather than the whole history; `truncated` says so, so
/// the view can show that it starts mid-conversation instead of pretending the
/// session began there.
const TAIL_MAX: u64 = 8 * 1024 * 1024;

/// The transcript file a lane is writing, plus which engine wrote it.
///
/// Precedence mirrors `read_session_context`: a run_id is an identity claim and
/// is tried against both engines first; the cwd fallback exists only for lanes
/// whose id we don't own (a Codex lane before its first agent event, a session
/// started outside Spike).
fn find_transcript(
    claude_root: &std::path::Path,
    codex_roots: &[PathBuf],
    run_id: &str,
    cwd: Option<&str>,
) -> Option<(PathBuf, &'static str)> {
    if !run_id.is_empty() {
        if let Some(p) = find_claude_transcript(claude_root, run_id) {
            return Some((p, "claude"));
        }
        if let Some(p) = find_codex_rollout(codex_roots, run_id) {
            return Some((p, "codex"));
        }
        // A run_id that resolves to nothing means THIS lane has not written a
        // transcript yet — a brand-new session before its first turn. The only
        // honest answer is "nothing yet". Falling through to the cwd guess here
        // is how a blank lane inherits a stranger's conversation: the newest
        // transcript in a project folder belongs to whatever ran there last,
        // not to us. (Same trap `read_session_context` documents; the chat view
        // hit it because it copied the precedence without this guard.)
        return None;
    }
    let dir = cwd.filter(|c| !c.is_empty())?;
    let slug: String = dir
        .chars()
        .map(|c| if c == '/' || c == '.' { '-' } else { c })
        .collect();
    if let Some(p) = newest_jsonl_with(&claude_root.join(&slug), |_| true) {
        return Some((p, "claude"));
    }
    let mut files: Vec<PathBuf> = Vec::new();
    for root in codex_roots {
        collect_jsonl(root, &mut files);
    }
    let mut matches: Vec<PathBuf> = files
        .into_iter()
        .filter(|p| codex_file_cwd(p).as_deref() == Some(dir))
        .collect();
    matches.sort_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok());
    matches.into_iter().next_back().map(|p| (p, "codex"))
}

/// A Codex rollout whose filename embeds this session UUID
/// (rollout-<ts>-<uuid>.jsonl), searched across every configured sessions root.
fn find_codex_rollout(roots: &[PathBuf], run_id: &str) -> Option<PathBuf> {
    if run_id.is_empty() {
        return None;
    }
    let mut files: Vec<PathBuf> = Vec::new();
    for root in roots {
        collect_jsonl(root, &mut files);
    }
    files.into_iter().find(|p| {
        p.file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.contains(run_id))
            .unwrap_or(false)
    })
}

/// The newest Codex rollout under a TAB'S OWN codex home
/// (`~/.spike/codex-homes/<pty-id>/sessions/**/rollout-*.jsonl`).
///
/// Every Codex tab is spawned with its own CODEX_HOME keyed by the pty id, so
/// whatever rollout lives under that home belongs to that tab and nothing else.
/// That makes this an EXACT key, not the "newest file in this cwd" guess
/// `find_transcript` deliberately refuses — two Codex chats in one folder stay
/// distinct. It matters because a Codex lane has no run_id until its first hook
/// event lands, and if the hook never fires (the hook is only installed into the
/// home on first spawn, so a session that started before it was seeded emits
/// nothing) the lane would read as an empty conversation forever.
fn codex_home_rollout(pty_id: &str) -> Option<PathBuf> {
    codex_home_rollout_in(&dirs::home_dir()?, pty_id)
}

/// Testable core of `codex_home_rollout`: the homes live under `base`.
fn codex_home_rollout_in(base: &std::path::Path, pty_id: &str) -> Option<PathBuf> {
    if pty_id.is_empty() {
        return None;
    }
    let dir = base
        .join(".spike")
        .join("codex-homes")
        .join(pty_id)
        .join("sessions");
    let mut files: Vec<PathBuf> = Vec::new();
    collect_jsonl(&dir, &mut files);
    files.sort_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok());
    files.into_iter().next_back()
}

/// Read whatever was appended to a lane's transcript since `offset`.
///
/// Returns complete lines only: a poll that lands mid-write must not hand back
/// half a JSON object, so a trailing partial line is left unread and the
/// returned offset stops short of it. The next call picks it up whole.
#[tauri::command]
pub fn transcript_tail(
    run_id: String,
    cwd: Option<String>,
    offset: u64,
    pty_id: Option<String>,
) -> Result<Value, String> {
    Ok(read_transcript_tail(
        &projects_dir(),
        &codex_session_roots(),
        &run_id,
        cwd.as_deref(),
        offset,
        pty_id.as_deref(),
    ))
}

/// `invoke('agent_subagents', { runId, cwd })` — the native subagents of a Claude
/// session, for the watch strip. Claude Code stores each Task/Agent subagent as
/// `<projects>/<enc-cwd>/<run_id>/subagents/agent-<id>.{meta.json,jsonl}`: the
/// meta names it + links to the parent Task; the jsonl is its live transcript.
/// We return, per subagent, its label, type, latest narration line, and whether
/// its Task has returned a result in the parent transcript (done). Always Ok —
/// no subagents dir just means an empty list.
#[tauri::command]
pub fn agent_subagents(run_id: String, cwd: Option<String>) -> Result<Value, String> {
    Ok(read_subagents(
        &projects_dir(),
        &codex_session_roots(),
        &run_id,
        cwd.as_deref(),
    ))
}

/// `invoke('agent_subagent_tail', { runId, cwd, agentId, offset })` — the tail of
/// ONE native subagent's own transcript, for the read-only click-in view. Same
/// incremental shape as transcript_tail, but pointed at
/// `<projects>/<enc-cwd>/<run_id>/subagents/agent-<agentId>.jsonl`.
#[tauri::command]
pub fn agent_subagent_tail(
    run_id: String,
    cwd: Option<String>,
    agent_id: String,
    offset: u64,
) -> Result<Value, String> {
    let claude_root = projects_dir();
    let codex_roots = codex_session_roots();
    let Some((main_path, engine)) = find_transcript(&claude_root, &codex_roots, &run_id, cwd.as_deref()) else {
        return Ok(json!({ "found": false, "offset": 0, "lines": [] }));
    };
    if engine != "claude" {
        return Ok(json!({ "found": false, "offset": 0, "lines": [] }));
    }
    let Some(path) = main_path
        .parent()
        .map(|p| p.join(&run_id).join("subagents").join(format!("agent-{agent_id}.jsonl")))
    else {
        return Ok(json!({ "found": false, "offset": 0, "lines": [] }));
    };
    Ok(read_transcript_tail_path(&path, offset))
}

/// Testable core of agent_subagents (temp dirs, no real ~/.claude).
fn read_subagents(
    claude_root: &std::path::Path,
    codex_roots: &[PathBuf],
    run_id: &str,
    cwd: Option<&str>,
) -> Value {
    // Only Claude sessions have this subagents layout; Codex's is different.
    let Some((main_path, engine)) = find_transcript(claude_root, codex_roots, run_id, cwd) else {
        return json!([]);
    };
    if engine != "claude" {
        return json!([]);
    }
    let Some(dir) = main_path.parent().map(|p| p.join(run_id).join("subagents")) else {
        return json!([]);
    };
    let _ = &main_path; // (done is read from each subagent's own transcript, below)
    let mut out: Vec<Value> = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return json!([]);
    };
    for e in entries.flatten() {
        let p = e.path();
        let Some(name) = p.file_name().and_then(|n| n.to_str()) else { continue };
        // pair on the meta file; the sibling jsonl carries the live transcript.
        let Some(stem) = name.strip_suffix(".meta.json") else { continue };
        let Ok(meta) = std::fs::read_to_string(&p).and_then(|s| {
            serde_json::from_str::<Value>(&s).map_err(std::io::Error::other)
        }) else { continue };
        let agent_id = stem.strip_prefix("agent-").unwrap_or(stem).to_string();
        let description = meta.get("description").and_then(Value::as_str).unwrap_or("").to_string();
        let agent_type = meta.get("agentType").and_then(Value::as_str).unwrap_or("").to_string();
        let tool_use_id = meta.get("toolUseId").and_then(Value::as_str).unwrap_or("").to_string();
        let jsonl = dir.join(format!("{stem}.jsonl"));
        let (narration, ended) = subagent_tail_state(&jsonl);
        let ts = std::fs::metadata(&jsonl)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        // Done = the subagent's OWN transcript ended on an end_turn AND it's been
        // quiet a few seconds. NOT the parent's tool_result — for a background
        // agent that lands at launch ("agent working in the background"), which is
        // exactly why every card wrongly read "Done". The stability window keeps a
        // between-turns end_turn from flickering to done while it's still working.
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let done = ended && now.saturating_sub(ts) >= 5;
        out.push(json!({
            "agentId": agent_id,
            "description": description,
            "agentType": agent_type,
            "toolUseId": tool_use_id,
            "narration": narration,
            "done": done,
            "ts": ts,
        }));
    }
    // Oldest first, so the strip reads in spawn order (mtime is a fair proxy).
    out.sort_by_key(|v| v.get("ts").and_then(Value::as_u64).unwrap_or(0));
    json!(out)
}

/// Read a subagent transcript's tail and derive both its latest narration line
/// and whether it has ENDED (its last row is an assistant turn that finished on
/// `end_turn` — the report, with nothing after it). Reads only the file's tail
/// (subagent transcripts run to megabytes), dropping a truncated leading
/// fragment before parsing. Returns (narration, ended).
fn subagent_tail_state(path: &std::path::Path) -> (String, bool) {
    use std::io::{Read, Seek, SeekFrom};
    const WINDOW: u64 = 256 * 1024;
    let Ok(len) = std::fs::metadata(path).map(|m| m.len()) else { return (String::new(), false) };
    let start = len.saturating_sub(WINDOW);
    let Ok(mut file) = std::fs::File::open(path) else { return (String::new(), false) };
    if file.seek(SeekFrom::Start(start)).is_err() {
        return (String::new(), false);
    }
    let mut buf = Vec::new();
    if file.take(WINDOW).read_to_end(&mut buf).is_err() {
        return (String::new(), false);
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = text.lines().collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0); // partial first line from seeking mid-file
    }

    // ended: the last MEANINGFUL turn row is an assistant message whose turn
    // finished on a terminal stop. Walk from the tail skipping bookkeeping rows
    // (result/summary/system rows Claude Code appends after the final turn) —
    // only assistant/user rows decide. A `user` row is a tool_result, i.e. the
    // agent is mid tool-cycle → still working. An `assistant` row ends the agent
    // only on a terminal stop_reason (end_turn/stop_sequence/max_tokens); a
    // `tool_use` stop means a call is pending, so not ended. This is broader than
    // "last row == end_turn": that missed agents that end on a non-end_turn stop
    // or whose transcript trails a bookkeeping row, leaving them stuck "working".
    let mut ended = false;
    for line in lines.iter().rev() {
        let Ok(row) = serde_json::from_str::<Value>(line) else { continue };
        match row.get("type").and_then(Value::as_str) {
            Some("assistant") => {
                ended = matches!(
                    row.get("message").and_then(|m| m.get("stop_reason")).and_then(Value::as_str),
                    Some("end_turn") | Some("stop_sequence") | Some("max_tokens")
                );
                break; // the last assistant turn decides
            }
            // A tool_result (user row) means a tool just returned / is pending —
            // the agent is still mid-cycle, not finished.
            Some("user") => {
                ended = false;
                break;
            }
            // result/summary/system bookkeeping — skip past to the real turn.
            _ => continue,
        }
    }

    // narration: the most recent non-empty assistant text block.
    let mut narration = String::new();
    for line in lines.iter().rev() {
        let Ok(row) = serde_json::from_str::<Value>(line) else { continue };
        if row.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        if let Some(arr) = row.get("message").and_then(|m| m.get("content")).and_then(Value::as_array) {
            for b in arr.iter().rev() {
                if b.get("type").and_then(Value::as_str) == Some("text") {
                    if let Some(t) = b.get("text").and_then(Value::as_str) {
                        let t = t.trim();
                        if !t.is_empty() {
                            narration = first_line_capped(t);
                            break;
                        }
                    }
                }
            }
        }
        if !narration.is_empty() {
            break;
        }
    }
    (narration, ended)
}

/// First sentence/line of a narration chunk, capped so it never overflows the
/// strip's two-line row.
fn first_line_capped(text: &str) -> String {
    let s: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let s = s.trim_start_matches(['#', '>', '*', '-', ' ']);
    if s.chars().count() > 120 {
        let cut: String = s.chars().take(119).collect();
        format!("{}…", cut.trim_end())
    } else {
        s.to_string()
    }
}

// Testable core of transcript_tail (temp dirs, no real ~/.claude).
fn read_transcript_tail(
    claude_root: &std::path::Path,
    codex_roots: &[PathBuf],
    run_id: &str,
    cwd: Option<&str>,
    offset: u64,
    pty_id: Option<&str>,
) -> Value {
    let found = find_transcript(claude_root, codex_roots, run_id, cwd)
        // No run_id yet (or one that resolves to nothing) — but a Codex tab still
        // has an exact key: its own CODEX_HOME. Use it before giving up.
        .or_else(|| pty_id.and_then(codex_home_rollout).map(|p| (p, "codex")));
    let (path, engine) = match found {
        Some(found) => found,
        // Not an error: a lane whose first turn hasn't landed has no file yet,
        // and the view polls again. Erroring would paint a failure on a
        // perfectly healthy brand-new session.
        None => return json!({ "found": false, "offset": 0, "lines": [] }),
    };
    let mut v = read_transcript_tail_path(&path, offset);
    if v["found"] == json!(true) {
        v["engine"] = json!(engine);
    }
    v
}

/// Incremental tail of a SPECIFIC transcript file (no run_id lookup) — the shared
/// core behind read_transcript_tail and the native-subagent viewer. Engine-neutral
/// (subagent transcripts are always Claude JSONL).
fn read_transcript_tail_path(path: &std::path::Path, offset: u64) -> Value {
    let len = match std::fs::metadata(path).map(|m| m.len()) {
        Ok(len) => len,
        Err(_) => return json!({ "found": false, "offset": 0, "lines": [] }),
    };
    // A shorter file than we last read means it was replaced, not appended to.
    let reset = len < offset;
    let mut start = if reset { 0 } else { offset };
    let truncated = len.saturating_sub(start) > TAIL_MAX;
    if truncated {
        start = len - TAIL_MAX;
    }
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) => return json!({ "found": false, "error": e.to_string(), "offset": 0, "lines": [] }),
    };
    use std::io::{Read, Seek, SeekFrom};
    if file.seek(SeekFrom::Start(start)).is_err() {
        return json!({ "found": false, "offset": 0, "lines": [] });
    }
    let mut buf = Vec::new();
    if let Err(e) = file.take(TAIL_MAX).read_to_end(&mut buf) {
        return json!({ "found": false, "error": e.to_string(), "offset": start, "lines": [] });
    }
    // Keep only through the last newline; drop a leading fragment when we seeked in.
    let end = match buf.iter().rposition(|b| *b == b'\n') {
        Some(i) => i + 1,
        None => 0,
    };
    let mut slice = &buf[..end];
    if truncated {
        if let Some(i) = slice.iter().position(|b| *b == b'\n') {
            slice = &slice[i + 1..];
        }
    }
    let consumed = start + end as u64;
    let text = String::from_utf8_lossy(slice);
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    json!({
        "found": true,
        "path": path.to_string_lossy(),
        "engine": "claude",
        "offset": consumed,
        "reset": reset,
        "truncated": truncated,
        "lines": lines,
    })
}

#[cfg(test)]
mod tests {
    use super::{codex_home_rollout_in, context_window_for, iso_day, read_session_context, read_subagents, read_transcript_tail, scan_codex_roots, subagent_tail_state};
    use serde_json::json;

    /// Two Codex tabs in the SAME folder must not read each other's chat. The
    /// run_id key can be missing (no hook event yet), so the fallback is the
    /// tab's own CODEX_HOME — which is per-tab by construction.
    #[test]
    fn codex_home_rollout_is_per_tab_and_newest_wins() {
        let unique = format!("spike-codexhome-{}", std::process::id());
        let base = std::env::temp_dir().join(unique);
        let _ = std::fs::remove_dir_all(&base);
        let mk = |tab: &str, name: &str, body: &str| {
            let dir = base
                .join(".spike")
                .join("codex-homes")
                .join(tab)
                .join("sessions")
                .join("2026")
                .join("08");
            std::fs::create_dir_all(&dir).unwrap();
            let f = dir.join(name);
            std::fs::write(&f, body).unwrap();
            f
        };
        let a = mk("s2-111", "rollout-a.jsonl", "{\"a\":1}\n");
        mk("s4-222", "rollout-b.jsonl", "{\"b\":1}\n");

        // Each tab resolves to its OWN rollout.
        assert_eq!(codex_home_rollout_in(&base, "s2-111").as_deref(), Some(a.as_path()));
        let b = codex_home_rollout_in(&base, "s4-222").unwrap();
        assert!(b.ends_with("rollout-b.jsonl"));

        // An unknown tab (or a Claude lane, which has no home) resolves to nothing
        // rather than borrowing someone else's conversation.
        assert!(codex_home_rollout_in(&base, "s9-999").is_none());
        assert!(codex_home_rollout_in(&base, "").is_none());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn subagent_tail_state_detects_ended_vs_running() {
        let dir = std::env::temp_dir().join(format!("spike-tail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let asst = |text: &str, stop: Option<&str>| {
            let mut m = json!({"content":[{"type":"text","text":text}]});
            if let Some(s) = stop { m["stop_reason"] = json!(s); }
            json!({"type":"assistant","message":m}).to_string()
        };
        // Ends on an end_turn assistant turn → ended.
        let done = dir.join("done.jsonl");
        std::fs::write(&done, format!("{}\n{}\n", asst("working", None), asst("Here is what I found", Some("end_turn")))).unwrap();
        let (n, ended) = subagent_tail_state(&done);
        assert!(ended, "last row is an end_turn assistant → ended");
        assert_eq!(n, "Here is what I found");

        // Last row is a pending tool_use (mid-work) → not ended.
        let running = dir.join("running.jsonl");
        let tool = json!({"type":"assistant","message":{"stop_reason":"tool_use","content":[
            {"type":"text","text":"Let me read the file"},{"type":"tool_use","name":"Read","id":"t1","input":{}}]}}).to_string();
        std::fs::write(&running, format!("{}\n{}\n", asst("hi", Some("end_turn")), tool)).unwrap();
        let (n2, ended2) = subagent_tail_state(&running);
        assert!(!ended2, "a pending tool_use last row means still working");
        assert_eq!(n2, "Let me read the file", "narration is the latest assistant text");

        // Finished agent whose transcript trails a bookkeeping row after the
        // final end_turn turn → still ended (we skip non-turn rows).
        let trailing = dir.join("trailing.jsonl");
        let result_row = json!({"type":"result","subtype":"success"}).to_string();
        std::fs::write(&trailing, format!("{}\n{}\n", asst("All done here", Some("end_turn")), result_row)).unwrap();
        let (_, ended3) = subagent_tail_state(&trailing);
        assert!(ended3, "a trailing result/bookkeeping row must not hide the end_turn");

        // Terminal stop that isn't literally end_turn (e.g. max_tokens) → ended.
        let capped = dir.join("capped.jsonl");
        std::fs::write(&capped, format!("{}\n", asst("Ran out of room", Some("max_tokens")))).unwrap();
        let (_, ended4) = subagent_tail_state(&capped);
        assert!(ended4, "a terminal stop_reason other than end_turn still ends the agent");

        // A tool_result (user) as the last meaningful row → mid-cycle, not ended.
        let midcycle = dir.join("midcycle.jsonl");
        let tresult = json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}).to_string();
        std::fs::write(&midcycle, format!("{}\n{}\n", asst("calling a tool", Some("tool_use")), tresult)).unwrap();
        let (_, ended5) = subagent_tail_state(&midcycle);
        assert!(!ended5, "a trailing tool_result means the agent is still mid-cycle");
    }

    #[test]
    fn read_subagents_lists_natives_with_narration_and_stable_done() {
        let unique = format!(
            "spike-subs-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        );
        let root = std::env::temp_dir().join(unique);
        let proj = root.join("-tmp-project");
        let subs = proj.join("run-subs").join("subagents");
        std::fs::create_dir_all(&subs).unwrap();
        let no_codex: Vec<std::path::PathBuf> = vec![];

        // Main transcript only needs to exist so find_transcript locates the dir.
        std::fs::write(proj.join("run-subs.jsonl"), "{\"type\":\"assistant\"}\n").unwrap();

        let meta = |desc: &str, tuid: &str| {
            json!({"agentType":"general-purpose","description":desc,"toolUseId":tuid,"spawnDepth":1}).to_string()
        };
        let asst = |text: &str, stop: Option<&str>| {
            let mut m = json!({"content":[{"type":"text","text":text}]});
            if let Some(s) = stop { m["stop_reason"] = json!(s); }
            json!({"type":"assistant","message":m}).to_string()
        };
        // aaa: finished (end_turn) AND backdated so it's past the settle window → done.
        std::fs::write(subs.join("agent-aaa.meta.json"), meta("Investigate auth", "toolu_A")).unwrap();
        let aaa = subs.join("agent-aaa.jsonl");
        std::fs::write(&aaa, format!("{}\n", asst("Auth flows through the listener token", Some("end_turn")))).unwrap();
        let old = filetime::FileTime::from_unix_time(
            (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() - 60) as i64, 0);
        filetime::set_file_mtime(&aaa, old).unwrap();
        // bbb: still streaming (no stop_reason) → running.
        std::fs::write(subs.join("agent-bbb.meta.json"), meta("Investigate broker", "toolu_B")).unwrap();
        std::fs::write(subs.join("agent-bbb.jsonl"), format!("{}\n", asst("Searching for the broker", None))).unwrap();

        let arr = read_subagents(&root, &no_codex, "run-subs", None);
        let arr = arr.as_array().unwrap();
        assert_eq!(arr.len(), 2);
        let by = |d: &str| arr.iter().find(|v| v["description"] == d).unwrap();
        assert_eq!(by("Investigate auth")["done"], true, "ended + settled → done");
        assert_eq!(by("Investigate auth")["narration"], "Auth flows through the listener token");
        assert_eq!(by("Investigate broker")["done"], false, "still streaming → running");
        assert_eq!(by("Investigate broker")["narration"], "Searching for the broker");

        assert_eq!(read_subagents(&root, &no_codex, "no-such", None).as_array().unwrap().len(), 0);
    }

    #[test]
    fn context_window_is_1m_for_current_gen_200k_for_legacy() {
        // current generation → 1M (verified against Claude Code's /context)
        assert_eq!(context_window_for("claude-opus-4-8"), 1_000_000);
        assert_eq!(context_window_for("claude-sonnet-5"), 1_000_000);
        assert_eq!(context_window_for("claude-sonnet-4-5[1m]"), 1_000_000);
        assert_eq!(context_window_for("mystery-model"), 1_000_000);
        // legacy Claude 3.x → 200K (the "-5" in 3-5 must not read as 5-family)
        assert_eq!(context_window_for("claude-3-5-sonnet-20241022"), 200_000);
        assert_eq!(context_window_for("claude-3-opus-20240229"), 200_000);
    }

    #[test]
    fn transcript_tail_is_incremental_and_never_splits_a_line() {
        let unique = format!(
            "spike-tail-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let root = std::env::temp_dir().join(unique);
        let proj = root.join("-tmp-project");
        std::fs::create_dir_all(&proj).unwrap();
        let file = proj.join("run-tail.jsonl");
        let no_codex: Vec<std::path::PathBuf> = vec![];

        // No file yet → not found, and emphatically not an error: a lane whose
        // first turn hasn't landed is healthy, it just has nothing to show.
        let none = read_transcript_tail(&root, &no_codex, "run-tail", None, 0, None);
        assert_eq!(none["found"], false);
        assert_eq!(none["lines"].as_array().unwrap().len(), 0);

        std::fs::write(&file, "{\"a\":1}\n{\"a\":2}\n").unwrap();
        let first = read_transcript_tail(&root, &no_codex, "run-tail", None, 0, None);
        assert_eq!(first["found"], true);
        assert_eq!(first["engine"], "claude");
        assert_eq!(first["lines"].as_array().unwrap().len(), 2);
        let off = first["offset"].as_u64().unwrap();
        assert_eq!(off, 16);

        // Re-poll with no new bytes → nothing, same offset. This is the common
        // case (a poll every second on an idle lane) and must stay free.
        let idle = read_transcript_tail(&root, &no_codex, "run-tail", None, off, None);
        assert_eq!(idle["lines"].as_array().unwrap().len(), 0);
        assert_eq!(idle["offset"], off);

        // A poll landing mid-write must return only whole lines and leave the
        // offset short of the fragment — feeding half a JSON object to the
        // parser would drop a real turn.
        std::fs::write(&file, "{\"a\":1}\n{\"a\":2}\n{\"a\":3}\n{\"partia").unwrap();
        let mid = read_transcript_tail(&root, &no_codex, "run-tail", None, off, None);
        let lines = mid["lines"].as_array().unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0], "{\"a\":3}");
        assert_eq!(mid["offset"], 24);

        // The rest of that line arrives → picked up whole on the next poll.
        std::fs::write(&file, "{\"a\":1}\n{\"a\":2}\n{\"a\":3}\n{\"a\":4}\n").unwrap();
        let rest = read_transcript_tail(&root, &no_codex, "run-tail", None, 24, None);
        assert_eq!(rest["lines"].as_array().unwrap().len(), 1);
        assert_eq!(rest["reset"], false);

        // A file that shrank was replaced, not appended to (/clear). Re-read
        // from zero and say so, rather than reading garbage at a stale offset.
        std::fs::write(&file, "{\"a\":9}\n").unwrap();
        let after = read_transcript_tail(&root, &no_codex, "run-tail", None, 32, None);
        assert_eq!(after["reset"], true);
        assert_eq!(after["lines"].as_array().unwrap().len(), 1);

        // A lane that HAS an id but no transcript yet (a brand-new session
        // before its first turn) must read as empty — never as the newest
        // transcript that happens to sit in the same project folder. That is
        // how a blank lane would show a stranger's conversation.
        let fresh = read_transcript_tail(&root, &no_codex, "run-not-written-yet", Some("/tmp/project"), 0, None);
        assert_eq!(fresh["found"], false);
        assert_eq!(fresh["lines"].as_array().unwrap().len(), 0);

        // The cwd fallback still works for a lane with NO id of its own (a
        // Codex lane before its first agent event, a session started outside
        // Spike) — that is the only case it exists for.
        let by_cwd = read_transcript_tail(&root, &no_codex, "", Some("/tmp/project"), 0, None);
        assert_eq!(by_cwd["found"], true);

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn session_context_reads_latest_turn_and_handles_missing() {
        let unique = format!(
            "spike-ctx-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let root = std::env::temp_dir().join(unique);
        let proj = root.join("-tmp-project");
        std::fs::create_dir_all(&proj).unwrap();

        // Three assistant turns; occupancy is the LATEST turn's input + both
        // cache tiers (output excluded), over the model's 200K window.
        let lines = [
            json!({"message":{"model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":999,"cache_read_input_tokens":20,"cache_creation_input_tokens":0}}}),
            json!({"type":"user","message":{"role":"user"}}),  // no usage → skipped
            json!({"message":{"model":"claude-opus-4-8","usage":{"input_tokens":100,"output_tokens":5,"cache_read_input_tokens":49_900,"cache_creation_input_tokens":0}}}),
        ]
        .iter()
        .map(|v| v.to_string())
        .collect::<Vec<_>>()
        .join("\n");
        std::fs::write(proj.join("run-xyz.jsonl"), lines).unwrap();

        let no_codex: Vec<std::path::PathBuf> = vec![];
        let got = read_session_context(&root, &no_codex, "run-xyz", None);
        assert_eq!(got["found"], true);
        assert_eq!(got["tokens"], 50_000); // 100 + 49_900, last turn only
        assert_eq!(got["contextWindow"], 1_000_000); // opus-4-8 → 1M
        assert_eq!(got["percent"], 5.0);

        // Unknown id → not found, zeroed, never errors.
        let missing = read_session_context(&root, &no_codex, "nope", None);
        assert_eq!(missing["found"], false);
        assert_eq!(missing["percent"], 0.0);

        // cwd fallback: no run_id, but the cwd slugs to the project dir. The
        // temp project dir is "-tmp-project" → cwd "/tmp/project".
        let by_cwd = read_session_context(&root, &no_codex, "", Some("/tmp/project"));
        assert_eq!(by_cwd["found"], true);
        assert_eq!(by_cwd["tokens"], 50_000);

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn cwd_fallback_stays_blank_when_newest_transcript_has_no_usage() {
        // A brand-new session: Claude writes a meta-only transcript (no usage)
        // at start, and it's the NEWEST file in the folder. Even with an older
        // full transcript present, the cwd lookup must read the newest (empty)
        // one and report nothing — so the ring stays blank until the first turn.
        let unique = format!(
            "spike-ctx-fresh-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let root = std::env::temp_dir().join(unique);
        let proj = root.join("-tmp-project");
        std::fs::create_dir_all(&proj).unwrap();

        // older, full transcript
        let full = json!({"message":{"model":"claude-opus-4-8","usage":{"input_tokens":50_000,"output_tokens":9,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}).to_string();
        std::fs::write(proj.join("old-full.jsonl"), full).unwrap();
        // newer, meta-only transcript (a just-started session) — must win as newest
        std::thread::sleep(std::time::Duration::from_millis(20));
        let meta = json!({"type":"system","message":{"role":"system"}}).to_string();
        std::fs::write(proj.join("new-fresh.jsonl"), meta).unwrap();

        let no_codex: Vec<std::path::PathBuf> = vec![];
        let got = read_session_context(&root, &no_codex, "", Some("/tmp/project"));
        assert_eq!(got["found"], false, "newest transcript has no usage → blank");

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_known_id_never_falls_back_to_the_cwd_guess() {
        // The bug this closes: a lane whose transcript has no usage yet (brand
        // new, or persistence was off) borrowed the ring of whatever transcript
        // happened to be newest in the same project folder — a session it has no
        // relationship to. A run_id is an identity claim, so a miss on it must
        // read blank, not go guessing by cwd.
        let unique = format!(
            "spike-ctx-owned-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let root = std::env::temp_dir().join(unique);
        let proj = root.join("-tmp-project");
        std::fs::create_dir_all(&proj).unwrap();

        // A full transcript from some earlier, unrelated session in this folder.
        let full = json!({"message":{"model":"claude-opus-5","usage":{"input_tokens":400_000,"output_tokens":9,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}).to_string();
        std::fs::write(proj.join("someone-elses-run.jsonl"), full).unwrap();

        let no_codex: Vec<std::path::PathBuf> = vec![];

        // Our lane owns an id whose transcript doesn't exist yet. Same cwd, so
        // the old code would have found the neighbour above and painted 40%.
        let owned = read_session_context(&root, &no_codex, "our-own-id", Some("/tmp/project"));
        assert_eq!(owned["found"], false, "own id + no transcript → blank, not the neighbour's 40%");
        assert_eq!(owned["tokens"], 0);

        // With no id at all (Codex pre-first-event, or a session Spike didn't
        // start) the cwd guess is still the best available answer.
        let guessed = read_session_context(&root, &no_codex, "", Some("/tmp/project"));
        assert_eq!(guessed["found"], true, "no id → cwd fallback still applies");
        assert_eq!(guessed["tokens"], 400_000);

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn session_context_reads_codex_rollout_by_uuid() {
        let unique = format!(
            "spike-ctx-codex-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let root = std::env::temp_dir().join(unique);
        // Codex nests rollouts by date; the search is recursive.
        let day = root.join("2026").join("07").join("19");
        std::fs::create_dir_all(&day).unwrap();

        let uuid = "019f7cdc-b033-7bd3-9689-815f5ef1722c";
        let lines = [
            json!({"type":"session_meta","payload":{"id":uuid,"cwd":"/tmp/project"}}),
            json!({"type":"turn_context","payload":{"model":"gpt-5.6-terra"}}),
            json!({"type":"event_msg","payload":{"type":"token_count","info":{
                "last_token_usage":{"input_tokens":5000,"output_tokens":100,"total_tokens":5100},
                "model_context_window":258400}}}),
            // latest reading wins:
            json!({"type":"event_msg","payload":{"type":"token_count","info":{
                "last_token_usage":{"input_tokens":64_500,"output_tokens":100,"total_tokens":64_600},
                "model_context_window":258400}}}),
        ]
        .iter()
        .map(|v| v.to_string())
        .collect::<Vec<_>>()
        .join("\n");
        std::fs::write(day.join(format!("rollout-2026-07-19T17-11-05-{uuid}.jsonl")), lines).unwrap();

        let claude_root = root.join("no-claude-here");
        let got = read_session_context(&claude_root, &[root.clone()], uuid, None);
        assert_eq!(got["found"], true);
        assert_eq!(got["tokens"], 64_600); // last event's total_tokens
        assert_eq!(got["contextWindow"], 258_400);
        assert_eq!(got["model"], "gpt-5.6-terra");
        // 64_600 / 258_400 = 25%
        assert_eq!(got["percent"], 25.0);

        // cwd fallback finds the same rollout by its session_meta cwd.
        let by_cwd = read_session_context(&claude_root, &[root.clone()], "", Some("/tmp/project"));
        assert_eq!(by_cwd["found"], true);
        assert_eq!(by_cwd["tokens"], 64_600);

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn iso_day_handles_normal_short_and_malformed() {
        // normal ISO-8601 → the date prefix
        assert_eq!(iso_day(Some("2026-06-01T12:34:56Z")), "2026-06-01");
        // absent / too short → "unknown" (never indexes out of range)
        assert_eq!(iso_day(None), "unknown");
        assert_eq!(iso_day(Some("2026")), "unknown");
        // the regression: a 10th byte mid-UTF-8 used to panic `&s[..10]`. "é" is
        // two bytes (0xC3 0xA9), so here byte index 10 splits it — get(..10)
        // returns None → "unknown", no panic.
        assert_eq!(iso_day(Some("123456789é-rest")), "unknown");
        // multibyte chars fully before byte 10 are fine: 5×2-byte "é" = bytes
        // 0..10 exactly, a clean boundary → the five é's, no panic.
        assert_eq!(iso_day(Some("ééééé67890Z")), "ééééé");
    }

    #[test]
    fn codex_scan_deltas_cumulative_snapshots_and_dedupes_sessions() {
        let unique = format!(
            "spike-codex-usage-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let base = std::env::temp_dir().join(unique);
        let root_a = base.join("a");
        let root_b = base.join("b");
        std::fs::create_dir_all(&root_a).unwrap();
        std::fs::create_dir_all(&root_b).unwrap();

        let records = [
            json!({"type":"session_meta","payload":{"id":"same-session","cwd":"/tmp/project"}}),
            json!({"type":"turn_context","payload":{"model":"gpt-5.6-sol"}}),
            json!({"timestamp":"2026-07-18T12:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":10,"reasoning_output_tokens":2}}}}),
            // Repeated snapshots are common UI updates and must add nothing.
            json!({"timestamp":"2026-07-18T12:00:01Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":10,"reasoning_output_tokens":2}}}}),
            json!({"timestamp":"2026-07-19T12:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":160,"cached_input_tokens":30,"output_tokens":20,"reasoning_output_tokens":4}}}}),
        ];
        let text = records.iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n");
        std::fs::write(root_a.join("rollout.jsonl"), &text).unwrap();
        // Same session copied under another CODEX_HOME: count once.
        std::fs::write(root_b.join("rollout-copy.jsonl"), &text).unwrap();

        let report = scan_codex_roots(&[root_a, root_b]);
        let totals = &report["totals"];
        assert_eq!(totals["input"], 160);
        assert_eq!(totals["cachedInput"], 30);
        assert_eq!(totals["output"], 20);
        assert_eq!(totals["reasoningOutput"], 4);
        assert_eq!(totals["requests"], 2);
        assert_eq!(totals["sessions"], 1);
        assert_eq!(totals["scannedFiles"], 2);
        assert_eq!(report["byDay"].as_array().unwrap().len(), 2);
        assert_eq!(report["byProject"][0]["project"], "/tmp/project");
        assert!(report["unpricedModels"].as_array().unwrap().is_empty());

        std::fs::remove_dir_all(base).unwrap();
    }
}
