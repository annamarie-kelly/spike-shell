// Headless verification entrypoint. Boots the real Spike frontend in headless
// Chrome under a Tauri shim and runs a scenario, printing a PASS/FAIL report
// with screenshot paths.
//
//   node verify/run.mjs [scenario]        # default: reorder-groups
//   SPIKE_HEADED=1 node verify/run.mjs    # watch it in a real window
//
// Screenshots land in $SPIKE_OUT or ./verify/out.

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';
import { launch as rawLaunch } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const outDir = process.env.SPIKE_OUT || join(HERE, 'out');
mkdirSync(outDir, { recursive: true });

const headed = process.env.SPIKE_HEADED === '1';
const launch = (opts = {}) => rawLaunch({ headless: !headed, ...opts });

const name = process.argv[2] || 'reorder-groups';
const { run } = await import(join(HERE, 'scenarios', `${name}.mjs`));

const results = await run({ startServer, launch, outDir });

let allPass = true;
console.log(`\n=== Verification: ${name} ===\n`);
for (const r of results) {
  console.log(`▸ ${r.part}`);
  for (const [k, v] of Object.entries(r)) {
    if (k === 'part' || k === 'checks') continue;
    console.log(`    ${k}: ${JSON.stringify(v)}`);
  }
  for (const [check, ok] of Object.entries(r.checks)) {
    allPass = allPass && ok;
    console.log(`    ${ok ? '✅' : '❌'} ${check}`);
  }
  console.log('');
}
console.log(`screenshots: ${outDir}`);
console.log(`\n${allPass ? 'PASS ✅' : 'FAIL ❌'}\n`);
process.exit(allPass ? 0 : 1);
