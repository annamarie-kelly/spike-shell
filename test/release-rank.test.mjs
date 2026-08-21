// The release-radar "rank" stage (src/routines/release-rank.ts), tested as pure
// classification — no network, no `gh`, no LLM, no disk. This is where the
// routine's judgement lives: a patch-level release with nothing notable must be
// dropped as noise, a security or breaking note must always surface however it's
// phrased, and the brief's order must be stable so an unattended run doesn't
// reshuffle its output between days. (npm test builds dist/ first.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, rank } from '../dist/routines/release-rank.js';

const change = (over = {}) => ({ pkg: 'pkg', from: '1.0.0', to: '1.0.1', notes: '', ...over });

test('a patch release with routine notes is noise and gets dropped', () => {
  const r = classify(change({ notes: 'Fixed a typo in the docs. Bumped internal deps.' }));
  assert.equal(r.signal, 'noise');
  assert.equal(r.severity, 0);
  assert.deepEqual(rank([change({ notes: 'minor perf tidy-up' })]), []);
});

test('a major version bump surfaces even when the notes say nothing alarming', () => {
  const r = classify(change({ from: '4.17.21', to: '5.0.0', notes: 'Rewrote the internals.' }));
  assert.equal(r.signal, 'major');
  assert.match(r.reasons.join(' '), /major bump 4→5/);
});

test('a security note surfaces on a mere patch bump', () => {
  const r = classify(change({ from: '2.3.0', to: '2.3.1', notes: 'Patch: fixes CVE-2026-1234, a prototype pollution vulnerability.' }));
  assert.equal(r.signal, 'security');
  assert.match(r.reasons.join(' '), /security note/);
});

test('security outranks a co-occurring breaking + major on the same release', () => {
  const r = classify(change({ from: '3.0.0', to: '4.0.0', notes: 'BREAKING CHANGE: removed the legacy API. Also patches a security advisory.' }));
  assert.equal(r.signal, 'security'); // highest precedence wins the label
  // ...but every trigger is still recorded, so the brief can explain all of it.
  const joined = r.reasons.join(' | ');
  assert.match(joined, /security note/);
  assert.match(joined, /breaking note/);
  assert.match(joined, /major bump 3→4/);
});

test('breaking language is caught in several phrasings', () => {
  for (const notes of ['This is a breaking change.', 'We removed the old flag.', 'Node 16 is no longer supported.', 'Dropped support for legacy configs.']) {
    assert.equal(classify(change({ notes })).signal, 'breaking', notes);
  }
});

test('deprecation is surfaced but sits below breaking and major', () => {
  const dep = classify(change({ notes: 'The `oldOption` field is now deprecated.' }));
  assert.equal(dep.signal, 'deprecation');
  assert.equal(dep.severity, 1);
});

test('version prefixes and pre-release tags do not fool the major-bump check', () => {
  assert.equal(classify(change({ from: 'v1.9.0', to: 'v2.0.0-rc.1', notes: 'x' })).signal, 'major');
  assert.equal(classify(change({ from: '^2.0.0', to: '~2.4.0', notes: 'x' })).signal, 'noise'); // same major, nothing notable
});

test('rank drops noise and orders by severity, then package name for a stable brief', () => {
  const changes = [
    change({ pkg: 'quiet', notes: 'docs only' }), // noise → dropped
    change({ pkg: 'zeta', from: '1.0.0', to: '2.0.0', notes: 'rewrite' }), // major
    change({ pkg: 'alpha', notes: 'fixes a security vulnerability' }), // security
    change({ pkg: 'beta', notes: 'BREAKING CHANGE: removed X' }), // breaking
    change({ pkg: 'aaa', from: '1.0.0', to: '2.0.0', notes: 'big rewrite' }), // major, ties with zeta
  ];
  const out = rank(changes);
  // noise gone; the rest ordered security > breaking > major, majors tie-broken by name.
  assert.deepEqual(out.map((r) => r.pkg), ['alpha', 'beta', 'aaa', 'zeta']);
  assert.deepEqual(out.map((r) => r.signal), ['security', 'breaking', 'major', 'major']);
});

test('empty or missing notes never throw and rank as noise unless the version jumped', () => {
  assert.equal(classify(change({ notes: '' })).signal, 'noise');
  assert.equal(classify({ pkg: 'p', from: '1.0.0', to: '1.0.1' }).signal, 'noise');
  assert.equal(classify({ pkg: 'p', from: '1.2.3', to: '2.0.0' }).signal, 'major');
});
