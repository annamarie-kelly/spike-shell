// ipc.ts - the Tauri transport shim. Every fetch/WebSocket/EventSource the
// frontend used against src/server.ts becomes an invoke() or event listener
// here, exposed as the same verbs app.ts already thinks in. This is the ONLY
// file that knows about @tauri-apps/*; app.ts call sites stay shape-compatible
// with the old HTTP responses (we re-derive `name` etc. where the Rust
// contract slimmed a response down to a bare path).
//
// Casing note: Tauri v2 converts a Rust command's snake_case parameters to
// camelCase keys on the JS side by default - so `new_name` is passed as
// `newName`, `dest_dir` as `destDir`, `data_b64` as `dataB64`. The command
// NAMES themselves stay snake_case.

import { invoke, convertFileSrc, Channel } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open as dialogOpen } from '@tauri-apps/plugin-dialog';

export type { UnlistenFn };

// ── fullscreen ↔ titlebar inset ─────────────────────────────────────────────
// macOS hides the traffic lights in fullscreen, so the bar's 78px left inset
// (html.tauri #bar, index.html) would be dead space. Mirror the window's
// fullscreen state onto <html class="fullscreen"> and let CSS drop the inset.
// Fullscreen transitions always fire a resize, so that's the only hook needed.
// The runtime guard is now vestigial - web mode was deprecated and Spike only
// ever runs inside Tauri - but it's harmless and keeps this module importable
// in a plain test/DOM context without a Tauri runtime.
if ('__TAURI_INTERNALS__' in window) {
  const win = getCurrentWindow();
  const sync = () =>
    win.isFullscreen().then(
      fs => document.documentElement.classList.toggle('fullscreen', fs),
      () => {});
  sync();
  win.onResized(sync);
}

// ── shared shapes (loose on purpose; app.ts is untyped Phase-2 code) ────────
export interface TreeNode { name: string; dir: boolean; path: string; children?: TreeNode[] }
export interface TreeResponse { root: string; path: string; children: TreeNode[] }
export interface FileResponse { path: string; content?: string; binary?: boolean; tooBig?: boolean }

export function setTrafficLightsZoom(factor: number): Promise<void> {
  return invoke('set_traffic_lights_zoom', { factor });
}

// A Rust command rejects with its Err(String). Surface that message when it's
// a real string, else the caller's fallback - keeps the old `d.error ||
// 'x failed'` copy identical.
export function errorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'string' && err.trim()) return err;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

// ── tree / root (old GET /tree, /last) ──────────────────────────────────────
// read_tree is pure now - the old /tree?root= side effects (persist lastRoot,
// re-point the watcher) are the separate setLastRoot/startWatch calls below.
// app.ts's loadTree fires all three together on every (re)root.
export function getTree(root?: string | null): Promise<TreeResponse> {
  return invoke('read_tree', { root: root || null });
}
export function getLastRoot(): Promise<string | null> {
  return invoke('get_last_root');
}
export function setLastRoot(root: string): Promise<void> {
  return invoke('set_last_root', { root });
}
export function startWatch(root: string): Promise<void> {
  return invoke('start_watch', { root });
}

// ── files (old GET/POST /file, /raw) ────────────────────────────────────────
export function readFile(path: string): Promise<FileResponse> {
  return invoke('read_file', { path });
}
export function saveFile(path: string, content: string): Promise<void> {
  return invoke('save_file', { path, content });
}

// ── interactive data tables (datatable.rs) ──────────────────────────────────
// A Spike table: SQLite is the source of truth (one .db per table, hidden under
// <dir>/.spike/tables/), with a human/git-facing <stem>.csv mirror re-exported
// on every mutation. Every mutating verb returns the FRESH doc so the grid
// re-renders from truth (no client-side drift). Rust snake_case params arrive
// camelCased: row_id→rowId, col_key→colKey, col_type→colType.
export type TableColType = 'text' | 'number' | 'date' | 'checkbox' | 'select' | 'multiselect' | 'status' | 'place' | 'url';
export type TableViewKind = 'table' | 'board' | 'gallery' | 'list' | 'calendar';
export type TableNumFormat = 'plain' | 'comma' | 'usd' | 'eur' | 'gbp' | 'percent';
// Status group bucket — orders lanes and (later) draws divider bands.
export type TableOptGroup = 'todo' | 'active' | 'done';
export interface TableOptMeta { color?: string; group?: TableOptGroup }
// Per-option metadata keyed by the option's value. Absent → the value falls back
// to its hash-derived hue (dtHueFor) and no group.
export interface TableColumn { key: string; name: string; type: TableColType; options: string[]; format: TableNumFormat; optionMeta?: Record<string, TableOptMeta> }
export interface TableRow { id: number; cells: Record<string, string> }
export interface TableFilterCond { col: string; op: string; value: string }
// A filter tree node: a rule, or a group (conjunction over rules + sub-groups).
export type TableFilterGroup = { conj: 'and' | 'or'; rules: Array<TableFilterCond | TableFilterGroup> };
export interface TableViewConfig { sort?: { key: string | null; dir: number }; filter?: string; filters?: TableFilterCond[]; filterTree?: TableFilterGroup; groupBy?: string | null; dateField?: string | null; hiddenGroups?: string[]; hideEmpty?: boolean; hiddenCols?: string[] }
export interface TableView { id: string; name: string; kind: TableViewKind; config: TableViewConfig }
export interface TableDoc { path: string; columns: TableColumn[]; rows: TableRow[]; views: TableView[]; meta: Record<string, string> }

// ── Company OS work store ───────────────────────────────────────────────────
// Entities (people + companies), their aliases, facts, relationships, and
// interactions, plus the `@` mention index. See src-tauri/src/workstore.rs.
//
// Every call is scoped by a durable workspace id — NOT the frontend's numeric
// group id, which is a per-boot counter. Resolve it once with workWorkspaceId()
// and pass it along; the backend applies scope and visibility itself, so a
// hidden or out-of-scope entity can never reach this side to be filtered here.

/** One `@` autocomplete result. `rank` is a bucket, 0 = best. */
export interface MentionHit {
  id: string;
  name: string;
  kind: 'person' | 'company';
  /** the alias the query actually matched, so the UI can say why */
  matchedOn: string;
  /** disambiguating line: a person's firm, a company's focus */
  detail: string;
  rank: number;
  /** another entity in scope answers to the same typed text */
  ambiguous: boolean;
}

/** Canonical records behind one entity — the projector's input, not a card. */
export interface EntityRecords {
  id: string;
  kind: 'person' | 'company';
  name: string;
  status: string;
  version: number;
  updatedAt: string;
  aliases: string[];
  facts: Array<{ key: string; value: string; sourceRef: string }>;
  related: Array<{ id: string; name: string; kind: string; relation: string; direction: 'in' | 'out' }>;
  interactions: Array<{ id: string; kind: string; occurredAt: string; summary: string; sourceRef: string }>;
}

export interface ImportReport {
  source: string;
  rows: number;
  peopleCreated: number;
  companiesCreated: number;
  interactions: number;
  facts: number;
  skipped: number;
  warnings: string[];
}

/** The durable `ws_…` id for a workspace name (minted on first ask). */
export function workWorkspaceId(name: string): Promise<string> {
  return invoke('work_workspace_id', { name });
}

/** `@` autocomplete. No model call, no network — a local indexed read. */
export function workMentionLookup(workspaceId: string, query: string, limit?: number): Promise<MentionHit[]> {
  return invoke('work_mention_lookup', { workspaceId, query, limit });
}

/** Records for one entity; null for absent, hidden, and out-of-scope alike. */
export function workEntityCard(workspaceId: string, entityId: string): Promise<EntityRecords | null> {
  return invoke('work_entity_card', { workspaceId, entityId });
}

/** Import a CSV of people/companies. Idempotent — re-running corrects, never duplicates. */
export function workImportCsv(workspaceId: string, path: string): Promise<ImportReport> {
  return invoke('work_import_csv', { workspaceId, path });
}

export function workEntities(
  workspaceId: string,
  limit?: number,
): Promise<Array<{ id: string; name: string; kind: string; updatedAt: string; interactions: number }>> {
  return invoke('work_entities', { workspaceId, limit });
}

export function workSetVisibility(workspaceId: string, entityId: string, hidden: boolean): Promise<void> {
  return invoke('work_set_visibility', { workspaceId, entityId, hidden });
}

export function tableStatus(path: string): Promise<{ backed: boolean; tablePath: string; isTable: boolean }> {
  return invoke('table_status', { path });
}
export function tableRead(path: string): Promise<TableDoc> {
  return invoke('table_read', { path });
}
// Adopt a plain csv → creates a sibling `.spiketable` (returns the doc, whose
// `path` is that new .spiketable — the source of truth to open/mutate).
export function tableImportCsv(path: string): Promise<TableDoc> {
  return invoke('table_import_csv', { path });
}
// On-demand "Export CSV" — writes a sibling `<stem>.csv`; returns its path.
export function tableExportCsv(path: string): Promise<string> {
  return invoke('table_export_csv', { path });
}
export function tableCreate(path: string): Promise<TableDoc> {
  return invoke('table_create', { path });
}
export function tableSetCell(path: string, rowId: number, colKey: string, value: string): Promise<TableDoc> {
  return invoke('table_set_cell', { path, rowId, colKey, value });
}
export function tableAddRow(path: string): Promise<TableDoc> {
  return invoke('table_add_row', { path });
}
export function tableDeleteRow(path: string, rowId: number): Promise<TableDoc> {
  return invoke('table_delete_row', { path, rowId });
}
export function tableAddColumn(path: string, name: string, colType: TableColType, options?: string[]): Promise<TableDoc> {
  return invoke('table_add_column', { path, name, colType, options: options ?? [] });
}
export function tableRenameColumn(path: string, colKey: string, name: string): Promise<TableDoc> {
  return invoke('table_rename_column', { path, colKey, name });
}
export function tableRetypeColumn(path: string, colKey: string, colType: TableColType, options?: string[]): Promise<TableDoc> {
  return invoke('table_retype_column', { path, colKey, colType, options: options ?? [] });
}
export function tableDeleteColumn(path: string, colKey: string): Promise<TableDoc> {
  return invoke('table_delete_column', { path, colKey });
}
export function tableDuplicateColumn(path: string, colKey: string): Promise<TableDoc> {
  return invoke('table_duplicate_column', { path, colKey });
}
export function tableSetColumnFormat(path: string, colKey: string, format: TableNumFormat): Promise<TableDoc> {
  return invoke('table_set_column_format', { path, colKey, format });
}
// Set the full ordered option list for a select/multiselect/status column, each
// with its chosen color + (status) group. Reorder/recolor/regroup/add/delete in
// one call; any value dropped from `options` is cleared from every row cell.
export interface TableOptionInput { value: string; color?: string | null; group?: TableOptGroup | null }
export function tableSetOptions(path: string, colKey: string, options: TableOptionInput[]): Promise<TableDoc> {
  return invoke('table_set_options', { path, colKey, options });
}
// Rename an option value from→to (migrates its color/group + every row cell).
export function tableRenameOption(path: string, colKey: string, from: string, to: string): Promise<TableDoc> {
  return invoke('table_rename_option', { path, colKey, from, to });
}
export function tableReorderColumns(path: string, keys: string[]): Promise<TableDoc> {
  return invoke('table_reorder_columns', { path, keys });
}
export function tableAddView(path: string, name: string, kind: TableViewKind): Promise<TableDoc> {
  return invoke('table_add_view', { path, name, kind });
}
export function tableUpdateView(path: string, id: string, name?: string | null, config?: TableViewConfig | null, kind?: TableViewKind | null): Promise<TableDoc> {
  return invoke('table_update_view', { path, id, name: name ?? null, config: config ?? null, kind: kind ?? null });
}
export function tableDeleteView(path: string, id: string): Promise<TableDoc> {
  return invoke('table_delete_view', { path, id });
}
// Set a display-metadata key ("title" | "icon"); empty value clears it.
export function tableSetMeta(path: string, key: string, value: string): Promise<TableDoc> {
  return invoke('table_set_meta', { path, key, value });
}

// ── learn-the-voice ─────────────────────────────────────────────────────────
// Record one before/after edit of agent-written prose to a workspace's voice
// log. Returns the count of edits not yet distilled (caller thresholds on it).
export function recordVoiceEdit(
  slug: string, path: string, before: string, after: string,
): Promise<number> {
  return invoke('record_voice_edit', { slug, path, before, after });
}
// Distill accumulated edits into candidate DO/DON'T directives (headless LLM).
export function analyzeVoice(slug: string): Promise<{ do: string[]; dont: string[] }> {
  return invoke('analyze_voice', { slug });
}
// Record that the user rejected some candidate directives (won't re-propose).
export function voiceDismiss(slug: string, items: string[]): Promise<void> {
  return invoke('voice_dismiss', { slug, items });
}
// Name a workstream from its opening message via a fast headless `claude -p
// --model haiku` (subscription-billed). Returns a 2–5 word title, or '' if the
// call failed / produced nothing usable (caller keeps the derived label).
export function titleWorkstream(firstMessage: string): Promise<string> {
  return invoke('title_workstream', { firstMessage });
}
// The real on-disk slash commands + skills for the composer's "/" menu:
// <cwd>/.claude/{commands,skills} + ~/.claude/{commands,skills}. Each entry is
// { name: '/foo', desc, source: 'command'|'skill', scope: 'project'|'user' }.
// The frontend merges these UNDER Claude Code's built-in list. Never throws for
// the caller — a missing dir just yields fewer entries; on error returns [].
export function listSlashCommands(cwd?: string): Promise<Array<{ name: string; desc: string; source: string; scope: string }>> {
  return invoke('list_slash_commands', { cwd: cwd || null }).then((v) => (Array.isArray(v) ? v : [])).catch(() => []);
}
// HTML preview is served over the private `spikehtml://` scheme, not `srcdoc`:
// a srcdoc iframe inherits the app's strict `script-src` (no 'unsafe-inline'),
// which silently blocks every inline <script> in the previewed page. A real
// navigation to a scheme we serve doesn't inherit that CSP, so the page's JS
// runs. `content` is the file text + the SPIKE_BRIDGE script (assembled by the
// caller); returns the URL to point the sandboxed iframe at.
export function registerHtmlPreview(path: string, content: string): Promise<string> {
  return invoke('html_preview_register', { path, content });
}
// The one shape change in the whole port: `/raw?path=` URLs (img/pdf/media
// src, drag-out URLs) become Tauri asset-protocol URLs.
export function rawSrc(path: string): string {
  return convertFileSrc(path);
}

// ── file management (old /rename, /delete, /move, /create) ──────────────────
// rename/move/create return a bare new-path String from Rust; the old JSON
// also carried `name`, so we derive it via basename here.
const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);

export async function renamePath(path: string, newName: string): Promise<{ path: string; name: string }> {
  const dest = await invoke<string>('rename_path', { path, newName });
  return { path: dest, name: basename(dest) };
}
export function trashPath(path: string): Promise<void> {
  return invoke('trash_path', { path });
}
export async function movePath(src: string, destDir: string): Promise<{ path: string; name: string }> {
  const dest = await invoke<string>('move_path', { src, destDir });
  return { path: dest, name: basename(dest) };
}
// Copy a file/folder INTO destDir (Finder → vault import). De-dups on collision.
export async function copyPath(src: string, destDir: string): Promise<{ path: string; name: string }> {
  const dest = await invoke<string>('copy_path', { src, destDir });
  return { path: dest, name: basename(dest) };
}
export async function createPath(dir: string, name: string, kind: string): Promise<{ path: string; name: string; kind: string }> {
  const dest = await invoke<string>('create_path', { dir, name, kind });
  return { path: dest, name: basename(dest), kind };
}

// ── image ingestion (old /drop-image, /ingest-path) ─────────────────────────
// Both resolve to the temp copy's absolute path (old {ok, path}).
export function dropImage(dataB64: string, name?: string | null): Promise<string> {
  return invoke('drop_image', { dataB64, name: name || null });
}
export function ingestPath(path: string): Promise<string> {
  return invoke('ingest_path', { path });
}
// Image file → macOS clipboard, so a Ctrl+V into the pty lands it as Claude
// Code's native [Image #N] chip. PNG/JPEG only; rejects otherwise.
export function clipboardSetImage(path: string): Promise<void> {
  return invoke('clipboard_set_image', { path });
}

// ── native drag-drop (Tauri only) ───────────────────────────────────────────
// The OS-level drag handler (dragDropEnabled in tauri.conf.json) is the only
// channel that gets a real filesystem path for every drag flavor - most
// importantly the macOS screenshot THUMBNAIL, whose file-promise drop hands
// the DOM no bytes and no path (see Session.wireDrop). Positions arrive in
// physical pixels; converted to CSS px here so callers can elementFromPoint()
// directly. 'over' events carry no paths; 'leave' carries neither.
export interface NativeDrag {
  type: 'enter' | 'over' | 'drop' | 'leave';
  paths: string[];
  x: number;
  y: number;
}
export function onNativeDrag(cb: (e: NativeDrag) => void): Promise<UnlistenFn> {
  if (!('__TAURI_INTERNALS__' in window)) return Promise.resolve(() => {});  // legacy web bundle
  return getCurrentWebview().onDragDropEvent((event) => {
    const p = event.payload as any;
    const scale = window.devicePixelRatio || 1;
    cb({
      type: p.type,
      paths: p.paths || [],
      x: p.position ? p.position.x / scale : 0,
      y: p.position ? p.position.y / scale : 0,
    });
  });
}

// ── action log + focus (old /log, /focus) ───────────────────────────────────
export function logEvent(action: string, payload?: Record<string, unknown>): Promise<void> {
  return invoke('log_event', { entry: { action, ...(payload || {}) } });
}
export function setFocus(payload: unknown): Promise<void> {
  return invoke('set_focus', { payload });
}

// ── folder picker (old GET /pick, was osascript) ────────────────────────────
// Resolves to the chosen absolute path, or null when the user cancelled.
// Throws only if the dialog plugin itself fails (caller falls back to typing).
export async function pickFolder(): Promise<string | null> {
  const picked = await dialogOpen({ directory: true, multiple: false });
  return typeof picked === 'string' && picked ? picked : null;
}
// File picker (settings: pin a file). Same contract as pickFolder.
export async function pickFile(): Promise<string | null> {
  const picked = await dialogOpen({ directory: false, multiple: false });
  return typeof picked === 'string' && picked ? picked : null;
}
// Image picker (doc preview: insert an image) — same contract as pickFile, but
// the OS dialog is filtered to image types so the user can't pick a non-image.
export async function pickImage(): Promise<string | null> {
  const picked = await dialogOpen({
    directory: false, multiple: false,
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg', 'heic', 'tiff', 'tif'] }],
  });
  return typeof picked === 'string' && picked ? picked : null;
}
// Multi-file picker (chat composer's "+" attach). Resolves to the chosen
// absolute paths, or [] when the user cancelled. `multiple: true` makes the
// plugin return an array of strings.
export async function pickFiles(): Promise<string[]> {
  const picked = await dialogOpen({ directory: false, multiple: true });
  if (Array.isArray(picked)) return picked.filter((p): p is string => typeof p === 'string');
  return typeof picked === 'string' && picked ? [picked] : [];
}

// ── group workspaces (old GET/PUT/DELETE /groups) ───────────────────────────
export function listGroups(): Promise<any[]> {
  return invoke('list_groups');
}
export function saveGroup(group: unknown): Promise<void> {
  return invoke('save_group', { group });
}
export function deleteGroup(name: string): Promise<void> {
  return invoke('delete_group', { name });
}

// ── config (old GET/PATCH /config) ──────────────────────────────────────────
export function getConfig(): Promise<any> {
  return invoke('get_config');
}
// Pinned docs live in ~/.spike/pins.json, NOT in config.json — every settings
// writer rewrites the config wholesale, and pins kept disappearing in the
// crossfire. pinsGet migrates the old config key on first read.
export function pinsGet(): Promise<any[]> {
  return invoke('pins_get');
}
export function pinsSet(pins: unknown[]): Promise<any[]> {
  return invoke('pins_set', { pins });
}
export function patchConfig(patch: unknown): Promise<any> {
  return invoke('patch_config', { patch });
}
// The theme id to hand a RUNNING agent via `/config theme=<value>`, with the
// user's variant preserved (light-daltonized → dark-daltonized). `mode` must
// already be resolved to 'light' | 'dark'. null = leave this user's theme alone
// (custom/auto). It always returns the target id for the wanted side, even when
// settings.json already reads it - the caller gates per-pane on the live theme,
// since a pane can be painted on the other side from the persisted setting.
// Read-only: Claude persists the change itself when it runs the command.
export function agentThemeCommand(mode: string): Promise<string | null> {
  return invoke('agent_theme_command', { mode });
}

// ── settings v2 helpers ─────────────────────────────────────────────────────
// Is this directory inside a git work tree? (drives the Auto-worktree segment)
export function gitRepoCheck(path: string): Promise<boolean> {
  return invoke('git_repo_check', { path });
}
// Active-work auto-context: resolve a cwd's branch + open PR for the status line.
// Always resolves (never rejects) - fields are absent when not a repo / no PR.
export function resolveAutoContext(cwd: string): Promise<{ branch?: string; prNumber?: number; prUrl?: string; isWorktree?: boolean }> {
  return invoke('resolve_auto_context', { cwd });
}
// Engine detection: powers the first-run modal and the Settings "Default engine"
// zone (live status text). Read-only - does not modify any engine state.
//   claude: present if the `claude` binary resolves on PATH.
//   codex.installed: same for `codex`.
//   codex.authed: ~/.codex/auth.json exists (the shim symlinks it through);
//                 false → the shim will print a "run codex login" hint.
export interface EngineDetection {
  claude: { installed: boolean; path?: string | null };
  codex:  { installed: boolean; path?: string | null; authed: boolean };
}
export function detectEngines(): Promise<EngineDetection> {
  return invoke('detect_engines');
}
// On-disk size of each pinned path (files: byte length; dirs: recursive sum),
// for the context editor's token estimates. Relative paths resolve against
// `base` (the workspace cwd).
export interface PathStat { path: string; exists: boolean; dir: boolean; bytes: number }
export function pathStats(base: string | null, paths: string[]): Promise<PathStat[]> {
  return invoke('path_stats', { base, paths });
}
// A finished auto-worktree needs the user (conflict / dirty / ask policy):
// the engine emits `worktree:ask`; the page shows merge / keep / discard and
// answers through worktree_resolve. Resolves to a one-line outcome message.
export interface WorktreeAsk { repoRoot: string; path: string; branch: string; base: string; reason: string }
export function onWorktreeAsk(cb: (ask: WorktreeAsk) => void): Promise<UnlistenFn> {
  return listen<WorktreeAsk>('worktree:ask', (e) => cb(e.payload));
}
export function worktreeResolve(ask: WorktreeAsk, choice: 'merge' | 'keep' | 'discard'): Promise<string> {
  return invoke('worktree_resolve', {
    repoRoot: ask.repoRoot, path: ask.path, branch: ask.branch, base: ask.base, choice,
  });
}

// Claude Code token-usage accounting (Settings → Usage). Read-only scan of
// ~/.claude/projects/*.jsonl transcripts; `cost` is NOTIONAL (API list price),
// not what a Pro/Max subscription is actually billed. All token fields are
// deduped per assistant turn backend-side.
export interface UsageBucket {
  input: number; output: number; cacheCreate: number; cacheRead: number;
  cost: number; messages: number;
}
export interface UsageTotals extends UsageBucket { sessions: number; scannedFiles: number }
export interface UsageReport {
  totals: UsageTotals;
  byModel: Array<UsageBucket & { model: string }>;
  byDay: Array<UsageBucket & { day: string }>;
  byProject: Array<UsageBucket & { project: string }>;
  truncatedProjects: number;
}
export function usageScan(): Promise<UsageReport> {
  return invoke('usage_scan');
}
// Live context occupancy for a single Claude Code session, keyed by its run_id
// (the transcript JSONL filename stem - the `run_id` carried on every agent
// event). Point-in-time, not cumulative: the latest assistant turn's non-output
// token footprint over the model's context window. `found:false` means no
// transcript / no turn yet (fresh session) - render no bar.
export interface SessionContext {
  tokens: number; contextWindow: number; percent: number;
  model: string; found: boolean;
}
export function sessionContext(runId: string, cwd?: string): Promise<SessionContext> {
  return invoke('session_context', { runId: runId || '', cwd: cwd || null });
}
// Raw transcript lines a lane's agent has appended since `offset`, for either
// engine. This is what the chat view renders from - the CLI's own JSONL, not
// the PTY stream (see chatview.ts on why parsing a redrawing TUI is a losing
// game). Incremental by byte offset: pass back the offset you were given and
// you get only what's new. `reset` means the file was replaced (a /clear), so
// drop what you have; `found:false` means no transcript yet, which is the
// normal state of a lane whose first turn hasn't landed.
export interface TranscriptTail {
  found: boolean;
  path?: string;
  engine?: 'claude' | 'codex';
  offset: number;
  reset?: boolean;
  truncated?: boolean;
  lines: string[];
}
export function transcriptTail(runId: string, cwd: string | undefined, offset: number, ptyId?: string | null): Promise<TranscriptTail> {
  // ptyId is the Codex fallback key: a Codex tab owns a CODEX_HOME named after
  // it, so its rollout is findable even before the first hook event gives the
  // lane a run_id (and if the hook never fires at all).
  return invoke('transcript_tail', { runId: runId || '', cwd: cwd || null, offset, ptyId: ptyId || null });
}
// A native (Claude Task/Agent) subagent of a session, for the watch strip. Read
// from <session>/subagents/ — description names it, narration is its latest line,
// done means its Task returned a result in the parent transcript.
export interface NativeSubagent {
  agentId: string;
  description: string;
  agentType: string;
  toolUseId: string;
  narration: string;
  done: boolean;
  ts: number;
}
export function agentSubagents(runId: string, cwd?: string): Promise<NativeSubagent[]> {
  return invoke('agent_subagents', { runId: runId || '', cwd: cwd || null });
}
// Incremental tail of ONE native subagent's own transcript (for the read-only
// click-in viewer). Same shape as transcriptTail.
export function agentSubagentTail(runId: string, cwd: string | undefined, agentId: string, offset: number): Promise<TranscriptTail> {
  return invoke('agent_subagent_tail', { runId: runId || '', cwd: cwd || null, agentId, offset });
}
// How the user is signed in to Claude Code — read from ~/.claude.json (no
// secrets; plan tier + billing type only). Lets the Usage pane auto-detect the
// plan and frame cost as notional (subscription) vs actual (API key).
export interface ClaudeAccount {
  authType: 'subscription' | 'api' | 'unknown';
  plan: 'max_20x' | 'max_5x' | 'pro' | null;
  planUsd: number | null;
  organizationType: string;
  subscriptionCreatedAt: string | null;
}
export function claudeAccount(): Promise<ClaudeAccount> {
  return invoke('claude_account');
}

// Codex stores cumulative token snapshots in rollout JSONL files. The backend
// scans normal ~/.codex sessions plus Spike's isolated per-tab CODEX_HOMEs and
// deduplicates them by session id. `cachedInput` is included in `input`, and
// `reasoningOutput` is included in `output` - both are detail fields, not extra
// tokens to add to the total.
export interface CodexUsageBucket {
  input: number; cachedInput: number; output: number; reasoningOutput: number;
  credits: number; cost: number; requests: number;
}
export interface CodexUsageTotals extends CodexUsageBucket { sessions: number; scannedFiles: number }
export interface CodexUsageReport {
  totals: CodexUsageTotals;
  byModel: Array<CodexUsageBucket & { model: string }>;
  byDay: Array<CodexUsageBucket & { day: string }>;
  byProject: Array<CodexUsageBucket & { project: string }>;
  truncatedProjects: number;
  unpricedModels: string[];
}
export function codexUsageScan(): Promise<CodexUsageReport> {
  return invoke('codex_usage_scan');
}
export interface CodexAccount {
  authType: 'chatgpt' | 'api' | 'unknown';
}
export function codexAccount(): Promise<CodexAccount> {
  return invoke('codex_account');
}

// ── settings panel helpers ──────────────────────────────────────────────────
// Open ~/.spike/logs in the system file manager (the "Open log directory →"
// link). The path is fixed backend-side.
export function openLogDir(): Promise<void> {
  return invoke('open_log_dir');
}
// Open an http(s) URL in the system browser - links clicked inside an HTML
// preview route here instead of navigating the sandboxed iframe. The backend
// enforces the http(s)-only scheme check.
export function openExternal(url: string): Promise<void> {
  return invoke('open_external', { url });
}
// Launch a second, independent Spike instance (⌘N). One window per process by
// design, so a "new window" is a fresh OS process; each gets its own CLI port.
export function newInstance(): Promise<void> {
  return invoke('new_instance');
}
// Reveal a file in Finder (selects it). Backend runs `open -R`.
export function revealPath(path: string): Promise<void> {
  return invoke('reveal_path', { path });
}
// Resolve an inline permission prompt: the blocked PermissionRequest hook is
// polling for this decision. `decision` is the option id
// (allow_once|allow_session|deny).
export function agentPermissionAnswer(promptId: string, decision: string): Promise<void> {
  return invoke('agent_permission_answer', { promptId, decision });
}
// The permission rules in effect for a workspace, per scope, for Settings.
// Rejects rather than resolving when a settings file exists but doesn't parse,
// so the pane can refuse to edit a file it couldn't read.
export function permissionRules(cwd: string): Promise<{ defaults: string[]; workspace: string[]; mode: string }> {
  return invoke('permission_rules', { cwd });
}
// Replace one scope's rule list wholesale — what removing a permission calls.
// Nothing in Spike ADDS a rule: rules are authored and persisted by Claude via
// the PermissionRequest hook's updatedPermissions.
export function permissionRulesSet(cwd: string, scope: 'defaults' | 'workspace', rules: string[], mode?: string): Promise<void> {
  return invoke('permission_rules_set', { cwd, scope, rules, mode });
}
// Show the native macOS share sheet for a file, anchored near (x,y) in window
// coordinates. Backend drives NSSharingServicePicker on the main thread.
export function shareFile(path: string, x: number, y: number): Promise<void> {
  return invoke('share_file', { path, x, y });
}
// Fetch an http(s) URL's raw HTML for the in-app reader (link → readable
// article in the preview). Backend shells out to curl; http(s)-only, capped.
export function fetchUrl(url: string): Promise<string> {
  return invoke('fetch_url', { url });
}

// ── in-pane browser: a native child webview pinned over the preview pane ──────
// `spike open http(s)://…` shows the live page (any host). An <iframe> underfills
// a width=device-width page in WebKit, so we float a real Tauri child webview over
// the pane instead (pixel-perfect, 1:1). The page drives placement: it calls
// show() with the pane's CSS-px rect (inset below the chrome strip) on every
// layout/resize/overlay change, hide() when an overlay could occlude it, close()
// when the board is gone. back/forward/reload drive the child's own history;
// onLiveNav reports the child's real URL so the address bar/tab name track it.
// `focus` = "safe to take keyboard focus". Showing the board makes it first
// responder (a hover-cursor workaround, see live_webview.rs), which blurs the
// DOM - pass false while a real text edit is open or the re-show will kill it.
export function liveWebviewShow(url: string, x: number, y: number, width: number, height: number, focus = true): Promise<void> {
  return invoke('live_webview_show', { url, x, y, width, height, focus });
}
export function liveWebviewHide(): Promise<void> {
  return invoke('live_webview_hide');
}
export function liveWebviewClose(): Promise<void> {
  return invoke('live_webview_close');
}
export function liveWebviewBack(): Promise<void> {
  return invoke('live_webview_back');
}
export function liveWebviewForward(): Promise<void> {
  return invoke('live_webview_forward');
}
export function liveWebviewReload(): Promise<void> {
  return invoke('live_webview_reload');
}
// Open the board's Web Inspector. Dev-only by design: the inspector is compiled
// out of release builds (see Cargo.toml), so this is a no-op there.
export function liveWebviewDevtools(): Promise<void> {
  return invoke('live_webview_devtools');
}
// The child webview's current URL (reflects SPA pushState routes + redirects);
// polled by the page to keep the address bar matched to the real location.
export function liveWebviewUrl(): Promise<string | null> {
  return invoke('live_webview_url');
}
// Tell the native side whether a preview is expanded (full-screen), so its key
// monitor knows when Escape should exit full-screen instead of reaching the page.
export function liveWebviewSetExpanded(on: boolean): Promise<void> {
  return invoke('live_webview_set_expanded', { on });
}
// Escape was pressed while full-screen (the native monitor caught it, even when
// the browser child had focus). The page collapses the expanded preview.
export function onBrowserEsc(cb: () => void): Promise<UnlistenFn> {
  return listen('browser-esc', () => cb());
}
// Subscribe to the child webview's navigations (link click, redirect, address-bar
// submit). Returns an unlisten fn; dispose it when the board is gone.
export function onLiveNav(cb: (url: string) => void): Promise<UnlistenFn> {
  return listen<{ url: string }>('live-nav', (e) => cb(e.payload.url));
}
// A target=_blank / window.open the child tried to open in a NEW window. We keep
// it in-pane instead: this fires with the URL so the page navigates the one board
// to it (rather than the OS browser). Returns an unlisten fn.
export function onLiveOpen(cb: (url: string) => void): Promise<UnlistenFn> {
  return listen<{ url: string }>('live-open', (e) => cb(e.payload.url));
}
// Open the top-level Google sign-in window (Google refuses sign-in in the
// embedded pane webview). `returnUrl` is where the pane should go once auth
// completes - the `continue=` target Docs was bounced from.
export function googleSigninShow(url: string, returnUrl?: string): Promise<void> {
  return invoke('google_signin_show', { url, returnUrl: returnUrl ?? null });
}
export function googleSigninClose(): Promise<void> {
  return invoke('google_signin_close');
}
// Fires when the sign-in window finishes auth (redirect off accounts.google.com).
// Payload url is the returnUrl to point the pane at, now authenticated.
export function onGoogleSigninDone(cb: (url: string) => void): Promise<UnlistenFn> {
  return listen<{ url: string }>('google-signin-done', (e) => cb(e.payload.url));
}
// The sign-in window was destroyed without completing (the user closed it, or
// gave up). Lets the page release the pane it parked behind the placeholder.
// Also fires on the ordinary close-after-success, so the handler must be
// idempotent.
export function onGoogleSigninCancelled(cb: () => void): Promise<UnlistenFn> {
  return listen('google-signin-cancelled', () => cb());
}
// The user's home dir (no trailing slash), for building ~/.spike/... paths in
// the page (workspace context .md previews). Tauri path API under the hood.
export async function getHomeDir(): Promise<string> {
  const { homeDir } = await import('@tauri-apps/api/path');
  const h = await homeDir();
  return h.replace(/\/+$/, '');
}

// ── PTY (old WebSocket protocol: init / in / resize / out / exit) ───────────
// One pty_spawn per session id; output streams back over a tauri::ipc::Channel
// passed as a spawn argument (Tauri's stream mechanism - ordered, per-session,
// and cheaper on the hot path than per-chunk named events). Exit stays a
// `pty:exit:{id}` event: it fires once, so event overhead doesn't matter.
// The old WS init payload (cwd, theme, cmd, group) rides on the spawn call,
// plus cols/rows so the first paint is sized right (the old protocol sized via
// a first resize message).
export interface PtySpawnOpts {
  id: string;
  cwd: string;
  cols: number;
  rows: number;
  theme?: string | null;   // 'light' | 'dark' - COLORFGBG hint
  cmd?: 'claude' | 'codex' | 'shell' | string | null;  // engine for the embedded session; unknown strings run verbatim (Custom)
  group?: string | null;   // workspace whose prompt binds at spawn
  // The Claude conversation this lane owns. Spike mints the id (a uuid) instead
  // of letting Claude Code pick one, because the id IS the transcript filename:
  // owning it means the lane can read its own context occupancy from spawn, and
  // means restore can pick the same conversation back up. Claude only - other
  // engines ignore it. `resume: true` continues that conversation (`--resume`);
  // false starts it (`--session-id`). Rust downgrades a resume to a fresh start
  // if the transcript is gone, so a stale id can't strand the lane in a shell.
  agentSessionId?: string | null;
  resume?: boolean;
  // True when this lane is a spawned subagent — Rust folds the worker guidance
  // into its system prompt (report up, don't spawn) instead of the orchestrator
  // guidance a top-level lane gets.
  subagent?: boolean;
}
// `onOut` is wired to the channel BEFORE the invoke fires, so no early output
// chunk can be lost. The channel dies with the pty (Rust side drops its
// sender at reader-thread exit); there is nothing to unlisten.
// Resolves to the dir the agent actually launched in (the isolated worktree
// path when auto-worktree kicked in, else the requested cwd) - the caller
// resolves the branch/PR badge from this, not the workspace's configured cwd.
export function ptySpawn(opts: PtySpawnOpts, onOut: (chunk: string) => void): Promise<string> {
  const out = new Channel<string>();
  out.onmessage = onOut;
  return invoke('pty_spawn', {
    id: opts.id, cwd: opts.cwd, cols: opts.cols, rows: opts.rows,
    theme: opts.theme || null, cmd: opts.cmd || null, group: opts.group || null,
    agentSessionId: opts.agentSessionId || null, resume: opts.resume || false,
    subagent: opts.subagent || false,
    onOut: out,
  });
}
// Hand a live session off to a fresh, briefed agent. The backend
// (pty_handoff_spawn) resolves the source lane's authoritative state, forks one
// worktree from its HEAD, carries the uncommitted snapshot, composes the
// engine-neutral bundle, and spawns the target - atomically. Resolves to the
// dir the target launched in (the forked worktree when branch&diff was carried).
export interface PtyHandoffOpts {
  sourceId: string;                 // the live lane to hand off FROM
  id: string;                       // the new target session id
  cwd: string;                      // fallback cwd if the source isn't a repo
  cols: number;
  rows: number;
  theme?: string | null;
  cmd: 'claude' | 'codex';          // target engine (briefable only)
  agentSessionId?: string | null;   // conversation id for the target; always a fresh start
  recap: string;                    // user-edited summary (trusted)
  includeFiles: boolean;
  includeBranchDiff: boolean;
  includeWorkspace: boolean;
  includeActivity: boolean;
  // True for a write-mode subagent (own worktree) → worker guidance, not the
  // orchestrator guidance a human "hand off to new agent" continuation gets.
  subagent?: boolean;
}
export function ptyHandoffSpawn(opts: PtyHandoffOpts, onOut: (chunk: string) => void): Promise<string> {
  const out = new Channel<string>();
  out.onmessage = onOut;
  return invoke('pty_handoff_spawn', {
    sourceId: opts.sourceId, id: opts.id, cwd: opts.cwd, cols: opts.cols, rows: opts.rows,
    theme: opts.theme || null, cmd: opts.cmd, recap: opts.recap,
    agentSessionId: opts.agentSessionId || null,
    includeFiles: opts.includeFiles, includeBranchDiff: opts.includeBranchDiff,
    includeWorkspace: opts.includeWorkspace, includeActivity: opts.includeActivity,
    subagent: opts.subagent || false,
    onOut: out,
  });
}
export function ptyWrite(id: string, data: string): Promise<void> {
  return invoke('pty_write', { id, data });
}
// Keep Claude Code's custom "spike" theme in step with ours. Update-only and
// scoped to ~/.claude/themes/spike.json - see pty::sync_claude_theme.
export function syncClaudeTheme(mode: string): Promise<void> {
  return invoke('sync_claude_theme', { mode });
}
export function ptyResize(id: string, cols: number, rows: number): Promise<void> {
  return invoke('pty_resize', { id, cols, rows });
}
export function ptyKill(id: string): Promise<void> {
  return invoke('pty_kill', { id });
}

// ── MCP connectors ───────────────────────────────────────────────────────────
// Thin wrappers over the `claude mcp …` subcommands (pty.rs). The Connectors
// settings pane uses these so a non-technical user can add a remote MCP server
// and run its OAuth sign-in without ever touching the terminal. `scope` maps to
// Claude Code's --scope: 'user' (default) = every workspace, 'project' = shared
// via the repo's .mcp.json, 'local' = this project, private.
export type McpScope = 'user' | 'project' | 'local';
export type McpStatus = 'connected' | 'needs_auth' | 'failed' | 'pending' | 'unknown';
// Which agent CLI a connector op targets. Both expose `mcp add/list/remove/login`
// but write to SEPARATE config (claude → ~/.claude.json, codex → ~/.codex/config.toml).
export type McpEngine = 'claude' | 'codex';
export interface McpServer { name: string; url: string; status: McpStatus; line: string }
// Read configured servers + status. Claude gives live status via `claude mcp
// list`; Codex is parsed from config.toml (status "unknown" - its `mcp list`
// hangs on unauthenticated remotes).
export function mcpList(engine: McpEngine = 'claude'): Promise<{ servers: McpServer[]; raw: string }> {
  return invoke('mcp_list', { engine });
}
// Register a remote MCP server (claude: `claude mcp add`; codex: `codex mcp add --url`).
export function mcpAdd(engine: McpEngine, name: string, transport: 'http' | 'sse', url: string, scope: McpScope = 'user'): Promise<void> {
  return invoke('mcp_add', { engine, name, transport, url, scope });
}
// Remove a configured server.
export function mcpRemove(engine: McpEngine, name: string, scope: McpScope = 'user'): Promise<void> {
  return invoke('mcp_remove', { engine, name, scope });
}
// Run a server's OAuth sign-in (`<engine> mcp login <name>`) in a pty; the flow
// opens a browser and waits for the redirect. Output rides the channel; the
// returned id feeds onPtyExit (fires when sign-in completes) and ptyKill (to
// cancel). Deterministic id `mcplogin:<engine>:<name>` so a retry replaces it.
export function mcpLoginSpawn(engine: McpEngine, name: string, onOut: (chunk: string) => void): Promise<string> {
  const out = new Channel<string>();
  out.onmessage = onOut;
  const id = `mcplogin:${engine}:${name}`;
  return invoke('mcp_login_spawn', { engine, name, id, onOut: out }).then(() => id);
}

// ── event subscriptions ─────────────────────────────────────────────────────
// Each returns the unlisten function; callers hold it and call it on teardown
// (Session.close disposes its pty listeners; the page-level ones live forever).
// PTY *output* is not here - it rides the ptySpawn channel above.
export function onPtyExit(id: string, cb: (code: number) => void): Promise<UnlistenFn> {
  return listen<number>(`pty:exit:${id}`, (e) => cb(e.payload));
}
// The watcher's burst-coalesced refresh (old SSE {kind:'tree', changed}).
export function onTreeChanged(cb: (changed: string[]) => void): Promise<UnlistenFn> {
  return listen<{ changed?: string[] }>('tree:changed', (e) => cb((e.payload && e.payload.changed) || []));
}
// `spike open` from the CLI listener (old SSE {kind:'open'|'project', path}).
// sessionId - the lane that fired the open (forwarded from $SPIKE_SESSION_ID);
// undefined when `spike` ran outside a Spike-spawned pty. Lets the page
// attribute the preview to the owning lane.
export function onOpen(cb: (msg: { kind: string; path: string; sessionId?: string }) => void): Promise<UnlistenFn> {
  return listen<{ kind: string; path: string; sessionId?: string }>('open', (e) => cb(e.payload));
}

// ── template bundles (Stage 0 declarative export/import) ─────────────────────
// Rust owns bundle IO: write/read a set of bundle-relative files under a dir,
// and append the provenance ledger. The page owns bundle *semantics* (which
// files, what format). write/read use a plain { path: contents } map.
export function writeBundle(dir: string, files: Record<string, string>): Promise<void> {
  return invoke('write_bundle', { dir, files });
}
export function readBundle(dir: string): Promise<Record<string, string>> {
  return invoke('read_bundle', { dir });
}
export function recordInstalledTemplate(entry: unknown): Promise<any> {
  return invoke('record_installed_template', { entry });
}
// `~/.spike/templates` - the canonical home for exported bundles. The frontend
// has no home-dir access, so Rust resolves it; the page writes to <dir>/<name>.
export function templatesDir(): Promise<string> {
  return invoke('templates_dir');
}
// Group bundling (Stage 1): readGroupSteering lifts the user-owned .md tail for
// export; installGroup writes a group on the receiving machine (block from json
// + spliced steering), returning the name actually written.
export function readGroupSteering(name: string): Promise<string> {
  return invoke('read_group_steering', { name });
}
export function installGroup(group: unknown, steering: string): Promise<string> {
  return invoke('install_group', { group, steering });
}
// Install gate (executable tier): parse + integrity-verify a bundle, returning
// the 3-tier plan { template, version, verified, violations, tiers:{declarative,
// executable, high_risk} }. The page MUST refuse to apply when verified=false.
export interface BundlePlanItem { kind: string; label: string; detail: string }
export interface BundlePlan {
  template: string; version: string; author: string; description: string;
  spike_min_version: string; scope: 'project' | 'global'; verified: boolean; violations: string[];
  tiers: { declarative: BundlePlanItem[]; executable: BundlePlanItem[]; high_risk: BundlePlanItem[] };
}
export function verifyBundle(dir: string): Promise<BundlePlan> {
  return invoke('verify_bundle', { dir });
}
// Apply the approved executable/high-risk tiers of a verified bundle into the
// scope-resolved Claude config, merge-never-clobber. `root` is the absolute
// project path (required for project scope; ignored for global). Returns the
// applied items (for the ledger) and skipped items (collisions, surfaced to the
// user). CALL ONLY when plan.verified is true.
export interface BundleApplyItem { type: string; label: string; detail?: string; scope: string }
export interface BundleSkipItem { type: string; name: string; reason: string }
// `errors`: a per-file write failed (e.g. ~/.claude.json unwritable). Items for
// that category are NOT in `applied` (they never persisted); the rest still are,
// so the ledger stays in sync with disk. Surfaced to the user, never thrown.
export interface BundleApplyError { stage: string; error: string }
export interface BundleApplyResult { applied: BundleApplyItem[]; skipped: BundleSkipItem[]; errors?: BundleApplyError[] }
export function installBundleExtras(
  dir: string, scope: 'project' | 'global', root: string | null,
  executable: boolean, high_risk: boolean,
): Promise<BundleApplyResult> {
  return invoke('install_bundle_extras', { dir, scope, root, executable, highRisk: high_risk });
}
// Uninstall: read the provenance ledger, revert an entry's executable/high-risk
// items (the inverse of installBundleExtras - removes only what install added,
// reporting `missing` for anything the user has since changed), then persist the
// trimmed ledger. Groups and theme are reverted page-side, not here.
export interface BundleRevertResult { removed: string[]; missing: string[] }
export function readInstalledTemplates(): Promise<any[]> {
  return invoke('read_installed_templates');
}
export function setInstalledTemplates(list: unknown[]): Promise<void> {
  return invoke('set_installed_templates', { list });
}
export function uninstallBundleExtras(
  items: unknown[], scope: 'project' | 'global', root: string | null,
): Promise<BundleRevertResult> {
  return invoke('uninstall_bundle_extras', { items, scope, root });
}
// `spike export-template <dir>` / `spike import-template <dir>` from the CLI
// listener - each carries the target dir; the page does the read/write/apply.
export function onTemplateExport(cb: (dir: string) => void): Promise<UnlistenFn> {
  return listen<{ path: string }>('tmpl-export', (e) => cb(e.payload.path));
}
export function onTemplateImport(cb: (dir: string) => void): Promise<UnlistenFn> {
  return listen<{ path: string }>('tmpl-import', (e) => cb(e.payload.path));
}

// `spike spawn "<task>"` from the CLI listener: an agent asking Spike to spawn a
// scoped subagent. task is the child's brief (untrusted agent text); sessionId
// is the lane that asked (forwarded from $SPIKE_SESSION_ID), which becomes the
// child's parent. Absent when run outside a Spike pty.
export function onSpawn(cb: (msg: { task: string; sessionId?: string }) => void): Promise<UnlistenFn> {
  return listen<{ task: string; sessionId?: string }>('spawn', (e) => cb(e.payload));
}

// ── agent broker (live agent-state events) ──────────────────────────────────
// Emitted by the broker on every POST /agent-event. The `data` shape is
// per-kind (see agent_broker.rs); callers branch on `kind` and read what
// they need. Subscribers attach AFTER pulling a snapshot via getAgentRecent;
// the broker assigns monotonic `seq` so dedup is a single comparison.
export interface AgentEvent {
  seq: number;
  ts: string;
  run_id: string;
  session_id?: string;
  kind: string;
  data: any;
}
export function getAgentRecent(since: number = 0): Promise<AgentEvent[]> {
  return invoke('agent_recent', { since });
}
export function onAgentEvent(cb: (e: AgentEvent) => void): Promise<UnlistenFn> {
  return listen<AgentEvent>('agent:event', (e) => cb(e.payload));
}

// ── attest: the attribution harness ────────────────────────────────────────
// Two OS-facing operations, because neither belongs in the webview. Everything
// that decides whether a run PASSED is pure TypeScript in src/attest/ - it runs
// here, and it is the same code the CLI script runs, so the two surfaces cannot
// drift into disagreeing about what "verified" means.
//
// An attest run is not a lane. pty.rs spawns an interactive TUI a person types
// into; this takes one bounded, gated turn and returns a receipt.

/** A source read verbatim, with the content hash that makes drift detectable. */
export interface AttestSource {
  id: string;
  label: string;
  detail: string;
  hash: string;
  url: string;
  complete: boolean;
}

/**
 * Read a folder (or one text file) into citable sources. Refuses a binary file
 * rather than reading it as UTF-8 - mojibake would be segmented and then quoted
 * back as if it were the document.
 */
export function attestReadSources(root: string, include?: string[]): Promise<AttestSource[]> {
  return invoke('attest_read_sources', { root, include });
}

/**
 * One headless turn on the user's own subscription. Returns Claude Code's
 * `--output-format json` result verbatim, so the caller gates exactly what the
 * model produced rather than a summary of it.
 */
export function attestTurn(turn: {
  run_id: string;
  prompt: string;
  schema: string;
  model: string;
  /** 'claude' | 'codex'. Omitted means claude. */
  engine?: string;
  session_id?: string;
}): Promise<any> {
  return invoke('attest_turn', { turn });
}

/**
 * Record a finished run's verdict on the broker. Separate from attestTurn
 * because a run is one or more turns plus a gate, and the gate is TypeScript -
 * without this the log would show that a verification ran but never whether it
 * passed, which is the half that matters.
 */
export function attestVerdict(
  runId: string,
  verdict: unknown,
  sessionId?: string,
): Promise<number> {
  return invoke('attest_verdict', { runId, sessionId, verdict });
}

/**
 * One headless CODING turn for a playbook (src/attest/playbook.ts). Unlike attestTurn this
 * edits files in `cwd` and its tool surface is open; the checks - run via playbookRunCheck -
 * are the gate. Returns Claude Code's `--output-format json` envelope verbatim.
 */
export function playbookTurn(turn: {
  run_id: string;
  prompt: string;
  cwd: string;
  /** 'claude' only for now. Omitted means claude. */
  engine?: string;
  session_id?: string;
}): Promise<any> {
  return invoke('playbook_turn', { turn });
}

/**
 * Run one playbook check command in `cwd`. A failing command is a non-zero `code`, not a
 * rejection; only an unrunnable shell rejects (which aborts the run - never a silent pass).
 */
export function playbookRunCheck(
  cmd: string,
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return invoke('playbook_run_check', { check: { cmd, cwd } });
}

// Dock bounce / taskbar flash (macOS bounces the dock icon; Windows flashes
// the taskbar entry; ignored if the window is currently focused - pause-on-
// question only routes attention back to Spike when you're elsewhere). Web
// fallback (no Tauri runtime) is a no-op.
export async function requestAttentionIfUnfocused(): Promise<void> {
  if (!('__TAURI_INTERNALS__' in window)) { console.log('[dock] no Tauri runtime'); return; }
  try {
    const { UserAttentionType } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    const focused = await win.isFocused();
    console.log(`[dock] window focused=${focused}`);
    if (focused) return;
    await win.requestUserAttention(UserAttentionType.Informational);
    console.log('[dock] requestUserAttention resolved');
  } catch (e) {
    console.warn('[dock] requestAttention threw', e);
  }
}

// ── in-app updates (tauri-plugin-updater) ───────────────────────────────────
// The manifest endpoint (a latest.json published on the GitHub release) and the
// minisign public key that gates it live in tauri.conf.json → plugins.updater.
// The signature check happens in Rust before anything is unpacked: a tarball
// that isn't signed by the matching private key is rejected, so a compromised
// endpoint can't ship a payload. Apple codesigning is separate and still
// applies - the downloaded .app must also be notarized to pass Gatekeeper.
//
// The plugin imports are dynamic so the updater code stays out of the startup
// path; a check runs at most once per launch and usually returns null.
export interface PendingUpdate {
  version: string;
  notes?: string;
  date?: string;
  /** Download, swap the app in place, then relaunch into the new build. */
  install(onProgress?: (downloaded: number, total: number | null) => void): Promise<void>;
}

// Resolves null when already current. Callers treat a throw as "couldn't
// check" (offline, endpoint down) - never as "no update".
export async function checkForUpdate(): Promise<PendingUpdate | null> {
  if (!('__TAURI_INTERNALS__' in window)) return null;
  const { check } = await import('@tauri-apps/plugin-updater');
  const update = await check();
  if (!update) return null;
  return {
    version: update.version,
    notes: update.body,
    date: update.date,
    async install(onProgress) {
      let downloaded = 0;
      let total: number | null = null;
      await update.downloadAndInstall((ev) => {
        if (ev.event === 'Started') total = ev.data.contentLength ?? null;
        else if (ev.event === 'Progress') {
          downloaded += ev.data.chunkLength;
          onProgress?.(downloaded, total);
        }
      });
      // relaunch() never returns - the process is replaced.
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    },
  };
}
