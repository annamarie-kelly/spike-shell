// A playbook decides what "done" means for a kind of work, so a misread file or a check
// that quietly does not run is a silently wrong verdict. Both halves are tested for refusal
// as much as for acceptance: the loader must throw on the constructs it cannot enforce, and
// the runner must honour the redo invariants (gate never relaxed, final verdict stands) and
// never let a check that could not run count as green.
//
// The whole loop runs with a fake turn and scripted exit codes - no model, no subprocess.
// (npm test builds dist/ first.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlaybook, runPlaybook, buildPrompt, STARTER_PLAYBOOK, serializePlaybook } from '../dist/attest/playbook.js';

const CODE_PLAYBOOK = `
name: How I code + verify
description: Implement the change, then prove it.
steps:
  - Implement the smallest change that satisfies the request.
  - Do not weaken or skip any check to make it pass.
checks:
  - { run: "npm test", expect: exit-zero, label: unit tests }
  - { run: "node verify/run.mjs scenarios/x.mjs", expect: matches, pattern: PASS, label: verify }
on_fail: gate
max_redos: 2
`;

// A fake turn that always "succeeds", and a runCheck driven by a script of outputs keyed by
// command. Each call to a command consumes the next scripted output, so a command can fail
// then pass across redos.
function harness(script) {
  const calls = { turn: 0 };
  const queues = new Map(Object.entries(script).map(([cmd, outs]) => [cmd, [...outs]]));
  const io = {
    turn: async () => {
      calls.turn++;
      return { summary: 'made the change' };
    },
    runCheck: async (cmd) => {
      const q = queues.get(cmd);
      if (!q) throw new Error(`no script for command: ${cmd}`);
      if (q.length === 0) throw new Error(`command ran more times than scripted: ${cmd}`);
      return q.shift();
    },
  };
  return { io, calls };
}
const ok = { code: 0, stdout: 'PASS\n', stderr: '' };
const testFail = { code: 1, stdout: '1 failing\n', stderr: '' };
const verifyFail = { code: 0, stdout: 'FAIL ❌\n', stderr: '' };

// ── the loader ──────────────────────────────────────────────────────────────────

test('a runner playbook loads, with defaults filled in', () => {
  const pb = loadPlaybook(CODE_PLAYBOOK);
  assert.equal(pb.name, 'How I code + verify');
  assert.equal(pb.scope, 'global');
  assert.equal(pb.engine, 'claude');
  assert.equal(pb.maxRedos, 2);
  assert.equal(pb.steps.length, 2);
  assert.deepEqual(pb.checks[0], { cmd: 'npm test', expect: 'exit-zero', pattern: undefined, label: 'unit tests' });
  assert.equal(pb.checks[1].pattern, 'PASS');
});

test('the starter playbook loads and every check is a real command', () => {
  const pb = loadPlaybook(STARTER_PLAYBOOK);
  assert.equal(pb.name, 'How I code + verify');
  assert.equal(pb.onFail, 'gate');
  assert.ok(pb.checks.every((c) => c.cmd && c.expect === 'exit-zero'));
});

test('scope reads global or a workspace binding', () => {
  assert.equal(loadPlaybook(CODE_PLAYBOOK.replace('name: How', 'scope: global\nname: How')).scope, 'global');
  const bound = loadPlaybook(CODE_PLAYBOOK.replace('name: How', 'scope: { workspace: ws_42 }\nname: How'));
  assert.deepEqual(bound.scope, { workspace: 'ws_42' });
});

test('REFUSES an unknown top-level key', () => {
  assert.throws(() => loadPlaybook(CODE_PLAYBOOK + '\ntirgger: x'), /unknown key `tirgger`/);
});

test('REFUSES an unknown key inside a check', () => {
  const src = `name: X\nsteps:\n  - do it\nchecks:\n  - { run: "npm test", expct: exit-zero }`;
  assert.throws(() => loadPlaybook(src), /unknown key `expct`/);
});

test('REFUSES a check with no command', () => {
  const src = `name: X\nsteps:\n  - do it\nchecks:\n  - { expect: exit-zero, label: nothing }`;
  assert.throws(() => loadPlaybook(src), /non-empty `run`/);
});

test('REFUSES an unknown expect value', () => {
  const src = `name: X\nsteps:\n  - do it\nchecks:\n  - { run: "x", expect: exit-one }`;
  assert.throws(() => loadPlaybook(src), /allowed: exit-zero, matches, not-matches/);
});

test('REFUSES matches / not-matches with no pattern - it would gate on nothing', () => {
  const m = `name: X\nsteps:\n  - do it\nchecks:\n  - { run: "x", expect: matches }`;
  const nm = `name: X\nsteps:\n  - do it\nchecks:\n  - { run: "x", expect: not-matches }`;
  assert.throws(() => loadPlaybook(m), /names no `pattern`/);
  assert.throws(() => loadPlaybook(nm), /names no `pattern`/);
});

test('REFUSES a pattern that is not a valid regex', () => {
  const src = `name: X\nsteps:\n  - do it\nchecks:\n  - { run: "x", expect: matches, pattern: "([" }`;
  assert.throws(() => loadPlaybook(src), /not a valid regex/);
});

test('REFUSES a pattern on an exit-zero check that would ignore it', () => {
  const src = `name: X\nsteps:\n  - do it\nchecks:\n  - { run: "x", expect: exit-zero, pattern: PASS }`;
  assert.throws(() => loadPlaybook(src), /ignores it/);
});

test('REFUSES empty steps or empty checks', () => {
  assert.throws(() => loadPlaybook('name: X\nsteps: []\nchecks:\n  - { run: "x" }'), /says to do nothing/);
  assert.throws(() => loadPlaybook('name: X\nsteps:\n  - do it\nchecks: []'), /verify nothing/);
});

// ── authoring: serialize → load round-trip ────────────────────────────────────────

test('serializePlaybook → loadPlaybook round-trips, incl. colons/commas/quotes', () => {
  const input = {
    name: 'Ship: a feature',                       // colon
    description: 'warm, brief — no "emoji"',        // comma + quotes
    steps: ['Do the thing.', 'Then: verify it, twice.'],
    checks: [
      { cmd: 'npm test', expect: 'exit-zero', label: 'unit tests' },
      { cmd: 'grep -q "PASS, done" out', expect: 'matches', pattern: 'PASS, done', label: 'verify' },
    ],
    onFail: 'gate',
    maxRedos: 3,
  };
  const pb = loadPlaybook(serializePlaybook(input));
  assert.equal(pb.name, 'Ship: a feature');
  assert.equal(pb.description, 'warm, brief — no "emoji"');
  assert.deepEqual(pb.steps, ['Do the thing.', 'Then: verify it, twice.']);
  assert.equal(pb.checks.length, 2);
  assert.deepEqual(pb.checks[0], { cmd: 'npm test', expect: 'exit-zero', pattern: undefined, label: 'unit tests' });
  assert.equal(pb.checks[1].cmd, 'grep -q "PASS, done" out');
  assert.equal(pb.checks[1].pattern, 'PASS, done');
  assert.equal(pb.onFail, 'gate');
  assert.equal(pb.maxRedos, 3);
});

test('serializePlaybook fills safe defaults (empty steps/label), still loads', () => {
  const pb = loadPlaybook(serializePlaybook({
    name: 'Minimal', steps: [], checks: [{ cmd: 'node build.mjs', expect: 'exit-zero' }],
  }));
  assert.ok(pb.steps.length >= 1);            // seeded a placeholder step
  assert.equal(pb.checks[0].label, 'node build.mjs');  // label defaults to the command
  assert.equal(pb.onFail, 'gate');
});

// ── the run ──────────────────────────────────────────────────────────────────────

test('all checks pass on the first attempt: green, no redo', async () => {
  const pb = loadPlaybook(CODE_PLAYBOOK);
  const { io, calls } = harness({ 'npm test': [ok], 'node verify/run.mjs scenarios/x.mjs': [ok] });
  const run = await runPlaybook({ task: 'add a flag', playbook: pb, io });
  assert.equal(run.pass, true);
  assert.equal(run.redos, 0);
  assert.equal(calls.turn, 1);
  assert.ok(run.results.every((r) => r.pass));
});

test('a check fails then passes: one redo, correction carried the output, final verdict green', async () => {
  const pb = loadPlaybook(CODE_PLAYBOOK);
  // First attempt: unit tests fail. Second attempt: both pass.
  const { io, calls } = harness({
    'npm test': [testFail, ok],
    'node verify/run.mjs scenarios/x.mjs': [ok, ok],
  });
  const run = await runPlaybook({ task: 'add a flag', playbook: pb, io });
  assert.equal(run.pass, true);
  assert.equal(run.redos, 1);
  assert.equal(calls.turn, 2);
});

test('a check fails every attempt: red after max_redos, final verdict stands (not best-of-N)', async () => {
  const pb = loadPlaybook(CODE_PLAYBOOK); // max_redos: 2 -> 3 attempts
  const { io, calls } = harness({
    'npm test': [ok, ok, ok],
    'node verify/run.mjs scenarios/x.mjs': [verifyFail, verifyFail, verifyFail],
  });
  const run = await runPlaybook({ task: 'add a flag', playbook: pb, io });
  assert.equal(run.pass, false);
  assert.equal(run.redos, 2);
  assert.equal(calls.turn, 3);
  const verify = run.results.find((r) => r.label === 'verify');
  assert.equal(verify.pass, false);
});

test('passed-on-2-failed-on-3 is a FAIL - the best attempt does not win', async () => {
  const pb = loadPlaybook(CODE_PLAYBOOK);
  // attempt 1 fails (redo), attempt 2 passes (loop stops - no correction). Prove it stopped
  // at the green attempt rather than running a needless third.
  const { io, calls } = harness({
    'npm test': [testFail, ok],
    'node verify/run.mjs scenarios/x.mjs': [ok, ok],
  });
  const run = await runPlaybook({ task: 'x', playbook: pb, io });
  assert.equal(run.pass, true);
  assert.equal(calls.turn, 2, 'must stop at the first green attempt, not exhaust redos');
});

test('a check that cannot run ABORTS the run - it never counts as green', async () => {
  const pb = loadPlaybook(CODE_PLAYBOOK);
  const io = {
    turn: async () => ({ summary: 'done' }),
    runCheck: async (cmd) => {
      if (cmd === 'npm test') return ok;
      throw new Error('command not found: node');
    },
  };
  await assert.rejects(() => runPlaybook({ task: 'x', playbook: pb, io }), /command not found/);
});

test('a run-level turn error aborts, it is not a silent green', async () => {
  const pb = loadPlaybook(CODE_PLAYBOOK);
  const io = {
    turn: async () => ({ is_error: true, terminal_reason: 'auth' }),
    runCheck: async () => ok,
  };
  await assert.rejects(() => runPlaybook({ task: 'x', playbook: pb, io }), /turn failed/);
});

test('max_redos: 0 disables the loop - one attempt, its verdict stands', async () => {
  const pb = loadPlaybook(CODE_PLAYBOOK.replace('max_redos: 2', 'max_redos: 0'));
  const { io, calls } = harness({
    'npm test': [testFail],
    'node verify/run.mjs scenarios/x.mjs': [ok],
  });
  const run = await runPlaybook({ task: 'x', playbook: pb, io });
  assert.equal(run.pass, false);
  assert.equal(run.redos, 0);
  assert.equal(calls.turn, 1);
});

// ── the prompt is generated from the playbook ─────────────────────────────────────

test('the prompt names every check, so what the agent is told matches what gates', () => {
  const pb = loadPlaybook(CODE_PLAYBOOK);
  const prompt = buildPrompt('add a flag', pb);
  assert.match(prompt, /npm test/);
  assert.match(prompt, /node verify\/run\.mjs scenarios\/x\.mjs/);
  assert.match(prompt, /add a flag/);
  assert.match(prompt, /not be bypassed|not bypassed|not be satisfied|satisfied, not bypassed/);
});

test('the receipt shows a failing check with its output tail', async () => {
  const pb = loadPlaybook(CODE_PLAYBOOK.replace('max_redos: 2', 'max_redos: 0'));
  const { io } = harness({
    'npm test': [ok],
    'node verify/run.mjs scenarios/x.mjs': [verifyFail],
  });
  const run = await runPlaybook({ task: 'x', playbook: pb, io });
  assert.match(run.display, /✗ 1\/2/);
  assert.match(run.display, /FAIL/);
});

test('a failed match names the pattern on the receipt, so "no match" is debuggable', async () => {
  const pb = loadPlaybook(`name: X\nsteps:\n  - do it\nchecks:\n  - { run: "echo hi", expect: matches, pattern: "wont-be-there" }\non_fail: gate\nmax_redos: 0`);
  const io = { turn: async () => ({ summary: 'done' }), runCheck: async () => ({ code: 0, stdout: 'hi\n', stderr: '' }) };
  const run = await runPlaybook({ task: 'x', playbook: pb, io });
  assert.equal(run.pass, false);
  assert.match(run.display, /no match \/wont-be-there\//);
});
