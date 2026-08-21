// Extraction by lookup, placement by SUBSTITUTION - never by the model.
//
// renderQuotes() replaces every `{{q:span_id}}` reference the model emitted with the
// span's exact bytes. The quoted characters in the final answer come from the span
// table, not from anything the model typed. That is the whole by-construction
// guarantee: a quote that was never fetched as a span cannot appear, and a fetched
// quote cannot be altered.
//
// Ported from tidemark-harness (src/pipeline/quote-extract.ts).

import type { SpanTable } from './segmenter';

// Two reference tokens, because a claim and its evidence want different things.
//
//   {{q:id}} - QUOTE. Substituted with the span's verbatim bytes plus a citation.
//   {{c:id}} - CITE.  Substituted with the citation alone, no text.
//
// The distinction is not cosmetic; it came out of a real run. With only {{q:}}, a rule
// requiring every figure to carry a citation forces tokens into the prose, and each one
// splices a whole quote mid-sentence - then repeats it in the evidence block below:
//
//   Annual recurring revenue reached $12.4M “ARR closed Q3 at $12.4M, up from $9.1M a
//   year ago.” [q3-call.md@s3] in Q3, up from $9.1M “ARR closed Q3 at $12.4M, up from…
//
// Verbatim, and unreadable. A cite gives a figure its receipt in place without turning
// the sentence into a quotation. Both tokens resolve against the same span table and
// both fail the same way on an invented id, so the guarantee is identical - a cite
// simply places no text.
export const QUOTE_TOKEN = /\{\{q:([^}]+)\}\}/g;

/**
 * Marks a citation this module emitted, so a later pass can rewrite ours and never the
 * source's. Without it, a source that itself contains `see [folder:q3.md@s4]` had that
 * fragment rewritten into a footnote marker inside its own blockquote - the displayed
 * quote no longer byte-identical to the source, under a receipt reading VERBATIM.
 *
 * U+E000 is a private-use codepoint with no meaning in text. buildSpanTable refuses a
 * source that contains one, so it cannot be injected.
 */
export const CITE_MARK = '\uE000';
export const CITE_TOKEN = /\{\{c:([^}]+)\}\}/g;

/** Either token, for callers that only need to know a reference is present. */
export const ANY_TOKEN = /\{\{[qc]:([^}]+)\}\}/g;

export type QuoteHit = { span_id: string; text: string };

/**
 * Pure lookup. Kept exported because it is the one operation an audit tool would
 * expose to the model ("show me this span's text") without weakening the guarantee -
 * an unknown span returns an explicit miss, never a guess.
 */
export function quoteLookup(table: SpanTable, span_id: string): string | null {
  const span = table.get(span_id.trim());
  return span ? span.text : null;
}

export type RenderResult = {
  /** the answer with every valid token substituted */
  rendered: string;
  /** spans placed VERBATIM via `{{q:}}` (the gate's matched/total count) */
  used: QuoteHit[];
  /** spans referenced via `{{c:}}` - attributed, but no text placed */
  cited: string[];
  /** referenced span ids that do not exist in the table (hard error, either token) */
  missing: string[];
};

/**
 * The trace citation for a placed span. With a URL the span id renders as a clickable
 * link; without one the bare span id is shown - it still pinpoints the source and,
 * via the span's char offsets, the exact location inside it.
 */
function citation(span: { span_id: string; url?: string }): string {
  const body = span.url ? `[${span.span_id}](${span.url})` : `[${span.span_id}]`;
  return `${CITE_MARK}${body}${CITE_MARK}`;
}

/**
 * Substitute every `{{q:span_id}}` token with the span's exact text (already edge-
 * cleaned in buildSpanTable, so a single wrap adds no doubled quotes) plus its trace
 * citation. A token whose span id is unknown is left visible as `[[MISSING QUOTE: id]]`
 * and reported in `missing` so the gate fails the run - a model cannot invent a span id
 * and have it quietly disappear.
 */
export function renderQuotes(output: string, table: SpanTable): RenderResult {
  const used: QuoteHit[] = [];
  const cited: string[] = [];
  const missing: string[] = [];

  // Cites first. Order matters only because both patterns are global regexes over the
  // same string; each pass rewrites its own token kind and leaves the other untouched.
  const withCites = output.replace(CITE_TOKEN, (_m, rawId: string) => {
    const span_id = String(rawId).trim();
    const span = table.get(span_id);
    if (!span) {
      missing.push(span_id);
      return `[[MISSING CITE: ${span_id}]]`;
    }
    cited.push(span_id);
    return citation(span);
  });

  const rendered = withCites.replace(QUOTE_TOKEN, (_m, rawId: string) => {
    const span_id = String(rawId).trim();
    const span = table.get(span_id);
    if (!span) {
      missing.push(span_id);
      return `[[MISSING QUOTE: ${span_id}]]`;
    }
    used.push({ span_id, text: span.text });
    // Curly outer quotes delimit the verbatim span. Curly rather than straight means a
    // span whose text itself contains a straight double quote (a nested quotation)
    // renders cleanly, with no doubled marks.
    return `“${span.text}” ${citation(span)}`;
  });

  return { rendered, used, cited, missing };
}
