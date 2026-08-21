// settings.ts — Spike's settings surface, extracted from app.ts so it can
// evolve without touching the (busy) app shell. Vanilla DOM, no framework, same
// style as the rest of src/web: small builder functions over document.createElement.
//
// settings-v2: a FULL-WINDOW view (not a modal) that replaces the app area
// below the title bar — a persistent left rail of categories and one content
// pane per category, Linear/Conductor style:
//   General · Workspaces · Context · Files · Git & worktrees · Privacy & logs
//   · Appearance, plus an inert "Local projects" rail section.
// A per-workspace context editor (opened from a card's "Edit context →") is a
// first-class screen inside the same shell.
//
// app.ts owns the live model (groups, sessions, config cache) and passes the
// handful of verbs the panel needs through SettingsDeps; this module owns all
// settings DOM + its CSS (injected once, so index.html stays untouched).

import * as ipc from './ipc';
import { CHAT_ENABLED } from './edition';
import claudeLogo from './claude-logo.png';
import codexLogo from './codex-logo.png';
// the group .md contract (pure module, shared with the server build): the
// Spike-owned head, the marker, and the user-owned tail the note edits.
import { assembleGroupMd, GROUP_MD_MARKER } from '../groupmd';
// the shared preview-assembly engine — the single source of truth for BOTH the
// Defaults and Workspace context panels (see src/assemble-context.ts). Mirrors
// the Rust spawn order; parity is guarded by test/assemble-context.test.mjs.
import { assembleContext, joinContext, type ContextLine, type AssembleWorkspace } from '../assemble-context';
// Brand logo marks for the Connectors pane (single-path SVGs, fill=currentColor).
import { CONNECTOR_LOGOS } from './connector-logos';

// Matches the in-memory group objects app.ts keeps (id is client-only; the
// rest round-trips through ~/.spike/groups/<slug>.json).
export interface WorkspaceGroup {
  id: number;
  name: string;
  color: string;
  collapsed: boolean;
  cwd?: string;
  description?: string;
  pinnedPaths?: string[];
  isolation?: 'shared' | 'auto-worktree';
  /// learned DO/DON'T writing voice, distilled from how the user edits agent
  /// output (learn-the-voice). Rides the .md head into every spawn; viewable +
  /// prunable here. See src/groupmd.ts SpikeGroup.voice.
  voice?: { do?: string[]; dont?: string[] };
  /// per-workspace override of the global Default view. Omitted → inherit
  /// Defaults; 'terminal' | 'chat' pins this workspace's new agent lanes.
  view?: 'terminal' | 'chat';
  /// reserved (settings-polish): persisted + round-tripped but NOT read or
  /// written by any UI. Comes back together with spawn-time MCP enforcement.
  mcpEnabled?: string[];
  createdAt?: string;
  /** Path to this workspace's attest check set. Absent → discovered by convention. */
  attest?: string;
  /// legacy (pre-settings-v2): kept on the object so old files round-trip;
  /// no UI, no spawn effect.
  worktreePath?: string;
}

export interface SettingsDeps {
  icon: (name: string, size?: number) => string;
  /// the LIVE groups array (mutated in place, like the rest of app.ts)
  groups: WorkspaceGroup[];
  groupColors: string[];
  membersOf: (gid: number) => Array<{ groupId: number | null }>;
  persistGroup: (g: WorkspaceGroup) => void;
  unpersistGroup: (name: string) => void;
  renderTabs: () => void;
  newTabInGroup: (g: WorkspaceGroup) => void;
  /// workspace factory (fresh id/createdAt, no tabs); `init` seeds fields —
  /// the card menu's Duplicate clones a workspace through it.
  newWorkspace: (init?: Partial<WorkspaceGroup>) => WorkspaceGroup;
  /// last-loaded config.json (app.ts's appConfig; may be null pre-boot)
  getConfig: () => any;
  /// refresh appConfig from disk; resolves with it
  loadConfig: () => Promise<any>;
  /// persist a config patch AND keep appConfig in sync (app.ts patchConfig)
  patchConfig: (patch: Record<string, unknown>) => void;
  /// cached engine detection (null pre-detection); read at chip-render time
  /// to set the initial disabled state on missing engines. Live updates ride
  /// on renderDetect's own ipc.detectEngines call.
  getEngines?: () => ipc.EngineDetection | null;
  /// open a file in Spike's preview/editor
  openFile: (path: string, name: string) => void;
  /// "Open ↗": return to the app focused on this workspace
  openWorkspace: (g: WorkspaceGroup) => void;
  /// current project root (for the Local projects rail section)
  getProjectPath: () => string | null;
  /// stored theme preference: 'light' | 'dark' | 'system' ('system' = follow OS)
  getTheme: () => string;
  /// pin a theme, or pass 'system' to clear the override and follow the OS
  setTheme: (mode: string) => void;
  /// user-chosen accent NAME (Valence palette), or null to follow the theme default
  getAccent: () => string | null;
  /// set the app-wide accent by name, or null to clear the override
  setAccent: (name: string | null) => void;
  /// the Valence accent options: name (→ data-accent), label, dot (display colour)
  accentPalette: Array<{ name: string; label: string; dot: string }>;
}

// Native folder picker (Tauri dialog plugin), falling back to a typed path.
async function pickFolderPath(): Promise<string | null> {
  try {
    const p = await ipc.pickFolder();
    if (p === null) return null;   // user hit Cancel
    return p;
  } catch {}
  const typed = window.prompt('Enter an absolute path:');
  return typed && typed.trim() ? typed.trim() : null;
}

export interface SettingsHandle {
  open: (paneId?: string) => void;
  close: () => void;
  toggle: () => void;
  isOpen: () => boolean;
}

// Preset swatch row: Spike's five existing workspace colors plus four
// additions in the same muted, earthy register (9 total; a workspace's
// existing custom color renders as an extra swatch — see swatchesFor).
const EXTRA_COLORS = ['#8A9D8A', '#A89968', '#C08D9B', '#7E92AB'];

// Spike's terminal font stack — the one monospace family the panel uses
// (xterm's fontFamily in app.ts). Do not introduce another.
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const SANS = '-apple-system, system-ui, sans-serif';

// Mirror of server.ts sanitizeGroupName / fs_ops sanitize_group_name, so the
// page can derive ~/.spike/groups/<slug>.md paths.
function sanitizeGroupName(name: string): string {
  return name.trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'group';
}

// bytes → "~1.2k" style token estimate (bytes ÷ 4; no tokenizer in the
// bundle, ±20% is fine per spec — the ~ carries the uncertainty).
export function tokenEstimate(bytes: number): string {
  const t = Math.max(0, Math.round(bytes / 4));
  if (t < 1000) return `~${t}`;
  if (t < 1_000_000) return `~${(t / 1000).toFixed(t < 10_000 ? 1 : 0)}k`;
  return `~${(t / 1_000_000).toFixed(1)}M`;
}

// Usage-pane number formatting: compact token counts (1.2M / 340k) and
// notional dollars ($12.34 / $1.2k). Tabular, terse — these sit in mono rows.
function fmtTok(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}
function fmtUsd(n: number): string {
  if (n <= 0) return '$0';
  if (n < 0.01) return '<$0.01';
  if (n < 100) return `$${n.toFixed(2)}`;
  if (n < 10_000) return `$${n.toFixed(0)}`;
  return `$${(n / 1000).toFixed(1)}k`;
}

// All visual values derive from Spike's CSS variables (index.html :root) —
// nothing here hardcodes a color outside the swatch palette. The companion
// reference HTML's placeholder hexes map: bg-window→--bg, bg-nav→--surface-soft,
// bg-card→--elevated, bg-sunken→--bg, border→--edge, border-soft→--edge-soft,
// text-hi→--ink, text→--ink-soft, text-mute/dim→--ink-faint, text-faint→
// --ink-ghost, accent→--accent, danger→--rose.
const SETTINGS_CSS = `
#settings {
  position: fixed; top: var(--barh); left: 0; right: 0; bottom: 0; z-index: 70;
  display: flex; background: var(--bg); color: var(--ink-soft);
  font: 13px ${SANS};
}
/* ── blank canvas (settings being reimagined) ── */
#settings.sv-blank { display: block; }
#settings .sv-blank-stage {
  position: absolute; inset: 0; display: flex;
  align-items: center; justify-content: center;
}
#settings .sv-blank-card { text-align: center; max-width: 380px; padding: 0 24px; }
#settings .sv-blank-title {
  font-size: 22px; font-weight: 500; color: var(--ink); margin-bottom: 8px;
}
#settings .sv-blank-sub { font-size: 13px; color: var(--ink-faint); line-height: 1.5; }
/* ── nav rail ── */
#settings .sv-rail {
  width: 192px; flex: 0 0 192px; display: flex; flex-direction: column; gap: 1px;
  padding: 14px 10px 16px; background: var(--surface-soft);
  border-right: 1px solid var(--edge-soft); overflow-y: auto; user-select: none;
}
#settings .sv-back {
  display: flex; align-items: center; gap: 8px; padding: 6px 9px; margin-bottom: 12px;
  border-radius: 6px; font-size: 12px; color: var(--ink-faint); cursor: pointer;
}
#settings .sv-back:hover { color: var(--ink); background: var(--elevated); }
#settings .sv-item {
  display: flex; align-items: center; gap: 10px; padding: 6px 9px;
  border-radius: 6px; font-size: 12.5px; color: var(--ink-faint); cursor: pointer;
  transition: background .12s, color .12s;
}
#settings .sv-item .sv-ic { width: 16px; flex: 0 0 16px; display: inline-flex; justify-content: center; }
#settings .sv-item:hover { background: var(--elevated); color: var(--ink-soft); }
/* app/Defaults items: active reads with the app's accent wash (mirrors the
   strip's srow.active), so the rail carries Spike's color, not flat gray */
#settings .sv-item.active { background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--ink); }
#settings .sv-item.active .sv-ic { color: var(--ink); }
/* workspace items: washed in THEIR color, exactly like the strip chip
   (chip = g.color @ ~13% + colored text). --wc is set inline per row. */
#settings .sv-item.sv-ws:hover:not(.active) { background: color-mix(in srgb, var(--wc) 10%, transparent); color: var(--ink-soft); }
#settings .sv-item.sv-ws.active { background: color-mix(in srgb, var(--wc) 20%, transparent); color: var(--ink); }
#settings .sv-item.sv-ws.active .sv-dot-sm { box-shadow: 0 0 0 2px color-mix(in srgb, var(--wc) 32%, transparent); }
#settings .sv-railsec {
  font-size: 9.5px; letter-spacing: .08em; text-transform: uppercase;
  color: var(--ink-ghost); padding: 8px 9px 4px; margin-top: 12px;
}
/* a workspace's rail entry: its color dot stands in for a category icon, so
   the rail reads as "places", not settings sections */
#settings .sv-item .sv-dot-sm { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 8px; margin: 0 4px; }
#settings .sv-item .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#settings .sv-item.sv-add { color: var(--ink-ghost); }
#settings .sv-item.sv-add:hover { color: var(--ink-soft); }
/* ── content pane ── */
#settings .sv-content { flex: 1 1 auto; min-width: 0; overflow-y: auto; padding: 26px 40px 48px; }
/* content caps at 720px, LEFT-anchored against the rail — Spike surfaces are
   edge-to-edge, never a floating centered column (which stranded the pane in a
   wide gray gutter). Tight label↔control gaps read as a tool, not a web form. */
#settings .sv-pane { max-width: 860px; margin: 0; }
/* the two split panes (Defaults + Workspace) fill the whole content width so
   the two columns stretch evenly, rather than capping in a left-of-centre band
   with dead space on the right */
#settings .sv-pane.sv-wide { max-width: none; }
/* full-width zones below a wide split (e.g. Defaults' Worktrees) stay readable
   rather than stretching label/control rows across the whole 1240 */
#settings .sv-pane.sv-wide > .sv-zone { max-width: 840px; }
#settings .sv-title { font-size: 21px; font-weight: 500; color: var(--ink); margin: 0 0 4px; }
#settings .sv-subtitle { font-size: 12.5px; color: var(--ink-faint); margin: 0 0 22px; line-height: 1.5; max-width: 560px; }
#settings .sv-subtitle code, #settings .sv-sub code { font-family: ${MONO}; font-size: 11px; color: var(--ink-soft); }
/* ── setting rows ── */
#settings .sv-row {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 18px;
  padding: 14px 0; border-bottom: 1px solid var(--edge-soft);
}
#settings .sv-row:last-child { border-bottom: none; }
#settings .sv-row.sv-row-col { flex-direction: column; align-items: stretch; gap: 8px; }
#settings .sv-row-l { flex: 1 1 auto; min-width: 0; }
#settings .sv-label { font-size: 13px; font-weight: 500; color: var(--ink); }
#settings .sv-sub { font-size: 11px; color: var(--ink-faint); margin-top: 3px; line-height: 1.45; }
#settings .sv-row-c { flex: 0 0 auto; display: flex; align-items: center; gap: 7px; }
#settings .sv-suffix { font-size: 11.5px; color: var(--ink-faint); }
/* inputs: mono wherever the value is a path / shell / number / extension.
   Focus reuses the app's live-address-bar idiom — accent border + soft accent
   glow ring — so a focused field feels like the rest of Spike, not a gray box. */
#settings input[type="text"], #settings input[type="number"], #settings textarea.sv-ta {
  background: var(--surface); border: 1px solid var(--edge); color: var(--ink);
  border-radius: 7px; padding: 8px 11px; font: 12px ${SANS};
  outline: none; box-sizing: border-box;
  transition: border-color .14s ease, box-shadow .14s ease, background .14s ease;
}
#settings input[type="text"]:hover, #settings input[type="number"]:hover,
#settings textarea.sv-ta:hover { border-color: var(--ink-ghost); }
#settings input:focus, #settings textarea.sv-ta:focus {
  border-color: var(--accent); background: var(--elevated);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}
#settings .sv-mono, #settings input.sv-mono, #settings textarea.sv-mono { font-family: ${MONO} !important; font-size: 11.5px !important; }
/* leading-glyph input: a kind-icon (folder / shell / …) sits inside the field
   so its type reads before the label does. The glyph lights up in the accent
   on focus, riding the same focus ring as the border. */
#settings .sv-field { position: relative; display: inline-flex; align-items: center; }
#settings .sv-field.grow { flex: 1 1 auto; min-width: 0; }
#settings .sv-field > input { padding-left: 32px !important; }
#settings .sv-field.grow > input { width: 100%; }
#settings .sv-field .sv-glyph {
  position: absolute; left: 11px; top: 50%; transform: translateY(-50%);
  display: inline-flex; color: var(--ink-ghost); pointer-events: none; transition: color .14s ease;
}
#settings .sv-field:focus-within .sv-glyph { color: var(--accent); }
#settings input[type="text"].sv-path { width: 264px; }
#settings input[type="number"] {
  width: 56px; text-align: right; -moz-appearance: textfield; appearance: textfield;
  font-family: ${MONO}; font-size: 11.5px;
}
#settings input[type="number"]::-webkit-inner-spin-button,
#settings input[type="number"]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
#settings textarea.sv-ta { width: 100%; resize: vertical; line-height: 1.6; min-height: 64px; }
/* permissions editor: the rule list fills the row, with a saved/count line
   beneath it. The status is the only feedback that a keystroke reached disk,
   so it sits directly under the box rather than in a corner of the pane. */
#settings .sv-perm-ctl { width: 100%; }
#settings .sv-perm-status { display: block; margin-top: 6px; font-size: 11px; color: var(--ink-ghost); }
/* permissions read as a list of sentences, not a config file. Each row is one
   grant with one way to take it away; the raw rule lives on the title. */
#settings .sv-perm-list { display: flex; flex-direction: column; gap: 1px; }
#settings .sv-perm-row {
  display: flex; align-items: center; gap: 8px; padding: 7px 10px;
  background: var(--elevated); border-radius: 6px; font-size: 12.5px; color: var(--ink);
}
#settings .sv-perm-what { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#settings .sv-perm-x {
  flex: 0 0 auto; border: 0; background: none; cursor: pointer; padding: 0 2px;
  font-size: 15px; line-height: 1; color: var(--ink-ghost);
}
#settings .sv-perm-x:hover { color: var(--rose-deep); }
#settings .sv-perm-empty { font-size: 12px; color: var(--ink-ghost); line-height: 1.5; }
/* toggle: filled accent when on, muted track when off. Hover brightens the
   track and the knob nudges, so it feels live under the cursor; keyboard focus
   gets the same accent ring as the inputs. */
#settings .sv-toggle {
  width: 34px; height: 19px; border-radius: 10px; background: var(--edge);
  position: relative; cursor: pointer; flex: 0 0 34px;
  transition: background .18s ease, box-shadow .14s ease;
}
#settings .sv-toggle::after {
  content: ''; position: absolute; top: 2px; left: 2px; width: 15px; height: 15px;
  border-radius: 50%; background: var(--ink-soft);
  transition: left .18s cubic-bezier(.32,.72,0,1), background .18s ease, width .12s ease;
}
#settings .sv-toggle:hover { background: color-mix(in srgb, var(--edge) 55%, var(--ink-ghost)); }
#settings .sv-toggle:active::after { width: 18px; }
#settings .sv-toggle:focus-visible { outline: none; box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 20%, transparent); }
#settings .sv-toggle.on { background: var(--accent); }
#settings .sv-toggle.on:hover { background: color-mix(in srgb, var(--accent) 85%, var(--ink)); }
#settings .sv-toggle.on::after { left: 17px; background: var(--bg); }
#settings .sv-toggle.on:active::after { left: 14px; }
/* segmented control: recessed track, raised active option (the launcher's
   .modes pattern, reused so segments read the same everywhere in Spike) */
#settings .sv-seg {
  display: inline-flex; gap: 2px; padding: 2px; border-radius: 7px;
  background: var(--bg); border: 1px solid var(--edge-soft);
}
#settings .sv-seg .sv-opt {
  display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px;
  border-radius: 5px; font-size: 11px; color: var(--ink-faint); cursor: pointer;
  white-space: nowrap; user-select: none; transition: background .12s, color .12s;
}
#settings .sv-seg .sv-opt:hover { color: var(--ink-soft); background: color-mix(in srgb, var(--ink) 7%, transparent); }
#settings .sv-seg .sv-opt.on, #settings .sv-seg .sv-opt.on:hover { background: var(--elevated); color: var(--ink); box-shadow: 0 1px 3px rgba(var(--shadow), calc(.25 * var(--shadow-k))); }
#settings .sv-seg.disabled { opacity: .55; }
#settings .sv-seg.disabled .sv-opt { cursor: default; color: var(--ink-ghost); }
#settings .sv-seg.disabled .sv-opt.on { color: var(--ink-faint); }
/* per-option disabled state — used to mute an engine chip whose binary isn't
   installed on this machine. The chip stays visible (so the user sees what
   the option would be) but reads as inactive and click is a no-op. Dimming is
   by COLOR (label + icon), not container opacity, so an inline install link
   stays readable (settings revamp: Codex-unavailable folds into the toggle). */
#settings .sv-seg .sv-opt.disabled { cursor: not-allowed; color: var(--ink-ghost); }
#settings .sv-seg .sv-opt.disabled .sv-ic { opacity: .4; }
#settings .sv-seg .sv-opt.disabled:hover { color: var(--ink-ghost); }
#settings .sv-seg .sv-opt .eng-install { margin-left: 5px; font-size: 9px; color: var(--accent); text-decoration: none; cursor: pointer; }
#settings .sv-seg .sv-opt .eng-install:hover { text-decoration: underline; }
/* small icon button (folder pickers) — accent-tinted on hover so the pick
   affordance reads as an action, not chrome */
#settings .sv-iconbtn {
  width: 34px; height: 34px; border-radius: 7px; display: inline-flex; flex: 0 0 34px;
  align-items: center; justify-content: center; color: var(--ink-faint); cursor: pointer;
  border: 1px solid var(--edge); background: transparent;
  transition: color .14s ease, border-color .14s ease, background .14s ease;
}
#settings .sv-iconbtn:hover {
  color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--edge));
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}
#settings .sv-iconbtn:active { background: color-mix(in srgb, var(--accent) 14%, transparent); }
/* quiet text button */
#settings .sv-btn {
  display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px;
  border-radius: 7px; border: 1px solid var(--edge); background: transparent;
  color: var(--ink-soft); cursor: pointer; font-size: 11.5px; user-select: none;
  transition: color .14s ease, border-color .14s ease, background .14s ease;
}
#settings .sv-btn:hover { color: var(--ink); border-color: var(--ink-ghost); background: color-mix(in srgb, var(--ink) 5%, transparent); }
#settings .sv-btn:active { background: color-mix(in srgb, var(--ink) 9%, transparent); }
/* muted action link ("Open log directory →", "Edit →") */
#settings .sv-link { font-size: 11.5px; color: var(--ink-faint); cursor: pointer; user-select: none; white-space: nowrap; transition: color .12s; }
#settings .sv-link:hover { color: var(--ink-soft); }
/* ── workspace page ── */
/* the page root hosts the same popovers the old card did (swatches, ⋯ menu,
   isolation ?) — they anchor against the nearest positioned ancestor */
#settings .sv-wsroot { position: relative; }
#settings .sv-wshead { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; }
#settings .sv-wshead .sv-name { font-size: 19px; }
#settings .sv-wshead .sv-nameedit { font: 500 19px ${SANS}; width: 240px; }
#settings .sv-wshead-r { margin-left: auto; display: flex; align-items: center; gap: 8px; }
#settings .sv-dot {
  width: 10px; height: 10px; border-radius: 50%; flex: 0 0 10px; cursor: pointer;
  box-sizing: border-box;
}
#settings .sv-dot.hollow { background: transparent !important; border: 1.5px solid currentColor; }
#settings .sv-name { color: var(--ink); font-size: 13.5px; font-weight: 500; cursor: text; }
#settings .sv-name:hover { text-decoration: underline dashed var(--ink-ghost); text-underline-offset: 4px; }
#settings .sv-nameedit {
  background: transparent; border: none; border-bottom: 1px solid var(--accent);
  color: var(--ink); font: 500 13.5px ${SANS};
  outline: none; padding: 0; width: 180px;
}
#settings .sv-count { color: var(--ink-ghost); font-size: 11px; font-variant-numeric: tabular-nums; }
/* one always-visible, subtle ⋯ button that opens the workspace action menu —
   hover-only icons were invisible to first-timers. */
#settings .sv-more {
  width: 24px; height: 24px; border-radius: 6px; border: none; background: transparent;
  display: inline-flex; align-items: center; justify-content: center; padding: 0;
  color: var(--ink-ghost); cursor: pointer; transition: color .12s, background .12s;
}
#settings .sv-more:hover { color: var(--ink-soft); background: var(--bg); }
/* card action menu — popover on the swatch picker's anchoring pattern */
#settings .sv-menu {
  position: absolute; z-index: 6; min-width: 138px; padding: 4px;
  background: var(--surface); border: 1px solid var(--edge); border-radius: 8px;
  box-shadow: 0 6px 22px rgba(var(--shadow), calc(.45 * var(--shadow-k)));
}
#settings .sv-menu .sv-mi {
  display: flex; align-items: center; gap: 8px; padding: 5px 9px; border-radius: 5px;
  font-size: 11.5px; color: var(--ink-soft); cursor: pointer; user-select: none;
}
#settings .sv-menu .sv-mi .sv-ic { display: inline-flex; color: var(--ink-faint); }
#settings .sv-menu .sv-mi:hover { background: var(--elevated); color: var(--ink); }
#settings .sv-menu .sv-mi.danger, #settings .sv-menu .sv-mi.danger .sv-ic { color: var(--rose); }
#settings .sv-menu .sv-msep { height: 1px; margin: 4px 6px; background: var(--edge-soft); }
/* isolation row + explainer (settings-polish 2c) */
#settings .sv-iso-help { display: inline-flex; color: var(--ink-ghost); cursor: help; }
#settings .sv-iso-help:hover { color: var(--ink-soft); }
#settings .sv-isopop {
  position: absolute; z-index: 6; max-width: 330px; padding: 9px 11px;
  background: var(--surface); border: 1px solid var(--edge); border-radius: 8px;
  box-shadow: 0 6px 22px rgba(var(--shadow), calc(.45 * var(--shadow-k)));
  font-size: 11px; color: var(--ink-faint); line-height: 1.55;
}
#settings .sv-isopop .k { color: var(--ink); font-weight: 500; }
/* the always-visible reason a disabled Auto-worktree gives */
#settings .sv-iso-reason { font-size: 10.5px; color: var(--ink-ghost); font-style: italic; white-space: nowrap; }
/* one quiet clarification line — no box, no alert weight (2c) */
#settings .sv-iso-detail {
  margin-top: 7px; font-family: ${MONO}; font-size: 10.5px; color: var(--ink-ghost);
  line-height: 1.5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* swatch popover */
#settings .sv-swpop {
  position: absolute; z-index: 5; display: flex; gap: 7px; padding: 8px 10px;
  background: var(--surface); border: 1px solid var(--edge); border-radius: 8px;
  box-shadow: 0 6px 22px rgba(var(--shadow), calc(.45 * var(--shadow-k)));
}
#settings .sv-swatch {
  width: 16px; height: 16px; border-radius: 50%; cursor: pointer;
  border: 2px solid transparent; box-sizing: content-box;
}
#settings .sv-swatch:hover { border-color: var(--ink-ghost); }
#settings .sv-swatch.on { border-color: var(--ink); }
#settings .sv-note { color: var(--ink-ghost); font-size: 11.5px; padding: 8px 0; line-height: 1.6; }
#settings .sv-note.italic { font-style: italic; }
/* extension rules as removable pills */
#settings .sv-pills { display: flex; flex-wrap: wrap; gap: 6px; padding: 2px 0 12px; }
#settings .sv-pill {
  display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 5px 0 11px;
  border-radius: 12px; background: var(--elevated); border: 1px solid var(--edge-soft);
  color: var(--ink-soft); font-family: ${MONO}; font-size: 11px; cursor: default;
}
#settings .sv-pill .sv-pillmode { color: var(--ink-faint); cursor: pointer; }
#settings .sv-pill .sv-pillmode:hover { color: var(--ink); }
#settings .sv-pill .sv-pillx {
  width: 15px; height: 15px; border-radius: 50%; display: inline-flex;
  align-items: center; justify-content: center; color: var(--ink-ghost); cursor: pointer;
}
#settings .sv-pill .sv-pillx:hover { color: var(--rose); }
#settings .sv-addrule { display: flex; align-items: center; gap: 6px; }
#settings .sv-addrule input { width: 64px; }
/* read-only theme line */
#settings .sv-ro { color: var(--ink-faint); font-size: 13px; display: inline-flex; align-items: baseline; gap: 6px; }
#settings .sv-ro .sv-roval { color: var(--ink); font-weight: 500; }
/* log-dir link row */
#settings .sv-linkrow { display: inline-flex; align-items: center; gap: 6px; padding: 14px 0 0; color: var(--ink-faint); font-size: 12px; cursor: pointer; }
#settings .sv-linkrow:hover { color: var(--ink-soft); }
#settings .sv-linkrow .sv-ic { display: inline-flex; }
/* ── zones + fields (shared by the workspace page and Defaults) ── */
#settings .sv-fld { margin-bottom: 22px; }
#settings .sv-fld:last-child { margin-bottom: 0; }
#settings .sv-fld-label { font-size: 12px; font-weight: 500; color: var(--ink); margin-bottom: 3px; }
#settings .sv-fld-hint { font-size: 11px; color: var(--ink-ghost); margin-bottom: 9px; line-height: 1.45; }
/* settings-polish fix 3: the editor's three labeled zones */
#settings .sv-zone { margin: 0 0 32px; padding-top: 24px; border-top: 1px solid var(--edge-soft); }
#settings .sv-zone-h { font-size: 10px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-faint); }
#settings .sv-zone-hint { font-size: 11px; color: var(--ink-ghost); margin: 3px 0 15px; line-height: 1.45; }
/* tiny field-status badge — rendered only on empty/none fields, so a
   configured workspace reads clean and the gaps stand out */
#settings .sv-badge {
  display: inline-block; margin-left: 7px; padding: 1px 6px 2px; border-radius: 8px;
  font-size: 9px; font-weight: 400; letter-spacing: .05em; text-transform: uppercase;
  color: var(--ink-ghost); background: var(--bg); border: 1px solid var(--edge-soft);
  vertical-align: 1px;
}
/* explicit empty states (not just placeholders that look like content) */
#settings .sv-empty { font-size: 11px; color: var(--ink-ghost); font-style: italic; padding: 4px 0 8px; line-height: 1.5; }
#settings textarea.sv-ta::placeholder, #settings input::placeholder { color: var(--ink-ghost); font-style: italic; }
#settings .sv-monofield { display: flex; align-items: center; gap: 6px; }
#settings .sv-monofield input { flex: 1 1 auto; min-width: 0; }
/* pinned paths */
#settings .sv-pins { display: flex; flex-direction: column; gap: 5px; margin-bottom: 8px; }
#settings .sv-pin {
  display: flex; align-items: center; gap: 9px; padding: 6px 9px;
  background: var(--elevated); border: 1px solid var(--edge-soft); border-radius: 6px;
}
#settings .sv-pin .sv-ic { display: inline-flex; color: var(--ink-faint); flex: 0 0 auto; }
#settings .sv-pin-path {
  font-family: ${MONO}; font-size: 11px; color: var(--ink-soft); flex: 1 1 auto;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
#settings .sv-pin.missing .sv-pin-path { color: var(--ink-ghost); text-decoration: line-through; }
#settings .sv-pin-tag { font-family: ${MONO}; font-size: 9.5px; color: var(--ink-ghost); }
#settings .sv-pin-cost { font-family: ${MONO}; font-size: 10px; color: var(--ink-ghost); }
#settings .sv-pin-x {
  display: inline-flex; color: var(--ink-ghost); cursor: pointer; opacity: 0;
  transition: opacity .15s, color .1s; flex: 0 0 auto;
}
#settings .sv-pin:hover .sv-pin-x { opacity: 1; }
#settings .sv-pin-x:hover { color: var(--rose); }
#settings .sv-pin-adds { display: flex; align-items: center; gap: 14px; }
#settings .sv-pin-add {
  display: inline-flex; align-items: center; gap: 6px; padding: 5px 0;
  font-size: 11.5px; color: var(--ink-faint); cursor: pointer; user-select: none;
}
#settings .sv-pin-add:hover { color: var(--ink-soft); }
#settings .sv-pin-add .sv-ic { display: inline-flex; }
/* assembled preview (settings-polish fix 3, zone C): user-set lines bright,
   Spike-added lines dim + tagged [auto] */
#settings .sv-preview { border: 1px solid var(--edge-soft); border-radius: 8px; background: var(--surface-soft); overflow: hidden; }
#settings .sv-pv-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 12px; }
#settings .sv-pv-l { display: flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--ink-faint); }
#settings .sv-pv-l .sv-ic { display: inline-flex; }
#settings .sv-pv-r { display: flex; align-items: center; gap: 12px; flex: 0 0 auto; }
#settings .sv-pv-cost { font-family: ${MONO}; font-size: 10px; color: var(--ink-ghost); }
#settings .sv-pv-legend { display: inline-flex; align-items: center; gap: 5px; font-size: 9.5px; color: var(--ink-ghost); white-space: nowrap; }
#settings .sv-pv-legend .chip { width: 7px; height: 7px; border-radius: 2px; display: inline-block; }
#settings .sv-pv-legend .chip.user { background: var(--ink-soft); }
#settings .sv-pv-legend .chip.auto { background: var(--ink-ghost); opacity: .6; }
#settings .sv-pv-body {
  padding: 9px 12px 11px; border-top: 1px solid var(--edge-soft);
  font-family: ${MONO}; font-size: 10.5px; color: var(--ink-soft); line-height: 1.65;
}
#settings .sv-pv-body > span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#settings .sv-pv-body .auto { color: var(--ink-ghost); }
#settings .sv-pv-body .auto .sv-pv-tag { font-size: 9px; letter-spacing: .04em; }
#settings .sv-pv-k { color: var(--ink); }
/* the global-prompt preview line carries an "edit in Defaults" link — flex
   split so the ellipsis on the text never eats the link */
#settings .sv-pv-body .haslink { display: flex; gap: 8px; align-items: baseline; }
#settings .sv-pv-body .haslink .txt { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#settings .sv-pv-body .sv-pv-link { flex: 0 0 auto; color: var(--ink-ghost); cursor: pointer; font-size: 10px; }
#settings .sv-pv-body .sv-pv-link:hover { color: var(--ink-soft); }
/* ── usage pane — generous vertical rhythm so the dense numbers can breathe ── */
#settings .sv-u-hero { display: flex; align-items: baseline; gap: 12px; margin: 6px 0 8px; }
#settings .sv-u-hero .v { font-family: ${MONO}; font-size: 36px; font-weight: 500; color: var(--ink); font-variant-numeric: tabular-nums; }
#settings .sv-u-hero .lbl { font-size: 12.5px; color: var(--ink-faint); }
#settings .sv-u-note { font-size: 11px; color: var(--ink-ghost); line-height: 1.6; margin: 0 0 28px; }
#settings .sv-u-stats { display: flex; flex-wrap: wrap; gap: 13px; margin-bottom: 8px; }
#settings .sv-u-stat {
  flex: 1 1 0; min-width: 88px; padding: 14px 16px; background: var(--elevated);
  border: 1px solid var(--edge-soft); border-radius: 8px;
}
#settings .sv-u-stat .n { font-family: ${MONO}; font-size: 16px; color: var(--ink); font-variant-numeric: tabular-nums; }
#settings .sv-u-stat .k { font-size: 10px; color: var(--ink-faint); margin-top: 5px; }
/* daily chart: equal-flex bars rising from a baseline */
#settings .sv-u-bars { display: flex; align-items: flex-end; gap: 3px; height: 110px; padding-top: 8px; }
#settings .sv-u-bar { flex: 1 1 0; min-width: 2px; background: var(--accent); border-radius: 2px 2px 0 0; min-height: 1px; opacity: .55; transition: opacity .1s; }
#settings .sv-u-bar:hover { opacity: 1; }
#settings .sv-u-axis { display: flex; justify-content: space-between; font-size: 9.5px; color: var(--ink-ghost); margin-top: 9px; font-family: ${MONO}; }
/* breakdown table: label · token bar · cost */
#settings .sv-u-rows { display: flex; flex-direction: column; gap: 1px; }
#settings .sv-u-r { display: flex; align-items: center; gap: 12px; padding: 11px 2px; border-bottom: 1px solid var(--edge-soft); }
#settings .sv-u-r:last-child { border-bottom: none; }
#settings .sv-u-r .nm { flex: 0 0 30%; min-width: 0; font-family: ${MONO}; font-size: 11.5px; color: var(--ink-soft); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#settings .sv-u-r .track { flex: 1 1 auto; height: 6px; background: var(--bg); border-radius: 3px; overflow: hidden; }
#settings .sv-u-r .fill { height: 100%; background: var(--accent); opacity: .5; border-radius: 3px; }
#settings .sv-u-r .amt { flex: 0 0 auto; font-family: ${MONO}; font-size: 11.5px; color: var(--ink); font-variant-numeric: tabular-nums; text-align: right; min-width: 58px; }
#settings .sv-u-r .sub { flex: 0 0 auto; font-family: ${MONO}; font-size: 10px; color: var(--ink-ghost); text-align: right; min-width: 52px; }
#settings .sv-u-loading { font-size: 12px; color: var(--ink-faint); font-style: italic; padding: 20px 0; }
/* subscription value: plan picker + savings readout */
#settings .sv-u-saverow { margin-bottom: 10px; }
#settings .sv-u-detected { font-size: 10.5px; color: var(--ink-ghost); margin-bottom: 20px; line-height: 1.5; }
#settings .sv-u-save { font-size: 12.5px; color: var(--ink-faint); line-height: 1.6; }
#settings .sv-u-save .v { font-family: ${MONO}; font-size: 22px; font-weight: 500; color: var(--ink); font-variant-numeric: tabular-nums; }
#settings .sv-u-save .t { color: var(--ink-faint); }
#settings .sv-u-save .sub2 { font-size: 11px; color: var(--ink-ghost); margin-top: 6px; line-height: 1.55; }
#settings .sv-u-save .block { margin-top: 22px; }
#settings .sv-u-save .block:first-child { margin-top: 0; }
#settings .sv-u-save .scope { font-size: 9.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-ghost); margin-bottom: 6px; }
/* ── split-view: form-left / assembled-context-right (settings revamp) ──────
   Provenance colors reuse the palette's theme-aware green/gold (--sage/--tan),
   so light and dark stay correct with no hardcoded hexes. Meaning is carried by
   BOTH the marker color AND the left-border + legend (never color alone). */
#settings {
  --pv-set: var(--sage-deep);      /* set-here (green)  */
  --pv-inherit: var(--tan-deep);   /* inherited (gold)  */
  --pv-auto: var(--ink-ghost);     /* by Spike (gray)   */
}
#settings .sv-split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 28px; align-items: start; }
/* below a comfortable width the two columns get cramped (form rows collapse to
   a ribbon), so stack them: form first, preview under it. The threshold is the
   WINDOW width; the rail eats ~210px, so ~1080 leaves ~430/col — the floor for
   readable field rows. */
@media (max-width: 1080px) {
  #settings .sv-split { grid-template-columns: 1fr; gap: 20px; }
  #settings .sv-panelcol { position: static; }   /* sticky is pointless once stacked */
}
/* the preview is a live inspector: it sticks in view while a long form scrolls,
   and never grows into an endless wall — its lines scroll inside a bounded box */
#settings .sv-panelcol { position: sticky; top: 0; align-self: start; }
#settings .sv-formcol { min-width: 0; }
/* the Worktrees zone inside the form column: no extra top margin beyond its
   hairline divider, so it reads as a continuation of the form, not a new page */
#settings .sv-formcol > .sv-zone { margin-bottom: 0; }
#settings .sv-colhead { display: flex; align-items: baseline; gap: 8px; margin-bottom: 12px; min-height: 15px; }
#settings .sv-colhead .lbl { font-size: 9.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-ghost); }
#settings .sv-colhead .r { margin-left: auto; font-size: 11px; color: var(--ink-ghost); font-variant-numeric: tabular-nums; }
/* left column: one bordered field card, hairline-separated rows */
#settings .sv-fieldcard { background: var(--surface); border: 1px solid var(--edge-soft); border-radius: 10px; overflow: hidden; }
#settings .sv-fc-row { padding: 13px 15px; border-bottom: 1px solid var(--edge-soft); }
#settings .sv-fc-row:last-child { border-bottom: none; }
#settings .sv-fc-head { display: flex; align-items: center; gap: 12px; }
#settings .sv-fc-lbl { display: flex; align-items: center; gap: 7px; min-width: 0; }
#settings .sv-fc-lbl .sv-ic { display: inline-flex; color: var(--ink-faint); }
#settings .sv-fc-lbl .t { font-size: 13px; font-weight: 500; color: var(--ink); }
#settings .sv-fc-lbl .rnote { font-size: 11px; color: var(--ink-ghost); }
#settings .sv-fc-head .sv-fc-ctl { margin-left: auto; display: flex; align-items: center; gap: 7px; }
#settings .sv-fc-gap { height: 9px; }
/* a right-aligned mono value chip (shell=$SHELL, isolation=Shared) */
#settings .sv-fc-chip { font-family: ${MONO}; font-size: 11.5px; color: var(--ink-soft); background: var(--elevated); border: 1px solid var(--edge-soft); border-radius: 6px; padding: 4px 10px; }
/* the FROM DEFAULTS read-only inherited block above workspace instructions */
#settings .sv-inh { position: relative; font-size: 12px; color: var(--ink-faint); line-height: 1.5; padding: 8px 10px 8px 11px; background: var(--elevated); border: 1px solid var(--edge-soft); border-left: 2px solid var(--pv-inherit); border-radius: 6px; margin-bottom: 7px; }
#settings .sv-inh .tag { display: block; font-size: 9px; letter-spacing: .06em; text-transform: uppercase; color: var(--pv-inherit); margin-bottom: 3px; }
#settings .sv-inh.empty { font-style: italic; color: var(--ink-ghost); }
/* right column: the assembled-context panel — paper surface, mono lines */
#settings .sv-panel { background: var(--surface-soft); border: 1px solid var(--edge-soft); border-radius: 10px; overflow: hidden; }
#settings .sv-legend { display: flex; align-items: center; gap: 14px; padding: 10px 14px; border-bottom: 1px solid var(--edge-soft); font-size: 10.5px; color: var(--ink-faint); }
#settings .sv-legend .k { display: inline-flex; align-items: center; gap: 6px; }
#settings .sv-legend .sw { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
#settings .sv-legend .sw.set { background: var(--pv-set); }
#settings .sv-legend .sw.inh { background: var(--pv-inherit); }
#settings .sv-legend .sw.auto { background: var(--pv-auto); }
#settings .sv-legend .root { margin-left: auto; color: var(--ink-ghost); font-style: normal; }
#settings .sv-plines { padding: 13px 14px; font-family: ${MONO}; font-size: 11.5px; line-height: 1.7; max-height: calc(100vh - 250px); overflow-y: auto; overscroll-behavior: contain; }
/* one field = one bordered block; wrapped text keeps a continuous left marker */
#settings .sv-pl { padding-left: 11px; white-space: pre-wrap; word-break: break-word; border-left: 2px solid transparent; }
#settings .sv-pl + .sv-pl { margin-top: 10px; }
#settings .sv-pl.set { border-left-color: var(--pv-set); color: var(--ink-soft); }
#settings .sv-pl.inh { border-left-color: var(--pv-inherit); color: var(--ink-soft); }
#settings .sv-pl.auto { border-left-color: var(--pv-auto); color: var(--ink-faint); }
/* inherited line carries a quiet "edit in Defaults" affordance (read-only here) */
#settings .sv-pl.inh { display: flex; gap: 8px; align-items: baseline; }
#settings .sv-pl.inh .txt { flex: 1 1 auto; min-width: 0; white-space: pre-wrap; word-break: break-word; }
#settings .sv-pl .sv-pl-link { flex: 0 0 auto; font-family: ${SANS}; font-size: 10px; color: var(--ink-ghost); cursor: pointer; white-space: nowrap; }
#settings .sv-pl .sv-pl-link:hover { color: var(--ink-soft); }
#settings .sv-cap { font-size: 11px; color: var(--ink-faint); margin-top: 10px; line-height: 1.5; padding-left: 2px; }
#settings .sv-cap .sv-link { display: inline; }
/* the split's header block sits above the grid, full width */
#settings .sv-splithead { margin-bottom: 20px; }
/* ── shared: a group of setting rows framed as one bordered card, so a flat
   pane (Privacy) reads as a designed surface like Defaults' fieldcard rather
   than rows floating in a gray band ── */
#settings .sv-cardgroup { max-width: 560px; background: var(--surface); border: 1px solid var(--edge-soft); border-radius: 10px; padding: 0 16px; }
#settings .sv-cardgroup .sv-row { padding: 15px 0; }
/* ── files: extension rules as fieldcard rows (mirrors the Defaults fieldcard) ── */
#settings .sv-rulecard { max-width: 560px; }
#settings .sv-rule { display: flex; align-items: center; gap: 12px; }
#settings .sv-rule .sv-ruleext { font-family: ${MONO}; font-size: 12.5px; color: var(--ink); flex: 0 0 auto; min-width: 62px; }
#settings .sv-rule .sv-rulearrow { color: var(--ink-ghost); font-size: 11px; }
#settings .sv-rule .sv-rule-ctl { margin-left: auto; display: flex; align-items: center; gap: 9px; }
#settings .sv-rule-rm { display: inline-flex; color: var(--ink-ghost); cursor: pointer; padding: 3px; border-radius: 5px; transition: color .12s, background .12s; }
#settings .sv-rule-rm:hover { color: var(--rose); background: color-mix(in srgb, var(--rose) 11%, transparent); }
/* the add-rule row sits as the card's footer — a hair recessed so it reads as
   the compose line, not another existing rule */
#settings .sv-fc-row.sv-rule-add { background: color-mix(in srgb, var(--ink) 2.5%, transparent); }
#settings .sv-rule-add input { width: 96px; }
#settings .sv-rule-add .sv-rule-ctl { gap: 9px; }
/* ── appearance: selectable theme-preview cards ──────────────────────────────
   Each card is a miniature of the app painted in the TARGET theme's real
   palette (hardcoded hexes below, matched to index.html) so the Light card
   reads light even while Spike is dark. Selection rides the same accent ring as
   the split-view field cards. */
#settings .sv-themes { display: flex; gap: 14px; flex-wrap: wrap; max-width: 560px; }
#settings .sv-theme {
  flex: 1 1 150px; cursor: pointer; border-radius: 11px; padding: 5px 5px 0;
  border: 1.5px solid var(--edge-soft); background: var(--surface-soft);
  transition: border-color .14s ease, box-shadow .14s ease;
}
#settings .sv-theme:hover:not(.on) { border-color: var(--ink-ghost); }
#settings .sv-theme.on { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }
#settings .sv-mini { height: 88px; border-radius: 7px; overflow: hidden; display: flex; }
#settings .sv-mini .rail { flex: 0 0 32%; height: 100%; }
#settings .sv-mini .body { flex: 1 1 auto; padding: 11px 10px; display: flex; flex-direction: column; align-items: flex-start; gap: 7px; }
#settings .sv-mini .bar { height: 6px; border-radius: 3px; }
#settings .sv-mini .chip { height: 7px; width: 18px; border-radius: 3px; margin-top: 2px; }
/* System: one mini split diagonally between the two palettes */
#settings .sv-mini.sys { position: relative; }
#settings .sv-mini.sys .half { position: absolute; inset: 0; padding: 11px 10px; display: flex; flex-direction: column; gap: 7px; }
#settings .sv-mini.sys .half.dark { align-items: flex-start; clip-path: polygon(0 0, 100% 0, 0 100%); }
#settings .sv-mini.sys .half.light { align-items: flex-end; clip-path: polygon(100% 0, 100% 100%, 0 100%); }
#settings .sv-theme .cap { display: flex; align-items: center; justify-content: space-between; padding: 8px 6px 9px; }
#settings .sv-theme .cap .nm { font-size: 12px; font-weight: 500; color: var(--ink-faint); }
#settings .sv-theme:hover .cap .nm { color: var(--ink-soft); }
#settings .sv-theme.on .cap .nm { color: var(--ink); }
#settings .sv-theme .cap .tick { display: inline-flex; color: var(--accent); opacity: 0; transition: opacity .12s; }
#settings .sv-theme.on .cap .tick { opacity: 1; }

/* accent swatches — the oasis palette, applied app-wide */
#settings .sv-swatches { display: flex; flex-wrap: wrap; gap: 12px; max-width: 360px; }
#settings .sv-accsw {
  width: 26px; height: 26px; border-radius: 50%; cursor: pointer; padding: 0; border: none;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 14%, transparent);
  transition: transform .1s;
}
#settings .sv-accsw:hover { transform: scale(1.14); }
#settings .sv-accsw.on {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 14%, transparent),
              0 0 0 2px var(--elevated), 0 0 0 4px var(--ink);
}
/* the "default" chip: no fixed color — a split showing both palettes' accents */
#settings .sv-accsw.default {
  background: linear-gradient(135deg, #B85F4E 0 50%, #E2A299 50% 100%);
}
`;

export function initSettings(deps: SettingsDeps): SettingsHandle {
  const { icon } = deps;

  let viewEl: HTMLElement | null = null;       // the full-window view root
  let contentEl: HTMLElement | null = null;    // right pane scroll surface
  let railEl: HTMLElement | null = null;
  // One routing string: 'defaults' | 'workspace:<id>' | an app-pane id. The
  // old two-variable scheme (pane + editorGroupId) is gone — a workspace's
  // page IS its pane now, a sibling of Defaults, not a screen behind a list.
  let currentPane = 'defaults';                // default landing pane
  let pendingNameEdit: number | null = null;   // start inline name edit after render
  let swatchPop: HTMLElement | null = null;
  let cardMenu: HTMLElement | null = null;     // the ⋯ action menu (one at a time)
  let isoPop: HTMLElement | null = null;       // the isolation "?" explainer
  let homeDir: string | null = null;           // cached for ~/.spike paths
  // cache, refreshed per open: cwd → git-repo?
  const gitRepoCache = new Map<string, boolean>();
  // Usage pane: the last scan result + an in-flight guard. Cached across pane
  // switches (a scan walks every transcript — not cheap); "Rescan" clears it.
  let usageReport: ipc.UsageReport | null = null;
  let usageAccount: ipc.ClaudeAccount | null = null;   // how the user is signed in
  let codexUsageReport: ipc.CodexUsageReport | null = null;
  let codexUsageAccount: ipc.CodexAccount | null = null;
  let usageEngines: ipc.EngineDetection | null = deps.getEngines?.() || null;
  let usageEnginesChecked = usageEngines != null;
  let usageProvider: 'claude' | 'codex' = 'claude';
  let usageLoading = false;

  // ── connectors (MCP) pane state ──────────────────────────────────────────────
  // Dual-engine: a connector can be configured in Claude Code AND/OR Codex, each
  // with its own separate config + sign-in. We load per engine and merge.
  let mcpEngines: ipc.McpEngine[] | null = null;   // installed engines (null = not detected yet)
  const mcpByEngine: Record<string, ipc.McpServer[] | null> = { claude: null, codex: null };
  let mcpLoading = false;
  let mcpError: string | null = null;              // load/action error to surface
  const mcpBusy = new Set<string>();               // catalog keys with an add/remove in flight
  let mcpAddTargets: ipc.McpEngine[] | null = null; // which engines a "+"/Connect writes to (null = all installed)
  let mcpLoginKey: string | null = null;           // "<engine>:<name>" currently signing in
  let mcpLoginLabel = '';                           // human label for the active sign-in
  let mcpLoginLog = '';                            // streamed sign-in output
  let mcpLoginId: string | null = null;            // active login pty id (for cancel)
  let mcpLoginUnlisten: (() => void) | null = null;
  let mcpLoginQueue: Array<{ engine: ipc.McpEngine; name: string; label: string }> = [];  // sequential sign-ins
  let mcpSearch = '';                               // connector browse filter (preserved across rerenders)

  const ENGINE_META: Record<ipc.McpEngine, { label: string; img: string }> = {
    claude: { label: 'Claude', img: claudeLogo },
    codex: { label: 'ChatGPT', img: codexLogo },
  };

  function currentWorkspace(): WorkspaceGroup | null {
    if (!currentPane.startsWith('workspace:')) return null;
    const id = Number(currentPane.slice('workspace:'.length));
    return deps.groups.find(g => g.id === id) || null;
  }
  // Outside callers still say open('workspaces') (the palette, old habits);
  // ids are client-session-only, so a stale workspace route degrades politely.
  function normalizePane(p: string): string {
    if (p === 'workspaces' || p === 'general' || p === 'context' || p === 'git') return 'defaults';
    if (p.startsWith('workspace:')) {
      const id = Number(p.slice('workspace:'.length));
      return deps.groups.some(g => g.id === id) ? p : 'defaults';
    }
    return p;
  }

  // ── tiny DOM helper, same shape app.ts uses: mk('div', {class, onclick}, ...kids)
  function mk(tag: string, props?: Record<string, any> | null, ...kids: Array<Node | string | null | undefined>): HTMLElement {
    const n = document.createElement(tag);
    if (props) for (const k in props) {
      if (k === 'class') n.className = props[k];
      else if (k === 'html') n.innerHTML = props[k];
      else if (k.startsWith('on') && typeof props[k] === 'function') n.addEventListener(k.slice(2), props[k]);
      else if (props[k] != null) n.setAttribute(k, props[k]);
    }
    for (const c of kids) if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return n;
  }

  // Top-bar chrome swap: while Settings is open, the bar's search icon steps
  // aside and a close ✕ takes its slot (same far-right position). CSS hides
  // #barSearch under html.settings-open; we own the ✕ button's lifecycle.
  function mountBarClose(): void {
    document.documentElement.classList.add('settings-open');
    const bar = document.getElementById('bar');
    if (!bar || document.getElementById('barSettingsClose')) return;
    const btn = mk('button', {
      id: 'barSettingsClose', class: 'baricon', 'data-tip': 'Close (Esc)',
      'aria-label': 'Close settings', html: icon('x', 18),
      onclick: () => close(),
    });
    bar.appendChild(btn);
  }
  function unmountBarClose(): void {
    document.documentElement.classList.remove('settings-open');
    document.getElementById('barSettingsClose')?.remove();
  }

  function injectStyles(): void {
    if (document.getElementById('spike-settings-css')) return;
    const style = document.createElement('style');
    style.id = 'spike-settings-css';
    style.textContent = SETTINGS_CSS;
    document.head.appendChild(style);
  }

  // trailing-edge debounce — coalesces a keystroke burst into one re-assembly so
  // the live preview reads instant (~150ms) without re-rendering per character.
  function debounce(fn: () => void, ms = 140): () => void {
    let t: ReturnType<typeof setTimeout> | undefined;
    return () => { if (t) clearTimeout(t); t = setTimeout(fn, ms); };
  }

  // ── primitives ─────────────────────────────────────────────────────────────

  interface RowOpts {
    label: string;
    sublabel?: string;
    sublabelHtml?: string;
    type: 'toggle' | 'number' | 'text' | 'path' | 'textarea' | 'segment' | 'custom';
    value?: any;
    onChange?: (v: any) => void;
    suffix?: string;
    placeholder?: string;
    mono?: boolean;
    rows?: number;
    min?: number;
    options?: Array<{ value: string; label: string }>;   // segment
    control?: HTMLElement;                                // custom
    glyph?: string;   // leading kind-icon inside text/path inputs (icon name)
    svkey?: string;   // data-svkey: rerender() carries focus/draft across repaints
    // stack the control BELOW the label instead of flush right. Implicit for
    // 'textarea'; set it for a 'custom' control that is also full-width, or it
    // gets squeezed into the right-hand column meant for a toggle or a segment.
    stack?: boolean;
  }

  // Wrap an input in a relative field carrying a leading kind-glyph. `grow`
  // makes the field flex to fill its row (workspace folder); omit it for the
  // fixed-width Defaults inputs.
  function withGlyph(input: HTMLElement, glyphName: string, grow?: boolean): HTMLElement {
    return mk('span', { class: 'sv-field' + (grow ? ' grow' : '') },
      mk('span', { class: 'sv-glyph', html: icon(glyphName, 14) }), input);
  }

  // SettingRow: bold label + muted sub-label on the left, the typed control
  // flush right (textarea stacks full-width below instead).
  function settingRow(o: RowOpts): HTMLElement {
    const left = mk('div', { class: 'sv-row-l' }, mk('div', { class: 'sv-label' }, o.label));
    if (o.sublabelHtml) left.appendChild(mk('div', { class: 'sv-sub', html: o.sublabelHtml }));
    else if (o.sublabel) left.appendChild(mk('div', { class: 'sv-sub' }, o.sublabel));
    const ctl = mk('div', { class: 'sv-row-c' });
    const row = mk('div', { class: 'sv-row' + (o.type === 'textarea' || o.stack ? ' sv-row-col' : '') }, left, ctl);

    if (o.type === 'toggle') {
      const t = mk('span', { class: 'sv-toggle' + (o.value ? ' on' : ''), role: 'switch', 'aria-checked': String(!!o.value) });
      t.addEventListener('click', () => {
        const on = !t.classList.contains('on');
        t.classList.toggle('on', on);
        t.setAttribute('aria-checked', String(on));
        o.onChange && o.onChange(on);
      });
      ctl.appendChild(t);
    } else if (o.type === 'number') {
      const input = mk('input', { type: 'number', min: String(o.min != null ? o.min : 1), value: String(o.value),
        'data-svkey': o.svkey }) as HTMLInputElement;
      input.addEventListener('change', () => o.onChange && o.onChange(input.value));
      ctl.appendChild(input);
      if (o.suffix) ctl.appendChild(mk('span', { class: 'sv-suffix' }, o.suffix));
    } else if (o.type === 'text' || o.type === 'path') {
      const input = mk('input', {
        type: 'text', class: 'sv-path' + (o.mono !== false ? ' sv-mono' : ''),
        value: o.value || '', placeholder: o.placeholder || '', spellcheck: 'false',
        'data-svkey': o.svkey,
      }) as HTMLInputElement;
      input.addEventListener('change', () => o.onChange && o.onChange(input.value.trim()));
      const glyphName = o.glyph || (o.type === 'path' ? 'folder' : '');
      ctl.appendChild(glyphName ? withGlyph(input, glyphName) : input);
      if (o.type === 'path') {
        ctl.appendChild(mk('span', { class: 'sv-iconbtn', title: 'pick folder', html: icon('folder', 14),
          onclick: async () => {
            const p = await pickFolderPath();
            if (p) { input.value = p; o.onChange && o.onChange(p); }
          } }));
      }
      if (o.suffix) ctl.appendChild(mk('span', { class: 'sv-suffix' }, o.suffix));
    } else if (o.type === 'textarea') {
      const ta = mk('textarea', {
        class: 'sv-ta' + (o.mono !== false ? ' sv-mono' : ''), rows: String(o.rows || 3),
        placeholder: o.placeholder || '', spellcheck: 'false', 'data-svkey': o.svkey,
      }) as HTMLTextAreaElement;
      ta.value = o.value || '';
      ta.addEventListener('change', () => o.onChange && o.onChange(ta.value));
      ctl.style.display = 'none';
      row.appendChild(ta);
    } else if (o.type === 'segment') {
      ctl.appendChild(segment(o.options || [], o.value, (v) => o.onChange && o.onChange(v)));
    } else if (o.type === 'custom' && o.control) {
      ctl.appendChild(o.control);
    }
    return row;
  }

  // segmented control on the launcher's recessed-track pattern. Each option
  // takes either an `iconName` (SVG from the icon set) OR an `iconHtml`
  // (arbitrary inline markup — used for engine PNGs that don't live in the
  // SVG family). Per-option `disabled` mutes the chip and gates its click —
  // used for "this engine isn't installed on this machine."
  function segment(
    options: Array<{ value: string; label: string; iconName?: string; iconHtml?: string; disabled?: boolean; title?: string }>,
    value: string,
    onPick: (v: string) => void,
    opts?: { disabled?: boolean; title?: string },
  ): HTMLElement {
    const seg = mk('span', { class: 'sv-seg' + (opts && opts.disabled ? ' disabled' : '') });
    if (opts && opts.title) seg.title = opts.title;
    for (const o of options) {
      const b = mk('span', {
        class: 'sv-opt' + (o.value === value ? ' on' : '') + (o.disabled ? ' disabled' : ''),
        'data-svvalue': o.value,
      });
      if (o.title || o.disabled) b.title = o.title || `${o.label} is not installed`;
      if (o.iconHtml) b.appendChild(mk('span', { class: 'sv-ic', html: o.iconHtml, style: 'display:inline-flex' }));
      else if (o.iconName) b.appendChild(mk('span', { class: 'sv-ic', html: icon(o.iconName, 12), style: 'display:inline-flex' }));
      b.appendChild(document.createTextNode(o.label));
      b.addEventListener('click', () => {
        if (opts && opts.disabled) return;
        if (b.classList.contains('disabled')) return;   // per-option gate
        if (o.value === value) return;
        seg.querySelectorAll('.sv-opt').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        value = o.value;
        onPick(o.value);
      });
      seg.appendChild(b);
    }
    return seg;
  }

  function pane(title: string, subtitle: string | HTMLElement | null, ...children: Array<Node | null>): HTMLElement {
    const p = mk('div', { class: 'sv-pane' }, mk('h1', { class: 'sv-title' }, title));
    if (typeof subtitle === 'string') p.appendChild(mk('p', { class: 'sv-subtitle' }, subtitle));
    else if (subtitle) p.appendChild(subtitle);
    for (const c of children) if (c) p.appendChild(c);
    return p;
  }

  // A labeled zone: micro-header + one quiet hint + fields. Shared by the
  // workspace page and Defaults so both read in the same rhythm.
  function zone(title: string, hint: string, ...kids: Array<Node | null>): HTMLElement {
    const z = mk('div', { class: 'sv-zone' },
      mk('div', { class: 'sv-zone-h' }, title),
      mk('div', { class: 'sv-zone-hint' }, hint));
    for (const k of kids) if (k) z.appendChild(k);
    return z;
  }
  // ── permissions ────────────────────────────────────────────────────────────
  // What the agent may do without stopping to ask.
  //
  // This zone SHOWS and REVOKES. It does not author rules, and there is nothing
  // here to type. Rules are added in the moment, by answering a permission
  // prompt, and it is Claude that writes them (the PermissionRequest hook's
  // `updatedPermissions`). Spike synthesizes nothing — an earlier version
  // derived rules from command strings and produced `Bash(sudo:*)` from a single
  // sudo call.
  //
  // It reads and writes the agent's OWN files: ~/.claude/settings.json under
  // Defaults, and <cwd>/.claude/settings.local.json under a Workspace — the
  // gitignored personal layer, so a grant never rides a commit to teammates. So
  // a rule shown here is the rule that governs the chat view, the terminal view,
  // and a bare `claude` run with Spike closed.
  //
  // Rules are shown in plain language, because the audience for "what is my
  // agent allowed to do" is not the audience for `Bash(git status:*)`. The raw
  // rule is kept on the row's title attribute for anyone who wants it.
  function permissionsZone(cwd: string, scope: 'defaults' | 'workspace'): HTMLElement {
    const isDefaults = scope === 'defaults';
    const list = mk('div', { class: 'sv-perm-list', 'data-svkey': 'perm-' + scope });
    const status = mk('span', { class: 'sv-perm-status' }, 'Loading…');
    let rules: string[] = [];
    let readable = false;

    const save = (next: string[], undo: () => void) => {
      const prev = rules;
      rules = next;
      paint();
      status.textContent = 'Saving…';
      ipc.permissionRulesSet(cwd, scope, next)
        .then(() => { paint(); })
        .catch((e) => {
          // A failed revoke must not look like a successful one. Put the rule
          // back and say why, rather than leaving the pane claiming a grant is
          // gone while the agent still honors it.
          rules = prev; undo(); paint();
          status.textContent = "Couldn't save: " + String(e);
        });
    };

    function paint() {
      list.textContent = '';
      if (!readable) return;
      if (!rules.length) {
        list.appendChild(mk('div', { class: 'sv-perm-empty' },
          isDefaults
            ? "Nothing yet. When you tell the agent not to ask again about something, it shows up here."
            : 'Nothing specific to this workspace yet.'));
        status.textContent = '';
        return;
      }
      for (const rule of rules) {
        const row = mk('div', { class: 'sv-perm-row', title: rule });
        row.appendChild(mk('span', { class: 'sv-perm-what' }, describeRule(rule)));
        const x = mk('button', { class: 'sv-perm-x', type: 'button', title: 'Remove this permission' }, '×');
        x.addEventListener('click', () => save(rules.filter(r => r !== rule), () => {}));
        row.appendChild(x);
        list.appendChild(row);
      }
      status.textContent = `${rules.length} permission${rules.length === 1 ? '' : 's'}`;
    }

    // defaultMode governs everything NOT matched by a rule. Only Defaults
    // carries it: it is user-scope in Claude, and writing it anywhere else
    // produces a key that silently does nothing.
    //
    // Built after the read rather than pre-selected and corrected, because
    // segment() closes over its initial value — a row rendered at 'default' and
    // then re-classed would swallow the first click back onto 'default'.
    const modeHost = isDefaults ? mk('div') : null;

    const z = zone(
      'Permissions',
      isDefaults
        ? "What the agent may do without asking, everywhere. These live in the agent's own settings, so they apply in the terminal too."
        : 'Extra permissions for this workspace only, on top of Defaults. Kept out of version control, so they stay yours.',
      modeHost,
      settingRow({
        label: 'Allowed without asking',
        sublabel: 'Added when you tell the agent not to ask again about something. Remove one with ×.',
        type: 'custom', stack: true, control: mk('div', { class: 'sv-perm-ctl' }, list, status),
      }),
    );

    ipc.permissionRules(cwd).then((r) => {
      readable = true;
      rules = (isDefaults ? r.defaults : r.workspace) || [];
      paint();
      if (modeHost) modeHost.appendChild(settingRow({
        label: 'When no rule matches',
        sublabel: 'Ask is the safe default. Auto-approve reads lets the agent look around without interrupting, and still asks before it changes, runs, or sends anything.',
        type: 'segment', value: r.mode || 'default',
        options: [
          { value: 'default', label: 'Ask' },
          { value: 'auto', label: 'Auto-approve reads' },
          { value: 'acceptEdits', label: 'Auto-approve edits' },
        ],
        onChange: (v) => {
          status.textContent = 'Saving…';
          ipc.permissionRulesSet(cwd, 'defaults', rules, v)
            .then(() => paint())
            .catch((e) => { status.textContent = "Couldn't save: " + String(e); });
        },
      }));
    }).catch((e) => {
      // The backend rejects rather than resolving when a settings file exists
      // but doesn't parse. Say so and stay read-only: an empty list would read
      // as "no permissions", and acting on that would write emptiness over the
      // real ones.
      readable = false;
      list.textContent = '';
      list.appendChild(mk('div', { class: 'sv-perm-empty' },
        "Can't read your permissions, so they can't be changed here. " + String(e)));
      status.textContent = '';
    });
    return z;
  }

  // Claude's rule syntax rendered as something a person can act on. `Bash(x:*)`
  // is precise and unreadable; "Run git status commands" is the same fact in the
  // language of the question being asked. Anything unrecognised falls through
  // verbatim rather than being guessed at — a wrong plain-language gloss on a
  // permission is worse than raw syntax.
  function describeRule(rule: string): string {
    const m = /^([A-Za-z_]+)\((.*)\)$/.exec(rule.trim());
    if (!m) return rule;
    const [, tool, arg] = m;
    const cmd = arg.replace(/:\*$/, '');
    switch (tool) {
      case 'Bash':
        return arg.endsWith(':*') ? `Run ${cmd} commands` : `Run ${cmd}`;
      case 'Read':   return `Read ${prettyPath(arg)}`;
      case 'Edit':
      case 'Write':  return `Change ${prettyPath(arg)}`;
      case 'WebFetch': {
        const d = /^domain:(.+)$/.exec(arg);
        return d ? `Fetch pages from ${d[1]}` : `Fetch ${arg}`;
      }
      default:       return `${tool}: ${arg}`;
    }
  }
  function prettyPath(p: string): string {
    const s = p.replace(/^\/\//, '/');
    if (s === '**' || s === '*') return 'any file';
    return s.endsWith('/**') ? `anything in ${s.slice(0, -3)}` : s;
  }


  // tiny field-status badge — rendered only when a field is empty, so a
  // configured workspace reads clean and the gaps stand out.
  function badge(label: 'empty' | 'none', visible: boolean): HTMLElement {
    const b = mk('span', { class: 'sv-badge' }, label);
    if (!visible) b.style.display = 'none';
    return b;
  }

  // ── split-view primitives (settings revamp) ────────────────────────────────
  // The left column is one bordered card of hairline-separated rows; the right
  // column is the assembled-context panel. Both Defaults and each Workspace use
  // this shape so the layering reads the same everywhere.

  function fieldCard(...rows: Array<Node | null>): HTMLElement {
    const card = mk('div', { class: 'sv-fieldcard' });
    for (const r of rows) if (r) card.appendChild(r);
    return card;
  }

  // A field-card row: a header line (icon + label, plus an optional badge, right
  // note, and/or a flush-right control), then optional stacked content below.
  // Header and below can coexist (isolation needs a control AND a detail line).
  function fcRow(iconName: string, label: string,
    opts: { rnote?: string; badge?: HTMLElement; right?: HTMLElement | string; below?: Array<Node | null> } = {}): HTMLElement {
    const lbl = mk('div', { class: 'sv-fc-lbl' },
      mk('span', { class: 'sv-ic', html: icon(iconName, 15) }),
      mk('span', { class: 't' }, label));
    if (opts.badge) lbl.appendChild(opts.badge);
    if (opts.rnote) lbl.appendChild(mk('span', { class: 'rnote' }, opts.rnote));
    const head = mk('div', { class: 'sv-fc-head' }, lbl);
    if (opts.right !== undefined)
      head.appendChild(mk('div', { class: 'sv-fc-ctl' },
        typeof opts.right === 'string' ? mk('span', { class: 'sv-fc-chip' }, opts.right) : opts.right));
    const row = mk('div', { class: 'sv-fc-row' }, head);
    if (opts.below && opts.below.length) {
      row.appendChild(mk('div', { class: 'sv-fc-gap' }));
      for (const c of opts.below) if (c) row.appendChild(c);
    }
    return row;
  }

  // The assembled-context panel — the right column of both screens, and the
  // single place ContextLine[] renders. Returns the whole column (section head +
  // panel + caption) plus an `update(lines)` for live, debounced re-render.
  // `showInherited` toggles the gold legend + "root" note (Defaults hides both).
  function assembledPanel(opts: {
    headLabel: string;
    showInherited: boolean;
    caption?: HTMLElement | string;
    onEditInDefaults?: () => void;
  }): { el: HTMLElement; update: (lines: ContextLine[]) => void } {
    const tokenEl = mk('span', { class: 'r sv-tok' });
    const head = mk('div', { class: 'sv-colhead' },
      mk('span', { class: 'lbl' }, opts.headLabel), tokenEl);

    const legend = mk('div', { class: 'sv-legend' });
    if (opts.showInherited)
      legend.appendChild(mk('span', { class: 'k' }, mk('span', { class: 'sw inh' }), 'inherited'));
    legend.appendChild(mk('span', { class: 'k' }, mk('span', { class: 'sw set' }), 'set here'));
    legend.appendChild(mk('span', { class: 'k' }, mk('span', { class: 'sw auto' }), 'by Spike'));
    if (!opts.showInherited)
      legend.appendChild(mk('span', { class: 'root' }, 'no inherited layer — this is the root'));

    const plines = mk('div', { class: 'sv-plines' });
    const panel = mk('div', { class: 'sv-panel' }, legend, plines);
    const col = mk('div', { class: 'sv-panelcol' }, head, panel);
    if (opts.caption)
      col.appendChild(typeof opts.caption === 'string'
        ? mk('div', { class: 'sv-cap' }, opts.caption) : opts.caption);

    const cls: Record<ContextLine['from'], string> = { 'inherited': 'inh', 'set-here': 'set', 'auto': 'auto' };
    const update = (lines: ContextLine[]): void => {
      plines.innerHTML = '';
      for (const l of lines) {
        // inherited lines are read-only here — they carry an "edit in Defaults"
        // affordance instead (the one source is edited on the Defaults screen).
        if (l.from === 'inherited' && opts.onEditInDefaults) {
          const row = mk('div', { class: 'sv-pl inh' },
            mk('span', { class: 'txt' }, l.text));
          row.appendChild(mk('span', { class: 'sv-pl-link', title: 'edit in Defaults',
            onclick: opts.onEditInDefaults }, 'edit in Defaults'));
          plines.appendChild(row);
        } else {
          plines.appendChild(mk('div', { class: 'sv-pl ' + cls[l.from] }, l.text));
        }
      }
      tokenEl.textContent = tokenEstimate(joinContext(lines).length) + ' tokens';
    };
    return { el: col, update };
  }

  // ── workspaces pane ─────────────────────────────────────────────────────────

  function swatchesFor(g: WorkspaceGroup): string[] {
    const base = [...deps.groupColors, ...EXTRA_COLORS];
    // a pre-existing custom color (from the old native picker) shows as an
    // extra swatch, but there is no custom-picker affordance — presets only.
    if (g.color && !base.some(c => c.toLowerCase() === g.color.toLowerCase())) base.push(g.color);
    return base;
  }

  function closeSwatchPop(): void {
    if (swatchPop) { swatchPop.remove(); swatchPop = null; }
    document.removeEventListener('mousedown', onDocDownSwatch, true);
  }
  function onDocDownSwatch(e: Event): void {
    if (swatchPop && !swatchPop.contains(e.target as Node)) closeSwatchPop();
  }
  function openSwatchPop(g: WorkspaceGroup, host: HTMLElement, anchor: HTMLElement): void {
    closeSwatchPop();
    const pop = mk('div', { class: 'sv-swpop' });
    for (const c of swatchesFor(g)) {
      pop.appendChild(mk('span', {
        class: 'sv-swatch' + (c.toLowerCase() === (g.color || '').toLowerCase() ? ' on' : ''),
        style: `background:${c}`, title: c,
        onclick: (e: Event) => {
          e.stopPropagation();
          g.color = c;
          deps.persistGroup(g);
          deps.renderTabs();
          closeSwatchPop();
          rerender();
        },
      }));
    }
    host.appendChild(pop);
    // anchored under the dot, clamped inside the positioned host
    const cr = host.getBoundingClientRect();
    const ar = anchor.getBoundingClientRect();
    pop.style.left = Math.max(6, ar.left - cr.left - 6) + 'px';
    pop.style.top = (ar.bottom - cr.top + 7) + 'px';
    swatchPop = pop;
    setTimeout(() => document.addEventListener('mousedown', onDocDownSwatch, true), 0);
  }

  // ── card ⋯ menu (settings-polish 2e) — same anchor/dismiss pattern as the
  // swatch picker: appended to the card, closed on any outside mousedown.
  function closeCardMenu(): void {
    if (cardMenu) { cardMenu.remove(); cardMenu = null; }
    document.removeEventListener('mousedown', onDocDownMenu, true);
  }
  function onDocDownMenu(e: Event): void {
    if (cardMenu && !cardMenu.contains(e.target as Node)) closeCardMenu();
  }
  function openCardMenu(g: WorkspaceGroup, host: HTMLElement, anchor: HTMLElement): void {
    const wasOpen = !!cardMenu && cardMenu.parentElement === host;
    closeCardMenu();
    closeSwatchPop();
    if (wasOpen) return;   // second click on the same ⋯ toggles closed
    const item = (label: string, iconName: string, fn: () => void, danger?: boolean) =>
      mk('div', { class: 'sv-mi' + (danger ? ' danger' : ''), onclick: () => { closeCardMenu(); fn(); } },
        mk('span', { class: 'sv-ic', html: icon(iconName, 13) }), label);
    const menu = mk('div', { class: 'sv-menu' },
      item('Open', 'external-link', () => { close(); deps.openWorkspace(g); }),
      item('Rename', 'pencil', () => {
        const nameEl = host.querySelector('.sv-name');
        if (nameEl) beginNameEdit(g, nameEl as HTMLElement);
      }),
      item('Duplicate', 'copy', () => duplicateWorkspace(g)),
      mk('div', { class: 'sv-msep' }),
      item('Delete', 'trash', () => deleteWorkspace(g), true),
    );
    host.appendChild(menu);
    // anchored under the ⋯, right-aligned to it, clamped inside the host
    const cr = host.getBoundingClientRect();
    const ar = anchor.getBoundingClientRect();
    menu.style.top = (ar.bottom - cr.top + 5) + 'px';
    menu.style.right = Math.max(6, cr.right - ar.right) + 'px';
    cardMenu = menu;
    setTimeout(() => document.addEventListener('mousedown', onDocDownMenu, true), 0);
  }

  // ── isolation "?" explainer (settings-polish 2c): hover-shown popover that
  // explains BOTH modes; click pins it open until the next outside click.
  function closeIsoPop(): void {
    if (isoPop) { isoPop.remove(); isoPop = null; }
    document.removeEventListener('mousedown', onDocDownIso, true);
  }
  function onDocDownIso(e: Event): void {
    if (isoPop && !isoPop.contains(e.target as Node)) closeIsoPop();
  }
  function openIsoPop(host: HTMLElement, anchor: HTMLElement): void {
    closeIsoPop();
    const pop = mk('div', { class: 'sv-isopop' });
    pop.appendChild(mk('div', null,
      mk('span', { class: 'k' }, 'Shared'),
      ' — all tabs use the same checkout. Fast, but concurrent agents can race on the same files.'));
    pop.appendChild(mk('div', { style: 'margin-top:5px' },
      mk('span', { class: 'k' }, 'Auto-worktree'),
      ' — 2nd+ concurrent agents each get an isolated git worktree on a fresh branch. Needs a git repo.'));
    // the live on-close policy, so the explainer answers the next question too
    const wt = ((deps.getConfig() || {}).worktree) || {};
    const policy = wt.onClose === 'ask' ? 'always asks'
      : wt.onClose === 'keep-branch' ? 'keeps the branch'
      : 'auto-merges if clean';
    pop.appendChild(mk('div', { style: 'margin-top:5px' },
      mk('span', { class: 'k' }, 'On tab close'),
      ` — ${policy}. Configurable in Defaults.`));
    host.appendChild(pop);
    const cr = host.getBoundingClientRect();
    const ar = anchor.getBoundingClientRect();
    pop.style.left = Math.max(6, ar.left - cr.left - 6) + 'px';
    pop.style.top = (ar.bottom - cr.top + 7) + 'px';
    isoPop = pop;
    setTimeout(() => document.addEventListener('mousedown', onDocDownIso, true), 0);
  }

  // Duplicate (2e): a fresh workspace through the normal create path, seeded
  // with the source's config — "name copy", same color/cwd/pins/isolation,
  // fresh createdAt, zero tabs — plus a clone of the .md's user-owned tail.
  function duplicateWorkspace(g: WorkspaceGroup): void {
    let name = `${g.name} copy`;
    for (let n = 2; deps.groups.some(x => x.name === name); n++) name = `${g.name} copy ${n}`;
    const d = deps.newWorkspace({
      name, color: g.color, cwd: g.cwd || '', description: g.description || '',
      pinnedPaths: [...(g.pinnedPaths || [])],
      isolation: g.isolation === 'auto-worktree' ? 'auto-worktree' : 'shared',
    });
    // carry the instructions tail over via the note contract (saveNote
    // read-modify-writes, so it composes with the factory's own .md write
    // in either arrival order)
    const src = contextMdPath(g);
    if (src) {
      ipc.readFile(src).then((r) => {
        const text = (r && r.content) || '';
        const idx = text.indexOf(GROUP_MD_MARKER);
        const tail = (idx === -1 ? text : text.slice(idx + GROUP_MD_MARKER.length)).replace(/^\n+|\n+$/g, '');
        if (tail) saveNote(d, tail);
      }).catch(() => {});
    }
    deps.renderTabs();
    currentPane = 'workspace:' + d.id;   // duplicating lands you on the copy
    rerender();
  }

  // Path for display (2b): collapse $HOME to ~, then truncate long paths from
  // the LEFT so the telling tail stays visible. Cuts on a / when one is near.
  function displayPath(p: string, max = 56): string {
    let d = p;
    if (homeDir && (d === homeDir || d.startsWith(homeDir + '/'))) d = '~' + d.slice(homeDir.length);
    if (d.length <= max) return d;
    const cut = d.length - max;
    const slash = d.indexOf('/', cut);
    return '…' + (slash >= 0 && slash < d.length - 8 ? d.slice(slash) : d.slice(cut));
  }

  function beginNameEdit(g: WorkspaceGroup, nameEl: HTMLElement): void {
    // data-svkey/-gid: rerender() carries an in-flight rename across the async
    // repaints (git check, note/pin stats) that fire right after a page opens.
    const input = mk('input', { class: 'sv-nameedit', value: g.name, spellcheck: 'false',
      'data-svkey': 'name', 'data-gid': String(g.id) }) as HTMLInputElement;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const commit = (ok: boolean) => {
      if (done) return; done = true;
      const v = input.value.trim();
      if (ok && v && v !== g.name) {
        // the disk key IS the name; a rename moves the .json + .md pair.
        // Existing worktrees/branches keep their old-name slugs by design.
        const old = g.name;
        g.name = v;
        deps.unpersistGroup(old);
        deps.persistGroup(g);
        deps.renderTabs();
      }
      rerender();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit(true);
      else if (e.key === 'Escape') commit(false);
      e.stopPropagation();
    });
    // Chromium fires blur on a focused element WHILE its subtree is being
    // removed — which is every rerender (innerHTML reset). Committing there
    // re-enters rerender mid-render and kills the mid-edit carry. Defer one
    // tick: a removal-blur leaves the input disconnected (the carry re-opens
    // the editor); a real user blur leaves it in the document — commit then.
    input.addEventListener('blur', () => {
      setTimeout(() => { if (input.isConnected) commit(true); }, 0);
    });
  }

  function deleteWorkspace(g: WorkspaceGroup): void {
    // same behavior as the tab-strip "Ungroup": members detach (ptys keep
    // running), the group's files are removed. Single deliberate click, no
    // confirmation modal — matching the existing delete path.
    for (const s of deps.membersOf(g.id)) s.groupId = null;
    const gi = deps.groups.findIndex(x => x.id === g.id);
    if (gi >= 0) deps.groups.splice(gi, 1);
    deps.unpersistGroup(g.name);
    // deleting the page you're on lands on the neighbor that took its slot,
    // so working down the rail never bounces you out of workspace-land.
    if (currentPane === 'workspace:' + g.id) {
      const next = deps.groups[Math.min(Math.max(gi, 0), deps.groups.length - 1)];
      currentPane = next ? 'workspace:' + next.id : 'defaults';
    }
    deps.renderTabs();
    rerender();
  }

  function contextMdPath(g: WorkspaceGroup): string | null {
    if (!homeDir) return null;
    return `${homeDir}/.spike/groups/${sanitizeGroupName(g.name)}.md`;
  }

  // is this workspace's cwd inside a git repo? cached per open; null = unknown
  // (still resolving / no cwd).
  function gitRepoKnown(g: WorkspaceGroup): boolean | null {
    const cwd = (g.cwd || '').trim();
    if (!cwd) return false;
    if (gitRepoCache.has(cwd)) return gitRepoCache.get(cwd)!;
    const key = `git:${cwd}`;
    if (!inflight.has(key)) {
      inflight.add(key);
      ipc.gitRepoCheck(cwd).then((ok) => {
        gitRepoCache.set(cwd, !!ok);
        inflight.delete(key);
        rerender();
      }).catch(() => { gitRepoCache.set(cwd, false); inflight.delete(key); });
    }
    return null;
  }

  // ── defaults pane ───────────────────────────────────────────────────────────
  // Everything every workspace inherits, in one home: the spawn layer (the old
  // General rows), the global agent prompt (the old Context pane), and the
  // worktree machinery (the old Git & worktrees pane). Rows moved verbatim —
  // same labels and patch shapes — only regrouped.

  function paneDefaults(): HTMLElement {
    const cfg = deps.getConfig() || {};
    const sd = cfg.spawnDefaults || {};
    const lg = cfg.logging || {};
    const wt = cfg.worktree || {};
    const patchWt = (k: string, v: string) =>
      deps.patchConfig({ worktree: { ...(((deps.getConfig() || {}).worktree) || {}), [k]: v } });
    const patchSd = (k: string, v: string) =>
      deps.patchConfig({ spawnDefaults: { ...(((deps.getConfig() || {}).spawnDefaults) || {}), [k]: v } });

    // ── engine control: the segment carries its own install state (settings
    // revamp Fix 10 — Codex-unavailable folds INTO the toggle instead of a
    // separate checklist). An uninstalled engine's chip dims and grows an
    // inline `install` link; selecting it stays impossible (segment gates it).
    const engines0 = deps.getEngines?.() || null;
    const INSTALL_URL: Record<string, string> = {
      claude: 'https://www.anthropic.com/claude-code',
      codex: 'https://github.com/openai/codex',
    };
    const engSeg = segment(
      [
        { value: 'claude', label: 'Claude', iconHtml: `<img src="${claudeLogo}" width="12" height="12" alt="" style="display:block">`,
          disabled: engines0?.claude?.installed === false },
        { value: 'codex', label: 'Codex', iconHtml: `<span class="cicon-codex" style="display:inline-flex"><img src="${codexLogo}" width="12" height="12" alt="" style="display:block"></span>`,
          disabled: engines0?.codex?.installed === false },
        { value: 'shell', label: 'Terminal', iconName: 'terminal' },
      ],
      sd.engine || 'claude',
      (v) => patchSd('engine', v),
    );
    // Paint install-state onto the chips — from cache immediately (no flash),
    // then again when detection resolves. Idempotent: re-removes a stale link.
    const decorateEngines = (d: { claude: { installed: boolean }; codex: { installed: boolean } }) => {
      engSeg.querySelectorAll('.sv-opt').forEach((el: Element) => {
        const v = (el as HTMLElement).dataset.svvalue;
        if (!v) return;
        const installed = v === 'shell' || (v === 'claude' ? d.claude.installed : v === 'codex' ? d.codex.installed : true);
        el.classList.toggle('disabled', !installed);
        const prior = el.querySelector('.eng-install');
        if (prior) prior.remove();
        if (!installed && INSTALL_URL[v]) {
          (el as HTMLElement).title = `${v[0].toUpperCase() + v.slice(1)} is not installed`;
          el.appendChild(mk('span', { class: 'eng-install', title: `install ${v}`,
            onclick: (e: Event) => { e.stopPropagation(); ipc.openExternal(INSTALL_URL[v]).catch(() => {}); } }, 'install'));
        }
      });
    };
    if (engines0) decorateEngines(engines0);
    ipc.detectEngines().then(decorateEngines).catch(() => {});

    // ── default view: which face a new agent lane opens in. Most people pick
    // one and stay — a non-coder lives in Chat, a terminal-lover never leaves
    // the terminal — so this is a set-once default, not a toggle. Chat is the
    // out-of-the-box default (calm view first); a terminal-lover picks Terminal
    // and it sticks. Terminal-only spawns ignore it (a shell has no transcript).
    const viewSeg = segment(
      [
        { value: 'terminal', label: 'Terminal', iconName: 'terminal' },
        { value: 'chat', label: 'Chat', iconName: 'message' },
      ],
      sd.view === 'terminal' ? 'terminal' : 'chat',
      (v) => patchSd('view', v),
    );

    // ── left field-card inputs. Held so the live preview can read their
    // current (pre-blur) values on every keystroke.
    const shellIn = mk('input', { type: 'text', class: 'sv-mono', value: sd.shell || '',
      placeholder: '$SHELL (default)', spellcheck: 'false', style: 'width:160px;text-align:right' }) as HTMLInputElement;
    shellIn.addEventListener('change', () => patchSd('shell', shellIn.value.trim()));

    const cwdIn = mk('input', { type: 'text', class: 'sv-mono', value: sd.cwd || '',
      placeholder: 'project root (default)', spellcheck: 'false' }) as HTMLInputElement;
    cwdIn.addEventListener('change', () => patchSd('cwd', cwdIn.value.trim()));
    const cwdPick = mk('span', { class: 'sv-iconbtn', title: 'pick folder', html: icon('folder', 14),
      onclick: async () => { const p = await pickFolderPath(); if (p) { cwdIn.value = p; patchSd('cwd', p); refresh(); } } });

    const promptTa = mk('textarea', { class: 'sv-ta sv-mono', rows: '3', spellcheck: 'false',
      placeholder: 'e.g. "Be concise. Prefer editing existing files over creating new ones."' }) as HTMLTextAreaElement;
    promptTa.value = cfg.spawnPromptAppend || '';
    promptTa.addEventListener('change', () => deps.patchConfig({ spawnPromptAppend: promptTa.value }));

    const recentIn = mk('input', { type: 'number', min: '1',
      value: String(lg.recentCount != null ? lg.recentCount : 10) }) as HTMLInputElement;
    recentIn.addEventListener('change', () => deps.patchConfig({
      logging: { ...((deps.getConfig() || {}).logging || {}), recentCount: Math.max(1, parseInt(recentIn.value, 10) || 10) } }));

    // ── right panel: what flows into every workspace (root layer, no inherited)
    const panel = assembledPanel({
      headLabel: 'FLOWS INTO EVERY WORKSPACE',
      showInherited: false,
      caption: 'Every workspace opens with these lines, then stacks its own on top. Change one here and it moves in all of them at once.',
    });
    const readDefaults = () => ({
      spawnPromptAppend: promptTa.value,
      cwd: cwdIn.value.trim(),
      recentCount: Math.max(1, parseInt(recentIn.value, 10) || 10),
    });
    const refresh = () => panel.update(assembleContext(readDefaults(), null));
    const refreshD = debounce(refresh);
    promptTa.addEventListener('input', refreshD);
    cwdIn.addEventListener('input', refreshD);
    recentIn.addEventListener('input', refresh);
    refresh();

    const card = fieldCard(
      fcRow('adjustments', 'Engine', { rnote: 'new tabs only', below: [engSeg] }),
      // Terminal vs Chat, in an edition with no chat: the row would offer a
      // choice with one outcome. spawnDefaults.view stays in the config file for
      // the full edition to own; the shell just doesn't render the control.
      ...(CHAT_ENABLED ? [fcRow('message', 'Default view', { rnote: 'agent tabs only', below: [viewSeg] })] : []),
      fcRow('terminal', 'Shell', { right: shellIn }),
      fcRow('folder', 'Fallback directory', {
        below: [mk('div', { class: 'sv-monofield' }, withGlyph(cwdIn, 'folder', true), cwdPick)] }),
      fcRow('message', 'Spawn prompt', { below: [promptTa] }),
      fcRow('file-text', 'Recent files in context', { right: recentIn }),
    );

    // Worktrees lives in the LEFT column, below the field card — it's a form
    // concern, so it aligns under the card at the same width instead of
    // stretching full-bleed across the page (which read as a grafted-on layout
    // with cavernous label→control gaps). A hairline sets it apart as secondary.
    const worktreeZone = zone('Worktrees', 'How Auto-worktree workspaces behave. These control spawn behavior, not the prompt above.',
      settingRow({
        label: 'Worktree location', sublabel: 'Where ephemeral worktrees are created. Relative paths resolve against the repo root.',
        type: 'text', mono: true, value: wt.location || '.spike/worktrees/', placeholder: '.spike/worktrees/', svkey: 'wtloc',
        onChange: (v) => patchWt('location', v || '.spike/worktrees/'),
      }),
      settingRow({
        label: 'On tab close', sublabel: "What happens to a worktree when its agent's tab closes. Merges are never forced — conflicts always fall back to asking.",
        type: 'segment', value: wt.onClose || 'auto-merge-clean',
        options: [
          { value: 'auto-merge-clean', label: 'Auto-merge if clean' },
          { value: 'ask', label: 'Always ask' },
          { value: 'keep-branch', label: 'Keep branch' },
        ],
        onChange: (v) => patchWt('onClose', v),
      }),
      settingRow({
        label: 'Branch prefix', sublabel: 'Naming for auto-created branches.',
        type: 'text', mono: true, value: wt.branchPrefix || 'spike/wt-', placeholder: 'spike/wt-', svkey: 'wtprefix',
        onChange: (v) => patchWt('branchPrefix', v || 'spike/wt-'),
      }));

    const split = mk('div', { class: 'sv-split' },
      mk('div', { class: 'sv-formcol' },
        mk('div', { class: 'sv-colhead' }, mk('span', { class: 'lbl' }, 'SET FOR EVERY WORKSPACE')),
        card, worktreeZone, permissionsZone('', 'defaults')),
      panel.el);

    const defaultsPane = pane('Defaults',
      'Set once, inherited by every workspace. The right panel is what each workspace starts from — before it adds its own folder and context.',
      split);
    defaultsPane.classList.add('sv-wide');
    return defaultsPane;
  }

  // ── files pane ──────────────────────────────────────────────────────────────

  function paneFiles(): HTMLElement {
    const pd = (deps.getConfig() || {}).previewDefaults || {};
    const setPref = (ext: string, mode: string | null) => {
      const next: Record<string, string> = { ...((deps.getConfig() || {}).previewDefaults || {}) };
      if (mode) next[ext] = mode; else delete next[ext];
      deps.patchConfig({ previewDefaults: next });
      rerender();
    };

    // One bordered card: each rule is a hairline-separated row (extension ·
    // rendered/source segment · remove), with an add-row footer. Matches the
    // Defaults fieldcard so Files reads as the same instrument, not a pill soup.
    const card = mk('div', { class: 'sv-fieldcard sv-rulecard' });
    const exts = Object.keys(pd).sort();
    if (!exts.length) {
      card.appendChild(mk('div', { class: 'sv-fc-row' },
        mk('div', { class: 'sv-empty', style: 'padding:2px 0' },
          'No custom rules yet. Every file opens in source mode until you add one below.')));
    } else {
      for (const ext of exts) {
        const row = mk('div', { class: 'sv-fc-row' },
          mk('div', { class: 'sv-rule' },
            mk('span', { class: 'sv-ruleext' }, ext),
            mk('span', { class: 'sv-rulearrow' }, 'opens as'),
            mk('div', { class: 'sv-rule-ctl' },
              segment(
                [{ value: 'rendered', label: 'rendered' }, { value: 'source', label: 'source' }],
                pd[ext], (v) => setPref(ext, v)),
              mk('span', { class: 'sv-rule-rm', title: 'remove rule', html: icon('x', 13),
                onclick: () => setPref(ext, null) }))));
        card.appendChild(row);
      }
    }

    // add-row footer: extension input + mode segment + Add
    const extIn = mk('input', { type: 'text', class: 'sv-mono', placeholder: '.ext', spellcheck: 'false' }) as HTMLInputElement;
    let mode = 'rendered';
    const seg = segment(
      [{ value: 'rendered', label: 'rendered' }, { value: 'source', label: 'source' }],
      mode, (v) => { mode = v; });
    const add = () => {
      let e = extIn.value.trim().toLowerCase();
      if (!e) return;
      if (!e.startsWith('.')) e = '.' + e;
      setPref(e, mode);
    };
    extIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    card.appendChild(mk('div', { class: 'sv-fc-row sv-rule-add' },
      mk('div', { class: 'sv-rule' },
        extIn,
        mk('div', { class: 'sv-rule-ctl' }, seg,
          mk('span', { class: 'sv-btn', onclick: add }, 'Add rule')))));

    return pane('Files', 'How files open by default, by extension. Takes effect immediately.', card);
  }

  // ── privacy & logs pane ─────────────────────────────────────────────────────

  function panePrivacy(): HTMLElement {
    const lg = (deps.getConfig() || {}).logging || {};
    const card = mk('div', { class: 'sv-cardgroup' },
      settingRow({
        label: 'Record session activity',
        sublabelHtml: 'Tracks file opens, edits, and spawns. Stored locally at <code>~/.spike/logs</code> — never sent anywhere.',
        type: 'toggle', value: lg.enabled !== false,
        onChange: (on) => deps.patchConfig({ logging: { ...((deps.getConfig() || {}).logging || {}), enabled: !!on } }),
      }),
      settingRow({
        label: 'Keep logs for', type: 'number', min: 1, suffix: 'days',
        value: lg.retentionDays != null ? lg.retentionDays : 30,
        onChange: (v) => deps.patchConfig({ logging: { ...((deps.getConfig() || {}).logging || {}), retentionDays: Math.max(1, parseInt(v, 10) || 30) } }),
      }));
    return pane('Privacy & logs',
      'Spike records activity locally so you can mine your own work. Nothing leaves your machine.',
      card,
      mk('div', { class: 'sv-linkrow', onclick: () => { ipc.openLogDir().catch(() => {}); } },
        mk('span', { class: 'sv-ic', html: icon('folder-open', 13) }), 'Open log directory →'),
    );
  }

  // ── appearance pane ─────────────────────────────────────────────────────────

  // The two palettes, mirrored from index.html. Hardcoded on purpose: each
  // preview must paint the TARGET theme's real colors, so the Light card reads
  // light while Spike itself is dark. Keep in sync with :root / [data-theme].
  const THEME_PAL = {
    dark: { bg: '#1C1A18', rail: '#322F2D', edge: '#3A3836', ink: '#F2EEE9', faint: '#7D7872', accent: '#E2A299' },
    light: { bg: '#F4F0EA', rail: '#FFFFFF', edge: '#D6CFC4', ink: '#1A1816', faint: '#8E867E', accent: '#B85F4E' },
  };

  function paneAppearance(): HTMLElement {
    // Reads the preference at render time, so flipping the theme from the
    // command palette and reopening Settings shows the right selection.
    const bar = (color: string, w: string) => mk('div', { class: 'bar', style: `background:${color};width:${w}` });
    const paintBody = (p: { ink: string; faint: string; accent: string }) => [
      bar(p.ink, '74%'), bar(p.faint, '54%'), bar(p.faint, '64%'),
      mk('div', { class: 'chip', style: `background:${p.accent}` }),
    ];
    const mini = (kind: 'dark' | 'light' | 'system'): HTMLElement => {
      if (kind === 'system') {
        // one tile split diagonally between the two palettes — "adapts to macOS"
        return mk('div', { class: 'sv-mini sys', style: `background:${THEME_PAL.light.bg}` },
          mk('div', { class: 'half dark', style: `background:${THEME_PAL.dark.bg}` },
            bar(THEME_PAL.dark.ink, '60%'), mk('div', { class: 'chip', style: `background:${THEME_PAL.dark.accent}` })),
          mk('div', { class: 'half light' },
            bar(THEME_PAL.light.ink, '60%'), mk('div', { class: 'chip', style: `background:${THEME_PAL.light.accent}` })));
      }
      const p = THEME_PAL[kind];
      return mk('div', { class: 'sv-mini', style: `background:${p.bg}` },
        mk('div', { class: 'rail', style: `background:${p.rail};border-right:1px solid ${p.edge}` }),
        mk('div', { class: 'body' }, ...paintBody(p)));
    };

    const cards = mk('div', { class: 'sv-themes' });
    const opts: Array<{ value: string; label: string; kind: 'dark' | 'light' | 'system' }> = [
      { value: 'dark', label: 'Dark', kind: 'dark' },
      { value: 'light', label: 'Light', kind: 'light' },
      { value: 'system', label: 'System', kind: 'system' },
    ];
    for (const o of opts) {
      const card = mk('div', { class: 'sv-theme' + (deps.getTheme() === o.value ? ' on' : ''), role: 'button', 'aria-pressed': String(deps.getTheme() === o.value) },
        mini(o.kind),
        mk('div', { class: 'cap' },
          mk('span', { class: 'nm' }, o.label),
          mk('span', { class: 'tick', html: icon('check', 13) })));
      card.addEventListener('click', () => {
        if (deps.getTheme() === o.value) return;
        cards.querySelectorAll('.sv-theme').forEach((x) => {
          x.classList.remove('on'); x.setAttribute('aria-pressed', 'false');
        });
        card.classList.add('on'); card.setAttribute('aria-pressed', 'true');
        deps.setTheme(o.value);
      });
      cards.appendChild(card);
    }

    // Accent — the Valence palette (from oasis-web): named, theme-aware accents.
    // Applies live app-wide via deps.setAccent and persists; the first swatch
    // clears the override and returns to the theme's built-in accent.
    const swatches = mk('div', { class: 'sv-swatches' });
    // No explicit choice = the built-in default (Ocean); highlight it.
    const cur = deps.getAccent() || 'ocean';
    const makeSw = (a: { name: string; label: string; dot: string }): HTMLElement => {
      const on = cur === a.name;
      const sw = mk('button', {
        class: 'sv-accsw' + (on ? ' on' : ''),
        title: a.label,
        'aria-label': 'Accent ' + a.label,
        'aria-pressed': String(on),
        style: `background:${a.dot}`,
      });
      sw.addEventListener('click', () => {
        swatches.querySelectorAll('.sv-accsw').forEach((x) => {
          x.classList.remove('on'); x.setAttribute('aria-pressed', 'false');
        });
        sw.classList.add('on'); sw.setAttribute('aria-pressed', 'true');
        deps.setAccent(a.name);
      });
      return sw;
    };
    for (const a of deps.accentPalette) swatches.appendChild(makeSw(a));

    return pane('Appearance', null,
      zone('Theme', 'System follows your macOS appearance setting and flips with it.', cards),
      zone('Accent', 'Colors buttons, links, and the name in your home greeting — everywhere in Spike.', swatches));
  }

  // ── usage pane ────────────────────────────────────────────────────────────
  // Reads Claude Code's own JSONL transcripts (~/.claude/projects) and shows
  // token consumption + a NOTIONAL dollar cost (API list price — not what a
  // Pro/Max subscription is billed). Pure local scan; nothing leaves the box.

  function loadUsage(force?: boolean): void {
    if (usageLoading) return;
    if (usageReport && codexUsageReport && usageEnginesChecked && !force) return;
    if (force) { usageReport = null; codexUsageReport = null; }
    usageLoading = true;
    Promise.all([
      ipc.usageScan(), ipc.claudeAccount().catch(() => null),
      ipc.codexUsageScan(), ipc.codexAccount().catch(() => null),
      ipc.detectEngines().catch(() => null),
    ])
      .then(([r, a, cr, ca, engines]) => {
        usageReport = r; usageAccount = a;
        codexUsageReport = cr; codexUsageAccount = ca;
        usageEngines = engines;
        usageEnginesChecked = true;
        usageLoading = false; rerender();
      })
      .catch(() => { usageEnginesChecked = true; usageLoading = false; rerender(); });
  }

  // dir name → readable project label. Claude encodes the cwd as a dashed slug
  // (-Users-me-dev-spike); we can't losslessly recover it, so just drop the
  // leading dash and left-truncate to keep the telling tail.
  function projLabel(p: string): string {
    let s = p.replace(/^-+/, '');
    // Claude encodes the cwd as a dashed slug; the readable project name is the
    // tail. Drop the "Users-<name>-" home prefix and common container prefixes
    // (dev/, conductor worktrees) so each row LEADS with the project, not the
    // path to it. The full slug stays on hover (the row's title).
    s = s.replace(/^Users-[^-]+-/, '');
    s = s.replace(/^(dev|conductor-workspaces|conductor-repos)-/, '');
    return s.length > 38 ? '…' + s.slice(-37) : s;
  }

  // one breakdown row: label · proportional token bar · cost + token sub
  function usageRow(name: string, title: string, tokens: number, cost: number, maxTokens: number): HTMLElement {
    const fill = mk('span', { class: 'fill', style: `width:${maxTokens > 0 ? Math.max(2, Math.round((tokens / maxTokens) * 100)) : 0}%` });
    return mk('div', { class: 'sv-u-r' },
      mk('span', { class: 'nm', title }, name),
      mk('span', { class: 'track' }, fill),
      mk('span', { class: 'amt' }, fmtUsd(cost)),
      mk('span', { class: 'sub', title: `${tokens.toLocaleString()} tokens` }, fmtTok(tokens)),
    );
  }

  function codexProjLabel(path: string): string {
    const parts = path.split(/[\\/]/).filter(Boolean);
    const tail = parts[parts.length - 1] || path;
    return tail.length > 38 ? '…' + tail.slice(-37) : tail;
  }

  function fmtCredits(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
    if (n >= 10) return n.toFixed(1);
    return n.toFixed(2);
  }

  function codexUsageRow(
    name: string, title: string, tokens: number, amount: string, maxTokens: number,
  ): HTMLElement {
    const fill = mk('span', { class: 'fill', style: `width:${maxTokens > 0 ? Math.max(2, Math.round((tokens / maxTokens) * 100)) : 0}%` });
    return mk('div', { class: 'sv-u-r' },
      mk('span', { class: 'nm', title }, name),
      mk('span', { class: 'track' }, fill),
      mk('span', { class: 'amt' }, amount),
      mk('span', { class: 'sub', title: `${tokens.toLocaleString()} tokens` }, fmtTok(tokens)),
    );
  }

  function paneCodexUsage(head: HTMLElement, providerPicker: HTMLElement): HTMLElement {
    if (!codexUsageReport) {
      return mk('div', { class: 'sv-pane' }, head, providerPicker,
        mk('p', { class: 'sv-subtitle' }, 'Codex writes token snapshots for every local session. Spike reads normal CLI sessions and its isolated Codex tabs — nothing is sent anywhere.'),
        mk('div', { class: 'sv-u-loading' }, usageLoading ? 'Scanning transcripts…' : 'No Codex usage data found.'));
    }

    const r = codexUsageReport;
    const t = r.totals;
    const isApi = codexUsageAccount?.authType === 'api';
    const totalTok = (b: { input: number; output: number }) => b.input + b.output;
    const amount = (b: { credits: number; cost: number }) =>
      isApi ? fmtUsd(b.cost) : `${fmtCredits(b.credits)} cr`;

    const root = mk('div', { class: 'sv-pane' }, head, providerPicker);
    root.appendChild(mk('p', { class: 'sv-subtitle', style: 'margin-bottom:14px' },
      `Token consumption across ${t.sessions.toLocaleString()} Codex sessions, read from local rollout logs.`));

    root.appendChild(mk('div', { class: 'sv-u-hero' },
      mk('span', { class: 'v' }, isApi ? fmtUsd(t.cost) : fmtCredits(t.credits)),
      mk('span', { class: 'lbl' }, isApi ? 'estimated API cost · all time' : 'estimated credits · all time')));

    const authNote = isApi
      ? 'Estimated from local tokens at the Codex rate card. Your OpenAI API usage dashboard remains the billing source of truth.'
      : 'A local token-based estimate. Included plan usage is consumed before purchased credits, so this is a sense of weight—not necessarily money spent.';
    const unpriced = r.unpricedModels.length
      ? ` No rate is known for ${r.unpricedModels.join(', ')}; its tokens are shown but omitted from the estimate.`
      : '';
    root.appendChild(mk('p', { class: 'sv-u-note' }, authNote + unpriced));

    const stat = (n: string, k: string) => mk('div', { class: 'sv-u-stat' },
      mk('div', { class: 'n' }, n), mk('div', { class: 'k' }, k));
    root.appendChild(mk('div', { class: 'sv-u-stats' },
      stat(fmtTok(t.input), 'input'),
      stat(fmtTok(t.cachedInput), 'cached input'),
      stat(fmtTok(t.output), 'output'),
      stat(fmtTok(t.reasoningOutput), 'reasoning'),
      stat(t.requests.toLocaleString(), 'requests')));

    const days = r.byDay.slice(-30);
    if (days.length > 1) {
      const metric = (d: ipc.CodexUsageBucket) => isApi ? d.cost : d.credits;
      const maxDay = Math.max(...days.map(metric), 0.0001);
      const bars = mk('div', { class: 'sv-u-bars' });
      for (const d of days) {
        bars.appendChild(mk('span', {
          class: 'sv-u-bar',
          style: `height:${Math.max(1, Math.round((metric(d) / maxDay) * 100))}%`,
          title: `${d.day} · ${amount(d)} · ${fmtTok(totalTok(d))} tokens`,
        }));
      }
      root.appendChild(zone('Daily', isApi ? 'Estimated API cost per day, most recent 30 days.' : 'Estimated credits per day, most recent 30 days.',
        bars,
        mk('div', { class: 'sv-u-axis' }, mk('span', null, days[0].day), mk('span', null, days[days.length - 1].day))));
    }

    if (r.byModel.length) {
      const maxM = Math.max(...r.byModel.map(totalTok), 1);
      const rows = mk('div', { class: 'sv-u-rows' });
      for (const m of r.byModel) rows.appendChild(codexUsageRow(m.model, m.model, totalTok(m), amount(m), maxM));
      root.appendChild(zone('By model', 'Tokens and estimated usage per model.', rows));
    }

    if (r.byProject.length) {
      const maxP = Math.max(...r.byProject.map(totalTok), 1);
      const rows = mk('div', { class: 'sv-u-rows' });
      for (const p of r.byProject) rows.appendChild(codexUsageRow(codexProjLabel(p.project), p.project, totalTok(p), amount(p), maxP));
      const hint = r.truncatedProjects > 0
        ? `Top 12 by estimated usage — ${r.truncatedProjects} more not shown. Scanned ${t.scannedFiles.toLocaleString()} rollout files.`
        : `Tokens and estimated usage per project. Scanned ${t.scannedFiles.toLocaleString()} rollout files.`;
      root.appendChild(zone('By project', hint, rows));
    }
    return root;
  }

  function paneUsage(): HTMLElement {
    loadUsage();
    const rescan = mk('span', { class: 'sv-link', onclick: () => loadUsage(true) }, '↻ Rescan');
    const head = mk('div', { style: 'display:flex;align-items:baseline;justify-content:space-between;gap:12px' },
      mk('h1', { class: 'sv-title', style: 'margin:0' }, 'Usage'), rescan);
    const providerPicker = mk('div', { class: 'sv-u-saverow', style: 'margin-top:16px' }, segment(
      [{ value: 'claude', label: 'Claude' }, { value: 'codex', label: 'Codex' }],
      usageProvider,
      (value) => { usageProvider = value as 'claude' | 'codex'; rerender(); },
    ));

    if (usageProvider === 'codex') return paneCodexUsage(head, providerPicker);

    if (!usageReport) {
      return mk('div', { class: 'sv-pane' }, head, providerPicker,
        mk('p', { class: 'sv-subtitle' }, 'Claude Code writes a usage log for every session. Spike reads it locally — nothing is sent anywhere.'),
        mk('div', { class: 'sv-u-loading' }, usageLoading ? 'Scanning transcripts…' : 'No usage data found.'));
    }

    const r = usageReport;
    const t = r.totals;
    const totalTok = (b: { input: number; output: number; cacheCreate: number; cacheRead: number }) =>
      b.input + b.output + b.cacheCreate + b.cacheRead;

    // how the user is signed in — flips cost between actual (API key) and
    // notional (flat-rate subscription). Detected from ~/.claude.json.
    const isApi = usageAccount?.authType === 'api';

    const root = mk('div', { class: 'sv-pane' }, head, providerPicker);
    root.appendChild(mk('p', { class: 'sv-subtitle', style: 'margin-bottom:14px' },
      `Token consumption across ${t.sessions.toLocaleString()} sessions, read from Claude Code's local transcripts.`));

    // hero: cost headline. For an API-key login the number IS the bill; for a
    // subscription it's notional (what it would cost à la carte).
    root.appendChild(mk('div', { class: 'sv-u-hero' },
      mk('span', { class: 'v' }, fmtUsd(t.cost)),
      mk('span', { class: 'lbl' }, isApi ? 'API cost · all time' : 'notional cost · all time')));
    root.appendChild(mk('p', { class: 'sv-u-note' }, isApi
      ? 'You\'re signed in with an API key, so this is your actual spend at list price. Cache writes priced at 1.25×, reads at 0.1×.'
      : 'At API list price. On a subscription this is what the same usage would cost à la carte — a sense of weight, not a bill. Cache writes priced at 1.25×, reads at 0.1×.'));

    // stat cells: the four token classes + message count
    const stat = (n: string, k: string) => mk('div', { class: 'sv-u-stat' },
      mk('div', { class: 'n' }, n), mk('div', { class: 'k' }, k));
    root.appendChild(mk('div', { class: 'sv-u-stats' },
      stat(fmtTok(t.input), 'input'),
      stat(fmtTok(t.output), 'output'),
      stat(fmtTok(t.cacheRead), 'cache read'),
      stat(fmtTok(t.cacheCreate), 'cache write'),
      stat(t.messages.toLocaleString(), 'messages')));

    // ── subscription value — the savings question. The plan tier is detected
    // from ~/.claude.json (falls back to a manual pick); we compare notional
    // usage against the flat plan price, monthly and lifetime. Skipped entirely
    // for API-key logins, where there's no subscription to value against.
    const ucfg = (deps.getConfig() || {}).usage || {};
    const detectedUsd = usageAccount?.planUsd ?? null;
    const planName = usageAccount?.plan === 'max_20x' ? 'Claude Max 20×'
      : usageAccount?.plan === 'max_5x' ? 'Claude Max 5×'
      : usageAccount?.plan === 'pro' ? 'Claude Pro' : null;
    // detected plan wins as the default; an explicit pick (config) overrides it
    const planUsd = typeof ucfg.planUsd === 'number' ? ucfg.planUsd : (detectedUsd ?? 100);
    const ym = new Date().toISOString().slice(0, 7);   // current YYYY-MM (UTC)
    const monthName = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
      'August', 'September', 'October', 'November', 'December'][parseInt(ym.slice(5), 10) - 1] || 'this month';
    const validDays = r.byDay.filter(d => /^\d{4}-\d{2}/.test(d.day));
    const monthNotional = validDays.filter(d => d.day.startsWith(ym)).reduce((n, d) => n + d.cost, 0);
    // months you were active = months you paid the flat plan (a proxy — we
    // can't see your billing history, only when you used Claude Code).
    const activeMonths = new Set(validDays.map(d => d.day.slice(0, 7))).size;

    const saveOut = mk('div', { class: 'sv-u-save' });
    // one labeled block: scope tag · big value + caption · detail line
    const block = (scope: string, val: string, valLabel: string, sub: string) =>
      mk('div', { class: 'block' },
        mk('div', { class: 'scope' }, scope),
        mk('div', null, mk('span', { class: 'v' }, val), mk('span', { class: 't' }, ' ' + valLabel)),
        mk('div', { class: 'sub2' }, sub));
    const paintSavings = (plan: number) => {
      saveOut.innerHTML = '';
      if (plan <= 0) return;
      // this month
      if (monthNotional >= plan) {
        saveOut.appendChild(block(monthName, fmtUsd(monthNotional - plan), 'saved this month',
          `${fmtUsd(monthNotional)} of usage at API list price · you paid ${fmtUsd(plan)} · ${(monthNotional / plan).toFixed(1)}× the plan's value`));
      } else {
        saveOut.appendChild(block(monthName, `${Math.round((monthNotional / plan) * 100)}%`, 'of your plan used',
          `${fmtUsd(monthNotional)} of notional usage against the ${fmtUsd(plan)} you paid this month`));
      }
      // all time — the flat-rate story: you pay the plan each active month
      if (activeMonths > 0) {
        const paid = activeMonths * plan;
        const moStr = `${activeMonths} month${activeMonths > 1 ? 's' : ''}`;
        if (t.cost >= paid) {
          saveOut.appendChild(block(`all time · ${moStr}`, fmtUsd(t.cost - paid), 'saved overall',
            `${fmtUsd(t.cost)} of usage vs ${fmtUsd(paid)} paid (${moStr} × ${fmtUsd(plan)}) · ${(t.cost / paid).toFixed(1)}× return on the subscription`));
        } else {
          saveOut.appendChild(block(`all time · ${moStr}`, `${Math.round((t.cost / paid) * 100)}%`, 'of what you paid',
            `${fmtUsd(t.cost)} of notional usage vs ${fmtUsd(paid)} paid (${moStr} × ${fmtUsd(plan)})`));
        }
      }
    };
    paintSavings(planUsd);
    const planSeg = segment(
      [
        { value: '20', label: 'Pro · $20' },
        { value: '100', label: 'Max 5× · $100' },
        { value: '200', label: 'Max 20× · $200' },
      ],
      String(planUsd),
      (v) => {
        const n = parseInt(v, 10) || 0;
        deps.patchConfig({ usage: { ...((deps.getConfig() || {}).usage || {}), planUsd: n } });
        paintSavings(n);
      });
    const detectedNote = planName
      ? mk('div', { class: 'sv-u-detected' },
          `Detected from your Claude login: ${planName}${detectedUsd ? ` · $${detectedUsd}/mo` : ''}. Change it above if it's wrong.`)
      : null;
    if (!isApi) {
      root.appendChild(zone('Subscription value',
        planName
          ? 'Your plan is a flat monthly price; this is what the same usage would cost à la carte at API list price.'
          : 'Your plan is a flat monthly price; this is what the same usage would cost à la carte at API list price. Pick your plan.',
        mk('div', { class: 'sv-u-saverow' }, planSeg),
        detectedNote,
        saveOut));
    }

    // daily chart — last 30 days of activity, bars scaled to the busiest day
    const days = r.byDay.slice(-30);
    if (days.length > 1) {
      const maxDayCost = Math.max(...days.map(d => d.cost), 0.0001);
      const bars = mk('div', { class: 'sv-u-bars' });
      for (const d of days) {
        bars.appendChild(mk('span', {
          class: 'sv-u-bar',
          style: `height:${Math.max(1, Math.round((d.cost / maxDayCost) * 100))}%`,
          title: `${d.day} · ${fmtUsd(d.cost)} · ${fmtTok(totalTok(d))} tokens`,
        }));
      }
      const axis = mk('div', { class: 'sv-u-axis' },
        mk('span', null, days[0].day), mk('span', null, days[days.length - 1].day));
      root.appendChild(zone('Daily', 'Notional cost per day, most recent 30 days.', bars, axis));
    }

    // by model
    if (r.byModel.length) {
      const maxM = Math.max(...r.byModel.map(totalTok), 1);
      const rows = mk('div', { class: 'sv-u-rows' });
      for (const m of r.byModel) rows.appendChild(usageRow(m.model, m.model, totalTok(m), m.cost, maxM));
      root.appendChild(zone('By model', 'Tokens and notional cost per model.', rows));
    }

    // by project
    if (r.byProject.length) {
      const maxP = Math.max(...r.byProject.map(totalTok), 1);
      const rows = mk('div', { class: 'sv-u-rows' });
      for (const p of r.byProject) rows.appendChild(usageRow(projLabel(p.project), p.project, totalTok(p), p.cost, maxP));
      const hint = r.truncatedProjects > 0
        ? `Top 12 by cost — ${r.truncatedProjects} more not shown. Scanned ${t.scannedFiles.toLocaleString()} transcripts.`
        : `Tokens and notional cost per project. Scanned ${t.scannedFiles.toLocaleString()} transcripts.`;
      root.appendChild(zone('By project', hint, rows));
    }

    return root;
  }

  // Unified usage view: users should not have to switch providers to understand
  // their total agent usage. Dollar figures are API-list equivalents so Claude
  // and Codex can share one scale; subscription/credit billing is still framed
  // as an estimate, never an invoice.
  function paneAllUsage(): HTMLElement {
    loadUsage();
    const rescan = mk('span', { class: 'sv-link', onclick: () => loadUsage(true) }, '↻ Rescan');
    const head = mk('div', { style: 'display:flex;align-items:baseline;justify-content:space-between;gap:12px' },
      mk('h1', { class: 'sv-title', style: 'margin:0' }, 'Usage'), rescan);

    if (!usageReport || !codexUsageReport) {
      return mk('div', { class: 'sv-pane' }, head,
        mk('p', { class: 'sv-subtitle' }, 'Spike reads Claude Code and Codex usage from local session logs — nothing is sent anywhere.'),
        mk('div', { class: 'sv-u-loading' }, usageLoading ? 'Scanning transcripts…' : 'No usage data found.'));
    }

    const claude = usageReport;
    const codex = codexUsageReport;
    const ct = claude.totals;
    const ot = codex.totals;
    const claudeTokens = (b: { input: number; output: number; cacheCreate: number; cacheRead: number }) =>
      b.input + b.output + b.cacheCreate + b.cacheRead;
    const codexTokens = (b: { input: number; output: number }) => b.input + b.output;
    const totalTokens = claudeTokens(ct) + codexTokens(ot);
    const totalSessions = ct.sessions + ot.sessions;
    const totalInteractions = ct.messages + ot.requests;
    const totalValue = ct.cost + ot.cost;
    const claudeTotalTokens = claudeTokens(ct);
    const codexTotalTokens = codexTokens(ot);
    const claudeHasUsage = claudeTotalTokens > 0;
    const codexHasUsage = codexTotalTokens > 0;
    const claudeInstalled = usageEngines?.claude.installed;
    const codexInstalled = usageEngines?.codex.installed;
    const codexIsApi = codexUsageAccount?.authType === 'api';
    const codexAmount = (b: { credits: number; cost: number }) =>
      codexIsApi ? fmtUsd(b.cost) : `${fmtCredits(b.credits)} cr`;

    const root = mk('div', { class: 'sv-pane' }, head);
    if (totalTokens === 0) {
      const neitherInstalled = claudeInstalled === false && codexInstalled === false;
      const installed = [claudeInstalled ? 'Claude Code' : '', codexInstalled ? 'Codex' : ''].filter(Boolean);
      root.appendChild(mk('p', { class: 'sv-subtitle', style: 'margin-bottom:14px' },
        neitherInstalled
          ? 'Claude Code and Codex are not installed on PATH, and no local usage logs were found.'
          : installed.length
            ? `No local usage recorded yet. ${installed.join(' and ')} ${installed.length > 1 ? 'are' : 'is'} ready on PATH.`
            : 'No local Claude Code or Codex usage has been recorded yet.'));
      root.appendChild(mk('div', { class: 'sv-u-hero' },
        mk('span', { class: 'v' }, '$0.00'),
        mk('span', { class: 'lbl' }, 'API-equivalent value · no usage recorded')));
      root.appendChild(mk('p', { class: 'sv-u-note' }, neitherInstalled
        ? 'Install either CLI to begin tracking local sessions here.'
        : 'Usage will appear after a local agent session writes its first token record. Nothing is missing from the estimate yet.'));
      return root;
    }

    const providers = [claudeHasUsage ? 'Claude Code' : '', codexHasUsage ? 'Codex' : ''].filter(Boolean);
    root.appendChild(mk('p', { class: 'sv-subtitle', style: 'margin-bottom:14px' },
      `All-time local usage across ${providers.join(' and ')} · ${totalSessions.toLocaleString()} sessions.`));
    root.appendChild(mk('div', { class: 'sv-u-hero' },
      mk('span', { class: 'v' }, fmtUsd(totalValue)),
      mk('span', { class: 'lbl' }, totalValue > 0 ? 'API-equivalent value · all time' : 'API-equivalent value · no priced usage')));
    const availability: string[] = [];
    if (!claudeHasUsage) availability.push(claudeInstalled === false
      ? 'Claude Code is not installed on PATH, so it is omitted.'
      : 'Claude Code has no local usage yet, so it is omitted.');
    else if (claudeInstalled === false) availability.push('Claude Code is not currently on PATH; its historical local logs are still included.');
    if (!codexHasUsage) availability.push(codexInstalled === false
      ? 'Codex is not installed on PATH, so it is omitted.'
      : 'Codex has no local usage yet, so it is omitted.');
    else if (codexInstalled === false) availability.push('Codex is not currently on PATH; its historical local logs are still included.');
    root.appendChild(mk('p', { class: 'sv-u-note' },
      'One comparable scale across providers, calculated from local tokens at list rates. Subscription allowances and included Codex usage mean this is a sense of weight—not necessarily money billed.' +
      (codex.unpricedModels.length ? ` Codex tokens for ${codex.unpricedModels.join(', ')} are shown but omitted from the value estimate.` : '') +
      (availability.length ? ` ${availability.join(' ')}` : '')));

    const stat = (n: string, k: string) => mk('div', { class: 'sv-u-stat' },
      mk('div', { class: 'n' }, n), mk('div', { class: 'k' }, k));
    const stats = [
      stat(fmtTok(totalTokens), 'total tokens'),
      stat(totalSessions.toLocaleString(), 'sessions'),
      stat(totalInteractions.toLocaleString(), 'interactions'),
    ];
    if (claudeHasUsage) stats.push(stat(fmtUsd(ct.cost), 'Claude value'));
    if (codexHasUsage) stats.push(stat(fmtUsd(ot.cost), 'Codex value'));
    root.appendChild(mk('div', { class: 'sv-u-stats' }, ...stats));

    // Provider split — the primary comparison, always visible without tabs.
    const providerMax = Math.max(claudeTotalTokens, codexTotalTokens, 1);
    const providerRows = mk('div', { class: 'sv-u-rows' });
    if (claudeHasUsage) providerRows.appendChild(
      usageRow('Claude', 'Claude Code · API-list equivalent', claudeTotalTokens, ct.cost, providerMax));
    if (codexHasUsage) providerRows.appendChild(
      codexUsageRow('Codex', `Codex · ${fmtCredits(ot.credits)} estimated credits`, codexTotalTokens, fmtUsd(ot.cost), providerMax));
    root.appendChild(zone('By provider',
      [claudeHasUsage ? `Claude ${fmtUsd(ct.cost)}` : '',
        codexHasUsage ? `Codex ${fmtUsd(ot.cost)} API-equivalent (${fmtCredits(ot.credits)} estimated credits)` : '']
        .filter(Boolean).join(' · '),
      providerRows));

    // Merge both providers by UTC day for a real combined activity curve.
    const dayMap = new Map<string, { cost: number; tokens: number; claude: number; codex: number }>();
    const addDay = (day: string, cost: number, tokens: number, provider: 'claude' | 'codex') => {
      const value = dayMap.get(day) || { cost: 0, tokens: 0, claude: 0, codex: 0 };
      value.cost += cost;
      value.tokens += tokens;
      value[provider] += cost;
      dayMap.set(day, value);
    };
    for (const d of claude.byDay) addDay(d.day, d.cost, claudeTokens(d), 'claude');
    for (const d of codex.byDay) addDay(d.day, d.cost, codexTokens(d), 'codex');
    const days = Array.from(dayMap.entries())
      .filter(([day]) => /^\d{4}-\d{2}-\d{2}$/.test(day))
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-30);
    if (days.length > 1) {
      const maxDay = Math.max(...days.map(([, d]) => d.cost), 0.0001);
      const bars = mk('div', { class: 'sv-u-bars' });
      for (const [day, d] of days) {
        bars.appendChild(mk('span', {
          class: 'sv-u-bar',
          style: `height:${Math.max(1, Math.round((d.cost / maxDay) * 100))}%`,
          title: `${day} · ${fmtUsd(d.cost)} total · Claude ${fmtUsd(d.claude)} · Codex ${fmtUsd(d.codex)} · ${fmtTok(d.tokens)} tokens`,
        }));
      }
      root.appendChild(zone('Daily', 'Combined API-equivalent value, most recent 30 active days.', bars,
        mk('div', { class: 'sv-u-axis' }, mk('span', null, days[0][0]), mk('span', null, days[days.length - 1][0]))));
    }

    if (claude.byModel.length) {
      const max = Math.max(...claude.byModel.map(claudeTokens), 1);
      const rows = mk('div', { class: 'sv-u-rows' });
      for (const m of claude.byModel) rows.appendChild(usageRow(m.model, m.model, claudeTokens(m), m.cost, max));
      root.appendChild(zone('Claude · by model', 'Tokens and API-list-equivalent value.', rows));
    }
    if (codex.byModel.length) {
      const max = Math.max(...codex.byModel.map(codexTokens), 1);
      const rows = mk('div', { class: 'sv-u-rows' });
      for (const m of codex.byModel) rows.appendChild(codexUsageRow(m.model, m.model, codexTokens(m), codexAmount(m), max));
      root.appendChild(zone('Codex · by model', codexIsApi ? 'Tokens and estimated API cost.' : 'Tokens and estimated credits.', rows));
    }

    if (claude.byProject.length) {
      const max = Math.max(...claude.byProject.map(claudeTokens), 1);
      const rows = mk('div', { class: 'sv-u-rows' });
      for (const p of claude.byProject) rows.appendChild(usageRow(projLabel(p.project), p.project, claudeTokens(p), p.cost, max));
      root.appendChild(zone('Claude · by project', `Top local projects · ${ct.scannedFiles.toLocaleString()} transcripts scanned.`, rows));
    }
    if (codex.byProject.length) {
      const max = Math.max(...codex.byProject.map(codexTokens), 1);
      const rows = mk('div', { class: 'sv-u-rows' });
      for (const p of codex.byProject) rows.appendChild(codexUsageRow(codexProjLabel(p.project), p.project, codexTokens(p), codexAmount(p), max));
      root.appendChild(zone('Codex · by project', `Top local projects · ${ot.scannedFiles.toLocaleString()} rollout files scanned.`, rows));
    }

    return root;
  }

  // ── per-workspace context editor ────────────────────────────────────────────
  // A first-class screen (its own pane) opened from a card's "Edit context →". The
  // editor's note binds to the user-owned tail of .spike/groups/<slug>.md —
  // the file stays directly editable; Spike never truncates below the marker.

  interface PinStat { path: string; exists: boolean; dir: boolean; bytes: number }
  // per-open caches keyed by group id (+ in-flight guards so async rerenders
  // don't refire the same read)
  const pinStatsCache = new Map<number, PinStat[]>();
  const noteCache = new Map<number, string>();
  const inflight = new Set<string>();

  function loadPinStats(g: WorkspaceGroup): void {
    const key = `pins:${g.id}`;
    if (inflight.has(key)) return;
    inflight.add(key);
    const pins = (g.pinnedPaths || []).map(p => (p || '').trim()).filter(Boolean);
    ipc.pathStats(g.cwd || null, pins).then((stats) => {
      pinStatsCache.set(g.id, stats as PinStat[]);
      inflight.delete(key);
      rerender();
    }).catch(() => { pinStatsCache.set(g.id, []); inflight.delete(key); });
  }

  function loadNote(g: WorkspaceGroup): void {
    const p = contextMdPath(g);
    const key = `note:${g.id}`;
    if (!p || inflight.has(key)) return;
    inflight.add(key);
    ipc.readFile(p).then((d) => {
      inflight.delete(key);
      const text = d.content || '';
      const idx = text.indexOf(GROUP_MD_MARKER);
      // marker-less file → the WHOLE body is the user's (same demotion rule
      // as groupmd.spliceAboveMarker), so a save can never clobber it.
      const tail = idx === -1 ? text : text.slice(idx + GROUP_MD_MARKER.length).replace(/^\n+/, '');
      noteCache.set(g.id, tail.replace(/^\n+|\n+$/g, ''));
      rerender();
    }).catch(() => { noteCache.set(g.id, ''); inflight.delete(key); rerender(); });
  }

  // Write the note as the .md tail, preserving the Spike-owned head verbatim
  // (the direct-edit contract: never truncate the other party's half).
  // Read-modify-write against the live file so a concurrent hand edit of the
  // head can't be clobbered; a missing file gets a freshly assembled head.
  function saveNote(g: WorkspaceGroup, note: string): void {
    const p = contextMdPath(g);
    if (!p) return;
    ipc.readFile(p).catch(() => ({ content: '' }))
      .then((d) => {
        const text = (d && d.content) || '';
        const idx = text.indexOf(GROUP_MD_MARKER);
        const head = idx === -1
          ? assembleGroupMd(g).trimEnd() + '\n\n' + GROUP_MD_MARKER   // no file / no marker yet
          : text.slice(0, idx + GROUP_MD_MARKER.length);
        const tail = note.trim() ? '\n\n' + note.replace(/\n+$/, '') + '\n' : '\n';
        noteCache.set(g.id, note.replace(/\n+$/, ''));
        return ipc.saveFile(p, head + tail);
      }).catch(() => {});
  }

  // pin display: relative to the workspace cwd when inside it (matches how
  // the spec's data model stores them); absolute otherwise.
  function displayPin(g: WorkspaceGroup, p: string): string {
    const cwd = (g.cwd || '').trim().replace(/\/+$/, '');
    if (cwd && p.startsWith(cwd + '/')) return p.slice(cwd.length + 1);
    return p;
  }

  // ── workspace page ──────────────────────────────────────────────────────────
  // ONE page per workspace — everything about a place in a single scroll:
  // folder, what the agent receives, isolation. Replaces the old card grid +
  // buried "context editor" two-step; the rail is the only navigation.
  function paneWorkspace(g: WorkspaceGroup): HTMLElement {
    const root = mk('div', { class: 'sv-pane sv-wsroot sv-wide' });
    root.dataset.gid = String(g.id);

    // kick off the page's async loads (each guards its own re-entry; the
    // arrivals rerender into the caches read below)
    if (!pinStatsCache.has(g.id)) loadPinStats(g);
    if (!noteCache.has(g.id)) loadNote(g);

    // ── header: dot · name · count · Open ↗ · ⋯ — identity up top, inline
    // editable exactly like the old card (pendingNameEdit lands here).
    const count = deps.membersOf(g.id).length;
    const dot = mk('span', {
      class: 'sv-dot' + (count ? '' : ' hollow'),
      style: `background:${g.color};color:${g.color}`,
      title: 'change color',
      onclick: (e: Event) => { e.stopPropagation(); openSwatchPop(g, root, dot); },
    });
    const name = mk('span', { class: 'sv-name', title: 'rename', onclick: () => beginNameEdit(g, name) }, g.name);
    const countEl = mk('span', { class: 'sv-count' }, count ? `${count} tab${count > 1 ? 's' : ''}` : 'no tabs');
    const more = mk('button', { class: 'sv-more', title: 'workspace actions', 'aria-label': 'Workspace actions',
      html: icon('dots', 15),
      onclick: (e: Event) => { e.stopPropagation(); openCardMenu(g, root, more); } });
    const openBtn = mk('span', { class: 'sv-btn', title: 'back to the app, focused on this workspace',
      onclick: () => { close(); deps.openWorkspace(g); } }, 'Open ↗');
    root.appendChild(mk('div', { class: 'sv-wshead' }, dot, name, countEl,
      mk('span', { class: 'sv-wshead-r' }, openBtn, more)));

    // ── folder — the workspace's anchor. Only the gaps speak (no badge when
    // it's a healthy git repo): same "configured reads clean" rule as fields.
    const isGit = gitRepoKnown(g);
    const cwdIn = mk('input', { type: 'text', class: 'sv-mono', 'data-svkey': 'cwd', value: g.cwd || '',
      placeholder: '/absolute/path', spellcheck: 'false' }) as HTMLInputElement;
    cwdIn.addEventListener('change', () => {
      g.cwd = cwdIn.value.trim();
      deps.persistGroup(g);
      gitRepoCache.delete(g.cwd);     // re-detect for the isolation segment
      pinStatsCache.delete(g.id);     // relative pins resolve against the new cwd
      loadPinStats(g);
    });
    const folderBelow: Array<Node | null> = [
      mk('div', { class: 'sv-monofield' }, withGlyph(cwdIn, 'folder', true),
        mk('span', { class: 'sv-iconbtn', title: 'pick folder', html: icon('folder', 14),
          onclick: async () => {
            const p = await pickFolderPath();
            if (p) { cwdIn.value = p; g.cwd = p; deps.persistGroup(g); gitRepoCache.delete(p); loadPinStats(g); rerender(); }
          } })),
    ];
    if (isGit === false) folderBelow.push(mk('div', { class: 'sv-empty' },
      (g.cwd || '').trim()
        ? 'Not a git repository — Auto-worktree unavailable.'
        : 'No folder yet — tabs here spawn in the default working directory.'));

    // ── description — one line; the launcher shows it and the agent gets it
    // (it rides the .md head, src/groupmd.ts).
    const descBadge = badge('empty', !(g.description || '').trim());
    const descTa = mk('textarea', { class: 'sv-ta', rows: '2', spellcheck: 'false', 'data-svkey': 'desc',
      placeholder: 'e.g. Sonar frontend — Next.js app' }) as HTMLTextAreaElement;
    descTa.value = g.description || '';
    descTa.addEventListener('change', () => { g.description = descTa.value; deps.persistGroup(g); });

    // ── pinned paths + instructions
    const pins = (g.pinnedPaths || []).map(p => (p || '').trim()).filter(Boolean);
    const rawStats = pinStatsCache.get(g.id);
    // only trust stats that line up with the current pin list (a just-edited
    // list shows "…" until the fresh stats land)
    const stats = rawStats && rawStats.length === pins.length ? rawStats : undefined;
    const pinList = mk('div', { class: 'sv-pins' });
    pins.forEach((p, i) => {
      const st = stats && stats[i];
      const missing = !!st && !st.exists;
      const isDir = st ? st.dir : /\/$/.test(p);
      const row = mk('div', { class: 'sv-pin' + (missing ? ' missing' : '') },
        mk('span', { class: 'sv-ic', html: icon(isDir ? 'folder' : 'file-text', 13) }),
        mk('span', { class: 'sv-pin-path', title: p }, displayPin(g, p)),
      );
      if (missing) row.appendChild(mk('span', { class: 'sv-pin-tag' }, 'missing'));
      else row.appendChild(mk('span', { class: 'sv-pin-cost', title: 'approximate token cost' },
        st ? tokenEstimate(st.bytes) : '…'));
      row.appendChild(mk('span', { class: 'sv-pin-x', title: 'remove pin', html: icon('x', 13),
        onclick: () => {
          const arr = (g.pinnedPaths || []).filter(x => (x || '').trim());
          arr.splice(i, 1);
          g.pinnedPaths = arr;
          deps.persistGroup(g);
          pinStatsCache.delete(g.id);
          loadPinStats(g);
          rerender();
        } }));
      pinList.appendChild(row);
    });
    const addPin = (p: string) => {
      const cwd = (g.cwd || '').trim().replace(/\/+$/, '');
      const stored = cwd && p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p;
      const arr = (g.pinnedPaths || []).filter(x => (x || '').trim());
      if (arr.includes(stored)) return;
      g.pinnedPaths = [...arr, stored];
      deps.persistGroup(g);
      pinStatsCache.delete(g.id);
      loadPinStats(g);
      rerender();
    };
    // Tauri's dialog picks files OR folders per call, so the add affordance is
    // two quiet links (the reference's single "Pin a file or folder" can't be
    // one native picker).
    const adds = mk('div', { class: 'sv-pin-adds' },
      mk('span', { class: 'sv-pin-add', onclick: async () => {
        try { const p = await ipc.pickFile(); if (p) addPin(p); } catch {}
      } }, mk('span', { class: 'sv-ic', html: icon('plus', 12) }), 'Pin a file'),
      mk('span', { class: 'sv-pin-add', onclick: async () => {
        const p = await pickFolderPath();
        if (p) addPin(p);
      } }, mk('span', { class: 'sv-ic', html: icon('folder', 12) }), 'Pin a folder'),
    );
    const pinBadge = badge('none', !pins.length);
    const pinKids: Array<Node | null> = [pins.length ? pinList : null];
    if (!pins.length) pinKids.push(mk('div', { class: 'sv-empty' },
      'No pinned paths yet — agents see only the open file and recent files.'));
    pinKids.push(adds);

    // instructions for agents (formerly "Context note") — still binds to the
    // user-owned tail of the group .md; that contract is unchanged.
    const note = noteCache.get(g.id);
    const noteBadge = badge('empty', note !== undefined && !(note || '').trim());
    const ta = mk('textarea', { class: 'sv-ta sv-mono', rows: '4', spellcheck: 'false', 'data-svkey': 'note',
      placeholder: note === undefined ? 'loading…' : "e.g. Use the existing component library. Don't add new dependencies without asking." }) as HTMLTextAreaElement;
    ta.value = note || '';
    ta.addEventListener('change', () => saveNote(g, ta.value));

    // instructions hint carries the .md contract (formerly the page subtitle):
    // the file stays directly editable; Spike never truncates below the marker.
    const mdPath = contextMdPath(g);
    const instrHint = mk('div', { class: 'sv-fld-hint' }, "Added to every agent's prompt here. Backed by ");
    instrHint.appendChild(mk('code', null, mdPath ? mdPath.replace(homeDir || '', '~') : '.spike/groups/…'));
    instrHint.appendChild(document.createTextNode(' — '));
    instrHint.appendChild(mk('span', { class: 'sv-link', style: 'font-size:11px', onclick: () => {
      if (!mdPath) return;
      deps.persistGroup(g);                       // make sure the .md exists
      close();                                    // the page lives behind settings
      deps.openFile(mdPath, mdPath.split('/').pop() || mdPath);
    } }, 'edit in the file directly'));
    instrHint.appendChild(document.createTextNode('.'));

    // ── instructions: the FROM DEFAULTS inherited block sits above the editable
    // note, so the stacking (global prompt → this workspace) is visible at the
    // point of editing. Read-only here; it's one source, edited in Defaults.
    const globalPrompt = String((deps.getConfig() || {}).spawnPromptAppend || '').trim();
    const instrBelow: Array<Node | null> = [];
    if (globalPrompt) instrBelow.push(mk('div', { class: 'sv-inh' },
      mk('span', { class: 'tag' }, 'From Defaults'), globalPrompt));
    instrBelow.push(instrHint, ta);

    // ── isolation control (segment + ? explainer + the on-close policy detail),
    // relocated into the field card as its own row.
    const isolation = g.isolation === 'auto-worktree' ? 'auto-worktree' : 'shared';
    const seg = segment(
      [
        { value: 'shared', label: 'Shared' },
        { value: 'auto-worktree', label: 'Auto-worktree', iconName: 'git-fork' },
      ],
      isolation,
      (v) => {
        g.isolation = v === 'auto-worktree' ? 'auto-worktree' : 'shared';
        deps.persistGroup(g);
        rerender();
      },
      isGit === false
        ? { disabled: true, title: (g.cwd || '').trim() ? 'Working directory is not a git repository' : 'Set a folder first' }
        : undefined,
    );
    const help = mk('span', { class: 'sv-iso-help', html: icon('help-circle', 12),
      onmouseenter: () => openIsoPop(root, help),
      onmouseleave: () => { if (!isoPop || !isoPop.dataset.pinned) closeIsoPop(); },
      onclick: (e: Event) => {
        e.stopPropagation();
        if (isoPop) { isoPop.dataset.pinned = '1'; return; }
        openIsoPop(root, help);
        if (isoPop) (isoPop as HTMLElement).dataset.pinned = '1';
      } });
    const isoBelow: Array<Node | null> = [
      mk('div', { style: 'display:flex; align-items:center; gap:9px' },
        seg, help,
        isGit === false
          ? mk('span', { class: 'sv-iso-reason' }, (g.cwd || '').trim() ? 'not a git repo' : 'no folder')
          : null),
    ];
    if (isolation === 'auto-worktree' && isGit !== false) {
      const wt = ((deps.getConfig() || {}).worktree) || {};
      const policy = wt.onClose === 'ask' ? 'asks on close'
        : wt.onClose === 'keep-branch' ? 'keeps the branch on close'
        : 'auto-merge on close';
      const det = mk('div', { class: 'sv-iso-detail' },
        `2nd+ agents get an isolated worktree + branch · ${policy} · `);
      det.appendChild(mk('span', { class: 'sv-link', style: 'font-size:10.5px',
        onclick: () => { currentPane = 'defaults'; rerender(); } }, 'change in Defaults'));
      isoBelow.push(det);
    }

    // ── default view: this workspace's own override of the global setting.
    // Inherit (the default) shows what Defaults currently resolves to, so the
    // choice is legible without leaving the page. Pick Terminal/Chat to pin it.
    const inheritedView = ((deps.getConfig() || {}).spawnDefaults || {}).view === 'terminal' ? 'Terminal' : 'Chat';
    const viewSeg = segment(
      [
        { value: 'inherit', label: `Inherit (${inheritedView})` },
        { value: 'terminal', label: 'Terminal', iconName: 'terminal' },
        { value: 'chat', label: 'Chat', iconName: 'message' },
      ],
      g.view === 'terminal' || g.view === 'chat' ? g.view : 'inherit',
      (v) => {
        g.view = v === 'terminal' || v === 'chat' ? v : undefined;
        deps.persistGroup(g);
        rerender();
      },
    );

    // ── voice: learned DO/DON'T directives, distilled from how the user edits
    // agent output. Viewable + prunable here; Spike owns this block in the .md
    // head, so it rides every spawn. Learned via the proposal in the app.
    g.voice = g.voice || { do: [], dont: [] };
    const vdo = (g.voice.do || []).map(s => (s || '').trim()).filter(Boolean);
    const vdont = (g.voice.dont || []).map(s => (s || '').trim()).filter(Boolean);
    const removeVoice = (kind: 'do' | 'dont', text: string) => {
      const arr = ((g.voice && g.voice[kind]) || []).filter(x => (x || '').trim());
      g.voice![kind] = arr.filter(x => x !== text);
      deps.persistGroup(g);
      rerender();
    };
    const voiceList = mk('div', { class: 'sv-pins' });
    const voiceRow = (kind: 'do' | 'dont', text: string) => {
      const tag = mk('span', {
        style: `flex:0 0 auto;font-size:9px;font-weight:700;letter-spacing:.05em;`
          + `padding:2px 6px;border-radius:5px;`
          + `color:${kind === 'do' ? 'var(--sage-deep)' : 'var(--rose-deep)'};`
          + `background:color-mix(in srgb, ${kind === 'do' ? 'var(--sage)' : 'var(--rose)'} 20%, transparent)`,
      }, kind === 'do' ? 'DO' : "DON'T");
      const row = mk('div', { class: 'sv-pin' }, tag,
        mk('span', { class: 'sv-pin-path', title: text }, text));
      row.appendChild(mk('span', { class: 'sv-pin-x', title: 'remove', html: icon('x', 13),
        onclick: () => removeVoice(kind, text) }));
      voiceList.appendChild(row);
    };
    vdo.forEach(t => voiceRow('do', t));
    vdont.forEach(t => voiceRow('dont', t));
    const voiceBadge = badge('empty', !(vdo.length || vdont.length));
    const voiceKids: Array<Node | null> = [];
    if (vdo.length || vdont.length) voiceKids.push(voiceList);
    else voiceKids.push(mk('div', { class: 'sv-empty' },
      'No voice learned yet — edit an agent’s markdown and Spike proposes DO/DON’T directives from your changes.'));
    voiceKids.push(mk('div', { class: 'sv-fld-hint' },
      'Learned from your edits. Every agent here writes to it.'));

    // ── left column: one field card, everything this workspace layers on
    const card = fieldCard(
      fcRow('folder', 'Folder', { below: folderBelow }),
      fcRow('message', 'Description', { badge: descBadge, below: [descTa] }),
      fcRow('list-tree', 'Instructions', { badge: noteBadge, below: instrBelow }),
      fcRow('pin', 'Pinned paths', { badge: pinBadge, below: pinKids }),
      fcRow('quote', 'Voice', { badge: voiceBadge, below: voiceKids }),
      fcRow('git-branch', 'Isolation', { below: isoBelow }),
      // Terminal vs Chat, in an edition with no chat: the row would offer a
      // choice with one outcome. spawnDefaults.view stays in the config file for
      // the full edition to own; the shell just doesn't render the control.
      ...(CHAT_ENABLED ? [fcRow('message', 'Default view', { rnote: 'agent tabs only', below: [viewSeg] })] : []),
    );

    // ── right column: the assembled context, three states. Gold inherited lines
    // are read-only and route to Defaults; the same assembleContext() the
    // Defaults screen uses, so the two previews can never disagree.
    const cap = mk('div', { class: 'sv-cap' }, 'Gold lines come from Defaults and change everywhere at once. ');
    cap.appendChild(mk('span', { class: 'sv-link', onclick: () => { currentPane = 'defaults'; rerender(); } }, 'Edit them in Defaults'));
    cap.appendChild(document.createTextNode(', not here.'));
    const panel = assembledPanel({
      headLabel: 'WHAT THE AGENT SEES',
      showInherited: true,
      caption: cap,
      onEditInDefaults: () => { currentPane = 'defaults'; rerender(); },
    });
    // live model read from the current field values (+ config for the Defaults
    // layer); paths collapse $HOME to ~ for display.
    const readDefaults = () => {
      const c = deps.getConfig() || {};
      return {
        spawnPromptAppend: String(c.spawnPromptAppend || ''),
        cwd: displayPath((c.spawnDefaults || {}).cwd || '', 72),
        recentCount: (c.logging || {}).recentCount,
      };
    };
    const readWs = (): AssembleWorkspace => ({
      name: g.name,
      description: descTa.value,
      cwd: cwdIn.value.trim() ? displayPath(cwdIn.value.trim(), 72) : '',
      pins: pins.map(p => displayPin(g, p)),
      instructions: ta.value,
      voice: { do: vdo, dont: vdont },
    });
    const refresh = () => panel.update(assembleContext(readDefaults(), readWs()));
    const refreshD = debounce(refresh);
    descTa.addEventListener('input', () => { descBadge.style.display = descTa.value.trim() ? 'none' : ''; refreshD(); });
    cwdIn.addEventListener('input', refreshD);
    ta.addEventListener('input', () => { noteBadge.style.display = ta.value.trim() ? 'none' : ''; refreshD(); });
    refresh();

    // Permissions only make sense once the workspace has a directory — the rules
    // live in ITS .claude/settings.json. Until then the zone would have nowhere
    // to write, so it's omitted rather than shown broken.
    const wsCwd = (g.cwd || '').trim();
    root.appendChild(mk('div', { class: 'sv-split' },
      mk('div', null, mk('div', { class: 'sv-colhead' },
        mk('span', { class: 'lbl' }, 'THIS WORKSPACE'),
        mk('span', { class: 'r' }, 'layers on Defaults')), card,
        wsCwd ? permissionsZone(wsCwd, 'workspace') : null),
      panel.el));

    return root;
  }

  // ── rail + view assembly ────────────────────────────────────────────────────

  // ── connectors (MCP) pane ────────────────────────────────────────────────────
  // A GUI for what otherwise requires typing `claude mcp add …` in the terminal
  // and running `/mcp` to authenticate: browse a curated catalog of remote MCP
  // connectors, add one, and run its OAuth sign-in — all without the CLI. New
  // connectors default to USER scope (`claude mcp add --scope user`), so they're
  // available in every workspace. Power users can paste any MCP server URL.

  interface CatalogEntry { name: string; label: string; url: string; transport: 'http' | 'sse'; logo: string; color: string; blurb: string; popular?: boolean }
  // Best-effort endpoints for popular remote MCP servers. URLs can drift over
  // time; the "Add a custom connector" form is the escape hatch when one is
  // wrong, missing, or points at a company's own server. `logo` is a brand
  // mark (see connector-logos.ts); `color` tints it — a brand hue for vivid
  // marks, `var(--ink)` for near-monochrome ones so they read in both themes.
  const MCP_CATALOG: CatalogEntry[] = [
    { name: 'gmail', label: 'Gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1', transport: 'http', logo: CONNECTOR_LOGOS.gmail, color: '#EA4335', blurb: 'Read, search, and draft email in Gmail.', popular: true },
    { name: 'googlecalendar', label: 'Google Calendar', url: 'https://calendarmcp.googleapis.com/mcp/v1', transport: 'http', logo: CONNECTOR_LOGOS.googlecalendar, color: '#4285F4', blurb: 'View and manage events on your calendar.', popular: true },
    { name: 'googledrive', label: 'Google Drive', url: 'https://drivemcp.googleapis.com/mcp/v1', transport: 'http', logo: CONNECTOR_LOGOS.googledrive, color: '#1FA463', blurb: 'Search and read files in Google Drive.' },
    { name: 'notion', label: 'Notion', url: 'https://mcp.notion.com/mcp', transport: 'http', logo: CONNECTOR_LOGOS.notion, color: 'var(--ink)', blurb: 'Search and edit your Notion pages and databases.', popular: true },
    { name: 'linear', label: 'Linear', url: 'https://mcp.linear.app/mcp', transport: 'http', logo: CONNECTOR_LOGOS.linear, color: '#5E6AD2', blurb: 'Read and update Linear issues, projects, and cycles.', popular: true },
    { name: 'slack', label: 'Slack', url: 'https://mcp.slack.com/mcp', transport: 'http', logo: CONNECTOR_LOGOS.slack, color: 'var(--ink)', blurb: 'Read and post to channels (workspace admin must approve).', popular: true },
    { name: 'sentry', label: 'Sentry', url: 'https://mcp.sentry.dev/mcp', transport: 'http', logo: CONNECTOR_LOGOS.sentry, color: 'var(--ink)', blurb: 'Inspect errors, issues, and releases from Sentry.' },
    { name: 'asana', label: 'Asana', url: 'https://mcp.asana.com/v2/mcp', transport: 'http', logo: CONNECTOR_LOGOS.asana, color: '#F06A6A', blurb: 'Manage Asana tasks and projects.' },
    { name: 'atlassian', label: 'Jira & Confluence', url: 'https://mcp.atlassian.com/v1/mcp', transport: 'http', logo: CONNECTOR_LOGOS.atlassian, color: '#2684FF', blurb: 'Atlassian Jira issues and Confluence pages.' },
    { name: 'github', label: 'GitHub', url: 'https://api.githubcopilot.com/mcp/', transport: 'http', logo: CONNECTOR_LOGOS.github, color: 'var(--ink)', blurb: 'Repos, issues, and pull requests on GitHub.', popular: true },
    { name: 'stripe', label: 'Stripe', url: 'https://mcp.stripe.com', transport: 'http', logo: CONNECTOR_LOGOS.stripe, color: '#635BFF', blurb: 'Query Stripe customers, payments, and invoices.' },
    { name: 'paypal', label: 'PayPal', url: 'https://mcp.paypal.com/mcp', transport: 'http', logo: CONNECTOR_LOGOS.paypal, color: '#0070E0', blurb: 'Payments, invoices, and transactions on PayPal.' },
    { name: 'square', label: 'Square', url: 'https://mcp.squareup.com/mcp', transport: 'http', logo: CONNECTOR_LOGOS.square, color: 'var(--ink)', blurb: 'Payments, catalog, and orders on Square.' },
    { name: 'intercom', label: 'Intercom', url: 'https://mcp.intercom.com/mcp', transport: 'http', logo: CONNECTOR_LOGOS.intercom, color: '#1F8DED', blurb: 'Conversations and contacts (US-hosted workspaces).' },
    { name: 'cloudflare', label: 'Cloudflare', url: 'https://mcp.cloudflare.com/mcp', transport: 'http', logo: CONNECTOR_LOGOS.cloudflare, color: '#F38020', blurb: 'Manage Cloudflare accounts, DNS, and observability.' },
    { name: 'vercel', label: 'Vercel', url: 'https://mcp.vercel.com', transport: 'http', logo: CONNECTOR_LOGOS.vercel, color: 'var(--ink)', blurb: 'Projects, deployments, and logs on Vercel.' },
    { name: 'huggingface', label: 'Hugging Face', url: 'https://huggingface.co/mcp', transport: 'http', logo: CONNECTOR_LOGOS.huggingface, color: '#F5A623', blurb: 'Search models, datasets, and Spaces.' },
  ];
  const catalogByName = new Map(MCP_CATALOG.map((c) => [c.name, c]));
  const hostOf = (u: string): string => { try { return new URL(u).host.toLowerCase(); } catch { return ''; } };
  // Match a configured server to a catalog entry — by exact name, then URL host,
  // then a name/url substring. This is how claude.ai-brokered servers (named
  // "claude.ai Google Drive", "plugin:vercel:vercel", …) pick up the right brand
  // logo AND a clean display name, and how we dedupe them out of the Add grid.
  function catalogMatch(name: string, url: string): CatalogEntry | undefined {
    const exact = catalogByName.get(name);
    if (exact) return exact;
    const host = hostOf(url);
    if (host) for (const c of MCP_CATALOG) if (hostOf(c.url) === host) return c;
    const hay = (name + ' ' + url).toLowerCase();
    for (const c of MCP_CATALOG) if (hay.includes(c.name)) return c;
    return undefined;
  }
  // Display name: prefer the catalog's clean label, else drop a "claude.ai " prefix.
  function connectorLabel(name: string, url: string): string {
    const m = catalogMatch(name, url);
    return m ? m.label : name.replace(/^claude\.ai\s+/i, '');
  }
  // Tasteful hues for the monogram fallback (logo-less connectors like Monarch /
  // todoist), picked deterministically by name so a service keeps its color.
  const MONO_HUES = ['#B85F4E', '#5E6AD2', '#5FA97B', '#C08A2D', '#8A5FB8', '#C05E8A', '#3E8E9E', '#7A8B3E'];
  function hashHue(s: string): string {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return MONO_HUES[h % MONO_HUES.length];
  }
  // A rounded logo tile: a brand mark, else a lettered monogram tinted by the
  // connector's name — never the anonymous fork glyph.
  function logoTile(logo: string, color: string, label?: string): HTMLElement {
    if (logo) {
      const tile = mk('div', { class: 'sv-conn-logo', style: `color:${color};--lc:${color}` });
      tile.innerHTML = logo;
      return tile;
    }
    const nm = (label || '?').trim();
    const c = color && color !== 'var(--ink-faint)' ? color : hashHue(nm.toLowerCase());
    const letter = (nm.match(/[a-z0-9]/i)?.[0] || '?').toUpperCase();
    return mk('div', { class: 'sv-conn-logo sv-conn-mono', style: `color:${c};--lc:${c}` }, letter);
  }

  const stripAnsi = (s: string): string =>
    s.replace(/\[[0-9;?]*[A-Za-z]/g, '').replace(/\][^]*/g, '').replace(/\r/g, '');

  function mcpStatusMeta(s: ipc.McpStatus): { label: string; cls: string } {
    switch (s) {
      case 'connected': return { label: 'Connected', cls: 'ok' };
      case 'needs_auth': return { label: 'Needs sign-in', cls: 'warn' };
      case 'pending': return { label: 'Pending approval', cls: 'warn' };
      case 'failed': return { label: 'Sign-in failed', cls: 'bad' };
      default: return { label: 'Added', cls: 'muted' };
    }
  }

  function installedEngines(): ipc.McpEngine[] {
    return (mcpEngines && mcpEngines.length) ? mcpEngines : ['claude'];
  }
  // Engines a "+"/Connect writes to: the user's chosen targets ∩ installed, else all installed.
  function currentTargets(): ipc.McpEngine[] {
    const inst = installedEngines();
    const t = (mcpAddTargets || inst).filter((e) => inst.includes(e));
    return t.length ? t : inst;
  }

  function loadMcp(force?: boolean): void {
    if (mcpLoading) return;
    if (mcpEngines != null && !force) return;
    mcpLoading = true;
    ipc.detectEngines().then((det) => {
      const engines: ipc.McpEngine[] = [];
      if (det && det.claude && det.claude.installed) engines.push('claude');
      if (det && det.codex && det.codex.installed) engines.push('codex');
      mcpEngines = engines.length ? engines : ['claude'];
      return Promise.all(mcpEngines.map((e) =>
        ipc.mcpList(e).then((r) => { mcpByEngine[e] = r.servers || []; })
          .catch((err) => { mcpByEngine[e] = []; mcpError = String(err); })));
    }).catch((err) => { mcpEngines = ['claude']; mcpError = String(err); })
      .then(() => { mcpLoading = false; if (viewEl && currentPane === 'connectors') rerender(); });
  }
  async function reloadEngine(e: ipc.McpEngine): Promise<void> {
    try { const r = await ipc.mcpList(e); mcpByEngine[e] = r.servers || []; } catch { /* keep prior */ }
  }

  // One row per logical connector, merged across engines and keyed by catalog
  // match / URL host, tracking each engine's own server name + status.
  interface UnifiedConn { key: string; label: string; url: string; perEngine: Partial<Record<ipc.McpEngine, { name: string; status: ipc.McpStatus }>> }
  function unifiedConnectors(): UnifiedConn[] {
    const map = new Map<string, UnifiedConn>();
    for (const e of installedEngines()) {
      for (const s of (mcpByEngine[e] || [])) {
        const m = catalogMatch(s.name, s.url);
        const key = m ? m.name : (hostOf(s.url) || s.name.toLowerCase());
        let u = map.get(key);
        if (!u) { u = { key, label: connectorLabel(s.name, s.url), url: s.url, perEngine: {} }; map.set(key, u); }
        u.perEngine[e] = { name: s.name, status: s.status };
      }
    }
    return [...map.values()];
  }

  // Add to the target engines, reload them, then queue a browser sign-in for
  // each engine that isn't already connected — "add + sign into both" in a click.
  async function addConnector(name: string, transport: 'http' | 'sse', url: string, engines?: ipc.McpEngine[]): Promise<void> {
    const targets = engines && engines.length ? engines : currentTargets();
    mcpBusy.add(name); mcpError = null; rerender();
    try {
      for (const e of targets) await ipc.mcpAdd(e, name, transport, url, 'user');
      await Promise.all(targets.map(reloadEngine));
      mcpBusy.delete(name);
      const queue = targets
        .filter((e) => {
          const s = (mcpByEngine[e] || []).find((x) => x.name === name);
          return !s || s.status !== 'connected';
        })
        .map((e) => ({ engine: e, name, label: connectorLabel(name, url) }));
      enqueueSignIn(queue);
      return;
    } catch (e) { mcpError = String(e); mcpBusy.delete(name); }
    rerender();
  }

  // Add an already-configured connector to an engine it isn't in yet (the faint
  // "+ ChatGPT" chip). Reuses the catalog name/transport when known.
  function addMissingEngine(u: UnifiedConn, engine: ipc.McpEngine): void {
    const m = catalogMatch(u.label, u.url);
    const first = Object.values(u.perEngine)[0];
    const name = m ? m.name : (first ? first.name : u.key);
    const transport: 'http' | 'sse' = m ? m.transport : 'http';
    addConnector(name, transport, u.url, [engine]);
  }

  async function removeUnified(u: UnifiedConn): Promise<void> {
    mcpBusy.add(u.key); mcpError = null; rerender();
    try {
      for (const e of Object.keys(u.perEngine) as ipc.McpEngine[]) {
        await ipc.mcpRemove(e, u.perEngine[e]!.name, 'user');
        await reloadEngine(e);
      }
    } catch (e) { mcpError = String(e); }
    mcpBusy.delete(u.key); rerender();
  }

  // Sequential sign-in queue (one browser OAuth at a time, across engines).
  function enqueueSignIn(items: Array<{ engine: ipc.McpEngine; name: string; label: string }>): void {
    mcpLoginQueue.push(...items);
    if (!mcpLoginKey) processSignInQueue(); else rerender();
  }
  function processSignInQueue(): void {
    const next = mcpLoginQueue.shift();
    if (!next) { mcpLoginKey = null; rerender(); return; }
    startSignIn(next.engine, next.name, next.label);
  }
  function signInOne(engine: ipc.McpEngine, name: string, label: string): void {
    if (mcpLoginKey) return;
    enqueueSignIn([{ engine, name, label }]);
  }

  function startSignIn(engine: ipc.McpEngine, name: string, label?: string): void {
    mcpLoginKey = `${engine}:${name}`;
    mcpLoginLabel = `${label || name} · ${ENGINE_META[engine].label}`;
    mcpLoginLog = ''; mcpError = null; rerender();
    ipc.mcpLoginSpawn(engine, name, (chunk) => {
      mcpLoginLog += chunk;
      const pre = viewEl && viewEl.querySelector('#sv-conn-loginlog') as HTMLElement | null;
      if (pre) { pre.textContent = stripAnsi(mcpLoginLog); pre.scrollTop = pre.scrollHeight; }
    }).then((id) => {
      mcpLoginId = id;
      return ipc.onPtyExit(id, () => {
        if (mcpLoginUnlisten) { mcpLoginUnlisten(); mcpLoginUnlisten = null; }
        mcpLoginKey = null; mcpLoginId = null;
        reloadEngine(engine).then(() => {
          if (mcpLoginQueue.length) processSignInQueue(); else rerender();
        });
      });
    }).then((un) => { mcpLoginUnlisten = un; }).catch((e) => {
      mcpError = String(e); mcpLoginKey = null; mcpLoginId = null; mcpLoginQueue = []; rerender();
    });
  }

  function cancelSignIn(): void {
    mcpLoginQueue = [];
    if (mcpLoginId) ipc.ptyKill(mcpLoginId).catch(() => {});
    if (mcpLoginUnlisten) { mcpLoginUnlisten(); mcpLoginUnlisten = null; }
    mcpLoginKey = null; mcpLoginId = null; rerender();
  }

  function injectConnectorCss(): void {
    if (document.getElementById('sv-conn-css')) return;
    const s = document.createElement('style');
    s.id = 'sv-conn-css';
    s.textContent = `
      #settings .sv-conn-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:12px; }
      #settings .sv-conn-card { display:flex; flex-direction:column; gap:9px; padding:15px 16px; border:1px solid var(--edge-soft); border-radius:13px; background:var(--surface); transition:border-color .14s ease, transform .14s ease; }
      #settings .sv-conn-card:hover { border-color:var(--ink-ghost); }
      #settings .sv-conn-cardhead { display:flex; align-items:center; gap:11px; }
      #settings .sv-conn-logo { width:34px; height:34px; flex:0 0 34px; border-radius:9px; display:inline-flex; align-items:center; justify-content:center; color:var(--lc,var(--ink)); background:color-mix(in srgb, var(--lc,var(--ink)) 13%, transparent); }
      #settings .sv-conn-logo svg { width:19px; height:19px; display:block; }
      #settings .sv-conn-logo.sv-conn-mono { font-weight:700; font-size:15px; letter-spacing:-.02em; }
      #settings .sv-conn-name { font-weight:600; color:var(--ink); font-size:13.5px; }
      #settings .sv-conn-blurb { font-size:12px; line-height:1.45; color:var(--ink-ghost); flex:1; }
      #settings .sv-conn-foot { display:flex; align-items:center; justify-content:flex-start; gap:8px; margin-top:2px; }
      #settings .sv-conn-actions { display:flex; align-items:center; gap:10px; }
      #settings .sv-conn-status { display:inline-flex; align-items:center; font-size:11px; font-weight:600; letter-spacing:.01em; white-space:nowrap; }
      #settings .sv-conn-dot { width:6px; height:6px; border-radius:50%; background:currentColor; margin-right:6px; }
      #settings .sv-conn-status.ok { color:#5FA97B; }
      #settings .sv-conn-status.warn { color:var(--accent); }
      #settings .sv-conn-status.bad { color:#C7584A; }
      #settings .sv-conn-status.muted { color:var(--ink-faint); }
      #settings .sv-conn-rm { display:inline-flex; cursor:pointer; color:var(--ink-faint); opacity:.75; transition:color .12s, opacity .12s; }
      #settings .sv-conn-rm:hover { opacity:1; color:#C7584A; }
      #settings .sv-conn-chips { display:flex; align-items:center; gap:6px; }
      #settings .sv-conn-chip { display:inline-flex; align-items:center; gap:5px; font-size:10.5px; font-weight:600; padding:3px 9px 3px 6px; border-radius:20px; border:1px solid var(--edge); color:var(--ink-soft); background:transparent; white-space:nowrap; }
      #settings .sv-conn-chipimg { width:13px; height:13px; border-radius:3px; object-fit:contain; display:block; }
      #settings .sv-conn-chip.on { color:#5FA97B; border-color:color-mix(in srgb,#5FA97B 40%,transparent); }
      #settings .sv-conn-chip.warn { color:var(--accent); border-color:color-mix(in srgb,var(--accent) 45%,transparent); }
      #settings .sv-conn-chip.clickable { cursor:pointer; }
      #settings .sv-conn-chip.clickable:hover { border-color:var(--ink-ghost); }
      /* the "add to the other agent" chip rests quiet, brightens on row hover */
      #settings .sv-conn-chip.add { color:var(--ink-faint); border-style:dashed; cursor:pointer; opacity:.4; padding-left:5px; transition:opacity .14s, color .12s, border-color .12s; }
      #settings .sv-conn-chip.add .sv-conn-chipimg { filter:grayscale(1); opacity:.7; }
      #settings .sv-fc-row:hover .sv-conn-chip.add { opacity:1; }
      #settings .sv-conn-chip.add:hover { color:var(--ink); border-color:var(--ink-ghost); }
      #settings .sv-conn-chip.add:hover .sv-conn-chipimg { filter:none; opacity:1; }
      #settings .sv-conn-chip.add .sv-conn-plus { display:inline-flex; }
      #settings .sv-conn-targets { display:flex; align-items:center; gap:8px; margin-bottom:15px; }
      #settings .sv-conn-targetlbl { font-size:11px; color:var(--ink-faint); }
      #settings .sv-conn-target { display:inline-flex; align-items:center; gap:6px; font-size:11.5px; font-weight:600; padding:4px 12px 4px 8px; border-radius:8px; border:1px solid var(--edge); color:var(--ink-faint); cursor:pointer; user-select:none; transition:background .12s, color .12s, border-color .12s; }
      #settings .sv-conn-target .sv-conn-chipimg { width:14px; height:14px; }
      #settings .sv-conn-target.on { color:#fff; background:var(--accent); border-color:transparent; }
      #settings .sv-conn-target.on .sv-conn-chipimg { filter:brightness(0) invert(1); }
      #settings .sv-btn.primary { background:var(--accent); color:#fff; border-color:transparent; }
      #settings .sv-btn.primary:hover { background:color-mix(in srgb, var(--accent) 88%, #000); color:#fff; }
      #settings .sv-btn.disabled { opacity:.5; pointer-events:none; }
      #settings .sv-conn-searchwrap { display:flex; align-items:center; gap:9px; padding:0 13px; margin-bottom:18px; border:1px solid var(--edge); border-radius:10px; background:var(--surface); transition:border-color .14s ease; }
      #settings .sv-conn-searchwrap:focus-within { border-color:var(--ink-ghost); }
      #settings .sv-conn-searchic { flex:0 0 15px; width:15px; height:15px; color:var(--ink-faint); display:inline-flex; }
      #settings .sv-conn-searchic svg { width:15px; height:15px; }
      /* high specificity so the global #settings input chrome (border/bg/box-shadow) can't show a nested box */
      #settings .sv-conn-searchwrap input.sv-conn-search { flex:1; min-width:0; width:auto; margin:0; border:0 !important; outline:0 !important; background:transparent !important; box-shadow:none !important; border-radius:0; padding:10px 0; color:var(--ink); font-size:13px; }
      #settings .sv-conn-searchwrap input.sv-conn-search:focus { border:0 !important; outline:0 !important; box-shadow:none !important; }
      #settings .sv-conn-searchwrap input.sv-conn-search::placeholder { color:var(--ink-faint); }
      #settings .sv-conn-sec { margin-bottom:22px; }
      #settings .sv-conn-sec:last-child { margin-bottom:0; }
      #settings .sv-conn-seclabel { font-size:10px; font-weight:600; letter-spacing:.1em; text-transform:uppercase; color:var(--ink-faint); margin:0 0 11px; }
      #settings .sv-conn-rowgrid { display:grid; grid-template-columns:repeat(auto-fill,minmax(288px,1fr)); gap:10px; }
      #settings .sv-conn-row { display:flex; align-items:center; gap:12px; padding:11px 12px; border:1px solid var(--edge-soft); border-radius:11px; background:var(--surface); transition:border-color .14s ease; }
      #settings .sv-conn-row:hover { border-color:var(--ink-ghost); }
      #settings .sv-conn-rowmain { flex:1; min-width:0; display:flex; flex-direction:column; gap:1px; }
      #settings .sv-conn-rowblurb { font-size:11px; color:var(--ink-ghost); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      #settings .sv-conn-add { flex:0 0 auto; width:30px; height:30px; border-radius:8px; border:1px solid var(--edge); background:transparent; color:var(--ink-soft); display:inline-flex; align-items:center; justify-content:center; cursor:pointer; transition:background .14s ease, border-color .14s ease, color .14s ease; }
      #settings .sv-conn-add:hover { background:var(--accent); border-color:transparent; color:#fff; }
      #settings .sv-conn-add .sv-conn-plus { display:inline-flex; }
      #settings .sv-conn-add.busy { pointer-events:none; }
      #settings .sv-conn-login { border:1px solid color-mix(in srgb, var(--accent) 55%, var(--edge)); border-radius:12px; padding:14px 15px; margin-bottom:16px; background:var(--surface); }
      #settings .sv-conn-login-h { display:flex; align-items:center; gap:10px; color:var(--ink); font-weight:600; font-size:13px; margin-bottom:9px; }
      #settings .sv-conn-loginlog { max-height:170px; overflow:auto; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; line-height:1.45; color:var(--ink-faint); white-space:pre-wrap; word-break:break-word; background:var(--bg); border-radius:8px; padding:9px 10px; margin:0; }
      #settings .sv-conn-loginlog:empty { display:none; }
      #settings .sv-conn-login-actions { margin-top:11px; }
      #settings .sv-conn-spin { width:13px; height:13px; border:2px solid var(--ink-ghost); border-top-color:var(--accent); border-radius:50%; display:inline-block; flex:0 0 13px; animation:sv-conn-spin .7s linear infinite; }
      #settings .sv-conn-loadrow { display:flex; align-items:center; gap:10px; color:var(--ink-faint); font-size:12.5px; padding:2px 0; }
      @keyframes sv-conn-spin { to { transform:rotate(360deg); } }
      #settings .sv-conn-err { color:#C7584A; font-size:12.5px; padding:10px 12px; border:1px solid color-mix(in srgb, #C7584A 40%, transparent); border-radius:9px; margin-bottom:14px; white-space:pre-wrap; }
      #settings .sv-conn-listrow { display:flex; align-items:center; gap:12px; width:100%; }
      #settings .sv-conn-listmain { display:flex; flex-direction:column; gap:2px; flex:1; min-width:0; }
      #settings .sv-conn-listname { font-weight:600; color:var(--ink); font-size:12.5px; }
      #settings .sv-conn-listurl { font-size:11px; color:var(--ink-faint); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      #settings .sv-conn-form { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
      #settings .sv-conn-formname { flex:0 1 190px; }
      #settings .sv-conn-formurl { flex:1 1 260px; }
      /* pill fields matching the search bar (bordered container, borderless input) */
      #settings .sv-conn-form .sv-conn-formname, #settings .sv-conn-form .sv-conn-formurl { display:flex; align-items:center; padding:0 13px; border:1px solid var(--edge); border-radius:10px; background:var(--surface); transition:border-color .14s ease; }
      #settings .sv-conn-form .sv-conn-formname:focus-within, #settings .sv-conn-form .sv-conn-formurl:focus-within { border-color:var(--ink-ghost); }
      #settings .sv-conn-form input { width:100%; min-width:0; margin:0; border:0 !important; outline:0 !important; background:transparent !important; box-shadow:none !important; border-radius:0; padding:10px 0; color:var(--ink); font-size:13px; }
      #settings .sv-conn-form input::placeholder { color:var(--ink-faint); }
    `;
    document.head.appendChild(s);
  }

  // Discovery row (Claude-style) — a compact logo · name · "＋" tile, shown only
  // for catalog entries NOT yet configured. Adding one moves it up into "Your
  // connectors". Carries data-q for the live search filter.
  function renderConnectorRow(c: CatalogEntry): HTMLElement {
    const busy = mcpBusy.has(c.name);
    const row = mk('div', { class: 'sv-conn-row', 'data-q': (c.label + ' ' + c.name + ' ' + c.blurb).toLowerCase() },
      logoTile(c.logo, c.color, c.label),
      mk('div', { class: 'sv-conn-rowmain' },
        mk('div', { class: 'sv-conn-name' }, c.label),
        mk('div', { class: 'sv-conn-rowblurb' }, c.blurb)),
      mk('button', {
        class: 'sv-conn-add' + (busy ? ' busy' : ''), title: `Connect ${c.label}`,
        onclick: () => { if (!busy) addConnector(c.name, c.transport, c.url); },
      }, busy ? mk('span', { class: 'sv-conn-spin' }) : mk('span', { class: 'sv-conn-plus', html: icon('plus', 15) })));
    return row;
  }
  const MAGNIFIER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>';

  // A per-engine status pill in a connector row. Connected = green; needs-auth /
  // unknown = clickable to (re)start that engine's sign-in.
  function engineChip(u: UnifiedConn, engine: ipc.McpEngine): HTMLElement {
    const pe = u.perEngine[engine]!;
    const connected = pe.status === 'connected';
    const warn = pe.status === 'needs_auth' || pe.status === 'failed';
    const chip = mk('span', {
      class: 'sv-conn-chip' + (connected ? ' on' : warn ? ' warn' : '') + (connected ? '' : ' clickable'),
    },
      mk('img', { class: 'sv-conn-chipimg', src: ENGINE_META[engine].img, alt: '', draggable: 'false' }),
      ENGINE_META[engine].label);
    if (!connected) {
      chip.title = `Sign in to ${ENGINE_META[engine].label}`;
      chip.addEventListener('click', () => { if (!mcpLoginKey) signInOne(engine, pe.name, u.label); });
    }
    return chip;
  }

  function renderUnifiedRow(u: UnifiedConn): HTMLElement {
    const busy = mcpBusy.has(u.key);
    const brand = catalogMatch(u.label, u.url);
    const inst = installedEngines();
    const right = mk('div', { class: 'sv-conn-actions' });

    if (inst.length === 1) {
      // Single agent — a plain status pill + Sign in, like before.
      const pe = u.perEngine[inst[0]];
      const status = pe ? pe.status : 'unknown';
      const meta = mcpStatusMeta(status);
      if (pe && status !== 'connected') {
        right.appendChild(mk('span', {
          class: 'sv-btn primary' + (mcpLoginKey ? ' disabled' : ''),
          onclick: () => signInOne(inst[0], pe.name, u.label),
        }, status === 'failed' ? 'Retry sign-in' : 'Sign in'));
      }
      right.appendChild(mk('span', { class: 'sv-conn-status ' + meta.cls },
        mk('span', { class: 'sv-conn-dot' }), meta.label));
    } else {
      // Multiple agents — one chip per engine; a faint "+ <engine>" to add it there.
      const chips = mk('div', { class: 'sv-conn-chips' });
      for (const e of inst) {
        if (u.perEngine[e]) chips.appendChild(engineChip(u, e));
        else chips.appendChild(mk('span', {
          class: 'sv-conn-chip add',
          title: `Add to ${ENGINE_META[e].label}`,
          onclick: () => { if (!busy && !mcpLoginKey) addMissingEngine(u, e); },
        }, mk('span', { class: 'sv-conn-plus', html: icon('plus', 11) }),
          mk('img', { class: 'sv-conn-chipimg', src: ENGINE_META[e].img, alt: '', draggable: 'false' }),
          ENGINE_META[e].label));
      }
      right.appendChild(chips);
    }

    right.appendChild(mk('span', {
      class: 'sv-conn-rm', title: 'Remove from all agents', html: icon('trash', 14),
      onclick: () => { if (!busy) removeUnified(u); },
    }));
    return mk('div', { class: 'sv-fc-row' },
      mk('div', { class: 'sv-conn-listrow' },
        logoTile(brand ? brand.logo : '', brand ? brand.color : 'var(--ink-faint)', u.label),
        mk('div', { class: 'sv-conn-listmain' },
          mk('span', { class: 'sv-conn-listname' }, u.label),
          mk('span', { class: 'sv-conn-listurl' }, u.url)),
        right));
  }

  // "Add to Claude / ChatGPT" target toggles (only shown when both are installed).
  function renderTargets(): HTMLElement {
    const inst = installedEngines();
    const sel = currentTargets();
    const wrap = mk('div', { class: 'sv-conn-targets' }, mk('span', { class: 'sv-conn-targetlbl' }, 'Add to'));
    for (const e of inst) {
      const on = sel.includes(e);
      wrap.appendChild(mk('span', {
        class: 'sv-conn-target' + (on ? ' on' : ''),
        onclick: () => {
          const cur = new Set(currentTargets());
          if (cur.has(e)) cur.delete(e); else cur.add(e);
          if (cur.size === 0) cur.add(e);   // never empty
          mcpAddTargets = inst.filter((x) => cur.has(x));
          rerender();
        },
      }, mk('img', { class: 'sv-conn-chipimg', src: ENGINE_META[e].img, alt: '', draggable: 'false' }),
        ENGINE_META[e].label));
    }
    return wrap;
  }

  function renderCustomForm(): HTMLElement {
    const nameIn = mk('input', { type: 'text', placeholder: 'name — e.g. acme', spellcheck: 'false' }) as HTMLInputElement;
    const urlIn = mk('input', { type: 'text', placeholder: 'https://mcp.example.com/mcp', spellcheck: 'false' }) as HTMLInputElement;
    let transport: 'http' | 'sse' = 'http';
    const seg = segment(
      [{ value: 'http', label: 'HTTP' }, { value: 'sse', label: 'SSE' }],
      transport, (v) => { transport = v as 'http' | 'sse'; });
    const submit = () => {
      const name = nameIn.value.trim();
      const url = urlIn.value.trim();
      if (!name || !url) { mcpError = 'Enter both a name and a URL.'; rerender(); return; }
      nameIn.value = ''; urlIn.value = '';
      addConnector(name, transport, url);
    };
    urlIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    return mk('div', { class: 'sv-conn-form' },
      mk('div', { class: 'sv-conn-formname' }, nameIn),
      seg,
      mk('div', { class: 'sv-conn-formurl' }, urlIn),
      mk('span', { class: 'sv-btn primary', onclick: submit }, 'Add'));
  }

  function paneConnectors(): HTMLElement {
    injectConnectorCss();
    loadMcp();
    const children: Array<Node | null> = [];
    const loading = mcpEngines == null;
    const multi = installedEngines().length > 1;

    if (mcpLoginKey) {
      children.push(mk('div', { class: 'sv-conn-login' },
        mk('div', { class: 'sv-conn-login-h' },
          mk('span', { class: 'sv-conn-spin' }),
          mk('span', {}, `Signing in — ${mcpLoginLabel}. A browser window should open; approve access there, then return here.`
            + (mcpLoginQueue.length ? `  (${mcpLoginQueue.length} more queued)` : ''))),
        mk('pre', { id: 'sv-conn-loginlog', class: 'sv-conn-loginlog' }, stripAnsi(mcpLoginLog)),
        mk('div', { class: 'sv-conn-login-actions' },
          mk('span', { class: 'sv-btn', onclick: cancelSignIn }, 'Cancel'))));
    }

    if (mcpError) children.push(mk('div', { class: 'sv-conn-err' }, mcpError));

    // First load detects engines then lists each (claude's `mcp list` health-checks
    // over the network, ~2-3s). The page paints instantly: the discovery grid is
    // static, and "Your connectors" shows a loading row until the lists land
    // (then cached for the session, so re-opening is immediate).
    const unified = unifiedConnectors();
    if (loading) {
      children.push(zone('Your connectors', 'Checking which services are connected…',
        mk('div', { class: 'sv-fieldcard' },
          mk('div', { class: 'sv-fc-row' },
            mk('div', { class: 'sv-conn-loadrow' },
              mk('span', { class: 'sv-conn-spin' }),
              mk('span', {}, 'Checking your connectors…'))))));
    } else if (unified.length) {
      const list = mk('div', { class: 'sv-fieldcard' });
      for (const u of unified) list.appendChild(renderUnifiedRow(u));
      const where = multi ? ' across Claude & ChatGPT' : '';
      children.push(zone('Your connectors',
        `${unified.length} connected${where}. Sign in again or remove any below.`, list));
    }

    // Hide catalog entries already configured in ANY engine — matched by URL/name,
    // so a claude.ai-brokered "claude.ai Google Drive" dedupes our "Google Drive".
    const configuredKeys = new Set<string>();
    for (const e of installedEngines()) for (const s of (mcpByEngine[e] || [])) {
      const m = catalogMatch(s.name, s.url); if (m) configuredKeys.add(m.name);
    }
    const available = MCP_CATALOG.filter((c) => !configuredKeys.has(c.name));
    if (available.length) {
      const popular = available.filter((c) => c.popular);
      const rest = available.filter((c) => !c.popular);

      const search = mk('input', {
        class: 'sv-conn-search', type: 'text', placeholder: 'Search connectors…',
        spellcheck: 'false', value: mcpSearch,
      }) as HTMLInputElement;
      const searchWrap = mk('div', { class: 'sv-conn-searchwrap' },
        mk('span', { class: 'sv-conn-searchic', html: MAGNIFIER }), search);

      // Two labeled sections (Popular, All). Search filters rows in place —
      // NO rerender per keystroke, so the input keeps focus; a section hides
      // when all its rows are filtered out.
      const sections: HTMLElement[] = [];
      const mkSection = (label: string, entries: CatalogEntry[]): HTMLElement | null => {
        if (!entries.length) return null;
        const grid = mk('div', { class: 'sv-conn-rowgrid' });
        for (const c of entries) grid.appendChild(renderConnectorRow(c));
        const sec = mk('div', { class: 'sv-conn-sec' },
          mk('div', { class: 'sv-conn-seclabel' }, label), grid);
        sections.push(sec);
        return sec;
      };
      // A separate "Popular" tier only earns its label when it's substantial
      // AND there's a distinct rest; otherwise one grid (popular-first) reads
      // cleaner than a two-item Popular over a long All list.
      const splitTiers = popular.length >= 3 && rest.length > 0;
      const popSec = splitTiers ? mkSection('Popular', popular) : null;
      const allSec = splitTiers
        ? mkSection('All connectors', rest)
        : mkSection('Connectors', [...popular, ...rest]);

      const applyFilter = () => {
        mcpSearch = search.value;
        const q = search.value.trim().toLowerCase();
        for (const sec of sections) {
          let any = false;
          sec.querySelectorAll('.sv-conn-row').forEach((r) => {
            const hit = !q || ((r as HTMLElement).dataset.q || '').includes(q);
            (r as HTMLElement).style.display = hit ? '' : 'none';
            if (hit) any = true;
          });
          sec.style.display = any ? '' : 'none';
        }
      };
      search.addEventListener('input', applyFilter);

      const browse = mk('div', { class: 'sv-conn-browse' });
      if (multi) browse.appendChild(renderTargets());
      browse.appendChild(searchWrap);
      if (popSec) browse.appendChild(popSec);
      if (allSec) browse.appendChild(allSec);
      children.push(zone('Add a connector',
        multi ? 'Pick a service — it’s configured for the agents selected above.'
              : 'Connect a service so your agent can use it — added for every workspace.', browse));
      if (mcpSearch) queueMicrotask(applyFilter);   // restore filter after a rerender
    }

    children.push(zone('Add a custom connector',
      'Any remote MCP server — paste the URL your provider gave you.', renderCustomForm()));

    return pane('Connectors',
      'Connect apps like Notion, Linear, or your company’s tools so your agent can use them — no terminal needed.',
      ...children);
  }

  // App preferences only — the workspaces group renders its own rail entries.
  const PANES: Array<{ id: string; label: string; iconName: string; render: () => HTMLElement }> = [
    { id: 'connectors', label: 'Connectors', iconName: 'git-fork', render: paneConnectors },
    { id: 'files', label: 'Files', iconName: 'file', render: paneFiles },
    { id: 'usage', label: 'Usage', iconName: 'activity', render: paneAllUsage },
    { id: 'appearance', label: 'Appearance', iconName: 'palette', render: paneAppearance },
    { id: 'privacy', label: 'Privacy & logs', iconName: 'lock', render: panePrivacy },
  ];

  // The rail mirrors the user's mental model, not the implementation: places
  // you work (each workspace + the Defaults they inherit), then app prefs.
  // (The old inert "Local projects" list duplicated workspace folders — gone.)
  function buildRail(): HTMLElement {
    const rail = mk('nav', { class: 'sv-rail' });
    rail.appendChild(mk('div', { class: 'sv-back', onclick: close },
      mk('span', { class: 'sv-ic', html: icon('arrow-left', 14), style: 'display:inline-flex' }), 'Back to app'));
    const item = (active: boolean, onclick: () => void, ...kids: Array<Node | string>) =>
      rail.appendChild(mk('div', { class: 'sv-item' + (active ? ' active' : ''), onclick }, ...kids));

    rail.appendChild(mk('div', { class: 'sv-railsec', style: 'margin-top:0' }, 'Workspaces'));
    item(currentPane === 'defaults', () => { currentPane = 'defaults'; rerender(); },
      mk('span', { class: 'sv-ic', html: icon('settings', 15) }), 'Defaults');
    for (const g of deps.groups) {
      const active = currentPane === 'workspace:' + g.id;
      rail.appendChild(mk('div', {
        class: 'sv-item sv-ws' + (active ? ' active' : ''),
        style: `--wc:${g.color}`,
        onclick: () => { currentPane = 'workspace:' + g.id; rerender(); },
      },
        mk('span', { class: 'sv-dot-sm', style: `background:${g.color}` }),
        mk('span', { class: 'nm' }, g.name)));
    }
    // folder-first creation: the folder is what defines a workspace, so ask
    // for it up front; the name prefills from the basename. Cancelling the
    // picker still creates a folder-less workspace (they're legal — the page
    // shows the one next step).
    rail.appendChild(mk('div', { class: 'sv-item sv-add', onclick: async () => {
      const folder = await pickFolderPath();
      let init: Partial<WorkspaceGroup> | undefined;
      if (folder) {
        const base = folder.replace(/\/+$/, '').split('/').pop() || 'workspace';
        let nm = base;   // the slug IS the disk key — a collision would overwrite files
        for (let n = 2; deps.groups.some(x => x.name === nm); n++) nm = `${base} ${n}`;
        init = { name: nm, cwd: folder };
      }
      const g = deps.newWorkspace(init);
      deps.renderTabs();
      currentPane = 'workspace:' + g.id;
      pendingNameEdit = g.id;
      rerender();
    } }, mk('span', { class: 'sv-ic', html: icon('plus', 14) }), 'New workspace'));

    rail.appendChild(mk('div', { class: 'sv-railsec' }, 'App'));
    for (const p of PANES) {
      item(currentPane === p.id, () => { currentPane = p.id; rerender(); },
        mk('span', { class: 'sv-ic', html: icon(p.iconName, 15) }), p.label);
    }
    return rail;
  }

  // Blank canvas. The old settings-v2 surface (rail + Defaults/workspace/Usage/
  // Connectors panes) is being reimagined from scratch — every builder below
  // (buildRail, paneDefaults, PANES, …) is left intact but unwired, so we can
  // rebuild the new surface here without excavating dead code first. This paints
  // instantly (no loadMcp/loadConfig round-trip), which also kills the "buffer
  // then flash the old settings" the async render used to cause.
  function renderView(): void {
    if (!viewEl) return;
    closeSwatchPop();
    closeCardMenu();
    closeIsoPop();
    viewEl.innerHTML = '';
    viewEl.classList.add('sv-blank');

    const stage = mk('div', { class: 'sv-blank-stage' });
    const card = mk('div', { class: 'sv-blank-card' },
      mk('div', { class: 'sv-blank-title' }, 'Settings'),
      mk('div', { class: 'sv-blank-sub' }, 'A clean slate — the new settings surface is being reimagined here.'),
    );
    stage.appendChild(card);
    viewEl.appendChild(stage);
    contentEl = stage;
    railEl = null;
  }

  // re-render in place, preserving the scroll position (config edits, pin
  // add/remove, async stat arrivals…) AND any field mid-edit: async arrivals
  // (pin stats, the .md note) must never clobber typing.
  function rerender(): void {
    if (!viewEl) return;
    const scroll = contentEl ? contentEl.scrollTop : 0;
    const ae = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
    const editKey = ae && viewEl.contains(ae) && (ae as any).dataset && (ae as any).dataset.svkey
      ? { key: (ae as any).dataset.svkey as string, value: ae.value,
          selStart: ae.selectionStart, selEnd: ae.selectionEnd }
      : null;
    // a mid-flight RENAME is an editor that renderView doesn't recreate — ask
    // it to (pendingNameEdit), then the generic restore below carries the
    // draft. (Chrome fires no blur on DOM removal, so nothing has committed.)
    if (editKey && editKey.key === 'name' && ae && (ae as any).dataset.gid)
      pendingNameEdit = Number((ae as any).dataset.gid);
    renderView();
    if (contentEl) contentEl.scrollTop = scroll;
    if (editKey && viewEl) {
      const el = viewEl.querySelector(`[data-svkey="${editKey.key}"]`) as HTMLInputElement | HTMLTextAreaElement | null;
      if (el) {
        el.value = editKey.value;
        el.focus();
        try { el.setSelectionRange(editKey.selStart || 0, editKey.selEnd || 0); } catch {}
      }
    }
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    // the worktree close prompt (app.ts #wtask) sits above settings and owns
    // Escape while it's up — registration order would hand it to us first.
    if (document.getElementById('wtask')) return;
    // an open popover (⋯ menu, isolation explainer, swatches) absorbs the
    // first Escape; the next one steps back a level as usual.
    if (cardMenu || isoPop || swatchPop) {
      e.preventDefault();
      closeCardMenu(); closeIsoPop(); closeSwatchPop();
      return;
    }
    // First Escape inside a field exits the field (a changed value commits via
    // its change handler, same as clicking away); the next one steps back.
    const t = e.target as HTMLElement | null;
    if (viewEl && t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && viewEl.contains(t)) {
      if (t.classList.contains('sv-nameedit')) return;   // its own handler cancels the rename
      e.preventDefault();
      (t as HTMLInputElement).blur();
      return;
    }
    e.preventDefault();
    // workspace pages are siblings of every other pane now — no level to step
    // out of, so Escape closes the view directly.
    close();
  }

  function close(): void {
    closeSwatchPop();
    closeCardMenu();
    closeIsoPop();
    unmountBarClose();
    if (viewEl) { viewEl.remove(); viewEl = null; contentEl = null; railEl = null; }
    document.removeEventListener('keydown', onKey, true);
  }

  function open(paneId?: string): void {
    if (viewEl) {
      if (paneId) { currentPane = normalizePane(paneId); rerender(); }
      return;
    }
    injectStyles();
    if (paneId) currentPane = normalizePane(paneId);
    else currentPane = normalizePane(currentPane);   // a stale workspace route degrades to Defaults
    viewEl = mk('div', { id: 'settings' });
    document.body.appendChild(viewEl);
    mountBarClose();
    document.addEventListener('keydown', onKey, true);
    // Blank surface: paints instantly, no config/connector prefetch. (The old
    // async paint is what buffered, then flashed the previous settings.)
    renderView();
  }

  function toggle(): void {
    if (viewEl) close();
    else open();
  }

  return { open, close, toggle, isOpen: () => !!viewEl };
}
