// lane-controller.ts — the reusable machinery for one lane talking to another.
//
// The reviewer↔coder convergence loop was born tangled into the Session class:
// message delivery, transcript reading, timers, correlation, and ownership all
// lived on a lane. But none of that is Session-specific — it's a turn-taking
// message channel between two lanes, of which code review is the first protocol.
// This module extracts that channel so it can be tested without a pty or the DOM
// (see test/lane-controller.test.mjs) and, later, carry other protocols.
//
// The split, deliberately:
//   • converge.ts   — the review PROTOCOL: compose the message, fold a reply,
//                     time-out policy. Pure, unchanged, unit-tested on its own.
//   • LaneHandle    — a lane's IO, reduced to what a controller needs: deliver a
//                     message, read the transcript, is-it-alive. Session implements
//                     it; the test's FakeLane implements it too.
//   • LaneReviewExchange — this file: owns the findings, the correlation counter,
//                     one reader per lane, and the tick that advances the loop.
//
// Everything here is engine-neutral and side-effect-injected (now/schedule), so a
// test drives a full multi-round negotiation deterministically.

import type { Engine, Finding, Turn } from './chatview';
import { ChatStream, parseCoderVerdicts, parseReviewerVerdicts } from './chatview';
import * as converge from './converge';

/** One incremental read of a lane's transcript — the shape ipc.transcriptTail returns. */
export interface TranscriptChunk {
  found: boolean;
  reset?: boolean;
  lines: string[];
  offset: number;
}

/**
 * A controller's thin view of a lane. The handle wraps IO only; the controller
 * owns all reader offsets and correlation state, so a lane needn't know it's part
 * of an exchange.
 */
export interface LaneHandle {
  readonly id: string;              // the address — a lane's ptyId in v1
  readonly name: string;
  readonly engine: Engine;
  isAlive(): boolean;
  /** Queue a message into the lane (bracketed, one-at-a-time). True = lane is live. */
  deliver(text: string): boolean;
  /** Read new transcript lines since `offset`. */
  readTranscript(offset: number): Promise<TranscriptChunk>;
}

export interface LaneReviewDeps {
  coder: LaneHandle;
  reviewer: LaneHandle | null;
  /** Repaint hook — the Session passes renderChat; a test can pass a spy. */
  onChange: () => void;
  /** Clock, injected so timeouts are testable. */
  now: () => number;
  cap: number;
  timeoutMs: number;
  tickMs: number;
  /** Timer seam, injected so tests don't spin real intervals. */
  schedule?: (fn: () => void, ms: number) => any;
  cancel?: (handle: any) => void;
}

/**
 * All agent text since the last thing the person (or an injected ask) said. A
 * reply to a review can span several turns — a "working on it" line, tool calls,
 * then the `#N` verdicts — so reading only the final turn drops the verdicts when
 * they land earlier. The monotonic askNum guards against re-reading a stale round,
 * so widening the window is safe.
 */
export function agentTextSinceLastUser(turns: Turn[]): string {
  let start = 0;
  for (let i = turns.length - 1; i >= 0; i--) { if (turns[i].actor === 'you') { start = i + 1; break; } }
  const parts: string[] = [];
  for (let i = start; i < turns.length; i++) {
    if (turns[i].actor !== 'agent') continue;
    parts.push(turns[i].blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n'));
  }
  return parts.join('\n');
}

/** One incremental transcript reader over a single lane — subsumes the old
 *  per-Session revStream/selfStream, so there is exactly one reader per lane. */
class LaneReader {
  private stream: ChatStream;
  private offset = 0;
  private polling = false;
  constructor(private handle: LaneHandle) {
    this.stream = new ChatStream(handle.engine === 'codex' ? 'codex' : 'claude');
  }
  /** Pull new lines and return the current turns, or null if nothing new / a poll
   *  is already in flight (guards against overlapping reads). */
  async turns(): Promise<Turn[] | null> {
    if (this.polling) return null;
    this.polling = true;
    try {
      const t = await this.handle.readTranscript(this.offset);
      if (!t || !t.found) return null;
      if (t.reset) { this.stream.reset(); this.offset = 0; }
      this.stream.push(t.lines);
      this.offset = t.offset;
      return this.stream.turns();
    } catch {
      return null;
    } finally {
      this.polling = false;
    }
  }
}

/**
 * One reviewer↔coder negotiation, decoupled from the DOM and the pty. Holds the
 * findings and drives them to terminal states via converge.ts. Bounded three
 * ways (see converge.ts): the round cap, the monotonically-shrinking contested
 * set, and a monotonic askNum so a stale reply can't match a re-ask — plus the
 * sweepStale timeout as a last-resort net.
 */
export class LaneReviewExchange {
  findings: Finding[] = [];
  private askSeq = 0;
  private timer: any = null;
  private coderReader: LaneReader;
  private reviewerReader: LaneReader | null;

  constructor(private d: LaneReviewDeps) {
    this.coderReader = new LaneReader(d.coder);
    this.reviewerReader = d.reviewer ? new LaneReader(d.reviewer) : null;
  }

  /** Take a reviewer's findings, merging by id so a re-send keeps in-flight
   *  progress, then ask the coder about the genuinely new ones. */
  receiveReview(incoming: Finding[]): void {
    const prev = new Map(this.findings.map((f) => [f.id, f]));
    this.findings = incoming.map((f) => prev.get(f.id) || f);
    const fresh = this.findings.filter((f) => f.state === 'open' && !f.turn);
    this.askCoder(fresh);
    this.d.onChange();
  }

  /** You broke a tie on an escalated finding: write the ruling back to the coder
   *  (only when siding with the reviewer — keeping the coder's approach needs no
   *  message) and settle it. */
  resolveFinding(id: string, side: 'coder' | 'reviewer'): void {
    const f = this.findings.find((x) => x.id === id);
    if (!f) return;
    const n = this.findings.indexOf(f) + 1;
    const msg = side === 'reviewer'
      ? `On finding #${n}, go with the reviewer: apply the suggested fix.`
      : `On finding #${n}, keep your approach — the reviewer's concern is noted but we're proceeding.`;
    if (side === 'reviewer') this.d.coder.deliver(msg);
    f.state = 'resolved';
    f.awaiting = undefined;
    this.d.onChange();
    this.ensureTimer();
  }

  /** One background advance: time out stragglers, then fold each side's replies.
   *  Public so a test can step the loop deterministically. */
  async tick(): Promise<void> {
    const escalated = converge.sweepStale(this.findings, this.d.now(), this.d.timeoutMs);
    if (escalated.length) this.d.onChange();
    await this.foldFromCoder();
    await this.foldFromReviewer();
    this.ensureTimer();
  }

  /** Stop the background timer — call on teardown. */
  dispose(): void {
    this.cancel(this.timer);
    this.timer = null;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private askCoder(batch: Finding[]): void {
    if (!batch.length) return;
    converge.markAsked(batch, 'coder', () => ++this.askSeq);
    const now = this.d.now();
    batch.forEach((f) => { f.askedAt = now; });
    this.d.coder.deliver(converge.composeCoderAsk(batch));
    this.ensureTimer();
  }

  private askReviewer(batch: Finding[]): void {
    if (!batch.length) return;
    // A dead or missing reviewer can't reconsider — escalate rather than strand.
    if (!this.d.reviewer || !this.d.reviewer.isAlive()) {
      this.escalateStuck(batch, 'the reviewer is no longer available');
      return;
    }
    converge.markAsked(batch, 'reviewer', () => ++this.askSeq);
    const now = this.d.now();
    batch.forEach((f) => { f.askedAt = now; });
    if (!this.d.reviewer.deliver(converge.composeReviewerAsk(batch))) {
      this.escalateStuck(batch, 'the reviewer is no longer available');
      return;
    }
    this.ensureTimer();
  }

  private escalateStuck(batch: Finding[], why: string): void {
    for (const f of batch) {
      f.state = 'escalated';
      f.awaiting = undefined;
      if (why && !f.reviewerNote) f.reviewerNote = why;
    }
    this.d.onChange();
  }

  private async foldFromCoder(): Promise<void> {
    if (!this.findings.some((f) => f.awaiting === 'coder' && (f.consumedTurn || 0) < (f.turn || 0))) return;
    const turns = await this.coderReader.turns();
    if (!turns) return;
    const verdicts = parseCoderVerdicts(agentTextSinceLastUser(turns));
    if (!verdicts.length) return;
    const hasReviewer = !!(this.d.reviewer && this.d.reviewer.isAlive());
    const { changed, toReviewer } = converge.foldCoderVerdicts(this.findings, verdicts, { cap: this.d.cap, hasReviewer });
    if (toReviewer.length) this.askReviewer(toReviewer);
    if (changed) this.d.onChange();
    this.ensureTimer();
  }

  private async foldFromReviewer(): Promise<void> {
    if (!this.reviewerReader) return;
    if (!this.findings.some((f) => f.awaiting === 'reviewer' && (f.consumedTurn || 0) < (f.turn || 0))) return;
    const turns = await this.reviewerReader.turns();
    if (!turns) return;
    const verdicts = parseReviewerVerdicts(agentTextSinceLastUser(turns));
    if (!verdicts.length) return;
    const { changed, backToCoder } = converge.foldReviewerVerdicts(this.findings, verdicts);
    if (backToCoder.length) this.askCoder(backToCoder);
    if (changed) this.d.onChange();
    this.ensureTimer();
  }

  private ensureTimer(): void {
    const active = this.findings.some((f) => !!f.awaiting);
    if (active && !this.timer) {
      const schedule = this.d.schedule || ((fn, ms) => setInterval(fn, ms));
      this.timer = schedule(() => { void this.tick(); }, this.d.tickMs);
    } else if (!active && this.timer) {
      this.cancel(this.timer);
      this.timer = null;
    }
  }

  private cancel(handle: any): void {
    if (handle == null) return;
    (this.d.cancel || ((h) => clearInterval(h)))(handle);
  }
}
