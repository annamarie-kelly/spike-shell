// Pure-parser tests for the chat view. No app, no Tauri, no DOM — everything
// here exercises the transcript adapters and the humanizer, which is where the
// view's correctness actually lives. (npm test builds dist/ first.)
//
// The Codex half matters most. Claude's shape is verified against real
// transcripts and covered end-to-end by verify/scenarios/chat-view.mjs; Codex
// has no rollout file on this machine, so its adapter had never been executed
// at all. These fixtures are written from the documented rollout format, which
// makes them a guard against regressions rather than proof the format is
// right — treat a real rollout as the outstanding check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, humanize, phrase, summarize, openDelegateCount, reconcilePending, AttachmentQueue, ChatStream, parseFindings, parseCoderVerdicts, findingId, splitDrafts, asksForDraft, PERMISSION_OPTIONS, PERMISSION_OPTIONS_KEYSTROKE } from '../dist/web/chatview.js';

const jsonl = (rows) => rows.map((r) => JSON.stringify(r));

test('codex: a rollout becomes turns, with tool calls folded', () => {
  const turns = parse(jsonl([
    { type: 'session_meta', payload: { cwd: '/proj' } },
    { timestamp: '2026-07-28T12:00:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'tidy the notes' }] } },
    { payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'On it.' }] } },
    { payload: { type: 'function_call', name: 'shell', arguments: '{"command":"ls notes"}' } },
    { payload: { type: 'local_shell_call', action: { command: 'wc -l notes.md' } } },
    { payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] } },
  ]), 'codex');

  assert.equal(turns.length, 2, 'one user turn, one agent turn');
  assert.equal(turns[0].actor, 'you');
  assert.equal(turns[0].blocks[0].text, 'tidy the notes');

  const agent = turns[1];
  assert.equal(agent.actor, 'agent');
  // prose, one folded run of calls, prose
  assert.deepEqual(agent.blocks.map((b) => b.type), ['text', 'actions', 'text']);
  assert.equal(agent.blocks[1].items.length, 2, 'both call shapes are understood');
  assert.equal(agent.blocks[2].text, 'Done.');
});

test('codex: an exec call shows its command, not a bare "Exec" (#21)', () => {
  // Codex names the tool "exec" and sends the command as an argv array with a
  // shell wrapper. The chip must read the real command, not the tool name.
  const turns = parse(jsonl([
    { payload: { type: 'function_call', name: 'exec', arguments: '{"command":["bash","-lc","git status"]}' } },
  ]), 'codex');
  const item = turns[0].blocks[0].items[0];
  const label = phrase(item);
  assert.doesNotMatch(label, /^Exec$/i, 'never a bare "Exec"');
  assert.match(label, /git status/, 'the actual command shows in the chip');
  assert.equal(item.detail, 'git status', 'argv is flattened to the real command');
});

test('codex: a shell call with a plain-string command shows the command (#21)', () => {
  const turns = parse(jsonl([
    { payload: { type: 'local_shell_call', action: { command: 'npm run build' } } },
  ]), 'codex');
  const item = turns[0].blocks[0].items[0];
  assert.match(phrase(item), /npm run build/, 'string command shows verbatim');
});

test('codex: a re-emitted tool call (same id) is NOT appended twice (#20 leak)', () => {
  // Codex restates prior items as context; an overlapping tail can hand the
  // same function_call row back. It must not grow the action strip.
  const call = { payload: { type: 'function_call', name: 'exec', call_id: 'c7', arguments: '{"command":["bash","-lc","ls"]}' } };
  const turns = parse(jsonl([call, call, call]), 'codex');
  const items = turns[0].blocks[0].items;
  assert.equal(items.length, 1, 'the same call id folds to one chip, not three');
});

test('codex: a call restated as context on a later poll does not grow the strip (#20 leak)', () => {
  // Codex's real re-emission pattern: a later turn's input restates the prior
  // turn's tool call (same call_id) as context. Fed incrementally across polls,
  // that call must fold onto the existing chip — not append a second one, which
  // would grow the last turn every poll and force a full transcript rebuild.
  const s = new ChatStream('codex');
  s.push(jsonl([
    { payload: { type: 'function_call', name: 'exec', call_id: 'c1', arguments: '{"command":["bash","-lc","npm run build"]}' } },
    { payload: { type: 'function_call_output', call_id: 'c1', output: 'built ok' } },
  ]));
  const afterFirst = JSON.stringify(s.turns());
  // Next poll: the SAME call c1 is restated (context), then a genuinely new call.
  s.push(jsonl([
    { payload: { type: 'function_call', name: 'exec', call_id: 'c1', arguments: '{"command":["bash","-lc","npm run build"]}' } },
    { payload: { type: 'function_call', name: 'exec', call_id: 'c2', arguments: '{"command":["bash","-lc","npm test"]}' } },
  ]));
  const items = s.turns()[0].blocks[0].items;
  assert.equal(items.length, 2, 'restated c1 folds; only the new c2 is added → 2 chips, not 3');
  assert.match(items[0].detail, /npm run build/);
  assert.match(items[1].detail, /npm test/);
  // And the first poll's rendering was already stable (c1 present exactly once).
  assert.match(afterFirst, /npm run build/);
});

test('codex: a genuinely repeated command (distinct ids) is kept, not deduped', () => {
  // The dedup keys on call_id, so two real `ls` runs (different ids) both show.
  const turns = parse(jsonl([
    { payload: { type: 'function_call', name: 'exec', call_id: 'a', arguments: '{"command":["bash","-lc","ls"]}' } },
    { payload: { type: 'function_call', name: 'exec', call_id: 'b', arguments: '{"command":["bash","-lc","ls"]}' } },
  ]), 'codex');
  assert.equal(turns[0].blocks[0].items.length, 2, 'distinct ids are two real steps');
});

test('codex: a tool result is carried back under its call', () => {
  const turns = parse(jsonl([
    { payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{"command":"ls"}' } },
    { payload: { type: 'function_call_output', call_id: 'c1', output: 'notes.md\nreadme.md' } },
  ]), 'codex');
  const call = turns[0].blocks[0].items[0];
  assert.match(call.result, /notes\.md/, 'the output shows under the call');
});

test('codex: an empty tool result still marks the call completed', () => {
  const turns = parse(jsonl([
    { payload: { type: 'function_call', name: 'shell', call_id: 'c9', arguments: '{"command":"touch x"}' } },
    { payload: { type: 'function_call_output', call_id: 'c9', output: '' } },
  ]), 'codex');
  const call = turns[0].blocks[0].items[0];
  assert.ok(call.result, 'a zero-output run still shows a result body');
  assert.equal(call.result, '(no output)');
});

test('codex: tool calls in a response_item wrapper still render', () => {
  // The envelope moved to `response_item`; the call must not vanish.
  const turns = parse(jsonl([
    { type: 'response_item', response_item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'working' }] } },
    { type: 'response_item', response_item: { type: 'function_call', name: 'shell', arguments: '{"command":"pwd"}' } },
  ]), 'codex');
  const agent = turns[0];
  assert.deepEqual(agent.blocks.map((b) => b.type), ['text', 'actions']);
  assert.equal(agent.blocks[1].items.length, 1);
});

test('codex: an unknown envelope is skipped, not crashed on', () => {
  const turns = parse(jsonl([
    { payload: { type: 'something_new_we_have_not_seen', data: { a: 1 } } },
    { payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'still here' }] } },
  ]).concat(['{not json at all']), 'codex');
  assert.equal(turns.length, 1);
  assert.equal(turns[0].blocks[0].text, 'still here');
});

test('codex: a preamble-only first turn never renders as a user turn', () => {
  const turns = parse(jsonl([
    { payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<user_instructions>\n# AGENTS.md instructions\nDo project things.\n</user_instructions>\n<environment_context>\ncwd: /proj\nshell: zsh\n</environment_context>' }] } },
    { payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<INSTRUCTIONS>\nYou are running inside Spike.\n</INSTRUCTIONS>' }] } },
    { payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'tidy the notes' }] } },
  ]), 'codex');
  const said = turns.filter((t) => t.actor === 'you').map((t) => t.blocks[0].text);
  assert.deepEqual(said, ['tidy the notes'], 'only the real message survives');
  assert.ok(!JSON.stringify(turns).includes('environment_context'), 'no env context leaks');
  assert.ok(!JSON.stringify(turns).includes('running inside Spike'), 'no instructions leak');
});

test('codex: a real message stapled after the preamble is kept, not dropped', () => {
  const turns = parse(jsonl([
    { payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions\n\n<environment_context>\ncwd: /proj\n</environment_context>\n\nSummarize the repo in plain language.' }] } },
  ]), 'codex');
  const said = turns.filter((t) => t.actor === 'you').map((t) => t.blocks[0].text);
  assert.deepEqual(said, ['Summarize the repo in plain language.'], 'the real trailing message survives');
  assert.ok(!JSON.stringify(turns).includes('environment_context'), 'preamble still excised');
});

test('claude: harness rows never become a person\'s turn', () => {
  const turns = parse(jsonl([
    { type: 'user', message: { role: 'user', content: 'real message' } },
    { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'file bytes' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'ok' }] } },
  ]), 'claude');
  const said = turns.filter((t) => t.actor === 'you').map((t) => t.blocks[0].text);
  assert.deepEqual(said, ['real message']);
  assert.ok(!JSON.stringify(turns).includes('private'), 'thinking is dropped');
});

test('interrupt + tool-rejection plumbing never renders (both engines)', () => {
  const rejection = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
  // Claude: the markers arrive as user rows around the real answer.
  const claude = parse(jsonl([
    { type: 'user', message: { role: 'user', content: rejection } },
    { type: 'user', message: { role: 'user', content: '[Request interrupted by user for tool use]' } },
    { type: 'user', message: { role: 'user', content: "I'll drive" } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Great, you drive.' }] } },
  ]), 'claude');
  const claudeYou = claude.filter((t) => t.actor === 'you').map((t) => t.blocks[0].text);
  assert.deepEqual(claudeYou, ["I'll drive"], 'only the real answer survives');
  assert.ok(!JSON.stringify(claude).includes('interrupted by user'), 'no interrupt marker');
  assert.ok(!JSON.stringify(claude).includes("doesn't want to proceed"), 'no rejection block');

  // Codex: same markers, same result.
  const codex = parse(jsonl([
    { payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[Request interrupted by user for tool use]' }] } },
    { payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: "I'll drive" }] } },
  ]), 'codex');
  const codexYou = codex.filter((t) => t.actor === 'you').map((t) => t.blocks[0].text);
  assert.deepEqual(codexYou, ["I'll drive"]);
});

test('claude: markup a person typed survives the harness filter', () => {
  // A catch-all for anything tag-shaped used to strip real content here.
  const turns = parse(jsonl([
    { type: 'user', message: { role: 'user', content: 'why is <Header /> broken in <main>?' } },
  ]), 'claude');
  assert.equal(turns[0].blocks[0].text, 'why is <Header /> broken in <main>?');
});

test('claude: a result is carried back to the call that produced it', () => {
  const turns = parse(jsonl([
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Write', input: { file_path: '/p/a.ts', content: 'one\ntwo\nthree' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Wrote 3 lines to /p/a.ts' }] } },
  ]), 'claude');
  const a = turns[0].blocks[0].items[0];
  assert.equal(a.magnitude, '3 lines');
  assert.match(a.result, /Wrote 3 lines/);
  assert.equal(a.failed, undefined);
});

test('claude: is_error marks the step as failed', () => {
  const turns = parse(jsonl([
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'npm run nope' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: 'npm ERR!' }] } },
  ]), 'claude');
  assert.equal(turns[0].blocks[0].items[0].failed, true);
});

test('claude: one dropped image counts once, not twice', () => {
  // The harness writes an "[Image #N]" marker into the text AND ships a real
  // `image` content block for the same picture. Counting both read as "2
  // images attached" for a single drop.
  const one = parse(jsonl([
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Image #1] look at this' }, { type: 'image', source: { type: 'base64', data: 'x' } }] } },
  ]), 'claude');
  assert.equal(one[0].attachments, 1, 'one image, counted once');

  const none = parse(jsonl([
    { type: 'user', message: { role: 'user', content: 'just words' } },
  ]), 'claude');
  assert.equal(none[0].attachments, undefined, 'no image, no chip');

  const two = parse(jsonl([
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Image #1] [Image #2] two' }, { type: 'image', source: { type: 'base64', data: 'a' } }, { type: 'image', source: { type: 'base64', data: 'b' } }] } },
  ]), 'claude');
  assert.equal(two[0].attachments, 2, 'two images, counted twice');
});

test('claude: an unfinished subagent counts as a background agent being waited on', () => {
  // A Task whose result has not landed = a background agent still running.
  const running = parse(jsonl([
    { type: 'user', message: { role: 'user', content: 'go' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'ta1', name: 'Task', input: { description: 'audit deps', prompt: 'do it' } }] } },
  ]), 'claude');
  assert.equal(openDelegateCount(running), 1, 'one open delegation');

  // Once the result lands, it is no longer being waited on.
  const done = parse(jsonl([
    { type: 'user', message: { role: 'user', content: 'go' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'ta1', name: 'Task', input: { description: 'audit deps', prompt: 'do it' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ta1', content: 'audit complete' }] } },
  ]), 'claude');
  assert.equal(openDelegateCount(done), 0, 'resolved delegation is not waited on');

  // Plain thinking with no delegation is zero.
  const plain = parse(jsonl([
    { type: 'user', message: { role: 'user', content: 'go' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'thinking...' }] } },
  ]), 'claude');
  assert.equal(openDelegateCount(plain), 0);

  // The delegation sits in an EARLIER turn: dispatched, then the person
  // interjected and the agent replied — so the last turn holds only prose. It
  // must still be counted, or the background-agent case regresses.
  const trailing = parse(jsonl([
    { type: 'user', message: { role: 'user', content: 'go' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tb1', name: 'Task', input: { description: 'crawl', prompt: 'p' } }] } },
    { type: 'user', message: { role: 'user', content: 'any update?' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'still running in the background' }] } },
  ]), 'claude');
  assert.equal(openDelegateCount(trailing), 1, 'a delegation in an earlier turn is still counted');
});

test('pending reconcile: reflow is tolerated but distinct messages are not co-evicted', () => {
  // Only kept/landed are under test here; `pairs` (which pending item matched
  // which turn, for re-anchoring a late-filed message) has its own test below.
  const outcome = (...args) => {
    const r = reconcilePending(...args);
    return { kept: r.kept, landed: r.landed };
  };

  // A shipped message picks up trailing/whitespace reflow — still clears.
  assert.deepEqual(
    outcome(['do it '], ['do it']),
    { kept: [], landed: ['do it '] },
  );

  // Two whitespace-similar-but-distinct messages queued, only ONE truly sent
  // (one landed turn): only the sent one clears, the other stays pending.
  const r = reconcilePending(['do it', 'do  it'], ['do it']);
  assert.deepEqual(r.landed, ['do it'], 'the exact match lands');
  assert.deepEqual(r.kept, ['do  it'], 'the still-unsent one is NOT evicted');

  // Two genuinely different queued messages, only the second landed.
  assert.deepEqual(
    outcome(['msg one', 'msg two'], ['msg two']),
    { kept: ['msg one'], landed: ['msg two'] },
  );

  // Newlines are structural: a one-line and a two-line message do not match.
  assert.deepEqual(
    outcome(['a\nb'], ['a b']),
    { kept: ['a\nb'], landed: [] },
  );

  // Codex leaked-prefix corruption: the transcript copy repeats a prefix of
  // itself. The optimistic clean bubble must still reconcile away (no lingering
  // duplicate) — but only when the extra is a prefix of the message.
  assert.deepEqual(
    outcome(["what's on deck"], ["whatwhat's on deck"]),
    { kept: [], landed: ["what's on deck"] },
  );
  // An unrelated longer turn is NOT a leaked-prefix match.
  assert.deepEqual(
    outcome(['deck'], ['the whole deck']),
    { kept: ['deck'], landed: [] },
  );
});

test('pending reconcile: a landed message reports WHICH turn it landed as', () => {
  // The caller needs the true turn index to put a late-filed message back where
  // it was said. Matches are consumed from the candidate pool as they are used,
  // so this must survive earlier matches shrinking it.
  const r = reconcilePending(['second', 'third'], ['first', 'second', 'third']);
  assert.deepEqual(r.landed, ['second', 'third']);
  assert.deepEqual(
    r.pairs,
    [{ pending: 0, recent: 1 }, { pending: 1, recent: 2 }],
    'the second pair still points at turn 2, not at 1 (the post-splice position)',
  );

  // Nothing landed → no pairs, and the bubble is kept.
  const none = reconcilePending(['unsent'], ['something else']);
  assert.deepEqual(none.pairs, []);
  assert.deepEqual(none.kept, ['unsent']);
});

test('the keystroke-only permission set offers no grant it cannot keep', () => {
  // Spike answers a notify-derived panel by typing a digit into a dialog it
  // cannot read. Claude's option 2 is "apply the suggested rules" — which rules
  // depends on the tool and the call — so a button labelled "Allow for this
  // session" typed a digit that can persist a rule. Only the digits that mean
  // the same thing for every tool may be offered there.
  assert.deepEqual(
    PERMISSION_OPTIONS_KEYSTROKE.map((o) => o.id),
    ['allow_once', 'deny'],
    'yes and no only',
  );
  assert.deepEqual(
    PERMISSION_OPTIONS_KEYSTROKE.map((o) => o.keystroke),
    ['1', '3'],
    'the two digits that are fixed across tool types',
  );
  assert.ok(
    !PERMISSION_OPTIONS_KEYSTROKE.some((o) => o.scope === 'session'),
    'no session grant on a path that cannot honour one',
  );
  // The full set is unchanged — the structured path resolves the hook itself,
  // so there it means what it says.
  assert.deepEqual(
    PERMISSION_OPTIONS.map((o) => o.id),
    ['allow_once', 'allow_session', 'deny'],
  );
});

test('`!` shell rows are not your messages', () => {
  // Claude records a `!`-mode command and its output as USER rows. Rendered as
  // chat bubbles they are raw-tag noise, and — worse — they count as your
  // recent messages when an optimistic bubble is matched against the
  // transcript, which is how a sent message could fail to reconcile and sit at
  // the foot of the conversation for good.
  const turns = parse(jsonl([
    { type: 'user', message: { role: 'user', content: 'deploy it' } },
    { type: 'user', message: { role: 'user', content: '<bash-input>slack deploy</bash-input>' } },
    { type: 'user', message: { role: 'user', content: '<bash-stdout>ok</bash-stdout><bash-stderr></bash-stderr>' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'shipped' }] } },
  ]), 'claude');
  const you = turns.filter((t) => t.actor === 'you');
  assert.equal(you.length, 1, 'only the message you actually typed is a turn of yours');
  assert.equal(you[0].blocks[0].text, 'deploy it');
});

test('codex: a re-emitted assistant message is not appended twice', () => {
  // The Codex rollout can re-record the assistant message (as prior-turn input
  // context). It must not grow the turn on each poll — which shifts content
  // under a scrolled-up reader (#20).
  const turns = parse(jsonl([
    { payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'explain' }] } },
    { payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The long answer.' }] } },
    { payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The long answer.' }] } },
  ]), 'codex');
  const agent = turns.find((t) => t.actor === 'agent');
  const texts = agent.blocks.filter((b) => b.type === 'text').map((b) => b.text);
  assert.deepEqual(texts, ['The long answer.'], 'the duplicate re-emission collapses');
});

test('codex: a user turn recorded twice back-to-back renders once', () => {
  const turns = parse(jsonl([
    { payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: "what's on deck" }] } },
    { payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: "what's on deck" }] } },
    { payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The deck.' }] } },
  ]), 'codex');
  const you = turns.filter((t) => t.actor === 'you');
  assert.equal(you.length, 1, 'the double-recorded user turn collapses to one');
  assert.equal(you[0].blocks[0].text, "what's on deck");
});

test('attachments: a removed chip is NOT in what gets delivered', () => {
  // This is the end-to-end retract property behind the chip's × — the disposer
  // stage() returns is exactly what the × calls.
  const q = new AttachmentQueue();
  const offA = q.stage({ path: '/tmp/a.pdf' });
  q.stage({ path: '/tmp/b.pdf' });
  offA();                       // user clicks × on a.pdf
  q.commit();                   // user hits send
  assert.deepEqual(q.next().map((x) => x.path), ['/tmp/b.pdf'], 'only the kept file is delivered');
});

test('attachments: each message carries its own files; cancel and stop drop them', () => {
  const q = new AttachmentQueue();
  // Compose + send message 1 with one file.
  q.stage({ path: '/tmp/one.png' });
  q.commit();
  // Compose message 2 with a different file while 1 is still queued.
  q.stage({ path: '/tmp/two.png' });
  assert.deepEqual(q.pending().map((x) => x.path), ['/tmp/two.png'], 'a fresh compose starts clean');
  q.commit();

  // Deliver in order, each message its own files.
  assert.deepEqual(q.next().map((x) => x.path), ['/tmp/one.png']);
  assert.deepEqual(q.next().map((x) => x.path), ['/tmp/two.png']);
  assert.deepEqual(q.next(), [], 'nothing left');

  // Cancel drops a queued message's files by index; stop drops everything.
  const q2 = new AttachmentQueue();
  q2.stage({ path: 'x' }); q2.commit();   // message 0
  q2.stage({ path: 'y' }); q2.commit();   // message 1
  q2.cancelAt(0);
  assert.deepEqual(q2.next().map((x) => x.path), ['y'], 'cancel removed message 0 and its file');

  q2.stage({ path: 'z' });
  q2.clear();
  assert.deepEqual(q2.pending(), [], 'stop cleared staged');
  assert.deepEqual(q2.next(), [], 'stop cleared queued');
});

test('connected services read as sentences, not tool names', () => {
  const say = (n) => phrase(humanize(n, {}));
  assert.equal(say('mcp__claude_ai_Slack__slack_search_public_and_private'), 'Searched Slack');
  assert.equal(say('mcp__claude_ai_Slack__slack_send_message'), 'Sent a message in Slack');
  assert.equal(say('mcp__linear__list_issues'), 'Listed Linear issues');
  assert.equal(say('mcp__affinity-mcp__search_companies_top_matches'), 'Searched Affinity');
  // An unknown verb still names the service rather than leaking the method.
  assert.equal(say('mcp__notion__notion-frobnicate'), 'Used Notion');
});

test('a connected service is marked by its own logo, or by its initial', () => {
  const mark = (n) => humanize(n, {}).mark;
  // A service we ship a logo for carries the logo itself.
  const slack = mark('mcp__claude_ai_Slack__slack_send_message');
  assert.equal(slack.key, 'slack');
  assert.match(slack.logo, /^<svg /);
  assert.equal(slack.monogram, undefined);
  // Server naming varies — harness prefix, -mcp suffix, punctuation.
  assert.equal(mark('mcp__linear__list_issues').key, 'linear');
  assert.equal(mark('mcp__claude_ai_Google_Calendar__list_events').key, 'googlecalendar');
  // Everything else falls back to its initial, which still tells two services
  // apart. It must agree with the name we print beside it.
  const sonar = mark('mcp__claude_ai_Sonar__get_company');
  assert.equal(sonar.monogram, 'S');
  assert.equal(sonar.logo, undefined);
  assert.equal(mark('mcp__affinity-mcp__search_companies_top_matches').monogram, 'A');
  // Non-MCP work keeps its plain tool glyph.
  assert.equal(mark('Read'), undefined);
});

test('a short run is named; a long one is counted', () => {
  const acts = (n) => Array.from({ length: n }, (_, i) => humanize('Read', { file_path: `/p/f${i}.ts` }));
  assert.equal(summarize(acts(2)), 'Read f0.ts · Read f1.ts');
  assert.equal(summarize(acts(9)), '9 files read');
  // A changed file is named even inside a counted run — it is the thing
  // anyone actually wants to know about.
  const mixed = [humanize('Edit', { file_path: '/p/notes.md' }), ...acts(5)];
  assert.match(summarize(mixed), /^Changed notes\.md · 5 files read$/);
});

// ── Convergence: findings in, verdicts out ───────────────────────────────────

test('parseFindings: reads the spike-findings block into structured findings', () => {
  const text = [
    "Here's what I found reviewing your change.",
    '```spike-findings',
    JSON.stringify([
      { file: 'src/x.ts', line: 42, claim: 'Off-by-one in the loop bound', severity: 'blocker', suggestion: 'Use <=' },
      { claim: 'Naming is inconsistent', severity: 'nit' },
    ]),
    '```',
    'Let me know.',
  ].join('\n');
  const fs = parseFindings(text);
  assert.equal(fs.length, 2);
  assert.equal(fs[0].file, 'src/x.ts');
  assert.equal(fs[0].line, 42);
  assert.equal(fs[0].severity, 'blocker');
  assert.equal(fs[0].suggestion, 'Use <=');
  assert.equal(fs[0].state, 'open');
  assert.equal(fs[0].bounces, 0);
  // A missing/garbage severity defaults to 'warn'; optional fields stay undefined.
  assert.equal(fs[1].severity, 'nit');
  assert.equal(fs[1].file, undefined);
});

test('parseFindings: a malformed or absent block yields nothing, never throws', () => {
  assert.deepEqual(parseFindings('no block here'), []);
  assert.deepEqual(parseFindings('```spike-findings\nnot json{{{\n```'), []);
  // Not an array → nothing.
  assert.deepEqual(parseFindings('```spike-findings\n{"claim":"x"}\n```'), []);
  // An item without a claim is dropped.
  assert.deepEqual(parseFindings('```spike-findings\n[{"severity":"warn"}]\n```'), []);
});

test('parseFindings: the LAST block wins (reviewer revised its list)', () => {
  const text = [
    '```spike-findings', '[{"claim":"first pass"}]', '```',
    'On reflection:',
    '```spike-findings', '[{"claim":"revised"},{"claim":"and another"}]', '```',
  ].join('\n');
  const fs = parseFindings(text);
  assert.equal(fs.length, 2);
  assert.equal(fs[0].claim, 'revised');
});

test('findingId: stable for the same triple, distinct across claims', () => {
  assert.equal(findingId('a.ts', 1, 'x'), findingId('a.ts', 1, 'x'));
  assert.notEqual(findingId('a.ts', 1, 'x'), findingId('a.ts', 1, 'y'));
});

test('parseCoderVerdicts: reads #N accept/reject/counter lines with reasons', () => {
  const reply = [
    "Here's my take on each:",
    '#1 accept',
    '#2 reject: this is intentional — the API guarantees non-null here',
    '#3 counter: rename to `total` instead',
    'Done.',
  ].join('\n');
  const vs = parseCoderVerdicts(reply);
  assert.equal(vs.length, 3);
  assert.deepEqual(vs[0], { index: 1, verdict: 'accept', note: undefined });
  assert.equal(vs[1].verdict, 'reject');
  assert.match(vs[1].note, /intentional/);
  assert.equal(vs[2].verdict, 'counter');
});

test('parseCoderVerdicts: tolerant of punctuation, last verdict per number wins', () => {
  const reply = ['1. accept', '#2) reject: nope', '#2 counter: actually this', 'garbage line'].join('\n');
  const vs = parseCoderVerdicts(reply);
  // #1 with a dot separator, #2 restated (counter wins over the earlier reject).
  assert.equal(vs.length, 2);
  assert.equal(vs[0].index, 1);
  assert.equal(vs[1].index, 2);
  assert.equal(vs[1].verdict, 'counter');
});

// ── draft cards ──────────────────────────────────────────────────────────
// splitDrafts decides which runs of an agent reply are composed ARTIFACTS (an
// email, a message) rather than the agent's prose about them. Getting this
// wrong in either direction is visible: a missed draft reads flat, a false
// positive cards a paragraph that was never a draft.
test('drafts: an email between commentary is split out, commentary kept', () => {
  const segs = splitDrafts([
    "Here's a draft — plus a trimmed version.",
    '',
    '**Subject:** 15 min? trying to learn how you use AI',
    '',
    'Hi [Name] —',
    '',
    "I'm Annamarie. I've spent the last few years inside firms.",
    '',
    'Would [day] or [day] work?',
    '',
    '— Annamarie',
    '',
    'Want me to make it shorter?',
  ].join('\n'));
  assert.equal(segs.length, 3);
  assert.equal(segs[0].draft, false);
  assert.match(segs[0].md, /Here's a draft/);
  assert.equal(segs[1].draft, true);
  assert.match(segs[1].md, /^\*\*Subject:\*\*/);
  assert.match(segs[1].md, /— Annamarie$/);
  assert.equal(segs[2].draft, false);
  assert.match(segs[2].md, /shorter/);
});

test('drafts: two drafts separated by an hr become two cards', () => {
  const segs = splitDrafts([
    '**Subject:** one', '', 'Hi [Name] —', '', 'Body one.', '', '— A', '',
    '---', '', '**Shorter version:**', '',
    '**Subject:** two', '', 'Hi [Name] —', '', 'Body two.', '', '— A',
  ].join('\n'));
  const drafts = segs.filter((s) => s.draft);
  assert.equal(drafts.length, 2);
  assert.match(drafts[0].md, /Body one/);
  assert.match(drafts[1].md, /Body two/);
  assert.ok(segs.some((s) => !s.draft && /Shorter version/.test(s.md)));
});

test('drafts: an explicit ```draft fence is a card, ordinary code is not', () => {
  const segs = splitDrafts('Try this:\n\n```draft\nSubject: hello\n\nHi there.\n```\n\nAnd the code:\n\n```js\nconst a = 1;\n```');
  const drafts = segs.filter((s) => s.draft);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].md, 'Subject: hello\n\nHi there.');
  assert.ok(segs.some((s) => !s.draft && /const a = 1/.test(s.md)));
});

test('drafts: a passing greeting is not a draft', () => {
  const segs = splitDrafts('Hi Sam,\n\nsure — done.');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].draft, false);
});

test('drafts: a plain reply is one text segment', () => {
  const segs = splitDrafts('I read the file and fixed the bug.\n\nWant me to run the tests?');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].draft, false);
});

test('drafts: the ask is what makes a SHORT reply a draft', () => {
  // Typed fast and misspelled — the real message that exposed this.
  assert.equal(asksForDraft('gvie me a 2 setnce emal saying hey'), true);
  assert.equal(asksForDraft('write me a cold email'), true);
  assert.equal(asksForDraft('draft a linkedin post'), true);
  // …and ordinary work asks are not draft asks.
  assert.equal(asksForDraft('why is the build failing'), false);
  assert.equal(asksForDraft('read the file and fix the bug'), false);
  assert.equal(asksForDraft('add a node to the graph and make it green'), false);
  assert.equal(asksForDraft(''), false);

  // A two-line email has no Subject: line and no sign-off — shape alone can't
  // see it, so without the ask it stays plain text.
  const short = 'Hey! Just wanted to say hi and hope you are having a great day.';
  assert.equal(splitDrafts(short).length, 1);
  assert.equal(splitDrafts(short)[0].draft, false);
  const asked = splitDrafts(short, { asked: true });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].draft, true);
});

test('drafts: asked-mode peels the agent\'s framing off both ends', () => {
  const segs = splitDrafts("Here's a quick one:\n\nHey —\n\nHope you're well. Saying hi.\n\nWant me to make it shorter?", { asked: true });
  assert.equal(segs.length, 3);
  assert.equal(segs[0].draft, false);
  assert.match(segs[0].md, /Here's a quick one/);
  assert.equal(segs[1].draft, true);
  assert.match(segs[1].md, /^Hey —/);
  assert.match(segs[1].md, /Saying hi\.$/);
  assert.equal(segs[2].draft, false);
  assert.match(segs[2].md, /shorter/);
});

test('drafts: asked-mode still refuses a reply that is just a question back', () => {
  const segs = splitDrafts('Sure — what tone do you want?', { asked: true });
  assert.equal(segs.length, 1);
  assert.equal(segs[0].draft, false);
});
