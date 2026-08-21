// Spike's architectural-boundary check — one invariant, enforced in CI:
//
//   ONLY src/web/ipc.ts may import from @tauri-apps/*.
//
// ipc.ts is the single shim that knows Tauri exists (see its header). Every
// other module stays transport-agnostic, so the Node test fixtures — and any
// future host — can run without the Tauri runtime. A leak here is the exact
// failure ipc.ts exists to prevent, so we fail the build on it rather than
// hope to catch it in review. Zero-dep on purpose; runs in plain Node.
//
// Run: `node scripts/check-tauri-boundary.mjs`  (wired into `npm run verify`)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');
const EXEMPT = join('src', 'web', 'ipc.ts'); // the one shim allowed to import @tauri-apps/*

// Matches a static `… from '@tauri-apps/…'` or a dynamic `import('@tauri-apps/…')`.
// A bare comment mention is intentionally NOT a violation — only real imports are.
const IMPORT_RE = /(?:from\s+|import\s*\(\s*)['"]@tauri-apps\//;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const offenders = [];
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file);
  if (rel === EXEMPT) continue;
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (IMPORT_RE.test(line)) offenders.push(`${rel}:${i + 1}:  ${line.trim()}`);
  });
}

if (offenders.length) {
  console.error('✗ Tauri boundary violated — only src/web/ipc.ts may import @tauri-apps/*:\n');
  for (const o of offenders) console.error('  ' + o);
  console.error(`\n${offenders.length} import(s) outside the shim. Route them through src/web/ipc.ts.`);
  process.exit(1);
}
console.log('✓ Tauri boundary intact — @tauri-apps/* imported only in src/web/ipc.ts');
