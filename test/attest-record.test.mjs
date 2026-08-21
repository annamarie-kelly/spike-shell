// The run record answers one question the harness could not previously answer: does the
// report I shipped last week still say something true about the sources it cites?
//
// Every case here is a way a citation can rot. The important distinction is between an
// edit that happened to touch a cited quote and one that did not - a check that cried
// DRIFTED on any file change would be ignored within a week.
//
// (npm test builds dist/ first.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecord, checkDrift, renderDrift } from '../dist/attest/record.js';
import { buildSpanTable } from '../dist/attest/segmenter.js';

const DETAIL = 'Pricing was the blocker on the renewal.\nARR closed at $12.4M this quarter.';

function makeRecord(detail = DETAIL, placed = ['folder:call.md@s0']) {
  const refs = [{ id: 'folder:call.md', label: 'call.md', detail }];
  const { table } = buildSpanTable(refs);
  return {
    record: buildRecord({
      at: '2026-08-05T12:00:00Z',
      task: 'What happened?',
      checkSetName: 'Test',
      model: 'haiku',
      pass: true,
      verdict: { quotes: 'VERBATIM - 1/1', shape: 'SHAPE - 1', figures: 'none' },
      sources: [{ id: 'folder:call.md', hash: 'H1', cited: true }],
      placedSpanIds: placed,
      table,
    }),
    table,
  };
}

test('a record captures the exact bytes each citation placed', () => {
  const { record } = makeRecord();
  assert.equal(record.spans.length, 1);
  assert.equal(record.spans[0].text, 'Pricing was the blocker on the renewal.');
  assert.ok(DETAIL.includes(record.spans[0].text));
});

test('a record is stable, so two identical runs produce identical records', () => {
  const a = makeRecord(DETAIL, ['folder:call.md@s1', 'folder:call.md@s0', 'folder:call.md@s0']);
  const b = makeRecord(DETAIL, ['folder:call.md@s0', 'folder:call.md@s1']);
  assert.deepEqual(a.record.spans, b.record.spans, 'records should dedupe and sort');
});

test('an unchanged source is INTACT', () => {
  const { record } = makeRecord();
  const drift = checkDrift(record, new Map([['folder:call.md', { text: DETAIL, hash: 'H1' }]]));
  assert.equal(drift.intact, true);
  assert.match(drift.summary, /^INTACT/);
});

test('an edit elsewhere in the file does not cry drift', () => {
  // The distinction that decides whether anyone keeps this check switched on. The second
  // line changed; the cited quote is untouched and still honest.
  const { record } = makeRecord();
  const edited = 'Pricing was the blocker on the renewal.\nARR closed at $13.1M this quarter.';
  const drift = checkDrift(record, new Map([['folder:call.md', { text: edited, hash: 'H2' }]]));
  assert.equal(drift.intact, true, drift.summary);
});

test('NEGATIVE - a cited quote that was rewritten is caught as gone', () => {
  const { record } = makeRecord();
  const rewritten = 'Packaging was the blocker on the renewal.\nARR closed at $12.4M this quarter.';
  const drift = checkDrift(record, new Map([['folder:call.md', { text: rewritten, hash: 'H2' }]]));
  assert.equal(drift.intact, false);
  assert.equal(drift.findings[0].kind, 'span-gone');
  assert.match(drift.summary, /no longer in the source/);
});

test('NEGATIVE - a quote that only MOVED is reported differently from one that is gone', () => {
  // Text prepended: the quote is still in the document, at a different offset. That is a
  // weaker finding than a deleted quote and must not read the same.
  const { record } = makeRecord();
  const shifted = `A new opening line.\n${DETAIL}`;
  const drift = checkDrift(record, new Map([['folder:call.md', { text: shifted, hash: 'H2' }]]));
  assert.equal(drift.intact, false);
  assert.equal(drift.findings[0].kind, 'span-moved');
  assert.match(drift.summary, /moved but still present/);
});

test('NEGATIVE - a deleted source invalidates every citation to it', () => {
  const { record } = makeRecord();
  const drift = checkDrift(record, new Map());
  assert.equal(drift.intact, false);
  assert.equal(drift.findings[0].kind, 'source-missing');
});

test('the drift block names the affected span and what the report claims', () => {
  const { record } = makeRecord();
  const rewritten = 'Packaging was the blocker.\nARR closed at $12.4M this quarter.';
  const drift = checkDrift(record, new Map([['folder:call.md', { text: rewritten, hash: 'H2' }]]));
  const md = renderDrift(record, drift);
  assert.match(md, /## Drift check/);
  assert.match(md, /folder:call\.md@s0/);
  assert.match(md, /no longer in the source/);
  assert.match(md, /Pricing was the blocker/, 'the reader needs to see what the report claimed');
});

test('an intact drift block stays short - nothing to act on', () => {
  const { record } = makeRecord();
  const drift = checkDrift(record, new Map([['folder:call.md', { text: DETAIL, hash: 'H1' }]]));
  const md = renderDrift(record, drift);
  assert.ok(!md.includes('| span |'), 'no table when there is nothing to report');
  assert.match(md, /INTACT/);
});

test('a record stores no source text, only hashes and what it placed', () => {
  // A report should not carry a copy of every document it cites: that is a privacy and
  // size problem nobody asked for. Hash plus placed text is enough to detect drift.
  const { record } = makeRecord();
  const json = JSON.stringify(record);
  assert.ok(!json.includes('ARR closed at $12.4M'), 'an uncited line leaked into the record');
  assert.ok(json.includes('Pricing was the blocker'), 'the placed quote must be recorded');
});
