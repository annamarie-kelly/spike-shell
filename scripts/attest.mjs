#!/usr/bin/env node
// attest - the attribution harness, from a terminal.
//
// Point it at a folder of sources and a task. It segments every source into addressable
// spans, hands the model the span manifest, and lets it reference spans by id instead of
// typing quotes. The harness substitutes the exact bytes and gates the result
// mechanically. A fabricated quote is not caught after the fact; it is impossible by
// construction.
//
//   node scripts/attest.mjs --init > attest.yaml         # a starter check set
//   node scripts/attest.mjs --task "What did customers say about pricing?"
//   node scripts/attest.mjs --check-set attest.yaml --task "..." --out report.md
//   node scripts/attest.mjs --sources ./notes --task "..." --dry   # print the prompt, spend nothing
//
// This file is I/O and argument handling only. Every decision about whether a run passed
// lives in src/attest/run.ts, which the Spike app calls with Tauri-backed I/O instead of
// Node's - so the two surfaces cannot drift into disagreeing about what "verified" means.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { extname, join, relative, resolve, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';

import { loadCheckSet, STARTER_CHECK_SET } from '../dist/attest/checkset.js';
import { runAttest, prepare, buildPrompt } from '../dist/attest/run.js';
import { buildRecord, checkDrift, renderDrift } from '../dist/attest/record.js';

// ── sources: the folder provider ────────────────────────────────────────────────
// Text formats only, on purpose. PDF extraction is a real source of byte-inexactness
// (ligatures, hyphenation, column order), and a verbatim guarantee over bytes nobody can
// reproduce is not a guarantee. PDFs arrive with a named extractor, not by accident.
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.csv', '.json', '.log', '.rst']);
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'dist-web', 'target', '.spike']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIR.has(entry.name)) walk(full, out);
    } else if (TEXT_EXT.has(extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

function matches(rel, include) {
  if (!include?.length) return true;
  return include.some((pat) => {
    const re = new RegExp(`^${pat.split('*').map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return re.test(rel) || re.test(basename(rel));
  });
}

/**
 * Read a folder into SourceRefs. The id is the path relative to the root, so a citation is
 * followable by a human without a database. The hash is over the exact bytes read, so a
 * later run can tell the source changed rather than silently resolving to different text.
 */
function readFolder(root, include) {
  const abs = resolve(root);
  if (!existsSync(abs)) throw new Error(`sources folder not found: ${abs}`);
  // The TEXT_EXT allowlist lives inside walk(), so a single-file argument would otherwise
  // skip it entirely: `--sources deck.pdf` reaches readFileSync(..., 'utf8') on binary,
  // Node replaces every invalid sequence with U+FFFD, and the harness reports VERBATIM over
  // text that is not in the document. Enforce the same rule on both paths.
  let files;
  if (statSync(abs).isDirectory()) {
    files = walk(abs);
  } else if (TEXT_EXT.has(extname(abs).toLowerCase())) {
    files = [abs];
  } else {
    throw new Error(
      `${abs} is not a supported text format (${[...TEXT_EXT].join(' ')}). ` +
        'Binary formats read as mojibake, so a verbatim guarantee over them would be a lie.',
    );
  }
  return files
    .sort()
    .map((path) => ({ path, rel: relative(abs, path) || basename(path) }))
    .filter(({ rel }) => matches(rel, include))
    .map(({ path, rel }) => {
      const detail = readFileSync(path, 'utf8');
      return {
        id: `folder:${rel}`,
        label: rel,
        detail,
        hash: createHash('sha256').update(detail).digest('hex'),
        url: `file://${path}`,
        complete: true,
        _path: path,
      };
    });
}

/** Re-read each source and report which changed under the run. */
function rehash(refs) {
  const changed = new Set();
  for (const r of refs) {
    try {
      const now = createHash('sha256').update(readFileSync(r._path, 'utf8')).digest('hex');
      if (now !== r.hash) changed.add(r.id);
    } catch {
      changed.add(r.id); // unreadable now: the citation no longer resolves either way
    }
  }
  return changed;
}

// ── the engine: the user's local claude binary, on their subscription ───────────

/** Resolve a real agent binary, skipping any Spike shim on PATH (it rewrites settings). */
function resolveAgent(binary) {
  const candidates = [
    join(process.env.HOME ?? '', '.local/bin', binary),
    `/opt/homebrew/bin/${binary}`,
    `/usr/local/bin/${binary}`,
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`${binary} binary not found (looked in ~/.local/bin, /opt/homebrew/bin, /usr/local/bin)`);
}

// Closing the tool surface is defense in depth, not the guarantee - the gate rejects typed
// quote marks regardless of what tools exist. It is worth doing anyway: it drops ~29k
// tokens of MCP schemas from the prompt, measured as $0.147 -> $0.022 on a trivial run.
// This is a DENYLIST, so a newly added built-in tool arrives allowed; survivable precisely
// because the gate does not depend on it.
const TOOL_DENYLIST = [
  'Bash', 'Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch', 'Task', 'TodoWrite', 'Skill', 'SlashCommand',
].join(',');

function claudeTurn(bin) {
  return ({ prompt, schema, model }) =>
    new Promise((res, rej) => {
      const args = [
        '-p', prompt,
        '--model', model,
        '--output-format', 'json',
        '--json-schema', JSON.stringify(schema),
        '--mcp-config', '{"mcpServers":{}}',
        '--strict-mcp-config',
        '--disallowedTools', TOOL_DENYLIST,
        '--permission-mode', 'dontAsk',
      ];
      // Strip the API key so the run bills to the OAuth subscription, and read
      // apiKeySource back off the result rather than assuming it did.
      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY;

      const p = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('error', rej);
      p.on('close', () => {
        try {
          res(JSON.parse(out));
        } catch {
          rej(new Error(`claude returned unparseable output.\nstdout: ${out.slice(0, 800)}\nstderr: ${err.slice(0, 800)}`));
        }
      });
    });
}

/**
 * One turn through `codex exec`, normalized into the shape claudeTurn returns so the
 * orchestrator never branches on engine.
 *
 * Three differences from Claude Code, each measured rather than assumed:
 *
 *  - codex reads stdin and blocks until it closes. Leaving it inherited hangs the run
 *    forever - that cost a five minute timeout to find.
 *  - --output-schema takes a PATH, and the answer is written to the -o file rather than
 *    embedded in a result object.
 *  - it reports tokens, never dollars. The cost stays undefined instead of being derived
 *    from a price table this script would have to keep current: an invented number in a
 *    receipt is worse than an absent one.
 */
function codexTurn(bin) {
  return ({ prompt, schema }) =>
    new Promise((res, rej) => {
      const stamp = `${process.pid}-${Date.now()}`;
      const schemaPath = join(tmpdir(), `attest-${stamp}-schema.json`);
      const outPath = join(tmpdir(), `attest-${stamp}-answer.json`);
      writeFileSync(schemaPath, JSON.stringify(schema));

      const env = { ...process.env };
      delete env.OPENAI_API_KEY;
      delete env.CODEX_API_KEY;

      const p = spawn(
        bin,
        [
          'exec', '--json',
          '--output-schema', schemaPath,
          '-o', outPath,
          // An attest turn reads sources and answers. It has no business writing anything.
          '--sandbox', 'read-only',
          '--skip-git-repo-check',
          prompt,
        ],
        { env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', () => {});
      p.on('error', rej);
      p.on('close', () => {
        let answer = null;
        try { answer = JSON.parse(readFileSync(outPath, 'utf8')); } catch { /* reported below */ }
        rmSync(schemaPath, { force: true });
        rmSync(outPath, { force: true });

        let usage;
        for (const line of out.split('\n')) {
          try {
            const ev = JSON.parse(line);
            if (ev.type === 'turn.completed') usage = ev.usage;
          } catch { /* codex logs non-JSON warnings; not a failure signal */ }
        }
        if (!answer) {
          res({ is_error: true, terminal_reason: 'no_structured_answer', result: out.slice(-400), usage });
          return;
        }
        res({ structured_output: answer, usage, apiKeySource: 'none' });
      });
    });
}

function turnFor(engine) {
  return engine === 'codex' ? codexTurn(resolveAgent('codex')) : claudeTurn(resolveAgent('claude'));
}

// ── main ────────────────────────────────────────────────────────────────────────

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

function resolveCheckSet() {
  const explicit = arg('check-set');
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`check set not found: ${explicit}`);
    return { set: loadCheckSet(readFileSync(explicit, 'utf8')), from: explicit, dir: dirname(resolve(explicit)) };
  }
  for (const candidate of ['attest.yaml', 'attest.yml']) {
    if (existsSync(candidate)) {
      return { set: loadCheckSet(readFileSync(candidate, 'utf8')), from: candidate, dir: resolve('.') };
    }
  }
  return { set: loadCheckSet(STARTER_CHECK_SET), from: '(built-in starter)', dir: resolve('.') };
}

async function main() {
  if (flag('init')) {
    process.stdout.write(STARTER_CHECK_SET);
    return;
  }

  // Re-check a report you already shipped. No model, no cost: read the sources as they
  // are now and ask whether each quote the report placed still says what it says it said.
  const verifyPath = arg('verify');
  if (verifyPath) {
    const record = JSON.parse(readFileSync(verifyPath, 'utf8'));
    const roots = new Set(record.sources.map((s) => s.id.replace(/^folder:/, '')));
    const base = arg('sources') ?? dirname(resolve(verifyPath));
    const current = new Map();
    for (const rel of roots) {
      const path = resolve(base, rel);
      if (!existsSync(path)) continue;
      const text = readFileSync(path, 'utf8');
      current.set(`folder:${rel}`, { text, hash: createHash('sha256').update(text).digest('hex') });
    }
    const drift = checkDrift(record, current);
    console.log(renderDrift(record, drift));
    console.error(`attest: ${drift.summary}`);
    process.exitCode = drift.intact ? 0 : 1;
    return;
  }

  const task = arg('task');
  if (!task) {
    console.error('usage: node scripts/attest.mjs --task "<question>" [--check-set attest.yaml] [--sources <dir>] [--out <file>] [--record <file>] [--audit] [--dry] [--model <m>]');
    console.error('       node scripts/attest.mjs --init > attest.yaml');
    console.error('       node scripts/attest.mjs --verify <record.json> [--sources <dir>]');
    process.exitCode = 2;
    return;
  }

  const { set: checkSet, from, dir } = resolveCheckSet();
  const modelOverride = arg('model');
  if (modelOverride) checkSet.model = modelOverride;

  // `--sources` overrides the check set's folder, which is what makes one check set
  // reusable across corpora. Paths inside a check set resolve relative to that file, not
  // to the shell's cwd, so a check set stays portable.
  const override = arg('sources');
  const includeFor = new Map(
    checkSet.sources.filter((s) => s.type === 'folder').map((s) => [s.path, s.include]),
  );
  const io = {
    readSources: async (root) => readFolder(override ?? resolve(dir, root), includeFor.get(root)),
    turn: turnFor(checkSet.engine),
    rehash: async (refs) => rehash(refs),
  };

  if (flag('dry')) {
    const prep = await prepare(checkSet, io, override);
    console.error(`attest: ${prep.refs.length} source(s), ${prep.table.size} span(s), ${prep.includedIds.length} shown`);
    process.stdout.write(buildPrompt(task, prep.manifest, checkSet));
    return;
  }

  console.error(`attest: check set \`${checkSet.name}\` from ${from}`);
  const t0 = Date.now();
  const run = await runAttest({ task, checkSet, io, sourceRoot: override });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  // `on_fail: gate` has to withhold something, or it is strictly less honest than
  // `annotate`. A gated failure is written beside the requested path with a .rejected
  // suffix and never printed to stdout, so a pipeline cannot consume it by accident.
  const withheld = !run.pass && checkSet.onFail === 'gate';
  const report = flag('audit') ? run.audit : run.display;
  const out = arg('out');
  if (withheld) {
    const target = (out || 'attest-report.md').replace(/(\.[^.]+)?$/, '.rejected$1');
    writeFileSync(target, report);
    writeFileSync(target.replace(/\.md$/, '.audit.md'), run.audit);
    console.error(`attest: WITHHELD - this check set gates on failure. Wrote ${target} for diagnosis.`);
  } else if (out) {
    writeFileSync(out, report);
    // The audit view is not an alternative to the display view, it is the other half of
    // it, so writing one writes both rather than making the reader re-run to get it.
    const auditPath = out.replace(/(\.[^.]+)?$/, '.audit$1');
    writeFileSync(auditPath, run.audit);
    console.error(`attest: wrote ${out} and ${auditPath}`);
  } else {
    console.log(report);
  }

  console.error(
    `attest: ${run.spans.total} span(s), ${run.spans.shown} shown` +
      (run.spans.omitted ? `, ${run.spans.omitted} omitted` : ''),
  );
  for (const line of [run.verdict.summary, run.shape.summary, run.facts.summary]) {
    console.error(`attest: ${line}`);
  }
  const changed = run.receipt.sources.filter((s) => s.changed).length;
  if (changed) console.error(`attest: ${changed} source(s) CHANGED during the run`);
  const recordPath = arg('record');
  if (recordPath) {
    const record = buildRecord({
      at: new Date().toISOString(),
      task,
      checkSetName: checkSet.name,
      model: checkSet.model,
      pass: run.pass,
      verdict: { quotes: run.verdict.summary, shape: run.shape.summary, figures: run.facts.summary },
      sources: run.receipt.sources.map(({ id, hash, cited }) => ({ id, hash, cited })),
      placedSpanIds: run.placedSpanIds,
      table: run.table,
    });
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    console.error(`attest: wrote ${recordPath} (re-check later with --verify ${recordPath})`);
  }

  // Codex reports tokens, never dollars. Printing $0.0000 would read as free.
  const spend = run.costUsd > 0 ? ` · $${run.costUsd.toFixed(4)}` : '';
  console.error(
    `attest: ${secs}s${spend} · ${run.redos} redo(s) · ${checkSet.engine} · auth=${run.auth ?? 'subscription'}`,
  );

  // process.exit() would tear the process down before a piped stdout drains, and the
  // receipt is emitted last, so it is the part most likely lost. Set the code and let Node
  // exit once the write queue is flushed.
  //
  // `on_fail: annotate` means a failing check does not withhold the work, but the run still
  // reports a non-zero code so a script can tell.
  process.exitCode = run.pass ? 0 : 1;
}

main().catch((e) => {
  console.error(`attest: ${e.message}`);
  process.exitCode = 1;
});
