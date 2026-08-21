// watcher.rs — recursive project watcher → `tree:changed` events.
//
// OWNER: watcher agent.
//
// Port of server.ts watchRoot (291–320) + the file_change logging filters
// (logFileChange, 206–214; selfWrites interplay, 85–97):
//
// ── Event emitted ───────────────────────────────────────────────────────────
//   `tree:changed` — payload: { "changed": ["/abs/path", ...] }
//   (the old SSE broadcast {kind:'tree', changed}; the kind moved into the
//   event name). The page refreshes the tree and live-reloads any open doc
//   whose path is in `changed`.
//
// ── Semantics reproduced ────────────────────────────────────────────────────
//   * One watcher at a time: start_watch on a new root REPLACES the previous
//     watcher (drop the old WatcherHandle out of state.watcher); same root +
//     live watcher → no-op (server.ts 298–299).
//   * Skip churn under node_modules/ and .git/ entirely (306) or every commit
//     spams a refresh. Faithful to server.ts: a SUBSTRING test on the path
//     relative to the watched root (`name.includes('node_modules'|'.git')`),
//     so e.g. `.github/` is also skipped, exactly as in Node.
//   * Burst-coalesce for the EVENT: collect touched absolute paths into a
//     pending set and debounce 200 ms (310–315) so a checkout touching
//     hundreds of files becomes one `tree:changed` with all paths. As in
//     server.ts, the emit is NOT self-write-filtered — pendingChanges.add()
//     ran unconditionally (309); only the LOG below is suppressed.
//   * file_change LOGGING (separate, per-path, leading-edge): a path is logged
//     to the action log as {action:"file_change", path, event} only if
//       (a) it was NOT just written by Spike itself —
//           state.was_self_write(path) (the 2 s suppression window;
//           fs_ops marks every save/create/rename/move/delete), and
//       (b) it's the FIRST event for that path in a 1 s burst window (log the
//           leading edge, swallow the rest — editors write several times per
//           save). server.ts changeSeen, 206–214: every event re-arms the
//           window, so suppression runs 1 s past the LAST event of a burst.
//   * Recursive-watch failure (unsupported fs) must not error the page: fall
//     back to "no watcher" silently (317–319) — manual refresh still works.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use notify::event::ModifyKind;
use notify::{EventKind, RecursiveMode, Watcher};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::AppState;

/// server.ts 311–315 — collapse a burst of fs events into one tree push.
const DEBOUNCE_MS: u64 = 200;
/// server.ts 213 — per-path leading-edge window for file_change logging.
const CHANGE_BURST_MS: u64 = 1_000;

/// The active watcher: the notify backend plus the root it watches. The
/// debounce thread hangs off the watcher's event channel, so dropping this
/// (closing the channel) stops the watch AND winds the thread down.
pub struct WatcherHandle {
    root: PathBuf,
    _watcher: notify::RecommendedWatcher,
}

/// (Re)point the recursive watcher at `root`. Called by the ipc shim on every
/// re-root, right after read_tree (the old GET /tree?root= did both).
///
/// Request: { root: "/abs/dir" } — must be an existing directory.
/// Response: Ok(()) (also Ok when recursive watching is unavailable — see
/// fallback note above). Err only on an invalid root.
#[tauri::command]
pub fn start_watch(
    app: AppHandle,
    state: State<'_, AppState>,
    root: String,
) -> Result<(), String> {
    let root_path = PathBuf::from(&root);
    // server.ts isDir (242–245): absolute + exists + directory, else 400.
    if !root_path.is_absolute() || !root_path.is_dir() {
        return Err("root must be an existing directory".into());
    }

    let mut guard = state.watcher.lock().unwrap();
    // Already watching this root with a live watcher → no-op (server.ts 298).
    if let Some(h) = guard.as_ref() {
        if h.root == root_path {
            return Ok(());
        }
    }
    // Replace: drop the old watcher first. Its event channel disconnects,
    // which exits its debounce thread (server.ts 299: watcher.close()).
    *guard = None;

    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = match notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    }) {
        Ok(w) => w,
        Err(e) => {
            // Fail soft (server.ts 317–319): no watcher, manual refresh works.
            eprintln!("spike: fs watcher unavailable: {e}");
            return Ok(());
        }
    };
    if let Err(e) = watcher.watch(&root_path, RecursiveMode::Recursive) {
        eprintln!(
            "spike: recursive watch failed for {}: {e}",
            root_path.display()
        );
        return Ok(());
    }

    // macOS reports events under the canonical root (/tmp → /private/tmp), so
    // keep both forms around for the relative-path computation.
    let canon_root = std::fs::canonicalize(&root_path).ok();
    let thread_app = app.clone();
    let thread_root = root_path.clone();
    std::thread::spawn(move || run_debounce(thread_app, thread_root, canon_root, rx));

    *guard = Some(WatcherHandle {
        root: root_path,
        _watcher: watcher,
    });
    Ok(())
}

/// The debounce loop: drain watcher events, filter, log leading edges, and
/// flush one `tree:changed` 200 ms after the burst goes quiet. Exits when the
/// watcher (the channel's sender) is dropped.
fn run_debounce(
    app: AppHandle,
    root: PathBuf,
    canon_root: Option<PathBuf>,
    rx: Receiver<notify::Result<notify::Event>>,
) {
    // Paths touched since the last push, in arrival order (server.ts
    // pendingChanges Set, 296).
    let mut pending: Vec<PathBuf> = Vec::new();
    let mut pending_seen: HashSet<PathBuf> = HashSet::new();
    // Per-path last-event time for the file_change leading edge (changeSeen).
    let mut last_seen: HashMap<PathBuf, Instant> = HashMap::new();

    loop {
        let received = if pending.is_empty() {
            // Nothing buffered — block until the next event (or shutdown).
            match rx.recv() {
                Ok(msg) => Some(msg),
                Err(_) => break, // watcher dropped
            }
        } else {
            // Buffered — the 200 ms timer re-arms on every event (server.ts
            // 310–311 clearTimeout/setTimeout), i.e. a trailing debounce.
            match rx.recv_timeout(Duration::from_millis(DEBOUNCE_MS)) {
                Ok(msg) => Some(msg),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => {
                    flush(&app, &mut pending, &mut pending_seen);
                    break;
                }
            }
        };

        match received {
            Some(Ok(event)) => {
                let Some(label) = event_label(&event.kind) else {
                    continue; // access-only noise fs.watch never reported
                };
                for abs in &event.paths {
                    let rel = rel_string(&root, canon_root.as_deref(), abs);
                    if skip_rel(&rel) {
                        continue;
                    }
                    // file_change log: suppress Spike's own write echoing back
                    // (server.ts 208–209), then log only the burst's leading
                    // edge (210–213). Self-writes don't touch the burst map.
                    let state = app.state::<AppState>();
                    if !state.was_self_write(abs) {
                        let in_burst = last_seen
                            .get(abs)
                            .map(|t| t.elapsed() < Duration::from_millis(CHANGE_BURST_MS))
                            .unwrap_or(false);
                        if !in_burst {
                            log_action(
                                "file_change",
                                json!({ "path": abs.to_string_lossy(), "event": label }),
                            );
                        }
                        last_seen.insert(abs.clone(), Instant::now());
                    }
                    // The EMIT is unconditional past the dir filter, matching
                    // server.ts 309 — self-writes still refresh the tree.
                    if pending_seen.insert(abs.clone()) {
                        pending.push(abs.clone());
                    }
                }
                // Keep the burst map bounded (server.ts timers self-delete).
                if last_seen.len() > 1024 {
                    let window = Duration::from_millis(CHANGE_BURST_MS);
                    last_seen.retain(|_, t| t.elapsed() < window);
                }
            }
            Some(Err(_)) => {} // backend hiccup — keep watching
            None => flush(&app, &mut pending, &mut pending_seen),
        }
    }
}

/// Push one `tree:changed` with everything buffered (server.ts 311–315).
fn flush(app: &AppHandle, pending: &mut Vec<PathBuf>, pending_seen: &mut HashSet<PathBuf>) {
    if pending.is_empty() {
        return;
    }
    let changed: Vec<String> = pending
        .drain(..)
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    pending_seen.clear();
    let _ = app.emit("tree:changed", json!({ "changed": changed }));
}

/// The path relative to the watched root — the string server.ts filtered on
/// (fs.watch hands Node a root-relative `name`). Falls back to the canonical
/// root (macOS symlinked roots), then to the full path.
fn rel_string(root: &Path, canon_root: Option<&Path>, abs: &Path) -> String {
    if let Ok(rel) = abs.strip_prefix(root) {
        return rel.to_string_lossy().into_owned();
    }
    if let Some(canon) = canon_root {
        if let Ok(rel) = abs.strip_prefix(canon) {
            return rel.to_string_lossy().into_owned();
        }
    }
    abs.to_string_lossy().into_owned()
}

/// server.ts 305–306: `if (!f || f.includes('node_modules') || f.includes('.git')) return`.
/// Substring semantics kept on purpose (also skips `.github`, `.gitignore` —
/// same churn class). Empty = an event on the root itself.
fn skip_rel(rel: &str) -> bool {
    rel.is_empty() || rel.contains("node_modules") || rel.contains(".git")
}

/// Map notify's event kinds onto fs.watch's two-value vocabulary so the
/// file_change log keeps the same `event` values ('rename' for create/
/// delete/rename, 'change' for content). None = drop (pure access events,
/// which fs.watch never surfaced).
fn event_label(kind: &EventKind) -> Option<&'static str> {
    match kind {
        EventKind::Access(_) => None,
        EventKind::Create(_) | EventKind::Remove(_) => Some("rename"),
        EventKind::Modify(ModifyKind::Name(_)) => Some("rename"),
        EventKind::Modify(_) => Some("change"),
        EventKind::Any | EventKind::Other => Some("change"),
    }
}

// ── action log (shared with cli_listener) ───────────────────────────────────
// Port of server.ts logEvent (75–83): one JSON line per event in
// ~/.spike/logs/<day>.jsonl, shaped { ts, action, ...payload }, gated on
// config logging.enabled, best-effort (never errors). The single
// implementation lives in fs_ops (it also backs the log_event command and the
// file_* mutation logs); re-exported here so watcher + cli_listener call sites
// keep their `watcher::log_action` spelling.
pub(crate) use crate::fs_ops::log_action;

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{AccessKind, CreateKind, DataChange, MetadataKind, RemoveKind, RenameMode};

    #[test]
    fn skips_node_modules_and_git_anywhere_in_the_rel_path() {
        assert!(skip_rel("node_modules"));
        assert!(skip_rel("node_modules/react/index.js"));
        assert!(skip_rel("packages/app/node_modules/x.js"));
        assert!(skip_rel(".git"));
        assert!(skip_rel(".git/objects/ab/cdef"));
        assert!(skip_rel("sub/.git/HEAD"));
    }

    #[test]
    fn keeps_server_ts_substring_quirk() {
        // server.ts used includes('.git'), which also catches these — kept.
        assert!(skip_rel(".github/workflows/ci.yml"));
        assert!(skip_rel(".gitignore"));
    }

    #[test]
    fn empty_rel_is_skipped() {
        // An event on the watched root itself (Node handed name=null → '').
        assert!(skip_rel(""));
    }

    #[test]
    fn ordinary_paths_pass() {
        assert!(!skip_rel("src/app.ts"));
        assert!(!skip_rel("docs/git-notes.md")); // 'git' alone is not '.git'
        assert!(!skip_rel("a/b/c.txt"));
    }

    #[test]
    fn event_labels_match_fs_watch_vocabulary() {
        assert_eq!(event_label(&EventKind::Create(CreateKind::File)), Some("rename"));
        assert_eq!(event_label(&EventKind::Remove(RemoveKind::File)), Some("rename"));
        assert_eq!(
            event_label(&EventKind::Modify(ModifyKind::Name(RenameMode::Any))),
            Some("rename")
        );
        assert_eq!(
            event_label(&EventKind::Modify(ModifyKind::Data(DataChange::Any))),
            Some("change")
        );
        assert_eq!(
            event_label(&EventKind::Modify(ModifyKind::Metadata(MetadataKind::Any))),
            Some("change")
        );
        assert_eq!(event_label(&EventKind::Any), Some("change"));
        assert_eq!(event_label(&EventKind::Access(AccessKind::Any)), None);
    }

    #[test]
    fn rel_string_strips_plain_and_canonical_roots() {
        let root = Path::new("/tmp/proj");
        let canon = Path::new("/private/tmp/proj");
        assert_eq!(
            rel_string(root, Some(canon), Path::new("/tmp/proj/src/a.ts")),
            "src/a.ts"
        );
        assert_eq!(
            rel_string(root, Some(canon), Path::new("/private/tmp/proj/src/a.ts")),
            "src/a.ts"
        );
        assert_eq!(rel_string(root, Some(canon), Path::new("/tmp/proj")), "");
    }
}
