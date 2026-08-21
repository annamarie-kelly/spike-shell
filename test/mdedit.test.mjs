// Phase 0 of the visual markdown editor: prove the source mapping before any
// editing UI exists. See docs/plans/wysiwyg-edit-pane.md §6.
//
// Three families:
//  1. invariants over the repo's OWN markdown, including the editable-leaf
//     coverage number that gates Phase 1
//  2. patch invariants — every byte outside the patched span is unchanged, and
//     every rejection case actually rejects
//  3. the offset mapper across wikilink/embed substitutions
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';
import {
  mdPreprocessMapped, makeMapper, editableLeaves, minimalPatch, splice,
  signature, verifyPatch, patchLeaves,
} from '../dist/web/mdedit.js';

const lex = (s) => marked.lexer(s);

// The hooks app.ts supplies, in their simplest form: enough to reproduce the
// SHAPE of the substitutions (a link, an html span) without a file index.
const HOOKS = {
  embed: (t, a, alias) => `<span class="embed" data-embed-path="${encodeURIComponent(t)}"></span>`,
  link: (t, a, alias) => `[${(alias || t).trim()}](wikilink:${encodeURIComponent(t.trim())})`,
};

const pre = (body) => mdPreprocessMapped(body, HOOKS);
// frontmatter split, mirroring app.ts's parseFrontmatter
function splitFm(text) {
  const m = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  return m ? { body: text.slice(m[0].length), base: m[0].length } : { body: text, base: 0 };
}
function leavesOf(text) {
  const { body, base } = splitFm(text);
  const pp = pre(body);
  return { leaves: editableLeaves(lex(pp.out), pp.out, pp.edits, base), pp, body, base };
}

// ── 1. invariants ─────────────────────────────────────────────────────────

test('marked top-level raws reconstruct the source exactly', () => {
  // The premise of the whole offset walk. `space` tokens carry their newlines,
  // so concatenation is lossless.
  for (const src of [
    'Hi there\n',
    '# Head\n\nBody *em* and `code`\n\n- one\n- two\n',
    'a\n\n\n\nb\n',
    '> quoted\n\n```js\nlet x = 1\n```\n',
    '| a | b |\n|---|---|\n| 1 | 2 |\n',
    'Setext\n======\n\ntext\n',
  ]) {
    assert.equal(lex(src).map((t) => t.raw).join(''), src, JSON.stringify(src));
  }
});

test('every leaf span is byte-exact against the source (rule 3)', () => {
  for (const file of repoMarkdown()) {
    const text = fs.readFileSync(file, 'utf8');
    const { leaves } = leavesOf(text);
    for (const lf of leaves) {
      assert.equal(
        text.slice(lf.start, lf.end), lf.text,
        `${path.basename(file)} @ ${lf.start}: span does not match its text`,
      );
    }
  }
});

test('leaves never overlap and are in document order', () => {
  for (const file of repoMarkdown()) {
    const { leaves } = leavesOf(fs.readFileSync(file, 'utf8'));
    for (let i = 1; i < leaves.length; i++) {
      assert.ok(
        leaves[i].start >= leaves[i - 1].end,
        `${path.basename(file)}: leaf ${i} overlaps its predecessor`,
      );
    }
  }
});

test('no leaf contains an entity reference (rule 4)', () => {
  for (const file of repoMarkdown()) {
    for (const lf of leavesOf(fs.readFileSync(file, 'utf8')).leaves) {
      assert.ok(!/&[a-zA-Z#][a-zA-Z0-9]*;/.test(lf.text), `${path.basename(file)}: ${lf.text}`);
    }
  }
});

test('leaves are found in the constructs we claim to support', () => {
  const src = '# Title\n\nA para with *em* text.\n\n- item one\n- item **two** tail\n\n## Sub\n';
  const texts = leavesOf(src).leaves.map((l) => l.text);
  assert.ok(texts.includes('Title'), 'heading');
  assert.ok(texts.includes('A para with '), 'paragraph head');
  assert.ok(texts.includes(' text.'), 'paragraph tail');
  assert.ok(texts.includes('item one'), 'list item');
  assert.ok(texts.includes(' tail'), 'list item tail');
  assert.ok(texts.includes('Sub'), 'second heading');
  // Text INSIDE emphasis is editable too: the delimiters sit outside the child's
  // span, so patching it cannot touch a marker. Without this, inline formatting
  // left holes in a sentence — 40% of real prose blocks contain one.
  assert.ok(texts.includes('em'), 'text inside em should be editable');
  assert.ok(texts.includes('two'), 'text inside strong should be editable');
});

test('emphasis inner spans point past the delimiters', () => {
  for (const [src, word] of [
    ['A **bold** word\n', 'bold'],
    ['A *em* word\n', 'em'],
    ['A __bold__ word\n', 'bold'],
    ['A _em_ word\n', 'em'],
    ['A ~~struck~~ word\n', 'struck'],
    ['**leading** bold\n', 'leading'],
    ['trailing **bold**\n', 'bold'],
    ['**a** and **b**\n', 'b'],
  ]) {
    const lf = leavesOf(src).leaves.find((l) => l.text === word);
    assert.ok(lf, `${JSON.stringify(src)}: expected an editable leaf for ${word}`);
    // the span must contain the word and NOT any delimiter character
    assert.equal(src.slice(lf.start, lf.end), word, JSON.stringify(src));
    assert.ok(!/[*_~]/.test(src.slice(lf.start, lf.end)), 'span must exclude markers');
  }
});

test('links and code spans stay read-only', () => {
  // a link's child text is its label, followed by `](url)` — editing it reads as
  // an attempt to change the target, so it is deliberately excluded
  const linkLeaves = leavesOf('See [the label](http://x) here\n').leaves.map((l) => l.text);
  assert.ok(!linkLeaves.includes('the label'), 'link label must be read-only');
  assert.ok(linkLeaves.includes('See '), 'prose before a link is still editable');
  const codeLeaves = leavesOf('Use `the_code` now\n').leaves.map((l) => l.text);
  assert.ok(!codeLeaves.includes('the_code'), 'code span must be read-only');
});

test('nested emphasis does not double-count or mis-map', () => {
  const src = 'A ***both*** word\n';
  for (const lf of leavesOf(src).leaves) {
    assert.equal(src.slice(lf.start, lf.end), lf.text);
    assert.ok(!/[*_~]/.test(lf.text), `leaf must not contain markers: ${JSON.stringify(lf.text)}`);
  }
});

test('a heading whose text starts with # gets the right offset', () => {
  // the case that kills naive indexOf: prefix `## ` then content `# Head`
  const src = '## # Head\n';
  const [lf] = leavesOf(src).leaves;
  assert.equal(lf.text, '# Head');
  assert.equal(lf.start, 3, 'must point past the ATX prefix, not at offset 0');
  assert.equal(src.slice(lf.start, lf.end), '# Head');
});

test('constructs we do not model yield no leaves', () => {
  // blockquote: marked strips the `> ` from inner raws, so offsets are not
  // derivable — it must produce nothing rather than something wrong.
  assert.equal(leavesOf('> quoted text here\n').leaves.length, 0, 'blockquote');
  assert.equal(leavesOf('```\nplain code\n```\n').leaves.length, 0, 'fenced code');
  assert.equal(leavesOf('| a | b |\n|---|---|\n| 1 | 2 |\n').leaves.length, 0, 'table');
  assert.equal(leavesOf('<div>raw html</div>\n').leaves.length, 0, 'html block');
  // and a blockquote must not corrupt the offsets of what follows it
  const after = leavesOf('> quoted\n\nAfter the quote\n').leaves;
  assert.equal(after.length, 1);
  assert.equal(after[0].text, 'After the quote');
  assert.equal('> quoted\n\nAfter the quote\n'.slice(after[0].start, after[0].end), 'After the quote');
});

test('task list items keep their checkbox out of the editable span', () => {
  const src = '- [ ] do a thing\n- [x] done thing\n';
  const leaves = leavesOf(src).leaves;
  assert.deepEqual(leaves.map((l) => l.text), ['do a thing', 'done thing']);
  for (const lf of leaves) assert.equal(src.slice(lf.start, lf.end), lf.text);
});

test('frontmatter offsets are absolute file positions', () => {
  const src = '---\ntitle: x\n---\n\nBody text\n';
  const [lf] = leavesOf(src).leaves;
  assert.equal(lf.text, 'Body text');
  assert.equal(src.slice(lf.start, lf.end), 'Body text');
});

test('COVERAGE: editable-leaf share across the repo (Phase 1 gate)', () => {
  let files = 0, blocks = 0, editable = 0, chars = 0, editableChars = 0;
  for (const file of repoMarkdown()) {
    const text = fs.readFileSync(file, 'utf8');
    const { leaves, pp, body } = leavesOf(text);
    files++;
    // denominator: every inline text token, editable or not
    const all = [];
    const walk = (ts) => {
      for (const t of ts) {
        if (t.type === 'text' && !t.tokens) all.push(t);
        if (t.items) walk(t.items);
        if (t.tokens) walk(t.tokens);
      }
    };
    walk(lex(pp.out));
    blocks += all.length;
    editable += leaves.length;
    chars += all.reduce((n, t) => n + t.raw.length, 0);
    editableChars += leaves.reduce((n, l) => n + l.text.length, 0);
    void body;
  }
  const byCount = blocks ? (editable / blocks) * 100 : 0;
  const byChars = chars ? (editableChars / chars) * 100 : 0;
  console.log(
    `\n  coverage: ${files} files, ${editable}/${blocks} text tokens editable `
    + `(${byCount.toFixed(1)}%), ${editableChars}/${chars} chars (${byChars.toFixed(1)}%)\n`,
  );
  // Not a strict threshold — the number is the decision input. This only fails
  // if the walk is essentially not working.
  assert.ok(byChars > 25, `editable coverage ${byChars.toFixed(1)}% is too low to build on`);
});

// ── 2. patch invariants ───────────────────────────────────────────────────

test('minimalPatch touches only what changed', () => {
  assert.equal(minimalPatch('same', 'same'), null);
  const old = 'the quick brown fox';
  const p = minimalPatch(old, 'the quiet brown fox');
  // 'the qui' is the common prefix, 'k brown fox' / 't brown fox' diverge at
  // index 7, and ' brown fox' is the common suffix
  assert.deepEqual(p, { at: 7, delLen: 2, ins: 'et' });
  assert.equal(old.slice(0, p.at) + p.ins + old.slice(p.at + p.delLen), 'the quiet brown fox');
  assert.deepEqual(minimalPatch('abc', 'abXc'), { at: 2, delLen: 0, ins: 'X' });
  assert.deepEqual(minimalPatch('abXc', 'abc'), { at: 2, delLen: 1, ins: '' });
});

test('minimalPatch preserves newlines outside the change', () => {
  // the hard-wrapped-paragraph case: reword one word, keep the wrapping
  const old = 'Markdown stays authoritative. A visual edit produces the\nsmallest possible patch';
  const next = 'Markdown stays canonical. A visual edit produces the\nsmallest possible patch';
  const p = minimalPatch(old, next);
  const applied = old.slice(0, p.at) + p.ins + old.slice(p.at + p.delLen);
  assert.equal(applied, next);
  assert.ok(!p.ins.includes('\n'), 'the inserted text must not carry the wrapping');
  assert.ok(p.delLen < 20, `patch should be small, was ${p.delLen}`);
});

test('a real edit changes only the patched span', () => {
  const src = '# Title\n\nThe qiuck brown fox. See [[Other Note]] and `code`.\n\nTail *em* here.\n';
  const { leaves, base } = leavesOf(src);
  const leaf = leaves.find((l) => l.text.includes('qiuck'));
  assert.ok(leaf, 'expected an editable leaf containing the typo');
  const p = minimalPatch(leaf.text, leaf.text.replace('qiuck', 'quick'));
  const start = leaf.start + p.at;
  const out = splice(src, start, start + p.delLen, p.ins);
  assert.equal(out, src.replace('qiuck', 'quick'));
  // everything outside the patch is byte-identical
  assert.equal(out.slice(0, start), src.slice(0, start));
  assert.equal(out.slice(start + p.ins.length), src.slice(start + p.delLen));
  // the wikilink survived untouched
  assert.ok(out.includes('[[Other Note]]'));
  void base;
});

// ── multi-run commits (a whole block edited at once) ──────────────────────

test('patchLeaves patches several runs in one pass', () => {
  // the real shape from the vault: prose, bold, prose — all three edited together
  const src = 'This vault is **personal** (not team-facing). The team layer lives on.\n';
  const { leaves } = leavesOf(src);
  const pick = (t) => leaves.find((l) => l.text === t);
  const a = pick('This vault is '), b = pick('personal'),
    c = pick(' (not team-facing). The team layer lives on.');
  assert.ok(a && b && c, 'expected three mapped runs around the bold span');
  const res = patchLeaves(src, [
    { leaf: a, next: 'This garden is ' },
    { leaf: b, next: 'private' },
    { leaf: c, next: ' (not team-facing). The team layer lives in Notion.' },
  ]);
  assert.equal(res.reason, undefined);
  assert.equal(
    res.out,
    'This garden is **private** (not team-facing). The team layer lives in Notion.\n',
  );
  // the delimiters were never rewritten
  assert.equal((res.out.match(/\*\*/g) || []).length, 2);
  assert.deepEqual(res.indices.slice().sort(), [a.index, b.index, c.index].sort());
});

test('patchLeaves applies right-to-left so spans do not shift', () => {
  const src = 'alpha **beta** gamma\n';
  const { leaves } = leavesOf(src);
  const first = leaves.find((l) => l.text === 'alpha ');
  const last = leaves.find((l) => l.text === ' gamma');
  // lengthen the FIRST run a lot; the last run's patch must still land correctly
  const res = patchLeaves(src, [
    { leaf: first, next: 'alpha plus a much longer opening ' },
    { leaf: last, next: ' gamma extended' },
  ]);
  assert.equal(res.out, 'alpha plus a much longer opening **beta** gamma extended\n');
});

test('patchLeaves ignores unchanged runs', () => {
  const src = 'one **two** three\n';
  const { leaves } = leavesOf(src);
  const res = patchLeaves(src, leaves.map((l) => ({ leaf: l, next: l.text })));
  assert.equal(res.out, src);
  assert.deepEqual(res.indices, []);
});

test('patchLeaves refuses when any run is stale', () => {
  const src = 'one **two** three\n';
  const { leaves } = leavesOf(src);
  const good = leaves.find((l) => l.text === 'one ');
  const stale = { ...leaves.find((l) => l.text === ' three'), text: 'NOT WHAT IS THERE' };
  const res = patchLeaves(src, [
    { leaf: good, next: 'ONE ' },
    { leaf: stale, next: 'whatever' },
  ]);
  // all-or-nothing: the valid edit must NOT land if a sibling is stale
  assert.match(res.reason, /changed underneath/);
  assert.equal(res.out, src);
});

test('a multi-run commit verifies as one unit', () => {
  const src = 'This vault is **personal** (not team-facing).\n';
  const { leaves } = leavesOf(src);
  const a = leaves.find((l) => l.text === 'This vault is ');
  const b = leaves.find((l) => l.text === 'personal');
  const res = patchLeaves(src, [
    { leaf: a, next: 'This garden is ' },
    { leaf: b, next: 'private' },
  ]);
  const before = lex(pre(src).out);
  const v = verifyPatch(before, pre(res.out).out, res.indices,
    ['This garden is ', 'private'], lex);
  assert.equal(v.ok, true, v.reason);
});

test('a multi-run commit still catches structural damage', () => {
  const src = 'This vault is **personal** here.\n';
  const { leaves } = leavesOf(src);
  const a = leaves.find((l) => l.text === 'This vault is ');
  const b = leaves.find((l) => l.text === 'personal');
  // the second edit closes the bold early and reopens it: same rendered words,
  // materially different markdown
  const res = patchLeaves(src, [
    { leaf: a, next: 'This vault is ' },
    { leaf: b, next: 'per** **sonal' },
  ]);
  const before = lex(pre(src).out);
  const v = verifyPatch(before, pre(res.out).out, res.indices, ['per** **sonal'], lex);
  assert.equal(v.ok, false, 'delimiter surgery inside a run must be refused');
});

test('signature accepts a SET of changed leaves', () => {
  const a = lex('one two three\n');
  // leaves 0 only vs leaves 0 and 1: the set is what may differ
  assert.equal(signature(a, [0]), signature(lex('CHANGED two three\n'), [0]));
  assert.notEqual(signature(a, [0]), signature(lex('one\n\ntwo three\n'), [0]));
});

test('verifyPatch accepts a plain reword', () => {
  const body = 'The qiuck brown fox jumps.\n';
  const before = lex(pre(body).out);
  const after = body.replace('qiuck', 'quick');
  assert.deepEqual(verifyPatch(before, pre(after).out, 0, 'quick', lex), { ok: true });
});

test('verifyPatch accepts a reword that changes the leaf length', () => {
  const body = 'A para with *em* inside and a tail.\n';
  const before = lex(pre(body).out);
  // leaf 0 is 'A para with ', leaf 2 is ' inside and a tail.'
  const after = 'A para with much more text here *em* inside and a tail.\n';
  assert.deepEqual(verifyPatch(before, pre(after).out, 0, 'A para with much more text here ', lex),
    { ok: true });
});

test('verifyPatch rejects structural damage', () => {
  const body = 'Some plain words here.\n';
  const before = lex(pre(body).out);
  const cases = [
    ['emphasis created', 'Some *plain* words here.\n', 'Some *plain* words here.'],
    ['a link created', 'Some [plain](http://x) words here.\n', '[plain](http://x)'],
    ['code span created', 'Some `plain` words here.\n', '`plain`'],
    ['block split', 'Some plain\n\nwords here.\n', 'Some plain\n\nwords'],
    ['promoted to heading', '# Some plain words here.\n', '# Some plain words here.'],
    ['an entity', 'Some &amp; words here.\n', 'Some &amp; words here.'],
  ];
  for (const [label, afterBody, next] of cases) {
    const r = verifyPatch(before, pre(afterBody).out, 0, next, lex);
    assert.equal(r.ok, false, `${label} must be rejected`);
    assert.ok(r.reason, `${label} needs a reason`);
  }
});

test('verifyPatch accepts markdown-special characters that form no construct', () => {
  // A lone `*` is literal text in markdown, so the file still round-trips to
  // exactly what the user sees. Rejecting it would be false caution — the rule
  // is "did the token stream change", not "does it contain punctuation".
  const body = 'Some plain words here.\n';
  const before = lex(pre(body).out);
  for (const after of [
    'Some *plain words here.\n',      // unpaired emphasis marker
    'Some 2 * 3 words here.\n',       // arithmetic
    'Some plain words here (x_y).\n', // underscore inside a word
    'Some plain & simple words.\n',   // bare ampersand: escapes on output, decodes back
  ]) {
    const r = verifyPatch(before, pre(after).out, 0, after.trim(), lex);
    assert.equal(r.ok, true, `${after.trim()} should be accepted, got: ${r.reason}`);
  }
});

test('verifyPatch rejects a second leaf changing (only one span may move)', () => {
  const body = 'One para here.\n\nTwo para there.\n';
  const before = lex(pre(body).out);
  // both leaves change, and to the SAME length — a length-only signature would
  // wave this through, which is why non-target leaves are pinned byte-for-byte
  const after = 'One para HERE.\n\nTwo para THERE.\n';
  assert.equal(verifyPatch(before, pre(after).out, 0, 'One para HERE.', lex).ok, false);
});

test('signature pins every leaf but the one under edit', () => {
  // the skipped leaf may differ freely
  assert.equal(signature(lex('abc def\n'), 0), signature(lex('totally other\n'), 0));
  // any OTHER leaf differing shows up, even at identical length
  assert.notEqual(signature(lex('one\n\ntwo\n'), 0), signature(lex('one\n\nTWO\n'), 0));
  // structure differing shows up
  assert.notEqual(signature(lex('abc def\n'), 0), signature(lex('abc *def*\n'), 0));
  // and with no leaf skipped, text is pinned
  assert.notEqual(signature(lex('abc\n')), signature(lex('abd\n')));
});

// ── 3. the offset mapper ──────────────────────────────────────────────────

test('mdPreprocessMapped matches the two-pass original it replaces', () => {
  // the exact behaviour of app.ts's original mdPreprocess, reproduced here
  const twoPass = (body) => body
    .replace(/!\[\[([^\]|#]+)(#[^\]|]+)?(?:\|([^\]]+))?\]\]/g,
      (m, t, a, alias) => HOOKS.embed(t, a, alias))
    .replace(/\[\[([^\]|#]+)(#[^\]|]+)?(?:\|([^\]]+))?\]\]/g,
      (m, t, a, alias) => HOOKS.link(t, a, alias));
  const cases = [
    'plain text\n',
    'See [[Target]] here\n',
    'See [[Target|Alias]] here\n',
    'An ![[image.png]] embed\n',
    'Both ![[a]] and [[b]] together\n',
    '[[a]][[b]]\n',
    'brackets [not a link] and [[real]]\n',
  ];
  for (const c of cases) assert.equal(pre(c).out, twoPass(c), c);
  for (const file of repoMarkdown()) {
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(pre(text).out, twoPass(text), path.basename(file));
  }
});

test('mapper maps clean offsets back and refuses substituted ones', () => {
  const body = 'AB [[Target]] CD\n';
  const { out, edits } = pre(body);
  const map = makeMapper(edits);
  // 'AB ' is before the substitution: identity
  assert.equal(map.toOriginal(0), 0);
  assert.equal(map.toOriginal(2), 2);
  // inside the replacement: no original bytes to point at
  assert.equal(map.toOriginal(4), null);
  assert.ok(!map.spanClean(3, 6));
  // after it: the CD run maps back to its real position
  const pAfter = out.indexOf(' CD');
  assert.equal(map.toOriginal(pAfter), body.indexOf(' CD'));
  assert.ok(map.spanClean(pAfter, pAfter + 3));
});

test('a leaf adjacent to a wikilink still maps to the right file offset', () => {
  const src = 'Before [[Link]] after the link\n';
  const { leaves } = leavesOf(src);
  const tail = leaves.find((l) => l.text.includes('after'));
  assert.ok(tail, 'the run after a wikilink should be editable');
  assert.equal(src.slice(tail.start, tail.end), tail.text);
  const head = leaves.find((l) => l.text.startsWith('Before'));
  assert.ok(head);
  assert.equal(src.slice(head.start, head.end), head.text);
});

test('multiple substitutions accumulate offsets correctly', () => {
  const src = 'a [[one]] b [[two]] c ![[three.png]] d tail\n';
  const { leaves } = leavesOf(src);
  assert.ok(leaves.length >= 2);
  for (const lf of leaves) assert.equal(src.slice(lf.start, lf.end), lf.text);
  const tail = leaves.find((l) => l.text.includes('tail'));
  assert.ok(tail, 'the run after three substitutions should still be editable');
});

// every .md in the repo, excluding vendored/generated trees
function repoMarkdown() {
  const root = path.resolve(import.meta.dirname, '..');
  const out = [];
  const skip = new Set(['node_modules', 'dist', 'dist-web', 'target', '.git', 'bin']);
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || skip.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.md$/i.test(e.name)) out.push(p);
    }
  })(root);
  return out;
}
