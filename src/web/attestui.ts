// The attest surface: one palette command, a report in the preview pane.
//
// Everything that decides whether a run passed lives in src/attest/, which the CLI script
// also calls. This file is the Spike-shaped shell around it: where the check set comes
// from, where the report lands, and what the status line says while it runs.
//
// Deps are injected rather than imported so this module stays testable and app.ts stays
// the only place that knows about the live model - the same shape as palette.ts and
// settings.ts.

import * as ipc from './ipc';
import { loadCheckSet, STARTER_CHECK_SET, type CheckSet } from '../attest/checkset';
import { runAttest, type AttestIO } from '../attest/run';
import { buildRecord } from '../attest/record';

export interface AttestDeps {
  /** The open project root, or null. Reports land under it so the tree and ⌘K find them. */
  getProjectPath: () => string | null;
  /** The workspace whose config applies to the focused lane, or null. */
  getGroup: () => { name?: string; cwd?: string; attest?: string } | null;
  /** Open a path in the preview pane (the in-process `spike open`). */
  openFile: (path: string, name: string) => void;
  /** Transient status line. ms = 0 makes it stick while work is in flight. */
  status: (msg: string, ms?: number) => void;
  /** Re-index the tree so a newly written report appears in it. */
  reloadTree: () => void;
}

export interface AttestHandle {
  /** Run one verification. Fire and forget: it reports through the status line. */
  run: (task: string) => Promise<void>;
  /** Label for the palette, so the command can name the check set it would use. */
  label: () => string;
}

/** Where a workspace's check set lives, and what it is called. */
function checkSetPathFor(deps: AttestDeps): string | null {
  const g = deps.getGroup();
  if (g?.attest) return g.attest;
  const root = g?.cwd || deps.getProjectPath();
  return root ? `${root.replace(/\/$/, '')}/attest.yaml` : null;
}

async function resolveCheckSet(deps: AttestDeps): Promise<{ set: CheckSet; from: string; dir: string }> {
  const path = checkSetPathFor(deps);
  if (path) {
    // Absent is the normal first run. Present-but-malformed is an error and must NOT fall
    // back to the starter: that would silently run a different check set than the file the
    // person is looking at, which is the one failure a verification tool cannot have.
    const file = await ipc.readFile(path).catch(() => null);
    const raw = file && !file.binary ? (file.content ?? '') : null;
    if (raw !== null) {
      return {
        set: loadCheckSet(raw),
        from: path.split('/').pop() || path,
        dir: path.slice(0, path.lastIndexOf('/')),
      };
    }
  }
  const root = deps.getGroup()?.cwd || deps.getProjectPath() || '';
  return { set: loadCheckSet(STARTER_CHECK_SET), from: 'built-in starter', dir: root };
}

function slug(task: string): string {
  return (
    task
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'attest'
  );
}

/** `2026-08-05` - a date, not a timestamp, so same-day reruns overwrite rather than pile up. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function initAttest(deps: AttestDeps): AttestHandle {
  let running = false;

  async function run(task: string): Promise<void> {
    // One at a time. Two concurrent runs would fight over the status line and could write
    // the same report path from different corpora.
    if (running) {
      deps.status('Attest: a verification is already running.');
      return;
    }
    const trimmed = task.trim();
    if (!trimmed) return;

    running = true;
    const runId = crypto.randomUUID();
    try {
      deps.status('Attest: reading sources…', 0);
      const { set: checkSet, from, dir } = await resolveCheckSet(deps);

      const roots = checkSet.sources.filter((s) => s.type === 'folder');
      if (!roots.length) throw new Error('the check set declares no folder source');

      // Paths in a check set resolve relative to the check set, not the shell's cwd.
      const absFor = (root: string) =>
        root.startsWith('/') ? root : `${dir.replace(/\/$/, '')}/${root.replace(/^\.\//, '')}`;
      // The check set's include filter has to survive this path. Dropping it would read,
      // segment and quote files the check set said were out of scope, under a green
      // receipt whose Sources list names them.
      const includeFor = new Map(
        checkSet.sources
          .filter((x): x is { type: 'folder'; path: string; include?: string[] } => x.type === 'folder')
          .map((x) => [x.path, x.include]),
      );

      const io: AttestIO = {
        readSources: async (root) => ipc.attestReadSources(absFor(root), includeFor.get(root)),
        // Without this the app could not run `source-unchanged` at all, and runAttest now
        // refuses rather than reporting a check that never ran.
        rehash: async (refs) => {
          const changed = new Set<string>();
          const byRoot = new Map<string, string[]>();
          for (const r of refs) byRoot.set(r.id, [r.hash ?? '']);
          for (const root of checkSet.sources.filter((x) => x.type === 'folder')) {
            const now = await ipc.attestReadSources(
              absFor((root as { path: string }).path),
              includeFor.get((root as { path: string }).path),
            );
            for (const n of now) {
              const before = byRoot.get(n.id);
              if (before && before[0] && before[0] !== n.hash) changed.add(n.id);
            }
            const seen = new Set(now.map((n) => n.id));
            for (const r of refs) if (!seen.has(r.id)) changed.add(r.id);
          }
          return changed;
        },
        turn: async ({ prompt, schema, model, engine }) => {
          deps.status(`Attest: asking ${model || engine}…`, 0);
          return ipc.attestTurn({
            run_id: runId,
            prompt,
            schema: JSON.stringify(schema),
            model,
            engine,
          });
        },
      };

      const result = await runAttest({ task: trimmed, checkSet, io });

      // Write the report before opening it: the preview pane takes a path, not a string.
      const root = deps.getProjectPath() || deps.getGroup()?.cwd;
      if (!root) throw new Error('no project or workspace folder to write the report into');
      // `on_fail: gate` has to withhold something, or it is strictly less honest than
      // `annotate`: its only other effect is to drop the disclosure note from the receipt,
      // so choosing the stricter setting used to remove the warning and publish anyway.
      const withheld = !result.pass && checkSet.onFail === 'gate';
      const name = withheld
        ? `${today()}-${slug(trimmed)}.rejected.md`
        : `${today()}-${slug(trimmed)}.md`;
      const path = `${root.replace(/\/$/, '')}/attest/${name}`;
      await ipc.createPath(root, 'attest', 'folder').catch(() => undefined);
      await ipc.saveFile(path, result.display);
      await ipc.saveFile(path.replace(/\.md$/, '.audit.md'), result.audit);

      // The record is what lets this report be re-checked against the sources months from
      // now, when the quotes in it still look authoritative and the files have moved on.
      const record = buildRecord({
        at: new Date().toISOString(),
        task: trimmed,
        checkSetName: checkSet.name,
        model: checkSet.model,
        pass: result.pass,
        verdict: {
          quotes: result.verdict.summary,
          shape: result.shape.summary,
          figures: result.facts.summary,
        },
        sources: result.receipt.sources.map(({ id, hash, cited }) => ({ id, hash, cited })),
        placedSpanIds: result.placedSpanIds,
        table: result.table,
      });
      await ipc.saveFile(path.replace(/\.md$/, '.record.json'), `${JSON.stringify(record, null, 2)}\n`);

      // Record the verdict on the broker so the action log carries whether a verification
      // passed, not merely that one ran.
      await ipc
        .attestVerdict(runId, {
          pass: result.pass,
          quotes: result.verdict.summary,
          matched: result.verdict.matched,
          total: result.verdict.total,
          redos: result.redos,
          cost_usd: result.costUsd,
          check_set: checkSet.name,
        })
        .catch(() => undefined);

      deps.reloadTree();
      // A gated failure is not opened in front of the reader. It is on disk, named
      // .rejected.md, for diagnosis.
      if (!withheld) deps.openFile(path, name);
      deps.status(
        `${result.pass ? 'Verified' : withheld ? 'Withheld (gated)' : 'Check failed'} · ${result.verdict.matched}/${result.verdict.total} quotes` +
          `${result.redos ? ` · ${result.redos} redo` : ''} · $${result.costUsd.toFixed(3)} · ${from}`,
        result.pass ? 8000 : 0,
      );
    } catch (e) {
      // Sticky, because a failure the person did not see is a failure they will act on
      // wrongly - and an attest run is the one thing in Spike whose whole job is honesty.
      deps.status(`Attest: ${ipc.errorMessage(e, 'run failed')}`, 0);
    } finally {
      running = false;
    }
  }

  function label(): string {
    const p = checkSetPathFor(deps);
    const name = p ? p.split('/').pop() : null;
    return name ? `Verify against sources… (${name})` : 'Verify against sources…';
  }

  return { run, label };
}
