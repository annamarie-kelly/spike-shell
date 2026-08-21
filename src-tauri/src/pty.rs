// pty.rs — terminal sessions over portable-pty.
//
// OWNER: pty agent.
//
// Port of server.ts WS PTY handling (spawnInto + wss.on('connection'),
// lines 643–755). The websocket protocol becomes: one `pty_spawn` per session
// id, then `pty_write`/`pty_resize`/`pty_kill` invokes, with output flowing
// back over an IPC channel.
//
// ── Output / exit delivery ───────────────────────────────────────────────────
//   output — sent through the `on_out: Channel<String>` passed to `pty_spawn`
//            (old WS message {t:'out', d}). A channel, not an event: Tauri's
//            recommended stream mechanism — ordered, per-session by
//            construction, and without per-chunk event-name routing + JSON
//            envelope overhead on the hot path.
//   `pty:exit:{id}` — event, payload: i32 exit code (old WS {t:'exit', code}).
//            Fires once per session, so event overhead is irrelevant there.
//
// ── Repo-dir resolution (shims/ + bin/ on PATH) ──────────────────────────────
// In Node these were `__dirname/..`-relative (server.ts ROOT, line 20). A Tauri
// binary has no __dirname, so `repo_root()` tries, in order:
//   1. $SPIKE_REPO_DIR — explicit override, wins always (set it when running a
//      bundled .app against a checkout).
//   2. The Tauri resource dir — only pays off once tauri.conf.json bundles
//      `../shims` + `../bin` as resources (it doesn't yet; harmless until then).
//   3. env!("CARGO_MANIFEST_DIR")/.. — compile-time path of src-tauri/, so the
//      dev build (`tauri dev` from this checkout) finds the repo with zero setup.
//   4. Ancestors of the running executable — covers target/debug deep paths and
//      any future layout where the binary lives inside the repo.
// First candidate that actually contains a `shims/` dir wins. If none match,
// the two prepends are skipped and PATH still resolves the real `claude` from
// ~/.local/bin etc. — the pane works, it just loses prompt injection and the
// in-terminal `spike` CLI (graceful degradation, never a spawn failure).

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::AppState;

/// Base system prompt injected into every embedded Claude session via
/// $SPIKE_SYSTEM_PROMPT (shims/claude appends it with --append-system-prompt).
/// Verbatim copy of server.ts SPIKE_SYSTEM_PROMPT (lines 33–41) — that file is
/// retired once Tauri reaches parity, at which point this is the single source.
///
/// Engine seam: the *content* is engine-neutral (teaches about `spike open` /
/// `spike context`, which work for any CLI agent that can run shell commands).
/// The *delivery* is engine-specific — Claude takes the flag, Codex reads
/// $CODEX_HOME/AGENTS.md. A future Engine enum would split delivery here.
const SPIKE_SYSTEM_PROMPT: &str = "You are running inside Spike, a shell with a live file preview/editor panel next to this terminal. \
When the user asks you to open, show, view, preview, render, or display a file, folder, or web page, run the \
shell command `spike open <target>` — a path displays the file in Spike's preview panel (or re-roots the tree \
to a folder); an http(s) URL or a bare `host:port` like `localhost:3457` opens live in the preview panel's browser. \
Prefer `spike open` over summarizing the file back to the user or launching an external app; \
do NOT use `open`, `cursor`, or `code` to show a file or URL to the user, and do NOT tell the user to open a \
URL in their own browser — `spike open` renders it in the panel. \
To see what the user is currently looking at — the file open in the preview, the tree selection, the project \
root, and recently opened files — run `spike context`. Use it to resolve references like \"this file\", \"what \
I'm looking at\", or \"the open file\" without asking; it prints paths, so read the file yourself if you need its contents. \
When your task is to REVIEW another agent's work, end your final message with a fenced code block tagged \
`spike-findings` holding a JSON array — one object per issue, {\"file\",\"line\",\"claim\",\"severity\",\"suggestion\"} \
where severity is \"blocker\" | \"warn\" | \"nit\" and file/line/suggestion are optional. Emit the block only if you \
found issues, and re-emit the whole array if you revise it. This lets Spike carry your findings to the coding agent \
and track each to resolution. Outside a review, do not emit the block. \
Never announce or name the underlying AI model or CLI you run on: do not introduce yourself as \"Claude\", \
\"Claude Code\", or any product/vendor name, and do not open a reply with a self-introduction. You are simply \
the assistant working inside Spike — when asked who you are, say that. Lead with the user's task, not a preamble about yourself.";

/// The base system prompt. We deliberately DON'T steer delegation here: Claude
/// uses its own native Task/Agent subagents (which report back to the lead and
/// bubble questions up on their own), and Spike visualizes those from the
/// on-disk `subagents/` dir (see usage::agent_subagents). The `is_subagent` param
/// is retained on the spawn commands for a possible future role split, but adds
/// nothing today — a plain, un-nudged agent is exactly what Path B wants.
fn base_prompt(_is_subagent: bool) -> String {
    SPIKE_SYSTEM_PROMPT.to_string()
}

/// Distinguishes a session from its same-id replacement: the reader thread of
/// a killed/replaced pty must not remove the NEW handle from state when its
/// own (old) stream hits EOF. Monotonic, process-wide.
static SPAWN_GEN: AtomicU64 = AtomicU64::new(0);

/// A live PTY session.
pub struct PtyHandle {
    /// Write side of the master (xterm keystrokes → child).
    writer: Box<dyn Write + Send>,
    /// Kills the child without needing the child handle (which the reader
    /// thread owns so it can wait() for the exit code).
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// Master side, kept for resize(). Dropping it (kill / replace) also makes
    /// the reader thread's stream end, so the thread always unwinds.
    master: Box<dyn MasterPty + Send>,
    /// This session's SPAWN_GEN token (see above).
    generation: u64,
    /// The workspace this session spawned into (auto-worktree counts live
    /// agents per workspace through this).
    group: Option<String>,
    /// The auto-created worktree backing this session, if any — the
    /// tab → worktree → branch mapping the close policy consumes.
    worktree: Option<crate::worktree::WorktreeInfo>,
    /// The dir the agent actually launched in (worktree path when isolation
    /// kicked in, else the requested cwd). Recorded so a handoff can resolve a
    /// source lane's authoritative cwd from backend state — `pty_spawn` used to
    /// only return this to the frontend.
    pub effective_cwd: String,
    /// The engine id this lane hosts ("claude" | "codex" | "shell" | custom).
    /// A handoff reads it to know whether the source is a briefable agent.
    pub engine_id: String,
}

// ── engine selection ─────────────────────────────────────────────────────────

/// Which CLI agent a tab is hosting. Shell is a plain interactive terminal;
/// Custom preserves the legacy escape hatch where an arbitrary SPIKE_CMD ran
/// verbatim (server.ts pinned this behavior — keep it reachable).
///
/// New engines slot in here. The launcher (src/web/app.ts) and Settings each
/// map a string id to one of these variants via `from_cmd`. The asymmetric
/// delivery of the system prompt (Claude's --append-system-prompt flag vs
/// Codex's $CODEX_HOME/AGENTS.md write) lives in the shims, NOT here — this
/// enum stays small.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Engine {
    Claude,
    Codex,
    Shell,
    Custom(String),
}

impl Engine {
    /// Resolve the cmd string from the frontend (or the SPIKE_CMD default when
    /// the frontend passes None). Anything not in the known set is treated as
    /// a Custom command — that's the pinned contract.
    fn from_cmd(cmd: Option<&str>, default_cmd: &str) -> Self {
        let raw = cmd.unwrap_or(default_cmd);
        match raw {
            "claude" => Self::Claude,
            "codex" => Self::Codex,
            "shell" => Self::Shell,
            other => Self::Custom(other.to_string()),
        }
    }

    /// Stable id string recorded on the PtyHandle. Custom keeps its raw command
    /// so a handoff can still show what the source was.
    fn id(&self) -> String {
        match self {
            Self::Claude => "claude".into(),
            Self::Codex => "codex".into(),
            Self::Shell => "shell".into(),
            Self::Custom(c) => c.clone(),
        }
    }

    /// Whether this engine can consume `$SPIKE_SYSTEM_PROMPT` — i.e. is a valid
    /// *handoff target*. A plain shell cannot, so it is never in the picker
    /// (§5 of the handoff plan). Custom commands are not assumed briefable.
    fn accepts_handoff_context(&self) -> bool {
        matches!(self, Self::Claude | Self::Codex)
    }
}

/// Per-tab CODEX_HOME path. Codex's session init reads AGENTS.md from this dir
/// and stores its full state (auth.json, sessions, sqlite) there too; the
/// shim symlinks ~/.codex/auth.json in so the user's login carries through.
fn codex_home_dir(spawn_id: &str) -> PathBuf {
    home_dir().join(".spike").join("codex-homes").join(spawn_id)
}

// ── env assembly helpers ─────────────────────────────────────────────────────

fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

/// Locate the spike repo checkout (for shims/ + bin/). See module header for
/// the resolution order. None → no checkout found, skip the PATH prepends.
fn repo_root(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = std::env::var("SPIKE_REPO_DIR") {
        if !dir.trim().is_empty() {
            candidates.push(PathBuf::from(dir));
        }
    }
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir);
    }
    // src-tauri/.. at compile time = the repo root of this checkout (dev builds).
    if let Some(dir) = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent() {
        candidates.push(dir.to_path_buf());
    }
    // Walk up from the executable (target/debug/spike → ... → repo root).
    if let Ok(exe) = std::env::current_exe() {
        for dir in exe.ancestors().skip(1) {
            candidates.push(dir.to_path_buf());
        }
    }
    candidates.into_iter().find(|c| c.join("shims").is_dir())
}

/// server.ts PATH rebuild (650–656): the app process may not have inherited the
/// login PATH, so `claude` (~/.local/bin) isn't found. shims/ first so its
/// claude wrapper (system-prompt injection) wins inside Spike; bin/ next so
/// `spike open` / `spike context` resolve in the embedded terminal.
fn build_path(repo: Option<&PathBuf>) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(root) = repo {
        parts.push(root.join("shims").to_string_lossy().into_owned());
        parts.push(root.join("bin").to_string_lossy().into_owned());
    }
    parts.push(home_dir().join(".local/bin").to_string_lossy().into_owned());
    for p in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
        parts.push(p.to_string());
    }
    parts.push(std::env::var("PATH").unwrap_or_default());
    parts.join(":")
}

/// server.ts sanitizeGroupName (169–171): filesystem-safe slug for a group's
/// on-disk filename. Runs of anything outside [A-Za-z0-9_.-] fold to one '-';
/// leading/trailing '-' trimmed; empty → "group" (never a dotfile).
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
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() { "group".to_string() } else { trimmed.to_string() }
}

/// server.ts readGroupMd (202–204): the group's assembled .md prompt, for
/// injection at spawn. Empty for an unknown or promptless group.
fn read_group_md(name: &str) -> String {
    let path = crate::state::spike_dir()
        .join("groups")
        .join(format!("{}.md", sanitize_group_name(name)));
    std::fs::read_to_string(path).unwrap_or_default()
}

/// Settings → Spawn Defaults shell override (server.ts activeConfig().
/// spawnDefaults.shell, line 689). Read straight from ~/.spike/config.json:
/// fs_ops owns the resolved-config command surface, but the raw read is cheap
/// and keeps this module self-contained (and it runs once per spawn, not hot).
fn config_shell_override() -> Option<String> {
    let raw = std::fs::read_to_string(crate::state::spike_dir().join("config.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let s = v.get("spawnDefaults")?.get("shell")?.as_str()?.trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// Settings → Agent Defaults "spawn prompt append": free-form text appended to
/// every spawn's system prompt, AFTER any workspace context. Same raw-read
/// rationale as config_shell_override. Missing/blank → None (append nothing).
fn config_spawn_prompt_append() -> Option<String> {
    let raw = std::fs::read_to_string(crate::state::spike_dir().join("config.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let s = v.get("spawnPromptAppend")?.as_str()?.trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// A workspace's isolation mode from ~/.spike/groups/<slug>.json.
/// Missing file / field / unknown value → "shared" (reader defaults).
/// The legacy `worktreePath` field is parsed harmlessly along with the rest
/// of the JSON but no longer affects the spawn — the isolation model
/// supersedes the manual-path escape hatch.
fn read_group_isolation(name: &str) -> String {
    let path = crate::state::spike_dir()
        .join("groups")
        .join(format!("{}.json", sanitize_group_name(name)));
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get("isolation").and_then(|s| s.as_str()).map(str::to_string))
        .filter(|s| s == "auto-worktree")
        .unwrap_or_else(|| "shared".to_string())
}

/// Compose the per-spawn system prompt: base + the global spawn-prompt append
/// + workspace context + (optional) handoff snapshot, in that order, blank
/// parts skipped. Pure, so the ordering contract is testable.
///
/// The handoff bundle comes LAST, after base/global/workspace, because it is
/// read-only *snapshot data* (what the source lane was doing), not
/// higher-priority policy — the assembler already fences and labels it as such
/// (see handoff.rs). Passing "" for `handoff` reproduces the pre-handoff spawn.
fn compose_system_prompt(base: &str, group_md: &str, append: &str, handoff: &str) -> String {
    [base, append, group_md, handoff]
        .iter()
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

// ── UTF-8 stream decoding ────────────────────────────────────────────────────
// A pty is a byte stream: a 32 KiB read can end mid-way through a multi-byte
// UTF-8 sequence (a box-drawing `─` is 3 bytes), and decoding each chunk
// independently turns every split sequence into U+FFFD on screen. The decoder
// holds back a trailing incomplete sequence (at most 3 bytes) and prepends it
// to the next read, so only genuinely invalid bytes ever decode lossily.

/// Index of the first byte of a trailing *incomplete-but-completable* UTF-8
/// sequence in `bytes`, or `bytes.len()` when the buffer ends on a sequence
/// boundary. Scans at most the last 3 bytes — a UTF-8 sequence is 1–4 bytes,
/// so an incomplete tail is at most 3. Invalid tails (stray continuation
/// bytes with no lead, over-long runs) return `len`: they can never complete,
/// so they fall through to a lossy decode instead of being carried.
fn utf8_carry_start(bytes: &[u8]) -> usize {
    let len = bytes.len();
    for i in (len.saturating_sub(3)..len).rev() {
        let b = bytes[i];
        if b < 0x80 {
            return len; // ASCII — nothing dangling past it but continuations (invalid)
        }
        if b < 0xC0 {
            continue; // continuation byte — keep scanning back for its lead
        }
        // Lead byte: sequence length it announces.
        let need = if b >= 0xF0 { 4 } else if b >= 0xE0 { 3 } else { 2 };
        return if i + need > len { i } else { len };
    }
    len
}

/// A UTF-8 `LANG` value for spawned ptys, or `None` when the inherited env
/// already names a UTF-8 locale (don't clobber a deliberate setting). Cached:
/// the region and installed-locale lookups shell out, and neither changes over
/// a session. Value tracks the user's macOS region when that locale is
/// installed, else falls back to the always-present `en_US.UTF-8`.
fn utf8_lang() -> Option<String> {
    static CACHE: OnceLock<Option<String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let names_utf8 = |k: &str| {
                std::env::var(k)
                    .map(|v| v.to_ascii_lowercase().replace('-', "").contains("utf8"))
                    .unwrap_or(false)
            };
            if names_utf8("LC_ALL") || names_utf8("LC_CTYPE") || names_utf8("LANG") {
                return None;
            }
            Some(region_utf8_locale())
        })
        .clone()
}

/// The user's macOS region as a UTF-8 POSIX locale (e.g. `de_DE.UTF-8`), or
/// `en_US.UTF-8` when the region can't be read or its locale isn't installed.
fn region_utf8_locale() -> String {
    const FALLBACK: &str = "en_US.UTF-8";
    // AppleLocale is `lang_REGION` with an optional script/keyword tail, e.g.
    // `en_US`, `zh_Hans_CN@calendar=gregorian`. POSIX locales have no script
    // tag, so keep just the first and last `_`-parts: `zh_Hans_CN` → `zh_CN`.
    let apple = std::process::Command::new("defaults")
        .args(["read", "-g", "AppleLocale"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok());
    let Some(apple) = apple else { return FALLBACK.into() };
    let core = apple.trim().split('@').next().unwrap_or("").trim();
    let parts: Vec<&str> = core.split('_').filter(|s| !s.is_empty()).collect();
    let candidate = match parts.as_slice() {
        [lang, .., region] => format!("{lang}_{region}.UTF-8"),
        _ => return FALLBACK.into(),
    };
    if locale_installed(&candidate) {
        candidate
    } else {
        FALLBACK.into()
    }
}

/// Whether `locale -a` lists `loc` (case/`-`-insensitive, so `en_US.UTF-8`
/// matches `en_US.utf8`). A locale absent from the system makes `setlocale`
/// fail and tools warn, so we only set one we've confirmed exists.
fn locale_installed(loc: &str) -> bool {
    let norm = |s: &str| s.to_ascii_lowercase().replace('-', "");
    std::process::Command::new("locale")
        .arg("-a")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|list| {
            let want = norm(loc);
            list.lines().any(|l| norm(l.trim()) == want)
        })
        .unwrap_or(false)
}

/// Streaming UTF-8 decoder with a carry buffer for sequences split across
/// reads. Pure (no I/O) so the boundary logic is unit-testable.
pub struct Utf8StreamDecoder {
    /// Trailing incomplete sequence from the previous `push` — at most 3
    /// bytes, by construction (`utf8_carry_start` never holds back more).
    carry: Vec<u8>,
}

impl Utf8StreamDecoder {
    pub fn new() -> Self {
        Self { carry: Vec::new() }
    }

    /// Decode `chunk`, prepending bytes held back by the previous call.
    /// Held-back bytes either complete here, stay carried while still
    /// completable (≤ 3 bytes, never unbounded), or — once provably invalid
    /// (followed by a non-continuation) — flush lossily in this same call.
    /// May return an empty string (chunk ended exactly mid-sequence).
    pub fn push(&mut self, chunk: &[u8]) -> String {
        self.carry.extend_from_slice(chunk);
        let boundary = utf8_carry_start(&self.carry);
        let out = String::from_utf8_lossy(&self.carry[..boundary]).into_owned();
        self.carry.drain(..boundary);
        out
    }

    /// EOF: nothing will ever complete the carry — flush it lossily.
    pub fn finish(&mut self) -> String {
        let out = String::from_utf8_lossy(&self.carry).into_owned();
        self.carry.clear();
        out
    }
}

/// Spawn a new PTY session.
///
/// Replaces: WS connect + `{t:'init', cwd, theme, cmd, group}` (server.ts
/// 723–754) and spawnInto (660–721).
///
/// Request (invoke args):
///   id    — frontend-chosen session id; keys all later calls and the event names
///   cwd   — absolute dir to spawn in (validated; bad/missing → default cwd)
///   cols, rows — initial size (old protocol sized via a first resize; here
///                the size rides on spawn so the first paint is right)
///   theme — Some("light") | Some("dark") | None → COLORFGBG (None = dark)
///   cmd   — Some("claude") | Some("shell") | None (None → SPIKE_CMD default,
///           i.e. claude). The old WS `?cmd=` / init `cmd` field.
///   group — workspace name whose assembled .md prompt is appended to
///           SPIKE_SYSTEM_PROMPT at spawn (old WS `?group=` / init `group`).
///   on_out — IPC channel (constructed JS-side, passed as an invoke arg) that
///            the reader thread streams decoded output chunks through.
///
/// Re-spawning a live id kills and replaces the old session — the WS analogue
/// was a fresh connection per pane, whose ws.close killed the old pty.
///
/// Response: Ok(effective_cwd) once the PTY is live (output then streams over
/// `on_out`) — the dir the agent actually launched in, which is the isolated
/// worktree path when auto-worktree kicked in, else the requested cwd. The
/// frontend resolves its branch/PR badge from this so an isolated lane reads
/// its own branch, not the main checkout's. Err(message) on spawn failure.
#[tauri::command]
// async so process-spawn + (auto-worktree) git work runs on the tokio runtime,
// not the main thread — a sync command here froze the window on the first
// message. Body is unchanged blocking work; async just keeps it off the UI thread.
pub async fn pty_spawn(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    theme: Option<String>,
    cmd: Option<String>,
    group: Option<String>,
    agent_session_id: Option<String>,
    resume: Option<bool>,
    subagent: Option<bool>,
    on_out: Channel<String>,
) -> Result<String, String> {
    // Same id already live → kill + replace (drop the old handle outside the
    // lock; its reader thread sees EOF, and the generation guard keeps it from
    // evicting the handle we're about to insert).
    let old = state.ptys.lock().unwrap().remove(&id);
    if let Some(mut old) = old {
        let _ = old.killer.kill();
        // a replaced worktree-backed session still settles its worktree
        if let Some(info) = old.worktree.take() {
            apply_close_policy_async(app.clone(), info);
        }
    }

    // cwd: an existing absolute dir, else SPIKE_CWD, else home (server.ts CWD,
    // line 23 + the isDir() check at the spawn sites, 737/744).
    let cwd_path = PathBuf::from(&cwd);
    let mut cwd_path = if cwd_path.is_absolute() && cwd_path.is_dir() {
        cwd_path
    } else {
        match std::env::var("SPIKE_CWD") {
            Ok(p) if PathBuf::from(&p).is_dir() => PathBuf::from(p),
            _ => home_dir(),
        }
    };

    // Auto-worktree isolation (settings-v2): in an `isolation: "auto-worktree"`
    // workspace, the FIRST agent uses the main checkout; each additional
    // concurrent agent spawns into a freshly created git worktree on a new
    // branch under the configured location. Spike launches claude through a
    // shell (no per-spawn CLI flags), so the working directory IS the
    // isolation mechanism. Every failure degrades to the shared checkout with
    // a one-line terminal warning — worktree trouble never blocks a tab.
    let mut worktree_info: Option<crate::worktree::WorktreeInfo> = None;
    if let Some(gname) = group.as_deref() {
        if read_group_isolation(gname) == "auto-worktree" {
            match crate::worktree::repo_root(&cwd_path) {
                None => {
                    // set in the file but the cwd isn't a repo (the UI disables
                    // this combination; files can be edited by hand)
                    let _ = on_out.send(
                        "\r\n\x1b[33mspike: this workspace is set to auto-worktree, but its working \
                         directory is not a git repository — spawning shared.\x1b[0m\r\n".to_string(),
                    );
                }
                Some(repo) => {
                    let live = state
                        .ptys
                        .lock()
                        .unwrap()
                        .values()
                        .filter(|h| h.group.as_deref() == Some(gname))
                        .count();
                    if crate::worktree::should_isolate("auto-worktree", true, live) {
                        let cfg = crate::fs_ops::read_config_resolved();
                        let location = cfg["worktree"]["location"].as_str().unwrap_or(".spike/worktrees/").to_string();
                        let prefix = cfg["worktree"]["branchPrefix"].as_str().unwrap_or("spike/wt-").to_string();
                        match crate::worktree::prepare_worktree(&repo, &location, &prefix, gname) {
                            Ok(info) => {
                                let _ = on_out.send(format!(
                                    "\r\n\x1b[90mspike: isolated worktree — branch {} at {}\x1b[0m\r\n",
                                    info.branch, info.path
                                ));
                                crate::fs_ops::log_action(
                                    "worktree_create",
                                    serde_json::json!({ "group": gname, "branch": info.branch, "path": info.path }),
                                );
                                cwd_path = PathBuf::from(&info.path);
                                worktree_info = Some(info);
                            }
                            Err(e) => {
                                let _ = on_out.send(format!(
                                    "\r\n\x1b[33mspike: could not create a worktree ({e}) — \
                                     spawning in the main checkout.\x1b[0m\r\n"
                                ));
                                crate::fs_ops::log_action(
                                    "worktree_create_failed",
                                    serde_json::json!({ "group": gname, "error": e }),
                                );
                            }
                        }
                    }
                }
            }
        }
    }
    // Per-spawn system prompt. compose_system_prompt joins, in order:
    //   base + global Settings "spawn prompt append" + this tab's group
    //   workspace prompt + (handoff snapshot — empty for a plain spawn). The
    //   append comes BEFORE the workspace .md — see compose_system_prompt + its
    //   test, and the settings preview (assembleContext) which mirrors this order.
    // Bound HERE, at spawn, because a live pty's env can't change afterward —
    // regrouping a running tab can't retarget its agent. (server.ts 665–671)
    // effective_cwd + COLORFGBG now live in spawn_core (shared with the handoff
    // spawn), computed just before the PTY opens.
    let group_md = group.as_deref().map(read_group_md).unwrap_or_default();
    let prompt_append = config_spawn_prompt_append().unwrap_or_default();
    let system_prompt =
        compose_system_prompt(&base_prompt(subagent.unwrap_or(false)), &group_md, &prompt_append, "");

    // Engine selection. The `cmd` arg comes from the webview, which is NOT a
    // trusted input: a stored-XSS payload in a previewed file could call
    // pty_spawn. So the frontend may only PICK a known engine — an unknown
    // string is never run as an arbitrary binary; it degrades to the default.
    // The default itself comes from SPIKE_CMD (env, developer-controlled, not
    // webview-reachable) and may still be a Custom command — the pinned escape
    // hatch stays, just no longer drivable from the page.
    let default_cmd = std::env::var("SPIKE_CMD").unwrap_or_else(|_| "claude".to_string());
    let engine = match cmd.as_deref() {
        Some("claude") => Engine::Claude,
        Some("codex") => Engine::Codex,
        Some("shell") => Engine::Shell,
        Some(other) => {
            eprintln!(
                "spike: ignoring unknown engine '{other}' requested by the UI; \
                 using the configured default"
            );
            Engine::from_cmd(None, &default_cmd)
        }
        None => Engine::from_cmd(None, &default_cmd),
    };

    spawn_core(
        app, &state, id, cwd_path, cols, rows, theme, engine, group, system_prompt,
        worktree_info, agent_conv(agent_session_id, resume.unwrap_or(false)), on_out,
    )
}

/// The `claude` invocation for a lane, given the conversation it owns.
///
/// Spike mints the session id rather than letting Claude Code pick one, because
/// the id IS the transcript filename — owning it up front is what lets a lane
/// read its own context occupancy from the moment it spawns (instead of guessing
/// from the cwd) and what makes restore able to pick the same conversation back
/// up. The two flags are mutually exclusive:
///
///   • `--resume <id>` — continue that conversation, appending to the same
///     transcript under the same id (no fork; `--fork-session` would change it).
///   • `--session-id <id>` — start a NEW conversation under an id we chose.
///
/// Picking wrong is fatal, not cosmetic: `--session-id` on an id already on disk
/// errors with "Session ID … is already in use", and `--resume` on a missing one
/// errors too. Either way the `;` in the launcher drops the user into a bare
/// shell. So resume is downgraded to a fresh start when the transcript isn't
/// there — the conversation is gone (deleted, or never persisted), but the lane
/// still comes up live and keeps its id.
fn claude_launch(conv: Option<&AgentConv>) -> String {
    let Some(conv) = conv else { return "claude".to_string() };
    if conv.resume && crate::usage::claude_transcript_exists(&conv.id) {
        format!("claude --resume {}", conv.id)
    } else {
        format!("claude --session-id {}", conv.id)
    }
}

/// A Claude conversation this lane owns: the session id Spike minted for it, and
/// whether we're picking that conversation back up (`--resume`) or starting it
/// (`--session-id`). `None` = let the engine choose its own id, which is what
/// every non-Claude engine does.
#[derive(Clone, Debug, PartialEq)]
pub struct AgentConv {
    pub id: String,
    pub resume: bool,
}

/// Validate a frontend-supplied session id into an `AgentConv`.
///
/// The id is interpolated into a `<shell> -c "…"` string, and the webview is not
/// a trusted input (see the engine-selection note in `pty_spawn`) — so this is a
/// whitelist, not an escape: UUID charset only, exact UUID length. Anything else
/// is dropped and the lane spawns a plain `claude`, which is degraded (no ring
/// until the first turn) but never injected.
fn agent_conv(id: Option<String>, resume: bool) -> Option<AgentConv> {
    let id = id?;
    let ok = id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
    if !ok {
        eprintln!("spike: ignoring malformed agent session id from the UI");
        return None;
    }
    Some(AgentConv { id, resume })
}

/// The shared spawn tail: given a fully-resolved cwd, engine, and composed
/// system prompt, open the PTY, launch the engine, wire the reader thread, and
/// register the `PtyHandle` (recording `effective_cwd` + engine id so a later
/// handoff can resolve this lane's authoritative state). Both `pty_spawn` and
/// `pty_handoff_spawn` funnel through here so the launcher contract is single-
/// sourced. On openpty/spawn failure returns `Err` WITHOUT consuming
/// `worktree_info` cleanup — the caller owns that (handoff cleans its fork).
#[allow(clippy::too_many_arguments)]
fn spawn_core(
    app: AppHandle,
    state: &AppState,
    id: String,
    cwd_path: PathBuf,
    cols: u16,
    rows: u16,
    theme: Option<String>,
    engine: Engine,
    group: Option<String>,
    system_prompt: String,
    worktree_info: Option<crate::worktree::WorktreeInfo>,
    conv: Option<AgentConv>,
    on_out: Channel<String>,
) -> Result<String, String> {
    // The dir the agent actually launches in — the worktree path when isolation
    // kicked in, else the requested cwd. Returned to the frontend (branch/PR
    // badge) and recorded on the handle for handoff source resolution.
    let effective_cwd = cwd_path.to_string_lossy().into_owned();

    // COLORFGBG tells TUIs (Claude Code included) whether the terminal is light
    // or dark. Format "fg;bg"; bg 15 = light, 0 = dark. (server.ts 663–664)
    let colorfgbg = if theme.as_deref() == Some("light") { "0;15" } else { "15;0" };

    // Launcher selection (server.ts 672–695). For shell-hosted engines (Claude,
    // Codex), spawn them inside `<shell> -c "<engine>; exec <shell> -i"`. The
    // ';' (not '&&') means exiting the engine — or it crashing — falls through
    // to a live shell at the same cwd instead of a dead pane. Engine::Shell is a
    // deliberate plain terminal. Engine::Custom runs the string verbatim.
    let shell = config_shell_override()
        .or_else(|| std::env::var("SHELL").ok().filter(|s| !s.trim().is_empty()))
        .unwrap_or_else(|| "/bin/zsh".to_string());
    let (file, args): (String, Vec<String>) = match &engine {
        Engine::Claude => (
            shell.clone(),
            vec!["-c".into(), format!("{}; exec {} -i", claude_launch(conv.as_ref()), shell)],
        ),
        Engine::Codex => (shell.clone(), vec!["-c".into(), format!("codex; exec {} -i", shell)]),
        Engine::Shell => (shell.clone(), vec!["-i".into()]),
        Engine::Custom(c) => (c.clone(), vec![]),
    };

    // Env: inherit the process env (CommandBuilder::new does), then override the
    // Spike-specific keys — exactly `{ ...process.env, PATH, TERM, … }`
    // (server.ts 672).
    let repo = repo_root(&app);
    let mut builder = CommandBuilder::new(&file);
    builder.args(&args);
    builder.cwd(&cwd_path);
    builder.env("PATH", build_path(repo.as_ref()));
    builder.env("TERM", "xterm-256color");
    // A GUI app launched from Finder/Dock inherits no locale, so pty children
    // come up US-ASCII and mis-decode multibyte *input*: a pasted `≥` (UTF-8
    // E2 89 A5) reaches the program as three Mac-Roman bytes and echoes `‚â•`.
    // (Output looks fine — xterm always renders UTF-8; only input is affected.)
    // Terminal.app/iTerm set LANG on spawn for exactly this reason; mirror that.
    if let Some(lang) = utf8_lang() {
        builder.env("LANG", lang);
    }
    // Claude Code marks the processes it spawns so a nested `claude` doesn't
    // write a transcript of its own. Spike inherits that marker whenever the app
    // itself was launched from inside an agent session (a `npm run dev:tauri`
    // that an agent ran, say) and would otherwise pass it to every pty — turning
    // transcript saving off for lanes that are top-level user sessions, not
    // sub-agents. No transcript means no --resume, no /resume, no context ring.
    // Strip it: what we spawn here is always a root session.
    builder.env_remove("CLAUDE_CODE_CHILD_SESSION");
    builder.env("COLORFGBG", colorfgbg);
    // The port the listener actually bound (auto-roamed if the default was
    // taken) so `spike` from this terminal reaches THIS instance, not another.
    builder.env("SPIKE_PORT", crate::cli_listener::cli_port().to_string());
    // Per-launch secret so `spike open` / `spike context` (this terminal) can
    // authenticate to the CLI bridge. Only processes Spike spawned get it —
    // see cli_listener::token. bin/spike forwards it as X-Spike-Token.
    builder.env("SPIKE_TOKEN", crate::cli_listener::token());
    builder.env("SPIKE_SYSTEM_PROMPT", system_prompt);
    // Per-tab session id — read by the agent-event-hook adapter and forwarded
    // as `session_id` on every agent:event. The frontend uses it to route
    // events to the right tab (pause-on-question's tab-badge lookup, etc.).
    builder.env("SPIKE_SESSION_ID", &id);
    // Per-tab CODEX_HOME isolation: each Codex spawn gets its own state dir at
    // ~/.spike/codex-homes/<spawn-id>/. shims/codex sets it up on first invoke
    // (symlinks ~/.codex/auth.json, writes AGENTS.md from SPIKE_SYSTEM_PROMPT).
    // Isolation matters because two Codex tabs in different workspaces have
    // different composed prompts; a shared dir would race the AGENTS.md write.
    if matches!(engine, Engine::Codex) {
        builder.env("SPIKE_CODEX_HOME", codex_home_dir(&id).to_string_lossy().to_string());
    }

    // A failed openpty/spawn must NOT crash the app — Err(message) goes back to
    // the frontend, which prints it into the xterm (server.ts 704–711).
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("openpty failed: {e}"))?;
    let child = pair
        .slave
        .spawn_command(builder)
        .map_err(|e| format!("spawn failed: {e}"))?;
    // Parent must not hold the slave side open or the master never sees EOF.
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("pty reader failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("pty writer failed: {e}"))?;
    let killer = child.clone_killer();
    let generation = SPAWN_GEN.fetch_add(1, Ordering::Relaxed);

    // Reader thread: pty bytes → on_out channel sends, then exit + cleanup.
    // Replaces term.onData/term.onExit (server.ts 713–718). The thread owns the
    // child handle so it can wait() for the real exit code after EOF.
    spawn_reader(app, id.clone(), generation, on_out, reader, child);

    state.ptys.lock().unwrap().insert(
        id,
        PtyHandle {
            writer,
            killer,
            master: pair.master,
            generation,
            group: group.clone(),
            worktree: worktree_info,
            effective_cwd: effective_cwd.clone(),
            engine_id: engine.id(),
        },
    );
    Ok(effective_cwd)
}

/// Hand a live agent session off to a fresh, already-briefed agent
/// (docs/plans/agent-handoff-recon.md). This is the ONE integrated op that owns
/// the whole lifecycle atomically: resolve authoritative source state, fork
/// exactly one worktree from the source's HEAD OID, carry its uncommitted work
/// non-destructively, compose the engine-neutral bundle, spawn the target
/// engine, and register the fork for close-policy cleanup. If the snapshot or
/// the spawn fails, the source is left untouched and the unused fork is
/// discarded (the atomicity rule).
///
/// `source_id` — the live lane to hand off FROM (its cwd/engine/group are read
///   from backend state, never from the UI).
/// `id` — the new target session id.
/// `cmd` — target engine; MUST be a briefable engine (claude|codex). Shell is
///   not a valid handoff target and is rejected (§5).
/// `recap` — the user-edited/Spike-authored summary (trusted; not redacted).
/// `include_*` — the preview sheet's per-component manifest toggles.
/// `agent_session_id` — Spike-minted conversation id for the TARGET lane. Always
///   a fresh start (a handoff is a new conversation by definition), so it never
///   resumes; it exists so the target owns its transcript from spawn like any
///   other lane.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn pty_handoff_spawn(
    app: AppHandle,
    state: State<'_, AppState>,
    source_id: String,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    theme: Option<String>,
    cmd: String,
    agent_session_id: Option<String>,
    recap: String,
    include_files: bool,
    include_branch_diff: bool,
    include_workspace: bool,
    include_activity: bool,
    subagent: Option<bool>,
    on_out: Channel<String>,
) -> Result<String, String> {
    // 1. Authoritative source state — read from the handle, not the UI.
    let (src_cwd, src_group, _src_engine) = {
        let ptys = state.ptys.lock().unwrap();
        match ptys.get(&source_id) {
            Some(h) => (h.effective_cwd.clone(), h.group.clone(), h.engine_id.clone()),
            None => return Err(format!("source session '{source_id}' is not live")),
        }
    };

    // 2. Target engine must accept the bundle. The UI only offers briefable
    //    engines; enforce it here too (the webview is untrusted, same as pty_spawn).
    let engine = match cmd.as_str() {
        "claude" => Engine::Claude,
        "codex" => Engine::Codex,
        other => {
            return Err(format!(
                "'{other}' is not a valid handoff target — only briefable agents \
                 (claude, codex) can receive a handoff bundle"
            ))
        }
    };
    if !engine.accepts_handoff_context() {
        return Err("target engine cannot receive a handoff bundle".into());
    }

    let src_path = {
        let p = PathBuf::from(&src_cwd);
        if p.is_dir() { p } else { PathBuf::from(&cwd) }
    };

    // 3a. Branch + diff facts from the source cwd (if it's a repo).
    let repo_root = crate::worktree::repo_root(&src_path);
    let mut branch: Option<String> = None;
    let mut diff_stat: Option<String> = None;
    let mut head_oid: Option<String> = None;
    if repo_root.is_some() {
        let b = crate::worktree::git(&src_path, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
        branch = if b.is_empty() || b == "HEAD" { None } else { Some(b) };
        head_oid = crate::worktree::git(&src_path, &["rev-parse", "HEAD"]).ok().filter(|s| !s.is_empty());
        if include_branch_diff {
            diff_stat = crate::worktree::git(&src_path, &["diff", "--stat", "HEAD"])
                .ok()
                .filter(|s| !s.is_empty());
        }
    }

    // 3b. Recent source activity from the broker, filtered to this lane, then
    //     normalized + redacted + capped (untrusted context).
    let activity: Vec<String> = if include_activity {
        let mut lines: Vec<String> = state
            .agent_broker
            .recent(0)
            .into_iter()
            .filter(|e| e.session_id.as_deref() == Some(source_id.as_str()))
            .filter_map(|e| crate::handoff::normalize_event(&e.kind, &e.data))
            .collect();
        if lines.len() > crate::handoff::MAX_ACTIVITY_LINES {
            lines = lines.split_off(lines.len() - crate::handoff::MAX_ACTIVITY_LINES);
        }
        lines
    } else {
        Vec::new()
    };

    // 3c. "Current Spike view" files from focus (page-global, excludable — §3).
    let files: Vec<String> = if include_files {
        let focus = state.focus.lock().unwrap().clone();
        let mut fs: Vec<String> = Vec::new();
        if let Some(p) = focus.get("openFile").and_then(|o| o.get("path")).and_then(|v| v.as_str()) {
            fs.push(p.to_string());
        }
        if let Some(sel) = focus.get("selection").and_then(|v| v.as_array()) {
            for s in sel.iter().filter_map(|v| v.as_str()) {
                if !fs.iter().any(|x| x == s) {
                    fs.push(s.to_string());
                }
            }
        }
        fs
    } else {
        Vec::new()
    };

    // 4. Fork exactly one worktree from the source HEAD OID and carry the
    //    snapshot — but only when carrying branch&diff and the source is a repo.
    let mut target_cwd = src_path.clone();
    let mut worktree_info: Option<crate::worktree::WorktreeInfo> = None;
    let mut carried_diff = false;
    if include_branch_diff {
        if let (Some(root), Some(oid)) = (&repo_root, &head_oid) {
            // Capture the PRISTINE source BEFORE creating the fork. The worktree
            // lands under the repo's own .spike/worktrees/, so forking first would
            // make that new dir show up in the source's untracked set and get
            // captured into its own snapshot. Capture-then-fork keeps the snapshot
            // clean; capture_snapshot also excludes .spike/ defensively.
            let snap = crate::handoff::capture_snapshot(&src_path);
            let cfg = crate::fs_ops::read_config_resolved();
            let location = cfg["worktree"]["location"].as_str().unwrap_or(".spike/worktrees/").to_string();
            let prefix = cfg["worktree"]["branchPrefix"].as_str().unwrap_or("spike/wt-").to_string();
            let label = format!("handoff-{}", src_group.as_deref().unwrap_or("agent"));
            let base = branch.clone().unwrap_or_else(|| oid.clone());
            match crate::worktree::prepare_worktree_from(root, &location, &prefix, &label, oid, &base) {
                Ok(info) => {
                    // Replay the pre-captured snapshot into the fresh fork.
                    match snap.and_then(|s| crate::handoff::apply_snapshot(&s, std::path::Path::new(&info.path))) {
                        Ok(()) => {
                            let _ = on_out.send(format!(
                                "\r\n\x1b[90mspike: handoff worktree — branch {} at {}\x1b[0m\r\n",
                                info.branch, info.path
                            ));
                            target_cwd = PathBuf::from(&info.path);
                            carried_diff = true;
                            worktree_info = Some(info);
                        }
                        Err(e) => {
                            // Atomicity: snapshot failed → discard the fork, leave
                            // the source untouched, surface the reason.
                            crate::worktree::discard_worktree(&info);
                            return Err(format!("handoff aborted — could not carry the source's changes: {e}"));
                        }
                    }
                }
                Err(e) => {
                    let _ = on_out.send(format!(
                        "\r\n\x1b[33mspike: could not fork a handoff worktree ({e}) — \
                         spawning in the source's directory.\x1b[0m\r\n"
                    ));
                }
            }
        }
    }

    // 5. Compose the engine-neutral bundle.
    let bundle = crate::handoff::render_bundle(&crate::handoff::BundleInputs {
        recap,
        files,
        branch: branch.clone(),
        diff_stat,
        activity,
        carried_diff,
    });

    // 6. Workspace inheritance: carry the source's workspace .md as the base
    //    layer (reuses today's mechanism), layered UNDER the handoff snapshot.
    let target_group = if include_workspace { src_group.clone() } else { None };
    let group_md = target_group.as_deref().map(read_group_md).unwrap_or_default();
    let prompt_append = config_spawn_prompt_append().unwrap_or_default();
    let system_prompt =
        compose_system_prompt(&base_prompt(subagent.unwrap_or(false)), &group_md, &prompt_append, &bundle);

    // 7. Spawn the target. On failure honor atomicity: discard the fork we made.
    let cleanup = worktree_info.clone();
    let result = spawn_core(
        app, &state, id, target_cwd, cols, rows, theme, engine, target_group, system_prompt,
        worktree_info, agent_conv(agent_session_id, false), on_out,
    );
    if result.is_err() {
        if let Some(info) = cleanup {
            crate::worktree::discard_worktree(&info);
        }
    }
    result
}

/// A worktree-backed session ended: apply the configured close policy on a
/// background thread (git can take a moment; never stall the IPC thread).
/// Outcomes are logged; a NeedsAsk emits `worktree:ask` so the page can show
/// the merge / keep / discard prompt.
fn apply_close_policy_async(app: AppHandle, info: crate::worktree::WorktreeInfo) {
    std::thread::spawn(move || {
        let cfg = crate::fs_ops::read_config_resolved();
        let policy = crate::worktree::parse_policy(cfg["worktree"]["onClose"].as_str().unwrap_or(""));
        match crate::worktree::close_worktree(&info, policy) {
            crate::worktree::CloseOutcome::Merged => crate::fs_ops::log_action(
                "worktree_close",
                serde_json::json!({ "branch": info.branch, "outcome": "merged", "base": info.base }),
            ),
            crate::worktree::CloseOutcome::Removed => crate::fs_ops::log_action(
                "worktree_close",
                serde_json::json!({ "branch": info.branch, "outcome": "removed" }),
            ),
            crate::worktree::CloseOutcome::BranchKept => crate::fs_ops::log_action(
                "worktree_close",
                serde_json::json!({ "branch": info.branch, "outcome": "branch-kept" }),
            ),
            crate::worktree::CloseOutcome::NeedsAsk(reason) => {
                crate::fs_ops::log_action(
                    "worktree_close",
                    serde_json::json!({ "branch": info.branch, "outcome": "ask", "reason": reason }),
                );
                let _ = app.emit(
                    "worktree:ask",
                    serde_json::json!({
                        "repoRoot": info.repo_root,
                        "path": info.path,
                        "branch": info.branch,
                        "base": info.base,
                        "reason": reason,
                    }),
                );
            }
        }
    });
}

fn spawn_reader(
    app: AppHandle,
    id: String,
    generation: u64,
    on_out: Channel<String>,
    mut reader: Box<dyn Read + Send>,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
) {
    std::thread::spawn(move || {
        // Chunked reads: xterm.js handles big writes fine, and per-send IPC
        // overhead dominates — never send per byte. 32 KiB rides well under
        // typical pty buffer sizes while keeping full-screen TUI repaints to a
        // handful of channel messages.
        let mut buf = vec![0u8; 32 * 1024];
        // Carry-buffer decode: a read can end mid-way through a multi-byte
        // UTF-8 sequence; decoding chunks independently rendered those splits
        // as U+FFFD (the bug). The decoder holds the incomplete tail for the
        // next read; only truly invalid bytes decode lossily.
        let mut decoder = Utf8StreamDecoder::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break, // EOF (child gone) or master closed (kill/replace)
                Ok(n) => {
                    let chunk = decoder.push(&buf[..n]);
                    if !chunk.is_empty() {
                        let _ = on_out.send(chunk);
                    }
                }
            }
        }
        // Anything still carried at EOF can never complete — flush it lossily
        // rather than swallowing the session's final bytes.
        let tail = decoder.finish();
        if !tail.is_empty() {
            let _ = on_out.send(tail);
        }
        // Stream over → reap the child for its real exit code (server.ts onExit).
        let code: i32 = match child.wait() {
            Ok(status) => status.exit_code() as i32,
            Err(_) => -1,
        };
        // Drop our entry from state — but only if it's still OUR session, not a
        // same-id replacement spawned while we were draining. Whichever path
        // actually removes the handle (this one, pty_kill, or a same-id
        // replace) owns settling its worktree — exactly once by construction.
        let removed = {
            let state = app.state::<AppState>();
            let mut ptys = state.ptys.lock().unwrap();
            if ptys.get(&id).map(|h| h.generation) == Some(generation) {
                ptys.remove(&id)
            } else {
                None
            }
        };
        if let Some(mut h) = removed {
            if let Some(info) = h.worktree.take() {
                apply_close_policy_async(app.clone(), info);
            }
        }
        let _ = app.emit(&format!("pty:exit:{id}"), code);
    });
}

/// Write user keystrokes/paste data to the PTY (old WS `{t:'in', d}`).
/// `data` is the raw utf8 chunk from xterm's onData. An unknown/dead id is a
/// benign race (input in flight while the pane exits) — Ok, like writes to a
/// closed ws were silently dropped.
#[tauri::command]
pub fn pty_write(state: State<'_, AppState>, id: String, data: String) -> Result<(), String> {
    let mut ptys = state.ptys.lock().unwrap();
    match ptys.get_mut(&id) {
        Some(handle) => handle
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("pty write failed: {e}")),
        None => Ok(()),
    }
}

/// Resize the PTY (old WS `{t:'resize', cols, rows}`). Errors on a dead/
/// unknown id are non-fatal to the frontend; match server.ts's try/ignore
/// (line 752) — always Ok.
#[tauri::command]
pub fn pty_resize(
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let ptys = state.ptys.lock().unwrap();
    if let Some(handle) = ptys.get(&id) {
        let _ = handle
            .master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
    }
    Ok(())
}

/// Kill the PTY and drop it from state (old behavior: ws.on('close') →
/// term.kill(), server.ts 719). Killing an unknown id is Ok (idempotent).
/// The reader thread observes the stream ending and emits `pty:exit:{id}`.
/// A worktree-backed tab also settles its worktree here (the close policy —
/// async, fail-soft, never blocks the close).
#[tauri::command]
pub fn pty_kill(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    let handle = state.ptys.lock().unwrap().remove(&id);
    if let Some(mut handle) = handle {
        let _ = handle.killer.kill();
        if let Some(info) = handle.worktree.take() {
            apply_close_policy_async(app, info);
        }
        // Dropping `handle` here also closes the master, unblocking the reader.
    }
    Ok(())
}

/// Keep Claude Code's custom "spike" theme in step with Spike's own light/dark.
///
/// Claude Code picks its palette from `theme` in ~/.claude/settings.json. When
/// that's `custom:spike` it reads ~/.claude/themes/spike.json, whose `base`
/// is a fixed "light"/"dark" — it does NOT consult the terminal background, so
/// neither COLORFGBG (bound at spawn, see pty_spawn) nor an OSC 11 answer
/// reaches it. Flipping Spike's theme therefore left the agent's message bars
/// inverted until this file was edited by hand.
///
/// Deliberately narrow, because this is the user's GLOBAL config, not Spike's:
///   - only ~/.claude/themes/spike.json, no caller-supplied path;
///   - only the `base` key — `overrides` and any other field are preserved;
///   - update-only. A missing file means the user never opted into the spike
///     theme, so creating one would invent config they didn't ask for.
/// Fail-soft throughout: a theme flip must never surface an error.
///
/// Claude Code reads this at startup, so it lands on NEWLY spawned tabs. A
/// running agent keeps the palette it booted with — same latch as COLORFGBG.
#[tauri::command]
pub fn sync_claude_theme(mode: String) -> Result<(), String> {
    if mode != "light" && mode != "dark" {
        return Err("mode must be light or dark".into());
    }
    let path = home_dir().join(".claude").join("themes").join("spike.json");
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Ok(()); // not opted in — nothing to keep in step
    };
    if let Some(out) = theme_json_with_base(&raw, &mode) {
        let _ = std::fs::write(&path, out);
    }
    Ok(())
}

/// Rewrite a spike-theme document's `base`, preserving every other key.
/// None = leave the file alone: unparseable, not an object, or already correct
/// (so a flip back and forth doesn't churn the file).
fn theme_json_with_base(raw: &str, mode: &str) -> Option<String> {
    let mut theme = serde_json::from_str::<Value>(raw).ok()?;
    let obj = theme.as_object_mut()?;
    if obj.get("base").and_then(|b| b.as_str()) == Some(mode) {
        return None;
    }
    obj.insert("base".into(), Value::String(mode.to_string()));
    Some(serde_json::to_string_pretty(&theme).ok()? + "\n")
}

// ── MCP connectors: drive `claude mcp …` so config + OAuth stay canonical ─────
//
// The Connectors settings pane never writes .mcp.json / ~/.claude.json itself —
// that path has footguns (the required `type` field, no hot-reload, project-
// scope trust prompts). Instead these commands shell out to the official
// `claude mcp` subcommands, which own the config format and the OAuth flow:
//   • add / remove / list  — quick, synchronous (std::process::Command).
//   • login                — runs a browser OAuth flow, so it streams like a
//                            session in a pty (mirrors the login-spawn shape).
// All name/url values arrive from the (untrusted) webview, so we NEVER build a
// shell string from them — we resolve the `claude` binary to an absolute path
// and pass explicit args, and we validate the server name.

/// The agent CLI a connector op targets. Both `claude` and `codex` expose an
/// `mcp` subcommand family (add/list/remove/login) — but they write to totally
/// separate config (~/.claude.json vs ~/.codex/config.toml) and codex's `list`
/// hangs on unauthenticated remotes, so the two paths diverge below.
fn engine_bin_name(engine: &str) -> Result<&'static str, String> {
    match engine {
        "claude" => Ok("claude"),
        "codex" => Ok("codex"),
        other => Err(format!("unknown engine '{other}' — expected claude or codex")),
    }
}

/// Resolve an agent CLI to an absolute path using the same PATH a real spawn
/// sees (shims/ + bin/ prepended, then the user's login PATH). Passing an
/// absolute program avoids relying on the child's PATH for lookup — and lets the
/// shim's wrapper win.
fn resolve_bin(app: &AppHandle, engine: &str) -> Result<PathBuf, String> {
    let name = engine_bin_name(engine)?;
    let path_var = build_path(repo_root(app).as_ref());
    for dir in std::env::split_paths(&path_var) {
        let cand = dir.join(name);
        if cand.is_file() {
            return Ok(cand);
        }
    }
    Err(format!("Could not find the `{name}` CLI on your PATH. Install it first."))
}

/// A server name safe to pass as a positional arg: non-empty, starts
/// alphanumeric, and only `[A-Za-z0-9_-]` after — so it can't be read as a flag
/// (a leading `-`) or smuggle whitespace/paths.
fn validate_mcp_name(name: &str) -> Result<(), String> {
    let mut chars = name.chars();
    let first_ok = matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric());
    let rest_ok = chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if first_ok && rest_ok && name.len() <= 64 {
        Ok(())
    } else {
        Err(format!(
            "'{name}' isn't a valid connector name — use letters, numbers, - or _ (start with a letter or number)."
        ))
    }
}

/// Run `<engine> <args…>` synchronously with the spawn PATH, capturing combined
/// output. Returns (output, success). Never uses a shell.
fn run_cli(app: &AppHandle, engine: &str, args: &[&str]) -> Result<(String, bool), String> {
    let bin = resolve_bin(app, engine)?;
    let out = std::process::Command::new(&bin)
        .args(args)
        .env("PATH", build_path(repo_root(app).as_ref()))
        .current_dir(home_dir())
        .output()
        .map_err(|e| format!("failed to run `{engine} {}`: {e}", args.join(" ")))?;
    let mut s = String::from_utf8_lossy(&out.stdout).into_owned();
    let err = String::from_utf8_lossy(&out.stderr);
    if !err.trim().is_empty() {
        if !s.is_empty() && !s.ends_with('\n') {
            s.push('\n');
        }
        s.push_str(&err);
    }
    Ok((s, out.status.success()))
}

// ── learn-the-voice: distill DO/DON'T from edit history ─────────────────────

/// The first balanced `{…}` JSON object substring in `s` (depth-tracked, string
/// aware), or None. Lets us pull the model's object out of prose or code fences.
fn first_json_object(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let start = s.find('{')?;
    let mut depth = 0i32;
    let mut in_str = false;
    let mut esc = false;
    for i in start..bytes.len() {
        let c = bytes[i] as char;
        if in_str {
            if esc {
                esc = false;
            } else if c == '\\' {
                esc = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match c {
            '"' => in_str = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(s[start..=i].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

/// Pull `{do:[], dont:[]}` out of a `claude -p --output-format json` response.
/// The envelope carries the model's text in `.result`; that text should be the
/// JSON object (tolerant of fences / stray prose via first_json_object).
fn extract_voice_json(raw: &str) -> (Vec<String>, Vec<String>) {
    let inner = serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|v| v.get("result").and_then(|r| r.as_str()).map(String::from))
        .unwrap_or_else(|| raw.to_string());
    let obj = match first_json_object(&inner) {
        Some(o) => o,
        None => return (vec![], vec![]),
    };
    let v: Value = match serde_json::from_str(&obj) {
        Ok(v) => v,
        Err(_) => return (vec![], vec![]),
    };
    let list = |key: &str| -> Vec<String> {
        v.get(key)
            .and_then(|a| a.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|s| s.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default()
    };
    (list("do"), list("dont"))
}

/// Distill the user's accumulated edits into candidate DO/DON'T voice directives.
/// Reads ~/.spike/voice/<slug>.edits.jsonl, sends the before/after pairs to a
/// headless `claude -p` call, and returns only NEW candidates (excluding what's
/// already in the workspace voice or previously dismissed). Advances the
/// `analyzed` watermark so the same edits don't re-trigger a proposal.
// async + spawn_blocking (below) so the `claude -p` distillation call runs off
// the main/UI thread — Tauri v2 runs sync commands on the UI thread, and a
// blocking multi-second inference there freezes the window (same class as the
// title_workstream/read_tree/pty_spawn fixes).
#[tauri::command]
pub async fn analyze_voice(app: AppHandle, slug: String) -> Result<Value, String> {
    let edits = crate::fs_ops::voice_edits(&slug);
    let total = crate::fs_ops::voice_edit_count(&slug);
    if edits.is_empty() {
        return Ok(json!({ "do": [], "dont": [] }));
    }

    let (cur_do, cur_dont) = crate::fs_ops::group_voice(&slug);
    let dismissed: Vec<String> = crate::fs_ops::voice_state(&slug)["dismissed"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();

    // Bound the prompt: last 25 edits, each field clipped.
    let clip = |s: &str| -> String {
        let t: String = s.chars().take(1400).collect();
        t
    };
    let mut samples = String::new();
    for (i, e) in edits.iter().rev().take(25).collect::<Vec<_>>().iter().rev().enumerate() {
        let before = e.get("before").and_then(|v| v.as_str()).unwrap_or("");
        let after = e.get("after").and_then(|v| v.as_str()).unwrap_or("");
        samples.push_str(&format!(
            "--- edit {} ---\nBEFORE:\n{}\n\nAFTER:\n{}\n\n",
            i + 1,
            clip(before),
            clip(after)
        ));
    }

    let known = |label: &str, items: &[String]| -> String {
        if items.is_empty() {
            String::new()
        } else {
            format!("\n{}:\n{}\n", label, items.iter().map(|s| format!("- {}", s)).collect::<Vec<_>>().join("\n"))
        }
    };

    let prompt = format!(
        "You are analyzing how a person edits AI-written prose to learn their WRITING VOICE.\n\
Below are before/after pairs of their edits. Infer the DURABLE STYLE preferences behind the pattern — \
not one-off content or factual changes. Express each as a short, imperative DO or DON'T directive an AI \
could follow to write in their voice (e.g. \"Lead with the number or the decision\", \"Don't open with a summary paragraph\").\n\n\
Only include a directive if the pattern shows up clearly. It is fine to return few or none. \
Do NOT repeat anything in the already-known or rejected lists below.\n\
{}{}{}\n\
EDITS:\n{}\n\
Respond with ONLY a JSON object, no prose and no code fences:\n\
{{\"do\": [\"...\"], \"dont\": [\"...\"]}}",
        known("Already in their voice (DO)", &cur_do),
        known("Already in their voice (DON'T)", &cur_dont),
        known("Previously rejected — never propose", &dismissed),
        samples,
    );

    let (out, ok) = tauri::async_runtime::spawn_blocking(move || {
        run_cli(&app, "claude", &["-p", &prompt, "--output-format", "json"])
    })
    .await
    .map_err(|e| format!("voice task panicked: {e}"))??;
    if !ok {
        let snippet: String = out.chars().take(400).collect();
        return Err(format!("voice analysis call failed: {snippet}"));
    }

    let (mut do_c, mut dont_c) = extract_voice_json(&out);

    // Exclude anything already accepted or dismissed (case-insensitive exact).
    let norm = |s: &str| s.trim().to_lowercase();
    let seen_do: Vec<String> = cur_do.iter().map(|s| norm(s)).collect();
    let seen_dont: Vec<String> = cur_dont.iter().map(|s| norm(s)).collect();
    let rejected: Vec<String> = dismissed.iter().map(|s| norm(s)).collect();
    do_c.retain(|c| !seen_do.contains(&norm(c)) && !rejected.contains(&norm(c)));
    dont_c.retain(|c| !seen_dont.contains(&norm(c)) && !rejected.contains(&norm(c)));

    // These edits are now accounted for — don't let them re-trigger.
    crate::fs_ops::voice_set_analyzed(&slug, total);
    crate::fs_ops::log_action("voice_analyze", json!({ "slug": slug, "do": do_c.len(), "dont": dont_c.len() }));

    Ok(json!({ "do": do_c, "dont": dont_c }))
}

// ── workstream auto-title: a short name from the opening message ─────────────

/// Unwrap the `claude -p --output-format json` envelope to its `.result` text,
/// falling back to the raw string if it isn't that shape.
fn unwrap_result(raw: &str) -> String {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|v| v.get("result").and_then(|r| r.as_str()).map(String::from))
        .unwrap_or_else(|| raw.to_string())
}

/// Squeeze the model's reply into a bare title: one line, no wrapping quotes or
/// code fences, no trailing punctuation, clamped to a handful of words. The
/// model is asked for exactly this, but we never trust it to comply.
fn clean_title(raw: &str) -> String {
    // First non-empty line — the model sometimes adds a stray blank line.
    let line = raw.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let mut t = line.trim().trim_matches(|c| c == '"' || c == '\'' || c == '`').trim().to_string();
    // Drop a leading list/heading marker if one slipped in ("- ", "# ", "1. ").
    if let Some(rest) = t.strip_prefix("- ").or_else(|| t.strip_prefix("# ")) {
        t = rest.trim().to_string();
    }
    t = t.trim_end_matches(|c: char| c == '.' || c == ',' || c == '!' || c == ';' || c == ':').trim().to_string();
    // Clamp: at most 6 words, and a hard char cap so a runaway reply can't
    // become the label. Word cap first so we don't slice mid-word.
    let words: Vec<&str> = t.split_whitespace().collect();
    if words.len() > 6 {
        t = words[..6].join(" ");
    }
    if t.chars().count() > 48 {
        t = t.chars().take(48).collect::<String>().trim_end().to_string();
    }
    t
}

/// Name a workstream from its opening user message. Runs a fast headless
/// `claude -p --model haiku` (subscription-billed, like analyze_voice — NOT the
/// metered API) and returns a 2–5 word title, or an empty string if the call
/// fails or yields nothing usable (the caller then keeps the derived label).
// async + spawn_blocking so the Haiku call (`claude -p` — a 1-2s subprocess
// inference) runs on the blocking pool, NOT the main thread. This fires on the
// first message to name the workstream; as a sync command it froze the window
// (beach ball) right through "Warming up…". Matches the read_tree/pty_spawn fix:
// Tauri v2 runs sync commands on the UI thread, so any blocking work must move off.
#[tauri::command]
pub async fn title_workstream(app: AppHandle, first_message: String) -> Result<String, String> {
    let msg: String = first_message.trim().chars().take(1400).collect();
    if msg.is_empty() {
        return Ok(String::new());
    }
    let prompt = format!(
        "Give a short title (2 to 5 words) for a work session that opens with the message below. \
Name the TASK or TOPIC, in the user's own terms. Title Case. No quotes, no punctuation, no preamble — \
respond with ONLY the title.\n\nMESSAGE:\n{msg}"
    );
    let (out, ok) = tauri::async_runtime::spawn_blocking(move || {
        run_cli(
            &app,
            "claude",
            &["-p", &prompt, "--model", "haiku", "--output-format", "json"],
        )
    })
    .await
    .map_err(|e| format!("title task panicked: {e}"))??;
    if !ok {
        let snippet: String = out.chars().take(200).collect();
        return Err(format!("title call failed: {snippet}"));
    }
    let title = clean_title(&unwrap_result(&out));
    crate::fs_ops::log_action("workstream_title", json!({ "ok": !title.is_empty() }));
    Ok(title)
}

// ── dynamic slash commands: the real command set from disk ───────────────────

/// A one-line description for a command/skill: the frontmatter `description:` if
/// present, else the first real line of the body (skipping fences, headings and
/// blank lines). Clamped so a paragraph-long SKILL description doesn't blow up
/// the menu row.
fn command_desc(path: &std::path::Path) -> String {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    if let Some(d) = frontmatter_field(&text, "description") {
        return d.chars().take(160).collect();
    }
    for line in text.lines() {
        let l = line.trim();
        if l.is_empty() || l == "---" || l.starts_with('#') || l.starts_with("```") {
            continue;
        }
        return l.chars().take(160).collect();
    }
    String::new()
}

/// Pull a single `key: value` out of a leading `---` frontmatter block.
fn frontmatter_field(text: &str, field: &str) -> Option<String> {
    let rest = text.strip_prefix("---")?;
    let end = rest.find("\n---")?;
    for line in rest[..end].lines() {
        if let Some(v) = line.trim().strip_prefix(&format!("{field}:")) {
            let v = v.trim().trim_matches(|c| c == '"' || c == '\'').trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

/// Walk a `.claude/commands` dir. Each `*.md` is a command `/<stem>`; a subdir
/// namespaces its files as `/<dir>:<stem>` (Claude Code's own convention).
fn collect_commands(
    dir: &std::path::Path,
    prefix: &str,
    scope: &str,
    out: &mut Vec<Value>,
    seen: &mut std::collections::HashSet<String>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let path = e.path();
        if path.is_dir() {
            let sub = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
            let np = if prefix.is_empty() { sub.to_string() } else { format!("{prefix}:{sub}") };
            collect_commands(&path, &np, scope, out, seen);
        } else if path.extension().and_then(|s| s.to_str()) == Some("md") {
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            if stem.is_empty() {
                continue;
            }
            let name = if prefix.is_empty() { format!("/{stem}") } else { format!("/{prefix}:{stem}") };
            if !seen.insert(name.clone()) {
                continue;
            }
            out.push(json!({ "name": name, "desc": command_desc(&path), "source": "command", "scope": scope }));
        }
    }
}

/// Walk a `.claude/skills` dir. Each `<name>/SKILL.md` is invocable as `/<name>`
/// (the frontmatter `name`, else the dir name).
fn collect_skills(
    dir: &std::path::Path,
    scope: &str,
    out: &mut Vec<Value>,
    seen: &mut std::collections::HashSet<String>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let path = e.path();
        let skill_md = path.join("SKILL.md");
        if !path.is_dir() || !skill_md.is_file() {
            continue;
        }
        let text = std::fs::read_to_string(&skill_md).unwrap_or_default();
        let dirname = path.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
        let nm = frontmatter_field(&text, "name").unwrap_or(dirname);
        if nm.is_empty() {
            continue;
        }
        let name = format!("/{nm}");
        if !seen.insert(name.clone()) {
            continue;
        }
        out.push(json!({ "name": name, "desc": command_desc(&skill_md), "source": "skill", "scope": scope }));
    }
}

/// The real, on-disk slash commands + skills, so the composer's "/" menu reflects
/// what THIS project + user actually have, not just Claude Code's built-ins.
/// Sources, project before user (project wins a name clash, Claude Code's order):
///   <cwd>/.claude/commands + ~/.claude/commands   (*.md, subdirs → /dir:name)
///   <cwd>/.claude/skills   + ~/.claude/skills      (<name>/SKILL.md → /name)
/// Each entry: { name, desc, source: "command"|"skill", scope: "project"|"user" }.
/// Plugin-provided commands are intentionally NOT walked (marketplace resolution
/// is engine-internal); the built-in list on the frontend covers Claude's own.
/// async + spawn_blocking so the fs walk never touches the UI thread.
#[tauri::command]
pub async fn list_slash_commands(cwd: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out: Vec<Value> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut bases: Vec<(PathBuf, &str)> = Vec::new();
        if let Some(c) = cwd.as_ref() {
            let p = PathBuf::from(c);
            if p.is_dir() {
                bases.push((p.join(".claude"), "project"));
            }
        }
        bases.push((home_dir().join(".claude"), "user"));
        for (base, scope) in &bases {
            collect_commands(&base.join("commands"), "", scope, &mut out, &mut seen);
            collect_skills(&base.join("skills"), scope, &mut out, &mut seen);
        }
        out.sort_by(|a, b| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")));
        json!(out)
    })
    .await
    .map_err(|e| format!("list_slash_commands task panicked: {e}"))
}

/// Parse Codex's `~/.codex/config.toml` for configured MCP servers — name + url.
/// We read the file directly instead of `codex mcp list --json` because that
/// command CONNECTS to each server and hangs indefinitely on an unauthenticated
/// remote. Codex doesn't expose auth status cheaply, so status is "unknown"
/// (the pane shows a neutral "Added"). Only top-level `[mcp_servers.<name>]`
/// tables start a server; subtables like `[mcp_servers.<name>.env]` are ignored.
fn parse_codex_mcp(toml: &str) -> Vec<Value> {
    let mut servers: Vec<Value> = Vec::new();
    let mut cur_name: Option<String> = None;
    let mut cur_url = String::new();
    let flush = |servers: &mut Vec<Value>, name: &Option<String>, url: &str| {
        if let Some(n) = name {
            servers.push(json!({ "name": n, "url": url, "status": "unknown", "line": n }));
        }
    };
    for raw in toml.lines() {
        let line = raw.trim();
        if let Some(rest) = line.strip_prefix("[mcp_servers.") {
            let Some(inner) = rest.strip_suffix(']') else { continue };
            // Subtable (name.env / name.http_headers) — belongs to the current
            // server, not a new one.
            if inner.contains('.') {
                continue;
            }
            flush(&mut servers, &cur_name, &cur_url);
            cur_name = Some(inner.trim_matches('"').to_string());
            cur_url = String::new();
        } else if line.starts_with("url") {
            if let Some((_, v)) = line.split_once('=') {
                cur_url = v.trim().trim_matches('"').to_string();
            }
        }
    }
    flush(&mut servers, &cur_name, &cur_url);
    servers
}

/// List configured MCP servers with their live auth/connection status. Parses
/// the text of `claude mcp list` (there is no JSON output) defensively — each
/// server line looks like `name: <url> (HTTP) - ✔ Connected`. Status is
/// normalized to: connected | needs_auth | failed | pending | unknown. The raw
/// text is returned too so the pane can surface details we didn't parse.
#[tauri::command]
pub fn mcp_list(app: AppHandle, engine: Option<String>) -> Result<Value, String> {
    let engine = engine.unwrap_or_else(|| "claude".into());
    match engine.as_str() {
        "claude" => {
            let (out, _ok) = run_cli(&app, "claude", &["mcp", "list"])?;
            Ok(json!({ "servers": parse_mcp_list(&out), "raw": out }))
        }
        "codex" => {
            // Read config.toml directly — `codex mcp list` hangs on unauth remotes.
            let toml = std::fs::read_to_string(home_dir().join(".codex/config.toml"))
                .unwrap_or_default();
            Ok(json!({ "servers": parse_codex_mcp(&toml), "raw": toml }))
        }
        other => Err(format!("unknown engine '{other}'")),
    }
}

/// Pure parser for `claude mcp list` output (extracted so it's testable without
/// spawning the CLI). Each remote-server row looks like
/// `<name>: <url> [(HTTP)] - ✔ Connected`; the URL sits right after "<name>: ".
/// Rows without a URL (headers, stdio servers, prose) are skipped. Status is
/// normalized to: connected | needs_auth | failed | pending | unknown.
fn parse_mcp_list(out: &str) -> Vec<Value> {
    let mut servers: Vec<Value> = Vec::new();
    for raw in out.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        // Anchor on ": http" (covers http/https) rather than the first ':' so
        // names that themselves contain a colon (e.g. "plugin:vercel:vercel")
        // parse whole, and header/footer prose (no URL) is skipped.
        let Some(idx) = line.find(": http") else {
            continue;
        };
        let name = line[..idx].trim();
        let rest = line[idx + 2..].trim(); // past the ": "
        if name.is_empty() {
            continue;
        }
        let low = rest.to_lowercase();
        let status = if low.contains("auth") && (low.contains("need") || low.contains("require")) {
            "needs_auth"
        } else if low.contains("pending") || low.contains("approval") {
            "pending"
        } else if low.contains("fail") || low.contains("error") || low.contains('✘') {
            "failed"
        } else if low.contains("connect") {
            "connected"
        } else {
            "unknown"
        };
        let url = rest.split_whitespace().next().unwrap_or("").to_string();
        servers.push(json!({ "name": name, "url": url, "status": status, "line": line }));
    }
    servers
}

/// Add a remote MCP server via `claude mcp add`. `transport` is http|sse;
/// `scope` is user|project|local (default user → available in every workspace,
/// stored under the top-level `mcpServers` in ~/.claude.json). Returns the CLI
/// error text on failure so the pane can show exactly what went wrong.
#[tauri::command]
pub fn mcp_add(
    app: AppHandle,
    engine: Option<String>,
    name: String,
    transport: String,
    url: String,
    scope: Option<String>,
) -> Result<(), String> {
    validate_mcp_name(&name)?;
    if transport != "http" && transport != "sse" {
        return Err("transport must be \"http\" or \"sse\"".into());
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("URL must start with http:// or https://".into());
    }
    let engine = engine.unwrap_or_else(|| "claude".into());
    let (out, ok) = match engine.as_str() {
        "claude" => {
            let scope = scope.unwrap_or_else(|| "user".into());
            if !matches!(scope.as_str(), "user" | "project" | "local") {
                return Err("scope must be \"user\", \"project\", or \"local\"".into());
            }
            run_cli(&app, "claude",
                &["mcp", "add", "--transport", &transport, "--scope", &scope, &name, &url])?
        }
        // Codex writes global ~/.codex/config.toml; it has no scope flag and
        // infers transport from --url (streamable HTTP).
        "codex" => run_cli(&app, "codex", &["mcp", "add", &name, "--url", &url])?,
        other => return Err(format!("unknown engine '{other}'")),
    };
    if ok { Ok(()) } else { Err(out.trim().to_string()) }
}

/// Remove a configured MCP server (`claude mcp remove` / `codex mcp remove`).
#[tauri::command]
pub fn mcp_remove(
    app: AppHandle,
    engine: Option<String>,
    name: String,
    scope: Option<String>,
) -> Result<(), String> {
    validate_mcp_name(&name)?;
    let engine = engine.unwrap_or_else(|| "claude".into());
    let (out, ok) = match engine.as_str() {
        "claude" => {
            let scope = scope.unwrap_or_else(|| "user".into());
            if !matches!(scope.as_str(), "user" | "project" | "local") {
                return Err("scope must be \"user\", \"project\", or \"local\"".into());
            }
            run_cli(&app, "claude", &["mcp", "remove", "--scope", &scope, &name])?
        }
        "codex" => run_cli(&app, "codex", &["mcp", "remove", &name])?,
        other => return Err(format!("unknown engine '{other}'")),
    };
    if ok { Ok(()) } else { Err(out.trim().to_string()) }
}

/// Run a configured server's OAuth sign-in via `claude mcp login <name>` in a
/// pty, streaming output to `on_out` — the flow opens a browser and waits for
/// the redirect, so it behaves like a short-lived session (the reader thread
/// emits `pty:exit:<id>` on completion, which the pane uses to re-list status).
/// Deliberately runs the resolved `claude` binary directly (no shell, no
/// SPIKE_SYSTEM_PROMPT) so nothing injects a system prompt into the auth flow.
#[tauri::command]
pub fn mcp_login_spawn(
    app: AppHandle,
    state: State<'_, AppState>,
    engine: Option<String>,
    name: String,
    id: String,
    on_out: Channel<String>,
) -> Result<(), String> {
    validate_mcp_name(&name)?;
    let engine = engine.unwrap_or_else(|| "claude".into());
    let bin = resolve_bin(&app, &engine)?;

    // Replace any lingering login pty with the same id (a retried sign-in).
    let old = state.ptys.lock().unwrap().remove(&id);
    if let Some(mut old) = old {
        let _ = old.killer.kill();
    }

    let mut builder = CommandBuilder::new(&bin);
    builder.args(["mcp", "login", &name]);
    builder.cwd(home_dir());
    builder.env("PATH", build_path(repo_root(&app).as_ref()));
    builder.env("TERM", "xterm-256color");
    if let Some(lang) = utf8_lang() {
        builder.env("LANG", lang);
    }

    let pair = native_pty_system()
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("openpty failed: {e}"))?;
    let child = pair
        .slave
        .spawn_command(builder)
        .map_err(|e| format!("spawn failed: {e}"))?;
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("pty reader failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("pty writer failed: {e}"))?;
    let killer = child.clone_killer();
    let generation = SPAWN_GEN.fetch_add(1, Ordering::Relaxed);

    spawn_reader(app, id.clone(), generation, on_out, reader, child);

    state.ptys.lock().unwrap().insert(
        id,
        PtyHandle {
            writer,
            killer,
            master: pair.master,
            generation,
            group: None,
            worktree: None,
            effective_cwd: home_dir().to_string_lossy().into_owned(),
            engine_id: engine,
        },
    );
    Ok(())
}

// ── tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_json_object_extracts_balanced_object() {
        // ignores braces inside strings, stops at the matching close
        let s = r#"prefix {"do": ["a {b}"], "dont": []} trailing } junk"#;
        let obj = first_json_object(s).unwrap();
        assert_eq!(obj, r#"{"do": ["a {b}"], "dont": []}"#);
        assert!(first_json_object("no object here").is_none());
    }

    #[test]
    fn extract_voice_json_handles_claude_envelope() {
        // `claude -p --output-format json` wraps the model text in `.result`
        let envelope = r#"{"type":"result","result":"{\"do\":[\"Lead with the number\"],\"dont\":[\"Open with a summary\"]}","total_cost_usd":0.01}"#;
        let (dos, donts) = extract_voice_json(envelope);
        assert_eq!(dos, vec!["Lead with the number"]);
        assert_eq!(donts, vec!["Open with a summary"]);
    }

    #[test]
    fn extract_voice_json_tolerates_fences_and_prose() {
        // model ignored the "no fences" instruction — still recoverable
        let raw = "Sure! Here you go:\n```json\n{\"do\": [\"Be terse\"], \"dont\": []}\n```";
        let (dos, donts) = extract_voice_json(raw);
        assert_eq!(dos, vec!["Be terse"]);
        assert!(donts.is_empty());
    }

    #[test]
    fn extract_voice_json_empty_on_garbage() {
        let (dos, donts) = extract_voice_json("total nonsense, no json");
        assert!(dos.is_empty() && donts.is_empty());
    }

    /// The theme sync flips `base` without disturbing anything else the user
    /// put in the file — `overrides` is theirs, not ours to reset.
    #[test]
    fn theme_sync_flips_base_and_keeps_overrides() {
        let raw = r##"{"name":"spike","base":"light","overrides":{"text":"#fff"}}"##;
        let out = theme_json_with_base(raw, "dark").expect("should rewrite");
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["base"], "dark");
        assert_eq!(v["name"], "spike");
        assert_eq!(v["overrides"]["text"], "#fff");
    }

    /// No-op cases must leave the file untouched rather than rewrite or clobber:
    /// already-correct (a flip back and forth shouldn't churn it) and garbage.
    #[test]
    fn theme_sync_leaves_file_alone_when_it_should() {
        assert!(theme_json_with_base(r#"{"base":"dark"}"#, "dark").is_none());
        assert!(theme_json_with_base("not json at all", "dark").is_none());
        assert!(theme_json_with_base("[1,2,3]", "dark").is_none());
    }

    /// End-to-end portable-pty sanity: spawn echo through a real pty, read its
    /// output back, reap the exit code. This is the M0 go/no-go in miniature.
    #[test]
    fn pty_roundtrip_echo() {
        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");
        let mut builder = CommandBuilder::new("/bin/echo");
        builder.arg("spike-pty-ok");
        let mut child = pair.slave.spawn_command(builder).expect("spawn echo");
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().expect("reader");
        let mut out = String::new();
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => out.push_str(&String::from_utf8_lossy(&buf[..n])),
            }
        }
        let status = child.wait().expect("wait");
        assert!(status.success(), "echo exited nonzero: {:?}", status);
        assert!(out.contains("spike-pty-ok"), "pty output missing echo text: {out:?}");
    }

    /// The env strip, through a real pty. Claude Code marks the processes it
    /// spawns with CLAUDE_CODE_CHILD_SESSION so a nested `claude` writes no
    /// transcript; Spike inherits it whenever the app was launched from inside
    /// an agent session, and passing it on silently disables transcripts (and
    /// with them --resume and the context ring) for lanes that are root
    /// sessions. Asserts spawn_core's env_remove reaches the child — the parent
    /// here HAS the marker set, and the child must not see it.
    #[test]
    fn child_session_marker_is_stripped_from_spawned_ptys() {
        std::env::set_var("CLAUDE_CODE_CHILD_SESSION", "1");

        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");
        let mut builder = CommandBuilder::new("/bin/sh");
        builder.args(["-c", "echo marker=[${CLAUDE_CODE_CHILD_SESSION}]"]);
        builder.env_remove("CLAUDE_CODE_CHILD_SESSION");   // the line under test
        let mut child = pair.slave.spawn_command(builder).expect("spawn sh");
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().expect("reader");
        let mut out = String::new();
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => out.push_str(&String::from_utf8_lossy(&buf[..n])),
            }
        }
        let _ = child.wait();
        std::env::remove_var("CLAUDE_CODE_CHILD_SESSION");

        assert!(out.contains("marker=[]"), "marker leaked into the pty: {out:?}");
    }

    /// The pty_kill edge the frontend relies on: after killer.kill() + dropping
    /// the master (exactly what pty_kill does), the reader thread must still
    /// reach EOF and the wait()/emit tail — otherwise `pty:exit:{id}` never
    /// fires and the pane stays "alive". Mimics spawn_reader's loop with the
    /// emit replaced by a channel send.
    #[test]
    fn kill_unblocks_reader_and_reaches_exit_path() {
        use std::time::Duration;

        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");
        // cat blocks on the slave forever — it only dies if the kill works.
        let builder = CommandBuilder::new("/bin/cat");
        let mut child = pair.slave.spawn_command(builder).expect("spawn cat");
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().expect("reader");
        let mut killer = child.clone_killer();
        let (tx, rx) = std::sync::mpsc::channel::<i32>();
        let t = std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
            let code = match child.wait() {
                Ok(status) => status.exit_code() as i32,
                Err(_) => -1,
            };
            let _ = tx.send(code); // stands in for app.emit("pty:exit:{id}")
        });

        // pty_kill's exact sequence: kill the child, then drop the handle
        // (which drops the master).
        let _ = killer.kill();
        drop(pair.master);

        let code = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("reader thread never reached its exit path after pty_kill");
        // SIGHUP-terminated; the exact code is platform-shaped — reaching here
        // at all is the assertion. Sanity: it's a real reaped status.
        let _ = code;
        t.join().expect("reader thread panicked");
    }

    /// PATH rebuild ordering: shims first, bin second, then ~/.local/bin, then
    /// the system dirs, with the inherited PATH at the tail.
    #[test]
    fn path_rebuild_order() {
        let repo = PathBuf::from("/tmp/spike-repo");
        let path = build_path(Some(&repo));
        let parts: Vec<&str> = path.split(':').collect();
        assert_eq!(parts[0], "/tmp/spike-repo/shims");
        assert_eq!(parts[1], "/tmp/spike-repo/bin");
        assert!(parts[2].ends_with("/.local/bin"));
        assert_eq!(parts[3], "/opt/homebrew/bin");
        // Without a repo the prepends are skipped, not empty strings.
        let bare = build_path(None);
        assert!(bare.split(':').next().unwrap().ends_with("/.local/bin"));
    }

    /// THE bug this decoder exists for: a 3-byte box-drawing char (`─`,
    /// E2 94 80) split across two reads must decode clean, not as `��`.
    #[test]
    fn utf8_multibyte_split_across_two_chunks() {
        let mut d = Utf8StreamDecoder::new();
        let bytes = "a─b".as_bytes(); // 61 E2 94 80 62
        assert_eq!(d.push(&bytes[..2]), "a"); // lead byte E2 held back
        assert_eq!(d.push(&bytes[2..]), "─b"); // completes on the next read
        assert_eq!(d.finish(), "");
    }

    /// Worst case: a 4-byte sequence delivered one byte per read. Also covers
    /// the carry-completing-across-multiple-pushes path.
    #[test]
    fn utf8_four_byte_char_byte_by_byte() {
        let mut d = Utf8StreamDecoder::new();
        let mut out = String::new();
        for b in "x🚀y".as_bytes() {
            out.push_str(&d.push(&[*b]));
        }
        out.push_str(&d.finish());
        assert_eq!(out, "x🚀y");
    }

    /// A carried lead byte that the next read does NOT continue must flush
    /// lossily in that next push — the carry never outlives one read while
    /// invalid, and never swallows the following bytes.
    #[test]
    fn utf8_dead_carry_flushes_lossily_on_next_push() {
        let mut d = Utf8StreamDecoder::new();
        assert_eq!(d.push(&[0xE2]), ""); // incomplete, plausibly completable
        assert_eq!(d.push(b"abc"), "\u{FFFD}abc"); // provably invalid now
        assert!(d.carry.is_empty());
        assert_eq!(d.finish(), "");
    }

    /// Stream ends mid-sequence: EOF flush is lossy, not silent.
    #[test]
    fn utf8_incomplete_tail_at_eof_flushes_lossily() {
        let mut d = Utf8StreamDecoder::new();
        assert_eq!(d.push(&[0x61, 0xE2, 0x94]), "a");
        assert_eq!(d.finish(), "\u{FFFD}");
        assert!(d.carry.is_empty());
    }

    /// Genuinely invalid bytes (stray continuations, no lead in range) must
    /// not be held back at all — they go straight to lossy output.
    #[test]
    fn utf8_stray_continuations_not_carried() {
        let mut d = Utf8StreamDecoder::new();
        assert_eq!(d.push(&[0x61, 0x80, 0x80]), "a\u{FFFD}\u{FFFD}");
        assert!(d.carry.is_empty());
        // Pure ASCII passes through untouched, nothing carried.
        assert_eq!(d.push(b"hello"), "hello");
        assert_eq!(d.finish(), "");
    }

    /// Boundary scanner: complete buffers return len; incomplete tails return
    /// the lead-byte index; never holds back more than 3 bytes.
    #[test]
    fn utf8_boundary_scanner_cases() {
        assert_eq!(utf8_carry_start(b""), 0);
        assert_eq!(utf8_carry_start(b"abc"), 3);
        assert_eq!(utf8_carry_start("a─".as_bytes()), 4); // complete 3-byte seq
        assert_eq!(utf8_carry_start(&[0x61, 0xE2]), 1); // 3-byte lead, 1/3 present
        assert_eq!(utf8_carry_start(&[0x61, 0xE2, 0x94]), 1); // 2/3 present
        assert_eq!(utf8_carry_start(&[0x61, 0xF0, 0x9F, 0x9A]), 1); // 4-byte, 3/4
        assert_eq!(utf8_carry_start(&[0x61, 0xC3]), 1); // 2-byte lead alone
        assert_eq!(utf8_carry_start(&[0x80, 0x80, 0x80]), 3); // invalid: don't carry
    }

    /// The spawn prompt contract (settings-v2): base, then the GLOBAL spawn
    /// prompt, then workspace context — "appended to every spawn before
    /// workspace context". Blank parts (incl. whitespace-only append)
    /// skipped, so an empty append never adds a trailing blank section.
    #[test]
    fn system_prompt_composition_order_and_blanks() {
        assert_eq!(compose_system_prompt("base", "", "", ""), "base");
        assert_eq!(compose_system_prompt("base", "ws ctx\n", "", ""), "base\n\nws ctx");
        assert_eq!(compose_system_prompt("base", "", "be concise", ""), "base\n\nbe concise");
        assert_eq!(
            compose_system_prompt("base", "ws ctx\n", "be concise", ""),
            "base\n\nbe concise\n\nws ctx"
        );
        // whitespace-only append is treated as empty (spec edge case)
        assert_eq!(compose_system_prompt("base", "ws", "   \n  ", ""), "base\n\nws");
        // handoff snapshot comes LAST, after base/global/workspace
        assert_eq!(
            compose_system_prompt("base", "ws", "glob", "handoff snap"),
            "base\n\nglob\n\nws\n\nhandoff snap"
        );
    }

    #[test]
    fn base_prompt_does_not_steer_delegation() {
        // Path B: don't fight Claude's native subagents — Spike visualizes them
        // instead. The base prompt keeps the preview-panel guidance and adds no
        // "use spike spawn / avoid Task" nudge, in either role.
        for role in [false, true] {
            let p = base_prompt(role);
            assert!(p.contains("spike open"), "keeps the base Spike guidance");
            assert!(!p.contains("spike spawn"), "no delegation steering");
            assert!(!p.contains("Task"), "does not mention the native Task tool");
        }
    }

    /// Slug rules match server.ts sanitizeGroupName: runs of junk fold to one
    /// '-', edges trimmed, empty falls back to "group".
    #[test]
    fn group_name_sanitization() {
        assert_eq!(sanitize_group_name("My Group"), "My-Group");
        assert_eq!(sanitize_group_name("a/b\\c"), "a-b-c");
        assert_eq!(sanitize_group_name("  spaced  out  "), "spaced-out");
        assert_eq!(sanitize_group_name("!!!"), "group");
        assert_eq!(sanitize_group_name(""), "group");
        assert_eq!(sanitize_group_name("ok_name.v2-x"), "ok_name.v2-x");
    }

    /// The session id reaches a `zsh -c` string, so validation is a whitelist
    /// (UUID charset + exact length), not an escape. Anything else is dropped
    /// rather than sanitized — a degraded lane beats an injected one.
    #[test]
    fn agent_conv_accepts_only_uuids() {
        let uuid = "12a49a91-229d-45c9-b52b-4f432ebb5e74";
        assert_eq!(
            agent_conv(Some(uuid.into()), true),
            Some(AgentConv { id: uuid.into(), resume: true })
        );
        // no id at all → engine picks its own, as before
        assert_eq!(agent_conv(None, false), None);
        // injection attempts and near-misses all drop
        assert_eq!(agent_conv(Some("12a49a91-229d-45c9-b52b-4f432ebb5e74; rm -rf ~".into()), false), None);
        assert_eq!(agent_conv(Some("$(whoami)".into()), false), None);
        assert_eq!(agent_conv(Some("../../etc/passwd".into()), false), None);
        assert_eq!(agent_conv(Some("".into()), false), None);
        assert_eq!(agent_conv(Some("12a49a91-229d-45c9-b52b-4f432ebb5e7".into()), false), None); // 35 chars
        assert_eq!(agent_conv(Some("12a49a91229d45c9b52b4f432ebb5e74zzzz".into()), false), None); // non-hex
    }

    /// Flag choice per lane state. `--session-id` starts a conversation under an
    /// id we chose; `--resume` picks an existing one back up. A resume whose
    /// transcript is gone downgrades to a fresh start rather than erroring the
    /// lane into a bare shell (the file can't exist for a random uuid, which is
    /// what this asserts without touching the real ~/.claude).
    #[test]
    fn claude_launch_flags() {
        let uuid = "0f9c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
        assert_eq!(claude_launch(None), "claude");
        assert_eq!(
            claude_launch(Some(&AgentConv { id: uuid.into(), resume: false })),
            format!("claude --session-id {uuid}")
        );
        // resume + no transcript on disk → fresh start, same id
        assert_eq!(
            claude_launch(Some(&AgentConv { id: uuid.into(), resume: true })),
            format!("claude --session-id {uuid}")
        );
    }

    /// Engine resolution from the frontend cmd string. None falls back to the
    /// SPIKE_CMD default; anything unknown becomes Custom (the pinned escape
    /// hatch from server.ts).
    #[test]
    fn engine_from_cmd_dispatch() {
        assert_eq!(Engine::from_cmd(Some("claude"), "claude"), Engine::Claude);
        assert_eq!(Engine::from_cmd(Some("codex"), "claude"), Engine::Codex);
        assert_eq!(Engine::from_cmd(Some("shell"), "claude"), Engine::Shell);
        // None → fall back to SPIKE_CMD default
        assert_eq!(Engine::from_cmd(None, "codex"), Engine::Codex);
        assert_eq!(Engine::from_cmd(None, "claude"), Engine::Claude);
        // Unknown → Custom (verbatim command, the pinned contract)
        assert_eq!(Engine::from_cmd(Some("aider"), "claude"), Engine::Custom("aider".into()));
        assert_eq!(Engine::from_cmd(None, "fish"), Engine::Custom("fish".into()));
    }

    /// The `claude mcp list` parser against a real sample: colon-containing
    /// names stay whole, statuses map, header/blank lines are dropped.
    #[test]
    fn parse_mcp_list_real_sample() {
        let sample = "Checking MCP server health…\n\n\
            claude.ai Monarch: https://api.monarch.com/mcp - ✔ Connected\n\
            plugin:vercel:vercel: https://mcp.vercel.com (HTTP) - ✔ Connected\n\
            todoist: https://ai.todoist.net/mcp (HTTP) - ✔ Connected\n\
            linear: https://mcp.linear.app/sse - ! Needs authentication\n\
            broken: https://x.example.com - ✘ Failed to connect\n";
        let servers = super::parse_mcp_list(sample);
        assert_eq!(servers.len(), 5, "header + blank line dropped, 5 servers kept");
        // colon-in-name parses whole (not just "plugin")
        assert_eq!(servers[1]["name"], "plugin:vercel:vercel");
        assert_eq!(servers[1]["url"], "https://mcp.vercel.com");
        assert_eq!(servers[0]["name"], "claude.ai Monarch");
        assert_eq!(servers[0]["status"], "connected");
        assert_eq!(servers[3]["status"], "needs_auth");
        assert_eq!(servers[4]["status"], "failed");
    }

    /// Codex config.toml parser: top-level server tables become entries with
    /// their url; subtables (.env / .http_headers) don't spawn phantom servers.
    #[test]
    fn parse_codex_mcp_toml() {
        let toml = "\
model = \"gpt-5\"\n\
[mcp_servers.notion]\n\
url = \"https://mcp.notion.com/mcp\"\n\
[mcp_servers.local-thing]\n\
command = \"npx\"\n\
args = [\"-y\", \"some-server\"]\n\
[mcp_servers.local-thing.env]\n\
API_KEY = \"x\"\n";
        let servers = super::parse_codex_mcp(toml);
        assert_eq!(servers.len(), 2, "two servers; the .env subtable isn't a third");
        assert_eq!(servers[0]["name"], "notion");
        assert_eq!(servers[0]["url"], "https://mcp.notion.com/mcp");
        assert_eq!(servers[1]["name"], "local-thing");
        assert_eq!(servers[1]["url"], ""); // stdio server, no url
    }

    /// Per-tab CODEX_HOME path: $HOME/.spike/codex-homes/<id>/, so two Codex
    /// tabs in different workspaces never race the same AGENTS.md.
    #[test]
    fn codex_home_dir_is_per_tab() {
        let a = codex_home_dir("abc123");
        let b = codex_home_dir("def456");
        assert_ne!(a, b);
        assert!(a.ends_with(".spike/codex-homes/abc123"));
        assert!(b.ends_with(".spike/codex-homes/def456"));
    }
}
