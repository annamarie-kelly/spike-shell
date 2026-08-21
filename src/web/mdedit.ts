// Source-mapped markdown text editing. Pure data + string helpers — no DOM, no
// marked import (the caller passes tokens in), so test/mdedit.test.mjs can
// exercise all of it under plain node.
//
// The contract this file exists to enforce: a visual edit produces the SMALLEST
// POSSIBLE patch to the original markdown, and every byte outside that patch is
// left alone. Not "re-serialize the block the user touched" — that normalizes
// reference links, escapes, entities, hard breaks and delimiter choices that
// happen to share the block, which is exactly the preservation claim we care
// about. We patch one span inside one inline text token and nothing else.
//
// Terminology: a "leaf" is one inline `text` token that we have PROVEN is safe
// to substitute into. Everything is fail-safe — any check we cannot complete
// (offsets that don't verify, an entity we can't round-trip, a construct we
// don't model) marks the leaf non-editable rather than guessing. A read-only
// leaf costs the user a trip to the source editor; a wrong one corrupts a file
// an agent is about to read.

// ── the four rules a leaf must satisfy (see docs/plans/wysiwyg-edit-pane.md §3.1)
//  1. it is an inline token of type `text`
//  2. it is a direct child of a modelled block (paragraph, heading, list item);
//     text nested in em/strong/link/codespan is read-only in v1
//  3. its computed span verifies byte-for-byte: src.slice(start,end) === raw
//  4. its source is already plain: no entity references, so the rendered text
//     and the source bytes are the same string
// Rule 3 is what turns offset arithmetic (block `raw` carries prefixes and
// trailing newlines, so where inline content begins is inference) into a safe
// operation: we check, and a leaf that fails is simply not editable.

/** A substitution mdPreprocess made, in ORIGINAL (pre-substitution) coordinates. */
export interface Edit { at: number; oldLen: number; newLen: number }

/**
 * A proven-editable run of text, in FILE coordinates (frontmatter included).
 * `index` is its position among ALL inline text tokens in the document (not just
 * the editable ones) — the handle verifyPatch uses to say "this leaf is allowed
 * to change and no other". `block` is the index of the top-level token it sits
 * in, so a caller rendering block by block knows which leaves are its.
 */
export interface Leaf {
  start: number; end: number; text: string; index: number; block: number;
}

export interface Preprocessed { out: string; edits: Edit[] }

// Anything that renders as a different string than its source bytes fails rule
// 4. In practice that means character references: marked passes `&amp;` through
// to the HTML unchanged, so the DOM shows `&` where the file says `&amp;` and
// there is no honest substitution. A bare `&` is fine — marked escapes it on
// output and the DOM decodes it back to the same byte.
const ENTITY_RE = /&(?:#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{0,31});/;

// Block prefixes we can compute exactly. A heading with no ATX match is setext
// (`Title\n=====`), whose content starts at offset 0.
const ATX_RE = /^[ \t]{0,3}#{1,6}[ \t]+/;
const PARA_RE = /^[ \t]*/;
// list marker, plus the `[ ] ` of a task item (marked strips it from the item's
// content tokens, so it belongs to the prefix).
const LI_RE = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]*)?/;

// ── mdPreprocess, with a source map ────────────────────────────────────────
// Obsidian-isms rewritten before marked sees the text: `![[embed]]` and
// `[[wikilink]]`. app.ts owns what they turn INTO (it needs the file index and
// asset URLs); this owns the rewrite itself so there is exactly one copy of the
// pattern and one definition of where the substitutions landed.
//
// One pass, not two. The original did embeds then wikilinks; a single alternation
// with the `!` optional is equivalent (no replacement output contains `[[`, so
// the second pass could never see the first's work) and it keeps the edit list
// in one coordinate space instead of needing composition.
const WIKI_RE = /(!?)\[\[([^\]|#]+)(#[^\]|]+)?(?:\|([^\]]+))?\]\]/g;

export interface WikiHooks {
  /** `![[x]]` → replacement HTML/markdown. */
  embed(target: string, anchor: string | undefined, alias: string | undefined): string;
  /** `[[x]]` → replacement markdown. */
  link(target: string, anchor: string | undefined, alias: string | undefined): string;
}

export function mdPreprocessMapped(body: string, hooks: WikiHooks): Preprocessed {
  const edits: Edit[] = [];
  let out = '';
  let last = 0;
  for (const m of body.matchAll(WIKI_RE)) {
    const at = m.index!;
    const [raw, bang, target, anchor, alias] = m;
    const next = bang
      ? hooks.embed(target, anchor, alias)
      : hooks.link(target, anchor, alias);
    out += body.slice(last, at) + next;
    edits.push({ at, oldLen: raw.length, newLen: next.length });
    last = at + raw.length;
  }
  out += body.slice(last);
  return { out, edits };
}

// ── offset mapping across those substitutions ──────────────────────────────
// We lex the PREPROCESSED text (that is what gets rendered, so DOM order and
// token order agree), but patches must land in the ORIGINAL file. This maps
// back, and refuses any span that overlaps a substitution — inside one, the
// source bytes are `[[Target]]` while the DOM says `Target`, so rule 4 could
// never hold anyway.
export interface Mapper {
  /** preprocessed offset → original offset, or null if inside a replacement. */
  toOriginal(p: number): number | null;
  /** is [s,e) entirely clear of every replacement? */
  spanClean(s: number, e: number): boolean;
}

export function makeMapper(edits: Edit[]): Mapper {
  // Each substitution's span in PREPROCESSED coords, plus the delta in force
  // after it (original + delta = preprocessed, for offsets past this region).
  const regions: { pStart: number; pEnd: number; deltaAfter: number }[] = [];
  let delta = 0;
  for (const ed of edits) {
    const pStart = ed.at + delta;
    delta += ed.newLen - ed.oldLen;
    regions.push({ pStart, pEnd: pStart + ed.newLen, deltaAfter: delta });
  }
  return {
    toOriginal(p) {
      let d = 0;
      for (const r of regions) {
        if (p < r.pStart) break;
        if (p < r.pEnd) return null;   // inside a replacement: no original bytes
        d = r.deltaAfter;
      }
      return p - d;
    },
    spanClean(s, e) {
      for (const r of regions) {
        if (r.pStart >= e) break;
        if (r.pEnd > s) return false;   // overlap
      }
      return true;
    },
  };
}

// ── the leaf walk ──────────────────────────────────────────────────────────
// Minimal shape of the marked tokens we consume, so this file needs no import.
export interface MdToken {
  type: string;
  raw: string;
  tokens?: MdToken[];
  items?: MdToken[];
}

interface Ctx {
  pp: string;
  map: Mapper;
  base: number;      // file offset of the body (frontmatter length)
  out: Leaf[];
  idx: Map<MdToken, number>;   // token identity → position among all text leaves
  block: number;               // index of the top-level token being walked
}

/**
 * Number every inline text token in document order, keyed by token IDENTITY.
 * Both the leaf walk and `signature` read positions out of this one map, so the
 * two never have to agree about traversal order — they agree about objects.
 */
function textLeafIndex(tokens: MdToken[]): Map<MdToken, number> {
  const m = new Map<MdToken, number>();
  let i = 0;
  const walk = (ts: MdToken[]) => {
    for (const t of ts) {
      if (t.type === 'text' && !t.tokens) m.set(t, i++);
      if (t.items) walk(t.items);
      if (t.tokens) walk(t.tokens);
    }
  };
  walk(tokens);
  return m;
}

/**
 * Every editable leaf in document order. `pp` is the preprocessed body, `base`
 * the body's offset within the file, `edits` the substitutions that produced pp.
 * Offsets in the result are FILE coordinates.
 */
export function editableLeaves(
  tokens: MdToken[], pp: string, edits: Edit[], base = 0,
): Leaf[] {
  const ctx: Ctx = {
    pp, map: makeMapper(edits), base, out: [], idx: textLeafIndex(tokens), block: 0,
  };
  let cur = 0;
  for (let bi = 0; bi < tokens.length; bi++) {
    const t = tokens[bi];
    ctx.block = bi;
    // Top-level raws concatenate to the whole body (`space` tokens carry their
    // newlines), so a mismatch means our model of marked is wrong — stop rather
    // than continue with offsets we can't trust.
    if (!pp.startsWith(t.raw, cur)) break;
    walkBlock(t, cur, ctx);
    cur += t.raw.length;
  }
  return ctx.out;
}

function walkBlock(tok: MdToken, start: number, ctx: Ctx): void {
  switch (tok.type) {
    case 'paragraph':
      inlineAfterPrefix(tok, start, PARA_RE, ctx);
      return;
    case 'heading':
      inlineAfterPrefix(tok, start, ATX_RE, ctx);
      return;
    case 'list': {
      let c = start;
      for (const item of tok.items || []) {
        if (!ctx.pp.startsWith(item.raw, c)) return;
        const m = item.raw.match(LI_RE);
        let ic = c + (m ? m[0].length : 0);
        // A tight list item's content is a BLOCK-level `text` token that carries
        // its own inline children (distinguishable from an inline text token by
        // exactly that: `.tokens` is present).
        for (const child of item.tokens || []) {
          if (!ctx.pp.startsWith(child.raw, ic)) break;
          if (child.type === 'text' && child.tokens) inlineWalk(child.tokens, ic, ctx);
          else if (child.type === 'paragraph') inlineAfterPrefix(child, ic, PARA_RE, ctx);
          ic += child.raw.length;
        }
        c += item.raw.length;
      }
      return;
    }
    // Not modelled in v1, so not editable:
    //  blockquote — marked strips the `> ` markers from the inner tokens' raw,
    //    so inner offsets cannot be derived by accumulation at all
    //  code/html — content is verbatim or markup, not prose
    //  table — cells would need their own span model
    //  def/hr/space — nothing to edit
    default:
      return;
  }
}

// Walk a block's inline children, given the block's start and the regex for the
// syntax that precedes its content (`## `, a list marker, leading indent).
function inlineAfterPrefix(tok: MdToken, start: number, prefix: RegExp, ctx: Ctx): void {
  if (!tok.tokens || !tok.tokens.length) return;
  const m = tok.raw.match(prefix);
  inlineWalk(tok.tokens, start + (m ? m[0].length : 0), ctx);
}

// Emphasis wrappers we walk INTO. Their delimiters sit outside the child text
// token's span, so patching the child never touches a marker: for `**personal**`
// the child raw is `personal` and its offset is the token start plus the marker
// run. Measured against a real 994-file vault, this lifts editable prose from
// 84.0% to 93.8%; of 18,913 inner spans, 18,869 verify byte-exactly and the 44
// that don't simply stay read-only (rule 3 rejects them).
//
// Links are NOT in this set. A link's child text is its LABEL, and the label's
// span is followed by `](url)` — editable in principle, but a label edit is far
// more likely to be an attempt to change the target, so it stays read-only until
// there is a reason to revisit.
const EMPHASIS = new Set(['em', 'strong', 'del']);
// The delimiter run opening an emphasis token: `**` / `__` / `*` / `_` / `~~`.
const MARKER_RE = /^[*_~]+/;

function inlineWalk(inline: MdToken[], start: number, ctx: Ctx): void {
  let c = start;
  for (const it of inline) {
    const s = c, e = c + it.raw.length;
    // rule 3: the span must be byte-exact. One mismatch and every offset after
    // it in this block is suspect, so abandon the block.
    if (ctx.pp.slice(s, e) !== it.raw) return;
    if (it.type === 'text' && !it.tokens) {
      consider(s, e, it, ctx);
    } else if (EMPHASIS.has(it.type) && it.tokens) {
      // Walk one level in, past the opening delimiter. inlineWalk's own rule-3
      // check re-verifies every child span, so a marker we mis-measure costs the
      // child its editability rather than mapping it to the wrong bytes.
      const m = it.raw.match(MARKER_RE);
      if (m) inlineWalk(it.tokens, s + m[0].length, ctx);
    }
    c = e;
  }
}

function consider(s: number, e: number, tok: MdToken, ctx: Ctx): void {
  const raw = tok.raw;
  if (!raw.length) return;
  if (ENTITY_RE.test(raw)) return;             // rule 4
  if (!ctx.map.spanClean(s, e)) return;        // overlaps a wikilink/embed rewrite
  const o = ctx.map.toOriginal(s);
  if (o === null) return;
  const index = ctx.idx.get(tok);
  if (index === undefined) return;             // defensive: not in the canonical walk
  ctx.out.push({
    start: ctx.base + o, end: ctx.base + o + raw.length, text: raw, index,
    block: ctx.block,
  });
}

// ── patching ───────────────────────────────────────────────────────────────

/**
 * The smallest edit turning `old` into `next`: trim the common prefix and
 * suffix. Returns null when they are identical. Offsets are relative to `old`.
 *
 * This is why a reworded sentence inside a hard-wrapped paragraph patches only
 * the words that changed — the newlines and the untouched clauses around it are
 * never rewritten.
 */
export function minimalPatch(
  old: string, next: string,
): { at: number; delLen: number; ins: string } | null {
  if (old === next) return null;
  let a = 0;
  const maxA = Math.min(old.length, next.length);
  while (a < maxA && old[a] === next[a]) a++;
  let b = 0;
  const maxB = Math.min(old.length - a, next.length - a);
  while (b < maxB && old[old.length - 1 - b] === next[next.length - 1 - b]) b++;
  return { at: a, delLen: old.length - a - b, ins: next.slice(a, next.length - b) };
}

export function splice(src: string, start: number, end: number, ins: string): string {
  return src.slice(0, start) + ins + src.slice(end);
}

export interface LeafEdit { leaf: Leaf; next: string }
export interface PatchResult {
  out: string;                 // the patched source
  indices: number[];           // leaf indices that actually changed
  spans: { start: number; end: number; ins: string }[];   // the patches, in file order
  reason?: string;             // set (with out === src) when nothing could be applied
}

/**
 * Apply several run edits to one source in a single pass.
 *
 * A whole paragraph is editable at once, so one commit can carry an edit to the
 * prose before a bold span AND inside it AND after it. Each run still gets its
 * own minimal patch, so the delimiters and everything untouched keep their bytes.
 *
 * Applied in DESCENDING order of position: an earlier patch would otherwise
 * shift every span after it. Every run is checked against the source it claims
 * to come from first — a stale run aborts the whole commit rather than landing
 * some edits and dropping others.
 */
export function patchLeaves(src: string, edits: LeafEdit[]): PatchResult {
  const real = edits.filter((e) => e.next !== e.leaf.text);
  if (!real.length) return { out: src, indices: [], spans: [] };
  for (const e of real) {
    if (src.slice(e.leaf.start, e.leaf.end) !== e.leaf.text) {
      return { out: src, indices: [], spans: [], reason: 'the file changed underneath this edit' };
    }
  }
  const ordered = real.slice().sort((a, b) => b.leaf.start - a.leaf.start);
  let out = src;
  const spans: PatchResult['spans'] = [];
  for (const e of ordered) {
    const p = minimalPatch(e.leaf.text, e.next);
    if (!p) continue;
    const start = e.leaf.start + p.at;
    out = splice(out, start, start + p.delLen, p.ins);
    spans.unshift({ start, end: start + p.delLen, ins: p.ins });
  }
  return { out, indices: real.map((e) => e.leaf.index), spans };
}

// ── source-level verification ──────────────────────────────────────────────
// A render-level check (compare text and tag structure) cannot see source-level
// loss: `[label][ref]` and `[label](url)` render identically and are materially
// different markdown. So we verify against the TOKEN STREAM instead.
//
// `signature` records the whole document EXCEPT the one leaf being edited: every
// other text leaf is pinned byte-for-byte, and every non-text token is pinned by
// type plus syntax. So the check is exact equality, and the permitted blast
// radius of an edit is literally one leaf.
//
// Pinning other leaves by their bytes (rather than their length) is what catches
// an equal-length change somewhere else in the document — a length-only pin
// silently accepts it.

/**
 * `skip` is the leaf index (or set of them) allowed to differ. A whole block can
 * be edited at once — several runs in one paragraph, each patched separately —
 * so this takes a set rather than a single index.
 */
export function signature(tokens: MdToken[], skip: number | Iterable<number> = -1): string {
  const skipSet = typeof skip === 'number' ? new Set([skip]) : new Set(skip);
  const parts: string[] = [];
  const idx = textLeafIndex(tokens);
  const walk = (ts: MdToken[], depth: number) => {
    for (const t of ts) {
      const kids = (t.tokens || t.items) as MdToken[] | undefined;
      if (t.type === 'text' && !t.tokens) {
        // Leaves under edit are the only things allowed to differ, so they go in
        // as placeholders. Every other leaf goes in verbatim.
        const i = idx.get(t);
        parts.push(i !== undefined && skipSet.has(i) ? `${depth}:text:*` : `${depth}:text:${t.raw}`);
      } else if (kids) {
        // A container's `raw` includes its children's text, so pinning it would
        // reject every legitimate reword. Pin the type plus the attributes that
        // carry its syntax instead; the children are walked below, and a change
        // to the container's own markers (`## ` → `### `, `-` → `1.`) shows up
        // there or as a type change.
        const a = t as unknown as Record<string, unknown>;
        const attrs = ['depth', 'ordered', 'start', 'task', 'checked', 'loose']
          .filter((k) => a[k] !== undefined)
          .map((k) => `${k}=${String(a[k])}`)
          .join(',');
        parts.push(`${depth}:${t.type}${attrs ? '(' + attrs + ')' : ''}`);
      } else {
        // A childless token IS its syntax (codespan, escape, br, html, code
        // fence, table, hr, def, space), so pin it byte-for-byte.
        parts.push(`${depth}:${t.type}:${t.raw}`);
      }
      if (t.items) walk(t.items, depth + 1);
      if (t.tokens) walk(t.tokens, depth + 1);
    }
  };
  walk(tokens, 0);
  return parts.join('\x1f');
}

export interface VerifyResult { ok: boolean; reason?: string }

/**
 * Would patching `leaf` to `next` change anything beyond that leaf's text?
 *
 * `lex` is the caller's lexer (app.ts passes marked's, the tests pass marked's
 * directly), applied to the already-preprocessed body so it sees what will
 * actually be rendered.
 */
export function verifyPatch(
  before: MdToken[], afterBody: string, leafIndex: number | Iterable<number>,
  next: string | string[],
  lex: (s: string) => MdToken[],
): VerifyResult {
  for (const s of (Array.isArray(next) ? next : [next])) {
    if (/\n[ \t]*\n/.test(s)) return { ok: false, reason: 'a blank line would split this block' };
    if (ENTITY_RE.test(s)) return { ok: false, reason: 'character references need the source editor' };
  }
  if (signature(before, leafIndex) === signature(lex(afterBody), leafIndex)) return { ok: true };
  return { ok: false, reason: 'that would change the document structure' };
}
