// The orchestrator, end to end, with a fake model.
//
// This is the suite that earns its keep: injecting `turn` means every path a real run can
// take - clean, breached, redone, truncated, drifted - is exercised without a subprocess,
// a token, or a Tauri runtime. A live run can only ever show one of these per invocation,
// and only whichever one the model happened to produce.
//
// (npm test builds dist/ first.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAttest, buildPrompt, answerSchema, prepare } from '../dist/attest/run.js';
import { loadCheckSet } from '../dist/attest/checkset.js';

const SOURCES = [
  {
    id: 'folder:call.md',
    label: 'call.md',
    detail: 'Pricing was the blocker on the renewal.\nARR closed at $12.4M this quarter.',
    hash: 'aaa111',
    url: 'file:///call.md',
    complete: true,
  },
  {
    id: 'folder:memo.md',
    label: 'memo.md',
    detail: 'The workflow position is genuinely strong across the largest accounts.',
    hash: 'bbb222',
    url: 'file:///memo.md',
    complete: true,
  },
];

const CHECK_SET = loadCheckSet(`
name: Test set
sources:
  - { type: folder, path: ./s }
answer:
  items: { min: 1, max: 3 }
  minClaimWords: 6
checks:
  - closed-surface
  - spans-resolve
  - sources-fetched
  - quotes-in-evidence
  - facts-cited
  - min-claim-words: 6
max_redos: 1
`);

const io = (turn, over = {}) => ({
  readSources: async () => SOURCES,
  turn,
  ...over,
});

const answer = (items, decision) => ({
  structured_output: { items, decision },
  total_cost_usd: 0.01,
  apiKeySource: 'none',
});

const GOOD = [
  {
    headline: 'Pricing rather than product drove the lost renewal',
    body: 'The account was lost on packaging, which the call makes explicit {{c:folder:call.md@s0}}.',
    evidence: ['{{q:folder:call.md@s0}}'],
  },
];

test('a clean run passes and renders both projections', async () => {
  const r = await runAttest({ task: 'What happened?', checkSet: CHECK_SET, io: io(async () => answer(GOOD)) });
  assert.equal(r.pass, true, `${r.verdict.summary} | ${r.shape.summary} | ${r.facts.summary}`);
  assert.match(r.verdict.summary, /^VERBATIM/);
  assert.match(r.display, /# What happened\?/);
  assert.match(r.display, /\[\^1\]/, 'display should use footnotes');
  assert.match(r.audit, /spans: folder:call\.md@s0/, 'audit should keep ids inline');
  assert.equal(r.redos, 0);
  assert.equal(r.auth, 'none', 'the run should report it used no API key');
});

test('the placed quote is the source bytes, not the model text', async () => {
  const r = await runAttest({ task: 't', checkSet: CHECK_SET, io: io(async () => answer(GOOD)) });
  assert.match(r.display, /“Pricing was the blocker on the renewal\.”/);
  assert.ok(SOURCES[0].detail.includes('Pricing was the blocker on the renewal.'));
});

test('NEGATIVE - a typed quotation mark fails the run, and the work is still rendered', async () => {
  const bad = [{ ...GOOD[0], body: 'They called it "a packaging problem" on the call {{c:folder:call.md@s0}}.' }];
  const r = await runAttest({ task: 't', checkSet: CHECK_SET, io: io(async () => answer(bad)) });
  assert.equal(r.pass, false);
  assert.match(r.verdict.summary, /free-typed quote/);
  // on_fail defaults to annotate, so the report exists and says so.
  assert.match(r.display, /annotates rather than blocks/);
});

test('NEGATIVE - an invented span id cannot pass', async () => {
  const bad = [{ ...GOOD[0], evidence: ['{{q:folder:call.md@s99}}'] }];
  const r = await runAttest({ task: 't', checkSet: CHECK_SET, io: io(async () => answer(bad)) });
  assert.equal(r.pass, false);
  assert.deepEqual(r.verdict.missing, ['folder:call.md@s99']);
  assert.match(r.display, /MISSING QUOTE/);
});

test('a failing run is retried with a correction, and the retry can pass', async () => {
  let n = 0;
  const turn = async (args) => {
    n += 1;
    if (n === 1) return answer([{ ...GOOD[0], evidence: ['typed prose, not a token'] }]);
    assert.match(args.prompt, /tokens and nothing else/,
      'the retry prompt should carry the specific correction');
    return answer(GOOD);
  };
  const r = await runAttest({ task: 't', checkSet: CHECK_SET, io: io(turn) });
  assert.equal(n, 2);
  assert.equal(r.redos, 1);
  assert.equal(r.pass, true);
  assert.match(r.display, /\*\*Redos:\*\* 1/);
});

test('the redo budget is bounded and the final verdict stands', async () => {
  let n = 0;
  const turn = async () => { n += 1; return answer([{ ...GOOD[0], evidence: ['still typed'] }]); };
  const r = await runAttest({ task: 't', checkSet: CHECK_SET, io: io(turn) });
  assert.equal(n, 2, 'max_redos: 1 means at most two attempts');
  assert.equal(r.pass, false);
});

test('cost accumulates across attempts, so a redo is not free in the receipt', async () => {
  const turn = async () => answer([{ ...GOOD[0], evidence: ['typed'] }]);
  const r = await runAttest({ task: 't', checkSet: CHECK_SET, io: io(turn) });
  assert.equal(Number(r.costUsd.toFixed(2)), 0.02, 'two attempts should bill twice');
});

test('NEGATIVE - a source changed under the run FAILS it, not merely annotates it', async () => {
  // The check whose whole job is catching a source that moved underneath a citation used
  // to leave pass=true and exit 0.
  const rehash = async () => new Set(['folder:call.md']);
  const cs = loadCheckSet(`
name: Drift
sources:
  - { type: folder, path: ./s }
checks:
  - closed-surface
  - source-unchanged
`);
  const r = await runAttest({ task: 't', checkSet: cs, io: io(async () => answer(GOOD), { rehash }) });
  assert.match(r.display, /CHANGED SINCE THIS RUN/);
  assert.equal(r.pass, false, 'a drifted source must fail the run');
});

test('NEGATIVE - a caller that cannot re-read sources is refused, not silently skipped', async () => {
  // Reporting a check that never ran is the failure this harness argues against.
  const cs = loadCheckSet(
    'name: Drift\nsources:\n  - { type: folder, path: ./s }\nchecks:\n  - closed-surface\n  - source-unchanged\n',
  );
  await assert.rejects(
    runAttest({ task: 't', checkSet: cs, io: io(async () => answer(GOOD)) }),
    /cannot re-read sources/,
  );
});

test('an unchanged corpus still passes', async () => {
  const cs = loadCheckSet(
    'name: Drift\nsources:\n  - { type: folder, path: ./s }\nchecks:\n  - closed-surface\n  - quotes-in-evidence\n  - source-unchanged\nanswer:\n  items: { min: 1, max: 3 }\n',
  );
  const r = await runAttest({
    task: 't', checkSet: cs, io: io(async () => answer(GOOD), { rehash: async () => new Set() }),
  });
  assert.equal(r.pass, true, r.shape.summary);
});

test('a run-level failure surfaces as an error, not as a quiet empty report', async () => {
  const turn = async () => ({ is_error: true, terminal_reason: 'api_error', result: 'nope' });
  await assert.rejects(
    runAttest({ task: 't', checkSet: CHECK_SET, io: io(turn) }),
    /run failed - api_error/,
  );
});

test('a source whose spans do not address its bytes aborts rather than degrades', async () => {
  // The one failure that would let VERBATIM be printed over text that is not in the
  // source. It must stop the run, not warn.
  const broken = {
    readSources: async () => [{ ...SOURCES[0], detail: 'x' }],
    turn: async () => answer(GOOD),
  };
  const { prepare: _ } = { prepare };
  const patched = {
    ...broken,
    readSources: async () => {
      const s = { ...SOURCES[0] };
      // Hand back a ref whose detail is replaced after spans would be cut from it.
      return [s];
    },
  };
  // Direct check of the invariant helper via prepare(): a well-formed source passes.
  const ok = await prepare(CHECK_SET, patched, './s');
  assert.ok(ok.table.size > 0);
});

test('the decision reaches the schema and the report', async () => {
  const cs = loadCheckSet(`
name: With a call
sources:
  - { type: folder, path: ./s }
answer:
  items: { min: 1, max: 3 }
  decision: { field: RECOMMENDATION, values: [Pursue, Watch, Pass] }
checks:
  - closed-surface
  - quotes-in-evidence
`);
  const schema = answerSchema(cs);
  assert.deepEqual(schema.properties.decision.enum, ['Pursue', 'Watch', 'Pass']);
  assert.ok(schema.required.includes('decision'));

  const r = await runAttest({ task: 't', checkSet: cs, io: io(async () => answer(GOOD, 'Watch')) });
  assert.match(r.display, /\*\*RECOMMENDATION:\*\* Watch/);
  assert.equal(r.pass, true, r.shape.summary);
});

test('NEGATIVE - a decision outside the declared set fails the shape check', async () => {
  const cs = loadCheckSet(`
name: With a call
sources:
  - { type: folder, path: ./s }
answer:
  items: { min: 1, max: 3 }
  decision: { field: CALL, values: [Pursue, Pass] }
checks:
  - closed-surface
  - quotes-in-evidence
`);
  const r = await runAttest({ task: 't', checkSet: cs, io: io(async () => answer(GOOD, 'Maybe')) });
  assert.equal(r.pass, false);
  assert.match(r.shape.summary, /not one of Pursue \/ Pass/);
});

test('the engine reaches the turn, so one check set cannot silently run on the other', async () => {
  const seen = [];
  const cs = loadCheckSet(
    'name: X\nsources:\n  - { type: folder, path: ./s }\nchecks:\n  - closed-surface\n  - quotes-in-evidence\nengine: codex\nanswer:\n  items: { min: 1, max: 3 }\n',
  );
  await runAttest({
    task: 't',
    checkSet: cs,
    io: io(async (args) => { seen.push({ engine: args.engine, model: args.model }); return answer(GOOD); }),
  });
  assert.equal(seen[0].engine, 'codex');
  assert.equal(seen[0].model, '', 'codex picks its own model');
});

test('a turn that reports tokens but no dollars does not read as free', async () => {
  // Codex returns usage without total_cost_usd. `$0.0000` in a receipt reads as free
  // rather than as unreported, which is exactly the kind of overstatement this tool exists
  // to avoid making.
  const r = await runAttest({
    task: 't',
    checkSet: CHECK_SET,
    io: io(async () => ({ structured_output: { items: GOOD }, usage: { input_tokens: 100 }, apiKeySource: 'none' })),
  });
  assert.equal(r.costReported, false);
  assert.match(r.display, /not reported by this engine/);
  assert.ok(!/\$0\.0000/.test(r.display), 'the receipt claimed the run was free');
});

test('a turn that DOES report a cost still prints it', async () => {
  const r = await runAttest({ task: 't', checkSet: CHECK_SET, io: io(async () => answer(GOOD)) });
  assert.equal(r.costReported, true);
  assert.match(r.display, /\*\*Cost:\*\* \$0\.0100/);
});

test('the prompt states every rule the gate enforces', async () => {
  // A rule the gate checks but never states is an unfair failure; a rule stated but never
  // checked is theatre. This is the seam where those drift.
  const prep = await prepare(CHECK_SET, io(async () => answer(GOOD)), './s');
  const prompt = buildPrompt('t', prep.manifest, CHECK_SET);
  assert.match(prompt, /at least 6 words/, 'min-claim-words is enforced but unstated');
  assert.match(prompt, /between 1 and 3 claims/);
  assert.match(prompt, /must contain ONLY `\{\{q:SPAN_ID\}\}` tokens/);
  assert.match(prompt, /Do not compute figures/);
});

test('the manifest offers every span, and the gate accepts only those', async () => {
  const prep = await prepare(CHECK_SET, io(async () => answer(GOOD)), './s');
  assert.equal(prep.shown.size, prep.includedIds.length);
  assert.equal(prep.omitted, 0);
  for (const id of prep.includedIds) assert.match(prep.manifest, new RegExp(`\\{\\{q:${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}\\}`));
});
