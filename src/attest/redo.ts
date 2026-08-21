// A bounded redo loop.
//
// Most gate failures are the model misreading the format, not the evidence failing to
// support an answer: a typed quotation mark, a token in the wrong field, a claim too
// short. Those are worth one more turn with a specific correction. Re-rolling with a
// generic "try again" is not - it resamples the same failure.
//
// Two rules, both inherited and both load-bearing:
//
//   1. The gate is NEVER relaxed. A redo changes what the model is told, never what
//      counts as a pass. A loop that loosens its own criteria to terminate is a loop
//      that reports success by definition.
//   2. The FINAL turn's verdict stands. Not the best of N: a run that passed on attempt
//      2 and failed on attempt 3 failed. Keeping the best verdict would let a caller
//      shop for a green receipt over text nobody re-checked.
//
// Evidence is fixed across attempts. The model gets another try at the ANSWER, never a
// second look at a different corpus, so the redo cannot quietly widen what was read.

export type Attempt<T> = {
  /** 1-based attempt number */
  n: number;
  result: T;
  pass: boolean;
  /** the correction fed into the NEXT attempt, or null when there was nothing to say */
  correction: string | null;
};

export type RedoOutcome<T> = {
  /** the final attempt, whose verdict stands */
  final: Attempt<T>;
  attempts: Attempt<T>[];
  /** how many extra turns were spent (attempts - 1) */
  redos: number;
};

/**
 * @param turn     runs one attempt. Receives the correction from the previous attempt,
 *                 or null on the first.
 * @param judge    gates an attempt. Returns pass plus a correction to feed forward. May be
 *                 async - a runner-check judge shells out - and an awaited plain value is
 *                 unchanged, so the citation caller's sync judge keeps working untouched.
 * @param maxRedos extra attempts allowed after the first. 0 disables the loop.
 */
export async function runWithRedo<T>(
  turn: (correction: string | null) => Promise<T>,
  judge: (result: T) => { pass: boolean; correction: string | null }
    | Promise<{ pass: boolean; correction: string | null }>,
  maxRedos: number,
): Promise<RedoOutcome<T>> {
  const attempts: Attempt<T>[] = [];
  let correction: string | null = null;

  for (let n = 1; n <= maxRedos + 1; n++) {
    const result = await turn(correction);
    const { pass, correction: next } = await judge(result);
    attempts.push({ n, result, pass, correction: next });
    if (pass) break;
    // Nothing actionable to say means another attempt would be a pure resample, so stop
    // rather than spend a turn on it.
    if (next === null) break;
    correction = next;
  }

  return {
    final: attempts[attempts.length - 1],
    attempts,
    redos: attempts.length - 1,
  };
}
