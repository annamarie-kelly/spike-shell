// assembleContext — the single pure function that produces the tagged, ordered
// lines the settings previews render. It is the source of truth for the PREVIEW
// only: the real spawn prompt is assembled in Rust (compose_system_prompt in
// src-tauri/src/pty.rs, base + spawnPromptAppend + group_md, joined by blank
// lines) and delivered across three channels (system-prompt env var, process
// cwd, and the runtime `spike context` CLI). A single TS function can't BE that
// path across the language boundary, so this mirrors its order and provenance
// instead, and derives its workspace lines from the same fields as
// assembleGroupMd (src/groupmd.ts) so the preview can never claim content the
// on-disk .md wouldn't carry. test/assemble-context.test.mjs guards both.
//
// Pure, DOM-free, framework-agnostic (like groupmd.ts) so it unit-tests without
// booting anything. Display formatting (path shortening, pin basenames) stays in
// the UI layer — the caller passes already-display-ready strings.

// Where a line came from — drives its marker color + read-only-ness in the panel.
//   inherited → gold  · comes from Defaults, editable only there
//   set-here  → green  · defined on the screen you're looking at
//   auto      → gray   · injected by Spike, not user-controllable here
export type Provenance = 'inherited' | 'set-here' | 'auto';

export interface ContextLine {
  // The line's full text. May contain newlines (one field = one block); the
  // panel wraps it under a single provenance marker.
  text: string;
  from: Provenance;
  // The config/field this line originated from — used by the panel to route
  // "edit in Defaults" and to key the debounced re-render. Absent on auto lines
  // with no editable source.
  sourceField?: string;
}

// The Defaults layer, mapped to Spike's real config keys:
//   spawnPromptAppend → config.json top-level (the one global prompt)
//   cwd               → config.spawnDefaults.cwd (the fallback working dir)
//   recentCount       → config.logging.recentCount (default 10)
export interface AssembleDefaults {
  spawnPromptAppend?: string;
  cwd?: string;
  recentCount?: number;
}

// The workspace layer. `instructions` is the user-owned tail of
// ~/.spike/groups/<slug>.md (loaded separately); `pins` are already
// display-ready strings (the UI applies displayPin before calling).
export interface AssembleWorkspace {
  name: string;
  description?: string;
  cwd?: string;
  pins?: string[];
  instructions?: string;
  // Learned DO/DON'T writing voice (see groupmd.ts SpikeGroup.voice). Structured,
  // Spike-owned — shown so the preview reflects the ## Voice block in the .md head.
  voice?: { do?: string[]; dont?: string[] };
}

const DEFAULT_RECENT = 10;

// Build the ordered, tagged lines. `ws === null` renders the Defaults screen
// itself (no inherited layer — the global prompt is set-here there). Order
// mirrors the Rust spawn assembly (global append precedes workspace context),
// with auto lines grouped last for legibility; this is a presentational
// grouping, NOT the literal .md line order (which the user doesn't control).
export function assembleContext(
  defaults: AssembleDefaults,
  ws: AssembleWorkspace | null,
): ContextLine[] {
  const lines: ContextLine[] = [];

  // 1. The global spawn prompt. set-here on Defaults; inherited on a workspace
  //    (same one source, shown twice). Empty → omitted, never a blank line.
  const append = (defaults.spawnPromptAppend || '').trim();
  if (append) {
    lines.push({ text: append, from: ws ? 'inherited' : 'set-here', sourceField: 'spawnPromptAppend' });
  }

  // 2. Workspace-only lines (skipped entirely on the Defaults screen).
  if (ws) {
    lines.push({ text: `# Workspace: ${ws.name}`, from: 'set-here', sourceField: 'name' });

    const desc = (ws.description || '').trim();
    if (desc) lines.push({ text: desc, from: 'set-here', sourceField: 'description' });

    const instr = (ws.instructions || '').trim();
    if (instr) lines.push({ text: instr, from: 'set-here', sourceField: 'instructions' });

    const pins = (ws.pins || []).map(p => (p || '').trim()).filter(Boolean);
    if (pins.length) {
      lines.push({ text: `Pinned: ${pins.join(', ')}`, from: 'set-here', sourceField: 'pinnedPaths' });
    }

    const vdo = (ws.voice?.do || []).map(s => (s || '').trim()).filter(Boolean);
    const vdont = (ws.voice?.dont || []).map(s => (s || '').trim()).filter(Boolean);
    if (vdo.length || vdont.length) {
      const parts: string[] = ['Voice:'];
      for (const d of vdo) parts.push(`  ✓ ${d}`);
      for (const d of vdont) parts.push(`  ✕ ${d}`);
      lines.push({ text: parts.join('\n'), from: 'set-here', sourceField: 'voice' });
    }
  }

  // 3. Auto lines — injected by Spike, delivered out-of-band (process cwd + the
  //    `spike context` CLI). Shown so the panel is honest about the full context.
  //    resolvedDir: the workspace folder, else the Defaults fallback directory.
  const wsCwd = (ws?.cwd || '').trim();
  const fallbackCwd = (defaults.cwd || '').trim();
  const resolvedDir = wsCwd || fallbackCwd;
  const usedFallback = !!ws && !wsCwd && !!fallbackCwd;   // ws exists but borrowed the fallback
  lines.push({
    text: `Working directory: ${resolvedDir || 'project root'}` + (usedFallback ? ' (fallback)' : ''),
    from: 'auto', sourceField: 'cwd',
  });

  const recent = defaults.recentCount != null ? defaults.recentCount : DEFAULT_RECENT;
  lines.push({ text: `[auto] open file + ${recent} recent files`, from: 'auto', sourceField: 'recent' });

  return lines;
}

// Flattened text of the assembled lines (one blank line between distinct
// fields), matching the panel's rendered grouping. Used for the token estimate
// and by the parity test.
export function joinContext(lines: ContextLine[]): string {
  return lines.map(l => l.text).join('\n\n');
}

// Rough token estimate: chars ÷ 4. Deliberately not a real tokenizer — the
// caller labels it with `~`. Kept here so preview and any headless check agree.
export function contextTokens(lines: ContextLine[]): number {
  return Math.max(0, Math.round(joinContext(lines).length / 4));
}
