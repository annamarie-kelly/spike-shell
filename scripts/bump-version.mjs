// Bump Spike's version in the three files that must agree.
//
//   node scripts/bump-version.mjs 0.3.0
//   node scripts/bump-version.mjs        # no arg → print current, change nothing
//
// Why this exists: the updater compares the running app's version (baked in
// from tauri.conf.json) against the version in latest.json. package.json is
// what release-dmg.sh reads to name the dmg and tag the release. Cargo.toml is
// what the built binary reports. If those drift, you ship a release whose
// manifest says 0.3.0 while the app believes it's already 0.3.0 — and the
// update silently never applies. Bumping by hand across three files is exactly
// the kind of thing that drifts, so it's one command.
//
// Zero-dep on purpose, matching scripts/check-tauri-boundary.mjs.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Each entry: the file, and a regex whose FIRST capture group is the version
// literal. Anchored to the top-level key so we can't rewrite a dependency's
// version by accident.
const TARGETS = [
  { file: 'package.json',             re: /("version"\s*:\s*")([^"]+)(")/ },
  { file: 'src-tauri/tauri.conf.json', re: /("version"\s*:\s*")([^"]+)(")/ },
  { file: 'src-tauri/Cargo.toml',      re: /(^version\s*=\s*")([^"]+)(")/m },
];

function read(t) {
  const text = readFileSync(join(ROOT, t.file), 'utf8');
  const m = text.match(t.re);
  if (!m) throw new Error(`no version field found in ${t.file}`);
  return { text, match: m, current: m[2] };
}

const current = TARGETS.map((t) => ({ ...t, ...read(t) }));

const next = process.argv[2];
if (!next) {
  for (const t of current) console.log(`${t.current}  ${t.file}`);
  const distinct = new Set(current.map((t) => t.current));
  if (distinct.size > 1) {
    console.error(`\n✗ versions have drifted: ${[...distinct].join(', ')}`);
    console.error('  Run this script with the version you want to pin them all to.');
    process.exit(1);
  }
  console.log(`\n✓ all three agree on ${current[0].current}`);
  process.exit(0);
}

// Tauri requires plain semver — no 'v' prefix, no pre-release suffix (the
// updater's comparison rejects what it can't parse).
if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error(`✗ "${next}" is not a plain x.y.z semver — the updater can't compare it.`);
  process.exit(1);
}

for (const t of current) {
  writeFileSync(join(ROOT, t.file), t.text.replace(t.re, `$1${next}$3`));
  console.log(`  ${t.file}: ${t.current} → ${next}`);
}
console.log(`\n✓ bumped to ${next}. Cargo.lock updates on the next build.`);
