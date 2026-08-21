// spike — talk to the running Spike server over HTTP on 127.0.0.1:7878.
//   spike open <file-or-folder>   open a file in the preview / re-root the tree
//   spike context                 print what the user is currently looking at
// Rust port of the legacy `bin/spike` Node script. Output is plaintext the
// embedded Claude session learns from, so byte-for-byte parity with the JS
// version matters — see the format_context tests below for the contract.

use std::env;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::process;
use std::time::Duration;

use serde_json::{json, Value};

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let port = env::var("SPIKE_PORT")
        .ok()
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(7878);

    match args.first().map(String::as_str) {
        Some("open") => cmd_open(args.get(1).map(String::as_str), port),
        Some("context") => cmd_context(port),
        Some("shot") => cmd_shot(args.get(1).map(String::as_str), port),
        Some("spawn") => cmd_spawn(args.get(1).map(String::as_str), port),
        Some("export-template") => cmd_template(args.get(1).map(String::as_str), port, "export"),
        Some("import-template") => cmd_template(args.get(1).map(String::as_str), port, "import"),
        _ => {
            eprintln!(
                "usage: spike open <file-or-folder-or-url> | spike context | \
                 spike shot [pane|window] | spike spawn \"<task>\" | \
                 spike export-template <dir> | spike import-template <dir>"
            );
            process::exit(1);
        }
    }
}

fn cmd_open(target: Option<&str>, port: u16) {
    let Some(target) = target else {
        eprintln!("usage: spike open <file-or-folder-or-url>");
        process::exit(1);
    };
    // A web target (an http(s):// URL, or a bare host:port like `localhost:3457`)
    // opens live in the preview panel instead of being resolved against the
    // filesystem. The page decides how to render it; we hand the normalized URL
    // through. Everything else is a path, resolved against cwd.
    let display = if let Some(url) = to_web_url(target) {
        url
    } else {
        let cwd = match env::current_dir() {
            Ok(p) => p,
            Err(_) => {
                // path.resolve in Node would throw here too; align by exiting non-zero.
                eprintln!("spike: cannot resolve cwd");
                process::exit(1);
            }
        };
        normalize(&cwd.join(target)).to_string_lossy().into_owned()
    };
    // The lane that fired this open: every Spike-spawned terminal carries its
    // session id in $SPIKE_SESSION_ID (pty.rs). Forwarding it lets the page
    // attribute the preview to the lane that opened it (lane color, ownership
    // lifecycle). Absent — e.g. `spike` run from outside a Spike pty — the page
    // treats the open as user-owned, exactly as before.
    let mut body = json!({ "path": display });
    if let Ok(sid) = env::var("SPIKE_SESSION_ID") {
        if !sid.is_empty() {
            body["sessionId"] = json!(sid);
        }
    }
    let body = body.to_string();
    let (status, resp_body) = match http_request(port, "POST", "/open", Some(&body)) {
        Ok(r) => r,
        Err(_) => return no_server(port),
    };
    if status == 200 {
        println!("opened in spike: {}", display);
        return;
    }
    // bin/spike (JS) prints the parsed `error` field on non-200, else the raw body.
    let msg = serde_json::from_str::<Value>(&resp_body)
        .ok()
        .and_then(|v| v.get("error").and_then(Value::as_str).map(String::from))
        .unwrap_or(resp_body);
    eprintln!("spike: {}", msg);
    process::exit(1);
}

/// `spike spawn "<task>"` — an agent asks Spike to spawn a scoped subagent for a
/// piece of work. The task is an opaque string (the child's brief); no path or
/// URL resolution. Mirrors cmd_open's transport: forward $SPIKE_SESSION_ID so the
/// page nests the child under the lane that asked. The 200 is optimistic — the
/// page owns the actual spawn (fork worktree, brief, boot).
fn cmd_spawn(task: Option<&str>, port: u16) {
    let task = task.map(str::trim).filter(|t| !t.is_empty());
    let Some(task) = task else {
        eprintln!("usage: spike spawn \"<task for the subagent>\"");
        process::exit(1);
    };
    let mut body = json!({ "task": task });
    if let Ok(sid) = env::var("SPIKE_SESSION_ID") {
        if !sid.is_empty() {
            body["sessionId"] = json!(sid);
        }
    }
    let body = body.to_string();
    let (status, resp_body) = match http_request(port, "POST", "/spawn", Some(&body)) {
        Ok(r) => r,
        Err(_) => return no_server(port),
    };
    if status == 200 {
        println!("spike: spawning subagent");
        return;
    }
    let msg = serde_json::from_str::<Value>(&resp_body)
        .ok()
        .and_then(|v| v.get("error").and_then(Value::as_str).map(String::from))
        .unwrap_or(resp_body);
    eprintln!("spike: {}", msg);
    process::exit(1);
}

/// `spike export-template <dir>` / `spike import-template <dir>` — resolve the
/// target dir to an absolute path and POST it; the page does the actual bundle
/// read/write. Like `cmd_open`, the 200 is optimistic (handed off to the page).
fn cmd_template(target: Option<&str>, port: u16, kind: &str) {
    let Some(target) = target else {
        eprintln!("usage: spike {kind}-template <dir>");
        process::exit(1);
    };
    let cwd = match env::current_dir() {
        Ok(p) => p,
        Err(_) => {
            eprintln!("spike: cannot resolve cwd");
            process::exit(1);
        }
    };
    let abs = normalize(&cwd.join(target));
    let body = json!({ "path": abs.to_string_lossy() }).to_string();
    let route = if kind == "export" {
        "/export-template"
    } else {
        "/import-template"
    };
    let (status, resp_body) = match http_request(port, "POST", route, Some(&body)) {
        Ok(r) => r,
        Err(_) => return no_server(port),
    };
    if status == 200 {
        let verb = if kind == "export" {
            "exporting template to"
        } else {
            "importing template from"
        };
        println!("{}: {}", verb, abs.display());
        return;
    }
    let msg = serde_json::from_str::<Value>(&resp_body)
        .ok()
        .and_then(|v| v.get("error").and_then(Value::as_str).map(String::from))
        .unwrap_or(resp_body);
    eprintln!("spike: {}", msg);
    process::exit(1);
}

/// Is the argument an http(s):// URL (case-insensitively)? Such targets bypass
/// filesystem resolution and open live in the preview. We don't validate the
/// rest of the URL — the listener and the page do the real gating.
fn is_http_url(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// Resolve a `spike open` argument to a web target, or None if it's a
/// filesystem path. Returns the normalized http(s):// URL for either an
/// explicit URL or a bare `host:port` / `localhost` a dev naturally types
/// (`spike open localhost:3457`) — bare targets get an `http://` scheme so the
/// listener and the page see a well-formed URL. We only treat unmistakable
/// web shapes as URLs so a real path is never misread: a bare word or a
/// `name.ext` (no port, not `localhost`) stays a path.
fn to_web_url(s: &str) -> Option<String> {
    if is_http_url(s) {
        return Some(s.to_string());
    }
    looks_like_host_port(s).then(|| format!("http://{s}"))
}

/// Does `s` look like a bare `host[:port]` web target (no scheme)? True for
/// `localhost`, `localhost:3457`, `127.0.0.1:3000`, `app.local:8080/x`. False
/// for filesystem paths — anything absolute/relative/`~`, a bare word, or a
/// `name.ext` with no numeric port. The port, when present, must be all digits;
/// that's what separates `localhost:3457` (a site) from `notes.md` (a file).
fn looks_like_host_port(s: &str) -> bool {
    if s.is_empty() || s.starts_with('/') || s.starts_with('.') || s.starts_with('~') {
        return false;
    }
    // The authority is everything before the first path slash (host[:port]).
    let authority = s.split('/').next().unwrap_or("");
    match authority.rsplit_once(':') {
        // host:port — a numeric port over a hostname of [A-Za-z0-9.-].
        Some((host, port)) => {
            !host.is_empty()
                && !port.is_empty()
                && port.bytes().all(|b| b.is_ascii_digit())
                && host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        }
        // no port — only `localhost` is a site; a bare word is a path.
        None => authority.eq_ignore_ascii_case("localhost"),
    }
}

fn cmd_context(port: u16) {
    let (_status, body) = match http_request(port, "GET", "/context", None) {
        Ok(r) => r,
        Err(_) => return no_server(port),
    };
    // JS: `let f = {}; try { f = JSON.parse(out); } catch {}` — swallow parse errors.
    let focus: Value = serde_json::from_str(&body).unwrap_or(Value::Object(Default::default()));
    println!("{}", format_context(&focus));
}

/// `spike shot [pane|window]` — photograph what the user is looking at and
/// print the PNG's path, which the caller then reads.
///
/// Prints a bare path and nothing else on success, so it drops straight into a
/// read without parsing. The native browser board is the case this exists for:
/// it renders remote pages that no text channel can reach, by the same design
/// that keeps those pages away from Spike's commands.
fn cmd_shot(target: Option<&str>, port: u16) {
    let body = json!({ "target": target.unwrap_or("") }).to_string();
    let (status, resp_body) = match http_request(port, "POST", "/shot", Some(&body)) {
        Ok(r) => r,
        Err(_) => return no_server(port),
    };
    let parsed: Value = serde_json::from_str(&resp_body).unwrap_or(Value::Null);
    if status == 200 {
        if let Some(path) = parsed.get("path").and_then(Value::as_str) {
            println!("{path}");
            return;
        }
    }
    let err = parsed
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("screenshot failed");
    eprintln!("spike: {err}");
    process::exit(1);
}

fn no_server(port: u16) {
    eprintln!("spike: no Spike server on port {} (is Spike running?)", port);
    process::exit(1);
}

/// Render the focus JSON into the multi-line plaintext the agent reads.
/// Lifted line-for-line from the JS so the contract is auditable here.
fn format_context(f: &Value) -> String {
    let mut lines: Vec<String> = Vec::new();

    // project: <path> | (none)   — JS: `f.projectPath || '(none)'`
    let project = f
        .get("projectPath")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    lines.push(format!("project: {}", project.unwrap_or("(none)")));

    // workspace + pinned   — JS: `if (f.activeGroup)` is truthy (empty string falls out).
    let active_group = f
        .get("activeGroup")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    if let Some(g) = active_group {
        lines.push(format!("workspace: {}", g));
        let pins: Vec<&str> = f
            .get("pinnedPaths")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .filter(|s| !s.is_empty()) // JS `.filter(Boolean)` drops "" too
                    .collect()
            })
            .unwrap_or_default();
        if !pins.is_empty() {
            lines.push("pinned (always relevant in this workspace):".to_string());
            for p in &pins {
                lines.push(format!("  - {}", p));
            }
        }
    }

    // open file (+ tag chain)   — JS: `f.openFile && f.openFile.path`.
    let open_file = f
        .get("openFile")
        .and_then(Value::as_object)
        .filter(|o| {
            o.get("path")
                .and_then(Value::as_str)
                .map(|s| !s.is_empty())
                .unwrap_or(false)
        });
    let open_path = open_file.and_then(|o| o.get("path").and_then(Value::as_str));
    // Whether a live browser board is on screen — gates the "preview is closed"
    // fallback so an open browser doesn't read as "nothing open".
    let has_browser = f
        .get("browser")
        .and_then(Value::as_object)
        .and_then(|o| o.get("url"))
        .and_then(Value::as_str)
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    // The Brainstorm canvas is also an on-screen surface — when it's open the
    // preview isn't "closed", the user is looking at their board (rendered below).
    let has_brainstorm = f.get("brainstorm").and_then(Value::as_object).is_some();
    if let Some(o) = open_file {
        let path = open_path.unwrap_or("");
        // First-truthy tag in declaration order. Don't sort, don't collect-then-pick.
        let mut tags: Vec<String> = Vec::new();
        if let Some(m) = o.get("media").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            tags.push(m.to_string());
        } else if o.get("binary").and_then(Value::as_bool).unwrap_or(false) {
            tags.push("binary".to_string());
        } else if o.get("tooBig").and_then(Value::as_bool).unwrap_or(false) {
            tags.push("too big".to_string());
        } else if let Some(v) = o.get("view").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            tags.push(v.to_string());
        }
        if f.get("dirty").and_then(Value::as_bool).unwrap_or(false) {
            tags.push("unsaved edits".to_string());
        }
        if tags.is_empty() {
            lines.push(format!("open file: {}", path));
        } else {
            lines.push(format!("open file: {} ({})", path, tags.join(", ")));
        }
    } else if !has_browser && !has_brainstorm {
        // U+2014 em-dash — not a hyphen. Bytes: \xe2\x80\x94.
        // Suppressed when a browser board OR the Brainstorm canvas is on screen:
        // the preview isn't "closed", there's a live surface (reported below).
        lines.push("open file: (none — preview is closed)".to_string());
    }

    // browser: <url>   — the in-pane live browser, when a board is on screen.
    // A URL is not a file, so it gets its own line rather than riding openFile.
    if let Some(url) = f
        .get("browser")
        .and_then(Value::as_object)
        .and_then(|o| o.get("url"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        lines.push(format!("browser: {}", url));
        // The board renders a remote page that no text channel can reach: the
        // same capability model that keeps page JS away from Spike's commands
        // keeps its content away from the agent. So advertise the way in rather
        // than leaving the agent to assume the URL is all it can have.
        //
        // A line of text, not an image. Attaching a screenshot to every context
        // call would cost tokens on calls made for unrelated reasons and would
        // ship a picture of whatever is open into an agent's context without
        // anyone asking for it. Pull, not push.
        lines.push(
            "visual: run `spike shot` for a screenshot of the page (its text is not readable otherwise)"
                .to_string(),
        );
    }

    // brainstorm canvas — the on-screen board the user is looking at. Reported
    // as structured text (item type + text/name + position) so the agent knows
    // the canvas contents without a screenshot or an "orient" round-trip.
    if let Some(bs) = f.get("brainstorm").and_then(Value::as_object) {
        let count = bs.get("count").and_then(Value::as_u64).unwrap_or(0);
        if count == 0 {
            lines.push("brainstorm canvas: on screen (empty)".to_string());
        } else {
            lines.push(format!("brainstorm canvas ({} items) — on screen:", count));
            if let Some(items) = bs.get("items").and_then(Value::as_array) {
                for it in items {
                    let ty = it.get("type").and_then(Value::as_str).unwrap_or("item");
                    let text = it.get("text").and_then(Value::as_str).filter(|s| !s.is_empty());
                    let name = it.get("name").and_then(Value::as_str).filter(|s| !s.is_empty());
                    let label = match (text, name) {
                        (Some(t), _) => format!("{} \"{}\"", ty, t),
                        (None, Some(n)) => format!("{} \"{}\"", ty, n),
                        _ => ty.to_string(),
                    };
                    match (it.get("x").and_then(Value::as_i64), it.get("y").and_then(Value::as_i64)) {
                        (Some(x), Some(y)) => lines.push(format!("  - {} @ {},{}", label, x, y)),
                        _ => lines.push(format!("  - {}", label)),
                    }
                }
            }
        }
    }

    // selection — drops the openFile.path entry; survives entirely when openFile is null.
    let selection: Vec<&str> = f
        .get("selection")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .filter(|p| match open_path {
                    Some(op) => *p != op,
                    None => true,
                })
                .collect()
        })
        .unwrap_or_default();
    if !selection.is_empty() {
        lines.push(format!("selection: {}", selection.join(", ")));
    }

    // tabs gating, ported verbatim:
    //   heldTabs.length > 1 || (heldTabs.length === 1 && tabs.length > 1)
    let tabs: Vec<&serde_json::Map<String, Value>> = f
        .get("tabs")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_object).collect())
        .unwrap_or_default();
    let held_count = tabs
        .iter()
        .filter(|t| !t.get("ephemeral").and_then(Value::as_bool).unwrap_or(false))
        .count();
    if held_count > 1 || (held_count == 1 && tabs.len() > 1) {
        lines.push("open tabs (held — do not disturb):".to_string());
        for t in &tabs {
            let path = t.get("path").and_then(Value::as_str).unwrap_or("");
            let mut marks: Vec<&str> = Vec::new();
            if t.get("active").and_then(Value::as_bool).unwrap_or(false) {
                marks.push("active");
            }
            if t.get("ephemeral").and_then(Value::as_bool).unwrap_or(false) {
                marks.push("live/ephemeral");
            }
            if t.get("dirty").and_then(Value::as_bool).unwrap_or(false) {
                marks.push("unsaved");
            }
            if marks.is_empty() {
                lines.push(format!("  - {}", path));
            } else {
                lines.push(format!("  - {} ({})", path, marks.join(", ")));
            }
        }
    }

    // recent — header skipped entirely when the list is empty.
    let recent: Vec<&str> = f
        .get("recent")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if !recent.is_empty() {
        lines.push("recent:".to_string());
        for p in &recent {
            lines.push(format!("  - {}", p));
        }
    }

    lines.join("\n")
}

// ── HTTP client ─────────────────────────────────────────────────────────────
//
// Hand-rolled because the protocol surface is tiny: localhost only, no TLS,
// `Connection: close` so we read until EOF and never have to think about
// chunked transfer or keep-alive. tiny_http on the server side honors this
// and closes cleanly.

fn http_request(
    port: u16,
    method: &str,
    path: &str,
    body: Option<&str>,
) -> std::io::Result<(u16, String)> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))?;
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    stream.set_write_timeout(Some(Duration::from_secs(10)))?;

    let mut req = String::new();
    req.push_str(&format!("{} {} HTTP/1.1\r\n", method, path));
    req.push_str(&format!("Host: 127.0.0.1:{}\r\n", port));
    req.push_str("Connection: close\r\n");
    // The bridge now requires this launch's secret (injected into our env by
    // pty.rs as SPIKE_TOKEN). Absent/empty → the request is rejected, which is
    // correct when we're not running inside a Spike-spawned terminal.
    if let Ok(tok) = env::var("SPIKE_TOKEN") {
        if !tok.is_empty() {
            req.push_str(&format!("X-Spike-Token: {}\r\n", tok));
        }
    }
    if let Some(b) = body {
        req.push_str("Content-Type: application/json\r\n");
        req.push_str(&format!("Content-Length: {}\r\n", b.len()));
    }
    req.push_str("\r\n");
    if let Some(b) = body {
        req.push_str(b);
    }
    stream.write_all(req.as_bytes())?;
    // Half-close so the server sees EOF immediately if it cares; tiny_http
    // doesn't, but it's correct and doesn't cost anything.
    let _ = stream.shutdown(Shutdown::Write);

    let mut raw = Vec::new();
    stream.read_to_end(&mut raw)?;
    let raw = String::from_utf8_lossy(&raw).into_owned();
    let (head, body) = match raw.find("\r\n\r\n") {
        Some(i) => (raw[..i].to_string(), raw[i + 4..].to_string()),
        None => (raw, String::new()),
    };
    let status: u16 = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    Ok((status, body))
}

// ── path resolution ─────────────────────────────────────────────────────────
//
// Node's `path.resolve(cwd, target)` is purely lexical — collapses `.` and
// `..`, drops trailing slash, leading `..` against root is dropped. Rust's
// `PathBuf::join` doesn't normalize, so we do it ourselves. Filesystem-touch-
// free by design; matches `path-clean` semantics.

fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    let mut had_root = false;
    for comp in p.components() {
        match comp {
            Component::Prefix(_) | Component::RootDir => {
                out.push(comp.as_os_str());
                had_root = true;
            }
            Component::CurDir => {}
            Component::ParentDir => {
                let last_is_normal = out
                    .components()
                    .next_back()
                    .map(|c| matches!(c, Component::Normal(_)))
                    .unwrap_or(false);
                if last_is_normal {
                    out.pop();
                } else if !had_root {
                    out.push(comp.as_os_str());
                }
                // else: at root with no normal component above, drop the ".."
            }
            Component::Normal(n) => out.push(n),
        }
    }
    if out.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn empty_focus_renders_minimum() {
        let f = json!({
            "projectPath": null,
            "openFile": null,
            "selection": [],
            "dirty": false,
            "recent": [],
            "tabs": [],
            "activeGroup": null,
            "pinnedPaths": []
        });
        let want = "project: (none)\nopen file: (none — preview is closed)";
        assert_eq!(format_context(&f), want);
    }

    #[test]
    fn matches_pre_rewrite_snapshot() {
        // Captured from `spike context` against the live Node CLI on 2026-06-13
        // — every byte of the expected string was produced by the JS version.
        let f = json!({
            "activeGroup": "digital-garden",
            "dirty": false,
            "openFile": {
                "binary": false,
                "media": null,
                "name": "What Spike could learn from Warren and Mulch.md",
                "path": "/Users/annamarie/obsidian-vault/02-Thinking/What Spike could learn from Warren and Mulch.md",
                "tooBig": false,
                "view": "rendered"
            },
            "pinnedPaths": [],
            "projectPath": "/Users/annamarie/obsidian-vault",
            "recent": [
                "/Users/annamarie/obsidian-vault/02-Thinking/What Spike could learn from Warren and Mulch.md",
                "/Users/annamarie/obsidian-vault/02-Thinking/Inner and Outer — The Conversation.md"
            ],
            "selection": [],
            "tabs": [{
                "active": true,
                "dirty": false,
                "ephemeral": true,
                "name": "What Spike could learn from Warren and Mulch.md",
                "path": "/Users/annamarie/obsidian-vault/02-Thinking/What Spike could learn from Warren and Mulch.md"
            }]
        });
        let want = "project: /Users/annamarie/obsidian-vault\nworkspace: digital-garden\nopen file: /Users/annamarie/obsidian-vault/02-Thinking/What Spike could learn from Warren and Mulch.md (rendered)\nrecent:\n  - /Users/annamarie/obsidian-vault/02-Thinking/What Spike could learn from Warren and Mulch.md\n  - /Users/annamarie/obsidian-vault/02-Thinking/Inner and Outer — The Conversation.md";
        assert_eq!(format_context(&f), want);
    }

    #[test]
    fn browser_board_replaces_closed_preview_line() {
        // A live board on screen with no file: the URL gets its own line and the
        // "(none — preview is closed)" fallback is suppressed (preview isn't closed).
        let f = json!({
            "projectPath": "/p", "openFile": null, "browser": {"url": "https://example.com/docs"},
            "selection": [], "dirty": false, "recent": [], "tabs": [],
            "activeGroup": null, "pinnedPaths": []
        });
        let out = format_context(&f);
        assert!(out.contains("browser: https://example.com/docs"));
        assert!(!out.contains("preview is closed"));
    }

    #[test]
    fn browser_and_open_file_coexist_in_split() {
        // A file focused in one pane while a browser board shows in another:
        // both lines render, in declaration order (open file, then browser).
        let f = json!({
            "projectPath": "/p",
            "openFile": {"path": "/p/x", "media": null, "binary": false, "tooBig": false, "view": "rendered"},
            "browser": {"url": "https://example.com"},
            "selection": [], "dirty": false, "recent": [], "tabs": [],
            "activeGroup": null, "pinnedPaths": []
        });
        let out = format_context(&f);
        let open_at = out.find("open file: /p/x (rendered)").expect("open file line");
        let browser_at = out.find("browser: https://example.com").expect("browser line");
        assert!(open_at < browser_at);
    }

    #[test]
    fn browser_ignored_when_url_missing_or_empty() {
        // No url / empty url / wrong type → no browser line, fallback stays.
        for b in [json!({}), json!({"url": ""}), json!({"url": 7}), json!("nope"), Value::Null] {
            let f = json!({
                "projectPath": "/p", "openFile": null, "browser": b,
                "selection": [], "dirty": false, "recent": [], "tabs": [],
                "activeGroup": null, "pinnedPaths": []
            });
            let out = format_context(&f);
            assert!(!out.contains("browser:"), "unexpected browser line: {out}");
            assert!(out.contains("preview is closed"));
        }
    }

    #[test]
    fn brainstorm_canvas_renders_items_and_suppresses_closed_line() {
        // Canvas open with items: header + per-item lines, and "(none — preview
        // is closed)" is suppressed (the canvas IS an on-screen surface).
        let f = json!({
            "projectPath": "/p", "openFile": null, "browser": null,
            "brainstorm": {"count": 2, "items": [
                {"type": "note", "text": "TEST!!", "x": 620, "y": 180},
                {"type": "image", "name": "shot.png", "x": 900, "y": 300}
            ]},
            "selection": [], "dirty": false, "recent": [], "tabs": [],
            "activeGroup": null, "pinnedPaths": []
        });
        let out = format_context(&f);
        assert!(out.contains("brainstorm canvas (2 items) — on screen:"), "{out}");
        assert!(out.contains("  - note \"TEST!!\" @ 620,180"), "{out}");
        assert!(out.contains("  - image \"shot.png\" @ 900,300"), "{out}");
        assert!(!out.contains("preview is closed"), "{out}");
    }

    #[test]
    fn brainstorm_empty_vs_absent() {
        // Empty canvas → "(empty)" line, still suppresses the closed-preview line.
        let empty = json!({
            "projectPath": "/p", "openFile": null, "browser": null,
            "brainstorm": {"count": 0, "items": []},
            "selection": [], "dirty": false, "recent": [], "tabs": [], "activeGroup": null, "pinnedPaths": []
        });
        let out = format_context(&empty);
        assert!(out.contains("brainstorm canvas: on screen (empty)"), "{out}");
        assert!(!out.contains("preview is closed"), "{out}");
        // Absent/null → no brainstorm line, closed-preview fallback stays.
        for b in [Value::Null, json!("nope"), json!(5)] {
            let f = json!({
                "projectPath": "/p", "openFile": null, "browser": null, "brainstorm": b,
                "selection": [], "dirty": false, "recent": [], "tabs": [], "activeGroup": null, "pinnedPaths": []
            });
            let out = format_context(&f);
            assert!(!out.contains("brainstorm canvas"), "unexpected canvas line: {out}");
            assert!(out.contains("preview is closed"), "{out}");
        }
    }

    #[test]
    fn tag_chain_picks_first_truthy_in_order() {
        // media wins over binary/tooBig/view
        let f = json!({
            "projectPath": "/p",
            "openFile": {"path": "/p/x", "media": "image", "binary": true, "tooBig": true, "view": "rendered"},
            "selection": [], "dirty": false, "recent": [], "tabs": [],
            "activeGroup": null, "pinnedPaths": []
        });
        assert!(format_context(&f).contains("open file: /p/x (image)"));

        // No media → binary wins, dirty appended
        let f = json!({
            "projectPath": "/p",
            "openFile": {"path": "/p/x", "media": null, "binary": true, "tooBig": true, "view": "rendered"},
            "selection": [], "dirty": true, "recent": [], "tabs": [],
            "activeGroup": null, "pinnedPaths": []
        });
        assert!(format_context(&f).contains("open file: /p/x (binary, unsaved edits)"));

        // No media/binary → tooBig wins
        let f = json!({
            "projectPath": "/p",
            "openFile": {"path": "/p/x", "media": null, "binary": false, "tooBig": true, "view": "rendered"},
            "selection": [], "dirty": false, "recent": [], "tabs": [],
            "activeGroup": null, "pinnedPaths": []
        });
        assert!(format_context(&f).contains("open file: /p/x (too big)"));
    }

    #[test]
    fn selection_filter_respects_open_file() {
        // openFile null → all selection entries survive
        let f = json!({
            "projectPath": "/p", "openFile": null, "dirty": false, "recent": [], "tabs": [],
            "activeGroup": null, "pinnedPaths": [],
            "selection": ["/p/a", "/p/b"]
        });
        assert!(format_context(&f).contains("selection: /p/a, /p/b"));

        // openFile set → its path filtered out
        let f = json!({
            "projectPath": "/p",
            "openFile": {"path": "/p/a"},
            "dirty": false, "recent": [], "tabs": [],
            "activeGroup": null, "pinnedPaths": [],
            "selection": ["/p/a", "/p/b"]
        });
        let out = format_context(&f);
        assert!(out.contains("selection: /p/b"));
        assert!(!out.contains("/p/a, /p/b"));
    }

    #[test]
    fn tabs_gating_matches_js_condition_exactly() {
        // 1 held + 1 ephemeral → show (held=1 AND tabs>1)
        let f = json!({
            "projectPath": "/p", "openFile": null, "selection": [], "dirty": false, "recent": [],
            "activeGroup": null, "pinnedPaths": [],
            "tabs": [
                {"path": "/p/a", "ephemeral": true, "active": true, "dirty": false},
                {"path": "/p/b", "ephemeral": false, "active": false, "dirty": false}
            ]
        });
        assert!(format_context(&f).contains("open tabs (held — do not disturb):"));

        // 1 held alone → hide
        let f = json!({
            "projectPath": "/p", "openFile": null, "selection": [], "dirty": false, "recent": [],
            "activeGroup": null, "pinnedPaths": [],
            "tabs": [
                {"path": "/p/b", "ephemeral": false, "active": false, "dirty": false}
            ]
        });
        assert!(!format_context(&f).contains("open tabs"));

        // 2 held (no ephemeral) → show
        let f = json!({
            "projectPath": "/p", "openFile": null, "selection": [], "dirty": false, "recent": [],
            "activeGroup": null, "pinnedPaths": [],
            "tabs": [
                {"path": "/p/a", "ephemeral": false, "active": true, "dirty": false},
                {"path": "/p/b", "ephemeral": false, "active": false, "dirty": false}
            ]
        });
        assert!(format_context(&f).contains("open tabs"));
    }

    #[test]
    fn recent_header_skipped_when_empty() {
        let f = json!({
            "projectPath": "/p", "openFile": null, "selection": [], "dirty": false,
            "tabs": [], "activeGroup": null, "pinnedPaths": [],
            "recent": []
        });
        assert!(!format_context(&f).contains("recent"));
    }

    #[test]
    fn is_http_url_detects_web_targets() {
        assert!(is_http_url("http://localhost:4317"));
        assert!(is_http_url("https://example.com/x"));
        assert!(is_http_url("HTTPS://EXAMPLE.COM")); // scheme is case-insensitive
        assert!(!is_http_url("/Users/a/file.md"));
        assert!(!is_http_url("./rel/path"));
        assert!(!is_http_url("ftp://host/x")); // only http(s)
        assert!(!is_http_url("httpfoo")); // no scheme separator
    }

    #[test]
    fn to_web_url_normalizes_bare_hosts_but_not_paths() {
        // Explicit URLs pass through verbatim.
        assert_eq!(to_web_url("http://localhost:4317").as_deref(), Some("http://localhost:4317"));
        assert_eq!(to_web_url("https://example.com/x").as_deref(), Some("https://example.com/x"));
        // Bare host:port a dev types → gets an http:// scheme.
        assert_eq!(to_web_url("localhost:3457").as_deref(), Some("http://localhost:3457"));
        assert_eq!(to_web_url("127.0.0.1:3000").as_deref(), Some("http://127.0.0.1:3000"));
        assert_eq!(to_web_url("localhost:3457/admin").as_deref(), Some("http://localhost:3457/admin"));
        assert_eq!(to_web_url("app.local:8080").as_deref(), Some("http://app.local:8080"));
        assert_eq!(to_web_url("localhost").as_deref(), Some("http://localhost"));
        // Filesystem paths stay paths (None → cwd resolution).
        assert_eq!(to_web_url("/Users/a/file.md"), None);
        assert_eq!(to_web_url("./rel/path"), None);
        assert_eq!(to_web_url("~/notes"), None);
        assert_eq!(to_web_url("notes.md"), None);   // name.ext, no port
        assert_eq!(to_web_url("src/app.ts"), None);
        assert_eq!(to_web_url("README"), None);     // bare word
        assert_eq!(to_web_url("a:b"), None);        // non-numeric port → path
    }

    #[test]
    fn normalize_matches_node_path_resolve() {
        assert_eq!(normalize(Path::new("/a/b/c")), PathBuf::from("/a/b/c"));
        assert_eq!(normalize(Path::new("/a/b/../c")), PathBuf::from("/a/c"));
        assert_eq!(normalize(Path::new("/a/b/./c")), PathBuf::from("/a/b/c"));
        assert_eq!(normalize(Path::new("/a/b/")), PathBuf::from("/a/b"));
        // leading `..` against root: dropped (node caps at "/")
        assert_eq!(normalize(Path::new("/a/../../c")), PathBuf::from("/c"));
        assert_eq!(normalize(Path::new("/")), PathBuf::from("/"));
    }
}
