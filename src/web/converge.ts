// converge.ts — the reviewer↔coder negotiation state machine, pure.
//
// The Session (app.ts) owns the IO: injecting a message into a lane's pty,
// reading a lane's transcript, re-rendering. Everything that DECIDES — how a
// finding moves between states as verdicts land, when a standoff escalates to
// the person, what each side is asked — lives here, as functions over plain
// Finding objects. That split is deliberate: the transitions are where the
// correctness lives (a mis-step loops or drops a finding), and they can only be
// tested if they don't need a pty.
//
// Termination is structural, not hoped-for:
//   • bounces is capped (foldCoderVerdicts escalates at the cap instead of
//     bouncing again), so a single finding can't ping-pong forever;
//   • every fold moves findings toward a terminal state (accepted / resolved /
//     escalated) and the contested set only shrinks;
//   • askNum is globally monotonic (markAsked), so a lane's STALE latest reply
//     can never be misread as an answer to a re-ask.

import type { Finding, CoderVerdict, ReviewerVerdict } from './chatview';

/** A finding is "awaiting `who`" and hasn't had this ask's reply folded yet. */
function pending(findings: Finding[], who: 'coder' | 'reviewer'): Finding[] {
  return findings.filter((f) => f.awaiting === who && (f.consumedTurn || 0) < (f.turn || 0));
}

/**
 * Stamp a batch as freshly asked of `audience`: a unique number (via `nextNum`,
 * a monotonic counter the caller owns), a bumped turn, and the awaiting/state
 * that side implies. This is the ONLY place askNum is set, which is what keeps
 * every `#N` unique across the whole exchange.
 */
export function markAsked(batch: Finding[], audience: 'coder' | 'reviewer', nextNum: () => number): void {
  for (const f of batch) {
    f.awaiting = audience;
    f.askNum = nextNum();
    f.turn = (f.turn || 0) + 1;
    if (audience === 'coder') {
      f.consumedTurn = f.consumedTurn || 0;
      f.state = 'open';
    } else {
      f.state = 'contested';
    }
  }
}

/**
 * Fold the coder's `#N accept|reject|counter` verdicts into the findings that
 * are awaiting it. Accept settles the finding; reject/counter is a contested
 * round — escalated to the person once bounces reach the cap (or if there's no
 * reviewer to bounce to), otherwise returned in `toReviewer` for reconsideration.
 * Matched by askNum, so a partial answer never renumbers the rest and a stale
 * reply (old askNums) matches nothing.
 */
export function foldCoderVerdicts(
  findings: Finding[],
  verdicts: CoderVerdict[],
  opts: { cap: number; hasReviewer: boolean },
): { changed: boolean; toReviewer: Finding[] } {
  const waiting = pending(findings, 'coder');
  const toReviewer: Finding[] = [];
  let changed = false;
  for (const v of verdicts) {
    const f = waiting.find((x) => x.askNum === v.index);
    if (!f) continue;
    f.consumedTurn = f.turn;
    f.awaiting = undefined;
    f.verdict = v.verdict;
    f.reply = v.note;
    if (v.verdict === 'accept') {
      f.state = 'accepted';
    } else {
      f.bounces = (f.bounces || 0) + 1;
      if (f.bounces >= opts.cap || !opts.hasReviewer) {
        f.state = 'escalated';
      } else {
        // Contested and heading to the reviewer. markAsked will restamp this when
        // the ask is actually sent; setting it here keeps the fold's output
        // self-consistent for anything that reads state before that.
        f.state = 'contested';
        toReviewer.push(f);
      }
    }
    changed = true;
  }
  return { changed, toReviewer };
}

/**
 * Fold the reviewer's `#N concede|hold` verdicts into the findings awaiting it.
 * Concede settles the finding (the coder's approach stands); hold records the
 * reviewer's reason and returns the finding in `backToCoder` for another round.
 */
export function foldReviewerVerdicts(
  findings: Finding[],
  verdicts: ReviewerVerdict[],
): { changed: boolean; backToCoder: Finding[] } {
  const waiting = pending(findings, 'reviewer');
  const backToCoder: Finding[] = [];
  let changed = false;
  for (const v of verdicts) {
    const f = waiting.find((x) => x.askNum === v.index);
    if (!f) continue;
    f.consumedTurn = f.turn;
    f.awaiting = undefined;
    if (v.verdict === 'concede') {
      f.state = 'resolved';
    } else {
      f.reviewerNote = v.note;
      backToCoder.push(f);
    }
    changed = true;
  }
  return { changed, backToCoder };
}

/**
 * Escalate any finding that has been awaiting a response past `timeoutMs`. The
 * loop's last safety net: a coder or reviewer that simply never answers (ignored
 * the format, wandered off, died mid-turn) can't leave a finding stuck — after
 * the deadline it becomes the person's call. Returns the ones escalated. `now`
 * and the finding's askedAt are passed in so this stays pure and testable.
 */
export function sweepStale(findings: Finding[], now: number, timeoutMs: number): Finding[] {
  const escalated: Finding[] = [];
  for (const f of findings) {
    if (!f.awaiting || !f.askedAt) continue;
    if (now - f.askedAt >= timeoutMs) {
      f.state = 'escalated';
      f.awaiting = undefined;
      if (!f.reviewerNote) f.reviewerNote = 'timed out waiting for a response';
      escalated.push(f);
    }
  }
  return escalated;
}

/** The message the coder is asked to answer (findings must be markAsked first). */
export function composeCoderAsk(batch: Finding[]): string {
  const lines = batch.map((f) => {
    const where = f.file ? ` (${f.file}${f.line ? ':' + f.line : ''})` : '';
    const sug = f.suggestion ? `\n    suggested: ${f.suggestion}` : '';
    const held = f.reviewerNote ? `\n    reviewer still holds: ${f.reviewerNote}` : '';
    return `#${f.askNum} [${f.severity}]${where} ${f.claim}${sug}${held}`;
  });
  const intro = batch.some((f) => (f.bounces || 0) > 0)
    ? 'The reviewer reconsidered and is holding on these. For EACH, reply on its own line'
    : 'A reviewer flagged the following on your work. For EACH item, reply on its own line';
  return [
    intro,
    'as `#N accept`, `#N reject: <reason>`, or `#N counter: <alternative>`.',
    'Fix the ones you accept; defend the ones you reject — do not edit for those.',
    '',
    ...lines,
  ].join('\n');
}

/** The message the reviewer is asked to reconsider (findings must be markAsked first). */
export function composeReviewerAsk(batch: Finding[]): string {
  const lines = batch.map((f) => {
    const where = f.file ? ` (${f.file}${f.line ? ':' + f.line : ''})` : '';
    const stance = f.verdict === 'counter' ? 'counters' : 'rejects';
    return `#${f.askNum}${where} ${f.claim}\n    coder ${stance}: ${f.reply || '(no reason given)'}`;
  });
  return [
    'The coder pushed back on your findings. For EACH, reply on its own line as',
    "`#N concede` (you accept the coder's reasoning — drop it) or `#N hold: <why",
    'it still stands>` (send it back for another round). Be willing to concede a',
    'point the coder has answered well; the goal is the right code, not winning.',
    '',
    ...lines,
  ].join('\n');
}
