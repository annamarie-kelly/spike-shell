// assembleContext is the source of truth for the settings previews. These tests
// pin two things: (1) the tagged, ordered lines it emits for the golden cases,
// and (2) parity with the real spawn assembly — the global prompt precedes all
// workspace context (mirroring Rust's compose_system_prompt: base + append +
// group_md), and the workspace `set-here` lines are derived from the same fields
// assembleGroupMd writes into the on-disk .md, so preview and reality can't drift.
//
// Runs against the compiled modules (npm test builds first) with Node's built-in
// runner — zero new deps. Pure modules, so nothing boots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleContext, joinContext, contextTokens } from '../dist/assemble-context.js';
import { assembleGroupMd } from '../dist/groupmd.js';

const DEFAULTS = { spawnPromptAppend: 'Be concise. Prefer editing existing files.', cwd: '~/garden', recentCount: 10 };
const WS = {
  name: 'garden',
  description: 'My Obsidian vault.',
  cwd: '~/garden',
  pins: ['style-guide.md', '/templates'],
  instructions: 'Write in my voice. Never touch /published.',
};

const tags = (lines) => lines.map(l => l.from);
const fields = (lines) => lines.map(l => l.sourceField);

test('defaults-only (ws=null): set-here prompt + two auto lines, no inherited', () => {
  const lines = assembleContext(DEFAULTS, null);
  assert.deepEqual(tags(lines), ['set-here', 'auto', 'auto']);
  assert.ok(!lines.some(l => l.from === 'inherited'), 'root screen has no inherited layer');
  assert.equal(lines[0].text, DEFAULTS.spawnPromptAppend);
  assert.equal(lines[0].sourceField, 'spawnPromptAppend');
  assert.equal(lines[1].text, 'Working directory: ~/garden');
  assert.equal(lines[2].text, '[auto] open file + 10 recent files');
});

test('full workspace: inherited prompt, set-here block, auto tail — in order', () => {
  const lines = assembleContext(DEFAULTS, WS);
  assert.deepEqual(tags(lines), ['inherited', 'set-here', 'set-here', 'set-here', 'set-here', 'auto', 'auto']);
  assert.deepEqual(fields(lines), ['spawnPromptAppend', 'name', 'description', 'instructions', 'pinnedPaths', 'cwd', 'recent']);
  assert.equal(lines[0].text, DEFAULTS.spawnPromptAppend, 'global prompt is inherited, shown verbatim');
  assert.equal(lines[1].text, '# Workspace: garden');
  assert.equal(lines.find(l => l.sourceField === 'pinnedPaths').text, 'Pinned: style-guide.md, /templates');
});

test('empty workspace: still renders header + auto lines, never blank', () => {
  const lines = assembleContext(DEFAULTS, { name: 'blank' });
  assert.deepEqual(tags(lines), ['inherited', 'set-here', 'auto', 'auto']);
  assert.equal(lines[1].text, '# Workspace: blank');
  assert.ok(lines.length >= 3, 'never empty');
});

test('workspace without a folder: working dir falls back to Defaults, flagged', () => {
  const lines = assembleContext(DEFAULTS, { name: 'nofolder' });
  const wd = lines.find(l => l.sourceField === 'cwd');
  assert.equal(wd.text, 'Working directory: ~/garden (fallback)');
  assert.equal(wd.from, 'auto');
});

test('workspace with its own folder is NOT flagged as fallback', () => {
  const lines = assembleContext(DEFAULTS, { name: 'own', cwd: '~/own-repo' });
  const wd = lines.find(l => l.sourceField === 'cwd');
  assert.equal(wd.text, 'Working directory: ~/own-repo');
});

test('empty global prompt: line omitted, not a blank inherited line', () => {
  const lines = assembleContext({ ...DEFAULTS, spawnPromptAppend: '   ' }, WS);
  assert.ok(!lines.some(l => l.sourceField === 'spawnPromptAppend'), 'blank prompt dropped');
  assert.equal(lines[0].from, 'set-here', 'workspace starts straight into its own lines');
  assert.equal(lines[0].text, '# Workspace: garden');
});

test('no folder anywhere: working dir shows project root', () => {
  const lines = assembleContext({ spawnPromptAppend: 'x' }, { name: 'w' });
  assert.equal(lines.find(l => l.sourceField === 'cwd').text, 'Working directory: project root');
});

// ── parity: preview vs the real spawn ────────────────────────────────────────

test('parity: global append precedes ALL workspace lines (mirrors compose_system_prompt)', () => {
  const lines = assembleContext(DEFAULTS, WS);
  const appendIdx = lines.findIndex(l => l.sourceField === 'spawnPromptAppend');
  const firstWsIdx = lines.findIndex(l => ['name', 'description', 'instructions', 'pinnedPaths'].includes(l.sourceField));
  assert.ok(appendIdx >= 0 && firstWsIdx >= 0);
  assert.ok(appendIdx < firstWsIdx, 'append (base+append) comes before workspace md, like Rust');
});

test('parity: workspace set-here content is exactly the fields assembleGroupMd writes', () => {
  // Every set-here workspace line must be sourced from a field assembleGroupMd
  // reads (name/description/cwd/pins) or the user note tail — so the preview
  // never shows content the on-disk .md wouldn't carry.
  const lines = assembleContext(DEFAULTS, WS);
  const md = assembleGroupMd({ name: WS.name, description: WS.description, cwd: WS.cwd, pinnedPaths: WS.pins });
  // header + description are baked into the .md head verbatim
  assert.ok(md.includes(`# Workspace: ${WS.name}`), 'md carries the header');
  assert.ok(md.includes(WS.description), 'md carries the description');
  // pins appear in the .md (as a list) and in the preview (as a joined line);
  // both draw from the same pinnedPaths array
  for (const p of WS.pins) assert.ok(md.includes(p), `md carries pin ${p}`);
  // the preview must not invent a set-here field with no md/note backing
  const backed = new Set(['name', 'description', 'instructions', 'pinnedPaths']);
  for (const l of lines.filter(l => l.from === 'set-here')) {
    assert.ok(backed.has(l.sourceField), `set-here line ${l.sourceField} is backed`);
  }
});

test('joinContext + contextTokens are consistent (chars/4)', () => {
  const lines = assembleContext(DEFAULTS, WS);
  const text = joinContext(lines);
  assert.equal(contextTokens(lines), Math.round(text.length / 4));
  assert.ok(text.includes('\n\n'), 'distinct fields separated by a blank line');
});
