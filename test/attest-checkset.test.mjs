// The check set decides what "verified" means, so a misread file is a silently wrong
// verdict. Both halves are tested for refusal as much as for acceptance: the YAML reader
// must throw on the constructs it does not support rather than approximate them, and the
// loader must refuse an unknown check name rather than run a weaker check set.
//
// (npm test builds dist/ first.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml } from '../dist/attest/yaml.js';
import { loadCheckSet, STARTER_CHECK_SET, DETERMINISTIC_CHECKS } from '../dist/attest/checkset.js';

// ── the reader ──────────────────────────────────────────────────────────────────

test('block maps, nesting and scalar types', () => {
  const v = parseYaml(`
name: Source-backed summary
answer:
  items:
    min: 3
    max: 5
  minClaimWords: 8
enabled: true
missing: null
ratio: 1.5
`);
  assert.equal(v.name, 'Source-backed summary');
  assert.deepEqual(v.answer.items, { min: 3, max: 5 });
  assert.equal(v.answer.minClaimWords, 8);
  assert.equal(v.enabled, true);
  assert.equal(v.missing, null);
  assert.equal(v.ratio, 1.5);
});

test('sequences of scalars, of flow maps, and of single-key maps', () => {
  const v = parseYaml(`
plain:
  - one
  - two
flow:
  - { type: folder, path: ./sources, include: [a.md, b.md] }
keyed:
  - min-claim-words: 8
  - closed-surface
`);
  assert.deepEqual(v.plain, ['one', 'two']);
  assert.deepEqual(v.flow, [{ type: 'folder', path: './sources', include: ['a.md', 'b.md'] }]);
  assert.deepEqual(v.keyed, [{ 'min-claim-words': 8 }, 'closed-surface']);
});

test('comments are stripped, but a # inside a quoted string survives', () => {
  const v = parseYaml(`
name: Memo   # trailing comment
# a whole-line comment
color: "#9AAA57"
`);
  assert.equal(v.name, 'Memo');
  assert.equal(v.color, '#9AAA57');
});

test('quoted scalars keep characters that would otherwise be structure', () => {
  const v = parseYaml(`a: "x: y"\nb: 'it''s fine'\nc: "line\\nbreak"`);
  assert.equal(v.a, 'x: y');
  assert.equal(v.c, 'line\nbreak');
});

test('a value that looks numeric but is quoted stays a string', () => {
  const v = parseYaml('version: "2"\nn: 2');
  assert.equal(v.version, '2');
  assert.equal(v.n, 2);
});

test('REFUSES what it does not support, rather than guessing', () => {
  const unsupported = {
    'multi-line scalar': 'body: |\n  some text',
    anchors: 'base: &a\n  x: 1',
    aliases: 'copy: *a',
    tags: 'when: !!timestamp 2026-01-01',
    'tab indentation': 'a:\n\tb: 1',
    'a bare line with no key': 'name: ok\njust some prose',
  };
  for (const [what, src] of Object.entries(unsupported)) {
    assert.throws(() => parseYaml(src), `${what} was accepted silently`);
  }
});

test('an unclosed bracket is an error, not a truncated value', () => {
  assert.throws(() => parseYaml('sources:\n  - { type: folder, path: ./x'));
});

test('the error names the line', () => {
  try {
    parseYaml('name: ok\nbad line here\n');
    assert.fail('expected a throw');
  } catch (e) {
    assert.match(e.message, /line 2/);
  }
});

// ── the loader ──────────────────────────────────────────────────────────────────

test('the starter check set loads and every check in it is real', () => {
  const cs = loadCheckSet(STARTER_CHECK_SET);
  assert.equal(cs.name, 'Source-backed summary');
  assert.deepEqual(cs.answer.items, { min: 3, max: 5 });
  assert.equal(cs.answer.minDistinctSources, 2);
  assert.equal(cs.args.get('min-claim-words'), 8);
  assert.equal(cs.onFail, 'annotate');
  assert.equal(cs.model, 'haiku');
  for (const c of cs.checks) assert.ok(DETERMINISTIC_CHECKS.includes(c), `unknown check ${c}`);
});

test('defaults fill in, so a minimal check set is usable', () => {
  const cs = loadCheckSet(`
name: Minimal
sources:
  - { type: folder, path: ./s }
checks:
  - closed-surface
`);
  assert.equal(cs.onFail, 'annotate');
  assert.equal(cs.model, 'haiku');
  assert.equal(cs.maxRedos, 1);
  assert.equal(cs.answer.minClaimWords, 8);
});

test('REFUSES an unknown check name - a typo must not silently weaken the set', () => {
  assert.throws(
    () => loadCheckSet('name: X\nsources:\n  - { type: folder, path: ./s }\ncheeks:\n  - closed-surface'),
    /unknown key/,
  );
  assert.throws(
    () => loadCheckSet('name: X\nsources:\n  - { type: folder, path: ./s }\nchecks:\n  - closed-surfce'),
    /unknown check/,
  );
});

test('REFUSES an unknown top-level or answer key', () => {
  const base = 'name: X\nsources:\n  - { type: folder, path: ./s }\nchecks:\n  - closed-surface\n';
  assert.throws(() => loadCheckSet(`${base}modle: haiku\n`), /unknown key `modle`/);
  assert.throws(() => loadCheckSet(`${base}answer:\n  itmes: { min: 1, max: 2 }\n`), /unknown key `answer.itmes`/);
});

test('REFUSES a source type that is not built yet, and says which are', () => {
  assert.throws(
    () => loadCheckSet('name: X\nsources:\n  - { type: notion, id: abc }\nchecks:\n  - closed-surface'),
    /supported today: folder, attachment/,
  );
});

test('REFUSES an empty sources or checks list', () => {
  assert.throws(() => loadCheckSet('name: X\nsources: []\nchecks:\n  - closed-surface'), /nothing to quote/);
  assert.throws(
    () => loadCheckSet('name: X\nsources:\n  - { type: folder, path: ./s }\nchecks: []'),
    /verify nothing/,
  );
});

test('REFUSES an incoherent answer contract', () => {
  const base = 'name: X\nsources:\n  - { type: folder, path: ./s }\nchecks:\n  - closed-surface\n';
  assert.throws(() => loadCheckSet(`${base}answer:\n  items: { min: 9, max: 2 }\n`), /exceeds max/);
  assert.throws(
    () => loadCheckSet(`${base}answer:\n  decision: { field: CALL, values: [Only] }\n`),
    /at least two options/,
  );
});

test('REFUSES an on_fail value it does not implement', () => {
  assert.throws(
    () => loadCheckSet('name: X\nsources:\n  - { type: folder, path: ./s }\nchecks:\n  - closed-surface\non_fail: warn'),
    /must be annotate or gate/,
  );
});

test('a decision is read as a closed set', () => {
  const cs = loadCheckSet(`
name: X
sources:
  - { type: folder, path: ./s }
checks:
  - closed-surface
answer:
  decision: { field: RECOMMENDATION, values: [Pursue, Watch, Pass] }
`);
  assert.deepEqual(cs.answer.decision, { field: 'RECOMMENDATION', values: ['Pursue', 'Watch', 'Pass'] });
});

test('every documented check name is loadable', () => {
  // Guards against the catalogue and the loader drifting apart, which would present a
  // check in the docs that the loader rejects.
  // min-distinct-sources needs a threshold or the loader refuses it, which is the point:
  // a check with no threshold passes unconditionally.
  const body = DETERMINISTIC_CHECKS.map((c) => (c === 'min-distinct-sources' ? `  - ${c}: 2` : `  - ${c}`)).join('\n');
  const cs = loadCheckSet(`name: X\nsources:\n  - { type: folder, path: ./s }\nchecks:\n${body}`);
  assert.equal(cs.checks.size, DETERMINISTIC_CHECKS.length);
});

// ── engine ──────────────────────────────────────────────────────────────────────

test('engine defaults to claude, and codex is accepted', () => {
  const base = 'name: X\nsources:\n  - { type: folder, path: ./s }\nchecks:\n  - closed-surface\n';
  assert.equal(loadCheckSet(base).engine, 'claude');
  assert.equal(loadCheckSet(`${base}engine: codex\n`).engine, 'codex');
});

test('REFUSES an engine that is not implemented', () => {
  const base = 'name: X\nsources:\n  - { type: folder, path: ./s }\nchecks:\n  - closed-surface\n';
  assert.throws(() => loadCheckSet(`${base}engine: gemini\n`), /must be claude or codex/);
});

test('a codex check set names no model, because codex picks its own', () => {
  // Defaulting to `haiku` here and passing it to codex would be a lie in the receipt.
  const base = 'name: X\nsources:\n  - { type: folder, path: ./s }\nchecks:\n  - closed-surface\n';
  assert.equal(loadCheckSet(`${base}engine: codex\n`).model, '');
  assert.equal(loadCheckSet(`${base}engine: codex\nmodel: gpt-5\n`).model, 'gpt-5');
});

test('the starter names its engine explicitly', () => {
  assert.match(STARTER_CHECK_SET, /^engine: claude/m);
  assert.equal(loadCheckSet(STARTER_CHECK_SET).engine, 'claude');
});

// ── a file that loads must enforce what it says ─────────────────────────────────

test('NEGATIVE - one stray space must not silently discard the rest of the file', () => {
  // Both block loops stop the moment an indent does not match exactly, so a single extra
  // space used to drop every remaining line: checks, thresholds and on_fail included. The
  // run then enforced less than the file on screen said, with no error anywhere.
  const src = [
    'name: X',
    'sources:',
    '  - { type: folder, path: ./s }',
    'checks:',
    '  - closed-surface',
    '  - quotes-in-evidence',
    '   - facts-cited',
    'on_fail: gate',
  ].join('\n');
  assert.throws(() => loadCheckSet(src), /unexpected indentation/);
});

test('NEGATIVE - a duplicate key is refused, not silently overwritten', () => {
  const src = 'name: X\nsources:\n  - { type: folder, path: ./s }\nchecks:\n  - closed-surface\nchecks:\n  - facts-cited';
  assert.throws(() => loadCheckSet(src), /duplicate key `checks`/);
});

test('NEGATIVE - a check with no threshold is refused rather than run as a no-op', () => {
  const base = 'name: X\nsources:\n  - { type: folder, path: ./s }\nchecks:\n  - min-distinct-sources\n';
  assert.throws(() => loadCheckSet(base), /passes unconditionally/);
  // Either spelling of the threshold satisfies it.
  assert.equal(loadCheckSet(base.replace('- min-distinct-sources', '- min-distinct-sources: 2')).args.get('min-distinct-sources'), 2);
  assert.equal(loadCheckSet(`${base}answer:\n  minDistinctSources: 2\n`).answer.minDistinctSources, 2);
});

test('NEGATIVE - a quoted number is refused, not silently discarded to a default', () => {
  const base = 'name: X\nsources:\n  - { type: folder, path: ./s }\nchecks:\n  - closed-surface\n';
  assert.throws(() => loadCheckSet(`${base}answer:\n  minClaimWords: "8"\n`), /must be a number/);
  assert.throws(() => loadCheckSet(`${base}answer:\n  items: { min: "2", max: 4 }\n`), /must be a number/);
});

test('NEGATIVE - a check that is not implemented is not loadable', () => {
  // cite-latest-source used to load clean and enforce nothing, which defeats the loader's
  // contract by name rather than by typo.
  const base = 'name: X\nsources:\n  - { type: folder, path: ./s }\nchecks:\n  - cite-latest-source\n';
  assert.throws(() => loadCheckSet(base), /unknown check/);
});
