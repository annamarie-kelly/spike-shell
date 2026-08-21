// The agent-event-hook is the one place Spike enriches its log with *content*
// (the Bash command + exit code behind a `tool.end`), so a path-only audit
// trail can answer "did a verify/test run this session, and did it pass?".
// It's a Python shim, so we test it the honest way: spawn the real script,
// feed it mock Claude hook payloads on stdin, and assert on what it POSTs to a
// throwaway capture server. Stays inside `node --test` — no new runner, no deps.
//
// Two contracts under test: (1) the enrichment lands for Bash and ONLY Bash;
// (2) the hook NEVER exits non-zero — a hook that throws kills the agent's
// tool call, so any payload shape must still exit 0.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK = fileURLToPath(new URL('../shims/agent-event-hook', import.meta.url));
const PYTHON = process.env.PYTHON || 'python3';

// The capture server mirrors cli_listener::authorized() on the one axis that
// matters here: no x-spike-token, no intake. A server that 200s everything is
// how the real outage hid — between e6e429b (2026-06-15, token required) and
// its repair the hook 403'd on every event for five weeks, and this suite went
// on passing because it had mocked the authorization boundary away. Rejecting
// here is what makes `hook_sends_the_cli_token` below able to fail.
const TEST_TOKEN = 'test-token-not-a-secret';

// Mirror of cli_listener.rs `authorized()` (~line 145). It rejects on THREE
// axes, and a mock that only checked the token made the other two invisible:
// a regression in either would pass this suite while production 403'd every
// event — the same silent-outage shape the token bug already caused once.
//   1. any Origin header at all  → reject (bin/spike sends none; browsers
//      always do, so its presence means the caller is a web page)
//   2. Host must be loopback     → reject otherwise (DNS-rebinding defence)
//   3. x-spike-token must match
// Returns a short reason string when the request would be denied, else null.
function authorizedDenialReason(req) {
  if ('origin' in req.headers) return 'origin-header-present';
  const host = req.headers.host;
  if (host !== undefined) {
    const ok = host === `127.0.0.1:${port}` || host === `localhost:${port}`
      || host === '127.0.0.1' || host === 'localhost';
    if (!ok) return `non-loopback-host:${host}`;
  }
  if (req.headers['x-spike-token'] !== TEST_TOKEN) return 'missing-or-bad-token';
  return null;
}

let server, port;
const received = [];
const rejected = [];
// The decision the mock resolve endpoint hands the next permission poll, and a
// record of which prompt_ids were polled. A test sets `nextDecision` before
// running the hook; the GET returns it once (one-shot, like take_permission).
let nextDecision = null;
const polled = [];

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const deny = authorizedDenialReason(req);
      if (deny) {
        rejected.push(deny);
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end('{"error":"forbidden"}');
        return;
      }
      // The inline-approval poll: GET /agent-permission?prompt_id=… → the
      // decision the UI made, consumed on read (mirrors take_permission).
      if (req.method === 'GET' && req.url.startsWith('/agent-permission')) {
        const id = new URL(req.url, 'http://x').searchParams.get('prompt_id');
        polled.push(id);
        const decision = nextDecision;
        nextDecision = null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ decision }));
        return;
      }
      try { received.push(JSON.parse(body)); } catch { /* ignore */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(() => server.close());

// Spawn the hook with `payload` on stdin; resolve with its exit code and the
// events it POSTed during this run. The hook calls urlopen().read() (waits for
// our response) before exiting, so the capture is in `received` by 'close'.
function runHook(payload, env = hookEnv()) {
  const start = received.length;
  return new Promise((resolve) => {
    const child = spawn(PYTHON, [HOOK], { env });
    // stdout carries the PreToolUse permission decision (the approval path);
    // existing tests ignore it, so capturing it is backward-compatible.
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    child.on('close', (code) => {
      setImmediate(() => resolve({ code, events: received.slice(start), stdout }));
    });
  });
}

// Every ambient SPIKE_* var the hook reads must be pinned to this suite's fake
// server, not merely shadowed by one of higher precedence. `node --test` run
// from inside a Spike lane inherits a real SPIKE_PORT and a real SPIKE_TOKEN,
// so a hook that resolves the port differently than we expect will happily
// authenticate into the live broker and write fixtures — `/repo/x.ts`,
// `npm test` exit 1 — straight into ~/.spike/logs. That happened. Pinning both
// vars makes the leak impossible under any precedence order rather than
// relying on SPIKE_AGENT_PORT winning.
const hookEnv = (overrides = {}) => ({
  ...process.env,
  SPIKE_AGENT_PORT: String(port),
  SPIKE_PORT: String(port),
  SPIKE_TOKEN: TEST_TOKEN,
  ...overrides,
});

const toolEnd = (events) => events.find((e) => e.kind === 'tool.end');

test('Bash tool.end is enriched with command + exit_code', async () => {
  const { code, events } = await runHook({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'npm run verify' },
    tool_response: { is_error: false, exit_code: 0 },
    session_id: 'sess-1',
  });
  assert.equal(code, 0);
  const end = toolEnd(events);
  assert.ok(end, 'a tool.end was emitted');
  assert.equal(end.data.tool, 'Bash');
  assert.equal(end.data.ok, true);
  assert.equal(end.data.command, 'npm run verify');
  assert.equal(end.data.exit_code, 0);
});

test('a failing Bash command reports ok:false and its non-zero exit_code', async () => {
  const { events } = await runHook({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_response: { is_error: true, exit_code: 1 },
  });
  const end = toolEnd(events);
  assert.equal(end.data.ok, false);
  assert.equal(end.data.command, 'npm test');
  assert.equal(end.data.exit_code, 1);
});

test('non-Bash tools never leak a command into the log', async () => {
  const { events } = await runHook({
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    tool_input: { file_path: '/secret/path' },
    tool_response: {},
  });
  const end = toolEnd(events);
  assert.ok(end, 'tool.end still emitted for non-Bash tools');
  assert.equal(end.data.command, undefined, 'no command key');
  assert.equal(end.data.exit_code, undefined, 'no exit_code key');
});

test('long commands are bounded to keep the jsonl small', async () => {
  const { events } = await runHook({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'x'.repeat(2000) },
    tool_response: { is_error: false },
  });
  assert.equal(toolEnd(events).data.command.length, 1000);
});

test('a Write still emits file.write + a tool.end with no command', async () => {
  const { events } = await runHook({
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    tool_input: { file_path: '/repo/x.ts' },
    tool_response: { is_error: false },
  });
  assert.ok(events.find((e) => e.kind === 'file.write'), 'file.write preserved');
  assert.equal(toolEnd(events).data.command, undefined);
});

test('the hook sends the CLI token, so the real listener accepts its events', async () => {
  // Guards the five-week silent outage: cli_listener::authorized() rejects any
  // route without x-spike-token, and the hook swallows failures by design, so a
  // missing header is invisible in production. If the header stops going out,
  // the capture server 403s and nothing lands in `received`.
  const before = rejected.length;
  const { code, events } = await runHook({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_response: { is_error: false },
  });
  assert.equal(code, 0);
  assert.equal(rejected.length, before, 'no event was refused for a missing token');
  assert.ok(toolEnd(events), 'the event was accepted and captured');
});

test('a tokenless hook is refused — the outage reproduces without the header', async () => {
  // The negative half: strip SPIKE_TOKEN and the hook must still exit 0 (the
  // silence contract holds) while landing nothing. This is exactly what every
  // event did between 2026-06-15 and the fix.
  const start = received.length;
  const before = rejected.length;
  const { code } = await new Promise((resolve) => {
    const env = hookEnv();
    delete env.SPIKE_TOKEN;
    const child = spawn(PYTHON, [HOOK], { env });
    child.stdin.end(JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_response: { is_error: false },
    }));
    child.on('close', (c) => setImmediate(() => resolve({ code: c })));
  });
  assert.equal(code, 0, 'silence on failure: a refused POST never kills the tool call');
  assert.ok(rejected.length > before, 'the server refused it');
  assert.equal(received.length, start, 'nothing was recorded');
});

test('the hook satisfies every axis of authorized(), not just the token', async () => {
  // The capture server now mirrors all three checks in cli_listener.rs's
  // authorized(). Landing an event proves the hook sends no Origin header and
  // a loopback Host as well as a valid token — the two axes a token-only mock
  // could never see.
  const before = rejected.length;
  const { events } = await runHook({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_response: { is_error: false },
  });
  assert.deepEqual(rejected.slice(before), [], 'no denial on any axis');
  assert.ok(toolEnd(events), 'event accepted');
});

test('contract: a malformed port never crashes the hook', async () => {
  // PORT resolution runs at module scope, OUTSIDE main()'s try/except, so a
  // bare int() on a bad value exits 1 and kills the agent's tool call. This is
  // reachable in production: pty.rs sets SPIKE_PORT in every lane, so one bad
  // value would take down every tool call in every lane.
  for (const [label, over] of [
    ['bad SPIKE_AGENT_PORT', { SPIKE_AGENT_PORT: 'not-a-port' }],
    ['bad SPIKE_PORT', { SPIKE_AGENT_PORT: '', SPIKE_PORT: 'not-a-port' }],
    ['both bad', { SPIKE_AGENT_PORT: 'x', SPIKE_PORT: 'y' }],
    ['out-of-range port', { SPIKE_AGENT_PORT: '99999' }],
    ['negative port', { SPIKE_AGENT_PORT: '-1' }],
  ]) {
    const code = await new Promise((resolve) => {
      const child = spawn(PYTHON, [HOOK], { env: hookEnv(over) });
      child.stdin.end(JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_response: { is_error: false },
      }));
      child.on('close', (c) => setImmediate(() => resolve(c)));
    });
    assert.equal(code, 0, `${label}: hook must exit 0, got ${code}`);
  }
});

test('a malformed override falls through to the next source, not to a crash', async () => {
  // Resolution order must degrade rather than throw: a junk explicit override
  // hands off to the ambient var, and junk everywhere lands on the default.
  const read = (over) => new Promise((resolve) => {
    const child = spawn(PYTHON, ['-c',
      'import runpy,sys; print(runpy.run_path(sys.argv[1])["PORT"])', HOOK],
      { env: hookEnv(over) });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('close', () => resolve(out.trim()));
  });
  assert.equal(await read({ SPIKE_AGENT_PORT: 'junk', SPIKE_PORT: '4321' }), '4321',
    'junk override falls through to the ambient port');
  assert.equal(await read({ SPIKE_AGENT_PORT: 'junk', SPIKE_PORT: 'junk' }), '7878',
    'junk everywhere lands on the default');
});

test('a permission-prompt Notification becomes a notify event carrying its type', async () => {
  // The whole point of wiring the Notification hook: PreToolUse fires before a
  // permission prompt AND before a slow tool, so it can't tell them apart.
  // Notification fires ONLY when the turn is actually blocked on the person,
  // and notification_type says why — the honest signal the chat view hands off on.
  const { code, events } = await runHook({
    hook_event_name: 'Notification',
    notification_type: 'permission_prompt',
    message: 'Claude needs your permission to use Bash',
    session_id: 'sess-perm',
  });
  assert.equal(code, 0);
  const n = events.find((e) => e.kind === 'notify');
  assert.ok(n, 'a notify event was emitted');
  assert.equal(n.data.notification_type, 'permission_prompt');
  assert.equal(n.run_id, 'sess-perm');
});

test('a needs-input Notification also hands off', async () => {
  const { events } = await runHook({
    hook_event_name: 'Notification',
    notification_type: 'agent_needs_input',
  });
  const n = events.find((e) => e.kind === 'notify');
  assert.ok(n, 'notify emitted for agent_needs_input');
  assert.equal(n.data.notification_type, 'agent_needs_input');
});

test('a non-blocking Notification (idle) emits nothing — no log noise, no false nudge', async () => {
  // idle_prompt / auth_success are not blocks. Forwarding them would badge tabs
  // and clutter the audit log for a turn that simply ended.
  const { code, events } = await runHook({
    hook_event_name: 'Notification',
    notification_type: 'idle_prompt',
  });
  assert.equal(code, 0);
  assert.equal(events.find((e) => e.kind === 'notify'), undefined, 'no notify for idle');
});

test('a Notification with no type never crashes the hook', async () => {
  const { code, events } = await runHook({ hook_event_name: 'Notification' });
  assert.equal(code, 0);
  assert.equal(events.find((e) => e.kind === 'notify'), undefined);
});

test('contract: malformed JSON on stdin exits 0 and emits nothing', async () => {
  const { code, events } = await runHook('not json at all');
  assert.equal(code, 0);
  assert.equal(events.length, 0);
});

test('contract: an unexpected payload shape exits 0 (never kills the tool call)', async () => {
  // tool_response as a string used to crash the hook (AttributeError) → exit 1,
  // which kills the agent's tool call. The top-level guard must absorb it.
  const { code } = await runHook({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_response: 'surprise-string',
  });
  assert.equal(code, 0);
});

// ── inline approvals ─────────────────────────────────────────────────────────
// Spike asks the person only when Claude is actually about to prompt, which is
// exactly when PermissionRequest fires. PreToolUse must stay silent: it runs
// before Claude has decided anything, so asking there invents prompts for calls
// that were already allowed. HOME is isolated so the session allow-set writes to
// a temp dir, never the real ~/.spike.
const approvalEnv = (home) => hookEnv({ HOME: home });
const askBash = (id = 'toolu_x1', command = 'npm run build') => ({
  hook_event_name: 'PermissionRequest', tool_name: 'Bash',
  tool_input: { command }, tool_use_id: id, prompt_id: id, session_id: 'sess-appr',
});
const decisionOf = (stdout) => {
  try { return JSON.parse(stdout).hookSpecificOutput.decision.behavior; } catch { return null; }
};

test('a permission request asks the person, and Allow lets it run', async () => {
  const home = mkdtempSync(join(tmpdir(), 'spike-appr-'));
  nextDecision = 'allow_once';
  const { code, events, stdout } = await runHook(askBash(), approvalEnv(home));
  assert.equal(code, 0);
  const ask = events.find((e) => e.kind === 'permission.ask');
  assert.ok(ask, 'a permission.ask event was emitted');
  assert.equal(ask.data.tool, 'Bash');
  assert.equal(ask.data.target, 'npm run build');
  assert.equal(ask.data.prompt_id, 'toolu_x1');
  assert.ok(polled.includes('toolu_x1'), 'the hook polled for the decision');
  assert.equal(decisionOf(stdout), 'allow', 'stdout tells Claude to allow the tool');
  assert.ok(events.find((e) => e.kind === 'permission.resolved'), 'the UI is told the prompt resolved');
});

test('Deny blocks the tool', async () => {
  const home = mkdtempSync(join(tmpdir(), 'spike-appr-'));
  nextDecision = 'deny';
  const { stdout } = await runHook(askBash('toolu_d1'), approvalEnv(home));
  assert.equal(decisionOf(stdout), 'deny');
});

test('PreToolUse never asks — only Claude decides whether a prompt is needed', async () => {
  // The regression that made Spike pop an Allow/Deny panel for commands the
  // terminal was never going to ask about, blocking the tool while it waited.
  const home = mkdtempSync(join(tmpdir(), 'spike-appr-'));
  nextDecision = 'allow_once';
  const { code, events, stdout } = await runHook({
    hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: 'npm run build' }, tool_use_id: 'toolu_p1', session_id: 'sess-appr',
  }, approvalEnv(home));
  assert.equal(code, 0);
  assert.equal(events.find((e) => e.kind === 'permission.ask'), undefined, 'PreToolUse raises no panel');
  assert.equal(stdout.trim(), '', 'no decision — Claude decides whether to ask');
  // tool.start still fires (the live status line depends on it).
  assert.ok(events.find((e) => e.kind === 'tool.start'), 'tool.start still emitted');
});

test('"allow for this session" remembers, so the same call runs silently next time', async () => {
  const home = mkdtempSync(join(tmpdir(), 'spike-appr-'));
  // First call: allow for the session.
  nextDecision = 'allow_session';
  const first = await runHook(askBash('toolu_s1', 'npm test'), approvalEnv(home));
  assert.equal(decisionOf(first.stdout), 'allow');
  assert.ok(first.events.find((e) => e.kind === 'permission.ask'), 'first call asks');
  // Second identical call: no decision offered — but the allow-set short-circuits.
  nextDecision = null;
  const second = await runHook(askBash('toolu_s2', 'npm test'), approvalEnv(home));
  assert.equal(second.events.find((e) => e.kind === 'permission.ask'), undefined, 'no second ask');
  assert.equal(decisionOf(second.stdout), 'allow', 'allowed silently from the session set');
});

test('contract: a permission request with a dead broker never blocks or crashes', async () => {
  // Point the hook at a closed port: the permission.ask POST fails, so it must
  // fall straight through (no polling, no hang) and exit 0 — Claude's own
  // prompt then handles it. A stalled hook here would freeze every tool call.
  const home = mkdtempSync(join(tmpdir(), 'spike-appr-'));
  const env = hookEnv({ HOME: home, SPIKE_AGENT_PORT: '1', SPIKE_PORT: '1' });
  const started = Date.now();
  const { code, stdout } = await runHook(askBash('toolu_dead'), env);
  assert.equal(code, 0);
  assert.equal(stdout.trim(), '', 'no decision — deferred to native');
  assert.ok(Date.now() - started < 5000, 'did not block on the dead broker');
});
