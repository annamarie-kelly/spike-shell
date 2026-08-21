// Pure decision logic for installing a template bundle's workspace groups over
// the groups already on disk. Framework-free (no ipc, no Tauri) so the Node test
// suite can exercise it — see test/groupmerge.test.mjs. The install gate in
// app.ts calls planGroupInstalls() and then performs the resulting writes.
//
// The rule an install must obey: never clobber a workspace, and never duplicate
// one that's already there unchanged. Re-importing a bundle you exported from
// this same machine is the common case (it doubled every group before this).

// Canonical form of a group for identity comparison. Drops the fields export
// strips (cwd, createdAt — machine-specific) plus the client-only id, then sorts
// keys so a different field order can't masquerade as a different group.
export function canonGroup(o: any): string {
  const { cwd, createdAt, id, ...rest } = o || {};
  return JSON.stringify(Object.keys(rest).sort().reduce((a: any, k) => { a[k] = rest[k]; return a; }, {}));
}

export interface GroupInstall { group: any; steering: string; }
export interface GroupPlan { installs: GroupInstall[]; skipped: string[]; }

// Decide what each bundle `groups/*.json` should do against the existing groups:
//   - same name + identical portable content -> skip (kept yours)
//   - same name + different content           -> install under a " (N)" suffix
//   - new name                                -> install as-is
// The returned group objects already carry their final (possibly suffixed) name.
// Pure: the caller does the actual ipc.installGroup writes.
export function planGroupInstalls(
  bundleFiles: Record<string, string>,
  existingGroups: any[],
): GroupPlan {
  const taken = new Set<string>();
  const existing = new Map<string, string>();   // name -> canonical content
  for (const g of existingGroups || []) {
    if (g?.name) { taken.add(g.name); existing.set(g.name, canonGroup(g)); }
  }
  const installs: GroupInstall[] = [];
  const skipped: string[] = [];
  for (const path of Object.keys(bundleFiles)) {
    const m = path.match(/^groups\/(.+)\.json$/);
    if (!m) continue;
    let g: any;
    try { g = JSON.parse(bundleFiles[path]); } catch { continue; }
    if (!g || typeof g.name !== 'string' || !g.name.trim()) continue;
    if (existing.get(g.name) === canonGroup(g)) { skipped.push(g.name); continue; }
    let finalName = g.name;
    for (let n = 2; taken.has(finalName); n++) finalName = `${g.name} (${n})`;
    taken.add(finalName);
    g.name = finalName;
    const steering = bundleFiles[`groups/${m[1]}.steering.md`] || '';
    installs.push({ group: g, steering });
  }
  return { installs, skipped };
}
