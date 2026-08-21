// Group workspace prompt assembly — the pure half of Phase 3's group feature.
// Kept free of any I/O so it can be unit-tested without booting the server (see
// test/groupmd.test.mjs). server.ts owns the disk read/write; this file only turns
// a group's structured fields into Markdown and splices it over the editable file.

// A group is a persisted workspace. `name` is the human label and (sanitized) the
// disk key; `id` stays client-only and is never persisted. Unknown fields on disk
// round-trip because the whole object is re-serialized as-is.
export interface SpikeGroup {
  name: string;
  color?: string;
  cwd?: string;
  description?: string;
  pinnedPaths?: string[];
  // Learned writing voice for this workspace: DO/DON'T style directives distilled
  // from how the user edits agent output (the "learn the voice" loop). Emitted into
  // the Spike-owned .md head so every spawned agent obeys it. Structured, not the
  // free-text tail — Spike owns and rewrites this on every save.
  voice?: { do?: string[]; dont?: string[] };
  // Per-workspace isolation mode (settings-v2). "shared" (default): all tabs
  // share the working directory. "auto-worktree": Spike creates a git worktree
  // for each 2nd+ concurrent agent in this workspace (engine in src-tauri).
  // Spawn-time concern — NOT part of the assembled .md.
  isolation?: 'shared' | 'auto-worktree';
  // MCP servers enabled for agents in this workspace (least-privilege: a new
  // workspace enables none). Persisted + surfaced in the context editor; not
  // yet enforced at spawn — Spike has no MCP injection point today (Claude
  // Code reads its own MCP config), so this is declared intent, not wiring.
  mcpEnabled?: string[];
  // Legacy (pre-settings-v2): per-workspace mcpServers — superseded by
  // mcpEnabled. Read as a fallback, no longer written.
  mcpServers?: string[];
  createdAt?: string;
  /** Path to this workspace's attest check set. Absent → discovered by convention. */
  attest?: string;
  // Legacy (pre-settings-v2): a manually managed worktree path that used to
  // override the spawn cwd. Superseded by `isolation: "auto-worktree"`.
  // Still parsed harmlessly off old files; ignored otherwise.
  worktreePath?: string;
}

// Each group gets a Markdown system prompt injected into Claude at spawn. Spike owns
// the block ABOVE this marker (regenerated from the JSON on every save); the user owns
// the marker and everything below it, and Spike never rewrites the tail. That split is
// the trust contract — see spliceAboveMarker.
export const GROUP_MD_MARKER = '<!-- Spike-generated — edit freely below this line -->';

// Build the Spike-owned block from a group's structured fields. Plain prose so the
// agent reads it as workspace context, not config. Only sections with content appear.
export function assembleGroupMd(group: SpikeGroup): string {
  const lines: string[] = [`# Workspace: ${group.name}`, ''];
  if (group.description && group.description.trim())
    lines.push(group.description.trim(), '');
  if (group.cwd && group.cwd.trim())
    lines.push(`Working directory: \`${group.cwd.trim()}\``, '');
  const pins = (group.pinnedPaths || []).map(p => (p || '').trim()).filter(Boolean);
  if (pins.length) {
    lines.push('Pinned paths (always relevant in this workspace):');
    for (const p of pins) lines.push(`- \`${p}\``);
    lines.push('');
  }
  const dos = (group.voice?.do || []).map(s => (s || '').trim()).filter(Boolean);
  const donts = (group.voice?.dont || []).map(s => (s || '').trim()).filter(Boolean);
  if (dos.length || donts.length) {
    lines.push('## Voice', '');
    lines.push('Write in this voice — learned from how the user edits their work.', '');
    if (dos.length) {
      lines.push('DO:');
      for (const d of dos) lines.push(`- ${d}`);
      lines.push('');
    }
    if (donts.length) {
      lines.push("DON'T:");
      for (const d of donts) lines.push(`- ${d}`);
      lines.push('');
    }
  }
  return lines.join('\n').trimEnd() + '\n';
}

// Replace ONLY the content above `marker`, preserving the marker and everything the
// user wrote below it verbatim. The trust contract: a regenerate never clobbers a
// hand-edited tail.
//
// Three cases, all fail-safe toward never destroying user content:
//   - no existing file        → block + marker + empty tail (a fresh workspace)
//   - existing marker found   → swap the head, keep the tail exactly as written
//   - existing file, NO marker → don't truncate; demote the whole body to the tail
export function spliceAboveMarker(existingMd: string, newBlock: string, marker: string): string {
  const head = newBlock.trimEnd() + '\n\n' + marker + '\n';
  if (!existingMd) return head + '\n';                       // first write: empty editable tail
  const idx = existingMd.indexOf(marker);
  if (idx === -1)                                            // hand-mangled or pre-marker file
    return head + '\n' + existingMd.replace(/^\n+/, '');     // preserve everything as the tail
  const tail = existingMd.slice(idx + marker.length).replace(/^\n+/, '');
  return head + (tail ? '\n' + tail : '\n');
}
