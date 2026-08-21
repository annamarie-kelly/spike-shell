// card.ts — the EntityContextCard projector.
//
// Canonical records in, a compact card out. Pure and DOM-free, in the same
// spirit as groupmd.ts and assemble-context.ts: the rules that decide what a
// person sees about Acme are the part most likely to be wrong, so they live
// where a test can pin them without a database, a webview, or a model.
//
// The card is a PROJECTION and never a source of truth. It can be thrown away
// and rebuilt from the records with no loss — which is why `project()` takes
// everything it needs as arguments (including the clock) and closes over
// nothing. Same records plus same `now` must always produce the same card;
// `test/work-card.test.mjs` asserts exactly that.
//
// Field-level provenance is the other half of the contract. Every value the
// card displays carries the source row it came from, so "why does Spike think
// Sarah is Series A" is answerable by pointing at `investors.csv#3` rather than
// by trusting the projection.

// ── input: what the store returns (mirrors ipc.EntityRecords) ────────────────

export interface EntityFact {
  key: string;
  value: string;
  sourceRef: string;
}

export interface EntityRelation {
  id: string;
  name: string;
  kind: string;
  relation: string;
  direction: 'in' | 'out';
}

export interface EntityInteraction {
  id: string;
  kind: string;
  /** ISO `YYYY-MM-DD` */
  occurredAt: string;
  summary: string;
  sourceRef: string;
}

export interface EntityRecords {
  id: string;
  kind: 'person' | 'company';
  name: string;
  status: string;
  version: number;
  updatedAt: string;
  aliases: string[];
  facts: EntityFact[];
  related: EntityRelation[];
  interactions: EntityInteraction[];
}

// ── output: the card ─────────────────────────────────────────────────────────

/** One displayed value plus where it came from. */
export interface CardField {
  label: string;
  value: string;
  /** the source row, e.g. `investors.csv#3`. Empty when Spike derived it. */
  source: string;
}

export interface CardEvent {
  date: string;
  summary: string;
  source: string;
  /** whole days between the event and `now`; negative when it is in the future */
  daysAgo: number;
}

export interface ContextCard {
  id: string;
  name: string;
  kind: 'person' | 'company';
  /** aliases other than the canonical name, for "also known as" */
  aliases: string[];
  /** the one line under the name: firm and role, or focus */
  headline: string;
  /** why this entity might matter right now, in plain words */
  status: string;
  fields: CardField[];
  related: Array<{ id: string; name: string; kind: string; relation: string }>;
  timeline: CardEvent[];
  /** honest count of what the card is NOT showing */
  moreEvents: number;
  provenance: {
    /** distinct source rows behind everything above */
    sources: string[];
    /** canonical records folded in — facts + relations + interactions */
    records: number;
    /** the entity row version this card was built from */
    entityVersion: number;
  };
  projectionVersion: number;
  refreshedAt: string;
}

/** Bump when the card's SHAPE changes, so a stored card can be spotted as stale. */
export const PROJECTION_VERSION = 1;

/** How many events the card shows before it starts counting the rest. */
const TIMELINE_LIMIT = 5;

// Facts that earn a place in the headline rather than the field list, in the
// order they read best. Everything else falls through to `fields`.
const HEADLINE_KEYS = ['role', 'firm', 'focus', 'industry', 'stage'];

/** Title-case a store key for display: `check size` → `Check size`. */
function label(key: string): string {
  const k = key.trim();
  if (!k) return '';
  return k.charAt(0).toUpperCase() + k.slice(1);
}

/** Whole days between two ISO dates. Returns null if either is unparseable. */
export function daysBetween(fromIso: string, toIso: string): number | null {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Plain-words recency. Deliberately coarse: "3 weeks ago" is what a person
 * actually reasons with, and a false precision ("21.4 days") invites trusting
 * the number more than the underlying record deserves.
 */
export function describeGap(days: number): string {
  if (days < 0) return 'upcoming';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'last week';
  if (days < 31) return `${Math.round(days / 7)} weeks ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)} years ago`;
}

/**
 * Build the card.
 *
 * @param rec  canonical records, exactly as the store returned them
 * @param now  today as ISO `YYYY-MM-DD` — passed in, never read from the clock,
 *             so the projection is reproducible and testable
 */
export function project(rec: EntityRecords, now: string): ContextCard {
  const factByKey = new Map<string, EntityFact>();
  for (const f of rec.facts) {
    // Store order is already stable (ORDER BY key); first write wins so a
    // duplicated key cannot make the card flicker between rebuilds.
    if (!factByKey.has(f.key)) factByKey.set(f.key, f);
  }

  // ── headline ──────────────────────────────────────────────────────────────
  // A person reads as "Role at Firm"; the firm comes from the relationship
  // graph when there is one, because that is the version with an id behind it.
  const employer = rec.related.find(
    r => r.relation === 'works_at' && r.direction === 'out',
  );
  const headlineParts: string[] = [];
  const role = factByKey.get('role')?.value;
  if (role) headlineParts.push(role);
  const firm = employer?.name || factByKey.get('firm')?.value;
  if (firm) headlineParts.push(rec.kind === 'person' ? `at ${firm}` : firm);
  if (!headlineParts.length) {
    const fallback = factByKey.get('focus') || factByKey.get('industry') || factByKey.get('stage');
    if (fallback) headlineParts.push(fallback.value);
  }

  // ── timeline ──────────────────────────────────────────────────────────────
  // Newest first. The store already sorts, but sorting here too means the card
  // does not silently depend on the query's ORDER BY to stay correct.
  const events: CardEvent[] = rec.interactions
    .map(i => ({
      date: i.occurredAt,
      summary: i.summary,
      source: i.sourceRef,
      daysAgo: daysBetween(i.occurredAt, now) ?? 0,
    }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const shown = events.slice(0, TIMELINE_LIMIT);

  // ── status ────────────────────────────────────────────────────────────────
  // What a person wants first: when we last spoke, and whether anything is
  // pending. No inference beyond what the records literally say.
  let status: string;
  const upcoming = events.filter(e => e.daysAgo < 0);
  const past = events.filter(e => e.daysAgo >= 0);
  if (upcoming.length) {
    status = `Next: ${upcoming[upcoming.length - 1].date}`;
  } else if (past.length) {
    status = `Last contact ${describeGap(past[0].daysAgo)}`;
  } else {
    status = 'No recorded contact';
  }

  // ── fields ────────────────────────────────────────────────────────────────
  // Everything not spent on the headline, in stable key order.
  const fields: CardField[] = [];
  for (const key of [...factByKey.keys()].sort()) {
    if (HEADLINE_KEYS.includes(key) && headlineParts.length) continue;
    const f = factByKey.get(key)!;
    fields.push({ label: label(key), value: f.value, source: f.sourceRef });
  }

  // ── provenance ────────────────────────────────────────────────────────────
  const sources = [
    ...new Set(
      [...rec.facts.map(f => f.sourceRef), ...rec.interactions.map(i => i.sourceRef)].filter(
        Boolean,
      ),
    ),
  ].sort();

  return {
    id: rec.id,
    name: rec.name,
    kind: rec.kind,
    aliases: rec.aliases.filter(a => a !== rec.name),
    headline: headlineParts.join(' '),
    status,
    fields,
    related: rec.related.map(r => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      relation: r.relation,
    })),
    timeline: shown,
    moreEvents: Math.max(0, events.length - shown.length),
    provenance: {
      sources,
      records: rec.facts.length + rec.related.length + rec.interactions.length,
      entityVersion: rec.version,
    },
    projectionVersion: PROJECTION_VERSION,
    refreshedAt: now,
  };
}
