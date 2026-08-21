// The bug this guards against: re-importing a bundle you exported from this same
// machine duplicated every workspace ("backend (2)", "frontend (2)", ...), because
// the install deduped by NAME only. planGroupInstalls must skip a group whose
// content already matches one on disk, and only suffix a genuine name+content
// collision. Pure module → no app, no Tauri. (npm test builds dist/ first.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planGroupInstalls, canonGroup } from '../dist/web/groupmerge.js';

// An existing on-disk group carries machine-specific fields (cwd, createdAt).
const onDisk = {
  name: 'backend',
  color: '#B898A8',
  cwd: '/Users/amk/dev/tidemark-backend/',
  createdAt: '2026-06-11T20:13:55.982Z',
  description: 'Django backend for Sonar.',
  isolation: 'auto-worktree',
  mcpEnabled: ['granola', 'linear', 'notion', 'affinity-mcp'],
  pinnedPaths: ['CLAUDE.md', 'tidemark_backend/settings/env'],
};
// What export writes into a bundle: the same group minus cwd/createdAt.
function exported(g) {
  const { cwd, createdAt, ...portable } = g;
  return JSON.stringify(portable, null, 2) + '\n';
}

test('canon ignores cwd/createdAt/id and key order — exported copy matches its on-disk origin', () => {
  const reordered = { mcpEnabled: onDisk.mcpEnabled, name: 'backend', color: '#B898A8',
    isolation: 'auto-worktree', pinnedPaths: onDisk.pinnedPaths, description: 'Django backend for Sonar.',
    id: 'client-session-xyz' };
  assert.equal(canonGroup(onDisk), canonGroup(reordered), 'machine + client-only fields and order do not affect identity');
});

test('re-importing an unchanged group is skipped, not duplicated', () => {
  const files = { 'groups/backend.json': exported(onDisk) };
  const { installs, skipped } = planGroupInstalls(files, [onDisk]);
  assert.deepEqual(skipped, ['backend'], 'kept yours');
  assert.equal(installs.length, 0, 'no second copy installed');
});

test('same name + DIFFERENT content still gets a " (2)" suffix (never clobbers)', () => {
  const changed = { ...onDisk, color: '#000000' };           // a real edit
  const files = { 'groups/backend.json': exported(changed) };
  const { installs, skipped } = planGroupInstalls(files, [onDisk]);
  assert.equal(skipped.length, 0);
  assert.equal(installs.length, 1);
  assert.equal(installs[0].group.name, 'backend (2)', 'collision suffixed, original untouched');
});

test('a genuinely new group installs under its own name', () => {
  const fresh = { name: 'research', color: '#88aa88', description: 'Reading.', isolation: 'none' };
  const files = { 'groups/research.json': exported(fresh) };
  const { installs, skipped } = planGroupInstalls(files, [onDisk]);
  assert.equal(skipped.length, 0);
  assert.equal(installs.length, 1);
  assert.equal(installs[0].group.name, 'research');
});

test('full re-import of every workspace skips them all (the reported bug)', () => {
  const groups = ['backend', 'frontend', 'learning', 'spike', 'tidemark'].map((name) => ({
    name, color: '#abcabc', description: `${name} ws`, isolation: 'none', pinnedPaths: [],
  }));
  const files = {};
  for (const g of groups) files[`groups/${g.name}.json`] = exported(g);
  const { installs, skipped } = planGroupInstalls(files, groups);
  assert.equal(installs.length, 0, 'nothing reinstalled');
  assert.deepEqual(skipped.sort(), ['backend', 'frontend', 'learning', 'spike', 'tidemark']);
});

test('steering markdown rides along with an installed (non-skipped) group', () => {
  const fresh = { name: 'research', color: '#88aa88', isolation: 'none' };
  const files = {
    'groups/research.json': exported(fresh),
    'groups/research.steering.md': 'Always read the changelog.\n',
  };
  const { installs } = planGroupInstalls(files, []);
  assert.equal(installs[0].steering, 'Always read the changelog.\n');
});

test('two bundle groups colliding with each other chain (2)/(3)', () => {
  // distinct content so neither is skipped; both collide on name "dup"
  const files = {
    'groups/a.json': JSON.stringify({ name: 'dup', color: '#1' }),
    'groups/b.json': JSON.stringify({ name: 'dup', color: '#2' }),
  };
  const { installs } = planGroupInstalls(files, [{ name: 'dup', color: '#0' }]);
  const names = installs.map((i) => i.group.name).sort();
  assert.deepEqual(names, ['dup (2)', 'dup (3)']);
});
