// The deterministic verbatim gate - closed-surface enforcement.
//
// Runs after renderQuotes(). It does NOT score similarity or repair anything: by
// construction there is nothing to repair. It enforces facts a model cannot influence,
// which is the whole point - a check that needs a model to judge it is a hint, not a
// gate.
//
//   1. CLOSED SURFACE  - the model's RAW output contains zero quotation marks. It is
//      told to quote only via `{{q:span_id}}` tokens, which contain none. Any literal
//      " “ ” it typed is a free-typed quote and fails the run. (Quotes inside a span's
//      source text appear only AFTER substitution, so they never trip this.)
//   2. NO INVENTED IDS - every referenced span id resolved to a real span.
//   3. FETCHED SOURCE  - every placed span belongs to a source this run actually read.
//
// The byte-exact check the upstream harness once had was dropped there as a tautology:
// renderQuotes sources the placed text FROM the span table, so it cannot differ. The
// real protection is the closed surface plus the fetched-source check, and renderQuotes
// is the single point that must keep placement byte-exact.
//
// Ported from tidemark-harness (src/gates/quote-gate.ts).

import { type RenderResult, renderQuotes } from './quote-extract';
import type { SpanTable } from './segmenter';

// Unambiguous quotation characters: ANY occurrence in the raw output is a free-typed
// quote breach.
const HARD_QUOTE_MARKS = /["“”`«»‹›„‚]/g;

// Single quotes are ambiguous (don't, Acme's), so we flag only a single-quoted SPAN:
// an opening quote after start/space/open-bracket, content, then a closing quote before
// whitespace or closing punctuation. Content is `[^\n]+?` (lazy, any non-newline) so an
// INTERNAL apostrophe - the contraction in `'we don't see a moat'` - does not terminate
// the span: it fails the closing lookahead and the match extends to the real closing
// quote. Contractions and possessives outside a span are untouched because their
// apostrophe is preceded by a letter, so it never opens a span.
const SINGLE_QUOTE_SPAN = /(^|[\s([])['‘’][^\n]+?['‘’](?=$|[\s).,;:!?\]])/g;

/** Count free-typed quote breaches in the raw output (hard marks + single-quoted spans). */
export function countStrayQuotes(rawOutput: string): number {
  const hard = (rawOutput.match(HARD_QUOTE_MARKS) ?? []).length;
  const singleSpans = (rawOutput.match(SINGLE_QUOTE_SPAN) ?? []).length;
  return hard + singleSpans;
}

export type QuoteVerdict = {
  /** overall: integrity AND at least one verbatim quote actually placed */
  pass: boolean;
  /** quote INTEGRITY (no breaches), independent of how many quotes were placed */
  verified: boolean;
  /** false when zero verbatim quotes were placed - a run that grounded nothing */
  grounded: boolean;
  matched: number;
  total: number;
  /** literal quotation marks found in the raw output (closed-surface breaches) */
  strayQuotes: number;
  /** referenced span ids that did not resolve */
  missing: string[];
  /** placed spans whose source was never fetched this run */
  drifted: string[];
  render: RenderResult;
  summary: string;
};

/**
 * @param rawOutput      the model's output BEFORE substitution (carries the tokens)
 * @param table          the span table the tokens reference
 * @param fetchedSources optional: source ids actually read this run. When given, a
 *                       placed span whose source was never fetched fails too - defense
 *                       in depth behind the closed tool surface.
 */
export function gateQuotes(
  rawOutput: string,
  table: SpanTable,
  fetchedSources?: Set<string>,
): QuoteVerdict {
  const render = renderQuotes(rawOutput, table);

  const strayQuotes = countStrayQuotes(rawOutput);

  // Every placed reference - quoted or merely cited - must belong to a source this run
  // actually read. A cite places no text, but it still makes a provenance claim to the
  // reader, so it is held to the same standard.
  const drifted: string[] = [];
  for (const span_id of [...render.used.map((h) => h.span_id), ...render.cited]) {
    const span = table.get(span_id);
    if (!span) drifted.push(span_id);
    else if (fetchedSources && !fetchedSources.has(span.source_id)) drifted.push(span_id);
  }

  // total/matched count VERBATIM placements only. A cite attributes but places no source
  // bytes, so counting it here would let a run that quoted nothing report a verbatim
  // score - the precise false green this gate exists to prevent.
  const total = render.used.length + render.missing.length;
  const driftedQuotes = drifted.filter((id) => render.used.some((h) => h.span_id === id)).length;
  const matched = render.used.length - driftedQuotes;
  const verified = strayQuotes === 0 && render.missing.length === 0 && drifted.length === 0;
  // A verdict that placed ZERO verbatim quotes grounded nothing, so it must not read as
  // a clean pass even when the integrity checks find no breach.
  const grounded = matched > 0;
  const pass = verified && grounded;

  const parts: string[] = [];
  if (strayQuotes) parts.push(`${strayQuotes} free-typed quote(s)`);
  if (render.missing.length)
    parts.push(`${render.missing.length} invented span id(s): ${render.missing.join(', ')}`);
  if (drifted.length) parts.push(`${drifted.length} unfetched span(s): ${drifted.join(', ')}`);

  const summary = !verified
    ? `FAILED - ${parts.join('; ')}.`
    : grounded
      ? `VERBATIM - ${matched}/${total} quotes placed by construction; surface closed.`
      : `NO QUOTES PLACED - surface clean, but the answer grounded nothing verbatim (0/${total}).`;

  return {
    pass,
    verified,
    grounded,
    matched,
    total,
    strayQuotes,
    missing: render.missing,
    drifted,
    render,
    summary,
  };
}

/**
 * Gate a set of fields INDEPENDENTLY and return both the merged verdict and the exact
 * strings the reader will see.
 *
 * Gating a newline-joined concatenation of the fields is not the same thing, and the
 * difference is a false green. QUOTE_TOKEN's `[^}]+` crosses newlines, so a token split
 * across two fields resolves in the joined string and in neither field on its own:
 * headline `Pricing killed it {{q:doc@s0` plus body `}} and we churned.` gates as
 * `1/1 quotes placed`, while the printed report contains no quote at all and a raw
 * fragment of a token. Gating each field on its own makes that impossible, and returning
 * the rendered fields means the verdict is a receipt for the document that is printed
 * rather than for a string nobody reads.
 */
export function gateFields(
  fields: string[],
  table: SpanTable,
  fetchedSources?: Set<string>,
): { verdict: QuoteVerdict; rendered: string[] } {
  const perField = fields.map((f) => gateQuotes(f ?? '', table, fetchedSources));

  const used = perField.flatMap((v) => v.render.used);
  const cited = perField.flatMap((v) => v.render.cited);
  const missing = perField.flatMap((v) => v.missing);
  const drifted = perField.flatMap((v) => v.drifted);
  const strayQuotes = perField.reduce((n, v) => n + v.strayQuotes, 0);

  const total = used.length + missing.length;
  const driftedQuotes = drifted.filter((id) => used.some((h) => h.span_id === id)).length;
  const matched = used.length - driftedQuotes;
  const verified = strayQuotes === 0 && missing.length === 0 && drifted.length === 0;
  const grounded = matched > 0;
  const pass = verified && grounded;

  const parts: string[] = [];
  if (strayQuotes) parts.push(`${strayQuotes} free-typed quote(s)`);
  if (missing.length) parts.push(`${missing.length} invented span id(s): ${missing.join(', ')}`);
  if (drifted.length) parts.push(`${drifted.length} unfetched span(s): ${drifted.join(', ')}`);

  const summary = !verified
    ? `FAILED - ${parts.join('; ')}.`
    : grounded
      ? `VERBATIM - ${matched}/${total} quotes placed by construction; surface closed.`
      : `NO QUOTES PLACED - surface clean, but the answer grounded nothing verbatim (0/${total}).`;

  return {
    verdict: {
      pass,
      verified,
      grounded,
      matched,
      total,
      strayQuotes,
      missing,
      drifted,
      render: { rendered: '', used, cited, missing },
      summary,
    },
    rendered: perField.map((v) => v.render.rendered),
  };
}
