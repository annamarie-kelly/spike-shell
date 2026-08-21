// The one test worth writing: the .md splice must NEVER clobber a user's hand-edited
// tail. Runs against the compiled module (npm test builds first), using Node's built-in
// test runner — zero new deps. Imports the pure module so the server never boots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleGroupMd, spliceAboveMarker, GROUP_MD_MARKER } from '../dist/groupmd.js';

const M = GROUP_MD_MARKER;

test('first write: no existing file → block + marker + empty tail', () => {
  const out = spliceAboveMarker('', '# Workspace: research', M);
  assert.ok(out.startsWith('# Workspace: research'));
  assert.ok(out.includes(M), 'marker present');
  // nothing below the marker yet
  assert.equal(out.slice(out.indexOf(M) + M.length).trim(), '');
});

test('regenerate: hand-edited tail below the marker survives verbatim', () => {
  const tail = 'My own notes.\nAlways check the changelog first.\n- a pinned thought';
  const existing = `# Workspace: research\n\nold block\n\n${M}\n\n${tail}\n`;
  const out = spliceAboveMarker(existing, '# Workspace: research\n\nNEW BLOCK', M);
  assert.ok(out.includes('NEW BLOCK'), 'head was regenerated');
  assert.ok(!out.includes('old block'), 'old head replaced');
  assert.ok(out.includes(tail), 'user tail preserved exactly');
  // exactly one marker — we didn't duplicate it
  assert.equal(out.split(M).length - 1, 1);
});

test('fail-safe: existing file with NO marker is not truncated', () => {
  const existing = 'Important hand-written content\nthe user typed directly.\n';
  const out = spliceAboveMarker(existing, '# Workspace: x\n\nblock', M);
  assert.ok(out.includes('Important hand-written content'), 'pre-marker content preserved');
  assert.ok(out.includes('the user typed directly.'), 'all of it preserved');
  assert.ok(out.includes(M), 'a marker is added so future regenerates are clean');
});

test('assembleGroupMd: omits empty sections, includes the ones with content', () => {
  const md = assembleGroupMd({ name: 'build', description: 'Ship the thing.', cwd: '/repo', pinnedPaths: ['/repo/SPEC.md', '  '] });
  assert.ok(md.includes('# Workspace: build'));
  assert.ok(md.includes('Ship the thing.'));
  assert.ok(md.includes('/repo'));
  assert.ok(md.includes('/repo/SPEC.md'));
  assert.ok(!md.includes('- ``'), 'blank pinned path filtered out');

  const bare = assembleGroupMd({ name: 'empty' });
  assert.equal(bare.trim(), '# Workspace: empty', 'no stray section headers when fields are empty');
});

test('assembleGroupMd: learned voice emits a DO/DON\'T block; empty voice omits it', () => {
  const md = assembleGroupMd({
    name: 'advisory',
    voice: { do: ['Lead with the number', ' '], dont: ['Open with a summary paragraph'] },
  });
  assert.ok(md.includes('## Voice'), 'Voice header present');
  assert.ok(md.includes('DO:'), 'DO section present');
  assert.ok(md.includes('- Lead with the number'));
  assert.ok(md.includes("DON'T:"), "DON'T section present");
  assert.ok(md.includes('- Open with a summary paragraph'));
  assert.ok(!md.includes('- \n') && !/- \s*$/m.test(md), 'blank directive filtered out');

  // no directives → no Voice block at all
  const none = assembleGroupMd({ name: 'x', voice: { do: [], dont: [] } });
  assert.ok(!none.includes('## Voice'), 'empty voice omits the section');
  // only DON'T → DO section skipped
  const onlyDont = assembleGroupMd({ name: 'y', voice: { dont: ['Hedge'] } });
  assert.ok(onlyDont.includes("DON'T:") && !onlyDont.includes('DO:'), 'DO omitted when only DON\'T present');
});

test('worktreePath is a spawn-time field — it never appears in the assembled .md', () => {
  const md = assembleGroupMd({
    name: 'iso', description: 'Isolated work.', cwd: '/repo',
    worktreePath: '/repo-worktrees/feature-x',
  });
  assert.ok(!md.includes('/repo-worktrees/feature-x'), 'worktree path stays out of the prompt');
  assert.ok(!md.toLowerCase().includes('worktree'), 'no worktree section is emitted');
  assert.ok(md.includes('# Workspace: iso'), 'normal assembly unaffected');
});
