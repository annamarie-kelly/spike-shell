// The segmenter is where the verbatim guarantee actually lives. Everything downstream
// assumes two things about it: that cutting a source into spans loses nothing, and that
// a span's recorded offsets address exactly the bytes it claims. If either breaks, the
// harness still reports VERBATIM while placing text that isn't in the source - a silent
// false green, which is the worst failure this system can have.
//
// So both are property tests, not example tests, and they run over deliberately hostile
// text: nested quotes, contractions, speaker attributions, list markers, bold field
// labels, CJK, emoji, and unpunctuated blobs longer than the span cap.
//
// (npm test builds dist/ first.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSpanTable,
  isLossless,
  spanResolves,
  renderEvidenceManifest,
  MAX_SPAN_CHARS,
} from '../dist/attest/segmenter.js';

const ref = (id, detail) => ({ id, label: id, detail });

// Every one of these has bitten a quote pipeline somewhere.
const HOSTILE = [
  'Plain prose. Two sentences here.',
  'He called it "the category leader" and moved on.',
  '“Curly quoted opener,” she said. Then more.',
  "'we don't see a moat' was the verdict.",
  "Karbon's pricing didn't move. It won't next year either.",
  'Speaker Name: we lost the deal on integrations.',
  '- a bullet line\n* another bullet\n+ a third',
  '1. ordered item\n2) second form',
  '**Overview**: Restaurant performance management platform.',
  '- **Financials**: $4.8M ARR, up 30%.',
  'Revenue hit $1,200,000 in 2024. Margin was 62.5%.',
  'A line with no terminator',
  'Trailing whitespace   \n\n\nand blank lines',
  'Mid-sentence figure 2024. and then more text',
  '日本語のテキストです。これは二番目の文です。',
  'emoji 🎉 in the middle of a sentence. And after.',
  'x'.repeat(MAX_SPAN_CHARS * 3), // unsplittable blob, no whitespace at all
  ('word '.repeat(MAX_SPAN_CHARS)).trim(), // long but splittable
  '',
  '   ',
  '...',
  '"',
];

test('losslessness: raw tiles reconstruct every source byte-for-byte', () => {
  for (const detail of HOSTILE) {
    assert.equal(isLossless(detail), true, `lost bytes on: ${JSON.stringify(detail.slice(0, 60))}`);
  }
});

test('losslessness holds on random text (fuzz)', () => {
  // Seeded LCG - a failing case must be reproducible, so no Math.random().
  let seed = 0x2545f491;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const alphabet = [...'abc XYZ .!?\n\t"\'“”’*-+1234.', '日', '🎉'];
  for (let i = 0; i < 400; i++) {
    const len = Math.floor(rnd() * 500);
    let s = '';
    for (let j = 0; j < len; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    assert.equal(isLossless(s), true, `lost bytes on fuzz case ${i}: ${JSON.stringify(s.slice(0, 80))}`);
  }
});

test('every span addresses exactly the bytes it claims', () => {
  for (const detail of HOSTILE) {
    const { table } = buildSpanTable([ref('s', detail)]);
    for (const span of table.values()) {
      assert.equal(
        spanResolves(span, detail),
        true,
        `offset drift in ${span.span_id}: recorded ${JSON.stringify(span.text)} but source has ${JSON.stringify(detail.slice(span.start, span.end))}`,
      );
    }
  }
});

test('every span text is a verbatim substring of its source', () => {
  for (const detail of HOSTILE) {
    const { table } = buildSpanTable([ref('s', detail)]);
    for (const span of table.values()) {
      assert.ok(detail.includes(span.text), `${span.span_id} is not a substring of its source`);
    }
  }
});

test('determinism: same input yields identical ids, text, and offsets', () => {
  const refs = HOSTILE.map((d, i) => ref(`src${i}`, d));
  const a = buildSpanTable(refs);
  const b = buildSpanTable(refs);
  assert.deepEqual(a.order, b.order);
  for (const id of a.order) {
    assert.deepEqual(a.table.get(id), b.table.get(id), `span ${id} differs between runs`);
  }
});

test('a speaker attribution survives - stripping it would misattribute the quote', () => {
  const detail = 'Speaker Name: we lost the deal on integrations.';
  const { table, order } = buildSpanTable([ref('s', detail)]);
  const text = table.get(order[0]).text;
  assert.ok(text.startsWith('Speaker Name:'), `speaker was stripped: ${JSON.stringify(text)}`);
});

test('a bold field label is stripped, but only at a line start', () => {
  const { table, order } = buildSpanTable([ref('s', '**Overview**: Restaurant platform.')]);
  assert.equal(table.get(order[0]).text, 'Restaurant platform.');

  // Same label mid-line is content, not scaffolding, and must survive.
  const mid = buildSpanTable([ref('s', 'It said **Overview**: nothing useful.')]);
  assert.ok(mid.table.get(mid.order[0]).text.includes('**Overview**:'));
});

test('a list marker is stripped, but a mid-sentence figure is not', () => {
  const bullets = buildSpanTable([ref('s', '- first point\n* second point')]);
  const texts = bullets.order.map((id) => bullets.table.get(id).text);
  assert.deepEqual(texts, ['first point', 'second point']);

  // "2024." is split onto its own tile by the sentence tiler. It looks exactly like an
  // ordered-list marker, and stripping it would delete real source content.
  const figure = buildSpanTable([ref('s', 'Mid-sentence figure 2024. and then more')]);
  const joined = figure.order.map((id) => figure.table.get(id).text).join(' ');
  assert.ok(joined.includes('2024'), `the figure was eaten: ${joined}`);
});

test('a balanced quote pair is stripped; a lone nested quote is kept', () => {
  const wrapped = buildSpanTable([ref('s', '"the whole line is quoted"')]);
  assert.equal(wrapped.table.get(wrapped.order[0]).text, 'the whole line is quoted');

  const nested = buildSpanTable([ref('s', 'He called it "the category leader" and moved on.')]);
  assert.ok(nested.table.get(nested.order[0]).text.includes('"the category leader"'));
});

test('punctuation-only tiles are never quotable', () => {
  const { table } = buildSpanTable([ref('s', '... !!! ??? ---')]);
  for (const span of table.values()) {
    assert.match(span.text, /[\p{L}\p{N}]/u, `punctuation-only span became quotable: ${span.text}`);
  }
});

test('spans stay under the cap when the text is splittable', () => {
  const detail = ('word '.repeat(400)).trim();
  const { table } = buildSpanTable([ref('s', detail)]);
  for (const span of table.values()) {
    assert.ok(span.text.length <= MAX_SPAN_CHARS, `span ran to ${span.text.length} chars`);
  }
});

test('a soft-wrapped sentence stays one span', () => {
  // Hard-wrapped prose, the shape of any markdown file someone wrapped at 80 columns.
  // Cutting at every newline splits this into fragments and the model can only ever
  // quote half a thought.
  const detail = 'Passed because the pitch led with a data moat the\nproduct has not earned yet.';
  const { table, order } = buildSpanTable([ref('s', detail)]);
  assert.equal(order.length, 1, `soft wrap was treated as a boundary: ${order.length} spans`);
  assert.ok(table.get(order[0]).text.includes('data moat the\nproduct has not earned'));
});

test('a hard break is still a boundary', () => {
  const cases = {
    'paragraph break': 'First thought here\n\nSecond thought here',
    'sentence end': 'A complete sentence.\nAnother one follows',
    'next line is a bullet': 'An intro line\n- a bullet item',
    'next line is a heading': 'Some prose\n# A heading',
    'next line is a key': 'created: 2026-06-20\ntype: episode',
    'line ends in a colon': 'What happened:\nthe deal fell through',
  };
  for (const [name, detail] of Object.entries(cases)) {
    const { order } = buildSpanTable([ref('s', detail)]);
    assert.ok(order.length >= 2, `${name}: expected a split, got ${order.length} span(s)`);
  }
});

test('soft-wrap handling does not break losslessness or offsets', () => {
  const detail =
    'created: 2026-06-20\ntype: episode\n\n# Heading\n\nA wrapped sentence that runs\nacross two lines here.\n\n- a bullet\n- another bullet that also\n  wraps softly\n';
  assert.equal(isLossless(detail), true);
  const { table } = buildSpanTable([ref('s', detail)]);
  for (const span of table.values()) {
    assert.equal(spanResolves(span, detail), true, `offset drift in ${span.span_id}`);
  }
});

test('span ids are dense per source, so they are comparable across runs', () => {
  const { order } = buildSpanTable([ref('a', 'One. Two. Three.'), ref('b', 'Four. Five.')]);
  assert.deepEqual(order, ['a@s0', 'a@s1', 'a@s2', 'b@s0', 'b@s1']);
});

test('the manifest discloses what it omitted rather than truncating silently', () => {
  const refs = [ref('a', 'One. Two. Three. Four.')];
  const { table, order } = buildSpanTable(refs);
  const { manifest, includedIds, omitted } = renderEvidenceManifest(refs, table, order, 10);
  assert.ok(omitted > 0, 'expected a tiny budget to omit spans');
  assert.ok(includedIds.length < order.length);
  assert.match(manifest, /omitted/, 'the omission was not disclosed in the manifest');
});

test('the manifest tells the model to reference spans, never to retype them', () => {
  const refs = [ref('a', 'A quotable sentence.')];
  const { table, order } = buildSpanTable(refs);
  const { manifest } = renderEvidenceManifest(refs, table, order);
  assert.match(manifest, /\{\{q:a@s0\}\}/);
  assert.match(manifest, /do NOT retype/i);
});

test('a speaker name with a period or apostrophe still ends the turn', () => {
  // `[A-Za-z][\\w -]{0,30}:` rejects `Dr. Chen:` and `O'Brien:`, so a real turn boundary
  // reads as a soft wrap, two speakers merge into one span, and the report shows one
  // person saying both things. Byte-verbatim, and a misattribution.
  const cases = [
    "Alice Wong: we loved the product\nO'Brien: we hated the pricing",
    'Alice Wong: we loved the product\nDr. Chen: we hated the pricing',
    'Alice Wong: we loved it\nDana Okafor, CFO: we did not',
  ];
  for (const detail of cases) {
    const { table, order } = buildSpanTable([ref('s', detail)]);
    assert.ok(order.length >= 2, `speakers merged into one span: ${JSON.stringify(detail)}`);
    for (const span of table.values()) {
      assert.ok(
        !(span.text.includes('loved') && span.text.includes('hated')),
        `one span carries both speakers: ${JSON.stringify(span.text)}`,
      );
    }
  }
});

test('an abbreviation does not end a sentence', () => {
  // The sentence tiler cutting at `Dr.` attaches the start of the next speaker's name to
  // the previous turn.
  const { table, order } = buildSpanTable([ref('s', 'We spoke to Dr. Chen about pricing.')]);
  assert.equal(order.length, 1, 'cut mid-name at the title');
  assert.equal(table.get(order[0]).text, 'We spoke to Dr. Chen about pricing.');

  for (const abbr of ['Mr.', 'Inc.', 'vs.', 'etc.', 'approx.']) {
    const d = `Acme ${abbr} filed late today.`;
    const r = buildSpanTable([ref('s', d)]);
    assert.equal(r.order.length, 1, `cut at ${abbr}`);
  }
});

test('the manifest emits exactly one line per span', () => {
  // Span text can now contain newlines. A multi-line manifest entry leaves continuation
  // lines with no span id, so the model cannot tell where a span ends - and unattributed
  // lines of source text are what the manifest header tells it to paraphrase from.
  const detail = 'Acme lost the renewal because procurement pushed back on\nthe seat minimum.\n\nBravo renewed at a higher tier.';
  const refs = [ref('notes.md', detail)];
  const { table, order } = buildSpanTable(refs);
  const { manifest, includedIds } = renderEvidenceManifest(refs, table, order);

  const bullets = manifest.split('\n').filter((l) => l.startsWith('- {{q:'));
  assert.equal(bullets.length, includedIds.length, 'a span spilled across manifest lines');
  for (const b of bullets) assert.ok(!b.includes('\n'));

  // The placed bytes are still the original, newline and all.
  const multi = [...table.values()].find((s) => s.text.includes('\n'));
  assert.ok(multi, 'expected a span crossing the soft wrap');
  assert.equal(spanResolves(multi, detail), true);
});
