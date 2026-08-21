// state.rs — shared app state + ~/.spike persistence helpers.
//
// OWNER: skeleton (shared). This file is the cross-module seam: the pty, fs_ops,
// watcher, and cli_listener agents all READ from here but should not need to
// restructure it. The small helpers at the bottom (spike_dir, last-root, the
// self-write ledger) are implemented for real so module agents never have to
// edit each other's files; everything domain-shaped lives in the owning module.
//
// Mirrors server.ts globals:
//   ptys          — the live PTY sessions, keyed by the frontend's session id
//                   (server.ts kept one pty per websocket; here it's one per id)
//   focus         — the page's last-reported focus (server.ts `currentFocus`,
//                   lines 339–349). Written by `set_focus`, read by the CLI
//                   listener's GET /context. Stored verbatim as JSON.
//   watcher       — the active recursive fs watcher (server.ts `watcher`/
//                   `watchedRoot`, 291–296). Re-watching a new root replaces it.
//   recent_writes — the self-write suppression ledger (server.ts `selfWrites`,
//                   93–97): paths Spike's own fs commands just wrote, so the
//                   watcher doesn't double-log them as external `file_change`s.
//                   Entries are valid for SELF_WRITE_WINDOW_MS; stale entries
//                   are pruned lazily on read/write.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// server.ts:96 — a self-write marker only needs to outlive the watcher echo.
pub const SELF_WRITE_WINDOW_MS: u64 = 2_000;

#[derive(Default)]
pub struct AppState {
    /// Live PTY sessions by frontend session id. PtyHandle is defined (and
    /// fleshed out) in pty.rs.
    pub ptys: Mutex<HashMap<String, crate::pty::PtyHandle>>,
    /// The page's current focus, exactly as POSTed by `set_focus` (the old
    /// POST /focus body — see cli_listener.rs for the shape). Starts as the
    /// empty-focus object equivalent; `Value::Null` until first report.
    pub focus: Mutex<serde_json::Value>,
    /// Active recursive watcher (None until start_watch). WatcherHandle is
    /// defined in watcher.rs; swapping in a new one drops (stops) the old.
    pub watcher: Mutex<Option<crate::watcher::WatcherHandle>>,
    /// Paths Spike itself just wrote → when. See mark_self_write / was_self_write.
    pub recent_writes: Mutex<HashMap<PathBuf, Instant>>,
    /// Append-only event log for agent-state events (file writes, tool calls,
    /// pause-on-question). Fed by `POST /agent-event` from per-engine
    /// adapters (Claude hook, future Codex sidecar). See agent_broker.rs.
    pub agent_broker: crate::agent_broker::AgentBroker,
    /// Resolved active-work context, keyed by "{repo_root}@{branch}". The branch
    /// is read fresh (cheap, local git) on every focus; this caches only the
    /// expensive `gh` lookup so it runs once per branch, not once per focus.
    pub auto_context: Mutex<HashMap<String, crate::auto_context::AutoContext>>,
    /// Permission decisions the UI has made, keyed by the hook's `prompt_id`.
    /// The inline approval flow: a blocked PreToolUse hook long-polls
    /// `GET /agent-permission?prompt_id=…` while the person picks Allow/Deny in
    /// the chat panel; that click writes the decision here (via the Tauri
    /// command or POST /agent-permission), the next poll reads it, and the hook
    /// unblocks. One-shot — a decision is consumed by the poll that reads it.
    /// Bounded + TTL-pruned so an unread decision (hook already timed out) can't
    /// accumulate. See resolve_permission / take_permission.
    pub permissions: Mutex<HashMap<String, PermDecision>>,
    /// The Company OS work store (workstore.rs), opened lazily on first use and
    /// held open for the process lifetime. `None` until something asks for it,
    /// so a user who never touches the feature never creates the database.
    /// Held behind the same Mutex that serializes its writes — see
    /// workstore::with_db.
    pub work: Mutex<Option<rusqlite::Connection>>,
    /// The current zoom-aware traffic-light y-inset (macOS). set_traffic_lights_zoom
    /// writes it on every zoom change; the native resize handler in lib.rs reads it
    /// to re-pin the dots synchronously after macOS resets them on resize — no JS
    /// round-trip, so no flicker. `0.0` is the 1x default (see 16.0 seed at setup).
    pub traffic_light_y: Mutex<f32>,
}

/// A permission decision waiting for its hook to read it. `at` drives TTL
/// pruning; `decision` is the option id the UI chose ("allow_once" |
/// "allow_session" | "deny").
pub struct PermDecision {
    pub decision: String,
    pub at: Instant,
}

/// A decision older than this was almost certainly for a prompt whose hook has
/// already timed out and given up; drop it rather than answer a stale call.
const PERM_TTL_MS: u64 = 5 * 60_000;
/// Hard cap on pending decisions, so a storm of unread answers can't grow the
/// map without bound. Far above any real concurrency.
const PERM_MAX: usize = 256;

impl AppState {
    /// Record that Spike's own UI just wrote `path` (save/create/rename/move/
    /// delete), so the watcher suppresses the echoing `file_change` log.
    /// server.ts markSelfWrite (94–97).
    pub fn mark_self_write(&self, path: &std::path::Path) {
        let mut map = self.recent_writes.lock().unwrap();
        let now = Instant::now();
        map.retain(|_, t| now.duration_since(*t) < Duration::from_millis(SELF_WRITE_WINDOW_MS));
        map.insert(path.to_path_buf(), now);
    }

    /// Was `path` written by Spike inside the suppression window?
    /// server.ts logFileChange's leading check (208–209).
    pub fn was_self_write(&self, path: &std::path::Path) -> bool {
        let map = self.recent_writes.lock().unwrap();
        map.get(path)
            .map(|t| t.elapsed() < Duration::from_millis(SELF_WRITE_WINDOW_MS))
            .unwrap_or(false)
    }

    /// Record the UI's decision for a pending permission prompt, so the blocked
    /// hook's next poll can read it. Prunes stale entries first; if the map is
    /// still at the cap (a pathological backlog of unread decisions), the oldest
    /// is evicted so a live prompt is never rejected.
    pub fn resolve_permission(&self, prompt_id: &str, decision: &str) {
        let mut map = self.permissions.lock().unwrap();
        let now = Instant::now();
        map.retain(|_, d| now.duration_since(d.at) < Duration::from_millis(PERM_TTL_MS));
        if map.len() >= PERM_MAX {
            if let Some(oldest) = map.iter().min_by_key(|(_, d)| d.at).map(|(k, _)| k.clone()) {
                map.remove(&oldest);
            }
        }
        map.insert(prompt_id.to_string(), PermDecision { decision: decision.to_string(), at: now });
    }

    /// Read and consume a permission decision, if the UI has made one. Returns
    /// None while the prompt is still pending (the hook keeps polling). One-shot:
    /// the decision is removed, so a second poll for the same id sees nothing.
    pub fn take_permission(&self, prompt_id: &str) -> Option<String> {
        let mut map = self.permissions.lock().unwrap();
        let now = Instant::now();
        map.retain(|_, d| now.duration_since(d.at) < Duration::from_millis(PERM_TTL_MS));
        map.remove(prompt_id).map(|d| d.decision)
    }
}

/// `~/.spike` — per-user state dir (server.ts STATE_DIR, line 54). Created on
/// first use. Holds state.json, config.json, logs/, groups/.
pub fn spike_dir() -> PathBuf {
    let dir = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/"))
        .join(".spike");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// `~/.spike/state.json` (server.ts STATE_FILE). Shape: `{ "lastRoot": "/abs/path" }`.
pub fn state_file() -> PathBuf {
    spike_dir().join("state.json")
}

/// Read state.json's lastRoot. Missing/corrupt file → None (server.ts readState).
/// Existence/dir-ness of the path is the CALLER's check (get_last_root does it).
pub fn read_last_root() -> Option<String> {
    let raw = std::fs::read_to_string(state_file()).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("lastRoot")?.as_str().map(|s| s.to_string())
}

/// Merge `{ lastRoot }` into state.json, preserving any other keys
/// (server.ts writeState, 60–65). Best-effort: errors are swallowed.
pub fn write_last_root(root: &str) {
    let mut v: serde_json::Value = std::fs::read_to_string(state_file())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(obj) = v.as_object_mut() {
        obj.insert("lastRoot".into(), serde_json::Value::String(root.to_string()));
    }
    if let Ok(s) = serde_json::to_string_pretty(&v) {
        let _ = std::fs::write(state_file(), s);
    }
}
