// The lane-exchange controller (src/web/lane-controller.ts), driven end-to-end
// through a fake lane — no pty, no DOM. This is the proof we could not get before:
// the FULL review loop (deliver a message → read the reply out of a transcript →
// fold it → deliver the next), exercised deterministically. The pure protocol is
// covered in converge.test.mjs; this covers the orchestration wrapped around it.
// (npm test builds dist/ first.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LaneReviewExchange } from '../dist/web/lane-controller.js';

const finding = (over = {}) => ({ id: over.id, claim: over.claim || 'c', severity: 'warn', state: 'open', bounces: 0, ...over });

// A lane the controller talks to, with no process behind it. `deliver` captures
// the outgoing message; `readTranscript` replays whatever the test has scripted as
// this lane's transcript so far (real Claude JSONL, since a real ChatStream parses it).
class FakeLane {
  constructor(id, { alive = true } = {}) {
    this.id = id; this.name = id; this.engine = 'claude';
    this._alive = alive; this.sent = []; this._lines = [];
  }
  isAlive() { return this._alive; }
  kill() { this._alive = false; }
  deliver(text) { this.sent.push(text); return this._alive && !this._deliverFails; }
  failDelivery() { this._deliverFails = true; }
  async readTranscript(offset) {
    return { found: this._lines.length > 0, reset: false, lines: this._lines.slice(offset), offset: this._lines.length };
  }
  // ── scripting helpers ──
  _push(row) { this._lines.push(JSON.stringify(row)); }
  user(text) { this._push({ type: 'user', message: { role: 'user', content: text } }); }
  agent(text) { this._push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }); }
  /** A realistic round: the injected ask lands as a user turn, then the reply. */
  round(reply) { this.user('(review ask)'); this.agent(reply); }
}

// Build a controller with injected clock + a no-op timer (tests step tick() by hand).
function makeExchange(coder, reviewer, opts = {}) {
  const clock = { t: 1000 };
  let changes = 0;
  const ex = new LaneReviewExchange({
    coder, reviewer,
    onChange: () => { changes++; },
    now: () => clock.t,
    cap: opts.cap ?? 3,
    timeoutMs: opts.timeoutMs ?? 60_000,
    tickMs: 2000,
    schedule: () => 'timer',   // truthy token; the real interval never fires in tests
    cancel: () => {},
  });
  return { ex, clock, changes: () => changes };
}
const askNumOf = (ex, id) => ex.findings.find((f) => f.id === id).askNum;

test('a review is asked of the coder as a numbered message', () => {
  const coder = new FakeLane('coder'), reviewer = new FakeLane('reviewer');
  const { ex } = makeExchange(coder, reviewer);
  ex.receiveReview([finding({ id: 'a', claim: 'null deref' }), finding({ id: 'b', claim: 'n^2' })]);
  assert.equal(coder.sent.length, 1);
  assert.match(coder.sent[0], /#1 \[warn\].*null deref/);
  assert.match(coder.sent[0], /#2 \[warn\].*n\^2/);
  assert.equal(ex.findings.every((f) => f.awaiting === 'coder'), true);
});

test('full round-trip: accept settles, reject bounces to reviewer, hold returns, then accept', async () => {
  const coder = new FakeLane('coder'), reviewer = new FakeLane('reviewer');
  const { ex } = makeExchange(coder, reviewer);
  ex.receiveReview([finding({ id: 'a' }), finding({ id: 'b' })]);
  const a1 = askNumOf(ex, 'a'), b1 = askNumOf(ex, 'b');

  // Coder accepts a, rejects b.
  coder.round(`#${a1} accept\n#${b1} reject: intentional`);
  await ex.tick();
  assert.equal(ex.findings.find((f) => f.id === 'a').state, 'accepted');
  assert.equal(reviewer.sent.length, 1, 'the reviewer was asked to reconsider b');
  assert.match(reviewer.sent[0], /concede|hold/);
  const bRev = askNumOf(ex, 'b');

  // Reviewer holds → b goes back to the coder with a fresh number.
  reviewer.round(`#${bRev} hold: still wrong on the empty path`);
  await ex.tick();
  const bBack = askNumOf(ex, 'b');
  assert.notEqual(bBack, bRev, 'a re-ask gets a new askNum');
  assert.equal(ex.findings.find((f) => f.id === 'b').awaiting, 'coder');
  assert.equal(coder.sent.length, 2, 'the coder was re-asked');

  // Coder now accepts b → everything terminal.
  coder.round(`#${bBack} accept`);
  await ex.tick();
  assert.equal(ex.findings.find((f) => f.id === 'b').state, 'accepted');
  assert.ok(ex.findings.every((f) => !f.awaiting), 'nothing left awaiting anyone');
});

test('a standoff escalates at the cap instead of bouncing forever', async () => {
  const coder = new FakeLane('coder'), reviewer = new FakeLane('reviewer');
  const { ex } = makeExchange(coder, reviewer, { cap: 2 });
  ex.receiveReview([finding({ id: 'x' })]);

  coder.round(`#${askNumOf(ex, 'x')} reject: no`);       // bounce 1 → reviewer
  await ex.tick();
  reviewer.round(`#${askNumOf(ex, 'x')} hold: yes`);      // back to coder
  await ex.tick();
  coder.round(`#${askNumOf(ex, 'x')} reject: still no`);  // bounce 2 == cap → escalate
  await ex.tick();

  assert.equal(ex.findings[0].state, 'escalated');
  assert.equal(reviewer.sent.length, 1, 'it did NOT bounce to the reviewer a second time');
});

test('reviewer concede resolves the finding (coder keeps its approach)', async () => {
  const coder = new FakeLane('coder'), reviewer = new FakeLane('reviewer');
  const { ex } = makeExchange(coder, reviewer);
  ex.receiveReview([finding({ id: 'a' })]);
  coder.round(`#${askNumOf(ex, 'a')} reject: by design`);
  await ex.tick();
  reviewer.round(`#${askNumOf(ex, 'a')} concede`);
  await ex.tick();
  assert.equal(ex.findings[0].state, 'resolved');
});

test('a reviewer dead at fold time escalates the standoff, never strands it', async () => {
  const coder = new FakeLane('coder'), reviewer = new FakeLane('reviewer');
  const { ex } = makeExchange(coder, reviewer);
  ex.receiveReview([finding({ id: 'a' })]);
  reviewer.kill();   // gone before the coder answers → treated as no reviewer
  coder.round(`#${askNumOf(ex, 'a')} reject: mine is fine`);
  await ex.tick();
  assert.equal(ex.findings[0].state, 'escalated');
  assert.equal(reviewer.sent.length, 0, 'nothing sent into a dead lane');
});

test('a reviewer that dies mid-delivery escalates with a reason, never strands it', async () => {
  const coder = new FakeLane('coder'), reviewer = new FakeLane('reviewer');
  const { ex } = makeExchange(coder, reviewer);
  ex.receiveReview([finding({ id: 'a' })]);
  reviewer.failDelivery();   // alive at the fold, but the write fails (pty raced away)
  coder.round(`#${askNumOf(ex, 'a')} reject: mine is fine`);
  await ex.tick();
  assert.equal(ex.findings[0].state, 'escalated');
  assert.match(ex.findings[0].reviewerNote, /no longer available/);
});

test('with no reviewer at all, a rejected finding escalates immediately', async () => {
  const coder = new FakeLane('coder');
  const { ex } = makeExchange(coder, null);
  ex.receiveReview([finding({ id: 'a' })]);
  coder.round(`#${askNumOf(ex, 'a')} reject: no`);
  await ex.tick();
  assert.equal(ex.findings[0].state, 'escalated');
});

test('a side that never answers is timed out and escalated', async () => {
  const coder = new FakeLane('coder'), reviewer = new FakeLane('reviewer');
  const { ex, clock } = makeExchange(coder, reviewer, { timeoutMs: 60_000 });
  ex.receiveReview([finding({ id: 'a' })]);
  await ex.tick();                       // coder silent, still inside window
  assert.equal(ex.findings[0].state, 'open');
  clock.t += 61_000;                     // past the deadline
  await ex.tick();
  assert.equal(ex.findings[0].state, 'escalated');
  assert.match(ex.findings[0].reviewerNote, /timed out/);
});

test('a stale reply citing an old askNum never re-triggers a settled round', async () => {
  const coder = new FakeLane('coder'), reviewer = new FakeLane('reviewer');
  const { ex } = makeExchange(coder, reviewer);
  ex.receiveReview([finding({ id: 'a' })]);
  const first = askNumOf(ex, 'a');
  // No user turn between replies, so the OLD reply stays visible in "agent text
  // since last user" — only the monotonic askNum protects us.
  coder.agent(`#${first} reject: r`);
  await ex.tick();
  reviewer.agent(`#${askNumOf(ex, 'a')} hold: h`);
  await ex.tick();
  const reasked = askNumOf(ex, 'a');
  assert.notEqual(reasked, first);
  const bounces = ex.findings[0].bounces;
  // The coder's transcript still shows "#first reject". Another tick must NOT
  // re-count it against the re-asked finding (whose number is now `reasked`).
  await ex.tick();
  assert.equal(ex.findings[0].bounces, bounces, 'the stale reject was not re-counted');
  assert.equal(ex.findings[0].awaiting, 'coder');
  // The real answer, citing the current number, lands.
  coder.agent(`#${reasked} accept`);
  await ex.tick();
  assert.equal(ex.findings[0].state, 'accepted');
});

test('your tiebreak on an escalated finding settles it and instructs the coder', async () => {
  const coder = new FakeLane('coder');
  const { ex } = makeExchange(coder, null);
  ex.receiveReview([finding({ id: 'a' })]);
  coder.round(`#${askNumOf(ex, 'a')} reject: no`);
  await ex.tick();
  assert.equal(ex.findings[0].state, 'escalated');
  const before = coder.sent.length;
  ex.resolveFinding('a', 'reviewer');
  assert.equal(ex.findings[0].state, 'resolved');
  assert.equal(coder.sent.length, before + 1);
  assert.match(coder.sent[coder.sent.length - 1], /apply the suggested fix/);
});
