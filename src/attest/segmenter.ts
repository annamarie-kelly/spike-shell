// The deterministic segmenter - the heart of quote-by-construction.
//
// A model that types a quote will eventually type one that isn't in the source.
// Measured, not assumed: the generate-then-repair path this replaces capped at
// ~10% verbatim fidelity, prompt iteration moved mismatches 43 -> 32 -> 25 and
// then stalled, and a deterministic snap-repair recovered 3 of 37. The reason is
// structural - the model synthesizes a claim across several sources and wraps the
// synthesis in quotation marks, so there is no single source line to repair to.
//
// So the model is removed from the quote path entirely. Each source carries a
// stable id and a `detail` of verbatim text. segment() cuts that detail into
// addressable spans with stable ids `{source_id}@s{n}`. The model never types a
// quote; it emits a `{{q:span_id}}` reference and the harness substitutes the
// exact bytes (see quote-extract).
//
// Two hard invariants, both PURE (no model, no I/O) so they are unit-testable:
//   1. DETERMINISM  - same refs in same order -> identical span ids and text.
//   2. LOSSLESSNESS - the raw tiles of a detail concatenate back to the detail
//                     byte-for-byte. A span's quotable `text` is therefore always
//                     a verbatim substring of its source, by construction.
//
// Ported from tidemark-harness (src/pipeline/segmenter.ts), which proved this in
// production. Changes here: the manifest budget is a plain parameter rather than
// an env var, and SourceRef carries a content `hash` so a later run can tell that
// a source changed underneath a citation instead of silently resolving to
// different bytes.

/** A unit of evidence: a stable id plus a verbatim text body. */
export type SourceRef = {
  /** stable anchor, e.g. "folder:notes/acme.md" or "notion:page:xyz" */
  id: string;
  /** human label for the manifest, e.g. "acme.md" */
  label: string;
  /** VERBATIM source text. Spans are cut from this and nothing else. */
  detail: string;
  /** sha256 of `detail` - lets a later run detect the source changed. */
  hash?: string;
  /** exhaustive vs sampled (informational, passed through from the provider) */
  complete?: boolean;
  /** clickable source URL or file path when one exists. */
  url?: string;
  /**
   * When the source is DATED in the record (YYYY-MM-DD), carried from the provider.
   * A date must never be typed by the model - an invented date is the failure mode -
   * so it travels with the source and the harness places it. Absent when the record
   * carried no parsable date; absent is a claim of its own, never defaulted to today.
   */
  date?: string;
  /** who the record attributes the source to. PLACED, not typed, for the same reason. */
  actor?: string;
};

/** One addressable, quotable span of a source detail. */
export type Span = {
  /** stable id `{source_id}@s{n}` - the token the model references */
  span_id: string;
  source_id: string;
  label: string;
  /**
   * The quotable text: a verbatim substring of the source detail, with surrounding
   * quote marks and stray separators trimmed so wrapping it adds no doubled quotes.
   */
  text: string;
  /** offsets into the source detail [start, end) - exact addressability of `text` */
  start: number;
  end: number;
  url?: string;
  date?: string;
  actor?: string;
};

/** A raw tile of a detail. Tiles TILE the detail with no gaps or overlaps. */
type Tile = { start: number; end: number; raw: string; text: string };

export type SpanTable = Map<string, Span>;

// Separator between a source id and its span index. NOT "#": source ids may already
// contain "#" (e.g. "...#chunk_0"), so "@s" keeps the suffix unambiguous.
const SPAN_SEP = '@s';

const CLOSERS = new Set(['"', "'", ')', ']', '”', '’', '»']);

// Cap on a single span's length. Transcripts contain long, unpunctuated speaker
// turns; without a cap such a block becomes ONE giant span, so the only quotable
// unit is the whole blob - which re-creates the "quote a synthesis with no single
// line" ceiling this module exists to break. Any tile longer than this is sub-split
// at whitespace (offset-based, so still lossless).
export const MAX_SPAN_CHARS = 320;

/**
 * Where to split an over-cap run [start, end): the last whitespace at/under the cap
 * (keeps spans <= cap in normal prose), else the next whitespace PAST the cap (so we
 * never split mid-word), else -1 (a run with no whitespace at all is left whole).
 */
function nextCut(detail: string, start: number, end: number): number {
  for (let j = Math.min(start + MAX_SPAN_CHARS, end - 1); j > start; j--) {
    if (/\s/.test(detail[j])) return j + 1;
  }
  for (let j = start + MAX_SPAN_CHARS; j < end; j++) {
    if (/\s/.test(detail[j])) return j + 1;
  }
  return -1;
}

/**
 * Add intermediate cut points so no gap between consecutive cuts exceeds
 * MAX_SPAN_CHARS. Only ADDS cuts, so the tiling stays exact and lossless.
 */
function capLength(detail: string, sorted: number[]): number[] {
  const extra = new Set<number>();
  for (let k = 0; k + 1 < sorted.length; k++) {
    let start = sorted[k];
    const end = sorted[k + 1];
    while (end - start > MAX_SPAN_CHARS) {
      const cut = nextCut(detail, start, end);
      if (cut <= start || cut >= end) break; // unsplittable blob: leave as one span
      extra.add(cut);
      start = cut;
    }
  }
  return extra.size ? [...new Set([...sorted, ...extra])].sort((a, b) => a - b) : sorted;
}

/**
 * Index just past a sentence terminator (.!?) and any trailing closers at i, when it
 * is a real boundary (followed by whitespace or end-of-string); -1 otherwise.
 */
function sentenceBoundary(detail: string, i: number, n: number): number {
  const ch = detail[i];
  if (ch !== '.' && ch !== '!' && ch !== '?') return -1;
  if (ch === '.' && ABBREV.has(wordBefore(detail, i))) return -1;
  let j = i + 1;
  while (j < n && CLOSERS.has(detail[j])) j++;
  return j >= n || /\s/.test(detail[j]) ? j : -1;
}

// Titles and abbreviations whose period does not end a sentence. Without this, a
// transcript line `Dr. Chen: we hated the pricing` is cut after `Dr.`, so the span
// ending the PREVIOUS speaker's turn absorbs the start of the next speaker's name and
// the quote reads as if one person said both. Byte-verbatim, and a misattribution,
// which is the failure this pipeline exists to foreclose.
const ABBREV = new Set([
  'dr', 'mr', 'mrs', 'ms', 'mx', 'prof', 'sr', 'jr', 'st', 'rev', 'hon',
  'inc', 'ltd', 'llc', 'co', 'corp', 'dept', 'est', 'approx', 'no', 'vs',
  'eg', 'ie', 'etc', 'al', 'fig', 'vol', 'pp', 'ca', 'cf',
]);

/** The word immediately before the period at `i`, lowercased, interior dots stripped. */
function wordBefore(detail: string, i: number): string {
  let k = i - 1;
  while (k >= 0 && /[A-Za-z.]/.test(detail[k])) k--;
  return detail.slice(k + 1, i).replace(/\./g, '').toLowerCase();
}

// Structure that means a newline is a REAL boundary: a heading, list item, blockquote,
// table row, fence, rule, a `key:` line (YAML front matter, `**Label**:` fields), or a
// speaker attribution.
//
// The speaker class must admit periods and apostrophes. `[A-Za-z][\w -]{0,30}:` rejects
// `Dr. Chen:` and `O'Brien:`, so a genuine turn boundary reads as a soft wrap and two
// speakers merge into one quotable span - the report then shows one person saying both
// things. A comma is admitted too, for `Dana Okafor, CFO:`.
const STRUCTURAL_LINE =
  /^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||```|~~~|---|\*\*|[A-Za-z][\w.,'’ -]{0,40}:\s)/;

/**
 * Is the newline at `i` a hard break, or a soft wrap inside a paragraph?
 *
 * The upstream harness cut at every newline, which is right for its corpus - API-fetched
 * transcripts, where a newline is always a speaker turn or a record boundary. It is wrong
 * for files a human wrapped at 80 columns: it splits single sentences into fragments, so
 * the model can only quote half a thought. Measured on a real folder, that produced
 * quotes like `Passed because the pitch led with a data moat the` - verbatim, and useless.
 *
 * A newline is hard when the line it ends actually finished something: a blank line
 * follows, the text before it ended a sentence or a clause-ending colon, or the next line
 * opens with markdown structure. Otherwise it is a soft wrap and the sentence continues.
 *
 * This only ever REMOVES cut points, so losslessness is untouched - the tiling still
 * reconstructs the source byte-for-byte, with coarser spans.
 */
function isHardBreak(detail: string, i: number): boolean {
  const n = detail.length;
  if (i + 1 >= n) return true;
  if (detail[i + 1] === '\n' || detail[i + 1] === '\r') return true; // paragraph break

  // What the ending line finished with, ignoring trailing spaces and closers.
  let k = i - 1;
  while (k >= 0 && (detail[k] === ' ' || detail[k] === '\t' || detail[k] === '\r')) k--;
  while (k >= 0 && CLOSERS.has(detail[k])) k--;
  if (k < 0) return true; // the line was blank
  const last = detail[k];
  if (last === '.' || last === '!' || last === '?' || last === ':' || last === ';') return true;

  const nextLine = detail.slice(i + 1, detail.indexOf('\n', i + 1) === -1 ? n : detail.indexOf('\n', i + 1));
  return STRUCTURAL_LINE.test(nextLine);
}

/**
 * Cut a detail into tiles that TILE it exactly: every character belongs to exactly
 * one tile, and the tiles in order reconstruct the detail byte-for-byte. Cuts land
 * after a HARD newline (see isHardBreak), after a sentence terminator plus any
 * trailing closers when followed by whitespace or end-of-string, and wherever a tile
 * would otherwise exceed MAX_SPAN_CHARS.
 *
 * Cutting is offset-based, so losslessness holds regardless of WHERE we cut - the
 * boundary rules affect span granularity, never fidelity.
 */
function tile(detail: string): Tile[] {
  const n = detail.length;
  const cuts = new Set<number>([0, n]);
  for (let i = 0; i < n; i++) {
    if (detail[i] === '\n') {
      if (isHardBreak(detail, i)) cuts.add(i + 1);
      continue;
    }
    const b = sentenceBoundary(detail, i, n);
    if (b >= 0) cuts.add(b);
  }
  const ordered = capLength(detail, [...cuts].sort((a, b) => a - b));
  const tiles: Tile[] = [];
  for (let k = 0; k + 1 < ordered.length; k++) {
    const start = ordered[k];
    const end = ordered[k + 1];
    if (end <= start) continue;
    const raw = detail.slice(start, end);
    tiles.push({ start, end, raw, text: raw.trim() });
  }
  return tiles;
}

const EDGE_SEP = /[\s,;]/; // whitespace + stray separators, always trimmable from edges
const EDGE_QUOTE = /["“”'‘’]/;

// A leading markdown list marker (bullet `* + -` or ordered `1. 2)`) followed by
// whitespace OR forming the whole tile. Stripped for PRESENTATION so a quoted bullet
// line reads as clean verbatim prose instead of carrying a stray "* " into the output.
//
// CRITICAL: only safe when the tile begins a real LINE (offset 0 or right after a
// newline). A real list marker is always line-initial. A digit+period is NOT: the
// sentence-boundary tiler isolates a mid-sentence figure like "2024." onto its own
// tile, and stripping that would silently delete source content. The caller passes
// `atLineStart` so we never strip a sentence-content collision.
//
// Applied to the cleaned span `text` only; raw tiles are untouched, so losslessness
// (defined over raw) holds, and offsets stay exact because the strip advances `lead`.
const LIST_MARKER = /^([*+-]|\d+[.)])(\s+|$)/;

// A leading BOLD field label - the structural header of a note field, e.g.
// `**Overview**:`. It is the source document's own scaffolding, not prose someone
// wrote, so a span beginning with one reads as a pasted form field rather than a
// sentence. Stripped for PRESENTATION, under the same `atLineStart` guard.
//
// CRITICAL - why BOLD only. Transcript evidence is full of `Speaker: text`
// attributions, and those are never bold. Stripping an unbolded `Label:` would
// silently delete the speaker from a quote and misattribute it, which is the one
// failure this whole pipeline exists to foreclose. The `**` delimiters make it
// unambiguously markdown structure. The label body is capped at 40 chars and forbids
// `*` and newlines so an italic/bold run inside real prose cannot masquerade as a
// field header.
const FIELD_LABEL = /^\*\*[^*\n]{1,40}\*\*\s*:\s*/;

/**
 * Trim a span's edges so wrapping it for display never produces doubled or unbalanced
 * quotes, WITHOUT corrupting interior content. Always trims surrounding whitespace and
 * stray separators, then strips at most ONE balanced surrounding quote pair. A lone
 * edge quote is LEFT in place - it pairs with an interior quote (e.g.
 * `he called it "the category leader"`), and stripping it would drop a real nested
 * quotation mark. A leading list marker and bold field label are also stripped (only
 * when `atLineStart`), both before AND after the quote-pair strip so `* "quote"` and
 * `"* quote"` both shed the marker. Offsets stay exact via `lead`.
 */
function cleanEdges(raw: string, atLineStart: boolean): { text: string; lead: number } {
  let start = 0;
  let end = raw.length;
  const trimSep = () => {
    while (start < end && EDGE_SEP.test(raw[start])) start++;
    while (end > start && EDGE_SEP.test(raw[end - 1])) end--;
  };
  const stripMarker = () => {
    if (!atLineStart) return;
    // A bullet can precede a field label (`- **Financials**: $4.8M ARR`), so try both,
    // in document order, and re-trim between them.
    for (const pattern of [LIST_MARKER, FIELD_LABEL]) {
      const marker = pattern.exec(raw.slice(start, end));
      if (marker && marker[0].length > 0) {
        start += marker[0].length;
        trimSep();
      }
    }
  };
  trimSep();
  stripMarker();
  if (end - start >= 2 && EDGE_QUOTE.test(raw[start]) && EDGE_QUOTE.test(raw[end - 1])) {
    start++;
    end--;
    trimSep();
    stripMarker();
  }
  return { text: raw.slice(start, end), lead: start };
}

/**
 * Build the span table for a set of sources. Span ids are dense per source
 * (@s0, @s1, ...) and assigned only to tiles with non-empty quotable text after edge
 * cleaning, so a whitespace- or punctuation-only tile is never quotable. PURE and
 * DETERMINISTIC. Offsets are recomputed to the cleaned text so they stay exact.
 *
 * Returns the table plus `order` (span ids in document order) for rendering.
 */
export function buildSpanTable(refs: SourceRef[]): { table: SpanTable; order: string[] } {
  const table: SpanTable = new Map();
  const order: string[] = [];
  for (const ref of refs) {
    // The renderer marks its own citations with U+E000 so it never rewrites bytes that
    // came from a source. A source containing one could forge that mark, so it is refused
    // rather than stripped - stripping would break byte-exactness to fix a forgery.
    if (ref.detail.includes('\uE000')) {
      throw new Error(
        `${ref.id} contains U+E000, which the renderer reserves. Refusing rather than ` +
          'altering the source bytes.',
      );
    }
    let n = 0;
    for (const t of tile(ref.detail)) {
      // A list marker is only stripped on a real line start (offset 0 or just after a
      // newline). This keeps the strip off mid-sentence figures the tiler splits off.
      const atLineStart = t.start === 0 || ref.detail[t.start - 1] === '\n';
      const { text, lead } = cleanEdges(t.raw, atLineStart);
      // A quotable span must carry actual content - skip empty or punctuation-only tiles.
      if (!/[\p{L}\p{N}]/u.test(text)) continue;
      const span_id = `${ref.id}${SPAN_SEP}${n}`;
      n += 1;
      const start = t.start + lead;
      table.set(span_id, {
        span_id,
        source_id: ref.id,
        label: ref.label,
        text,
        start,
        end: start + text.length,
        url: ref.url,
        date: ref.date,
        actor: ref.actor,
      });
      order.push(span_id);
    }
  }
  return { table, order };
}

/**
 * Prove the tiling is lossless for a detail: the raw tiles concatenate back to it.
 * This is the invariant the whole guarantee rests on, so it is exported and asserted
 * rather than assumed.
 */
export function isLossless(detail: string): boolean {
  return (
    tile(detail)
      .map((t) => t.raw)
      .join('') === detail
  );
}

/**
 * Verify a span still addresses the bytes it claims to. `buildSpanTable` guarantees
 * this at build time; this re-checks it against a source detail read later, which is
 * how a changed source is caught rather than silently re-resolved.
 */
export function spanResolves(span: Span, detail: string): boolean {
  return detail.slice(span.start, span.end) === span.text;
}

/**
 * Total verbatim span text the manifest will emit.
 *
 * This is an ATTENTION budget, not a context limit: past some size the prompt hits
 * the lost-in-the-middle band where mid-manifest spans get ignored. Spans past it are
 * OMITTED with an explicit disclosure, never silently dropped - a truncated run must
 * not look identical to a complete one.
 *
 * The upstream harness swept this against a real corpus and landed on 1.4M chars for a
 * 1M-token model. That number is load-bearing on ITS corpus and model, and it is NOT
 * available to us: both adapters pass the prompt as an argv value, and macOS ARG_MAX is
 * 1,048,576 bytes for the whole argument list. At 1.4M the manifest stayed under budget -
 * so the omission disclosure never fired - and exec failed with a bare "Argument list too
 * long" that says nothing about corpus size. A quarter of call notes is enough to hit it.
 *
 * 400k leaves generous room for the schema, the flags and the environment, and a corpus
 * past it now truncates loudly instead of failing opaquely. Raising this means moving the
 * prompt off argv first (stdin), not just changing the number.
 */
export const MANIFEST_CHAR_BUDGET = 400_000;

/** Group spans by source, preserving first-seen source order. */
function groupBySource(
  table: SpanTable,
  order: string[],
): { bySource: Map<string, Span[]>; sourceOrder: string[] } {
  const bySource = new Map<string, Span[]>();
  const sourceOrder: string[] = [];
  for (const id of order) {
    const s = table.get(id)!;
    if (!bySource.has(s.source_id)) {
      bySource.set(s.source_id, []);
      sourceOrder.push(s.source_id);
    }
    bySource.get(s.source_id)!.push(s);
  }
  return { bySource, sourceOrder };
}

/**
 * Fair round-robin selection within the budget: take span[k] from each source in turn
 * so one long early source cannot starve the others. Returns the selected span ids and
 * how many were omitted.
 */
function selectWithinBudget(
  bySource: Map<string, Span[]>,
  sourceOrder: string[],
  budget: number,
): { selected: Set<string>; omitted: number } {
  const selected = new Set<string>();
  let used = 0;
  let omitted = 0;
  const maxLen = Math.max(0, ...sourceOrder.map((sid) => bySource.get(sid)!.length));
  for (let k = 0; k < maxLen; k++) {
    for (const sid of sourceOrder) {
      const s = bySource.get(sid)![k];
      if (!s) continue;
      if (used + s.text.length > budget) {
        omitted += 1;
        continue;
      }
      used += s.text.length;
      selected.add(s.span_id);
    }
  }
  return { selected, omitted };
}

/**
 * Render the evidence the model sees: each source, its quotable spans with id and
 * verbatim text, up to `budget` chars.
 *
 * Returns the manifest text, `includedIds` - the spans actually shown, so the caller
 * can restrict the gate surface to exactly what the model saw (a span the model never
 * read must not be quotable) - and `omitted`, the count dropped for budget. Callers
 * MUST surface a non-zero `omitted`: the disclosure line below is inside the manifest,
 * which only the model reads.
 */
export function renderEvidenceManifest(
  refs: SourceRef[],
  table: SpanTable,
  order: string[],
  budget: number = MANIFEST_CHAR_BUDGET,
): { manifest: string; includedIds: string[]; omitted: number } {
  const { bySource, sourceOrder } = groupBySource(table, order);
  const { selected, omitted } = selectWithinBudget(bySource, sourceOrder, budget);

  const lines: string[] = [
    '## Evidence (the ONLY sources you have)',
    'To QUOTE any of this, do NOT retype it. Insert a reference token `{{q:SPAN_ID}}` where',
    'the quote should go; the harness substitutes the exact source text. You may paraphrase',
    'in your own words WITHOUT quotation marks. Any quotation mark you type yourself fails the run.',
    '',
  ];
  const includedIds: string[] = [];
  for (const ref of refs) {
    const flag = ref.complete === false ? ' (SAMPLED)' : ref.complete === true ? ' (complete)' : '';
    lines.push(`### ${ref.label} [${ref.id}]${flag}`);
    for (const s of bySource.get(ref.id) ?? []) {
      if (!selected.has(s.span_id)) continue;
      // One line per span, always. Span text can now contain newlines (a span may cross
      // a soft wrap in the source), and a multi-line entry breaks the manifest's only
      // structural cue: continuation lines carry no span id, so the model cannot tell
      // where a span ends, and unattributed lines of source text are exactly what the
      // header above tells it to paraphrase from.
      //
      // Collapsing whitespace HERE is safe and is not a weakening of the guarantee: the
      // manifest is a menu the model reads to choose a span, while the bytes placed in
      // the answer are taken from the table, not from this string.
      lines.push(`- {{q:${s.span_id}}}  ${s.text.replace(/\s*\n\s*/g, ' ')}`);
      includedIds.push(s.span_id);
    }
    lines.push('');
  }
  if (omitted) {
    lines.push(
      `_(${omitted} span(s) omitted - manifest char budget ${budget} reached; narrow the sources for full coverage.)_`,
    );
  }
  return { manifest: lines.join('\n'), includedIds, omitted };
}
