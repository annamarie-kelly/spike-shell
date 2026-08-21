// The reviewer↔coder negotiation state machine (src/web/converge.ts), tested as
// pure transitions — no pty, no Session, no DOM. This is where the loop's
// correctness lives: a finding must always march toward a terminal state, a
// standoff must escalate at the cap rather than bounce forever, and a lane's
// stale previous reply must never be misread as an answer to a re-ask.
// (npm test builds dist/ first.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markAsked, foldCoderVerdicts, foldReviewerVerdicts, composeCoderAsk, composeReviewerAsk, sweepStale } from '../dist/web/converge.js';
import { parseCoderVerdicts, parseReviewerVerdicts } from '../dist/web/chatview.js';

const finding = (over = {}) => ({ id: over.id || 'f' + Math.random().toString(36).slice(2), claim: 'c', severity: 'warn', state: 'open', bounces: 0, ...over });

// A monotonic counter, exactly like the Session's askSeq.
const counter = () => { let n = 0; return () => ++n; };

test('markAsked stamps a unique, monotonic number and bumps the turn', () => {
  const next = counter();
  const a = finding(), b = finding();
  markAsked([a, b], 'coder', next);
  assert.equal(a.askNum, 1); assert.equal(b.askNum, 2);
  assert.equal(a.awaiting, 'coder'); assert.equal(a.turn, 1);
  markAsked([a], 'reviewer', next);   // re-ask a → a fresh, higher number
  assert.equal(a.askNum, 3); assert.equal(a.awaiting, 'reviewer'); assert.equal(a.turn, 2);
});

test('coder accept settles; reject bounces to the reviewer under the cap', () => {
  const next = counter();
  const fs = [finding({ id: 'x' }), finding({ id: 'y' })];
  markAsked(fs, 'coder', next);   // #1, #2
  const { changed, toReviewer } = foldCoderVerdicts(fs, parseCoderVerdicts('#1 accept\n#2 reject: intentional'), { cap: 3, hasReviewer: true });
  assert.equal(changed, true);
  assert.equal(fs[0].state, 'accepted');
  assert.equal(fs[1].state, 'contested');
  assert.equal(fs[1].bounces, 1);
  assert.deepEqual(toReviewer.map((f) => f.id), ['y']);
});

test('with no reviewer, a rejected finding escalates immediately', () => {
  const next = counter();
  const fs = [finding()];
  markAsked(fs, 'coder', next);
  const { toReviewer } = foldCoderVerdicts(fs, parseCoderVerdicts('#1 reject: no'), { cap: 3, hasReviewer: false });
  assert.equal(fs[0].state, 'escalated');
  assert.equal(toReviewer.length, 0);
});

test('reviewer concede resolves; hold sends it back to the coder', () => {
  const next = counter();
  const fs = [finding({ id: 'a' }), finding({ id: 'b' })];
  markAsked(fs, 'coder', next);
  foldCoderVerdicts(fs, parseCoderVerdicts('#1 reject: r\n#2 counter: c'), { cap: 3, hasReviewer: true });
  markAsked(fs, 'reviewer', next);   // #3, #4
  const { backToCoder } = foldReviewerVerdicts(fs, parseReviewerVerdicts('#3 concede\n#4 hold: it still stands'));
  assert.equal(fs[0].state, 'resolved');           // conceded
  assert.equal(fs[1].awaiting, undefined);         // cleared, pending re-ask
  assert.equal(fs[1].reviewerNote, 'it still stands');
  assert.deepEqual(backToCoder.map((f) => f.id), ['b']);
});

test('a standoff escalates at the cap instead of bouncing again', () => {
  const next = counter();
  const f = finding();
  // Round 1: coder rejects (bounces 1) → reviewer holds → back to coder.
  markAsked([f], 'coder', next);
  foldCoderVerdicts([f], parseCoderVerdicts(`#${f.askNum} reject: a`), { cap: 3, hasReviewer: true });
  markAsked([f], 'reviewer', next);
  foldReviewerVerdicts([f], parseReviewerVerdicts(`#${f.askNum} hold: b`));
  // Round 2: coder rejects again (bounces 2) → reviewer holds → back.
  markAsked([f], 'coder', next);
  foldCoderVerdicts([f], parseCoderVerdicts(`#${f.askNum} reject: c`), { cap: 3, hasReviewer: true });
  markAsked([f], 'reviewer', next);
  foldReviewerVerdicts([f], parseReviewerVerdicts(`#${f.askNum} hold: d`));
  // Round 3: coder rejects a third time (bounces 3 == cap) → escalates, NOT bounced.
  markAsked([f], 'coder', next);
  const { toReviewer } = foldCoderVerdicts([f], parseCoderVerdicts(`#${f.askNum} reject: e`), { cap: 3, hasReviewer: true });
  assert.equal(f.bounces, 3);
  assert.equal(f.state, 'escalated');
  assert.equal(toReviewer.length, 0);
});

test("a lane's STALE reply (old askNums) is not misread as an answer to a re-ask", () => {
  const next = counter();
  const f = finding();
  markAsked([f], 'coder', next);                 // #1
  foldCoderVerdicts([f], parseCoderVerdicts('#1 reject: r'), { cap: 3, hasReviewer: true });
  markAsked([f], 'reviewer', next);              // #2
  foldReviewerVerdicts([f], parseReviewerVerdicts('#2 hold: h'));
  markAsked([f], 'coder', next);                 // now #3, awaiting coder again
  // The coder's transcript still shows its OLD "#1 reject" line. Folding it must
  // NOT touch f (its current number is 3, and #1 belongs to a settled ask).
  const { changed } = foldCoderVerdicts([f], parseCoderVerdicts('#1 reject: r'), { cap: 3, hasReviewer: true });
  assert.equal(changed, false);
  assert.equal(f.state, 'open');
  assert.equal(f.bounces, 1);   // unchanged — the stale reject didn't re-count
  // Its real answer, citing the current number, lands normally.
  foldCoderVerdicts([f], parseCoderVerdicts('#3 accept'), { cap: 3, hasReviewer: true });
  assert.equal(f.state, 'accepted');
});

test('a partial answer settles only what it names; the rest stays awaiting', () => {
  const next = counter();
  const fs = [finding({ id: 'a' }), finding({ id: 'b' }), finding({ id: 'c' })];
  markAsked(fs, 'coder', next);   // #1 #2 #3
  foldCoderVerdicts(fs, parseCoderVerdicts('#2 accept'), { cap: 3, hasReviewer: true });
  assert.equal(fs[1].state, 'accepted');
  assert.equal(fs[0].awaiting, 'coder');   // #1 still open
  assert.equal(fs[2].awaiting, 'coder');   // #3 still open
});

test('sweepStale escalates a side that has waited past the deadline, and only that', () => {
  const now = 1_000_000;
  const fresh = finding({ awaiting: 'coder', askedAt: now - 1000 });     // just asked
  const stale = finding({ awaiting: 'reviewer', askedAt: now - 99_999 }); // long overdue
  const settled = finding({ state: 'accepted', askedAt: now - 99_999 });  // terminal, not awaiting
  const escalated = sweepStale([fresh, stale, settled], now, 60_000);
  assert.deepEqual(escalated.map((f) => f.id), [stale.id]);
  assert.equal(stale.state, 'escalated');
  assert.equal(stale.awaiting, undefined);
  assert.match(stale.reviewerNote, /timed out/);
  assert.equal(fresh.state, 'open');       // still within the window
  assert.equal(settled.state, 'accepted'); // terminal is left alone
});

test('sweepStale never touches a finding that was never asked (no askedAt)', () => {
  const f = finding({ awaiting: 'coder' });   // awaiting but no askedAt
  assert.deepEqual(sweepStale([f], 9e9, 1000), []);
  assert.equal(f.state, 'open');
});

// A full negotiation driven the way the app drives it: compose the message an
// agent SEES, derive its reply by citing the very numbers that message shows,
// parse that reply back, fold it. This is the contract the live loop depends on
// — that composeCoderAsk's `#N` and parseCoderVerdicts' `#N` are the same N —
// which the per-step tests above assume but never prove end to end.
test('round-trip: a two-round convergence settles every finding to a terminal state', () => {
  const next = counter();
  const fs = [
    finding({ id: 'null', claim: 'null deref' }),
    finding({ id: 'perf', claim: 'n^2 loop' }),
    finding({ id: 'name', claim: 'bad name' }),
  ];
  // Round 1 — ask the coder. Reply by citing the numbers the message actually shows.
  markAsked(fs, 'coder', next);
  const ask1 = composeCoderAsk(fs);
  const num = (id) => fs.find((f) => f.id === id).askNum;
  const reply1 = [
    `#${num('null')} accept`,
    `#${num('perf')} reject: it's bounded to 8 items`,
    `#${num('name')} counter: rename to total`,
  ].join('\n');
  // sanity: the reply cites numbers that are really in the composed ask
  for (const n of [num('null'), num('perf'), num('name')]) assert.match(ask1, new RegExp(`#${n}\\b`));
  const r1 = foldCoderVerdicts(fs, parseCoderVerdicts(reply1), { cap: 3, hasReviewer: true });
  assert.equal(fs[0].state, 'accepted');
  assert.deepEqual(r1.toReviewer.map((f) => f.id).sort(), ['name', 'perf']);

  // Round 2 — the reviewer reconsiders the two contested ones.
  markAsked(r1.toReviewer, 'reviewer', next);
  composeReviewerAsk(r1.toReviewer);
  const reply2 = [
    `#${num('perf')} concede`,
    `#${num('name')} hold: total shadows an existing symbol`,
  ].join('\n');
  const r2 = foldReviewerVerdicts(fs, parseReviewerVerdicts(reply2));
  assert.equal(fs[1].state, 'resolved');                 // perf: reviewer conceded
  assert.deepEqual(r2.backToCoder.map((f) => f.id), ['name']);

  // Round 3 — 'name' goes back to the coder, who accepts the reviewer's point.
  markAsked(r2.backToCoder, 'coder', next);
  const reply3 = `#${num('name')} accept`;
  foldCoderVerdicts(fs, parseCoderVerdicts(reply3), { cap: 3, hasReviewer: true });
  assert.equal(fs[2].state, 'accepted');

  // Everything reached a terminal state; nothing is left awaiting anyone.
  assert.ok(fs.every((f) => ['accepted', 'resolved', 'escalated'].includes(f.state)));
  assert.ok(fs.every((f) => !f.awaiting));
});

test('compose messages carry the numbers and the round framing', () => {
  const next = counter();
  const fresh = [finding({ file: 'a.ts', line: 3, claim: 'bug', suggestion: 'fix it' })];
  markAsked(fresh, 'coder', next);
  const first = composeCoderAsk(fresh);
  assert.match(first, /A reviewer flagged/);
  assert.match(first, /#1 \[warn\] \(a\.ts:3\) bug/);
  assert.match(first, /suggested: fix it/);
  // A re-ask (bounced once, with a reviewer hold note) reframes and carries it.
  const held = [finding({ claim: 'x', bounces: 1, reviewerNote: 'still wrong' })];
  markAsked(held, 'coder', next);
  const again = composeCoderAsk(held);
  assert.match(again, /reviewer reconsidered and is holding/);
  assert.match(again, /reviewer still holds: still wrong/);
  // The reviewer ask relays the coder's pushback.
  const contested = [finding({ claim: 'y', verdict: 'reject', reply: 'by design' })];
  markAsked(contested, 'reviewer', next);
  const rev = composeReviewerAsk(contested);
  assert.match(rev, /concede/); assert.match(rev, /hold/);
  assert.match(rev, /coder rejects: by design/);
});
