// codex-agent-event-hook is the Codex sibling of agent-event-hook: Codex spawns
// it for PreToolUse/PostToolUse/Stop and it POSTs canonical broker events. We
// test it the same honest way — spawn the real Python script, feed it mock
// Codex hook payloads on stdin, and assert on what it POSTs to a throwaway
// capture server. Stays inside `node --test`, no new runner, no deps.
//
// Contracts under test: the four canonical kinds (tool.start / tool.end /
// file.write / turn.ended), the apply_patch → secondary file.write per path
// (the preview-refresh driver), run_id/session_id mapping, and the absolute
// rule that the hook NEVER exits non-zero (a throwing hook kills the tool call).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../shims/codex-agent-event-hook', import.meta.url));
const PYTHON = process.env.PYTHON || 'python3';

let server, port;
const received = [];

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try { received.push(JSON.parse(body)); } catch { /* ignore */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(() => server.close());

// Spawn the hook with `payload` on stdin. Both port vars point at our stub
// (SPIKE_AGENT_PORT is the override the _port() helper checks first);
// SPIKE_SESSION_ID is the canonical session_id the hook should forward. The
// hook waits on urlopen().read() before exiting, so captured events are in
// `received` by 'close'.
function runHook(payload, env = {}) {
  const start = received.length;
  return new Promise((resolve) => {
    const child = spawn(PYTHON, [HOOK], {
      env: {
        ...process.env,
        SPIKE_PORT: String(port),
        SPIKE_AGENT_PORT: String(port),
        SPIKE_SESSION_ID: 's-tab-1',
        SPIKE_TOKEN: '',
        SPIKE_CODEX_HOME: '',
        CODEX_HOME: '',
        ...env,
      },
    });
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    child.on('close', (code) => {
      setImmediate(() => resolve({ code, events: received.slice(start) }));
    });
  });
}

const byKind = (events, kind) => events.filter((e) => e.kind === kind);
const one = (events, kind) => byKind(events, kind)[0];

test('PreToolUse → tool.start with the real Codex tool name', async () => {
  const { code, events } = await runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'shell',
    session_id: 'conv-abc',
  });
  assert.equal(code, 0);
  const start = one(events, 'tool.start');
  assert.ok(start, 'tool.start emitted');
  assert.equal(start.data.tool, 'shell');
  // run_id = Codex session id; session_id = the Spike tab id from env.
  assert.equal(start.run_id, 'conv-abc');
  assert.equal(start.session_id, 's-tab-1');
  // Codex has no structured question event — no question.asked ever.
  assert.equal(byKind(events, 'question.asked').length, 0);
});

test('PostToolUse → tool.end with ok:true parsed from "Exit code: 0"', async () => {
  const { events } = await runHook({
    hook_event_name: 'PostToolUse',
    tool_name: 'shell',
    tool_input: { command: 'ls' },
    tool_response: 'Exit code: 0\nWall time: 0.1 seconds\nOutput:\nok\n',
    session_id: 'conv-abc',
  });
  const end = one(events, 'tool.end');
  assert.ok(end);
  assert.equal(end.data.tool, 'shell');
  assert.equal(end.data.ok, true);
});

test('a non-zero Exit code marks ok:false', async () => {
  const { events } = await runHook({
    hook_event_name: 'PostToolUse',
    tool_name: 'shell',
    tool_input: { command: 'false' },
    tool_response: 'Exit code: 1\nWall time: 0.0 seconds\n',
  });
  assert.equal(one(events, 'tool.end').data.ok, false);
});

test('apply_patch emits a file.write per changed path AND a tool.end', async () => {
  const patch = [
    '*** Begin Patch',
    '*** Add File: a.txt',
    '+hi',
    '*** Update File: sub/b.txt',
    '@@',
    '-x',
    '+y',
    '*** Delete File: c.txt',
    '*** End Patch',
  ].join('\n');
  const { events } = await runHook({
    hook_event_name: 'PostToolUse',
    tool_name: 'apply_patch',
    tool_input: { command: patch },
    tool_response: 'Success. Updated the following files:\nA a.txt\n',
    cwd: '/repo',
    session_id: 'conv-abc',
  });
  const writes = byKind(events, 'file.write').map((e) => e.data.path).sort();
  // Relative patch paths resolved to absolute against cwd.
  assert.deepEqual(writes, ['/repo/a.txt', '/repo/c.txt', '/repo/sub/b.txt']);
  for (const w of byKind(events, 'file.write')) assert.equal(w.data.tool, 'apply_patch');
  assert.ok(one(events, 'tool.end'), 'tool.end still emitted alongside file.write');
});

test('apply_patch: absolute patch paths are kept, "*** Move to:" is captured', async () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: old/name.txt',
    '*** Move to: new/name.txt',
    '@@',
    '+z',
    '*** Add File: /abs/already.txt',
    '*** End Patch',
  ].join('\n');
  const { events } = await runHook({
    hook_event_name: 'PostToolUse',
    tool_name: 'apply_patch',
    tool_input: { command: patch },
    tool_response: 'Exit code: 0\n',
    cwd: '/repo',
  });
  const writes = byKind(events, 'file.write').map((e) => e.data.path).sort();
  assert.deepEqual(writes, ['/abs/already.txt', '/repo/new/name.txt', '/repo/old/name.txt']);
});

test('a failed apply_patch emits no file.write (but still a tool.end)', async () => {
  const { events } = await runHook({
    hook_event_name: 'PostToolUse',
    tool_name: 'apply_patch',
    tool_input: { command: '*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch' },
    tool_response: 'Exit code: 1\napply_patch failed\n',
    cwd: '/repo',
  });
  assert.equal(byKind(events, 'file.write').length, 0);
  assert.equal(one(events, 'tool.end').data.ok, false);
});

test('Stop → turn.ended (the pause/turn-end indicator)', async () => {
  const { events } = await runHook({
    hook_event_name: 'Stop',
    stop_hook_active: false,
    session_id: 'conv-abc',
  });
  const end = one(events, 'turn.ended');
  assert.ok(end);
  assert.equal(end.run_id, 'conv-abc');
  assert.equal(end.session_id, 's-tab-1');
});

test('Stop re-fires (stop_hook_active) are dropped', async () => {
  const { events } = await runHook({ hook_event_name: 'Stop', stop_hook_active: true });
  assert.equal(events.length, 0);
});

test('run_id falls back to codex-unknown only when session_id is absent', async () => {
  const { events } = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'shell' });
  assert.equal(one(events, 'tool.start').run_id, 'codex-unknown');
});

test('an unknown hook event is silently dropped', async () => {
  const { code, events } = await runHook({
    hook_event_name: 'SessionStart',
    tool_name: 'shell',
    session_id: 'conv-abc',
  });
  assert.equal(code, 0);
  assert.equal(events.length, 0);
});

test('contract: malformed JSON on stdin exits 0 and emits nothing', async () => {
  const { code, events } = await runHook('not json at all');
  assert.equal(code, 0);
  assert.equal(events.length, 0);
});

test('contract: an unexpected payload shape exits 0 (never kills the tool call)', async () => {
  // tool_response as an object, tool_input as a non-dict — must not throw.
  const { code } = await runHook({
    hook_event_name: 'PostToolUse',
    tool_name: 'apply_patch',
    tool_input: 'surprise-string',
    tool_response: { is_error: true },
  });
  assert.equal(code, 0);
});
