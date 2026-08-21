// Build the worktree's web frontend and serve it with a Tauri shim injected,
// so the real app boots inside a plain headless Chrome (no Tauri runtime).
//
// Three jobs:
//   1. bundle src/web/app.ts (esbuild from the main checkout's node_modules,
//      since a worktree has none) into an in-memory app.js - with a tiny test
//      seam appended so a scenario can SET UP state (create groups/tabs) the
//      same way the UI would. The seam touches a bundled COPY only; committed
//      source is never modified.
//   2. copy the vendored libs (xterm, marked, …) the page <script>s expect.
//   3. http server that returns index.html with shim.js injected before the
//      first inline script, plus /app.js and /vendor/*.
//
// The shim (verify/shim.js) provides window.__TAURI_INTERNALS__ so the bundled
// @tauri-apps/api talks to our mock instead of a real backend, and records
// every invoke() so a scenario can assert what was persisted.

import * as esbuildNS from 'node:module';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Same strip the real shell build applies, so the harness exercises shipped bytes.
// The shell strip. In THIS repo it subsets the source at build time; in the
// published tree the source arrives already subset (scripts/publish-shell.mjs
// applies the same functions on the way out), so the module is withheld and
// there is nothing left to strip. Absent module => no plugin, by design.
let stripChatUi = null;
try { ({ stripChatUi } = await import('../build-shell-strip.mjs')); } catch { /* published tree: pre-stripped */ }

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKTREE = join(HERE, '..');

// The main checkout (git common dir's parent) hosts node_modules + esbuild.
function mainCheckout() {
  const common = execSync('git rev-parse --git-common-dir', { cwd: WORKTREE }).toString().trim();
  const abs = common.startsWith('/') ? common : join(WORKTREE, common);
  return join(abs, '..');
}
const MAIN = mainCheckout();
const NM = join(MAIN, 'node_modules');
if (!existsSync(join(NM, 'esbuild'))) {
  throw new Error(`esbuild not found at ${NM}. Run \`npm install\` in ${MAIN} first.`);
}
const esbuild = await import(join(NM, 'esbuild', 'lib', 'main.js'));

const VENDOR = {
  'xterm.js': '@xterm/xterm/lib/xterm.js',
  'xterm.css': '@xterm/xterm/css/xterm.css',
  'addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js',
  'addon-web-links.js': '@xterm/addon-web-links/lib/addon-web-links.js',
  'marked.min.js': 'marked/marked.min.js',
  'purify.min.js': 'dompurify/dist/purify.min.js',
  'highlight.min.js': '@highlightjs/cdn-assets/highlight.min.js',
  'turndown.umd.js': 'turndown/lib/turndown.browser.umd.js',
  'turndown-plugin-gfm.js': 'turndown-plugin-gfm/dist/turndown-plugin-gfm.js',
};

// Exposed on window inside the module scope so scenarios can build a realistic
// strip (these are all top-level names in app.ts). Setup only - the gesture
// under test is still driven through real DOM mouse events.
const SEAM = `
;(function () {
  try {
    window.__spike = {
      groups, sessions, renderTabs, activate,
      newGroupFor, newTabInGroup, assignTo, addGroupToModel,
      // folder→workspace adoption (#77 isolation fix): the pure cwd→group lookup
      // spawnHomeSession uses to bind a folder-launched session to its workspace.
      workspaceForCwd,
      Session, hydrateGroups, hideWelcome,
      // layout merge (drag-apart → bring-back-together): palette cmd + divider dbl-click
      renderLayout, resetLayout, layout, leaf, split, terminalLeaf, paletteItems, openProject,
      // the end state a tab-drag reaches (its own pane) and the way back, so a
      // scenario can inspect the popped pane's own tab bar without simulating
      // the whole drag — the drag itself has its own coverage.
      popSession, unpopSession,
      // in-pane browser: dock an http(s) URL live in the preview
      openUrl,
      // lane-owned preview lifecycle: attribution, orphan-on-close, eviction
      openFile, previews, orphanLane, sweepOrphans, laneColorFor,
      // recently-touched sidebar panel: record an edit/open + inspect the render
      noteTouched, renderRecentPanel,
      // template apply: the gate's "install" action, for the no-project guard test
      applyApprovedTiers, currentTheme,
      // theme tri-state (dark / light / system) + the xterm palette it drives
      applyTheme, themePref, effectiveTheme, xtermTheme,
      // worktree close policy: raise the real #wtask dialog without a Tauri event
      wtAskQueue, showNextWorktreeAsk,
      // settings split-view: open Defaults / a workspace page + seed a workspace;
      // loadConfig lets a scenario await the async config read before opening.
      settingsUI, newWorkspace, loadConfig,
      // learn-the-voice: raise the real #voiceask proposal card without the
      // record→analyze IPC round-trip (that path is Rust-side, unit-tested).
      showVoiceProposal,
      // chatview module: drive render()/the SPIKE loader directly (spike-loader-advance)
      chatview,
      // zoom + terminal-overlay geometry (zoom-pin #1): drive the real scale
      // pipeline and read where panes land relative to their slots.
      applyZoom, syncTermLayer, toViewportRect, ZOOM_STEPS,
      zoomTo: function (f) { var i = ZOOM_STEPS.indexOf(f); if (i >= 0) { zoomIndex = i; applyZoom(); } return zoomIndex; },
      zoomFactor: function () { return ZOOM_STEPS[zoomIndex]; },
      // attest: the verification run behind the palette command. Exposed so a scenario
      // can drive a whole run against fixtured Rust commands without keystroking the
      // palette's two-step arg mode, which has its own coverage.
      attest, palette,
      // Home shell entry points (new-build launcher): mirror a session into the
      // #home thread / return to the launcher, so a scenario can exercise the
      // Home surface (e.g. the debug raw-terminal dock) without the pty round-trip.
      get homeOpenWorkstream() { return homeOpenWorkstream; },
      get homeGoLauncher() { return homeGoLauncher; },
      // Workspaces surface: open the browsable list/detail over Home so a
      // scenario can drive the area view, brief edit, and scoped composer.
      get openWorkspacesView() { return openWorkspacesView; },
      // The pure PTY-stream formatter (terminal lines → reply HTML). Exposed so a
      // scenario can verify the parsing/reflow/block-detection without a live pty.
      parsePtyStreamText,
    };
    window.__spikeReady = true;
  } catch (e) { window.__spikeSeamError = String(e); }
})();
`;

async function bundleApp() {
  const appSrc = readFileSync(join(WORKTREE, 'src/web/app.ts'), 'utf8') + SEAM;
  const out = await esbuild.build({
    stdin: { contents: appSrc, resolveDir: join(WORKTREE, 'src/web'), loader: 'ts', sourcefile: 'app.harness.ts' },
    bundle: true, platform: 'browser', format: 'esm', target: 'es2022',
    loader: { '.png': 'dataurl' }, write: false, sourcemap: false,
    // Same define build-web.mjs uses, so a scenario can exercise the SHELL
    // edition (SPIKE_EDITION=shell node verify/run.mjs …) and not just the full
    // one. Without it every scenario ran as 'full' and the terminal-only
    // contract had no coverage at all.
    define: { __SPIKE_EDITION__: JSON.stringify(process.env.SPIKE_EDITION === 'shell' ? 'shell' : 'full') },
    plugins: process.env.SPIKE_EDITION === 'shell' && stripChatUi ? [stripChatUi] : [],
    nodePaths: [NM],
  });
  return out.outputFiles[0].text;
}

const CT = {
  '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
  '.png': 'image/png', '.map': 'application/json',
};

export async function startServer({ port = 0 } = {}) {
  const appJs = await bundleApp();
  const shimJs = readFileSync(join(HERE, 'shim.js'), 'utf8');
  let indexHtml = readFileSync(join(WORKTREE, 'index.html'), 'utf8');
  // Inject the shim as the very first <script> in <head> so __TAURI_INTERNALS__
  // exists before the inline runtime-flag script and before /app.js.
  indexHtml = indexHtml.replace('<head>', '<head>\n  <script src="/__shim.js"></script>');

  const server = createServer((req, res) => {
    const url = req.url.split('?')[0];
    const sendText = (body, ext) => { res.writeHead(200, { 'content-type': CT[ext] || 'text/plain' }); res.end(body); };
    try {
      if (url === '/' || url === '/index.html') return sendText(indexHtml, '.html');
      if (url === '/__shim.js') return sendText(shimJs, '.js');
      if (url === '/app.js') return sendText(appJs, '.js');
      if (url.startsWith('/vendor/')) {
        const name = url.slice('/vendor/'.length);
        const rel = VENDOR[name];
        if (!rel) { res.writeHead(404); return res.end('no vendor ' + name); }
        const ext = name.slice(name.lastIndexOf('.'));
        return sendText(readFileSync(join(NM, rel)), ext);
      }
      res.writeHead(404); res.end('not found: ' + url);
    } catch (e) {
      res.writeHead(500); res.end(String(e));
    }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const actual = server.address().port;
  return { url: `http://127.0.0.1:${actual}`, close: () => new Promise((r) => server.close(r)) };
}
