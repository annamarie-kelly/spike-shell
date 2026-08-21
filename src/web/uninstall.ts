// Pure planning for uninstalling a template recorded in the provenance ledger
// (~/.spike/installed-templates.json). Framework-free (no ipc, no Tauri) so the
// Node test suite can exercise it — see test/uninstall.test.mjs. The orchestration
// in app.ts calls these, then performs the reverts (delete groups, restore theme,
// call uninstall_bundle_extras) and persists the trimmed ledger.
//
// A ledger entry is { template, version, scope, installedAt, items: [...] }. Each
// item carries `_installedBy: "template@version"` and a `type`. Uninstall reverses
// exactly what install recorded — never the user's own config.

export interface LedgerItem {
  type: string;            // theme | group | hook | grant | spawn | mcp | skill
  name?: string;           // group name, or the extras label (mcp/skill name, grant, hook label, "key = val")
  detail?: string;         // hook: the literal command
  mode?: string;           // theme: applied mode
  prior?: string;          // theme: the mode that was active before install (for restore)
  scope?: string;
  _installedBy?: string;
}
export interface LedgerEntry {
  template?: string;
  version?: string;
  scope?: string;
  installedAt?: string;
  items?: LedgerItem[];
}
export interface UninstallParts {
  groups: string[];        // group names to delete
  theme: LedgerItem | null;// the theme item (restore its `prior` if present)
  extras: LedgerItem[];    // hook/grant/spawn/mcp/skill — reversed in Rust
}

// One-line human label for an entry, used by the picker.
export function entryLabel(e: LedgerEntry): string {
  const id = `${e.template || '?'}@${e.version || '0.0.0'}`;
  const n = (e.items || []).length;
  const where = e.scope === 'global' ? 'global' : 'project';
  return `${id} · ${n} item${n === 1 ? '' : 's'} · ${where}`;
}

// Split an entry's items into how each is reverted. Unknown/empty items are
// dropped. A group needs a name; theme is matched by type; everything else that
// touches the Claude/Spike config goes to `extras` for the Rust inverse merge.
export function categorizeItems(items: LedgerItem[] | undefined): UninstallParts {
  const groups: string[] = [];
  let theme: LedgerItem | null = null;
  const extras: LedgerItem[] = [];
  for (const it of items || []) {
    if (!it || typeof it.type !== 'string') continue;
    if (it.type === 'group') {
      if (typeof it.name === 'string' && it.name.trim()) groups.push(it.name);
    } else if (it.type === 'theme') {
      theme = it;
    } else if (it.type === 'hook' || it.type === 'grant' || it.type === 'spawn'
            || it.type === 'mcp' || it.type === 'skill') {
      extras.push(it);
    }
  }
  return { groups, theme, extras };
}

// Return a copy of the ledger with entry `index` removed. Out-of-range index
// returns the list unchanged (caller treats that as "nothing to do").
export function removeLedgerEntry(ledger: LedgerEntry[], index: number): LedgerEntry[] {
  if (!Array.isArray(ledger) || index < 0 || index >= ledger.length) return ledger || [];
  return ledger.slice(0, index).concat(ledger.slice(index + 1));
}
