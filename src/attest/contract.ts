// Shape checks over the answer's structure, as opposed to its quotes.
//
// Every check here is driven by the check set, and every one is mechanical: a token is
// present or it isn't, a count is over a threshold or it isn't. Nothing in this file asks
// a model anything, which is what lets any of it gate.
//
// The load-bearing one is `quotes-in-evidence`, and it exists because of a specific
// documented failure: when a model is forbidden to type quotation marks but required to
// ground its claims, the cheapest way to satisfy both is to make the fetched span BE the
// sentence - "Acme is a {{q:...}}". Every quote gate stays green and the answer contains
// no reasoning at all, just quotes strung together.

import { QUOTE_TOKEN } from './quote-extract';
import type { CheckName } from './checkset';

export type AnswerItem = {
  headline: string;
  body: string;
  evidence: string[];
};

export type ContractConfig = {
  items: { min: number; max: number };
  minDistinctSources?: number;
  minClaimWords?: number;
  decision?: { field: string; values: string[] };
  /** Which checks this run enforces. A check absent here is not evaluated. */
  checks: Set<CheckName>;
  args: Map<CheckName, number>;
};

export type ContractVerdict = {
  pass: boolean;
  /** 1-based indexes of items whose headline or body carried a verbatim quote token */
  quotesInBody: number[];
  /** 1-based indexes of items with no evidence at all */
  ungrounded: number[];
  /**
   * `item.entry` locations where an evidence string does not begin with a `{{q:}}`
   * token. The report renders every evidence string as a blockquote, so an entry the
   * model simply typed is displayed exactly like placed source bytes.
   */
  freeTypedEvidence: string[];
  /** 1-based indexes of items whose claim is too short to be a claim */
  thinClaims: number[];
  /** how many distinct sources the answer actually rests on */
  distinctSources: number;
  /** set when the answer's committed decision is outside the declared closed set */
  badDecision?: string;
  /** set when the item count is outside the declared range */
  cardinality?: string;
  summary: string;
};

/** Does this text carry a `{{q:}}` token? (Fresh lastIndex - QUOTE_TOKEN is global.) */
function hasQuoteToken(text: string): boolean {
  QUOTE_TOKEN.lastIndex = 0;
  return QUOTE_TOKEN.test(text);
}

/**
 * An evidence entry must contain NOTHING but quote tokens and whitespace.
 *
 * The report renders each entry as a blockquote, so anything else in the string is
 * displayed as though it were placed source bytes. Leading-token-only was not enough:
 * `{{q:a@s1}} and the CFO added that renewals collapsed by half` passed the gate, and
 * rendered as one blockquote whose second clause exists in no source, under a green
 * VERBATIM receipt. That is precisely the false green this harness exists to foreclose.
 *
 * This drops the trailing-tag affordance the earlier comment described. A bounded tag
 * cannot be told apart from a fabricated clause by any rule that is not a guess, and a
 * gate that guesses is not a gate. If per-quote tags come back they belong in their own
 * field, where they are never rendered as quotation.
 */
const TOKENS_ONLY = /^(?:\s*\{\{q:[^}]+\}\})+\s*$/;

/** Words in a claim, ignoring reference tokens (which are plumbing, not prose). */
function claimWords(item: AnswerItem): number {
  const prose = `${item.headline ?? ''} ${item.body ?? ''}`.replace(/\{\{[qc]:[^}]*\}\}/g, ' ');
  return prose.split(/\s+/).filter(Boolean).length;
}

export function checkContract(
  items: AnswerItem[],
  cfg: ContractConfig,
  placedSourceIds: Set<string>,
  decision?: string,
): ContractVerdict {
  const on = (c: CheckName) => cfg.checks.has(c);

  const quotesInBody: number[] = [];
  const ungrounded: number[] = [];
  const freeTypedEvidence: string[] = [];
  const thinClaims: number[] = [];

  const minWords = cfg.args.get('min-claim-words') ?? cfg.minClaimWords ?? 0;

  items.forEach((it, i) => {
    if (on('quotes-in-evidence')) {
      if (hasQuoteToken(it.headline ?? '') || hasQuoteToken(it.body ?? '')) quotesInBody.push(i + 1);
      (it.evidence ?? []).forEach((e, j) => {
        if (!TOKENS_ONLY.test(e ?? '')) freeTypedEvidence.push(`${i + 1}.${j + 1}`);
      });
    }
    if (!(it.evidence ?? []).length) ungrounded.push(i + 1);
    if (on('min-claim-words') && minWords > 0 && claimWords(it) < minWords) thinClaims.push(i + 1);
  });

  const distinctSources = placedSourceIds.size;
  const wantSources = cfg.args.get('min-distinct-sources') ?? cfg.minDistinctSources ?? 0;
  const sourcesShort =
    on('min-distinct-sources') && wantSources > 0 && distinctSources < wantSources;

  let cardinality: string | undefined;
  if (items.length < cfg.items.min || items.length > cfg.items.max) {
    cardinality = `${items.length} claim(s), expected ${cfg.items.min}-${cfg.items.max}`;
  }

  let badDecision: string | undefined;
  if (cfg.decision) {
    if (decision === undefined || decision === null || decision === '') {
      badDecision = `no ${cfg.decision.field} committed`;
    } else if (!cfg.decision.values.includes(decision)) {
      badDecision = `${cfg.decision.field} is \`${decision}\`, not one of ${cfg.decision.values.join(' / ')}`;
    }
  }

  const parts: string[] = [];
  if (cardinality) parts.push(cardinality);
  if (quotesInBody.length) parts.push(`item(s) ${quotesInBody.join(', ')} quote inside the claim`);
  if (ungrounded.length) parts.push(`item(s) ${ungrounded.join(', ')} carry no evidence`);
  if (freeTypedEvidence.length) parts.push(`evidence ${freeTypedEvidence.join(', ')} is typed, not placed`);
  if (thinClaims.length) parts.push(`item(s) ${thinClaims.join(', ')} are under ${minWords} words`);
  if (sourcesShort) parts.push(`rests on ${distinctSources} source(s), expected ${wantSources}`);
  if (badDecision) parts.push(badDecision);

  const pass = parts.length === 0;
  const summary = items.length === 0
    ? 'SHAPE FAILED - no claims returned.'
    : pass
      ? `SHAPE - ${items.length} claim(s) across ${distinctSources} source(s), each in the model's own words with evidence attached.`
      : `SHAPE FAILED - ${parts.join('; ')}.`;

  return {
    pass,
    quotesInBody,
    ungrounded,
    freeTypedEvidence,
    thinClaims,
    distinctSources,
    badDecision,
    cardinality,
    summary,
  };
}

/**
 * The correction fed back on a redo. Imperative and specific: a generic "try again"
 * re-rolls the same failure, and the point of a bounded redo is to converge, not to
 * resample. Returns null when there is nothing actionable to say.
 */
export function correctionFor(
  quote: { summary: string; pass: boolean; missing: string[]; strayQuotes: number },
  shape: ContractVerdict,
  facts?: { pass: boolean; uncited: string[]; unsupported: string[] },
): string | null {
  const fixes: string[] = [];
  if (quote.strayQuotes > 0)
    fixes.push('You typed quotation marks. Remove every one of them; quote only by emitting a {{q:SPAN_ID}} token in evidence.');
  if (quote.missing.length)
    fixes.push(`These span ids do not exist: ${quote.missing.join(', ')}. Use only ids copied exactly from the evidence manifest.`);
  if (shape.quotesInBody.length)
    fixes.push(`Item(s) ${shape.quotesInBody.join(', ')} put a {{q:}} token in the claim. Write the claim in your own words and move the quote to evidence.`);
  if (shape.freeTypedEvidence.length)
    fixes.push(`Evidence ${shape.freeTypedEvidence.join(', ')} contains text you typed. An evidence entry must be {{q:SPAN_ID}} tokens and nothing else - no words of your own, before or after.`);
  if (shape.thinClaims.length)
    fixes.push(`Item(s) ${shape.thinClaims.join(', ')} are too short to be a claim. State what the evidence shows in a full sentence.`);
  if (shape.cardinality) fixes.push(`Wrong number of claims: ${shape.cardinality}.`);
  if (shape.badDecision) fixes.push(`Decision problem: ${shape.badDecision}.`);
  if (!quote.pass && quote.summary.startsWith('NO QUOTES PLACED'))
    fixes.push('You grounded nothing. Every claim needs at least one {{q:SPAN_ID}} token in its evidence.');

  // Figures were counted in the verdict but had no branch here, so a run that failed only
  // on attribution produced no correction and the redo loop stopped without spending its
  // budget - the harness knew what was wrong and declined to say so. Observed live.
  if (facts && !facts.pass) {
    if (facts.uncited.length)
      fixes.push(
        `${facts.uncited.length} figure(s) carry no citation: ${facts.uncited.slice(0, 3).join(' | ')}. ` +
          'Put a {{c:SPAN_ID}} token in the same sentence, on the same line, or drop the figure.',
      );
    if (facts.unsupported.length)
      fixes.push(
        `${facts.unsupported.length} figure(s) cite a source that does not state them: ${facts.unsupported.slice(0, 3).join(' | ')}. ` +
          'Do not compute or restate figures the sources do not give. Quote the number the source actually states, or drop the claim.',
      );
  }

  if (!fixes.length) return null;
  return ['Your previous answer failed these checks. Fix exactly these and answer again:', ...fixes.map((f) => `- ${f}`)].join('\n');
}
