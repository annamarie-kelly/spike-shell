// Round-trip guard for ${workspace} path parameterization. A workspace group's
// absolute cwd/pinnedPaths must rebase to ${workspace} on export and resolve back
// against the target root on install — and the round trip must be lossless for
// paths under the root. Paths OUTSIDE the root can't rebase and must be reported,
// not silently dropped. Pure module → no app, no Tauri. (npm test builds dist/.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WORKSPACE, isUnder, toWorkspace, fromWorkspace,
  parameterizeGroup, resolveGroup, resolveBundleGroups,
} from '../dist/web/pathparam.js';

const ROOT = '/Users/annamarie/digital-garden';

test('isUnder respects segment boundaries', () => {
  assert.ok(isUnder('/a/b', '/a/b'));
  assert.ok(isUnder('/a/b/c', '/a/b'));
  assert.ok(isUnder('/a/b/c', '/a/b/'));     // trailing slash on root
  assert.equal(isUnder('/a/bc', '/a/b'), false);
  assert.equal(isUnder('/x', '/a/b'), false);
});

test('toWorkspace: root itself, a child, and an outside path', () => {
  assert.equal(toWorkspace(ROOT, ROOT), WORKSPACE);
  assert.equal(toWorkspace(ROOT + '/02-Thinking', ROOT), WORKSPACE + '/02-Thinking');
  assert.equal(toWorkspace('/Users/annamarie/dev/spike', ROOT), null);  // outside → caller keeps absolute
  assert.equal(toWorkspace(WORKSPACE + '/x', ROOT), WORKSPACE + '/x');  // already parameterized, idempotent
});

test('fromWorkspace resolves against a target root and passes non-vars through', () => {
  const target = '/Users/bob/notes';
  assert.equal(fromWorkspace(WORKSPACE, target), target);
  assert.equal(fromWorkspace(WORKSPACE + '/02-Thinking', target), target + '/02-Thinking');
  assert.equal(fromWorkspace('/abs/untouched', target), '/abs/untouched');
});

test('parameterizeGroup rewrites cwd + pinnedPaths and flags external paths', () => {
  const group = {
    name: 'tidemark', color: '#93A7C0', cwd: ROOT + '/02-Thinking',
    pinnedPaths: [ROOT + '/CLAUDE.md', ROOT + '/06-Loops/loops.json', '/Users/annamarie/dev/spike/README.md'],
  };
  const { group: out, external } = parameterizeGroup(group, ROOT);
  assert.equal(out.cwd, WORKSPACE + '/02-Thinking');
  assert.deepEqual(out.pinnedPaths, [
    WORKSPACE + '/CLAUDE.md', WORKSPACE + '/06-Loops/loops.json',
    '/Users/annamarie/dev/spike/README.md',                 // outside the vault → left absolute
  ]);
  assert.deepEqual(external, ['/Users/annamarie/dev/spike/README.md']);
  assert.equal(group.cwd, ROOT + '/02-Thinking');           // input not mutated
});

test('empty cwd is left untouched, not turned into ${workspace}', () => {
  const { group: out } = parameterizeGroup({ name: 'x', cwd: '', pinnedPaths: [] }, ROOT);
  assert.equal(out.cwd, '');
});

test('export → install round trip is lossless on a different target machine', () => {
  const original = {
    name: 'garden', color: '#8A9D8A', cwd: ROOT + '/02-Thinking',
    pinnedPaths: [ROOT + '/CLAUDE.md'],
  };
  const { group: bundled } = parameterizeGroup(original, ROOT);
  const target = '/Users/bob/my-vault';
  const installed = resolveGroup(bundled, target);
  assert.equal(installed.cwd, target + '/02-Thinking');
  assert.deepEqual(installed.pinnedPaths, [target + '/CLAUDE.md']);
});

test('resolveBundleGroups resolves only groups/*.json and tolerates bad JSON', () => {
  const files = {
    'theme.json': '{"mode":"dark"}',
    'manifest.yaml': 'template: "x"',
    'groups/garden.json': JSON.stringify({ name: 'garden', cwd: WORKSPACE + '/02-Thinking', pinnedPaths: [WORKSPACE + '/CLAUDE.md'] }),
    'groups/garden.steering.md': '# steering',
    'groups/broken.json': '{not json',
  };
  const out = resolveBundleGroups(files, '/Users/bob/vault');
  assert.equal(out['theme.json'], files['theme.json']);             // untouched
  assert.equal(out['groups/garden.steering.md'], '# steering');     // untouched
  assert.equal(out['groups/broken.json'], '{not json');             // bad JSON passed through
  const g = JSON.parse(out['groups/garden.json']);
  assert.equal(g.cwd, '/Users/bob/vault/02-Thinking');
  assert.deepEqual(g.pinnedPaths, ['/Users/bob/vault/CLAUDE.md']);
});

// Idempotency: re-importing a bundle on the SAME machine it was exported from
// must resolve back to the identical absolute paths, so groupmerge's canon match
// skips it instead of installing a " (2)" duplicate.
test('same-machine re-import resolves to the original absolute paths', () => {
  const onDisk = { name: 'garden', color: '#8A9D8A', cwd: ROOT + '/02-Thinking', pinnedPaths: [ROOT + '/CLAUDE.md'] };
  const { group: bundled } = parameterizeGroup(onDisk, ROOT);
  const back = resolveGroup(bundled, ROOT);
  assert.deepEqual(back, onDisk);
});
