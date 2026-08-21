// Drag-to-dock tree math. The invariants that keep the tiling engine honest:
// splits always have >= 2 children with normalized sizes, takeSurface prunes
// collapsed structure, insertBeside splices into same-direction parents instead
// of nesting, and a stale target is a no-op rather than a corrupt tree.
// Runs against the compiled module (npm test builds first).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  leaf, terminalLeaf, previewLeaf, split,
  insertBeside, takeSurface, findParent, findLeafById, pruneEmpty, leaves,
  serialize, deserialize,
} from '../dist/web/layout.js';

const state = (root) => ({ root, treeSide: 'left', treeWidth: 264, treeVisible: true });
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

test('insertBeside the root leaf wraps it in a 50/50 split', () => {
  const term = terminalLeaf();
  const st = state(term);
  const pv = previewLeaf('pv1');
  insertBeside(st, term.id, pv, 'right');
  assert.equal(st.root.type, 'split');
  assert.equal(st.root.dir, 'row');
  assert.deepEqual(st.root.children.map((c) => c.id), [term.id, pv.id]);
  assert.deepEqual(st.root.sizes, [0.5, 0.5]);
});

test('before-sides (left/top) place the new node first', () => {
  const term = terminalLeaf();
  const st = state(term);
  const pv = previewLeaf('pv1');
  insertBeside(st, term.id, pv, 'top');
  assert.equal(st.root.dir, 'col');
  assert.equal(st.root.children[0].id, pv.id);
});

test('same-direction parent splices a sibling, halving the target weight', () => {
  const a = terminalLeaf(), b = previewLeaf('pv1');
  const root = split('row', [a, b], [0.6, 0.4]);
  const st = state(root);
  const c = terminalLeaf('claude 2');
  insertBeside(st, a.id, c, 'right');
  assert.equal(st.root, root, 'no new wrapper split');
  assert.deepEqual(root.children.map((x) => x.id), [a.id, c.id, b.id]);
  // a's 0.6 split in half between a and c; b keeps 0.4 — and it all renormalizes
  assert.ok(Math.abs(root.sizes[0] - 0.3) < 1e-9);
  assert.ok(Math.abs(root.sizes[1] - 0.3) < 1e-9);
  assert.ok(Math.abs(sum(root.sizes) - 1) < 1e-9);
});

test('cross-direction drop wraps just the target in a nested split', () => {
  const a = terminalLeaf(), b = previewLeaf('pv1');
  const root = split('row', [a, b], [0.6, 0.4]);
  const st = state(root);
  const c = terminalLeaf('claude 2');
  insertBeside(st, b.id, c, 'bottom');
  assert.equal(root.children[1].type, 'split');
  assert.equal(root.children[1].dir, 'col');
  assert.deepEqual(root.children[1].children.map((x) => x.id), [b.id, c.id]);
  assert.ok(Math.abs(root.sizes[1] - 0.4) < 1e-9, 'outer weight untouched');
});

test('takeSurface collapses a two-leaf split back to a single leaf', () => {
  const a = terminalLeaf(), b = previewLeaf('pv1');
  const st = state(split('row', [a, b]));
  const surf = takeSurface(st, b.id, 0);
  assert.equal(surf.kind, 'preview');
  assert.equal(surf.id, 'pv1', 'the moved surface keeps its instance id');
  assert.equal(st.root.id, a.id, 'split pruned to the surviving leaf');
});

test('takeSurface from a stack keeps the leaf and clamps activeIndex', () => {
  const stack = leaf([{ kind: 'terminal' }, { kind: 'preview', id: 'pv1' }], 1);
  const st = state(stack);
  const surf = takeSurface(st, stack.id, 1);
  assert.equal(surf.kind, 'preview');
  assert.equal(st.root.id, stack.id);
  assert.equal(stack.surfaces.length, 1);
  assert.equal(stack.activeIndex, 0);
});

test('takeSurface with a stale address is a null no-op', () => {
  const a = terminalLeaf();
  const st = state(a);
  assert.equal(takeSurface(st, 'leaf-nope', 0), null);
  assert.equal(takeSurface(st, a.id, 5), null);
  assert.equal(st.root.id, a.id);
});

test('insertBeside a vanished target leaves the tree untouched', () => {
  const a = terminalLeaf();
  const st = state(a);
  insertBeside(st, 'leaf-gone', previewLeaf('pv1'), 'left');
  assert.equal(st.root.id, a.id);
});

test('move round-trip: take then insert never loses a surface', () => {
  const a = terminalLeaf(), b = previewLeaf('pv1'), c = terminalLeaf('claude 2');
  const st = state(split('row', [a, split('col', [b, c])]));
  const surf = takeSurface(st, c.id, 0);
  insertBeside(st, a.id, leaf([surf]), 'top');
  const all = leaves(st.root).flatMap((l) => l.surfaces);
  assert.equal(all.length, 3);
  assert.ok(all.some((s) => s.kind === 'terminal' && s.name === 'claude 2'));
  // the col split that held b+c collapsed to b
  const parentOfB = findParent(st.root, b.id);
  assert.equal(parentOfB.parent.dir, 'row');
});

test('findParent / findLeafById address nested nodes', () => {
  const a = terminalLeaf(), b = previewLeaf('pv1'), c = terminalLeaf('x');
  const inner = split('col', [b, c]);
  const root = split('row', [a, inner]);
  assert.equal(findParent(root, c.id).parent.id, inner.id);
  assert.equal(findParent(root, c.id).index, 1);
  assert.equal(findParent(root, a.id).parent.id, root.id);
  assert.equal(findParent(root, root.id), null);
  assert.equal(findLeafById(root, b.id).id, b.id);
  assert.equal(findLeafById(root, 'nope'), null);
});

test('pruneEmpty drops empty leaves and unwraps single-child splits', () => {
  const a = terminalLeaf();
  const empty = leaf([]);
  empty.surfaces = [];
  const root = split('row', [a, empty]);
  const pruned = pruneEmpty(root);
  assert.equal(pruned.id, a.id);
});

// ── preview instance ids (multi-preview SurfaceRef shape) ──────────────────

test('preview surfaces carry their instance id through serialize/deserialize', () => {
  const st = state(split('row', [terminalLeaf(), previewLeaf('pv7')], [0.58, 0.42]));
  const back = deserialize(serialize(st));
  assert.deepEqual(back.root.children[1].surfaces[0], { kind: 'preview', id: 'pv7' });
});

test('deserialize rejects a preview with a malformed id', () => {
  const bad = JSON.stringify({
    root: { type: 'leaf', id: 'x', surfaces: [{ kind: 'preview', id: 42 }], activeIndex: 0 },
  });
  assert.equal(deserialize(bad).root, null, 'malformed tree falls back to null root');
});

test('deserialize tolerates a legacy id-less preview (boot strips it anyway)', () => {
  const legacy = JSON.stringify({
    root: {
      type: 'split', id: 's', dir: 'row', sizes: [0.5, 0.5],
      children: [
        { type: 'leaf', id: 'a', surfaces: [{ kind: 'terminal' }], activeIndex: 0 },
        { type: 'leaf', id: 'b', surfaces: [{ kind: 'preview' }], activeIndex: 0 },
      ],
    },
  });
  const back = deserialize(legacy);
  assert.notEqual(back.root, null, 'the rest of the tree survives a pre-id preview');
});
