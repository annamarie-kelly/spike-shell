// cli_listener.rs — the localhost HTTP listener that keeps `bin/spike` working
// unmodified, plus the `set_focus` command the page reports focus through.
//
// OWNER: cli-listener agent.
//
// Why this exists: `spike open` / `spike context` run inside the embedded
// terminal — a separate process — and reach Spike over HTTP on
// 127.0.0.1:7878 (bin/spike line 11: SPIKE_PORT env, default 7878; pty.rs
// passes SPIKE_PORT into every spawn). Tauri has no HTTP server, so we keep a
// tiny_http listener in-process for exactly these routes. Their old SSE
// broadcast to the page becomes a Tauri event emit.
//
// ── Routes (port of server.ts; bin/spike is the only client) ────────────────
//
// POST /open  {"path": "/abs/file-or-folder"}            (server.ts 554–563)
//   `spike open <path>` lands here (bin/spike 34–43; it pre-resolves to an
//   absolute path). Folder → emit `open` event {kind:"project", path} (the
//   page re-roots); file → emit `open` event {kind:"open", path} (the page
//   previews it). An http(s):// target → emit {kind:"url", path} (the page
//   docks it live in the preview); URLs skip the absolute-path / exists checks.
//   Log spike_open {path, kind:"project"|"file"|"url"}.
//   Responses (Content-Type: application/json):
//     200 {"ok":true,"kind":"project"} | 200 {"ok":true,"kind":"open"}
//       | 200 {"ok":true,"kind":"url"}
//     400 {"error":"absolute path required"}
//     404 {"error":"no such file or folder"}
//   (bin/spike prints the parsed `error` field on non-200 — keep the strings.)
//
// GET /context                                            (server.ts 583–593)
//   `spike context` lands here (bin/spike 44–95). Respond 200 with the
//   last-reported focus JSON (state.focus) PLUS pinnedPaths folded in:
//     { projectPath, openFile, browser, selection, dirty, recent, tabs,
//       activeGroup, pinnedPaths: [..] }
//   where pinnedPaths = the active group's pinnedPaths from
//   ~/.spike/groups/<slug>.json (empty array when no activeGroup / no group
//   file / no pins). Before any focus report, serve the empty-focus shape:
//   { projectPath:null, openFile:null, browser:null, selection:[], dirty:false,
//     recent:[], tabs:[], activeGroup:null, pinnedPaths:[] }.
//
// POST /focus {focus body — see set_focus below}          (server.ts 564–582)
//   Same handling as the set_focus command, over HTTP. bin/spike never POSTs
//   this today, but the route is kept per the scope doc (TAURI-SCOPE.md) so
//   any external focus reporter keeps working. Responds 200 {"ok":true}.
//
// POST /agent-event {"run_id": str, "kind": str, "session_id"?: str, "data"?: obj}
//   The engine-neutral intake for the agent_broker. Adapters (Claude hook,
//   future Codex sidecar) POST one event here; broker assigns seq + ts and
//   fans out via Tauri event "agent:event" plus a jsonl mirror. See
//   agent_broker.rs and `02-Thinking/Spike event broker — build plan.md`.
//   Responses:
//     200 {"ok":true,"seq":N}
//     400 {"error":"run_id required"} | {"error":"kind required"} | {"error":"bad json"}
//   (data defaults to {}, session_id optional. Schema kept permissive in v1
//   per the plan's lock-in mitigation — broker doesn't enforce kind values.)
//
// Anything else → 404 "not found". Bind 127.0.0.1 only (never 0.0.0.0).
// Run the accept loop on its own thread; it must not block setup. If the port
// is taken (e.g. Node Spike still running — the dogfooding overlap), log and
// continue without the listener rather than crashing the app.

use std::io::{Cursor, Read};
use std::path::Path;
use std::sync::OnceLock;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tiny_http::{Header, Method, Request, Response};

use crate::state::AppState;

/// The default bridge port. A launch prefers `SPIKE_PORT` (env) if set, else
/// this, then auto-roams upward to the first free port — so a second instance
/// (e.g. a dev build beside the daily app) still gets a working bridge instead
/// of silently disabling it.
const DEFAULT_CLI_PORT: u16 = 7878;
/// How many ports to try from the preferred one before giving up.
const PORT_SCAN: u16 = 16;

/// The port this instance actually bound. Set once in `start()` before any
/// terminal can spawn; pty.rs injects it as SPIKE_PORT so `spike` from a
/// terminal reaches the instance that spawned it (not some other one), and the
/// request guard checks the Host header against it. Falls back to the default
/// if read before bind (shouldn't happen — start() runs in setup).
static BOUND_PORT: OnceLock<u16> = OnceLock::new();
pub fn cli_port() -> u16 {
    BOUND_PORT.get().copied().unwrap_or(DEFAULT_CLI_PORT)
}

/// Per-launch shared secret for the CLI bridge. Binding to 127.0.0.1 keeps
/// remote hosts out, but ANY local process — and any web page the user visits,
/// via a cross-origin request to 127.0.0.1:7878 — can otherwise drive Spike
/// (open arbitrary files into the privileged preview, inject agent events).
/// The fix: only processes Spike itself spawned can talk to the bridge. We mint
/// a random token at launch and inject it into every terminal's env as
/// SPIKE_TOKEN (pty.rs); bin/spike echoes it back in the X-Spike-Token header.
/// A drive-by page or unrelated process has no way to learn it.
static TOKEN: OnceLock<String> = OnceLock::new();

/// The bridge token, minted on first access. Read by pty.rs (to inject into
/// spawned terminals) and by the request guard below. Stable for the process'
/// lifetime; generated lazily so call order doesn't matter.
pub fn token() -> &'static str {
    TOKEN.get_or_init(|| {
        // 32 bytes of OS entropy, URL-safe base64. /dev/urandom is present on
        // macOS and Linux (Spike's targets); the time/pid fallback only runs
        // if that read somehow fails and is better than a constant.
        use base64::Engine as _;
        let mut buf = [0u8; 32];
        let ok = std::fs::File::open("/dev/urandom")
            .and_then(|mut f| f.read_exact(&mut buf).map(|_| ()))
            .is_ok();
        if !ok {
            let pid = std::process::id() as u64;
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(0);
            buf[..8].copy_from_slice(&pid.to_le_bytes());
            buf[8..16].copy_from_slice(&nanos.to_le_bytes());
        }
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
    })
}

/// Constant-time byte comparison so a token guess can't be timed out byte by
/// byte. (Length is allowed to leak — the token is a fixed width.)
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Gate every request on the bridge. Rejects unless:
///   * it carries no `Origin` header — the trusted client (bin/spike) never
///     sets one; a browser always attaches Origin on a cross-origin request,
///     so this alone blocks drive-by CSRF and DNS-rebind attempts; and
///   * its `Host` is loopback — a rebinding page would send its own hostname;
///     and
///   * `X-Spike-Token` matches this launch's secret (constant-time).
fn authorized(req: &Request) -> bool {
    let mut token_ok = false;
    for h in req.headers() {
        let name = h.field.as_str().as_str();
        if name.eq_ignore_ascii_case("origin") {
            return false; // bin/spike sends none; browsers always do → reject
        }
        if name.eq_ignore_ascii_case("host") {
            let host = h.value.as_str();
            let port = cli_port();
            let ok = host == format!("127.0.0.1:{port}")
                || host == format!("localhost:{port}")
                || host == "127.0.0.1"
                || host == "localhost";
            if !ok {
                return false; // DNS-rebinding / Host spoofing
            }
        }
        if name.eq_ignore_ascii_case("x-spike-token") {
            token_ok = ct_eq(h.value.as_str().as_bytes(), token().as_bytes());
        }
    }
    token_ok
}

/// server.ts readJson cap (266–268) — way past any focus body; keeps a stray
/// client from ballooning memory.
const BODY_CAP: u64 = 20_000_000;

/// Start the listener thread. Called once from lib.rs's .setup().
pub fn start(app: AppHandle) {
    // Mint the bridge token now, before any terminal can spawn, so pty.rs and
    // the request guard see the same value.
    let _ = token();
    // Resolve + bind the port SYNCHRONOUSLY (before this returns and any terminal
    // spawns) so pty.rs injects the real bound port. Prefer SPIKE_PORT (env) or
    // the default, then roam upward to the first free port.
    let preferred = std::env::var("SPIKE_PORT")
        .ok()
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(DEFAULT_CLI_PORT);
    let mut bound = None;
    for p in preferred..preferred.saturating_add(PORT_SCAN) {
        if let Ok(s) = tiny_http::Server::http(("127.0.0.1", p)) {
            bound = Some((s, p));
            break;
        }
    }
    let (server, port) = match bound {
        Some(b) => b,
        None => {
            // Every candidate port was taken — keep the app alive without the CLI.
            eprintln!(
                "spike: CLI listener could not bind any port in {preferred}..{} — \
                 `spike open`/`spike context` disabled for this session",
                preferred.saturating_add(PORT_SCAN)
            );
            return;
        }
    };
    let _ = BOUND_PORT.set(port);
    if port != preferred {
        eprintln!("spike: CLI listener bound 127.0.0.1:{port} (preferred {preferred} was in use)");
    }
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            handle(&app, request);
        }
    });
}

/// Route one request and respond. Response errors (client hung up) are moot.
fn handle(app: &AppHandle, mut req: Request) {
    // Reject anything that isn't a token-bearing, same-process request before
    // it can reach a route (read a file into the preview, inject an event, …).
    if !authorized(&req) {
        let _ = req.respond(json_response(403, r#"{"error":"forbidden"}"#));
        return;
    }
    let method = req.method().clone();
    // bin/spike never sends a query string, but strip one defensively.
    let path = req.url().split('?').next().unwrap_or("").to_string();
    let response = match (&method, path.as_str()) {
        (Method::Post, "/open") => handle_open(app, &mut req),
        (Method::Post, "/shot") => handle_shot(app, &mut req),
        (Method::Get, "/context") => handle_context(app),
        (Method::Post, "/focus") => handle_focus(app, &mut req),
        (Method::Post, "/agent-event") => handle_agent_event(app, &mut req),
        // Inline permission approvals. The blocked hook polls the GET; the UI's
        // Allow/Deny click resolves via the Tauri command (or this POST, for a
        // non-Tauri resolver). Both share AppState.permissions.
        (Method::Get, "/agent-permission") => handle_permission_poll(app, &req),
        (Method::Post, "/agent-permission") => handle_permission_resolve(app, &mut req),
        (Method::Post, "/spawn") => handle_spawn(app, &mut req),
        (Method::Post, "/export-template") => handle_template(app, &mut req, "tmpl-export"),
        (Method::Post, "/import-template") => handle_template(app, &mut req, "tmpl-import"),
        _ => Response::from_string("not found").with_status_code(404),
    };
    let _ = req.respond(response);
}

/// POST /open — `spike open <path>` (server.ts 554–563).
fn handle_open(app: &AppHandle, req: &mut Request) -> Response<Cursor<Vec<u8>>> {
    let Some(msg) = read_json_body(req) else {
        return json_response(400, r#"{"error":"bad json"}"#);
    };
    let p = msg.get("path").and_then(Value::as_str).unwrap_or("");
    // The lane that fired this open, forwarded verbatim by `spike open` from
    // $SPIKE_SESSION_ID. Rides the `open` event so the page can attribute the
    // preview to the owning lane; absent for opens from outside a Spike pty.
    let sid = msg.get("sessionId").and_then(Value::as_str);
    // An http(s):// target opens live in the preview (a local dev tool's board,
    // say) — it's a URL, not a filesystem path, so it skips the absolute-path
    // and exists-on-disk checks. The page decides how to render it.
    if is_http_url(p) {
        let _ = app.emit("open", json!({ "kind": "url", "path": p, "sessionId": sid }));
        crate::watcher::log_action("spike_open", json!({ "path": p, "kind": "url" }));
        return json_response(200, r#"{"ok":true,"kind":"url"}"#);
    }
    if p.is_empty() || !Path::new(p).is_absolute() {
        return json_response(400, r#"{"error":"absolute path required"}"#);
    }
    let path = Path::new(p);
    if path.is_dir() {
        // The old broadcast({kind:'project', path}) → Tauri event `open`.
        let _ = app.emit("open", json!({ "kind": "project", "path": p, "sessionId": sid }));
        crate::watcher::log_action("spike_open", json!({ "path": p, "kind": "project" }));
        return json_response(200, r#"{"ok":true,"kind":"project"}"#);
    }
    if path.is_file() {
        let _ = app.emit("open", json!({ "kind": "open", "path": p, "sessionId": sid }));
        crate::watcher::log_action("spike_open", json!({ "path": p, "kind": "file" }));
        return json_response(200, r#"{"ok":true,"kind":"open"}"#);
    }
    json_response(404, r#"{"error":"no such file or folder"}"#)
}

/// POST /shot — `spike shot [pane|window]`. Unlike /open, this does real work
/// rather than emitting an event for the page to act on: the capture happens in
/// Rust (it photographs a native view the page cannot reach) and the response
/// carries the PNG's path, which the caller then reads.
///
/// Blocking is intentional. `spike shot` is only useful if the path it prints
/// points at a file that already exists, so this waits for the capture instead
/// of handing back a promise. Capture has its own timeout; this thread is the
/// listener's, never the main thread.
fn handle_shot(app: &AppHandle, req: &mut Request) -> Response<Cursor<Vec<u8>>> {
    // Body is optional: `spike shot` with no argument means the pane.
    let target_word = read_json_body(req)
        .and_then(|m| m.get("target").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default();
    let target = match crate::shot::parse_target(&target_word) {
        Ok(t) => t,
        Err(e) => {
            return json_response(400, &json!({ "error": e }).to_string());
        }
    };
    match crate::shot::capture(app, target) {
        Ok(path) => json_response(
            200,
            &json!({ "ok": true, "path": path.to_string_lossy() }).to_string(),
        ),
        Err(e) => json_response(500, &json!({ "error": e }).to_string()),
    }
}

/// POST /export-template + /import-template — `spike export-template <dir>` /
/// `spike import-template <dir>`. A thin trigger like /open: validate the dir is
/// an absolute path and emit the matching Tauri event the page acts on. The
/// page owns bundle semantics (read the theme, write/read files via the
/// write_bundle/read_bundle commands), so a 200 means "handed off to the page",
/// not "written to disk".
fn handle_template(
    app: &AppHandle,
    req: &mut Request,
    event: &str,
) -> Response<Cursor<Vec<u8>>> {
    let Some(msg) = read_json_body(req) else {
        return json_response(400, r#"{"error":"bad json"}"#);
    };
    let p = msg.get("path").and_then(Value::as_str).unwrap_or("");
    if p.is_empty() || !Path::new(p).is_absolute() {
        return json_response(400, r#"{"error":"absolute path required"}"#);
    }
    let _ = app.emit(event, json!({ "path": p }));
    crate::watcher::log_action("spike_template", json!({ "path": p, "event": event }));
    json_response(200, r#"{"ok":true}"#)
}

/// POST /spawn — `spike spawn "<task>"`. An agent asks Spike to spawn a scoped
/// subagent. A thin trigger like /open: read the opaque task + the forwarded
/// source lane id and emit `spawn` for the page, which owns the real work (fork a
/// worktree, brief the child, boot it, nest it under the source). The task is
/// untrusted agent text — it's forwarded verbatim as a string and never touches
/// the filesystem here; the page treats it as the child's brief.
fn handle_spawn(app: &AppHandle, req: &mut Request) -> Response<Cursor<Vec<u8>>> {
    let Some(msg) = read_json_body(req) else {
        return json_response(400, r#"{"error":"bad json"}"#);
    };
    let task = msg.get("task").and_then(Value::as_str).unwrap_or("").trim();
    if task.is_empty() {
        return json_response(400, r#"{"error":"task required"}"#);
    }
    // The lane that fired this spawn → the child's parent. Absent when `spike
    // spawn` runs outside a Spike pty; the page then has no source to nest under.
    let sid = msg.get("sessionId").and_then(Value::as_str);
    let _ = app.emit("spawn", json!({ "task": task, "sessionId": sid }));
    crate::watcher::log_action("spike_spawn", json!({ "hasSource": sid.is_some() }));
    json_response(200, r#"{"ok":true}"#)
}

/// GET /context — `spike context` (server.ts 583–593): the last-reported
/// focus plus the active group's pinned paths folded in.
fn handle_context(app: &AppHandle) -> Response<Cursor<Vec<u8>>> {
    let state = app.state::<AppState>();
    let focus = state.focus.lock().unwrap().clone();
    let mut obj = match focus {
        Value::Object(map) => map, // set_focus stores the sanitized full shape
        _ => empty_focus(),        // Value::Null until the first report
    };
    // `currentFocus.activeGroup ? readGroup(...)... : []` — JS truthiness, so
    // an empty-string group also yields no pins.
    let pins = obj
        .get("activeGroup")
        .and_then(Value::as_str)
        .filter(|g| !g.is_empty())
        .map(group_pinned_paths)
        .unwrap_or_default();
    obj.insert("pinnedPaths".into(), Value::Array(pins));
    let body = serde_json::to_string(&Value::Object(obj)).unwrap_or_else(|_| "{}".into());
    json_response(200, &body)
}

/// POST /focus — same sanitization as the set_focus command (server.ts 564–582).
fn handle_focus(app: &AppHandle, req: &mut Request) -> Response<Cursor<Vec<u8>>> {
    let Some(msg) = read_json_body(req) else {
        return json_response(400, r#"{"error":"bad json"}"#);
    };
    if let Some(sanitized) = sanitize_focus(&msg) {
        *app.state::<AppState>().focus.lock().unwrap() = sanitized;
    }
    json_response(200, r#"{"ok":true}"#)
}

/// POST /agent-event — engine-neutral intake for the agent broker. Validates
/// just enough to keep the ring clean (non-empty run_id + kind); data is
/// passed through verbatim. The broker assigns seq + ts and handles emit +
/// jsonl mirror.
fn handle_agent_event(app: &AppHandle, req: &mut Request) -> Response<Cursor<Vec<u8>>> {
    let Some(msg) = read_json_body(req) else {
        return json_response(400, r#"{"error":"bad json"}"#);
    };
    let run_id = msg
        .get("run_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let Some(run_id) = run_id else {
        return json_response(400, r#"{"error":"run_id required"}"#);
    };
    let kind = msg
        .get("kind")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let Some(kind) = kind else {
        return json_response(400, r#"{"error":"kind required"}"#);
    };
    let session_id = msg
        .get("session_id")
        .and_then(Value::as_str)
        .map(|s| s.to_string());
    // data defaults to {}; non-object values fall back to {} rather than
    // erroring — keeps adapters forgiving (plan: "data is permissive").
    let data = msg
        .get("data")
        .cloned()
        .filter(|v| v.is_object())
        .unwrap_or_else(|| json!({}));

    let seq = app.state::<AppState>().agent_broker.append(
        app,
        run_id.to_string(),
        session_id,
        kind.to_string(),
        data,
    );
    let body = json!({ "ok": true, "seq": seq }).to_string();
    json_response(200, &body)
}

/// GET /agent-permission?prompt_id=… — the blocked hook's poll. Returns the
/// decision the UI made (and consumes it), or null while still pending. Must
/// return immediately: the listener is single-threaded, so a blocking wait here
/// would stall every other request — the hook does the waiting, by polling.
fn handle_permission_poll(app: &AppHandle, req: &Request) -> Response<Cursor<Vec<u8>>> {
    let url = req.url();
    // prompt_id is minted URL-safe by the hook (run_id + counter), so a plain
    // split is enough — no percent-decoding needed.
    let prompt_id = url
        .split('?')
        .nth(1)
        .unwrap_or("")
        .split('&')
        .find_map(|kv| kv.strip_prefix("prompt_id="))
        .unwrap_or("");
    if prompt_id.is_empty() {
        return json_response(400, r#"{"error":"prompt_id required"}"#);
    }
    let decision = app.state::<AppState>().take_permission(prompt_id);
    json_response(200, &json!({ "decision": decision }).to_string())
}

/// POST /agent-permission {prompt_id, decision} — resolve a pending prompt. The
/// Tauri command below is the frontend's path; this HTTP form lets a non-Tauri
/// resolver (or a test) answer the same store. `decision` is validated so a
/// forged/garbled body can't stash an arbitrary string the hook would echo into
/// a permissionDecision.
fn handle_permission_resolve(app: &AppHandle, req: &mut Request) -> Response<Cursor<Vec<u8>>> {
    let Some(msg) = read_json_body(req) else {
        return json_response(400, r#"{"error":"bad json"}"#);
    };
    let prompt_id = msg
        .get("prompt_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let Some(prompt_id) = prompt_id else {
        return json_response(400, r#"{"error":"prompt_id required"}"#);
    };
    let decision = msg.get("decision").and_then(Value::as_str).unwrap_or("");
    if !matches!(decision, "allow_once" | "allow_session" | "deny") {
        return json_response(400, r#"{"error":"bad decision"}"#);
    }
    app.state::<AppState>().resolve_permission(prompt_id, decision);
    json_response(200, r#"{"ok":true}"#)
}

/// The frontend's Allow/Deny click lands here. Writes the decision into the
/// shared store; the blocked hook's next poll reads it and unblocks the tool.
/// Validated so only the three real decisions can be stored.
#[tauri::command]
pub fn agent_permission_answer(
    prompt_id: String,
    decision: String,
    state: State<AppState>,
) -> Result<(), String> {
    if prompt_id.is_empty() {
        return Err("prompt_id required".into());
    }
    if !matches!(decision.as_str(), "allow_once" | "allow_session" | "deny") {
        return Err("bad decision".into());
    }
    state.resolve_permission(&prompt_id, &decision);
    Ok(())
}

/// The page reports its current focus here whenever it changes (open a file,
/// select a row, edit, re-root). Port of POST /focus (server.ts 564–582).
///
/// Request: payload =
///   { projectPath: string|null,
///     openFile: { path, name, view, binary, tooBig, media } | null,
///     browser: { url } | null,
///     brainstorm: { count, items:[{type,text,name,x,y}] } | null,
///     selection: [string], dirty: bool, recent: [string],
///     tabs: [{ path, name, ephemeral, dirty, active }],
///     activeGroup: string|null }
/// Behavior: sanitize field-by-field exactly like server.ts (wrong-typed
/// fields fall back to null/[]/false — never reject the report), then store
/// into state.focus. GET /context reads it back. Always Ok.
#[tauri::command]
pub fn set_focus(
    state: State<'_, AppState>,
    payload: serde_json::Value,
) -> Result<(), String> {
    // A non-object payload leaves the stored focus untouched, exactly like
    // server.ts's `if (msg && typeof msg === 'object')` guard.
    if let Some(sanitized) = sanitize_focus(&payload) {
        *state.focus.lock().unwrap() = sanitized;
    }
    Ok(())
}

// ── helpers ─────────────────────────────────────────────────────────────────

/// Is `p` an http(s):// URL (case-insensitive scheme)? Such targets open live
/// in the preview rather than as files. Mirrors bin/spike's is_http_url.
fn is_http_url(p: &str) -> bool {
    let lower = p.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// Field-by-field sanitization (server.ts 568–579). None when the payload
/// isn't an object (report ignored, never an error).
fn sanitize_focus(msg: &Value) -> Option<Value> {
    let m = msg.as_object()?;
    let mut out = serde_json::Map::new();
    out.insert(
        "projectPath".into(),
        m.get("projectPath").filter(|v| v.is_string()).cloned().unwrap_or(Value::Null),
    );
    // `msg.openFile && typeof msg.openFile === 'object'` — kept verbatim.
    out.insert(
        "openFile".into(),
        m.get("openFile").filter(|v| v.is_object()).cloned().unwrap_or(Value::Null),
    );
    // The in-pane browser's current URL, when a live board is on screen. Kept
    // only if it's an object carrying a string `url` (mirrors the openFile guard);
    // anything else → null.
    out.insert(
        "browser".into(),
        m.get("browser")
            .filter(|v| {
                v.as_object()
                    .and_then(|o| o.get("url"))
                    .map(Value::is_string)
                    .unwrap_or(false)
            })
            .cloned()
            .unwrap_or(Value::Null),
    );
    // The open Brainstorm canvas summary ({count, items:[…]}). Kept when it's an
    // object (mirrors openFile); anything else → null. The frontend caps size.
    out.insert(
        "brainstorm".into(),
        m.get("brainstorm").filter(|v| v.is_object()).cloned().unwrap_or(Value::Null),
    );
    out.insert("selection".into(), string_array(m.get("selection")));
    out.insert(
        "dirty".into(),
        Value::Bool(m.get("dirty").map(js_truthy).unwrap_or(false)), // !!msg.dirty
    );
    out.insert("recent".into(), string_array(m.get("recent")));
    out.insert("tabs".into(), tabs_array(m.get("tabs")));
    out.insert(
        "activeGroup".into(),
        m.get("activeGroup").filter(|v| v.is_string()).cloned().unwrap_or(Value::Null),
    );
    Some(Value::Object(out))
}

/// `Array.isArray(x) ? x.filter(s => typeof s === 'string') : []`
fn string_array(v: Option<&Value>) -> Value {
    match v.and_then(Value::as_array) {
        Some(arr) => Value::Array(arr.iter().filter(|x| x.is_string()).cloned().collect()),
        None => Value::Array(vec![]),
    }
}

/// `msg.tabs.filter(t => t && typeof t === 'object' && typeof t.path === 'string')`
fn tabs_array(v: Option<&Value>) -> Value {
    match v.and_then(Value::as_array) {
        Some(arr) => Value::Array(
            arr.iter()
                .filter(|t| {
                    t.as_object()
                        .and_then(|o| o.get("path"))
                        .map(Value::is_string)
                        .unwrap_or(false)
                })
                .cloned()
                .collect(),
        ),
        None => Value::Array(vec![]),
    }
}

/// JS `!!v` over a JSON value.
fn js_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(false),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// The pre-first-report focus (server.ts 349), sans pinnedPaths (the caller
/// folds those in).
fn empty_focus() -> serde_json::Map<String, Value> {
    let mut m = serde_json::Map::new();
    m.insert("projectPath".into(), Value::Null);
    m.insert("openFile".into(), Value::Null);
    m.insert("browser".into(), Value::Null);
    m.insert("brainstorm".into(), Value::Null);
    m.insert("selection".into(), Value::Array(vec![]));
    m.insert("dirty".into(), Value::Bool(false));
    m.insert("recent".into(), Value::Array(vec![]));
    m.insert("tabs".into(), Value::Array(vec![]));
    m.insert("activeGroup".into(), Value::Null);
    m
}

/// The active group's pinnedPaths from ~/.spike/groups/<slug>.json —
/// `(readGroup(g)?.pinnedPaths || []).filter(p => typeof p === 'string' && p.trim())`
/// (server.ts 589–591). Any read/parse failure → [].
fn group_pinned_paths(group: &str) -> Vec<Value> {
    let file = crate::state::spike_dir()
        .join("groups")
        .join(format!("{}.json", sanitize_group_name(group)));
    let Ok(raw) = std::fs::read_to_string(file) else {
        return vec![];
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return vec![];
    };
    parsed
        .get("pinnedPaths")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter(|p| p.as_str().map(|s| !s.trim().is_empty()).unwrap_or(false))
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

/// Filesystem-safe slug for a group filename. Port of sanitizeGroupName
/// (server.ts 169–171): trim, fold runs of non-[A-Za-z0-9_.-] to '-', strip
/// leading/trailing '-', fall back to "group". (JS \w without /u is ASCII.)
fn sanitize_group_name(name: &str) -> String {
    let mut out = String::new();
    let mut in_run = false;
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-' {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push('-');
            in_run = true;
        }
    }
    let out = out.trim_matches('-');
    if out.is_empty() {
        "group".into()
    } else {
        out.to_string()
    }
}

/// Read a size-capped JSON body (server.ts readJson, 266–273).
/// None = unreadable/malformed → the caller answers 400 {"error":"bad json"}.
fn read_json_body(req: &mut Request) -> Option<Value> {
    let mut body = String::new();
    req.as_reader()
        .take(BODY_CAP)
        .read_to_string(&mut body)
        .ok()?;
    serde_json::from_str(&body).ok()
}

/// A JSON response with the same Content-Type header server.ts set.
fn json_response(status: u16, body: &str) -> Response<Cursor<Vec<u8>>> {
    Response::from_string(body)
        .with_status_code(status)
        .with_header(
            Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                .expect("static header"),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_focus_passes_a_well_formed_report_through() {
        let report = json!({
            "projectPath": "/Users/a/proj",
            "openFile": { "path": "/Users/a/proj/x.md", "name": "x.md", "view": "rendered",
                          "binary": false, "tooBig": false, "media": null },
            "browser": { "url": "https://example.com" },
            "brainstorm": { "count": 1, "items": [{ "type": "note", "text": "hi", "x": 1, "y": 2 }] },
            "selection": ["/Users/a/proj/x.md"],
            "dirty": true,
            "recent": ["/Users/a/proj/x.md"],
            "tabs": [{ "path": "/Users/a/proj/x.md", "name": "x.md",
                       "ephemeral": false, "dirty": true, "active": true }],
            "activeGroup": "research"
        });
        let got = sanitize_focus(&report).unwrap();
        assert_eq!(got, report);
    }

    #[test]
    fn sanitize_focus_falls_back_field_by_field_on_wrong_types() {
        let junk = json!({
            "projectPath": 42,
            "openFile": "nope",
            "browser": { "url": 5 },             // url not a string → dropped
            "selection": ["ok", 7, null, "also ok"],
            "dirty": "yes",                      // truthy string → true
            "recent": "not an array",
            "tabs": [{ "path": "/a" }, { "name": "no path" }, "str", null, { "path": 5 }],
            "activeGroup": ["x"]
        });
        let got = sanitize_focus(&junk).unwrap();
        assert_eq!(got["projectPath"], Value::Null);
        assert_eq!(got["openFile"], Value::Null);
        assert_eq!(got["browser"], Value::Null);
        assert_eq!(got["selection"], json!(["ok", "also ok"]));
        assert_eq!(got["dirty"], json!(true));
        assert_eq!(got["recent"], json!([]));
        assert_eq!(got["tabs"], json!([{ "path": "/a" }]));
        assert_eq!(got["activeGroup"], Value::Null);
    }

    #[test]
    fn sanitize_focus_defaults_missing_fields() {
        let got = sanitize_focus(&json!({})).unwrap();
        assert_eq!(got["projectPath"], Value::Null);
        assert_eq!(got["browser"], Value::Null);
        assert_eq!(got["dirty"], json!(false));
        assert_eq!(got["selection"], json!([]));
        assert_eq!(got["tabs"], json!([]));
    }

    #[test]
    fn sanitize_focus_rejects_non_objects() {
        assert!(sanitize_focus(&json!(null)).is_none());
        assert!(sanitize_focus(&json!("focus")).is_none());
        assert!(sanitize_focus(&json!([1, 2])).is_none());
    }

    #[test]
    fn js_truthy_matches_double_bang() {
        assert!(!js_truthy(&json!(null)));
        assert!(!js_truthy(&json!(false)));
        assert!(!js_truthy(&json!(0)));
        assert!(!js_truthy(&json!("")));
        assert!(js_truthy(&json!("x")));
        assert!(js_truthy(&json!(1)));
        assert!(js_truthy(&json!({})));
        assert!(js_truthy(&json!([])));
    }

    #[test]
    fn ct_eq_matches_only_identical_bytes() {
        assert!(ct_eq(b"abc123", b"abc123"));
        assert!(!ct_eq(b"abc123", b"abc124"));
        assert!(!ct_eq(b"abc", b"abcd")); // different lengths
        assert!(ct_eq(b"", b""));
    }

    #[test]
    fn token_is_stable_and_nonempty() {
        let a = token();
        let b = token();
        assert!(!a.is_empty());
        assert_eq!(a, b); // OnceLock: same value every call
        assert!(a.len() >= 32); // 32 bytes base64 → 43 url-safe chars
    }

    #[test]
    fn group_slugs_match_server_ts() {
        assert_eq!(sanitize_group_name("research"), "research");
        assert_eq!(sanitize_group_name("My Group / v2"), "My-Group-v2");
        assert_eq!(sanitize_group_name("  spaced  "), "spaced");
        assert_eq!(sanitize_group_name("a.b-c_d"), "a.b-c_d");
        assert_eq!(sanitize_group_name("///"), "group");
        assert_eq!(sanitize_group_name(""), "group");
    }
}
