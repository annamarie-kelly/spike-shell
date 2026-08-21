// The orchestrator: one run, start to receipt.
//
// Pure except for two injected operations - read the sources, and take one model turn.
// That split is what lets the CLI script and the Spike app be the same code rather than
// two copies that drift: the script injects Node's fs and a subprocess, the app injects
// Tauri commands, and neither owns any of the logic that decides whether a run passed.
//
// It also means the whole pipeline is testable without a model, a subprocess, or a Tauri
// runtime. A fake `turn` that returns a canned answer exercises segmenting, substitution,
// every gate, the redo loop and both projections in a millisecond, for free - which is
// what makes it affordable to have a test for each way a run can go wrong.

import { buildSpanTable, renderEvidenceManifest, spanResolves, type SourceRef, type Span } from './segmenter';
import { gateFields, type QuoteVerdict } from './quote-gate';
import { checkFactsCited, type FactCoverage } from './facts-cited';
import { checkContract, correctionFor, type ContractVerdict, type AnswerItem } from './contract';
import { runWithRedo } from './redo';
import { renderAudit, renderDisplay, type Receipt } from './render';
import type { CheckSet } from './checkset';

/** What one headless turn gives back. Mirrors Claude Code's `--output-format json`. */
export type TurnResult = {
  is_error?: boolean;
  terminal_reason?: string;
  result?: string;
  total_cost_usd?: number;
  apiKeySource?: string;
  structured_output?: { items?: AnswerItem[]; decision?: string };
};

export type AttestIO = {
  /** Read one source root into verbatim SourceRefs, each with a content hash. */
  readSources: (root: string) => Promise<SourceRef[]>;
  /** Take one model turn. Throws on a run-level failure; gate failures are not errors. */
  turn: (args: { prompt: string; schema: object; model: string; engine: string }) => Promise<TurnResult>;
  /** Re-hash the sources to detect a file edited under the run. Optional. */
  rehash?: (refs: SourceRef[]) => Promise<Set<string>>;
};

export type AttestRun = {
  pass: boolean;
  display: string;
  audit: string;
  verdict: QuoteVerdict;
  shape: ContractVerdict;
  facts: FactCoverage;
  receipt: Receipt;
  redos: number;
  costUsd: number;
  /** False when the engine reports tokens but no dollars. See Receipt.costReported. */
  costReported: boolean;
  /** what the manifest showed vs what existed, so a caller can surface truncation */
  spans: { total: number; shown: number; omitted: number };
  auth?: string;
  /**
   * Every span this answer placed or cited, and the table it came from. Returned so a
   * caller can build a run record (src/attest/record.ts) without re-deriving them - the
   * record is what lets a report shipped last week be re-checked against sources today.
   */
  placedSpanIds: string[];
  table: Map<string, Span>;
};

/** The answer shape the model must fill. A declared decision becomes a closed enum. */
export function answerSchema(checkSet: CheckSet): object {
  const item = {
    type: 'object',
    properties: {
      headline: { type: 'string' },
      body: { type: 'string' },
      evidence: { type: 'array', items: { type: 'string' } },
    },
    required: ['headline', 'body', 'evidence'],
    additionalProperties: false,
  };
  const properties: Record<string, unknown> = { items: { type: 'array', items: item } };
  const required = ['items'];
  if (checkSet.answer.decision) {
    properties.decision = { type: 'string', enum: checkSet.answer.decision.values };
    required.push('decision');
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

/**
 * The rules the model is held to. Generated from the check set rather than fixed, so what
 * the model is told and what the gate enforces cannot drift apart - a rule the gate checks
 * but never states is an unfair failure, and a rule stated but never checked is theatre.
 */
export function rules(checkSet: CheckSet): string {
  const L = [
    '## How to answer',
    '',
    'Every claim you make must be grounded in the evidence above. You have no other sources.',
    '',
    'There are two reference tokens, and they do different jobs:',
    '',
    '  `{{c:SPAN_ID}}`  CITE  - becomes a citation link. Places no text. Use this in prose.',
    '  `{{q:SPAN_ID}}`  QUOTE - becomes the exact source words. Use this only in `evidence`.',
    '',
    '1. Write each claim in YOUR OWN WORDS in `headline` and `body`. Use no quotation marks',
    '   anywhere. A typed quotation mark of any kind (" “ ” ‘ ’ ` « ») fails the run.',
    '2. Do NOT put `{{q:}}` in `headline` or `body`. A claim is your sentence, not a quote',
    '   with a few words around it. Put the quotes in `evidence`.',
    '3. Every evidence entry must contain ONLY `{{q:SPAN_ID}}` tokens, copied exactly from',
    '   the manifest - no words of your own, before or after. Anything you type there is',
    '   displayed as if it were a source quote.',
    '4. Every figure you state - a dollar amount, a percentage, a year, a count - must be',
    '   followed by a `{{c:...}}` token in the same sentence, on the same line, pointing at a',
    '   span that actually states that figure. Do not compute figures the sources do not give.',
    `5. Return between ${checkSet.answer.items.min} and ${checkSet.answer.items.max} claims.`,
  ];
  let n = 6;
  if (checkSet.answer.minClaimWords) {
    L.push(`${n++}. Each claim must be a full sentence of at least ${checkSet.answer.minClaimWords} words.`);
  }
  if (checkSet.answer.minDistinctSources) {
    L.push(`${n++}. The answer must rest on at least ${checkSet.answer.minDistinctSources} distinct sources.`);
  }
  if (checkSet.answer.decision) {
    L.push(`${n++}. Commit a ${checkSet.answer.decision.field}: one of ${checkSet.answer.decision.values.join(', ')}.`);
  }
  L.push(
    '',
    'If the evidence does not support a claim, drop the claim. An honest short answer beats a',
    'padded one. If nothing is supportable, return an empty items array.',
  );
  return L.join('\n');
}

/** Build the prompt for a run. Exposed so a caller can offer a dry run that spends nothing. */
export function buildPrompt(task: string, manifest: string, checkSet: CheckSet): string {
  return `${manifest}\n\n${rules(checkSet)}\n\n## Task\n\n${task}\n`;
}

export async function prepare(checkSet: CheckSet, io: AttestIO, overrideRoot?: string) {
  const roots = overrideRoot
    ? [overrideRoot]
    : checkSet.sources.filter((s) => s.type === 'folder').map((s) => (s as { path: string }).path);
  if (!roots.length) throw new Error('no folder source declared');

  const refs: SourceRef[] = [];
  for (const root of roots) refs.push(...(await io.readSources(root)));
  if (!refs.length) throw new Error('no readable text sources');

  const { table, order } = buildSpanTable(refs);

  // The invariant the whole guarantee rests on, checked on every run rather than only in
  // the test suite: each span must still address exactly the bytes it claims. If this ever
  // fails the harness would place text that is not in the source while reporting VERBATIM,
  // so it aborts rather than degrades.
  const byId = new Map(refs.map((r) => [r.id, r]));
  for (const span of table.values()) {
    const detail = byId.get(span.source_id)?.detail ?? '';
    if (!spanResolves(span, detail)) {
      throw new Error(`span ${span.span_id} does not address its source bytes - refusing to run.`);
    }
  }

  const { manifest, includedIds, omitted } = renderEvidenceManifest(refs, table, order);
  // The gate judges exactly the surface the model saw: a span dropped for budget was never
  // readable, so it must not be quotable either.
  const shown = new Map(includedIds.map((id) => [id, table.get(id)!]));
  const fetchedSources = new Set([...shown.values()].map((s) => s.source_id));

  return { refs, table, manifest, shown, fetchedSources, omitted, includedIds };
}

/** Gate one answer. Shared by the redo judge and the final pass so they cannot disagree. */
function judge(
  result: TurnResult,
  checkSet: CheckSet,
  shown: Map<string, { source_id: string; text: string }>,
  fetchedSources: Set<string>,
) {
  const items = result.structured_output?.items ?? [];
  const fields = items.flatMap((it) => [it.headline ?? '', it.body ?? '', ...(it.evidence ?? [])]);
  const { verdict, rendered } = gateFields(fields, shown as never, fetchedSources);
  const facts = checkFactsCited(fields.join('\n'), shown);
  const cited = new Set(
    verdict.render.used
      .map((h) => shown.get(h.span_id)?.source_id)
      .concat(verdict.render.cited.map((id) => shown.get(id)?.source_id))
      .filter((x): x is string => Boolean(x)),
  );
  const shape = checkContract(
    items,
    { ...checkSet.answer, checks: checkSet.checks, args: checkSet.args },
    cited,
    result.structured_output?.decision,
  );
  return { items, verdict, facts, shape, rendered, cited };
}

export async function runAttest(opts: {
  task: string;
  checkSet: CheckSet;
  io: AttestIO;
  sourceRoot?: string;
}): Promise<AttestRun> {
  const { task, checkSet, io } = opts;
  const prep = await prepare(checkSet, io, opts.sourceRoot);
  const schema = answerSchema(checkSet);
  const basePrompt = buildPrompt(task, prep.manifest, checkSet);

  let costUsd = 0;
  let costReported = false;
  const outcome = await runWithRedo<TurnResult>(
    async (correction) => {
      const prompt = correction ? `${correction}\n\n${basePrompt}` : basePrompt;
      const result = await io.turn({
        prompt, schema, model: checkSet.model, engine: checkSet.engine,
      });
      if (result.is_error) {
        throw new Error(`run failed - ${result.terminal_reason ?? 'unknown'}: ${result.result ?? ''}`);
      }
      if (typeof result.total_cost_usd === 'number') {
        costUsd += result.total_cost_usd;
        costReported = true;
      }
      return result;
    },
    (result) => {
      const j = judge(result, checkSet, prep.shown, prep.fetchedSources);
      return {
        pass: j.verdict.pass && j.shape.pass && j.facts.pass,
        correction: correctionFor(j.verdict, j.shape, j.facts),
      };
    },
    checkSet.maxRedos,
  );

  const result = outcome.final.result;
  const { items, verdict, facts, shape, rendered, cited } = judge(
    result, checkSet, prep.shown, prep.fetchedSources,
  );

  // Re-slice the rendered fields back into items, in the order they were flattened.
  let cursor = 0;
  const placed = items.map((it) => ({
    headline: rendered[cursor++],
    body: rendered[cursor++],
    evidence: (it.evidence ?? []).map(() => rendered[cursor++]),
  }));

  // A check that cannot fail is not a check. `source-unchanged` was declared, loaded, and
  // then never consulted by `pass` - and the app injected no rehash at all, so it was a
  // total no-op there. If a check set asks for it, the caller must supply the means to run
  // it; a silently skipped check is the failure this whole harness argues against.
  const wantsDrift = checkSet.checks.has('source-unchanged');
  if (wantsDrift && !io.rehash) {
    throw new Error(
      'this check set requires source-unchanged, but this caller cannot re-read sources. ' +
        'Refusing rather than reporting a check that did not run.',
    );
  }
  const changed = wantsDrift ? await io.rehash!(prep.refs) : new Set<string>();

  const receipt: Receipt = {
    quotes: verdict.summary,
    shape: shape.summary,
    figures: facts.summary,
    uncited: facts.uncited,
    unsupported: facts.unsupported,
    sources: prep.refs.map((r) => ({
      id: r.id,
      hash: r.hash ?? '',
      cited: cited.has(r.id),
      changed: changed.has(r.id),
    })),
    omitted: prep.omitted,
    redos: outcome.redos,
    costUsd,
    costReported,
    gated: checkSet.onFail === 'gate',
  };

  const decisionValue = result.structured_output?.decision;
  const decision = checkSet.answer.decision && decisionValue
    ? { field: checkSet.answer.decision.field, value: decisionValue }
    : undefined;

  return {
    pass: verdict.pass && shape.pass && facts.pass && changed.size === 0,
    display: renderDisplay(task, placed, receipt, decision),
    audit: renderAudit(task, placed, receipt, decision),
    verdict,
    shape,
    facts,
    receipt,
    redos: outcome.redos,
    costUsd,
    costReported,
    spans: { total: prep.table.size, shown: prep.includedIds.length, omitted: prep.omitted },
    auth: result.apiKeySource,
    placedSpanIds: [...verdict.render.used.map((h) => h.span_id), ...verdict.render.cited],
    table: prep.table,
  };
}
