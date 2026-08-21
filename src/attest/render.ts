// Two projections of the same gated answer.
//
//   AUDIT   - span ids inline, next to the text they placed. This is the view you read
//             when you are checking the harness rather than the work: every quote sits
//             beside the exact address it came from.
//   DISPLAY - the reader's view. Span ids move to numbered footnotes so the prose is
//             readable, and the receipt states what was checked and what was skipped.
//
// Keeping both matters because they fail differently. A display-only harness is
// unauditable; an audit-only one is unreadable, and an unreadable receipt does not get
// read, which is the same as not having one.
//
// Neither projection alters placed bytes. Both render the strings the gate already
// judged, so the receipt describes exactly the document underneath it.

export type PlacedItem = {
  headline: string;
  body: string;
  evidence: string[];
};

export type Receipt = {
  quotes: string;
  shape: string;
  figures: string;
  /** figures with no citation, and figures whose cited source does not state them */
  uncited: string[];
  unsupported: string[];
  sources: Array<{ id: string; hash: string; cited: boolean; changed?: boolean }>;
  omitted: number;
  costUsd?: number;
  /**
   * False when no turn reported a dollar cost. Codex reports tokens only, and printing
   * `$0.0000` for it reads as free rather than as unreported - the difference matters in a
   * receipt whose whole job is not overstating what it knows.
   */
  costReported?: boolean;
  redos: number;
  /** when a check set declared `on_fail: annotate`, a failing run still renders */
  gated: boolean;
};

/** A blockquote that survives a span crossing a soft wrap in the source. */
function quoteBlock(text: string): string {
  return `> ${text.replace(/\n/g, '\n> ')}`;
}

/** Drop the renderer's private citation marks before anything reaches a reader. */
function unmark(text: string): string {
  return text.replace(/\uE000/g, '');
}

/**
 * `[id]` and `[id](url)` -> footnote marker, collecting the reference.
 *
 * The collected text must stay a valid markdown link. Concatenating id and `(url)` yields
 * `id(url)`, which renders as literal text - the reference stops being clickable at
 * exactly the moment the reader wants to follow it back to the source.
 */
function footnote(text: string, refs: string[]): string {
  return text.replace(/\uE000\[([^\]\n]+)\](?:\(([^)\n]*)\))?\uE000/g, (_m, id: string, url?: string) => {
    const ref = url ? `[${id}](${url})` : id;
    const existing = refs.indexOf(ref);
    const n = existing === -1 ? refs.push(ref) : existing + 1;
    return `[^${n}]`;
  });
}

function receiptLines(r: Receipt, footnotes: string[]): string[] {
  const L = ['---', '', '## Receipt', ''];
  L.push(`- **Quotes:** ${r.quotes}`);
  L.push(`- **Shape:** ${r.shape}`);
  L.push(`- **Figures:** ${r.figures}`);
  for (const u of r.uncited) L.push(`  - no citation: ${u}`);
  for (const u of r.unsupported) L.push(`  - source does not state it: ${u}`);

  const cited = r.sources.filter((s) => s.cited).length;
  L.push(`- **Sources read:** ${r.sources.length} (${cited} cited)`);
  if (r.omitted) L.push(`- **Spans omitted for budget:** ${r.omitted}`);
  if (r.redos) L.push(`- **Redos:** ${r.redos}`);
  if (r.costReported === false) L.push('- **Cost:** not reported by this engine (tokens only)');
  else if (r.costUsd != null) L.push(`- **Cost:** $${r.costUsd.toFixed(4)}`);
  if (!r.gated) {
    L.push('- **Note:** this check set annotates rather than blocks, so a failing check above did not withhold the work.');
  }
  L.push('');

  L.push('### Sources');
  for (const s of r.sources) {
    const marks = [s.cited ? 'cited' : 'read, not cited'];
    if (s.changed) marks.push('**CHANGED SINCE THIS RUN**');
    L.push(`- \`${s.id}\` - ${marks.join(' · ')} · sha256 \`${s.hash.slice(0, 12)}\``);
  }

  if (footnotes.length) {
    L.push('', '### References');
    footnotes.forEach((f, i) => L.push(`[^${i + 1}]: ${f}`));
  }
  return L;
}

/** The reader's view: prose first, addresses in footnotes, receipt at the end. */
export function renderDisplay(
  title: string,
  items: PlacedItem[],
  receipt: Receipt,
  decision?: { field: string; value: string },
): string {
  const refs: string[] = [];
  const L = [`# ${title}`, ''];
  if (decision?.value) L.push(`**${decision.field}:** ${decision.value}`, '');
  if (!items.length) L.push('_No supportable claims were returned._', '');

  items.forEach((it, i) => {
    L.push(`## ${i + 1}. ${footnote(it.headline, refs)}`, '');
    L.push(footnote(it.body, refs), '');
    for (const e of it.evidence) L.push(quoteBlock(footnote(e, refs)), '');
  });

  // Any mark that survived (a field with no citations at all) must not reach the reader.
  return unmark([...L, ...receiptLines(receipt, refs)].join('\n'));
}

/**
 * The auditor's view: every placed span keeps its id inline, and each item lists the span
 * ids it rests on so a reviewer can walk the citations without following links.
 */
export function renderAudit(
  title: string,
  items: PlacedItem[],
  receipt: Receipt,
  decision?: { field: string; value: string },
): string {
  const L = [`# ${title}`, '', '_Audit view: span ids inline. See the display view for prose._', ''];
  if (decision?.value) L.push(`**${decision.field}:** ${decision.value}`, '');

  items.forEach((it, i) => {
    L.push(`## ${i + 1}. ${unmark(it.headline)}`, '', unmark(it.body), '');
    for (const e of it.evidence) L.push(quoteBlock(unmark(e)), '');
    const ids = [...new Set([...`${it.headline} ${it.body} ${it.evidence.join(' ')}`.matchAll(/\uE000\[([^\]\n]+)\]/g)].map((m) => m[1]))];
    if (ids.length) L.push(`\`spans: ${ids.join(', ')}\``, '');
  });

  return unmark([...L, ...receiptLines(receipt, [])].join('\n'));
}
