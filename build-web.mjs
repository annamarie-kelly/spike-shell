// Builds the self-contained web frontend for the Tauri shell into dist-web/:
//   index.html  — copied verbatim from the repo root (it loads /app.js, which
//                 resolves against the frontendDist root when Tauri serves it)
//   app.js(.map) — src/web/app.ts bundled by esbuild (same options as build.mjs's
//                 `web` target, just a different outfile)
// tauri.conf.json points build.frontendDist at ../dist-web, so `tauri dev` and
// `tauri build` serve exactly this folder. Run via `npm run build:web`.
import * as esbuild from 'esbuild';
import fs from 'fs';

// Which product this bundle is — read before anything that varies by edition
// (the index.html copy below does), so it has to be declared up here.
const EDITION = process.env.SPIKE_EDITION === 'shell' ? 'shell' : 'full';

// The shell strip. In THIS repo it subsets the source at build time; in the
// published tree the source arrives already subset (scripts/publish-shell.mjs
// applies the same functions on the way out), so the module is withheld and
// there is nothing left to strip. Absent module => no plugin, by design.
let stripChatUi = null, stripIndexHtml = null;
try { ({ stripChatUi, stripIndexHtml } = await import('./build-shell-strip.mjs')); } catch { /* published tree: pre-stripped */ }

fs.mkdirSync('dist-web', { recursive: true });
// index.html carries the Home surface's markup (#home, ~145 lines). The shell
// edition has that code stripped from app.ts, so shipping the markup would leave
// dead product chrome in a public file for anyone to read. Cut it to a husk —
// app.ts still does `getElementById('home')`, and null is a state it handles.
{
  // index.html carries the Home markup. In THIS repo it is still whole and gets
  // subset here; in the published tree it arrived subset, the strip module is
  // withheld, and there is nothing to do. Same function either way.
  let html = fs.readFileSync('index.html', 'utf8');
  if (EDITION === 'shell' && stripIndexHtml) {
    const { text, removed } = stripIndexHtml(html);
    if (removed) console.log(`  strip: ${removed} lines of Home markup from index.html`);
    html = text;
  }
  fs.writeFileSync('dist-web/index.html', html);
}

// Vendored front-end libs. These used to load from cdn.jsdelivr.net at runtime,
// which broke the *packaged* app: a desktop build runs from the tauri.localhost
// origin under a strict CSP and may launch offline, so the remote xterm CSS/JS
// silently failed and the terminal rendered unstyled. Bundling them locally
// (copied here, referenced as /vendor/* in index.html) makes rendering
// deterministic and lets us drop jsdelivr from the CSP. The npm lib/*.js files
// are the same UMD bundles the CDN served (just un-minified) — same globals.
const VENDOR = [
  ['node_modules/@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['node_modules/@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
  ['node_modules/@xterm/addon-web-links/lib/addon-web-links.js', 'addon-web-links.js'],
  ['node_modules/marked/marked.min.js', 'marked.min.js'],
  ['node_modules/dompurify/dist/purify.min.js', 'purify.min.js'],
  ['node_modules/@highlightjs/cdn-assets/highlight.min.js', 'highlight.min.js'],
  // WYSIWYG markdown editing serializes the contenteditable DOM back to markdown
  // on save — turndown (HTML→md) + its GFM plugin (tables/strikethrough/tasks).
  // Mirror the marked/DOMPurify pattern: UMD globals, no bundler entanglement.
  ['node_modules/turndown/lib/turndown.browser.umd.js', 'turndown.umd.js'],
  ['node_modules/turndown-plugin-gfm/dist/turndown-plugin-gfm.js', 'turndown-plugin-gfm.js'],
  // Newsreader (variable serif, latin subset) — vendored locally for the Home
  // landing brand + headings, since the packaged app can't fetch Google Fonts.
  ['web-fonts/newsreader-latin.woff2', 'newsreader-latin.woff2'],
];
fs.mkdirSync('dist-web/vendor', { recursive: true });
for (const [src, name] of VENDOR) fs.copyFileSync(src, `dist-web/vendor/${name}`);

// Which product this bundle is. `SPIKE_EDITION=shell npm run build:web` builds
// Spike Shell — the public, terminal-only client — from the same source tree;
// anything else builds the full app. app.ts reads it through a typeof guard, so
// builders that don't set the define (verify's harness) get the full edition.
if (EDITION !== 'full') console.log(`edition: ${EDITION}`);


// The shell edition strips chat out of the BUNDLE, not just off the screen.
// Shared with verify/serve.mjs so the harness tests the same bytes we ship.

await esbuild.build({
  entryPoints: ['src/web/app.ts'],
  define: { __SPIKE_EDITION__: JSON.stringify(EDITION) },
  // small images import as data URIs (the launcher's Claude logo) — one bundle,
  // no asset copying for either web target.
  loader: { '.png': 'dataurl' },
  outfile: 'dist-web/app.js',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  sourcemap: true,
  logLevel: 'info',
  plugins: EDITION === 'shell' && stripChatUi ? [stripChatUi] : [],
});

console.log('dist-web/ ready (index.html + app.js)');
