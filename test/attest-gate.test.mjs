// The gates. Two rules govern what belongs here:
//
//   1. A gate may only assert something the model cannot influence. If a check needs a
//      model to judge it, it is a hint, not a gate. So every test below is mechanical.
//   2. A gate that has never gone red is not known to work. Each check has a negative
//      test that drives it to FAIL, not just a happy path.
//
// (npm test builds dist/ first.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpanTable } from '../dist/attest/segmenter.js';
import { gateQuotes, gateFields, countStrayQuotes } from '../dist/attest/quote-gate.js';
import { renderQuotes, quoteLookup } from '../dist/attest/quote-extract.js';
import { checkFactsCited } from '../dist/attest/facts-cited.js';
import { checkContract } from '../dist/attest/contract.js';

const SOURCE = 'Pricing was the blocker. We churned in Q3 after the renewal.';
const build = () => buildSpanTable([{ id: 'doc', label: 'doc', detail: SOURCE }]);
const fetched = new Set(['doc']);

// ── substitution ────────────────────────────────────────────────────────────────

test('a placed quote is the source bytes, not the model text', () => {
  const { table } = build();
  const r = renderQuotes('The blocker: {{q:doc@s0}}', table);
  assert.equal(r.used.length, 1);
  assert.equal(r.used[0].text, 'Pricing was the blocker.');
  assert.ok(SOURCE.includes(r.used[0].text));
  assert.match(r.rendered, /“Pricing was the blocker\.” \uE000\[doc@s0\]\uE000/);
});

test('an invented span id is surfaced, never silently dropped', () => {
  const { table } = build();
  const r = renderQuotes('As stated: {{q:doc@s99}}', table);
  assert.deepEqual(r.missing, ['doc@s99']);
  assert.match(r.rendered, /\[\[MISSING QUOTE: doc@s99\]\]/);
});

test('quoteLookup returns an explicit miss rather than a guess', () => {
  const { table } = build();
  assert.equal(quoteLookup(table, 'doc@s0'), 'Pricing was the blocker.');
  assert.equal(quoteLookup(table, 'doc@s404'), null);
});

// ── closed surface ──────────────────────────────────────────────────────────────

test('a clean run passes and reports what it grounded', () => {
  const { table } = build();
  const v = gateQuotes('Pricing drove the loss: {{q:doc@s0}}', table, fetched);
  assert.equal(v.pass, true);
  assert.equal(v.verified, true);
  assert.equal(v.grounded, true);
  assert.equal(v.matched, 1);
  assert.match(v.summary, /^VERBATIM/);
});

test('NEGATIVE - a typed double quote fails the run', () => {
  const { table } = build();
  const v = gateQuotes('They said "pricing was the blocker" in the call.', table, fetched);
  assert.equal(v.pass, false);
  assert.equal(v.verified, false);
  assert.ok(v.strayQuotes >= 2);
  assert.match(v.summary, /^FAILED/);
});

test('NEGATIVE - a typed curly quote fails too', () => {
  const { table } = build();
  assert.equal(gateQuotes('They said “pricing”.', table, fetched).verified, false);
});

test('NEGATIVE - an invented span id fails the run', () => {
  const { table } = build();
  const v = gateQuotes('{{q:doc@s99}}', table, fetched);
  assert.equal(v.pass, false);
  assert.deepEqual(v.missing, ['doc@s99']);
});

test('NEGATIVE - quoting a source this run never read fails the run', () => {
  const { table } = build();
  const v = gateQuotes('{{q:doc@s0}}', table, new Set(['some-other-doc']));
  assert.equal(v.pass, false);
  assert.deepEqual(v.drifted, ['doc@s0']);
  assert.match(v.summary, /unfetched/);
});

test('NEGATIVE - a clean surface that grounds nothing is not a pass', () => {
  const { table } = build();
  const v = gateQuotes('Pricing was probably the issue.', table, fetched);
  assert.equal(v.verified, true, 'no breach occurred');
  assert.equal(v.grounded, false, 'but nothing was grounded');
  assert.equal(v.pass, false);
  assert.match(v.summary, /^NO QUOTES PLACED/);
});

test('a contraction is not a quote; a single-quoted span is', () => {
  assert.equal(countStrayQuotes("we don't see a moat and Karbon's price held"), 0);
  assert.equal(countStrayQuotes("he said 'we don't see a moat' on the call"), 1);
});

test('the token itself introduces no quote marks', () => {
  assert.equal(countStrayQuotes('grounded here: {{q:doc@s0}} and here: {{q:doc@s1}}'), 0);
});

test('a quote mark inside the SOURCE never trips the gate', () => {
  // The breach test reads the raw output, where the source bytes are not yet present.
  const detail = 'He called it "the category leader" on the record.';
  const { table } = buildSpanTable([{ id: 'd', label: 'd', detail }]);
  const v = gateQuotes('On the record: {{q:d@s0}}', table, new Set(['d']));
  assert.equal(v.pass, true, 'a nested source quote must not read as a model breach');
  assert.match(v.render.rendered, /the category leader/);
});

// ── cite vs quote ───────────────────────────────────────────────────────────────

test('a cite attributes without placing source text', () => {
  const { table } = build();
  const r = renderQuotes('Pricing drove it {{c:doc@s0}}.', table);
  assert.deepEqual(r.cited, ['doc@s0']);
  assert.equal(r.used.length, 0, 'a cite must not place source bytes');
  assert.equal(r.rendered, 'Pricing drove it \uE000[doc@s0]\uE000.');
  assert.ok(!r.rendered.includes('Pricing was the blocker'), 'a cite spliced the quote text in');
});

test('cite and quote coexist in one string', () => {
  const { table } = build();
  const r = renderQuotes('Churn rose {{c:doc@s0}}. Evidence: {{q:doc@s1}}', table);
  assert.deepEqual(r.cited, ['doc@s0']);
  assert.equal(r.used.length, 1);
  assert.equal(r.used[0].text, 'We churned in Q3 after the renewal.');
});

test('NEGATIVE - an invented cite id fails the run like an invented quote id', () => {
  const { table } = build();
  const v = gateQuotes('Stated here {{c:doc@s99}}. {{q:doc@s0}}', table, fetched);
  assert.equal(v.pass, false);
  assert.deepEqual(v.missing, ['doc@s99']);
});

test('NEGATIVE - citing a source this run never read fails the run', () => {
  const { table } = build();
  const v = gateQuotes('Stated here {{c:doc@s0}}', table, new Set(['other']));
  assert.equal(v.pass, false);
  assert.deepEqual(v.drifted, ['doc@s0']);
});

test('cites do not inflate the verbatim score', () => {
  const { table } = build();
  const v = gateQuotes('{{c:doc@s0}} {{c:doc@s1}}', table, fetched);
  assert.equal(v.total, 0, 'cites counted as quotes');
  assert.equal(v.grounded, false, 'citing without quoting is not grounding');
  assert.equal(v.pass, false);
});

// ── answer shape ────────────────────────────────────────────────────────────────
//
// The contract gate is driven by the check set, so these pass an explicit config. The
// config-permutation cases live in attest-phase1.test.mjs; what is tested here is the
// evidence-integrity half, which is the part that decides whether a blockquote in the
// report can be trusted.

const SHAPE_CFG = {
  items: { min: 1, max: 5 },
  minClaimWords: 0,
  checks: new Set(['quotes-in-evidence']),
  args: new Map(),
};
const SRC = new Set(['doc']);
const shapeOf = (items) => checkContract(items, SHAPE_CFG, SRC);

test('a well-shaped answer passes: claims in prose, quotes in evidence', () => {
  const r = shapeOf([
    { headline: 'Pricing drove the loss', body: 'They churned {{c:doc@s0}}.', evidence: ['{{q:doc@s0}}'] },
  ]);
  assert.equal(r.pass, true, r.summary);
  assert.match(r.summary, /^SHAPE -/);
});

test('NEGATIVE - a quote token inside the claim fails the shape check', () => {
  // The documented shortcut: make the fetched span BE the sentence, and every quote gate
  // stays green while the answer contains no reasoning at all.
  const r = shapeOf([
    { headline: 'Acme is a {{q:doc@s0}}', body: 'As above.', evidence: ['{{q:doc@s0}}'] },
  ]);
  assert.equal(r.pass, false);
  assert.deepEqual(r.quotesInBody, [1]);
});

test('NEGATIVE - an item with no evidence is ungrounded', () => {
  const r = shapeOf([{ headline: 'A claim', body: 'Some prose.', evidence: [] }]);
  assert.equal(r.pass, false);
  assert.deepEqual(r.ungrounded, [1]);
});

test('NEGATIVE - a typed evidence entry is caught before it renders as a quotation', () => {
  // The report blockquotes every evidence string. An entry with no token carries no quote
  // marks, so the closed-surface check is clean, and a sibling entry that does carry a
  // token grounds the run - so the reader sees invented text presented as sourced evidence
  // beneath a green receipt. Nothing else catches this.
  const r = shapeOf([
    {
      headline: 'Integrations were the problem',
      body: 'They said so {{c:doc@s0}}.',
      evidence: ['{{q:doc@s0}}', 'The team also said integrations were broken'],
    },
  ]);
  assert.equal(r.pass, false);
  assert.deepEqual(r.freeTypedEvidence, ['1.2']);
});

test('NEGATIVE - prose smuggled in FRONT of a real quote is caught', () => {
  const r = shapeOf([
    { headline: 'A claim', body: 'Prose.', evidence: ['They admitted {{q:doc@s0}}'] },
  ]);
  assert.equal(r.pass, false, 'an entry must LEAD with the token, not merely contain one');
});

test('NEGATIVE - prose appended AFTER the quote is caught too', () => {
  // Leading-token-only was not enough: `{{q:...}} and the CFO added that renewals
  // collapsed by half` passed, then rendered as one blockquote whose second clause exists
  // in no source, under a green VERBATIM receipt.
  const r = shapeOf([
    {
      headline: 'A claim',
      body: 'Prose.',
      evidence: ['{{q:doc@s0}} and the CFO added that renewals collapsed by half'],
    },
  ]);
  assert.equal(r.pass, false);
  assert.deepEqual(r.freeTypedEvidence, ['1.1']);
});

test('several tokens in one entry are fine; anything else is not', () => {
  assert.equal(shapeOf([{ headline: 'A', body: 'B', evidence: ['{{q:doc@s0}} {{q:doc@s1}}'] }]).pass, true);
  assert.equal(shapeOf([{ headline: 'A', body: 'B', evidence: ['{{q:doc@s0}} - Dana Okafor, CFO'] }]).pass, false,
    'a trailing tag cannot be told apart from a fabricated clause, so it is refused');
});

test('a cite in the body is fine - that is what cites are for', () => {
  const r = shapeOf([
    { headline: 'ARR grew {{c:doc@s0}}', body: 'To $12.4M {{c:doc@s0}}.', evidence: ['{{q:doc@s0}}'] },
  ]);
  assert.equal(r.pass, true);
});

// ── per-field gating (the verdict must describe the printed document) ────────────

test('NEGATIVE - a token split across two fields resolves in neither', () => {
  // Gating the joined string reports 1/1 placed, while the printed report contains no
  // quote and a raw token fragment. The receipt has to describe what is printed.
  const { table } = build();
  const { verdict, rendered } = gateFields(
    ['Pricing killed it {{q:doc@s0', '}} and we churned.'],
    table,
    fetched,
  );
  assert.equal(verdict.pass, false, 'a split token was treated as a placed quote');
  assert.equal(verdict.total, 0);
  assert.equal(rendered[0], 'Pricing killed it {{q:doc@s0');
});

test('gateFields returns exactly the strings the reader sees', () => {
  const { table } = build();
  const { verdict, rendered } = gateFields(['Claim here.', '{{q:doc@s0}}'], table, fetched);
  assert.equal(verdict.pass, true);
  assert.equal(rendered.length, 2);
  assert.match(rendered[1], /“Pricing was the blocker\.”/);
  assert.equal(rendered[0], 'Claim here.', 'a field with no tokens must pass through unchanged');
});

test('gateFields still catches a breach in any single field', () => {
  const { table } = build();
  const { verdict } = gateFields(['{{q:doc@s0}}', 'They said "hi"'], table, fetched);
  assert.equal(verdict.pass, false);
  assert.ok(verdict.strayQuotes >= 2);
});

// ── quantitative claims ─────────────────────────────────────────────────────────

test('a cited figure passes - with either token', () => {
  for (const tok of ['{{q:doc@s0}}', '{{c:doc@s0}}']) {
    const r = checkFactsCited(`ARR reached $4.8M last year ${tok}.`);
    assert.equal(r.pass, true, `${tok} did not attribute the figure`);
    assert.equal(r.facts, 1);
    assert.equal(r.cited, 1);
  }
});

test('NEGATIVE - a figure the quote gate cannot see is caught here', () => {
  // No quotation marks anywhere, so the quote gate is clean. The number is still
  // unattributed, and that is exactly the gap this check exists to close.
  const raw = 'ARR reached $4.8M last year.';
  const { table } = build();
  assert.equal(gateQuotes(raw, table, fetched).verified, true);

  const r = checkFactsCited(raw);
  assert.equal(r.pass, false);
  assert.equal(r.uncited.length, 1);
  assert.match(r.summary, /^UNATTRIBUTED/);
});

test('currency, percentages, years and grouped numbers all count as claims', () => {
  const r = checkFactsCited('Revenue $1.2M, up 30%, in 2024, across 1,200 accounts.');
  assert.equal(r.facts, 4);
  assert.equal(r.cited, 0);
});

test('a citation on the next line does not cover this line', () => {
  const r = checkFactsCited('Revenue was $4.8M\nSomething else {{q:doc@s0}}');
  assert.equal(r.pass, false, 'a citation on another line must not attribute this figure');
});

test('a citation two sentences later does not cover the figure', () => {
  const r = checkFactsCited('Revenue was $4.8M. That mattered. See here {{q:doc@s0}}.');
  assert.equal(r.pass, false);
});

test('a decimal point does not end the sentence scope', () => {
  const r = checkFactsCited('Margin was 62.5% {{q:doc@s0}}.');
  assert.equal(r.pass, true, 'the decimal in 62.5 truncated the scope');
});

test('NEGATIVE - a derived figure with a citation is caught as unsupported', () => {
  // The source states 240 and 186. "29%" is the model's own arithmetic presented as a
  // sourced fact - no quotation marks, so the quote gate sees nothing wrong, and a
  // citation IS present, so a presence-only check passes it too. Observed live.
  const table = new Map([['h@s0', { text: 'the headcount plan is 240 by year end, from 186 today' }]]);
  const raw = 'Headcount growing 29% to 240 by year end {{c:h@s0}}';
  const r = checkFactsCited(raw, table);
  assert.equal(r.pass, false);
  assert.ok(
    r.unsupported.some((u) => u.includes('29%')),
    `expected 29% unsupported, got ${JSON.stringify(r.unsupported)}`,
  );
  // The figures the source does state are fine.
  assert.equal(r.uncited.length, 0);
});

test('a figure the cited span states is supported', () => {
  const table = new Map([['h@s0', { text: 'ARR closed Q3 at $12.4M, up from $9.1M a year ago.' }]]);
  const r = checkFactsCited('ARR reached $12.4M {{c:h@s0}}.', table);
  assert.equal(r.pass, true);
  assert.equal(r.cited, 1);
});

test('grouped-number formatting is not a different claim', () => {
  const table = new Map([['h@s0', { text: 'revenue of 1200 accounts' }]]);
  assert.equal(checkFactsCited('We saw 1,200 accounts {{c:h@s0}}.', table).pass, true);
});

test('a figure is not matched inside a longer number', () => {
  // "29" must not be considered stated by a source that says "1129" or "290".
  const table = new Map([['h@s0', { text: 'the count was 1129 and then 290' }]]);
  const r = checkFactsCited('Growth of 29% {{c:h@s0}}.', table);
  assert.equal(r.pass, false);
  assert.equal(r.unsupported.length, 1);
});

test('without a span table the check degrades to presence, and says so honestly', () => {
  // No table means the containment check cannot be made. It must not silently claim the
  // figure was traced - `cited` counts presence only, and `unsupported` stays empty.
  const r = checkFactsCited('Headcount growing 29% {{c:h@s0}}', undefined);
  assert.equal(r.pass, true);
  assert.deepEqual(r.unsupported, []);
});

test('the uncited snippet starts and ends on a word', () => {
  // A fixed-width window cuts mid-word, and `t is projected to grow by 29%` in a receipt
  // reads as the check malfunctioning rather than as the sentence it is quoting.
  const raw = 'Total headcount is projected to grow by approximately 29% from today across the org';
  const r = checkFactsCited(raw);
  assert.equal(r.uncited.length, 1);
  const snip = r.uncited[0];
  assert.ok(raw.includes(snip), 'the snippet should be a contiguous slice of the output');
  assert.ok(/^\S/.test(snip) && raw.split(/\s+/).includes(snip.split(/\s+/)[0]),
    `snippet starts mid-word: ${snip}`);
});

test('the uncited snippet reads as prose, not plumbing', () => {
  // The window is a fixed width, so it lands mid-token routinely. Debris like
  // `older:q3-call.md@s4}}` in a receipt makes the check look broken.
  const raw = 'a {{c:folder:q3-call.md@s4}} Headcount growing 29% to 240 by year end\nnext line';
  const r = checkFactsCited(raw);
  for (const u of r.uncited) {
    assert.ok(!u.includes('}}'), `token debris in snippet: ${u}`);
    assert.ok(!u.includes('{{'), `token debris in snippet: ${u}`);
  }
});

test('prose with no figures has nothing to attribute', () => {
  const r = checkFactsCited('Pricing was the blocker, and they churned.');
  assert.equal(r.facts, 0);
  assert.equal(r.pass, true);
  assert.match(r.summary, /No quantitative claims/);
});
