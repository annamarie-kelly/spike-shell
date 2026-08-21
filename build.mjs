// Spike's test-fixture build. The shipping app is Tauri — its frontend is
// bundled by build-web.mjs (→ dist-web/), and its backend is Rust (src-tauri/).
// This script exists only to transpile the two PURE modules the Node test suite
// imports, into dist/ as CommonJS:
//   src/groupmd.ts          -> dist/groupmd.js          (test/groupmd.test.mjs)
//   src/assemble-context.ts -> dist/assemble-context.js (test/assemble-context.test.mjs)
//   src/web/layout.ts    -> dist/web/layout.js     (test/layout.test.mjs)
//   src/web/groupmerge.ts-> dist/web/groupmerge.js (test/groupmerge.test.mjs)
//   src/web/uninstall.ts -> dist/web/uninstall.js  (test/uninstall.test.mjs)
//   src/web/pathparam.ts -> dist/web/pathparam.js  (test/pathparam.test.mjs)
//   src/web/mdedit.ts    -> dist/web/mdedit.js     (test/mdedit.test.mjs)
//   src/web/chatview.ts  -> dist/web/chatview.js   (test/chatview.test.mjs)
//   src/web/connector-logos.ts -> dist/web/connector-logos.js (chatview imports it)
//   src/web/converge.ts  -> dist/web/converge.js   (test/converge.test.mjs)
//   src/web/lane-controller.ts -> dist/web/lane-controller.js (test/lane-controller.test.mjs)
//   src/routines/release-rank.ts -> dist/routines/release-rank.js (test/release-rank.test.mjs)
//   src/attest/*.ts      -> dist/attest/*.js       (test/attest-*.test.mjs)
//   src/attest/playbook.ts -> dist/attest/playbook.js (test/playbook.test.mjs)
// chatview's parsers and humanizer are pure; only its renderer touches the DOM,
// and the tests import the pure half. The attest modules are pure throughout —
// segmenting, substitution, and gating never touch the model or the disk, which
// is what makes the verbatim guarantee testable without spending a token.
// Both are framework-free data modules, so test/ can exercise them without a
// browser or the app. esbuild only transpiles here (no bundling) so a relative
// import like `./groupmd` resolves to its sibling dist/groupmd.js at runtime.
// Run `node build.mjs` to build once, `node build.mjs --watch` to watch.
//
// (The legacy Node HTTP/WebSocket server, src/server.ts, was removed when web
// mode was deprecated — Spike is Tauri-only. ipc.ts has no HTTP fallback, so
// the browser build could never function.)
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const fixtures = {
  entryPoints: ['src/groupmd.ts', 'src/assemble-context.ts', 'src/work/card.ts', 'src/web/layout.ts', 'src/web/groupmerge.ts', 'src/web/uninstall.ts', 'src/web/pathparam.ts', 'src/web/mdedit.ts', 'src/web/chatview.ts', 'src/web/connector-logos.ts', 'src/web/converge.ts', 'src/web/mention.ts', 'src/web/lane-controller.ts', 'src/routines/release-rank.ts', 'src/attest/segmenter.ts', 'src/attest/quote-extract.ts', 'src/attest/quote-gate.ts', 'src/attest/facts-cited.ts', 'src/attest/contract.ts', 'src/attest/yaml.ts', 'src/attest/checkset.ts', 'src/attest/render.ts', 'src/attest/redo.ts', 'src/attest/run.ts', 'src/attest/record.ts', 'src/attest/playbook.ts'],
  outdir: 'dist',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: true,
  logLevel: 'info',
};

await esbuild.build(fixtures);

if (watch) {
  const ctx = await esbuild.context(fixtures);
  await ctx.watch();
  console.log('spike: esbuild watching test fixtures — run `npm run dev:tauri` for the app.');
}
