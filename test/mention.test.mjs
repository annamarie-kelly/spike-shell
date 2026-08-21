// The composer `@` menu rules. The DOM and the IPC live in app.ts; everything
// here is the part that decides what a person sees and what Spike believes they
// meant — which is the part worth pinning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeMentionItems,
  mentionInsert,
  trackMention,
  liveMentions,
  parseComposerToken,
  isCurrent,
} from '../dist/web/mention.js';

const sarah = { id: 'e1', name: 'Sarah Guo', kind: 'person', detail: 'Conviction', rank: 1, ambiguous: false };
const sam = { id: 'e2', name: 'Sam Altman', kind: 'person', detail: 'OpenAI', rank: 1, ambiguous: false };
const acme = { id: 'e3', name: 'Acme', kind: 'company', detail: '', rank: 0, ambiguous: false };

test('entities rank above files — a person beats a filename', () => {
  const items = mergeMentionItems([sarah], [{ rel: 'src/sarah-notes.md' }]);
  assert.equal(items[0].source, 'entity');
  assert.equal(items[0].label, 'Sarah Guo');
  assert.equal(items[1].source, 'file');
});

test('entity order follows the store rank, then name for stable ties', () => {
  const items = mergeMentionItems([sam, sarah, acme], []);
  assert.deepEqual(items.map(i => i.label), ['Acme', 'Sam Altman', 'Sarah Guo']);
});

test('the same query twice produces the same list', () => {
  const a = mergeMentionItems([sam, sarah, acme], [{ rel: 'a.md' }]);
  const b = mergeMentionItems([acme, sarah, sam], [{ rel: 'a.md' }]);
  assert.deepEqual(a, b);
});

test('ambiguous rows always carry something that tells them apart', () => {
  const m1 = { id: 'e4', name: 'Matrix Partners', kind: 'company', detail: '', rank: 2, ambiguous: true };
  const m2 = { id: 'e5', name: 'Matrix Labs', kind: 'company', detail: 'dev tools', rank: 2, ambiguous: true };
  const items = mergeMentionItems([m1, m2], []);
  assert.equal(items.length, 2, 'never collapsed into one');
  for (const it of items) assert.ok(it.desc, `${it.label} would be chosen blind`);
  const partners = items.find(i => i.label === 'Matrix Partners');
  assert.equal(partners.desc, 'company', 'falls back to the type when there is no detail');
});

test('the menu is bounded, and entities are what survive the cut', () => {
  const files = Array.from({ length: 20 }, (_, i) => ({ rel: `f${i}.md` }));
  const items = mergeMentionItems([sarah, acme], files, 8);
  assert.equal(items.length, 8);
  assert.equal(items.filter(i => i.source === 'entity').length, 2);
});

test('insertion keeps the display name and trails a space', () => {
  assert.equal(mentionInsert('Sarah Guo'), '@Sarah Guo ');
});

test('picking the same entity twice does not grow the tracked list', () => {
  let list = [];
  list = trackMention(list, { entityId: 'e1', text: '@Sarah Guo' });
  list = trackMention(list, { entityId: 'e1', text: '@Sarah Guo' });
  assert.equal(list.length, 1);
  list = trackMention(list, { entityId: 'e3', text: '@Acme' });
  assert.equal(list.length, 2);
});

test('deleting the words drops the mention — intent follows the visible text', () => {
  const list = [
    { entityId: 'e1', text: '@Sarah Guo' },
    { entityId: 'e3', text: '@Acme' },
  ];
  assert.deepEqual(
    liveMentions(list, 'draft a follow-up for @Sarah Guo about pricing').map(m => m.entityId),
    ['e1'],
    'only the mention still written down survives',
  );
  assert.deepEqual(liveMentions(list, 'never mind'), []);
});

test('@ opens only at a word boundary, so an email address does not trigger it', () => {
  assert.equal(parseComposerToken('write to amek775@gmail.com', 26), null);
  const tok = parseComposerToken('draft for @sar', 14);
  assert.deepEqual(tok, { kind: '@', query: 'sar', start: 10 });
});

test('the token is read at the caret, not at the end of the line', () => {
  const val = 'ask @ac about the thing';
  const tok = parseComposerToken(val, 7); // caret right after "@ac"
  assert.equal(tok.query, 'ac');
  assert.equal(tok.start, 4);
});

test('/ still parses, so the slash menu is untouched', () => {
  assert.deepEqual(parseComposerToken('/rev', 4), { kind: '/', query: 'rev', start: 0 });
});

test('a stale lookup reply is discarded rather than flickering the menu', () => {
  const now = { query: 'sar', seq: 4 };
  assert.equal(isCurrent({ query: 'sa', seq: 3 }, now), false, 'older keystroke');
  assert.equal(isCurrent({ query: 'sar', seq: 3 }, now), false, 'same text, older request');
  assert.equal(isCurrent({ query: 'sar', seq: 4 }, now), true);
});
