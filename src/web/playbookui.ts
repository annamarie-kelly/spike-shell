// The playbook surface: one palette command, a receipt in the preview pane.
//
// A playbook does the steps, then PROVES it by running the user's own checks and gating on
// the result. Everything that decides whether a run passed lives in src/attest/playbook.ts,
// which the CLI script (scripts/playbook.mjs) also calls - so the two surfaces cannot drift
// into disagreeing about "done". This file is the Spike-shaped shell: where the playbook
// comes from, where the coding turn and the checks run (the OS, via ipc), and what the
// status line says. Deps are injected, the same shape as attestui.ts / palette.ts.

import * as ipc from './ipc';
import { loadPlaybook, runPlaybook, serializePlaybook, STARTER_PLAYBOOK,
  type Playbook, type PlaybookIO, type PlaybookRun, type PlaybookInput } from '../attest/playbook';

/** One entry on the library shelf. `error` is set when the file exists but won't parse — we
 *  show it as a broken card rather than hiding it, so a typo is visible, not silent. */
export interface PlaybookCard {
  path: string;
  fileName: string;
  name: string;
  description: string;
  checks: string[];
  scope: 'global' | { workspace: string };
  error?: string;
}

export interface PlaybookDeps {
  getProjectPath: () => string | null;
  getGroup: () => { name?: string; cwd?: string; playbook?: string } | null;
  openFile: (path: string, name: string) => void;
  status: (msg: string, ms?: number) => void;
  reloadTree: () => void;
}

export interface PlaybookHandle {
  /** Run one playbook against a task. Fire and forget: it reports through the status line. */
  run: (task: string) => Promise<void>;
  /** Label for the palette, naming the playbook it would use. */
  label: () => string;
  /** The global library folder (~/.spike/playbooks), created on first read. */
  libraryDir: () => Promise<string>;
  /** Every playbook on the shelf, parsed (broken ones carry `error`). Seeds a starter once. */
  list: () => Promise<PlaybookCard[]>;
  /** Create a new playbook file from the starter and return its path. */
  create: (name: string) => Promise<string>;
  /** Read + parse one playbook file into its full structure (steps + checks), or null if it
   *  won't parse. The list cards only carry labels; the editor needs everything. */
  read: (path: string) => Promise<Playbook | null>;
  /**
   * Write an authoring form to disk as YAML and return its path. Validates by loading the
   * generated YAML first, so a form can never save a file that won't parse. Omit `existingPath`
   * to create a new file (named from the playbook name); pass it to overwrite in place.
   */
  save: (input: PlaybookInput, existingPath?: string) => Promise<string>;
  /**
   * Run a specific playbook file against a chosen folder, returning the full result so a view
   * can render the receipt inline. `onStatus` streams progress. Also writes the receipt to
   * <cwd>/playbook/ so it survives in the tree.
   */
  runFile: (opts: { path: string; cwd: string; task: string; onStatus?: (m: string) => void }) => Promise<PlaybookRun>;
}

/** Where a workspace's playbook lives. Mirrors attest: an explicit field, else a file
 *  beside the root, else the built-in starter. */
function playbookPathFor(deps: PlaybookDeps): string | null {
  const g = deps.getGroup();
  if (g?.playbook) return g.playbook;
  const root = g?.cwd || deps.getProjectPath();
  return root ? `${root.replace(/\/$/, '')}/playbook.yaml` : null;
}

async function resolvePlaybook(deps: PlaybookDeps): Promise<{ pb: Playbook; from: string }> {
  const path = playbookPathFor(deps);
  if (path) {
    // Absent is the normal first run. Present-but-malformed is an error and must NOT fall
    // back to the starter: that would silently run a different playbook than the file the
    // person is looking at.
    const file = await ipc.readFile(path).catch(() => null);
    const raw = file && !file.binary ? (file.content ?? '') : null;
    if (raw !== null) return { pb: loadPlaybook(raw), from: path.split('/').pop() || path };
  }
  return { pb: loadPlaybook(STARTER_PLAYBOOK), from: 'built-in starter' };
}

function slug(task: string): string {
  return (
    task.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'playbook'
  );
}

/** A date, not a timestamp, so same-day reruns overwrite rather than pile up. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function initPlaybook(deps: PlaybookDeps): PlaybookHandle {
  let running = false;

  async function run(task: string): Promise<void> {
    // One at a time: two concurrent coding turns would fight over the tree and the status line.
    if (running) {
      deps.status('Playbook: a run is already in flight.');
      return;
    }
    const trimmed = task.trim();
    if (!trimmed) return;

    const cwd = deps.getGroup()?.cwd || deps.getProjectPath();
    if (!cwd) {
      deps.status('Playbook: open a project or workspace first — a run needs a repo to work in.');
      return;
    }

    running = true;
    const runId = crypto.randomUUID();
    try {
      deps.status('Playbook: loading…', 0);
      const { pb, from } = await resolvePlaybook(deps);

      const io: PlaybookIO = {
        turn: async ({ prompt, engine, correction }) => {
          deps.status(correction ? 'Playbook: revising…' : 'Playbook: working…', 0);
          const raw = await ipc.playbookTurn({ run_id: runId, prompt, cwd, engine });
          if (raw?.is_error) {
            return { is_error: true, terminal_reason: raw.terminal_reason ?? 'unknown' };
          }
          return { summary: String(raw?.result ?? '').slice(0, 4000) };
        },
        runCheck: async (cmd) => {
          deps.status(`Playbook: ${cmd}…`, 0);
          return ipc.playbookRunCheck(cmd, cwd);
        },
      };

      const result = await runPlaybook({ task: trimmed, playbook: pb, io });

      // Write the receipt before opening it: the preview pane takes a path, not a string. A
      // gated failure is named .rejected.md and left on disk for diagnosis, not opened in
      // front of the reader as if it were the finished work.
      const withheld = !result.pass && result.gated;
      const name = withheld
        ? `${today()}-${slug(trimmed)}.rejected.md`
        : `${today()}-${slug(trimmed)}.md`;
      const body = `# ${pb.name}\n\n> Task: ${trimmed}\n\n\`\`\`\n${result.display}\n\`\`\`\n`;
      const path = `${cwd.replace(/\/$/, '')}/playbook/${name}`;
      await ipc.createPath(cwd, 'playbook', 'folder').catch(() => undefined);
      await ipc.saveFile(path, body);

      deps.reloadTree();
      if (!withheld) deps.openFile(path, name);
      const passed = result.results.filter((r) => r.pass).length;
      deps.status(
        `${result.pass ? 'Playbook passed' : withheld ? 'Gated (checks failed)' : 'Checks failed'} · ` +
          `${passed}/${result.results.length} checks${result.redos ? ` · ${result.redos} redo` : ''} · ${from}`,
        result.pass ? 8000 : 0,
      );
    } catch (e) {
      // Sticky: a run whose failure the person did not see is one they will act on wrongly.
      deps.status(`Playbook: ${ipc.errorMessage(e, 'run failed')}`, 0);
    } finally {
      running = false;
    }
  }

  function label(): string {
    const p = playbookPathFor(deps);
    const name = p ? p.split('/').pop() : null;
    return name ? `Run playbook… (${name})` : 'Run playbook…';
  }

  // ── the library shelf (~/.spike/playbooks) ─────────────────────────────────────

  let cachedDir: string | null = null;
  async function libraryDir(): Promise<string> {
    if (cachedDir) return cachedDir;
    const home = (await ipc.getHomeDir().catch(() => ''))?.replace(/\/$/, '') || '';
    // Guard a null/empty home (e.g. the path plugin unavailable) with a clear message
    // rather than a cryptic `.replace of null` crash surfacing in the shelf.
    if (!home) throw new Error('could not locate your home folder — is the app running under Tauri?');
    // Ensure ~/.spike/playbooks exists before any read or write, or read_tree/save_file hit
    // "bad target" on a first-ever visit (the folder is created lazily, like ~/.spike/voice).
    await ipc.createPath(home, '.spike', 'folder').catch(() => undefined);
    await ipc.createPath(`${home}/.spike`, 'playbooks', 'folder').catch(() => undefined);
    cachedDir = `${home}/.spike/playbooks`;
    return cachedDir;
  }

  async function list(): Promise<PlaybookCard[]> {
    const dir = await libraryDir();
    const readChildren = async () => {
      const tree = await ipc.getTree(dir).catch(() => ({ children: [] as any[] }));
      return (tree.children || []).filter((c: any) => !c.dir && /\.ya?ml$/i.test(c.name));
    };
    let files = await readChildren();
    if (!files.length) {
      // Seed a starter so a first visit shows the shape of a playbook, not a blank shelf.
      await create('How I code + verify').catch(() => undefined);
      files = await readChildren();
    }
    const cards: PlaybookCard[] = [];
    for (const f of files) {
      const file = await ipc.readFile(f.path).catch(() => null);
      const raw = file && !file.binary ? (file.content ?? '') : '';
      try {
        const pb = loadPlaybook(raw);
        cards.push({
          path: f.path, fileName: f.name, name: pb.name, description: pb.description,
          checks: pb.checks.map((c) => c.label), scope: pb.scope,
        });
      } catch (e) {
        cards.push({
          path: f.path, fileName: f.name, name: f.name.replace(/\.ya?ml$/i, ''),
          description: '', checks: [], scope: 'global',
          error: ipc.errorMessage(e, 'could not parse this playbook'),
        });
      }
    }
    return cards.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function create(name: string): Promise<string> {
    const dir = await libraryDir();
    const base = (slug(name) || 'playbook').replace(/\.ya?ml$/i, '');
    const path = `${dir}/${base}.yaml`;
    // Give the new file a real name line so the card doesn't read as "how i code" for all of them.
    const titled = STARTER_PLAYBOOK.replace(/^name:.*$/m, `name: ${name.trim() || 'New playbook'}`);
    await ipc.saveFile(path, titled);
    return path;
  }

  async function read(path: string): Promise<Playbook | null> {
    const file = await ipc.readFile(path).catch(() => null);
    const raw = file && !file.binary ? (file.content ?? '') : '';
    try { return loadPlaybook(raw); } catch { return null; }
  }

  async function save(input: PlaybookInput, existingPath?: string): Promise<string> {
    const yaml = serializePlaybook(input);
    loadPlaybook(yaml);   // never write a file that won't load — the form's safety net
    const dir = await libraryDir();
    let path = existingPath;
    if (!path) {
      // Creating: pick a filename from the name, but don't clobber an existing playbook.
      const existing = await list().catch(() => [] as PlaybookCard[]);
      const taken = new Set(existing.map((c) => c.fileName.replace(/\.ya?ml$/i, '')));
      const base = slug(input.name) || 'playbook';
      let nm = base, n = 2;
      while (taken.has(nm)) nm = `${base}-${n++}`;
      path = `${dir}/${nm}.yaml`;
    }
    await ipc.saveFile(path, yaml);
    return path;
  }

  async function runFile(opts: {
    path: string; cwd: string; task: string; onStatus?: (m: string) => void;
  }): Promise<PlaybookRun> {
    const { path, cwd, task, onStatus } = opts;
    const file = await ipc.readFile(path);
    const raw = file && !file.binary ? (file.content ?? '') : '';
    const pb = loadPlaybook(raw);
    const runId = crypto.randomUUID();
    const io: PlaybookIO = {
      turn: async ({ prompt, engine, correction }) => {
        onStatus?.(correction ? 'revising…' : 'working…');
        const rawr = await ipc.playbookTurn({ run_id: runId, prompt, cwd, engine });
        if (rawr?.is_error) return { is_error: true, terminal_reason: rawr.terminal_reason ?? 'unknown' };
        return { summary: String(rawr?.result ?? '').slice(0, 4000) };
      },
      runCheck: async (cmd) => {
        onStatus?.(cmd);
        return ipc.playbookRunCheck(cmd, cwd);
      },
    };
    const result = await runPlaybook({ task: task.trim(), playbook: pb, io });

    const withheld = !result.pass && result.gated;
    const fname = `${today()}-${slug(task)}${withheld ? '.rejected' : ''}.md`;
    const body = `# ${pb.name}\n\n> Task: ${task.trim()}\n\n\`\`\`\n${result.display}\n\`\`\`\n`;
    const outPath = `${cwd.replace(/\/$/, '')}/playbook/${fname}`;
    await ipc.createPath(cwd, 'playbook', 'folder').catch(() => undefined);
    await ipc.saveFile(outPath, body).catch(() => undefined);
    deps.reloadTree();
    return result;
  }

  return { run, label, libraryDir, list, create, read, save, runFile };
}
