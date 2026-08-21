// A playbook: a user-defined "here is how I like this done" that fires for a kind of
// request, does the steps, then PROVES it by running the user's own checks and gating on
// the result. Slice 1 is the delegate-to-runner tier only - a check is a command (a test
// run, the verify harness, a lint) that either exits clean / matches or fails the run.
//
// This deliberately does NOT reuse the citation pipeline (answerSchema / gateFields /
// facts-cited / the span table). A coding playbook produces a diff checked by runners, not
// a claims array checked by quotes; forcing one through the other is the trap. What it DOES
// reuse is the spine: runWithRedo (bounded, gate-never-relaxed, final-verdict-stands) and
// the check-set loader's three laws - an unknown key is a hard error, a check that cannot
// run aborts rather than no-ops, and only a deterministic check may gate (a runner's exit
// code is mechanical, so it qualifies).
//
// Pure except for two injected operations - take one coding-agent turn, and run one
// command - so the whole loop is testable with a fake turn and scripted exit codes, with no
// model and no subprocess. Same discipline as run.ts.

import { parseYaml, type YamlValue } from './yaml';
import { runWithRedo } from './redo';

export type Expect = 'exit-zero' | 'matches' | 'not-matches';
const EXPECTS: readonly Expect[] = ['exit-zero', 'matches', 'not-matches'];

/** One deterministic gate: run a command, judge its exit code or its output. */
export type RunnerCheck = {
  cmd: string;
  expect: Expect;
  /** Required for matches / not-matches; the regex the output is tested against. */
  pattern?: string;
  label: string;
};

export type Scope = 'global' | { workspace: string };

export type Playbook = {
  name: string;
  description: string;
  scope: Scope;
  /** The procedure, verbatim, joined into the instruction block. */
  steps: string[];
  checks: RunnerCheck[];
  onFail: 'annotate' | 'gate';
  engine: 'claude' | 'codex';
  maxRedos: number;
};

const DEFAULTS = { onFail: 'gate' as const, engine: 'claude' as const, maxRedos: 2 };

const TOP_LEVEL = new Set([
  'name', 'description', 'scope', 'steps', 'checks', 'on_fail', 'engine', 'max_redos',
]);
const RUNNER_KEYS = new Set(['run', 'expect', 'pattern', 'label']);

function fail(message: string): never {
  throw new Error(`playbook: ${message}`);
}

function asRecord(v: YamlValue, where: string): Record<string, YamlValue> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) fail(`${where} must be a mapping`);
  return v as Record<string, YamlValue>;
}

function asArray(v: YamlValue, where: string): YamlValue[] {
  if (!Array.isArray(v)) fail(`${where} must be a list`);
  return v;
}

function readSteps(raw: YamlValue): string[] {
  const list = asArray(raw, 'steps');
  if (!list.length) fail('steps is empty; the playbook says to do nothing');
  return list.map((s, i) => {
    if (typeof s !== 'string' || !s.trim()) fail(`steps[${i}] must be a non-empty string`);
    return s;
  });
}

function readChecks(raw: YamlValue): RunnerCheck[] {
  const list = asArray(raw, 'checks');
  if (!list.length) fail('checks is empty; the run would verify nothing');
  return list.map((entry, i) => {
    const r = asRecord(entry, `checks[${i}]`);
    for (const key of Object.keys(r)) {
      if (!RUNNER_KEYS.has(key)) {
        fail(`checks[${i}] has unknown key \`${key}\`. A runner check takes: run, expect, pattern, label.`);
      }
    }
    const cmd = r.run;
    if (typeof cmd !== 'string' || !cmd.trim()) fail(`checks[${i}] needs a non-empty \`run\` command`);

    const expect = r.expect === undefined ? 'exit-zero' : String(r.expect);
    if (!EXPECTS.includes(expect as Expect)) {
      fail(`checks[${i}] has expect \`${expect}\`; allowed: ${EXPECTS.join(', ')}`);
    }

    let pattern: string | undefined;
    if (expect === 'matches' || expect === 'not-matches') {
      if (typeof r.pattern !== 'string' || !r.pattern) {
        // Mirrors the min-distinct-sources rule: a matcher with no pattern would pass (or
        // fail) unconditionally, so the file claims a bar the run is not held to.
        fail(`checks[${i}] uses expect \`${expect}\` but names no \`pattern\`; it would ${
          expect === 'matches' ? 'never match' : 'always match'
        } and gate on nothing.`);
      }
      // Reject a pattern that is not a valid regex now, not at run time.
      try {
        new RegExp(r.pattern);
      } catch (e) {
        fail(`checks[${i}] pattern is not a valid regex: ${(e as Error).message}`);
      }
      pattern = r.pattern;
    } else if (r.pattern !== undefined) {
      fail(`checks[${i}] gives a \`pattern\` but expect is \`exit-zero\`, which ignores it`);
    }

    const label = r.label === undefined ? cmd : String(r.label);
    return { cmd, expect: expect as Expect, pattern, label };
  });
}

function readScope(raw: YamlValue): Scope {
  if (raw === undefined || raw === 'global') return 'global';
  const r = asRecord(raw, 'scope');
  const keys = Object.keys(r);
  if (keys.length !== 1 || keys[0] !== 'workspace' || typeof r.workspace !== 'string' || !r.workspace) {
    fail('scope must be `global` or `{ workspace: <id> }`');
  }
  return { workspace: r.workspace as string };
}

export function loadPlaybook(source: string): Playbook {
  const doc = asRecord(parseYaml(source), 'the playbook');

  for (const key of Object.keys(doc)) {
    if (!TOP_LEVEL.has(key)) fail(`unknown key \`${key}\`. Known keys: ${[...TOP_LEVEL].join(', ')}`);
  }
  if (typeof doc.name !== 'string' || !doc.name) fail('name is required');
  if (doc.steps === undefined) fail('steps is required');
  if (doc.checks === undefined) fail('checks is required');

  const onFail = doc.on_fail === undefined ? DEFAULTS.onFail : String(doc.on_fail);
  if (onFail !== 'annotate' && onFail !== 'gate') fail(`on_fail must be annotate or gate, got \`${onFail}\``);

  const engine = doc.engine === undefined ? DEFAULTS.engine : String(doc.engine);
  if (engine !== 'claude' && engine !== 'codex') fail(`engine must be claude or codex, got \`${engine}\``);

  const maxRedos = doc.max_redos === undefined ? DEFAULTS.maxRedos : doc.max_redos;
  if (typeof maxRedos !== 'number' || maxRedos < 0) fail('max_redos must be a number >= 0');

  return {
    name: doc.name,
    description: typeof doc.description === 'string' ? doc.description : '',
    scope: readScope(doc.scope),
    steps: readSteps(doc.steps),
    checks: readChecks(doc.checks),
    onFail,
    engine,
    maxRedos,
  };
}

// ── authoring: a structured form → YAML ──────────────────────────────────────────

/** What an authoring form collects. Serialized to YAML that loadPlaybook round-trips. */
export interface PlaybookInput {
  name: string;
  description?: string;
  steps: string[];
  checks: { cmd: string; expect: Expect; pattern?: string; label?: string }[];
  onFail?: 'annotate' | 'gate';
  maxRedos?: number;
}

/** Single-quote a scalar for the minimal YAML reader. Single quotes are the robust choice:
 *  the reader doesn't unescape `\"` inside flow-map values, and it treats `\\` inconsistently
 *  in double-quoted strings — but a single-quoted scalar is literal (backslashes kept, ideal
 *  for regex patterns) and only a literal `'` needs doubling. Newlines are flattened since the
 *  reader is single-line. */
function sq(s: string): string {
  return "'" + String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/'/g, "''") + "'";
}

/** Serialize a form into YAML. Every string is quoted so a command, label, or step with a
 *  colon, comma, or brace can never corrupt the shape. The result is guaranteed to parse:
 *  the caller (playbookui.save) runs loadPlaybook on it before writing, so a form can never
 *  produce a file that won't load. */
export function serializePlaybook(input: PlaybookInput): string {
  const steps = input.steps.map((s) => s.trim()).filter(Boolean);
  const checks = input.checks.filter((c) => c.cmd && c.cmd.trim());
  const L: string[] = [];
  L.push(`name: ${sq(input.name || 'Untitled playbook')}`);
  if (input.description && input.description.trim()) L.push(`description: ${sq(input.description)}`);
  L.push('scope: global');
  L.push('steps:');
  for (const s of steps.length ? steps : ['Do the task.']) L.push(`  - ${sq(s)}`);
  L.push('checks:');
  for (const c of checks) {
    const parts = [`run: ${sq(c.cmd)}`, `expect: ${c.expect}`];
    if ((c.expect === 'matches' || c.expect === 'not-matches') && c.pattern) {
      parts.push(`pattern: ${sq(c.pattern)}`);
    }
    parts.push(`label: ${sq(c.label && c.label.trim() ? c.label : c.cmd)}`);
    L.push(`  - { ${parts.join(', ')} }`);
  }
  L.push(`on_fail: ${input.onFail || 'gate'}`);
  L.push('engine: claude');
  L.push(`max_redos: ${Number.isFinite(input.maxRedos) ? input.maxRedos : 2}`);
  return L.join('\n') + '\n';
}

// ── run ─────────────────────────────────────────────────────────────────────────

export type TurnResult = { is_error?: boolean; terminal_reason?: string; summary?: string };
export type CheckOutput = { code: number; stdout: string; stderr: string };

export type PlaybookIO = {
  /**
   * Take one coding-agent turn against the repo. `correction` carries the failing checks
   * from the previous attempt, or null on the first. Slice 1 wraps the headless run_cli
   * path pty.rs already uses for analyze_voice. Throws on a run-level failure.
   */
  turn: (args: { prompt: string; engine: string; correction: string | null }) => Promise<TurnResult>;
  /** Run one command. Deterministic. Throws only if the command could not be executed. */
  runCheck: (cmd: string) => Promise<CheckOutput>;
};

export type CheckResult = RunnerCheck & { pass: boolean; code: number; output: string };

export type PlaybookRun = {
  pass: boolean;
  results: CheckResult[];
  redos: number;
  display: string;
  gated: boolean;
};

/** The instruction block, generated FROM the playbook so what the agent is told and what
 *  the gate runs cannot drift. */
export function buildPrompt(task: string, playbook: Playbook): string {
  const steps = playbook.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const checks = playbook.checks
    .map((c) => `  - ${c.label}: \`${c.cmd}\` (${c.expect}${c.pattern ? ` /${c.pattern}/` : ''})`)
    .join('\n');
  return [
    `## Playbook: ${playbook.name}`,
    playbook.description,
    '',
    '## Steps',
    steps,
    '',
    '## This will be checked',
    'When you finish, these commands run and must pass. Do NOT weaken, skip, or edit a check',
    'to make it pass - a check exists to be satisfied, not bypassed. Make the work real.',
    checks,
    '',
    '## Task',
    task,
    '',
  ].join('\n');
}

/** Judge one attempt by running every check. Deterministic; the runner's result is the gate. */
async function judgeChecks(playbook: Playbook, io: PlaybookIO): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of playbook.checks) {
    // A check that cannot run must abort the whole run, never pass. This is the
    // source-unchanged precedent (run.ts): a silently skipped check is the exact failure
    // this harness argues against. runCheck throws -> the error propagates out of runPlaybook.
    const { code, stdout, stderr } = await io.runCheck(check.cmd);
    const out = `${stdout}${stderr}`;
    const pass =
      check.expect === 'exit-zero' ? code === 0
      : check.expect === 'matches' ? new RegExp(check.pattern!).test(out)
      : !new RegExp(check.pattern!).test(out);
    results.push({ ...check, pass, code, output: out });
  }
  return results;
}

/** Fold failing checks into a correction fed to the next attempt. Null when all passed. */
function correctionFor(results: CheckResult[]): string | null {
  const failed = results.filter((r) => !r.pass);
  if (!failed.length) return null;
  const lines = failed.map((r) => {
    const why =
      r.expect === 'exit-zero' ? `exited ${r.code}, expected 0`
      : r.expect === 'matches' ? `output did not match /${r.pattern}/`
      : `output matched /${r.pattern}/ but must not`;
    const tail = lastLines(r.output, 20);
    return `- ${r.label} (\`${r.cmd}\`): ${why}${tail ? `\n${tail}` : ''}`;
  });
  return [
    'Your previous attempt did not pass its checks. Fix the underlying work so these pass -',
    'do not touch the checks themselves:',
    ...lines,
  ].join('\n');
}

function lastLines(s: string, n: number): string {
  const lines = s.trimEnd().split('\n');
  return lines.slice(-n).join('\n');
}

export async function runPlaybook(opts: {
  task: string;
  playbook: Playbook;
  io: PlaybookIO;
}): Promise<PlaybookRun> {
  const { task, playbook, io } = opts;
  const basePrompt = buildPrompt(task, playbook);

  const outcome = await runWithRedo<{ turn: TurnResult; results: CheckResult[] }>(
    async (correction) => {
      const prompt = correction ? `${correction}\n\n${basePrompt}` : basePrompt;
      const turn = await io.turn({ prompt, engine: playbook.engine, correction });
      if (turn.is_error) {
        throw new Error(`playbook turn failed - ${turn.terminal_reason ?? 'unknown'}`);
      }
      const results = await judgeChecks(playbook, io);
      return { turn, results };
    },
    ({ results }) => ({ pass: results.every((r) => r.pass), correction: correctionFor(results) }),
    playbook.maxRedos,
  );

  const results = outcome.final.result.results;
  const pass = results.every((r) => r.pass);
  return {
    pass,
    results,
    redos: outcome.redos,
    gated: playbook.onFail === 'gate',
    display: renderReceipt(playbook, results, outcome.redos, pass),
  };
}

/** The starting point a person edits. Every check is a command that gates on its result.
 *  The default checks are fast and pass in the Spike repo so a FIRST run is green; replace
 *  them with how YOU verify a change in your project (its test command, a lint, the build). */
export const STARTER_PLAYBOOK = `# Implement a change, then prove it with your own checks.
# Replace the checks below with your project's real verify commands.
name: How I code + verify
description: Make the smallest real change, then let my checks gate it.
scope: global

steps:
  - Implement the smallest change that satisfies the request.
  - Keep edits inside the touched module unless told otherwise.
  - Do not weaken, skip, or edit a check to make it pass.

checks:
  - { run: "node build.mjs", expect: exit-zero, label: build }
  - { run: "node --test test/playbook.test.mjs", expect: exit-zero, label: tests }

on_fail: gate         # annotate | gate
engine: claude        # claude | codex - both run on your own subscription
max_redos: 2
`;

export function renderReceipt(
  playbook: Playbook,
  results: CheckResult[],
  redos: number,
  pass: boolean,
): string {
  const passed = results.filter((r) => r.pass).length;
  const head = `▸ ${playbook.name}   ${pass ? '✓' : '✗'} ${passed}/${results.length}${
    redos ? `   (revised ${redos}×)` : ''
  }`;
  const rows = results.map((r) => {
    const mark = r.pass ? '✓' : '✗';
    // Name the pattern on a failed match so "no match" is debuggable - a receipt that shows
    // the output but not what it was tested against sends you hunting for a difference you
    // cannot see (a double-escaped regex looks identical to the text it fails to match).
    const why =
      r.expect === 'exit-zero' ? `exit ${r.code}`
      : r.pass ? `matched /${r.pattern}/`
      : `no match /${r.pattern}/`;
    const line = `  ${mark} ${r.label}   ${r.cmd} → ${why}`;
    if (r.pass) return line;
    return `${line}\n${lastLines(r.output, 20).split('\n').map((l) => `      ${l}`).join('\n')}`;
  });
  return [head, ...rows].join('\n');
}
