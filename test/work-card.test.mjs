// The EntityContextCard projector. These tests exist to pin two properties the
// spec is strict about and that are easy to lose by accident:
//
//   1. the card is REBUILDABLE — same records + same clock ⇒ byte-identical card,
//      so a projection can be discarded and recomputed with no drift;
//   2. every displayed value is TRACEABLE — the source row that produced it is
//      carried on the field, not summarized away.
//
// Runs against the compiled module (npm test builds first). No DB, no webview.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, describeGap, daysBetween, PROJECTION_VERSION } from '../dist/work/card.js';

const NOW = '2026-08-20';

// Shaped exactly like what workstore::entity_records returns for a row of the
// user's real investors.csv + team.csv.
const SARAH = {
  id: 'ent_1',
  kind: 'person',
  name: 'Sarah Guo',
  status: 'active',
  version: 3,
  updatedAt: '2026-08-20T10:00:00.000Z',
  aliases: ['Sarah Guo'],
  facts: [
    { key: 'check size', value: '$1500000', sourceRef: 'investors.csv#2' },
    { key: 'role', value: 'Partner', sourceRef: 'investors.csv#2' },
    { key: 'stage', value: 'Seed', sourceRef: 'investors.csv#2' },
    { key: 'warm', value: 'yes', sourceRef: 'investors.csv#2' },
  ],
  related: [
    { id: 'ent_2', name: 'Conviction', kind: 'company', relation: 'works_at', direction: 'out' },
  ],
  interactions: [
    { id: 'int_1', kind: 'meeting', occurredAt: '2026-08-11', summary: 'intro call', sourceRef: 'team.csv#2' },
    { id: 'int_2', kind: 'meeting', occurredAt: '2026-07-02', summary: 'first contact', sourceRef: 'team.csv#9' },
  ],
};

test('headline reads as role at firm, taken from the relationship graph', () => {
  const card = project(SARAH, NOW);
  assert.equal(card.headline, 'Partner at Conviction');
  // the firm came from `related`, which has an id behind it — not a loose fact
  assert.equal(card.related[0].id, 'ent_2');
});

test('status says when contact last happened, in plain words', () => {
  const card = project(SARAH, NOW);
  assert.equal(card.status, 'Last contact last week'); // 9 days
});

test('a future interaction becomes an upcoming status, not a stale one', () => {
  const withNext = {
    ...SARAH,
    interactions: [
      ...SARAH.interactions,
      { id: 'int_3', kind: 'meeting', occurredAt: '2026-09-01', summary: 'follow-up', sourceRef: 'team.csv#12' },
    ],
  };
  assert.equal(project(withNext, NOW).status, 'Next: 2026-09-01');
});

test('no interactions is stated plainly, never blank', () => {
  const cold = { ...SARAH, interactions: [] };
  assert.equal(project(cold, NOW).status, 'No recorded contact');
});

test('every displayed field carries the source row it came from', () => {
  const card = project(SARAH, NOW);
  assert.ok(card.fields.length > 0);
  for (const f of card.fields) {
    assert.ok(f.source, `field ${f.label} lost its provenance`);
  }
  for (const e of card.timeline) {
    assert.ok(e.source, `event ${e.date} lost its provenance`);
  }
  // and the card lists the distinct sources behind it, sorted for stability
  assert.deepEqual(card.provenance.sources, ['investors.csv#2', 'team.csv#2', 'team.csv#9']);
  assert.equal(card.provenance.records, 4 + 1 + 2);
  assert.equal(card.provenance.entityVersion, 3);
});

test('facts spent on the headline are not repeated in the field list', () => {
  const card = project(SARAH, NOW);
  const labels = card.fields.map(f => f.label);
  assert.ok(!labels.includes('Role'), 'role is already in the headline');
  assert.ok(labels.includes('Check size'), 'unrecognized columns still surface');
  assert.ok(labels.includes('Warm'));
});

test('timeline is newest-first and does not depend on the query order', () => {
  const shuffled = { ...SARAH, interactions: [...SARAH.interactions].reverse() };
  const card = project(shuffled, NOW);
  assert.equal(card.timeline[0].date, '2026-08-11');
  assert.equal(card.timeline[1].date, '2026-07-02');
});

test('a long history is truncated and says how much it is hiding', () => {
  const many = {
    ...SARAH,
    interactions: Array.from({ length: 9 }, (_, i) => ({
      id: `int_${i}`,
      kind: 'meeting',
      occurredAt: `2026-0${(i % 8) + 1}-0${(i % 9) + 1}`,
      summary: `meeting ${i}`,
      sourceRef: `team.csv#${i}`,
    })),
  };
  const card = project(many, NOW);
  assert.equal(card.timeline.length, 5);
  assert.equal(card.moreEvents, 4, 'the card must not pretend it showed everything');
});

test('rebuild equivalence: same records and clock produce an identical card', () => {
  const a = project(SARAH, NOW);
  const b = project(structuredClone(SARAH), NOW);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'key order must be stable too');
});

test('the projector is pure — it does not mutate the records handed to it', () => {
  const input = structuredClone(SARAH);
  project(input, NOW);
  assert.deepEqual(input, SARAH);
});

test('a duplicated fact key cannot make the card flicker between rebuilds', () => {
  const dup = {
    ...SARAH,
    facts: [...SARAH.facts, { key: 'stage', value: 'Series A', sourceRef: 'other.csv#1' }],
  };
  assert.deepEqual(project(dup, NOW), project(dup, NOW));
});

test('a company card falls back to its own focus when it has no role', () => {
  const company = {
    id: 'ent_2',
    kind: 'company',
    name: 'Conviction',
    status: 'active',
    version: 1,
    updatedAt: '2026-08-20T10:00:00.000Z',
    aliases: ['Conviction'],
    facts: [{ key: 'focus', value: 'AI infrastructure', sourceRef: 'vcs.csv#2' }],
    related: [{ id: 'ent_1', name: 'Sarah Guo', kind: 'person', relation: 'works_at', direction: 'in' }],
    interactions: [],
  };
  const card = project(company, NOW);
  assert.equal(card.headline, 'AI infrastructure');
  assert.equal(card.related[0].name, 'Sarah Guo');
});

test('aliases exclude the canonical name so "also known as" is never redundant', () => {
  const aka = { ...SARAH, aliases: ['Sarah Guo', 'S. Guo'] };
  assert.deepEqual(project(aka, NOW).aliases, ['S. Guo']);
});

test('recency wording is coarse on purpose', () => {
  assert.equal(describeGap(0), 'today');
  assert.equal(describeGap(1), 'yesterday');
  assert.equal(describeGap(3), '3 days ago');
  assert.equal(describeGap(9), 'last week');
  assert.equal(describeGap(21), '3 weeks ago');
  assert.equal(describeGap(200), '7 months ago');
  assert.equal(describeGap(-2), 'upcoming');
});

test('an unparseable date does not throw, it just has no gap', () => {
  assert.equal(daysBetween('not-a-date', NOW), null);
  const bad = {
    ...SARAH,
    interactions: [{ id: 'x', kind: 'meeting', occurredAt: 'someday', summary: 's', sourceRef: 'a#1' }],
  };
  assert.doesNotThrow(() => project(bad, NOW));
});

test('the projection version is stamped so a stale stored card is detectable', () => {
  assert.equal(project(SARAH, NOW).projectionVersion, PROJECTION_VERSION);
  assert.equal(project(SARAH, NOW).refreshedAt, NOW);
});
