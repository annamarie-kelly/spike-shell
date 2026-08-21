// codex-hook-install registers Spike's Codex hook into a per-tab config.toml
// and seeds/harvests its trust. The correctness stakes are high: Codex writes
// its own tables into that same file, and a duplicate [hooks.state."…"] header
// is a TOML parse error that would break the session. We test the real Python
// script against temp config files. Stays inside `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const INSTALL = fileURLToPath(new URL('../shims/codex-hook-install', import.meta.url));
const PYTHON = process.env.PYTHON || 'python3';
const HOOK = '/Applications/Spike.app/Contents/Resources/shims/codex-agent-event-hook';

// A fresh codex-homes root per call. The installer derives the homes root as
// dirname(dirname(config)) to scan sibling tabs, so each test's config must sit
// one level deep (root/<home>/config.toml) to stay isolated from other tests.
function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-'));
}

// Run the installer against a fresh home under `dir`; return { out, store, config }.
function run(dir, { configBody = '', storeBody = null, trustDirs = [] } = {}) {
  const home = path.join(dir, 'h1');
  fs.mkdirSync(home, { recursive: true });
  const config = path.join(home, 'config.toml');
  const storePath = path.join(dir, 'store.json');
  fs.writeFileSync(config, configBody);
  if (storeBody != null) fs.writeFileSync(storePath, storeBody);
  execFileSync(PYTHON, [INSTALL, config, HOOK, storePath, ...trustDirs]);
  const out = fs.readFileSync(config, 'utf8');
  const store = fs.existsSync(storePath) ? JSON.parse(fs.readFileSync(storePath, 'utf8')) : null;
  return { out, store, storePath, config };
}

const count = (s, sub) => s.split(sub).length - 1;

test('registers the three hook blocks and preserves Codex-written tables', () => {
  const codexBody = '[projects."/repo"]\ntrust_level = "trusted"\n\n[tui.foo]\nx = 1\n';
  const { out } = run(tmp(), { configBody: codexBody });
  // Codex's own content survives untouched.
  assert.ok(out.includes('[projects."/repo"]'));
  assert.ok(out.includes('[tui.foo]'));
  // Our three events are registered, each pointing at the hook.
  assert.ok(out.includes('[[hooks.PreToolUse]]'));
  assert.ok(out.includes('[[hooks.PostToolUse]]'));
  assert.ok(out.includes('[[hooks.Stop]]'));
  assert.equal(count(out, `command = "${HOOK}"`), 3);
  // No store, no Codex trust → nothing seeded (clean fail-closed degrade).
  assert.equal(count(out, 'trusted_hash'), 0);
});

test('idempotent: a second run does not duplicate the block', () => {
  const dir = tmp();
  const { config, storePath } = run(dir, { configBody: '[projects."/repo"]\ntrust_level = "trusted"\n' });
  execFileSync(PYTHON, [INSTALL, config, HOOK, storePath]);
  const out = fs.readFileSync(config, 'utf8');
  assert.equal(count(out, '# >>> spike-managed hooks (do not edit)'), 1);
  assert.equal(count(out, '[[hooks.PreToolUse]]'), 1);
  assert.equal(count(out, '[projects."/repo"]'), 1);
});

test('seeds trust from the store, re-keyed to this home config path', () => {
  const store = JSON.stringify({
    [HOOK]: {
      pre_tool_use: 'sha256:aaa',
      post_tool_use: 'sha256:bbb',
      stop: 'sha256:ccc',
    },
  });
  const { out, config } = run(tmp(), { configBody: '', storeBody: store });
  assert.ok(out.includes(`[hooks.state."${config}:pre_tool_use:0:0"]`));
  assert.ok(out.includes('trusted_hash = "sha256:aaa"'));
  assert.ok(out.includes(`[hooks.state."${config}:stop:0:0"]`));
  assert.ok(out.includes('trusted_hash = "sha256:ccc"'));
  assert.equal(count(out, 'trusted_hash'), 3);
});

test('harvests a Codex-written trust hash into the store and de-dups the table', () => {
  // Simulate: user clicked "Trust all" once, Codex wrote these tables OUTSIDE
  // any sentinel block, for our 0:0 hooks in THIS home.
  const dir = tmp();
  const config = path.join(dir, 'h1', 'config.toml');
  const codexBody =
    '[projects."/repo"]\ntrust_level = "trusted"\n\n' +
    '[hooks.state]\n\n' +
    `[hooks.state."${config}:pre_tool_use:0:0"]\ntrusted_hash = "sha256:live-pre"\n\n` +
    `[hooks.state."${config}:stop:0:0"]\ntrusted_hash = "sha256:live-stop"\n`;
  const { out, store } = run(dir, { configBody: codexBody });
  // The hash is learned and stored keyed by hook path (portable across homes).
  assert.equal(store[HOOK].pre_tool_use, 'sha256:live-pre');
  assert.equal(store[HOOK].stop, 'sha256:live-stop');
  // Exactly one definition of each owned key — no duplicate TOML header.
  assert.equal(count(out, `[hooks.state."${config}:pre_tool_use:0:0"]`), 1);
  assert.equal(count(out, `[hooks.state."${config}:stop:0:0"]`), 1);
  // The owned tables now live inside our managed block; the bare parent
  // [hooks.state] Codex wrote is preserved (harmless, no collision).
  assert.ok(out.includes('# >>> spike-managed hooks'));
  assert.ok(out.includes('trusted_hash = "sha256:live-pre"'));
  // Codex's own project trust is untouched.
  assert.ok(out.includes('[projects."/repo"]'));
});

test('adopts trust granted in a sibling tab (trust once → every future tab)', () => {
  // codex-homes/ layout: tab "a" got trusted (Codex wrote the hashes into its
  // own config, which references our hook); a brand-new tab "b" must seed from
  // it without any prompt — the hash is content-derived, portable across homes.
  const root = tmp();
  const homeA = path.join(root, 'a');
  const homeB = path.join(root, 'b');
  fs.mkdirSync(homeA);
  fs.mkdirSync(homeB);
  const cfgA = path.join(homeA, 'config.toml');
  const cfgB = path.join(homeB, 'config.toml');
  const storePath = path.join(root, 'store.json');
  // Home A: our hook registered + Codex-persisted trust (keyed by A's path).
  fs.writeFileSync(
    cfgA,
    `[[hooks.PreToolUse]]\nmatcher = ".*"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "${HOOK}"\n\n` +
      `[hooks.state."${cfgA}:pre_tool_use:0:0"]\ntrusted_hash = "sha256:from-sibling"\n`
  );
  // Fresh home B: nothing yet.
  fs.writeFileSync(cfgB, '');
  execFileSync(PYTHON, [INSTALL, cfgB, HOOK, storePath]);
  const outB = fs.readFileSync(cfgB, 'utf8');
  const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  // B seeded from A's trust, re-keyed to B's own config path.
  assert.ok(outB.includes(`[hooks.state."${cfgB}:pre_tool_use:0:0"]`));
  assert.ok(outB.includes('trusted_hash = "sha256:from-sibling"'));
  // And the learned hash is persisted for every subsequent tab.
  assert.equal(store[HOOK].pre_tool_use, 'sha256:from-sibling');
});

test('a sibling that does NOT reference our hook is ignored', () => {
  const root = tmp();
  const homeA = path.join(root, 'a');
  const homeB = path.join(root, 'b');
  fs.mkdirSync(homeA);
  fs.mkdirSync(homeB);
  const cfgA = path.join(homeA, 'config.toml');
  const cfgB = path.join(homeB, 'config.toml');
  const storePath = path.join(root, 'store.json');
  // A trusts some OTHER project hook at 0:0 — not our binary. Must not adopt it.
  fs.writeFileSync(
    cfgA,
    `[[hooks.PreToolUse]]\nmatcher = ".*"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "/some/other/hook"\n\n` +
      `[hooks.state."${cfgA}:pre_tool_use:0:0"]\ntrusted_hash = "sha256:not-ours"\n`
  );
  fs.writeFileSync(cfgB, '');
  execFileSync(PYTHON, [INSTALL, cfgB, HOOK, storePath]);
  const outB = fs.readFileSync(cfgB, 'utf8');
  assert.equal(count(outB, 'trusted_hash'), 0, 'did not adopt an unrelated hook trust');
});

test('seeds workspace trust so Codex does not re-ask the directory gate', () => {
  const ws = '/Users/annamarie/spike-vault';
  const { out } = run(tmp(), { trustDirs: [ws] });
  assert.ok(out.includes(`[projects."${ws}"]`), 'the launched workspace is a trusted project');
  assert.ok(out.includes('trust_level = "trusted"'));
  // Lives inside our managed block (re-seeded every spawn), with the hooks.
  assert.ok(out.includes('# >>> spike-managed hooks'));
  assert.ok(out.includes('[[hooks.PreToolUse]]'));
});

test('workspace trust: cwd + git root both seeded, deduped, no double header', () => {
  const cwd = '/Users/annamarie/proj/sub';
  const root = '/Users/annamarie/proj';
  const dir = tmp();
  // A prior seed / Codex-written trust for the same cwd must not duplicate.
  const { config, storePath, out: out1 } = run(dir, {
    configBody: `[projects."${cwd}"]\ntrust_level = "trusted"\n\n[projects."/other/repo"]\ntrust_level = "trusted"\n`,
    trustDirs: [cwd, root],
  });
  assert.equal(count(out1, `[projects."${cwd}"]`), 1, 'no duplicate cwd project header');
  assert.ok(out1.includes(`[projects."${root}"]`), 'git root trusted too');
  // An unrelated project Codex trusted survives.
  assert.ok(out1.includes('[projects."/other/repo"]'), 'other trusted projects preserved');
  // Idempotent across spawns.
  execFileSync(PYTHON, [INSTALL, config, HOOK, storePath, cwd, root]);
  const out2 = fs.readFileSync(config, 'utf8');
  assert.equal(count(out2, `[projects."${cwd}"]`), 1);
  assert.equal(count(out2, `[projects."${root}"]`), 1);
  assert.equal(count(out2, '# >>> spike-managed hooks (do not edit)'), 1);
});

test('no trust dirs (hook-only call) seeds no project table', () => {
  const { out } = run(tmp());
  assert.equal(count(out, '[projects.'), 0);
});

test('missing config file is created cleanly with the hook block', () => {
  const dir = tmp();
  const config = path.join(dir, 'config.toml');
  const storePath = path.join(dir, 'store.json');
  execFileSync(PYTHON, [INSTALL, config, HOOK, storePath]);
  assert.ok(fs.existsSync(config));
  const out = fs.readFileSync(config, 'utf8');
  assert.ok(out.includes('[[hooks.PreToolUse]]'));
});

// Regression: the shipped bundle is "Spike Shell.app" — a path with a SPACE.
// Codex does not exec the command; it runs the string through a shell
// (codex-rs/hooks/src/engine/command_runner.rs → `$SHELL -lc "<command>"`), so
// an unquoted path word-splits and every hook dies with exit 127 before the
// adapter runs. Assert we emit it shell-quoted, and prove it round-trips
// through the same shell invocation Codex uses.
test('shell-quotes a hook path containing spaces (exit-127 regression)', () => {
  const dir = tmp();
  const bundle = path.join(dir, 'Spike Shell.app', 'Contents', 'Resources', 'shims');
  fs.mkdirSync(bundle, { recursive: true });
  const spaced = path.join(bundle, 'codex-agent-event-hook');
  fs.writeFileSync(spaced, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(spaced, 0o755);

  const home = path.join(dir, 'h1');
  fs.mkdirSync(home, { recursive: true });
  const config = path.join(home, 'config.toml');
  fs.writeFileSync(config, '');
  execFileSync(PYTHON, [INSTALL, config, spaced, path.join(dir, 'store.json')]);
  const out = fs.readFileSync(config, 'utf8');

  // The bare path must never appear as the command value.
  assert.equal(count(out, `command = "${spaced}"`), 0);
  const emitted = out.match(/^command = "(.+)"$/m)[1];
  assert.notEqual(emitted, spaced, 'command must be quoted, not bare');
  assert.equal(count(out, `command = "${emitted}"`), 3);

  // End-to-end: the emitted string survives Codex's own shell invocation.
  execFileSync('/bin/sh', ['-lc', emitted]);
});

// A space-free install path must be byte-identical to what we emitted before
// quoting — the trust hash is content-derived over the command string, so a
// gratuitous change here would silently invalidate every stored hash.
test('space-free paths are emitted unchanged (trust hashes stay valid)', () => {
  const { out } = run(tmp());
  assert.equal(count(out, `command = "${HOOK}"`), 3);
});
