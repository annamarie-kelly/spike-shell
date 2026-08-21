// Phase 1: the config-driven contract gate, the bounded redo loop, and the two render
// projections. Same discipline as the other suites - every check has a test that drives
// it red, because a gate that has never failed is not known to work.
//
// (npm test builds dist/ first.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkContract, correctionFor } from '../dist/attest/contract.js';
import { runWithRedo } from '../dist/attest/redo.js';
import { renderDisplay, renderAudit } from '../dist/attest/render.js';
import { loadCheckSet } from '../dist/attest/checkset.js';

const ALL = new Set([
  'quotes-in-evidence', 'min-claim-words', 'min-distinct-sources', 'facts-cited',
  'closed-surface', 'spans-resolve', 'sources-fetched',
]);

const cfg = (over = {}) => ({
  items: { min: 1, max: 5 },
  minClaimWords: 8,
  checks: ALL,
  args: new Map(),
  ...over,
});

const item = (over = {}) => ({
  headline: 'Pricing was the blocker on the renewal',
  body: 'The team lost the account over packaging rather than product {{c:d@s0}}.',
  evidence: ['{{q:d@s0}}'],
  ...over,
});

// ── contract, driven by the check set ───────────────────────────────────────────

test('a well-shaped answer passes', () => {
  const r = checkContract([item()], cfg(), new Set(['d']));
  assert.equal(r.pass, true, r.summary);
  assert.match(r.summary, /^SHAPE -/);
});

test('NEGATIVE - each contract check can be driven red', () => {
  const cases = {
    cardinality: [[], cfg(), new Set(['d'])],
    quotesInBody: [[item({ headline: 'Acme is a {{q:d@s0}}' })], cfg(), new Set(['d'])],
    ungrounded: [[item({ evidence: [] })], cfg(), new Set(['d'])],
    freeTypedEvidence: [[item({ evidence: ['they also said it was broken'] })], cfg(), new Set(['d'])],
    thinClaims: [[item({ headline: 'Bad', body: 'Very.' })], cfg(), new Set(['d'])],
    distinctSources: [[item()], cfg({ minDistinctSources: 2 }), new Set(['d'])],
  };
  for (const [name, [items, c, sources]] of Object.entries(cases)) {
    const r = checkContract(items, c, sources);
    assert.equal(r.pass, false, `${name} did not fail`);
    assert.match(r.summary, /^SHAPE FAILED/);
  }
});

test('a check absent from the check set is not evaluated', () => {
  // The whole point of a declarative check set: a team that does not want the
  // claim-length rule simply omits it, and the run must not enforce it anyway.
  const thin = [item({ headline: 'Bad', body: 'Very.' })];
  assert.equal(checkContract(thin, cfg(), new Set(['d'])).pass, false);

  const without = cfg({ checks: new Set(['quotes-in-evidence']) });
  assert.equal(checkContract(thin, without, new Set(['d'])).pass, true);
});

test('a per-check argument overrides the answer default', () => {
  const items = [item({ headline: 'Short one', body: 'Four words here now.' })];
  assert.equal(checkContract(items, cfg({ minClaimWords: 3 }), new Set(['d'])).pass, true);
  const strict = cfg({ args: new Map([['min-claim-words', 40]]) });
  assert.equal(checkContract(items, strict, new Set(['d'])).pass, false);
});

test('reference tokens do not pad the claim word count', () => {
  // Counting tokens as words would let `{{c:a}} {{c:b}} {{c:c}}...` satisfy a length rule
  // with no prose at all.
  const padded = [item({ headline: 'X', body: '{{c:d@s0}} {{c:d@s1}} {{c:d@s2}} {{c:d@s3}} {{c:d@s4}}' })];
  assert.equal(checkContract(padded, cfg({ minClaimWords: 8 }), new Set(['d'])).pass, false);
});

test('a decision must land inside the declared closed set', () => {
  const decision = { field: 'CALL', values: ['Pursue', 'Watch', 'Pass'] };
  const c = cfg({ decision });
  assert.equal(checkContract([item()], c, new Set(['d']), 'Watch').pass, true);
  assert.equal(checkContract([item()], c, new Set(['d']), 'Maybe').pass, false);
  assert.equal(checkContract([item()], c, new Set(['d']), undefined).pass, false, 'a missing decision must fail');
});

// ── the correction fed into a redo ──────────────────────────────────────────────

test('the correction names the specific failure, not a generic retry', () => {
  const shape = checkContract([item({ evidence: ['typed prose'] })], cfg(), new Set(['d']));
  const c = correctionFor({ summary: 'FAILED', pass: false, missing: [], strayQuotes: 0 }, shape);
  assert.match(c, /tokens and nothing else/);
  assert.match(c, /1\.1/, 'the correction should point at the offending entry');
});

test('a figures-only failure still produces a correction', () => {
  // Figures are counted in the verdict, so a run can fail on attribution alone. Without a
  // branch here the loop stops with its redo budget unspent: the harness knows what is
  // wrong and declines to say so.
  const shape = checkContract([item()], cfg(), new Set(['d']));
  const clean = { summary: 'VERBATIM', pass: true, missing: [], strayQuotes: 0 };
  const c = correctionFor(clean, shape, {
    pass: false,
    uncited: ['growth of 36% year over year'],
    unsupported: ['headcount up 29%'],
  });
  assert.match(c, /carry no citation/);
  assert.match(c, /does not state them/);
  assert.match(c, /Do not compute/);
});

test('a clean run produces no correction, so no turn is wasted', () => {
  const shape = checkContract([item()], cfg(), new Set(['d']));
  const clean = { summary: 'VERBATIM', pass: true, missing: [], strayQuotes: 0 };
  const facts = { pass: true, uncited: [], unsupported: [] };
  assert.equal(correctionFor(clean, shape, facts), null);
});

// ── bounded redo ────────────────────────────────────────────────────────────────

test('a passing first attempt spends no redo', async () => {
  let calls = 0;
  const out = await runWithRedo(
    async () => { calls++; return 'ok'; },
    () => ({ pass: true, correction: null }),
    2,
  );
  assert.equal(calls, 1);
  assert.equal(out.redos, 0);
  assert.equal(out.final.pass, true);
});

test('a failing attempt is retried with the correction, and converges', async () => {
  const seen = [];
  const out = await runWithRedo(
    async (correction) => { seen.push(correction); return seen.length; },
    (n) => (n >= 2 ? { pass: true, correction: null } : { pass: false, correction: 'fix the tokens' }),
    3,
  );
  assert.deepEqual(seen, [null, 'fix the tokens']);
  assert.equal(out.redos, 1);
  assert.equal(out.final.pass, true);
});

test('the loop is bounded and the FINAL verdict stands, not the best one', async () => {
  // Attempt 2 passes, attempt 3 fails. Keeping the best would report a green receipt over
  // text nobody re-checked.
  let n = 0;
  const out = await runWithRedo(
    async () => ++n,
    (i) => (i === 2 ? { pass: true, correction: null } : { pass: false, correction: 'again' }),
    5,
  );
  assert.equal(out.final.pass, true, 'this run should stop at the first pass');

  const always = await runWithRedo(
    async () => ++n,
    () => ({ pass: false, correction: 'again' }),
    2,
  );
  assert.equal(always.attempts.length, 3, 'maxRedos=2 means at most three attempts');
  assert.equal(always.final.pass, false);
  assert.equal(always.redos, 2);
});

test('maxRedos 0 disables the loop entirely', async () => {
  let calls = 0;
  const out = await runWithRedo(
    async () => { calls++; return 'x'; },
    () => ({ pass: false, correction: 'fix it' }),
    0,
  );
  assert.equal(calls, 1);
  assert.equal(out.redos, 0);
});

test('no actionable correction stops the loop instead of resampling', async () => {
  let calls = 0;
  const out = await runWithRedo(
    async () => { calls++; return 'x'; },
    () => ({ pass: false, correction: null }),
    3,
  );
  assert.equal(calls, 1, 'a failure with nothing to say must not burn turns');
});

// ── the two projections ─────────────────────────────────────────────────────────

const RECEIPT = {
  quotes: 'VERBATIM - 1/1 quotes placed by construction; surface closed.',
  shape: 'SHAPE - 1 claim(s).',
  figures: 'No quantitative claims to attribute.',
  uncited: [],
  unsupported: [],
  sources: [{ id: 'folder:notes.md', hash: 'abc123def456789', cited: true }],
  omitted: 0,
  redos: 0,
  gated: true,
};

// Citations carry the renderer's private mark, exactly as renderQuotes emits them.
const M = '\uE000';
const PLACED = [{
  headline: 'Pricing was the blocker',
  body: `They churned over packaging ${M}[folder:notes.md@s0](file:///notes.md)${M}.`,
  evidence: [`“Pricing was the blocker.” ${M}[folder:notes.md@s0](file:///notes.md)${M}`],
}];

test('display moves span ids into footnotes and keeps the prose readable', () => {
  const out = renderDisplay('Q3 review', PLACED, RECEIPT);
  assert.match(out, /\[\^1\]/, 'no footnote marker was emitted');
  assert.ok(!/@s0\]\(file/.test(out.split('### References')[0]), 'a raw span link leaked into the prose');
  assert.match(out, /### References/);
  assert.match(out, /\[\^1\]: \[folder:notes\.md@s0\]\(file:\/\/\/notes\.md\)/,
    'the footnote must stay a valid markdown link, or it is not clickable');
});

test('audit keeps span ids inline and lists them per claim', () => {
  const out = renderAudit('Q3 review', PLACED, RECEIPT);
  assert.match(out, /spans: folder:notes\.md@s0/);
  assert.ok(!out.includes('[^1]'), 'the audit view should not hide addresses in footnotes');
});

test('both projections carry the same receipt', () => {
  for (const out of [renderDisplay('t', PLACED, RECEIPT), renderAudit('t', PLACED, RECEIPT)]) {
    assert.match(out, /VERBATIM - 1\/1/);
    assert.match(out, /sha256 `abc123def456`/);
  }
});

test('a changed source is called out, not silently re-resolved', () => {
  const receipt = { ...RECEIPT, sources: [{ ...RECEIPT.sources[0], changed: true }] };
  assert.match(renderDisplay('t', PLACED, receipt), /CHANGED SINCE THIS RUN/);
});

test('an annotate-only run says so, so a green-looking report is not mistaken for a pass', () => {
  const out = renderDisplay('t', PLACED, { ...RECEIPT, gated: false });
  assert.match(out, /annotates rather than blocks/);
});

test('a multi-line placed quote stays inside its blockquote', () => {
  const placed = [{ headline: 'H', body: 'B', evidence: [`“first line\nsecond line” ${M}[d@s0]${M}`] }];
  const out = renderDisplay('t', placed, RECEIPT);
  assert.match(out, /> “first line\n> second line”/);
});

test('the starter check set drives the contract gate it advertises', () => {
  // Guards the docs-to-behaviour seam: the shipped starter must actually produce a
  // config the gate accepts, or a first-time user gets an error on a file we wrote.
  const cs = loadCheckSet(
    'name: X\nsources:\n  - { type: folder, path: ./s }\nchecks:\n  - quotes-in-evidence\n  - min-claim-words: 4\nanswer:\n  items: { min: 1, max: 2 }\n',
  );
  const r = checkContract([item()], { ...cs.answer, checks: cs.checks, args: cs.args }, new Set(['d']));
  assert.equal(r.pass, true, r.summary);
});

test('an unmarked bracket in the SOURCE is never rewritten as a footnote', () => {
  // A note that itself quotes an earlier attest report contains `[folder:q3.md@s4]`. That
  // fragment came from the source, so rewriting it means the displayed quote is no longer
  // byte-identical to the source it cites, under a receipt reading VERBATIM.
  const placed = [{
    headline: 'H',
    body: 'B',
    evidence: [`“see [folder:q3.md@s4] for context” ${M}[folder:notes.md@s0](file:///notes.md)${M}`],
  }];
  const out = renderDisplay('t', placed, RECEIPT);
  assert.match(out, /see \[folder:q3\.md@s4\] for context/, 'source bytes were rewritten');
  assert.match(out, /\[\^1\]/, 'the harness citation should still become a footnote');
});

test('neither projection leaks the private citation mark to the reader', () => {
  for (const out of [renderDisplay('t', PLACED, RECEIPT), renderAudit('t', PLACED, RECEIPT)]) {
    assert.ok(!out.includes('\uE000'), 'a private-use character reached the report');
  }
});
