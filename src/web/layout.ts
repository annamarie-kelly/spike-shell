// Spike tiling layout model. Pure data + helpers — no DOM, no live objects.
// The renderer (renderLayout in app.ts) turns a LayoutState into DOM by
// re-parenting the live surface nodes (the terminal column, the preview
// instances) into a freshly-built split/leaf scaffold. Keeping this file
// side-effect-free makes the tree trivially serializable and testable.
//
// Surface kinds: the whole terminal column ({kind:'terminal'} with no name),
// per-session terminal leaves ({kind:'terminal', name}), and preview panes.
// Previews stopped being a singleton: each instance carries its own id, so
// two files can sit side by side; app.ts maps id → live instance.

export type SurfaceRef =
  | { kind: 'terminal'; name?: string }   // no name = the shared terminal column
  | { kind: 'preview'; id: string };       // one independent preview/editor pane

// A leaf is always a tab-stack (length >= 1). A "single pane" is a stack of 1,
// so tabify in Phase B is just surfaces.push — no node-type change.
export interface LeafNode {
  type: 'leaf';
  id: string;
  surfaces: SurfaceRef[];
  activeIndex: number;
}

export interface SplitNode {
  type: 'split';
  id: string;
  dir: 'row' | 'col';        // row = side-by-side; col = stacked vertically
  children: LayoutNode[];    // invariant (post-prune): length >= 2
  sizes: number[];           // fractional weights, normalized to sum 1
}

export type LayoutNode = SplitNode | LeafNode;

// The whole tiling area EXCEPT the file-tree sidebar. The tree is not a leaf —
// it docks to one edge and carries its own width/visibility.
export interface LayoutState {
  root: LayoutNode | null;          // null only transiently (everything closed)
  treeSide: 'left' | 'right';
  treeWidth: number;                // px
  treeVisible: boolean;
}

// ── ids ────────────────────────────────────────────────────────────────────
// Module-local counter. Only used for DOM data-attrs + per-render splitter keys;
// uniqueness within one render is all that matters. Restored trees are re-id'd
// (see deserialize) so a fresh boot can't collide ids with persisted ones.
let _idSeq = 0;
export function nodeId(prefix = 'n'): string { return prefix + '-' + (++_idSeq).toString(36); }

// ── constructors ─────────────────────────────────────────────────────────────
export function leaf(surfaces: SurfaceRef[], activeIndex = 0): LeafNode {
  const clamp = surfaces.length ? Math.max(0, Math.min(activeIndex, surfaces.length - 1)) : 0;
  return { type: 'leaf', id: nodeId('leaf'), surfaces, activeIndex: clamp };
}
export function terminalLeaf(name?: string): LeafNode { return leaf([{ kind: 'terminal', name }]); }
export function previewLeaf(id: string): LeafNode { return leaf([{ kind: 'preview', id }]); }

export function split(dir: 'row' | 'col', children: LayoutNode[], sizes?: number[]): SplitNode {
  const n = children.length;
  const s = sizes && sizes.length === n ? sizes : children.map(() => 1 / n);
  return { type: 'split', id: nodeId('split'), dir, children, sizes: normalize(s) };
}

// ── size math ────────────────────────────────────────────────────────────────
// Normalize weights to sum 1, guarding against zero/NaN/negative so a child
// never collapses to a flex-grow of 0 by accident.
export function normalize(sizes: number[]): number[] {
  const clean = sizes.map(s => (Number.isFinite(s) && s > 0 ? s : 0.0001));
  const sum = clean.reduce((a, b) => a + b, 0) || 1;
  return clean.map(s => s / sum);
}

// ── traversal ────────────────────────────────────────────────────────────────
export function leaves(node: LayoutNode | null): LeafNode[] {
  if (!node) return [];
  if (node.type === 'leaf') return [node];
  return node.children.flatMap(leaves);
}

export function findLeaf(node: LayoutNode | null, pred: (s: SurfaceRef) => boolean): LeafNode | null {
  for (const lf of leaves(node)) if (lf.surfaces.some(pred)) return lf;
  return null;
}

export function hasSurface(node: LayoutNode | null, pred: (s: SurfaceRef) => boolean): boolean {
  return findLeaf(node, pred) != null;
}

// ── mutation helpers ─────────────────────────────────────────────────────────
// Collapse the tree to its canonical form: a split with one child becomes that
// child; a leaf with no surfaces is dropped; an empty tree becomes null. Run
// after every structural mutation and after rehydration so the renderer only
// ever sees splits with >= 2 children and leaves with >= 1 surface.
export function pruneEmpty(node: LayoutNode | null): LayoutNode | null {
  if (!node) return null;
  if (node.type === 'leaf') return node.surfaces.length ? node : null;
  const kids: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((c, i) => {
    const p = pruneEmpty(c);
    if (p) { kids.push(p); sizes.push(node.sizes[i] != null ? node.sizes[i] : 1); }
  });
  if (kids.length === 0) return null;
  if (kids.length === 1) return kids[0];
  return { ...node, children: kids, sizes: normalize(sizes) };
}

// ── Phase B mutations (drag-to-dock) ─────────────────────────────────────────
export type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center';
export type DropSide = Exclude<DropZone, 'center'>;

export function findLeafById(node: LayoutNode | null, id: string): LeafNode | null {
  for (const lf of leaves(node)) if (lf.id === id) return lf;
  return null;
}

// The split that directly holds `id`, or null if `id` is the root / absent.
export function findParent(node: LayoutNode | null, id: string): { parent: SplitNode; index: number } | null {
  if (!node || node.type === 'leaf') return null;
  for (let i = 0; i < node.children.length; i++) {
    if (node.children[i].id === id) return { parent: node, index: i };
    const deeper = findParent(node.children[i], id);
    if (deeper) return deeper;
  }
  return null;
}

// Remove surfaces[index] from a leaf and prune. Returns the surface, or null
// if the address was stale (leaf pruned mid-drag, index out of range).
export function takeSurface(state: LayoutState, leafId: string, index: number): SurfaceRef | null {
  const lf = findLeafById(state.root, leafId);
  if (!lf || index < 0 || index >= lf.surfaces.length) return null;
  const [surf] = lf.surfaces.splice(index, 1);
  lf.activeIndex = Math.max(0, Math.min(lf.activeIndex, lf.surfaces.length - 1));
  state.root = pruneEmpty(state.root);
  return surf || null;
}

// Dock `node` against one side of the target leaf. If the target's parent
// already splits in that direction the node splices in as a sibling (taking
// half the target's weight); otherwise the target is wrapped in a fresh
// two-child 50/50 split. Stale target (pruned mid-drag) is a silent no-op —
// callers re-render either way, so the drag just dissolves.
export function insertBeside(state: LayoutState, targetId: string, node: LayoutNode, side: DropSide): void {
  const dir: 'row' | 'col' = side === 'left' || side === 'right' ? 'row' : 'col';
  const before = side === 'left' || side === 'top';
  if (!state.root) { state.root = node; return; }
  if (state.root.id === targetId) {
    state.root = split(dir, before ? [node, state.root] : [state.root, node], [0.5, 0.5]);
    return;
  }
  const at = findParent(state.root, targetId);
  if (!at) return;
  const { parent, index } = at;
  if (parent.dir === dir) {
    const w = (parent.sizes[index] != null ? parent.sizes[index] : 1 / parent.children.length) / 2;
    parent.sizes[index] = w;
    parent.children.splice(before ? index : index + 1, 0, node);
    parent.sizes.splice(before ? index : index + 1, 0, w);
    parent.sizes = normalize(parent.sizes);
  } else {
    parent.children[index] = split(dir, before ? [node, parent.children[index]] : [parent.children[index], node], [0.5, 0.5]);
  }
}

// Drop every surface matching `pred` from every leaf, then prune. Mutates state.
export function removeSurface(state: LayoutState, pred: (s: SurfaceRef) => boolean): void {
  for (const lf of leaves(state.root)) {
    const before = lf.surfaces.length;
    lf.surfaces = lf.surfaces.filter(s => !pred(s));
    if (lf.surfaces.length !== before) {
      lf.activeIndex = Math.max(0, Math.min(lf.activeIndex, lf.surfaces.length - 1));
    }
  }
  state.root = pruneEmpty(state.root);
}

// ── serialization ────────────────────────────────────────────────────────────
function isValidNode(n: any): boolean {
  if (!n || typeof n !== 'object') return false;
  if (n.type === 'leaf') {
    // Previews accept a missing id (pre-multi-instance persisted layouts) so a
    // legacy tree doesn't void the whole restore — boot strips every persisted
    // preview surface anyway (they're session-transient, see loadLayout).
    return Array.isArray(n.surfaces) && n.surfaces.length > 0 && n.surfaces.every((s: any) =>
      s && ((s.kind === 'preview' && (s.id == null || typeof s.id === 'string')) ||
            (s.kind === 'terminal' && (s.name == null || typeof s.name === 'string'))));
  }
  if (n.type === 'split') {
    return (n.dir === 'row' || n.dir === 'col') && Array.isArray(n.children) &&
      n.children.length >= 2 && n.children.every(isValidNode) && Array.isArray(n.sizes);
  }
  return false;
}

// Give every restored node a fresh id so a same-session boot can't collide with
// ids minted earlier this page-load.
function reid(node: LayoutNode): void {
  node.id = nodeId(node.type);
  if (node.type === 'split') node.children.forEach(reid);
}

export function serialize(state: LayoutState): string {
  return JSON.stringify({
    root: state.root,
    treeSide: state.treeSide,
    treeWidth: state.treeWidth,
    treeVisible: state.treeVisible,
  });
}

// Parse + validate persisted state. Returns null on anything malformed so the
// caller can fall back to a synthesized default (no half-broken trees).
export function deserialize(raw: string | null): LayoutState | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object') return null;
    const root = o.root && isValidNode(o.root) ? (o.root as LayoutNode) : null;
    if (root) reid(root);
    return {
      root,
      treeSide: o.treeSide === 'right' ? 'right' : 'left',
      treeWidth: Number.isFinite(o.treeWidth) ? o.treeWidth : 264,
      treeVisible: o.treeVisible !== false,
    };
  } catch { return null; }
}

// First-run default (no persisted layout): a single terminal-column leaf, with
// the sidebar prefs folded in from the legacy localStorage keys so existing
// users see no change. The preview leaf is added on demand when a file opens.
export function defaultState(opts: { treeVisible?: boolean; treeWidth?: number; treeSide?: 'left' | 'right' } = {}): LayoutState {
  return {
    root: terminalLeaf(),
    treeSide: opts.treeSide === 'right' ? 'right' : 'left',
    treeWidth: Number.isFinite(opts.treeWidth as number) ? (opts.treeWidth as number) : 264,
    treeVisible: opts.treeVisible !== false,
  };
}
