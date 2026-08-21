// chat-demo.mjs — render a real agent transcript through src/web/chatview.ts
// into a standalone HTML page, so the calm view can be looked at before it is
// wired into a pane.
//
//   node scripts/chat-demo.mjs [transcript.jsonl] [--engine claude|codex]
//
// With no argument it picks the newest Claude transcript for this repo. Output
// lands in the session scratchpad (or ./dist-web/chat-demo.html as a fallback)
// and the path is printed — open it with `spike open <path>`.
import * as esbuild from 'esbuild';
import fs from 'fs';
import os from 'os';
import path from 'path';

const argv = process.argv.slice(2);
const engine = argv.includes('--engine') ? argv[argv.indexOf('--engine') + 1] : 'claude';
let file = argv.find((a) => a.endsWith('.jsonl'));

if (!file) {
  // Claude encodes the cwd into the project folder name: /a/b → -a-b.
  const dir = path.join(os.homedir(), '.claude', 'projects', process.cwd().replace(/\//g, '-'));
  const found = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
        .map((f) => path.join(dir, f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    : [];
  if (!found.length) {
    console.error(`no transcript found under ${dir} — pass one explicitly`);
    process.exit(1);
  }
  file = found[0];
}

const lines = fs.readFileSync(file, 'utf8').split('\n');

// Bundle chatview + a tiny driver as one IIFE. Same esbuild the app uses.
const entry = path.join(os.tmpdir(), `chatdemo-entry-${process.pid}.ts`);
fs.writeFileSync(entry, `
import { parse, render, composer, CHAT_CSS } from ${JSON.stringify(path.resolve('src/web/chatview.ts'))};
const w = window as any;
const style = document.createElement('style');
style.textContent = CHAT_CSS;
document.head.appendChild(style);
// Same renderer the app uses: Spike vendors marked + DOMPurify as globals.
const markdown = (src: string) => w.DOMPurify.sanitize(w.marked.parse(src, { breaks: true }));
const turns = parse(w.__LINES__, w.__ENGINE__);
const host = document.createElement('div');
document.getElementById('app')!.appendChild(host);
render(host, turns, { markdown });
document.getElementById('app')!.appendChild(
  composer((text) => {
    // The demo has no PTY behind it; the real pane writes this into the lane.
    turns.push({ actor: 'you', blocks: [{ type: 'text', text }] });
    render(host, turns, { markdown, working: true });
    host.scrollIntoView({ block: 'end' });
  })
);
`);

const { outputFiles } = await esbuild.build({
  entryPoints: [entry],
  bundle: true, format: 'iife', write: false, target: 'es2020',
});
fs.unlinkSync(entry);
const js = outputFiles[0].text;

// Spike's palette, both themes, so the demo looks like the app it belongs to.
const THEME = `
:root {
  --bg:#1C1A18; --surface:#2A2826; --surface-soft:#211F1D; --elevated:#322F2D;
  --edge:#3A3836; --edge-soft:#2F2D2B;
  --ink:#F2EEE9; --ink-soft:#CFC9C2; --ink-faint:#7D7872; --ink-ghost:#6B655E;
  --sage-deep:#8A9D8A; --blue-deep:#7A9BB0; --accent:#E2A299;
  --shadow:0,0,0; --shadow-k:1;
}
:root[data-theme="light"] {
  --bg:#F4F0EA; --surface:#EAE5DD; --surface-soft:#ECE7DF; --elevated:#FFFFFF;
  --edge:#D6CFC4; --edge-soft:#DFD8CE;
  --ink:#1A1816; --ink-soft:#3D3935; --ink-faint:#8E867E; --ink-ghost:#9E9891;
  --sage-deep:#3F5A3F; --blue-deep:#2E5473; --accent:#B85F4E;
  --shadow:82,68,52; --shadow-k:.45;
}
html, body { height: 100%; margin: 0; background: var(--bg); }
#app { height: 100%; display: flex; flex-direction: column; }
#app > .cw { flex: 1; min-height: 0; }
#theme {
  position: fixed; top: 12px; right: 14px; z-index: 2;
  background: var(--surface); color: var(--ink-faint); border: 1px solid var(--edge-soft);
  border-radius: 999px; padding: 5px 12px; font: 12px ui-sans-serif, system-ui; cursor: pointer;
}
`;

// A transcript is full of code, and code contains "</script>". Embedded raw,
// that string closes the tag early and the rest of the file lands in the body
// as invisible text. Escaping "<" as < inside the JSON literal is the
// standard fix and keeps the value identical after parse.
const embed = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

const html = `<!doctype html>
<meta charset="utf-8">
<title>Spike — calm view</title>
<style>${THEME}</style>
<script>${fs.readFileSync('node_modules/marked/marked.min.js', 'utf8')}</script>
<script>${fs.readFileSync('node_modules/dompurify/dist/purify.min.js', 'utf8')}</script>
<button id="theme">light</button>
<div id="app"></div>
<script>
  window.__LINES__ = ${embed(lines)};
  window.__ENGINE__ = ${embed(engine)};
  document.getElementById('theme').onclick = (e) => {
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    document.documentElement.setAttribute('data-theme', light ? 'dark' : 'light');
    e.target.textContent = light ? 'light' : 'dark';
  };
</script>
<script>${js}</script>
`;

const scratch = process.env.SPIKE_SCRATCH || '';
const outDir = scratch && fs.existsSync(scratch) ? scratch : 'dist-web';
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'chat-demo.html');
fs.writeFileSync(out, html);
console.log(`transcript: ${file}`);
console.log(out);
