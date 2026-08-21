#!/usr/bin/env node
// playbook - run a "here is how I do this" playbook from a terminal.
//
// A playbook does the steps, then PROVES it by running your own checks (a test run, the
// verify harness, a lint) and gating on the result. It refuses to report success unless
// every check passes; if one fails it feeds the failure back and lets the agent try again,
// bounded by max_redos.
//
//   node scripts/playbook.mjs --init > code.yaml            # a starter playbook
//   node scripts/playbook.mjs -p code.yaml --task "add a --json flag to foo"
//   node scripts/playbook.mjs -p code.yaml --task "..." --dry        # print the prompt only
//   node scripts/playbook.mjs -p code.yaml --skip-agent              # just run the checks now
//   node scripts/playbook.mjs -p code.yaml --task "..." --cwd ../repo
//
// This file is I/O and argument handling only. Every decision about whether a run passed
// lives in src/attest/playbook.ts, which the Spike app will call with Tauri-backed I/O
// instead of Node's - so the two surfaces cannot drift into disagreeing about "done".

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// The engine (compiled from src/attest/playbook.ts) is loaded lazily, inside main() and only
// once a run actually needs it. Pure meta flags like --version and --init must answer even
// when the dist build is absent, so they cannot hang off a top-level import of it.

// ── the runner: run one check command, capture exit + output ─────────────────────
// Deterministic. Runs the command through the user's shell in the target repo, so a check
// like `npm test` or `node verify/run.mjs` behaves exactly as it would typed by hand. A
// command that cannot start (ENOENT) throws, which aborts the run rather than passing it -
// a check that could not run is never green.
function runCheckIn(cwd) {
  return (cmd) =>
    new Promise((res, rej) => {
      const p = spawn(cmd, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      p.stdout.on('data', (d) => (stdout += d));
      p.stderr.on('data', (d) => (stderr += d));
      p.on('error', rej); // command could not be executed - abort, do not pass
      p.on('close', (code) => res({ code: code ?? 1, stdout, stderr }));
    });
}

// ── the engine: the user's local claude binary, on their subscription ────────────
// Unlike an attest turn (which reads sources and may type NO quotes, all tools denied), a
// coding turn must edit files and run commands. So the tool surface is OPEN and the cwd is
// the repo, not home. The gate is still the checks, not the agent's self-report.
function resolveAgent(binary) {
  const candidates = [
    join(process.env.HOME ?? '', '.local/bin', binary),
    `/opt/homebrew/bin/${binary}`,
    `/usr/local/bin/${binary}`,
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`${binary} binary not found (looked in ~/.local/bin, /opt/homebrew/bin, /usr/local/bin)`);
}

function claudeTurn(cwd) {
  const bin = resolveAgent('claude');
  return ({ prompt }) =>
    new Promise((res, rej) => {
      const args = [
        '-p', prompt,
        '--output-format', 'json',
        // A coding turn edits and runs; accept its edits without prompting in this headless
        // run. The checks - not this flag - decide whether the work was real.
        '--permission-mode', 'acceptEdits',
      ];
      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY; // bill the OAuth subscription, not a metered key
      const p = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('error', rej);
      p.on('close', () => {
        let summary = out;
        try {
          const j = JSON.parse(out);
          if (j.is_error) return res({ is_error: true, terminal_reason: j.terminal_reason ?? 'unknown' });
          summary = j.result ?? out;
        } catch {
          // A coding turn that returned unparseable output still ran; the checks are what
          // gate. Keep the raw text as the summary rather than failing here.
        }
        res({ summary: String(summary).slice(0, 4000) });
      });
    });
}

// A turn that does nothing, for --skip-agent: run the checks against the tree as it is now.
// Useful to watch the gate + receipt on a change you already made by hand.
const noopTurn = () => Promise.resolve({ summary: '(skipped agent; checking the tree as-is)' });

// ── args ─────────────────────────────────────────────────────────────────────────
function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(name);

async function main() {
  if (has('--version')) {
    process.stdout.write('playbook 0.1\n');
    return;
  }

  // Everything past here drives a real run, so pull in the engine now.
  const { loadPlaybook, runPlaybook, buildPrompt, STARTER_PLAYBOOK } = await import(
    '../dist/attest/playbook.js'
  );

  if (has('--init')) {
    process.stdout.write(STARTER_PLAYBOOK);
    return;
  }

  const file = arg('--playbook', arg('-p'));
  if (!file) {
    process.stderr.write(
      'usage: playbook -p <file.yaml> --task "..."  |  --init  |  -p <file> --skip-agent\n',
    );
    process.exit(2);
  }
  const playbook = loadPlaybook(readFileSync(resolve(file), 'utf8'));
  const cwd = resolve(arg('--cwd', process.cwd()));
  const task = arg('--task', '');

  if (has('--dry')) {
    process.stdout.write(buildPrompt(task || '(no task given)', playbook) + '\n');
    return;
  }

  const skip = has('--skip-agent');
  if (!skip && !task) {
    process.stderr.write('a run needs --task "..." (or use --skip-agent to only run the checks)\n');
    process.exit(2);
  }

  const io = {
    turn: skip ? noopTurn : claudeTurn(cwd),
    runCheck: runCheckIn(cwd),
  };

  process.stderr.write(`▸ ${playbook.name}  (${skip ? 'checks only' : `up to ${playbook.maxRedos + 1} attempts`})\n`);
  const run = await runPlaybook({ task, playbook, io });

  process.stdout.write('\n' + run.display + '\n');
  if (run.gated && !run.pass) {
    process.stderr.write('\nGATED: checks did not pass. The work was not reported as done.\n');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`playbook: ${e.message}\n`);
  process.exit(1);
});
