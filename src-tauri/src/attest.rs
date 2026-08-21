// attest.rs - the headless agent turn, and the source reads that feed it.
//
// This is NOT a lane. pty.rs spawns an interactive TUI a person types into; this spawns
// `claude -p` for one bounded, gated turn and collects a JSON result. They share nothing
// but the binary, and deliberately so: a lane is a conversation, an attest run is a
// verification job with a receipt.
//
// Two capabilities live here because both need the OS and neither belongs in the webview:
//
//   attest_read_sources - read a folder of text sources with a content hash each, so a
//                         citation can later be told it points at changed bytes.
//   attest_turn         - run one headless turn on the user's own subscription.
//
// Everything else (segmenting, substitution, gating, rendering) is pure TypeScript in
// src/attest/ and runs in the webview. That split is on purpose: the guarantee lives in
// code that can be unit-tested without a model, a subprocess, or a Tauri runtime.
//
// Billing. The turn runs WITHOUT --bare, which is the only mode that uses the OAuth
// subscription login; --bare requires an ANTHROPIC_API_KEY. So a run inherits whatever the
// person has configured locally and is not byte-reproducible across machines. The gate is
// mechanical, so local config cannot fake a pass.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::state::AppState;

/// Text formats only. PDF and other binary formats read as mojibake through
/// `read_to_string`, and a verbatim guarantee over bytes nobody can reproduce is not a
/// guarantee - so they are refused rather than silently mangled.
const TEXT_EXT: &[&str] = &["md", "markdown", "txt", "csv", "json", "log", "rst"];
const SKIP_DIR: &[&str] = &["node_modules", ".git", "dist", "dist-web", "target", ".spike"];

/// Per-source and per-run ceilings. A source larger than this is refused rather than
/// truncated: a truncated source would silently make spans unquotable with no signal.
const MAX_SOURCE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_SOURCES: usize = 2_000;

#[derive(Serialize)]
pub struct AttestSource {
    /// stable, followable id: `folder:<path relative to the root>`
    pub id: String,
    pub label: String,
    /// verbatim file contents - spans are cut from this and nothing else
    pub detail: String,
    /// sha256 of `detail`, so a later run can tell the source changed
    pub hash: String,
    pub url: String,
    pub complete: bool,
}

fn sha256_hex(bytes: &[u8]) -> String {
    // Tiny local sha256 so this module adds no dependency. The hash is a change detector,
    // not a security primitive: it answers "are these the same bytes I read", and a
    // collision would at worst hide a drift warning.
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut msg = bytes.to_vec();
    let bit_len = (bytes.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in msg.chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([chunk[i * 4], chunk[i * 4 + 1], chunk[i * 4 + 2], chunk[i * 4 + 3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g; g = f; f = e;
            e = d.wrapping_add(t1);
            d = c; c = b; b = a;
            a = t1.wrapping_add(t2);
        }
        for (i, v) in [a, b, c, d, e, f, g, hh].iter().enumerate() {
            h[i] = h[i].wrapping_add(*v);
        }
    }
    h.iter().map(|x| format!("{x:08x}")).collect()
}

fn is_text(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| TEXT_EXT.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    if out.len() >= MAX_SOURCES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut items: Vec<_> = entries.filter_map(|e| e.ok()).collect();
    // Sorted so span ids are stable across runs - a citation that changes meaning because
    // the filesystem returned a different order would be worse than no citation.
    items.sort_by_key(|e| e.file_name());
    for entry in items {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            if !SKIP_DIR.contains(&name.as_str()) {
                walk(&path, out);
            }
        } else if is_text(&path) {
            out.push(path);
        }
    }
}

/// Glob match for a check set's `include` pattern, against the relative path and the bare
/// filename. Only `*` is meaningful; everything else is literal.
fn matches(rel: &str, include: &[String]) -> bool {
    if include.is_empty() {
        return true;
    }
    let name = rel.rsplit('/').next().unwrap_or(rel);
    include.iter().any(|pat| {
        let parts: Vec<&str> = pat.split('*').collect();
        let test = |hay: &str| {
            if parts.len() == 1 {
                return hay == pat;
            }
            let mut pos = 0usize;
            if !hay.starts_with(parts[0]) {
                return false;
            }
            pos += parts[0].len();
            for (i, part) in parts.iter().enumerate().skip(1) {
                if i == parts.len() - 1 {
                    return hay.len() >= pos && hay[pos..].ends_with(part);
                }
                match hay[pos..].find(part) {
                    Some(at) => pos += at + part.len(),
                    None => return false,
                }
            }
            true
        };
        test(rel) || test(name)
    })
}

/// `invoke('attest_read_sources', { root, include })` - read a folder of text sources.
///
/// `include` is the check set's filter for this source. Dropping it is not cosmetic: a
/// check set that scopes a run to one client's notes would otherwise read, segment and
/// quote every other client's file, and the receipt would print a green VERBATIM over it.
///
/// Refuses a non-text single file rather than reading it as UTF-8: `read_to_string`
/// replaces every invalid sequence with U+FFFD, so the harness would segment mojibake and
/// then report VERBATIM over text that is not in the document.
#[tauri::command]
pub fn attest_read_sources(
    root: String,
    include: Option<Vec<String>>,
) -> Result<Vec<AttestSource>, String> {
    let include = include.unwrap_or_default();
    let abs = std::fs::canonicalize(&root).map_err(|_| format!("sources not found: {root}"))?;
    let meta = std::fs::metadata(&abs).map_err(|e| e.to_string())?;

    let (base, files) = if meta.is_dir() {
        let mut files = Vec::new();
        walk(&abs, &mut files);
        (abs.clone(), files)
    } else if is_text(&abs) {
        let parent = abs.parent().unwrap_or(&abs).to_path_buf();
        (parent, vec![abs.clone()])
    } else {
        return Err(format!(
            "{} is not a supported text format ({}). Binary formats read as mojibake, so a \
             verbatim guarantee over them would be a lie.",
            abs.display(),
            TEXT_EXT.join(" ")
        ));
    };

    let mut out = Vec::with_capacity(files.len());
    for path in files {
        let rel_pre = path.strip_prefix(&base).unwrap_or(&path).to_string_lossy().into_owned();
        if !matches(&rel_pre, &include) {
            continue;
        }
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        if size > MAX_SOURCE_BYTES {
            return Err(format!(
                "{} is {size} bytes, over the {MAX_SOURCE_BYTES}-byte cap. Truncating it would \
                 silently make part of the source unquotable, so the run is refused instead.",
                path.display()
            ));
        }
        let detail = std::fs::read_to_string(&path)
            .map_err(|e| format!("{}: {e}", path.display()))?;
        let rel = path
            .strip_prefix(&base)
            .unwrap_or(&path)
            .to_string_lossy()
            .into_owned();
        if !matches(&rel, &include) {
            continue;
        }
        out.push(AttestSource {
            id: format!("folder:{rel}"),
            label: rel,
            hash: sha256_hex(detail.as_bytes()),
            url: format!("file://{}", path.display()),
            detail,
            complete: true,
        });
    }
    Ok(out)
}

// ── the headless turn ───────────────────────────────────────────────────────

/// Closing the tool surface is defense in depth, not the guarantee - the gate rejects
/// typed quote marks regardless of what tools exist. It is worth doing anyway: it drops
/// ~29k tokens of MCP schemas from the prompt, measured as $0.147 -> $0.022 on a trivial
/// run. This is a DENYLIST, so a newly added built-in tool arrives allowed; survivable
/// precisely because the gate does not depend on it.
const TOOL_DENYLIST: &str = "Bash,Read,Write,Edit,NotebookEdit,Glob,Grep,WebSearch,WebFetch,\
                             Task,TodoWrite,Skill,SlashCommand";

#[derive(Deserialize)]
pub struct AttestTurn {
    pub run_id: String,
    pub prompt: String,
    /// JSON Schema for the answer, serialized.
    pub schema: String,
    pub model: String,
    /// Which local agent runs the turn. Defaults to claude.
    #[serde(default)]
    pub engine: Option<String>,
    /// Spike lane that started this run, when one did. Carried onto broker events.
    pub session_id: Option<String>,
}

/// The webview supplies the model name, so it is validated as a charset rather than
/// trusted. Args are passed as a vector (never a shell string), so this is belt and
/// braces rather than the only defence.
fn valid_model(m: &str) -> bool {
    !m.is_empty()
        && m.len() <= 64
        && m.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '[' | ']'))
}

/// Resolve an agent binary, skipping any Spike shim on PATH. The shim rewrites
/// ~/.claude/settings.json (or seeds a per-tab CODEX_HOME) on every launch, which is
/// correct for a lane and wrong for a background verification run.
fn resolve_agent(binary: &str) -> Result<PathBuf, String> {
    let path_var = std::env::var("PATH").unwrap_or_default();
    for dir in path_var.split(':') {
        if dir.is_empty() || dir.ends_with("/shims") || dir.contains("/shims/") {
            continue;
        }
        let candidate = PathBuf::from(dir).join(binary);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    let home = dirs::home_dir().unwrap_or_default();
    for p in [
        home.join(".local/bin").join(binary),
        PathBuf::from("/opt/homebrew/bin").join(binary),
        PathBuf::from("/usr/local/bin").join(binary),
    ] {
        if p.is_file() {
            return Ok(p);
        }
    }
    Err(format!("{binary} binary not found on PATH"))
}

/// One turn through `codex exec`, normalized into the same shape `claude -p --output-format
/// json` returns, so the orchestrator does not branch on engine.
///
/// Three things differ from Claude Code and each is load-bearing:
///
///  - **codex reads stdin and blocks until it closes.** Leaving it inherited hangs the run
///    forever; measured, not guessed. stdin is explicitly null.
///  - **--output-schema takes a PATH, not inline JSON**, and the structured answer is
///    written to the `-o` file rather than embedded in a result object.
///  - **No USD cost is reported, only tokens.** The cost stays null rather than being
///    derived from a price table this module would have to keep current - a made-up number
///    in a receipt is worse than an absent one.
fn codex_turn(bin: &Path, turn: &AttestTurn) -> Result<Value, String> {
    let dir = std::env::temp_dir();
    let stamp = turn.run_id.replace(|c: char| !c.is_ascii_alphanumeric(), "");
    let schema_path = dir.join(format!("attest-{stamp}-schema.json"));
    let out_path = dir.join(format!("attest-{stamp}-answer.json"));
    std::fs::write(&schema_path, &turn.schema).map_err(|e| format!("could not stage schema: {e}"))?;

    let mut cmd = Command::new(bin);
    cmd.args([
        "exec",
        "--json",
        "--output-schema",
        &schema_path.to_string_lossy(),
        "-o",
        &out_path.to_string_lossy(),
        // An attest turn reads sources and answers. It has no business writing anything.
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        &turn.prompt,
    ]);
    cmd.stdin(std::process::Stdio::null());
    cmd.env_remove("OPENAI_API_KEY");
    cmd.env_remove("CODEX_API_KEY");

    let out = cmd.output().map_err(|e| format!("could not run {}: {e}", bin.display()))?;
    let events = String::from_utf8_lossy(&out.stdout).into_owned();
    let _ = std::fs::remove_file(&schema_path);

    let answer = std::fs::read_to_string(&out_path).ok();
    let _ = std::fs::remove_file(&out_path);

    // codex logs unrelated cache warnings to stderr on a healthy run, so stderr is NOT a
    // failure signal. The absence of a parseable answer is.
    let structured: Option<Value> = answer.as_deref().and_then(|a| serde_json::from_str(a).ok());

    let mut usage = Value::Null;
    for line in events.lines() {
        if let Ok(ev) = serde_json::from_str::<Value>(line) {
            if ev.get("type").and_then(Value::as_str) == Some("turn.completed") {
                usage = ev.get("usage").cloned().unwrap_or(Value::Null);
            }
        }
    }

    match structured {
        Some(s) => Ok(json!({
            "structured_output": s,
            // Codex reports tokens, never dollars. Left null rather than invented.
            "total_cost_usd": Value::Null,
            "usage": usage,
            "apiKeySource": "none",
        })),
        None => Ok(json!({
            "is_error": true,
            "terminal_reason": "no_structured_answer",
            "result": events.lines().rev().take(3).collect::<Vec<_>>().join(" | "),
            "usage": usage,
        })),
    }
}

fn resolve_claude() -> Result<PathBuf, String> {
    // Skip any Spike shim on PATH: the shim rewrites ~/.claude/settings.json on every
    // launch, which is correct for a lane and wrong for a background verification run.
    let path_var = std::env::var("PATH").unwrap_or_default();
    for dir in path_var.split(':') {
        if dir.is_empty() || dir.ends_with("/shims") || dir.contains("/shims/") {
            continue;
        }
        let candidate = PathBuf::from(dir).join("claude");
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    for fallback in [".local/bin/claude"] {
        let p = dirs::home_dir().unwrap_or_default().join(fallback);
        if p.is_file() {
            return Ok(p);
        }
    }
    for p in ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"] {
        if Path::new(p).is_file() {
            return Ok(PathBuf::from(p));
        }
    }
    Err("claude binary not found on PATH".into())
}

/// `invoke('attest_turn', { turn })` - one headless, gated turn.
///
/// Returns Claude Code's `--output-format json` result verbatim, so the frontend gates
/// exactly what the model produced. Broker events bracket the run (`attest.started` /
/// `attest.turn`) so the action log records that a verification ran and what it cost,
/// which is the point of having a log at all.
#[tauri::command]
pub fn attest_turn(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    turn: AttestTurn,
) -> Result<Value, String> {
    if !valid_model(&turn.model) {
        return Err(format!("invalid model name: {}", turn.model));
    }
    serde_json::from_str::<Value>(&turn.schema).map_err(|e| format!("invalid answer schema: {e}"))?;

    let engine = turn.engine.as_deref().unwrap_or("claude");
    if engine != "claude" && engine != "codex" {
        return Err(format!("unknown engine: {engine}"));
    }
    let bin = if engine == "codex" { resolve_agent("codex")? } else { resolve_claude()? };
    state.agent_broker.append(
        &app,
        turn.run_id.clone(),
        turn.session_id.clone(),
        "attest.started".into(),
        json!({ "model": turn.model, "engine": engine }),
    );

    if engine == "codex" {
        let parsed = codex_turn(&bin, &turn)?;
        state.agent_broker.append(
            &app,
            turn.run_id.clone(),
            turn.session_id.clone(),
            "attest.turn".into(),
            json!({
                "engine": "codex",
                "ok": !parsed.get("is_error").and_then(Value::as_bool).unwrap_or(false),
                "usage": parsed.get("usage"),
            }),
        );
        return Ok(parsed);
    }

    let mut cmd = Command::new(&bin);
    cmd.args([
        "-p", &turn.prompt,
        "--model", &turn.model,
        "--output-format", "json",
        "--json-schema", &turn.schema,
        "--mcp-config", "{\"mcpServers\":{}}",
        "--strict-mcp-config",
        "--disallowedTools", TOOL_DENYLIST,
        "--permission-mode", "dontAsk",
    ]);
    // Strip the API key so the run bills to the OAuth subscription. The caller reads
    // `apiKeySource` back off the result rather than assuming it did.
    cmd.env_remove("ANTHROPIC_API_KEY");

    let out = cmd.output().map_err(|e| format!("could not run {}: {e}", bin.display()))?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let parsed: Value = serde_json::from_str(&stdout).map_err(|_| {
        let stderr = String::from_utf8_lossy(&out.stderr);
        format!(
            "claude returned unparseable output.\nstdout: {}\nstderr: {}",
            stdout.chars().take(600).collect::<String>(),
            stderr.chars().take(600).collect::<String>()
        )
    })?;

    state.agent_broker.append(
        &app,
        turn.run_id.clone(),
        turn.session_id.clone(),
        "attest.turn".into(),
        json!({
            "ok": !parsed.get("is_error").and_then(Value::as_bool).unwrap_or(false),
            "cost_usd": parsed.get("total_cost_usd").and_then(Value::as_f64),
            "auth": parsed.get("apiKeySource").and_then(Value::as_str),
        }),
    );
    Ok(parsed)
}

/// `invoke('attest_verdict', { .. })` - record a finished run's verdict on the broker.
///
/// Kept separate from `attest_turn` because a run is one or more turns plus a gate, and
/// the gate is TypeScript. Without this the log would show that a verification ran but
/// never whether it passed, which is the half that matters.
#[tauri::command]
pub fn attest_verdict(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    run_id: String,
    session_id: Option<String>,
    verdict: Value,
) -> Result<u64, String> {
    Ok(state
        .agent_broker
        .append(&app, run_id, session_id, "attest.verdict".into(), verdict))
}

// ── playbooks: a coding turn, and a check runner ─────────────────────────────────
//
// A playbook (src/attest/playbook.ts) does the steps, then PROVES it by running the user's
// own checks and gating on the result. Two capabilities need the OS and so live here, next
// to attest_turn because they share the same binary resolution and billing story:
//
//   playbook_turn      - one headless CODING turn. Unlike an attest turn (reads sources,
//                        types no quotes, ALL tools denied), this must edit files and run
//                        commands, so the tool surface is OPEN and the cwd is the repo.
//                        The gate is still the checks, never the agent's self-report.
//   playbook_run_check - run one check command in the repo and return its exit + output.
//                        Deterministic; a runner's exit code is what gates.
//
// Trust boundary: playbook_run_check shells out. For slice 1 the playbook is a LOCAL file
// the user points Spike at - the same trust as the commands in their own shell config. An
// imported or marketplace playbook must be reviewed and its commands surfaced BEFORE this
// runs; that gate belongs to the authoring/import slice, not here. Do not wire an untrusted
// source straight into this command.

#[derive(Deserialize)]
pub struct PlaybookTurn {
    pub run_id: String,
    pub prompt: String,
    /// The repo the coding turn edits. Validated to be a real directory before use.
    pub cwd: String,
    /// Which local agent runs the turn. Defaults to claude. (codex needs a writable sandbox
    /// flag, added when a codex coding turn is actually wired; slice 1 is claude.)
    #[serde(default)]
    pub engine: Option<String>,
    pub session_id: Option<String>,
}

/// `invoke('playbook_turn', { turn })` - one headless coding turn on the user's own
/// subscription. Returns Claude Code's `--output-format json` result verbatim; the webview
/// reads `.result` off it as the turn summary. The checks - run separately - are the gate.
#[tauri::command]
pub fn playbook_turn(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    turn: PlaybookTurn,
) -> Result<Value, String> {
    let engine = turn.engine.as_deref().unwrap_or("claude");
    if engine != "claude" {
        return Err(format!("playbook coding turn supports claude only for now, got: {engine}"));
    }
    let cwd = PathBuf::from(&turn.cwd);
    if !cwd.is_dir() {
        return Err(format!("cwd is not a directory: {}", turn.cwd));
    }
    let bin = resolve_claude()?;

    state.agent_broker.append(
        &app,
        turn.run_id.clone(),
        turn.session_id.clone(),
        "playbook.started".into(),
        json!({ "engine": engine, "cwd": turn.cwd }),
    );

    let mut cmd = Command::new(&bin);
    cmd.args([
        "-p", &turn.prompt,
        "--output-format", "json",
        // A coding turn edits and runs; accept its edits without prompting in this headless
        // run. The checks - not this flag - decide whether the work was real.
        "--permission-mode", "acceptEdits",
    ]);
    cmd.current_dir(&cwd);
    // Bill the OAuth subscription, not a metered key (same as attest_turn).
    cmd.env_remove("ANTHROPIC_API_KEY");

    let out = cmd.output().map_err(|e| format!("could not run {}: {e}", bin.display()))?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    // A coding turn's stdout is Claude Code's JSON envelope. If it is unparseable the turn
    // still ran; return an error object rather than throwing, so the loop can surface it.
    let parsed: Value = serde_json::from_str(&stdout).unwrap_or_else(|_| {
        json!({
            "is_error": true,
            "terminal_reason": "unparseable_output",
            "result": stdout.chars().take(600).collect::<String>(),
        })
    });

    state.agent_broker.append(
        &app,
        turn.run_id.clone(),
        turn.session_id.clone(),
        "playbook.turn".into(),
        json!({
            "ok": !parsed.get("is_error").and_then(Value::as_bool).unwrap_or(false),
            "cost_usd": parsed.get("total_cost_usd").and_then(Value::as_f64),
            "auth": parsed.get("apiKeySource").and_then(Value::as_str),
        }),
    );
    Ok(parsed)
}

#[derive(Deserialize)]
pub struct PlaybookCheck {
    pub cmd: String,
    pub cwd: String,
}

/// `invoke('playbook_run_check', { check })` - run one check command in the repo, return
/// its exit code and captured output. A failing command is a non-zero `code`, NOT an Err:
/// the gate (TypeScript) decides pass/fail. An Err here means the command could not be run
/// at all (no shell), which aborts the run rather than passing it - a check that could not
/// run is never green.
#[tauri::command]
pub fn playbook_run_check(check: PlaybookCheck) -> Result<Value, String> {
    let cwd = PathBuf::from(&check.cwd);
    if !cwd.is_dir() {
        return Err(format!("cwd is not a directory: {}", check.cwd));
    }
    // Through the shell so a check like `npm test` or `node verify/run.mjs x` behaves
    // exactly as typed by hand. See the trust-boundary note above the playbook section.
    let out = Command::new("sh")
        .arg("-c")
        .arg(&check.cmd)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("could not run check `{}`: {e}", check.cmd))?;
    Ok(json!({
        "code": out.status.code().unwrap_or(1),
        "stdout": String::from_utf8_lossy(&out.stdout),
        "stderr": String::from_utf8_lossy(&out.stderr),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_known_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        // Crosses the 56-byte padding boundary, where a hand-rolled implementation breaks.
        assert_eq!(
            sha256_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
    }

    #[test]
    fn include_filters_by_relative_path_and_by_name() {
        let pats = vec!["acme-*.md".to_string()];
        assert!(matches("acme-q3.md", &pats));
        assert!(matches("notes/acme-q3.md", &pats), "should match the bare filename too");
        assert!(!matches("bravo-q3.md", &pats));
        // An empty filter means everything, which is what a check set with no include says.
        assert!(matches("anything.md", &[]));
        // A literal pattern with no star matches only itself.
        assert!(matches("only.md", &["only.md".to_string()]));
        assert!(!matches("other.md", &["only.md".to_string()]));
    }

    #[test]
    fn only_text_extensions_are_readable() {
        assert!(is_text(Path::new("notes.md")));
        assert!(is_text(Path::new("NOTES.MD")));
        assert!(!is_text(Path::new("deck.pdf")));
        assert!(!is_text(Path::new("icon.png")));
        assert!(!is_text(Path::new("noext")));
    }

    #[test]
    fn model_names_are_validated_not_trusted() {
        assert!(valid_model("haiku"));
        assert!(valid_model("claude-opus-5[1m]"));
        assert!(!valid_model(""));
        assert!(!valid_model("haiku; rm -rf /"));
        assert!(!valid_model("haiku $(whoami)"));
        assert!(!valid_model(&"x".repeat(65)));
    }
}
