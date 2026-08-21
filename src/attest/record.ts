// A run record: what a report's citations pointed at, at the moment it was written.
//
// Without this, `source-unchanged` can only catch a file edited DURING a run, which is
// the least interesting case. The one that matters is the report you shipped last week:
// every `[folder:notes.md@s7]` in it still looks authoritative, the file has since been
// rewritten, and nothing anywhere can tell. Re-running produces different span text under
// the same ids and reports VERBATIM again, because it is verbatim - to different bytes.
//
// So a record stores, per cited span, the id it claimed and the exact text that was
// placed, plus the source's hash. Re-checking is then mechanical and needs no model: read
// the sources as they are now, and ask whether each recorded span still says what the
// report says it said.
//
// Deliberately NOT a snapshot of the sources. Storing the corpus would make every report
// carry a copy of the documents it cites - a privacy and size problem, and one the user
// did not ask for. A hash plus the placed text is enough to detect drift and to say
// exactly which claim is affected.

export type RecordedSpan = {
  span_id: string;
  source_id: string;
  /** the exact bytes placed in the report */
  text: string;
  start: number;
  end: number;
};

export type RunRecord = {
  version: 1;
  /** ISO 8601. Supplied by the caller - this module stays pure. */
  at: string;
  task: string;
  checkSet: string;
  model: string;
  pass: boolean;
  verdict: { quotes: string; shape: string; figures: string };
  sources: Array<{ id: string; hash: string; cited: boolean }>;
  spans: RecordedSpan[];
};

export type DriftFinding = {
  span_id: string;
  source_id: string;
  kind: 'source-missing' | 'source-changed' | 'span-moved' | 'span-gone';
  /** what the report says was there */
  claimed: string;
  /** what is there now at the recorded offsets, when the source still exists */
  found?: string;
};

export type DriftReport = {
  /** true when every cited span still resolves to the text the report placed */
  intact: boolean;
  checked: number;
  findings: DriftFinding[];
  summary: string;
};

/** Build a record from a finished run. Pure: `at` is passed in, never read from a clock. */
export function buildRecord(args: {
  at: string;
  task: string;
  checkSetName: string;
  model: string;
  pass: boolean;
  verdict: { quotes: string; shape: string; figures: string };
  sources: Array<{ id: string; hash: string; cited: boolean }>;
  placedSpanIds: string[];
  table: Map<string, { span_id: string; source_id: string; text: string; start: number; end: number }>;
}): RunRecord {
  // Deduped and sorted so two runs that cited the same spans produce identical records,
  // which is what makes a record diffable.
  const ids = [...new Set(args.placedSpanIds)].sort();
  const spans: RecordedSpan[] = [];
  for (const id of ids) {
    const s = args.table.get(id);
    if (!s) continue;
    spans.push({ span_id: s.span_id, source_id: s.source_id, text: s.text, start: s.start, end: s.end });
  }
  return {
    version: 1,
    at: args.at,
    task: args.task,
    checkSet: args.checkSetName,
    model: args.model,
    pass: args.pass,
    verdict: args.verdict,
    sources: args.sources,
    spans,
  };
}

/**
 * Re-check a record against the sources as they are now.
 *
 * `current` maps source id -> the file's text today. A source absent from the map is
 * treated as gone, which is a finding rather than a skip: a citation to a document that no
 * longer exists is exactly the thing worth surfacing.
 *
 * The check is layered so the finding says something useful rather than just "changed":
 * an unchanged hash means nothing to do; a changed hash where the span still resolves at
 * its recorded offsets means the edit was elsewhere in the file and the quote is still
 * honest; a span that moved but whose text is still present somewhere is a `span-moved`;
 * and text that is gone entirely is `span-gone`, the one that invalidates the claim.
 */
export function checkDrift(
  record: RunRecord,
  current: Map<string, { text: string; hash: string }>,
): DriftReport {
  const findings: DriftFinding[] = [];
  const bySource = new Map<string, RecordedSpan[]>();
  for (const s of record.spans) {
    if (!bySource.has(s.source_id)) bySource.set(s.source_id, []);
    bySource.get(s.source_id)!.push(s);
  }

  for (const [source_id, spans] of bySource) {
    const now = current.get(source_id);
    if (!now) {
      for (const s of spans) {
        findings.push({ span_id: s.span_id, source_id, kind: 'source-missing', claimed: s.text });
      }
      continue;
    }
    const recorded = record.sources.find((r) => r.id === source_id);
    if (recorded && recorded.hash === now.hash) continue; // untouched, nothing to check

    for (const s of spans) {
      const at = now.text.slice(s.start, s.end);
      if (at === s.text) continue; // the edit was elsewhere; this quote still holds
      if (now.text.includes(s.text)) {
        findings.push({ span_id: s.span_id, source_id, kind: 'span-moved', claimed: s.text, found: at });
      } else {
        findings.push({ span_id: s.span_id, source_id, kind: 'span-gone', claimed: s.text, found: at });
      }
    }
  }

  const gone = findings.filter((f) => f.kind === 'span-gone' || f.kind === 'source-missing').length;
  const moved = findings.filter((f) => f.kind === 'span-moved').length;
  const intact = findings.length === 0;

  const parts: string[] = [];
  if (gone) parts.push(`${gone} quote(s) no longer in the source`);
  if (moved) parts.push(`${moved} quote(s) moved but still present`);

  return {
    intact,
    checked: record.spans.length,
    findings,
    summary: intact
      ? `INTACT - all ${record.spans.length} cited quote(s) still resolve to the text this report placed.`
      : `DRIFTED - ${parts.join(', ')} of ${record.spans.length} cited.`,
  };
}

/** A short markdown block for a drift check, suitable for appending to a report. */
export function renderDrift(record: RunRecord, drift: DriftReport): string {
  const L = [`## Drift check`, '', `Report written ${record.at} against check set \`${record.checkSet}\`.`, '', `**${drift.summary}**`, ''];
  if (!drift.intact) {
    L.push('| span | what happened | the report says |', '| --- | --- | --- |');
    for (const f of drift.findings) {
      const what = {
        'source-missing': 'source no longer exists',
        'source-changed': 'source changed',
        'span-moved': 'moved within the source',
        'span-gone': 'no longer in the source',
      }[f.kind];
      L.push(`| \`${f.span_id}\` | ${what} | ${f.claimed.replace(/\n/g, ' ').slice(0, 80)} |`);
    }
    L.push('');
  }
  return L.join('\n');
}
