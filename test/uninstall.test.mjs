// Uninstall planning: split a ledger entry's items into how each is reverted, and
// trim the entry from the ledger. The Rust side (revert_settings + the inverse
// merge) is tested in fs_ops.rs; this covers the pure page-side decisions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categorizeItems, removeLedgerEntry, entryLabel } from '../dist/web/uninstall.js';

const items = [
  { type: 'theme', mode: 'dark', prior: 'light', _installedBy: 'wb@0.1.0' },
  { type: 'group', name: 'backend', _installedBy: 'wb@0.1.0' },
  { type: 'group', name: 'frontend', _installedBy: 'wb@0.1.0' },
  { type: 'hook', name: 'PreToolUse [Bash]', detail: 'scan.sh', scope: 'global', _installedBy: 'wb@0.1.0' },
  { type: 'grant', name: 'Bash(ls)', scope: 'global', _installedBy: 'wb@0.1.0' },
  { type: 'mcp', name: 'linear', scope: 'project', _installedBy: 'wb@0.1.0' },
  { type: 'skill', name: 'verify', scope: 'global', _installedBy: 'wb@0.1.0' },
  { type: 'spawn', name: 'engine = codex', scope: 'spike', _installedBy: 'wb@0.1.0' },
];

test('categorizeItems splits groups / theme / extras', () => {
  const { groups, theme, extras } = categorizeItems(items);
  assert.deepEqual(groups, ['backend', 'frontend']);
  assert.equal(theme.mode, 'dark');
  assert.equal(theme.prior, 'light', 'prior carried so uninstall can restore it');
  // every config-touching item goes to extras for the Rust inverse merge
  assert.deepEqual(extras.map((e) => e.type).sort(), ['grant', 'hook', 'mcp', 'skill', 'spawn']);
});

test('categorizeItems ignores blank/unknown items', () => {
  const { groups, theme, extras } = categorizeItems([
    { type: 'group', name: '  ' },        // blank name → dropped
    { type: 'mystery', name: 'x' },       // unknown type → dropped
    null,
    { type: 'group', name: 'real' },
  ]);
  assert.deepEqual(groups, ['real']);
  assert.equal(theme, null);
  assert.equal(extras.length, 0);
});

test('categorizeItems tolerates a missing items list', () => {
  const parts = categorizeItems(undefined);
  assert.deepEqual(parts, { groups: [], theme: null, extras: [] });
});

test('removeLedgerEntry drops exactly one entry, leaves a copy', () => {
  const ledger = [{ template: 'a' }, { template: 'b' }, { template: 'c' }];
  const out = removeLedgerEntry(ledger, 1);
  assert.deepEqual(out.map((e) => e.template), ['a', 'c']);
  assert.equal(ledger.length, 3, 'original not mutated');
});

test('removeLedgerEntry out-of-range is a no-op', () => {
  const ledger = [{ template: 'a' }];
  assert.deepEqual(removeLedgerEntry(ledger, 5), ledger);
  assert.deepEqual(removeLedgerEntry(ledger, -1), ledger);
});

// Regression: uninstalling several entries in one modal session must compose.
// The bug: each row trimmed `removeLedgerEntry(originalSnapshot, originalIndex)`
// and persisted that, so uninstalling row 0 then row 2 wrote [a,c] minus index 2
// = [a,b] — resurrecting the already-removed `a`. The fix removes each entry from
// a single live ledger by its CURRENT position (indexOf the entry reference).
test('successive uninstalls by entry reference never resurrect a removed entry', () => {
  const a = { template: 'a' }, b = { template: 'b' }, c = { template: 'c' };
  let ledger = [a, b, c];                       // the live, reassigned ledger
  const persisted = [];
  const uninstall = (entry) => {                // mirrors the app.ts caller
    const at = ledger.indexOf(entry);
    if (at >= 0) { ledger = removeLedgerEntry(ledger, at); persisted.push(ledger.map((e) => e.template)); }
  };
  uninstall(a);                                 // remove the FIRST row
  uninstall(c);                                 // then a LATER row, modal still open
  assert.deepEqual(persisted, [['b', 'c'], ['b']]);
  assert.deepEqual(ledger.map((e) => e.template), ['b'], 'a stays gone; only b remains');
  // re-clicking an already-removed row is an inert no-op (indexOf → -1)
  uninstall(a);
  assert.deepEqual(ledger.map((e) => e.template), ['b']);
});

test('entryLabel is a readable one-liner', () => {
  assert.equal(
    entryLabel({ template: 'wb', version: '0.1.0', scope: 'global', items }),
    'wb@0.1.0 · 8 items · global');
  assert.equal(
    entryLabel({ template: 'x', version: '1.0.0', scope: 'project', items: [{ type: 'theme' }] }),
    'x@1.0.0 · 1 item · project');
});
