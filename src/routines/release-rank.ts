// release-rank.ts — the "rank" stage of the release-radar routine, pure.
//
// A scheduled routine (see docs/routines/release-radar.md) does the IO: it
// watches a repo's manifest against installed versions, pulls each dependency's
// release notes (`gh api`), and — at the end — writes a brief into inbox/. This
// module is the part in between that DECIDES which releases are worth a human's
// attention and which are patch-level noise to drop. It is split out for the
// same reason converge.ts is: the judgement is where the value (and the bugs)
// live, and it can only be tested cheaply if it never touches the network, the
// LLM, or the disk — plain functions over plain Change objects.
//
// The whole point of a routine is to run unattended, so the ranking must be
// deterministic: the same releases must always produce the same brief, with no
// model call in the loop. The agent's judgement is spent on WRITING the prose of
// the brief, not on deciding what clears the bar — that bar is here, in code.

/**
 * What a release earned. Ordered by how loudly it should interrupt someone;
 * `noise` is the only non-surfacing signal (patch churn, routine fixes) and is
 * dropped from the brief. Precedence when a release trips several: security >
 * breaking > major > deprecation.
 */
export type Signal = 'security' | 'breaking' | 'major' | 'deprecation' | 'noise';

/** One dependency that moved, with its raw release notes (as `gh api` returns them). */
export interface Change {
  pkg: string;
  from: string;
  to: string;
  notes: string;
}

/** A Change after classification: its signal, a sort weight, and why it earned it. */
export interface Ranked extends Change {
  signal: Signal;
  severity: number; // higher = more urgent; == SEVERITY[signal]
  reasons: string[]; // human-readable, e.g. ['mentions "vulnerability"', 'major bump 4→5']
}

/** Sort weight per signal. Only the ordering matters; the numbers are arbitrary. */
const SEVERITY: Record<Signal, number> = {
  security: 4,
  breaking: 3,
  major: 2,
  deprecation: 1,
  noise: 0,
};

// Signal keyword scanners, most-urgent first. Each entry that matches the notes
// contributes its signal and a short reason; the final signal is the highest-
// precedence match. Kept intentionally broad — a routine that runs unattended
// should over-surface (a false positive costs a glance) rather than silently
// swallow a real security or breaking note it didn't recognise.
const SCANNERS: { signal: Exclude<Signal, 'noise' | 'major'>; re: RegExp; why: string }[] = [
  { signal: 'security', re: /\b(security|vulnerab\w*|CVE-\d{4}|RCE|XSS|SSRF|exploit|advisor\w+|malicious)\b/i, why: 'security note' },
  { signal: 'breaking', re: /\bbreaking[\s-]?change\b|\bbreaking\b|\bincompatib\w*|\bno longer\b|\bremoved\b|\bdropped support\b/i, why: 'breaking note' },
  { signal: 'deprecation', re: /\bdeprecat\w*/i, why: 'deprecation note' },
];

/** Strip a version string to [major, minor, patch] numbers, tolerating v/^/~/= prefixes and pre-release/build tags. Non-numeric parts become 0. */
function parseSemver(v: string): [number, number, number] {
  const cleaned = (v || '').trim().replace(/^[v=^~><\s]*/, '');
  const core = cleaned.split(/[-+]/)[0]; // drop -rc.1 / +build
  const [maj, min, pat] = core.split('.');
  const n = (s?: string) => {
    const x = parseInt(s ?? '', 10);
    return Number.isFinite(x) ? x : 0;
  };
  return [n(maj), n(min), n(pat)];
}

/**
 * Classify one release. Scans the notes for security / breaking / deprecation
 * language and compares the versions for a major bump, then returns the highest-
 * precedence signal it found (or `noise` if none). All matched reasons are kept
 * so the brief can say WHY, not just THAT, something surfaced.
 */
export function classify(change: Change): Ranked {
  const reasons: string[] = [];
  const found = new Set<Signal>();

  for (const s of SCANNERS) {
    const m = change.notes?.match(s.re);
    if (m) {
      found.add(s.signal);
      reasons.push(`${s.why} ("${m[0].toLowerCase()}")`);
    }
  }

  const [fromMaj] = parseSemver(change.from);
  const [toMaj] = parseSemver(change.to);
  if (toMaj > fromMaj) {
    found.add('major');
    reasons.push(`major bump ${fromMaj}→${toMaj}`);
  }

  // Highest-precedence signal wins the label; reasons already carry the rest.
  const signal: Signal = (['security', 'breaking', 'major', 'deprecation'] as const).find((s) => found.has(s)) ?? 'noise';
  return { ...change, signal, severity: SEVERITY[signal], reasons };
}

/**
 * Classify a batch, drop the noise, and order what's left for the brief: most
 * urgent first, ties broken by package name so the output is stable run to run
 * (a routine's brief shouldn't reshuffle just because the source list did).
 */
export function rank(changes: Change[]): Ranked[] {
  return changes
    .map(classify)
    .filter((r) => r.signal !== 'noise')
    .sort((a, b) => b.severity - a.severity || a.pkg.localeCompare(b.pkg));
}
