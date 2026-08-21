// mention.ts — the rules behind the composer's `@` menu, as pure functions.
//
// Spike's Home composer already had an `@` menu for project FILES. The Company
// OS adds entities (people and companies) to the same trigger, because from the
// person's side there is one question — "what am I pointing at?" — and splitting
// it across two keys would be an implementation detail leaking into the keyboard.
//
// The ordering, the bookkeeping, and the "is this mention still in the text"
// rule live here rather than in app.ts so they can be tested without a DOM, a
// database, or a Tauri runtime. app.ts keeps the DOM and the async plumbing.

/** An entity result from the work store (mirrors ipc.MentionHit). */
export interface EntityCandidate {
  id: string;
  name: string;
  kind: 'person' | 'company';
  detail: string;
  rank: number;
  ambiguous: boolean;
}

/** One row in the composer menu, already display-ready. */
export interface MenuItem {
  /** what the row shows on the left */
  label: string;
  /** the muted line on the right */
  desc: string;
  /** the text spliced into the composer when picked */
  insert: string;
  /** 'entity' rows carry an id and open a context card; 'file' rows do not */
  source: 'entity' | 'file';
  entityId?: string;
  kind?: 'person' | 'company';
}

/** A mention the person actually selected, tracked so we know what they meant. */
export interface TrackedMention {
  entityId: string;
  /** the exact text spliced in, e.g. `@Sarah Guo` */
  text: string;
}

/** The text inserted for an entity. Trailing space so typing continues cleanly. */
export function mentionInsert(name: string): string {
  return `@${name} `;
}

/**
 * Order the menu: entities first, then files.
 *
 * Entities lead because they are the more specific answer — if a person typed
 * `@sar` and Spike knows a Sarah, offering `src/sarah-notes.md` first would be
 * ranking a filename above a human being. Within entities the store's rank
 * bucket decides, and ties break on name so the list never reorders between
 * two identical queries.
 *
 * Ambiguous candidates are NOT collapsed or deduped — the whole point is that
 * the person picks which Matrix they meant.
 */
export function mergeMentionItems(
  entities: EntityCandidate[],
  files: Array<{ rel: string }>,
  limit = 8,
): MenuItem[] {
  const sorted = [...entities].sort(
    (a, b) => a.rank - b.rank || a.name.localeCompare(b.name),
  );

  const items: MenuItem[] = sorted.map(e => ({
    label: e.name,
    // An ambiguous row MUST carry something that tells it apart, or the person
    // is choosing blind. Fall back to naming the type when there is no detail.
    desc: e.ambiguous ? e.detail || (e.kind === 'person' ? 'person' : 'company') : e.detail,
    insert: mentionInsert(e.name),
    source: 'entity',
    entityId: e.id,
    kind: e.kind,
  }));

  for (const f of files) {
    if (items.length >= limit) break;
    items.push({ label: f.rel, desc: '', insert: `@${f.rel} `, source: 'file' });
  }

  return items.slice(0, limit);
}

/**
 * Record a selection, replacing any earlier tracking of the same entity so the
 * list cannot grow without bound when someone picks the same person twice.
 */
export function trackMention(
  list: TrackedMention[],
  mention: TrackedMention,
): TrackedMention[] {
  return [...list.filter(m => m.entityId !== mention.entityId), mention];
}

/**
 * Which tracked mentions are STILL present in the composer text.
 *
 * This is the rule that keeps intent honest. A textarea has no rich tokens, so
 * the only truthful signal that someone still means "Sarah Guo" is that the
 * text they are about to send still says so. Deleting the words must drop the
 * mention — otherwise a message could carry an entity the person cannot see
 * referenced anywhere, which is exactly the sort of invisible context the
 * receipt is supposed to prevent.
 */
export function liveMentions(list: TrackedMention[], text: string): TrackedMention[] {
  return list.filter(m => text.includes(m.text.trim()));
}

/**
 * The `@`/`/` token under the caret, or null.
 *
 * Only matches at a word boundary, so an email address (`a@b.com`) never opens
 * the menu. Entity names with spaces are reachable through a single-token query
 * — the store's index matches any word in a name, so `@guo` finds "Sarah Guo"
 * without the composer having to guess where a multi-word query ends.
 */
export function parseComposerToken(
  val: string,
  caret: number,
): { kind: '@' | '/'; query: string; start: number } | null {
  const before = val.slice(0, caret);
  const m = /(^|\s)([@/])([\w./-]*)$/.exec(before);
  if (!m) return null;
  return {
    kind: m[2] as '@' | '/',
    query: m[3].toLowerCase(),
    start: m.index + m[1].length,
  };
}

/**
 * Should an in-flight lookup's results still be applied?
 *
 * Keystrokes outrun IPC, so a reply for `@sa` can land after the person has
 * typed `@sar`. Comparing the query the reply was FOR against the query on
 * screen now is what stops the menu flickering back to stale results.
 */
export function isCurrent(
  requested: { query: string; seq: number },
  current: { query: string; seq: number },
): boolean {
  return requested.seq === current.seq && requested.query === current.query;
}
