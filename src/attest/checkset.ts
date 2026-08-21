// A check set: the file that decides what "verified" means for one kind of work.
//
// This is the difference between a harness and a product. Upstream, a skill was a
// TypeScript record in a registry and the gate was a single-member union. Here it is a
// file a person edits, and the same file is what a marketplace template installs.
//
// Two rules the loader enforces rather than documents:
//
//   1. A model-judged check can never gate. Lifted from the upstream policy layer, which
//      raises on `judged` + `block` at construction. It is also what the cost probes
//      forced independently: a per-claim model call is neither affordable nor able to
//      fail honestly. Judged checks annotate. Only deterministic checks may block.
//   2. Unknown keys and unknown check names are errors. A check set is a safety
//      configuration; a typo that silently disables a check is the worst outcome
//      available, so the loader refuses the file instead of running a weaker one.

import { parseYaml, type YamlValue } from './yaml';

/** Checks the harness can actually run. Everything here is mechanical. */
export const DETERMINISTIC_CHECKS = [
  'closed-surface', // the model typed no quotation marks
  'spans-resolve', // every reference names a real span
  'sources-fetched', // no reference to a source this run did not read
  'quotes-in-evidence', // claims are the model's words; placed bytes live in evidence
  'facts-cited', // every figure traces to a source that states it
  'min-claim-words', // a claim must be a sentence, not a fragment
  'min-distinct-sources', // the answer rests on more than one source
  'source-unchanged', // each cited source still hashes to what was read
] as const;

// `cite-latest-source` used to be listed above. It was never implemented: nothing read it,
// so a check set naming it loaded clean and silently enforced nothing. The loader's stated
// contract is that a name which does not run is refused, and a known-but-unimplemented
// name defeats that by name rather than by typo - which is worse, because the user has no
// reason to doubt it. It comes back when the folder provider extracts source dates.

export type CheckName = (typeof DETERMINISTIC_CHECKS)[number];

export type SourceSpec =
  | { type: 'folder'; path: string; include?: string[] }
  | { type: 'attachment' };

export type CheckSet = {
  name: string;
  description: string;
  sources: SourceSpec[];
  answer: {
    items: { min: number; max: number };
    minDistinctSources?: number;
    minClaimWords?: number;
    decision?: { field: string; values: string[] };
  };
  checks: Set<CheckName>;
  /** Per-check numeric argument, e.g. `min-claim-words: 8`. */
  args: Map<CheckName, number>;
  onFail: 'annotate' | 'gate';
  /** Which local agent runs this check set. Both bill to the user's own subscription. */
  engine: 'claude' | 'codex';
  model: string;
  maxRedos: number;
};

const DEFAULTS = {
  onFail: 'annotate' as const,
  model: 'haiku',
  maxRedos: 1,
  items: { min: 1, max: 8 },
  minClaimWords: 8,
};

const TOP_LEVEL = new Set([
  'name', 'description', 'sources', 'answer', 'checks', 'on_fail', 'engine', 'model', 'max_redos',
]);
const ANSWER_KEYS = new Set(['items', 'minDistinctSources', 'minClaimWords', 'decision']);

function fail(message: string): never {
  throw new Error(`check set: ${message}`);
}

function asRecord(v: YamlValue, where: string): Record<string, YamlValue> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) fail(`${where} must be a mapping`);
  return v as Record<string, YamlValue>;
}

function asArray(v: YamlValue, where: string): YamlValue[] {
  if (!Array.isArray(v)) fail(`${where} must be a list`);
  return v;
}

function readSources(raw: YamlValue): SourceSpec[] {
  const list = asArray(raw, 'sources');
  if (!list.length) fail('sources is empty; there would be nothing to quote');
  return list.map((entry, i) => {
    const r = asRecord(entry, `sources[${i}]`);
    const type = r.type;
    if (type === 'folder') {
      if (typeof r.path !== 'string' || !r.path) fail(`sources[${i}] (folder) needs a path`);
      const include = r.include === undefined ? undefined : asArray(r.include, `sources[${i}].include`).map(String);
      return { type: 'folder', path: r.path, include };
    }
    if (type === 'attachment') return { type: 'attachment' };
    fail(
      `sources[${i}] has type \`${String(type)}\`; supported today: folder, attachment. ` +
        'Run-capture and connector sources are not built yet.',
    );
  });
}

function readChecks(raw: YamlValue): { checks: Set<CheckName>; args: Map<CheckName, number> } {
  const list = asArray(raw, 'checks');
  const checks = new Set<CheckName>();
  const args = new Map<CheckName, number>();
  const known = new Set<string>(DETERMINISTIC_CHECKS);

  for (const entry of list) {
    let name: string;
    let arg: number | undefined;
    if (typeof entry === 'string') {
      name = entry;
    } else {
      const r = asRecord(entry, 'checks entry');
      const keys = Object.keys(r);
      if (keys.length !== 1) fail(`a check entry must name exactly one check, got \`${keys.join(', ')}\``);
      name = keys[0];
      const value = r[name];
      if (typeof value !== 'number') fail(`check \`${name}\` takes a number, got \`${String(value)}\``);
      arg = value;
    }
    if (!known.has(name)) {
      fail(
        `unknown check \`${name}\`. Known checks: ${[...known].join(', ')}. ` +
          'A typo that silently disables a check is worse than a refused file.',
      );
    }
    checks.add(name as CheckName);
    if (arg !== undefined) args.set(name as CheckName, arg);
  }
  if (!checks.size) fail('checks is empty; the run would verify nothing');
  return { checks, args };
}

export function loadCheckSet(source: string): CheckSet {
  const doc = asRecord(parseYaml(source), 'the check set');

  for (const key of Object.keys(doc)) {
    if (!TOP_LEVEL.has(key)) {
      fail(`unknown key \`${key}\`. Known keys: ${[...TOP_LEVEL].join(', ')}`);
    }
  }
  if (typeof doc.name !== 'string' || !doc.name) fail('name is required');
  if (doc.sources === undefined) fail('sources is required');
  if (doc.checks === undefined) fail('checks is required');

  const answerRaw = doc.answer === undefined ? {} : asRecord(doc.answer, 'answer');
  for (const key of Object.keys(answerRaw)) {
    if (!ANSWER_KEYS.has(key)) fail(`unknown key \`answer.${key}\`. Known: ${[...ANSWER_KEYS].join(', ')}`);
  }

  const itemsRaw = answerRaw.items === undefined ? null : asRecord(answerRaw.items, 'answer.items');
  const items = {
    min: typeof itemsRaw?.min === 'number' ? itemsRaw.min : DEFAULTS.items.min,
    max: typeof itemsRaw?.max === 'number' ? itemsRaw.max : DEFAULTS.items.max,
  };
  if (items.min > items.max) fail(`answer.items.min (${items.min}) exceeds max (${items.max})`);

  let decision: CheckSet['answer']['decision'];
  if (answerRaw.decision !== undefined) {
    const d = asRecord(answerRaw.decision, 'answer.decision');
    if (typeof d.field !== 'string' || !d.field) fail('answer.decision needs a field');
    const values = asArray(d.values, 'answer.decision.values').map(String);
    if (values.length < 2) fail('answer.decision.values needs at least two options to be a decision');
    decision = { field: d.field, values };
  }

  const { checks, args } = readChecks(doc.checks);

  // A check whose threshold is absent (or written as a string, which the numeric reads
  // below discard) resolves to 0 and then passes unconditionally. The file says the run
  // was held to a bar; the run was held to nothing. Refuse it rather than run it weaker.
  if (checks.has('min-distinct-sources')
      && args.get('min-distinct-sources') === undefined
      && typeof answerRaw.minDistinctSources !== 'number') {
    fail(
      'min-distinct-sources needs a number: either `- min-distinct-sources: 2` under checks, ' +
        'or `minDistinctSources: 2` under answer. Without one the check passes unconditionally.',
    );
  }
  for (const key of ['minDistinctSources', 'minClaimWords'] as const) {
    if (answerRaw[key] !== undefined && typeof answerRaw[key] !== 'number') {
      fail(`answer.${key} must be a number, got \`${String(answerRaw[key])}\``);
    }
  }
  if (itemsRaw) {
    for (const key of ['min', 'max'] as const) {
      if (itemsRaw[key] !== undefined && typeof itemsRaw[key] !== 'number') {
        fail(`answer.items.${key} must be a number, got \`${String(itemsRaw[key])}\``);
      }
    }
  }

  const onFail = doc.on_fail === undefined ? DEFAULTS.onFail : String(doc.on_fail);
  if (onFail !== 'annotate' && onFail !== 'gate') fail(`on_fail must be annotate or gate, got \`${onFail}\``);

  const engine = doc.engine === undefined ? 'claude' : String(doc.engine);
  if (engine !== 'claude' && engine !== 'codex') {
    fail(`engine must be claude or codex, got \`${engine}\``);
  }

  const maxRedos = typeof doc.max_redos === 'number' ? doc.max_redos : DEFAULTS.maxRedos;
  if (maxRedos < 0) fail('max_redos cannot be negative');

  return {
    name: doc.name,
    description: typeof doc.description === 'string' ? doc.description : '',
    sources: readSources(doc.sources),
    answer: {
      items,
      minDistinctSources:
        typeof answerRaw.minDistinctSources === 'number' ? answerRaw.minDistinctSources : undefined,
      minClaimWords:
        typeof answerRaw.minClaimWords === 'number' ? answerRaw.minClaimWords : DEFAULTS.minClaimWords,
      decision,
    },
    checks,
    args,
    onFail,
    engine,
    // Codex picks its own model from the user's config; naming one here would be a lie.
    model: typeof doc.model === 'string' ? doc.model : engine === 'codex' ? '' : DEFAULTS.model,
    maxRedos,
  };
}

/**
 * The starting point a person edits. Every check here is deterministic, which is why
 * every one of them may gate.
 */
export const STARTER_CHECK_SET = `# A memo where every quote is byte-exact to a source you supplied.
name: Source-backed summary
description: Claims in the model's own words, with receipts.

sources:
  - { type: folder, path: ./sources }

answer:
  items: { min: 3, max: 5 }
  minDistinctSources: 2
  minClaimWords: 8

checks:
  - closed-surface        # the model typed no quotation marks
  - spans-resolve         # every reference names a real span
  - sources-fetched       # no reference to a source this run did not read
  - quotes-in-evidence    # claims are the model's words, quotes live in evidence
  - facts-cited           # every figure traces to a source that states it
  - min-claim-words: 8
  - min-distinct-sources: 2

on_fail: annotate         # annotate | gate
engine: claude            # claude | codex - both run on your own subscription
model: haiku
max_redos: 1
`;
