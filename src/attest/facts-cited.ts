// The check the quote gate structurally cannot make.
//
// Quote-by-construction guarantees that anything *in quotation marks* is real. It says
// nothing about a number the model states in its own voice: "ARR grew to $4.8M last
// year" carries no quotation marks, so the closed-surface gate passes it, and if the
// figure was invented nothing catches it.
//
// So: find quantitative claims - currency, percentages, years, grouped numbers - and
// require a citation token later in the same sentence AND the same line. Deterministic,
// no model, and it flags rather than judges. An uncited figure is not necessarily
// wrong; it is unattributed, which is a different and checkable thing.
//
// Ported from the Python `coverage_check` in tidemark-backend
// (sonar_mcp/harness/traceability.py), adapted to this harness's `{{q:}}` token.

/**
 * A quantitative signal worth attributing.
 *   $4.8M / $1,200 / $0.5b   - currency, optional magnitude suffix
 *   12% / 3.5 %              - percentage
 *   1,200 / 10,000,000       - grouped number
 *   1998 / 2026              - a bare 4-digit year
 *
 * Deliberately narrow. It does not fire on every integer: "3 customers" is a claim, but
 * flagging every small number produces noise that trains people to ignore the check.
 */
const FACT_SIGNAL = new RegExp(
  [
    '\\$\\s?\\d[\\d,]*(?:\\.\\d+)?\\s?[kKmMbBtT]?\\b', // $4.8M, $1,200
    '\\d[\\d,]*(?:\\.\\d+)?\\s?%', // 12%, 3.5 %
    '\\d[\\d,]*(?:\\.\\d+)?\\s*(?:million|billion|trillion|thousand|percent|bps)\\b', // 4.8 million, 30 percent
    '\\d[\\d,]*(?:\\.\\d+)?\\s?[kKmMbB]\\b', // 4.8M, 30k
    '\\d+(?:\\.\\d+)?x\\b', // 3x
    '\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?', // 1,200
    '\\d{4,}', // 2024, 4800000
  ].join('|'),
  'gi',
);

/**
 * A figure inside a reference token is not a claim. Source ids are derived from
 * filenames, and dated filenames are the common case, so `{{q:folder:2026-06-20-acme.md@s3}}`
 * otherwise registers the `2026` as its own uncited figure - and because the scope only
 * looks forward, the `{{q:` that opens the very same token cannot cite it. Every
 * well-cited claim in a run over a dated file then reports UNATTRIBUTED.
 */
function tokenRanges(text: string): Array<[number, number]> {
  return [...text.matchAll(/\{\{[qc]:[^}]*\}\}/g)].map((m) => [
    m.index ?? 0,
    (m.index ?? 0) + m[0].length,
  ]);
}

/**
 * A fact is attributed if a reference token follows it in scope. Either kind counts:
 * `{{c:}}` gives the figure its receipt without splicing a quote into the sentence,
 * which is what prose actually wants; `{{q:}}` also attributes it, more loudly.
 */
const CITATION = /\{\{[qc]:/;

export type FactCoverage = {
  /** quantitative claims found */
  facts: number;
  /** those with a citation in scope whose span actually contains the figure */
  cited: number;
  /** figures with no citation in scope at all */
  uncited: string[];
  /**
   * Figures that DO carry a citation, but whose cited span does not contain them -
   * the model's own arithmetic presented as a sourced fact. Only populated when a span
   * table is supplied; without one this check cannot be made.
   */
  unsupported: string[];
  pass: boolean;
  summary: string;
};

/**
 * Scope for "is this fact attributed": everything after the figure, truncated at
 * whichever comes first - the end of the line, or the end of the sentence.
 *
 * Both bounds matter. The line bound stops a citation on the next bullet from covering
 * this one. The sentence bound stops a citation two sentences later from covering a
 * figure it has nothing to do with. The sentence terminator is matched with a
 * `(?<!\d)` guard so the decimal point in `4.8` does not end the sentence.
 */
function scopeAfter(text: string, end: number): string {
  let window = text.slice(end);
  const nl = window.indexOf('\n');
  if (nl !== -1) window = window.slice(0, nl);
  const sent = /(?<!\d)[.!?](?:\s|$)/.exec(window);
  if (sent) window = window.slice(0, sent.index + sent[0].length);
  return window;
}

/**
 * A readable fragment around an uncited figure, for the report.
 *
 * Reference tokens are stripped rather than shown: the window is a fixed character
 * width, so it routinely lands mid-token and prints debris like `older:q3-call.md@s4}}`.
 * The reader needs to recognise the sentence, not read the plumbing.
 */
function snippet(text: string, start: number, end: number): string {
  let from = Math.max(0, start - 40);
  let to = Math.min(text.length, end + 40);
  // Snap to word boundaries. A fixed-width window cuts mid-word, and a receipt that reads
  // `t is projected to grow by approximately 29%` looks like the check malfunctioned
  // rather than like the sentence it is quoting.
  while (from > 0 && !/\s/.test(text[from - 1])) from--;
  while (to < text.length && !/\s/.test(text[to])) to++;
  return text
    .slice(from, to)
    .replace(/\{\{[qc]:[^}]*\}?\}?/g, '') // whole tokens, and partials at either edge
    .replace(/^[^\s]*\}\}/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every span id referenced inside a window, in order. */
function tokensIn(window: string): string[] {
  return [...window.matchAll(/\{\{[qc]:([^}]+)\}\}/g)].map((m) => m[1].trim());
}

/**
 * The digit core of a matched figure: `$12.4M` -> `12.4`, `118%` -> `118`, `1,200` -> `1200`.
 * Grouping commas are dropped so a figure written `1,200` matches a source that wrote
 * `1200`, which is the same number and not a different claim.
 */
function digitCore(figure: string): string {
  return figure.replace(/[^\d.]/g, '').replace(/\.$/, '');
}

/** Does `spanText` state this figure? Digit-boundary matched, comma-insensitive. */
function spanStates(spanText: string, core: string): boolean {
  if (!core) return false;
  const normalized = spanText.replace(/(\d),(?=\d{3}\b)/g, '$1');
  const escaped = core.replace(/\./g, '\\.');
  return new RegExp(`(?<!\\d)${escaped}(?!\\d)`).test(normalized);
}

/**
 * Check every quantitative claim in the model's RAW output is attributed - and, when a
 * span table is supplied, that the span it points at actually says so.
 *
 * The two are different checks and the second is the one that matters. Presence alone is
 * weak: a model that computes `29%` from a source saying `240 today, from 186` and drops
 * any nearby citation passes a presence check, because a citation is indeed present. It
 * is still a number that exists nowhere in the evidence. Observed live, not hypothesised.
 *
 * Runs on the raw output (pre-substitution), where citations are still tokens - the same
 * surface the quote gate reads, so the two agree about what the model wrote.
 */
export function checkFactsCited(rawOutput: string, table?: Map<string, { text: string }>): FactCoverage {
  const uncited: string[] = [];
  const unsupported: string[] = [];
  let facts = 0;
  let cited = 0;

  const skip = tokenRanges(rawOutput);
  FACT_SIGNAL.lastIndex = 0;
  for (const m of rawOutput.matchAll(FACT_SIGNAL)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (skip.some(([a, b]) => start >= a && start < b)) continue;
    facts += 1;

    const scope = scopeAfter(rawOutput, end);
    if (!CITATION.test(scope)) {
      uncited.push(snippet(rawOutput, start, end));
      continue;
    }
    if (!table) {
      cited += 1;
      continue;
    }
    const core = digitCore(m[0]);
    const backed = tokensIn(scope).some((id) => spanStates(table.get(id)?.text ?? '', core));
    if (backed) cited += 1;
    else unsupported.push(snippet(rawOutput, start, end));
  }

  const pass = uncited.length === 0 && unsupported.length === 0;
  const parts: string[] = [];
  if (uncited.length) parts.push(`${uncited.length} with no citation`);
  if (unsupported.length) parts.push(`${unsupported.length} whose source does not state it`);

  const summary = facts === 0
    ? 'No quantitative claims to attribute.'
    : pass
      ? `ATTRIBUTED - ${cited}/${facts} quantitative claim(s) traced to a source that states them.`
      : `UNATTRIBUTED - ${facts} figure(s), ${parts.join(', ')}.`;

  return { facts, cited, uncited, unsupported, pass, summary };
}
