// Pure path parameterization for template bundles. Framework-free (no ipc, no
// Tauri) so the Node test suite can exercise it — see test/pathparam.test.mjs.
//
// The problem: a workspace group carries an absolute `cwd` and absolute
// `pinnedPaths` (e.g. /Users/annamarie/digital-garden/02-Thinking). Shipped
// verbatim, those are dead paths on anyone else's machine. So on EXPORT we
// rebase every path that lives under the workspace root to the placeholder
// `${workspace}`, and on INSTALL we resolve `${workspace}` back to the target
// machine's workspace root. Paths outside the root can't be rebased; we leave
// them absolute and report them so the export isn't silently lossy.

export const WORKSPACE = '${workspace}';

// Strip a single trailing slash (but never reduce "/" to ""). Used so a root of
// "/a/b/" and a path of "/a/b" still compare as equal.
function trimSlash(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

// Is `path` the root itself or a child of it? Compares on segment boundaries so
// "/a/bc" is NOT considered under "/a/b".
export function isUnder(path: string, root: string): boolean {
  const p = trimSlash(path), r = trimSlash(root);
  if (!r || !p) return false;
  return p === r || p.startsWith(r + '/');
}

// Rebase one absolute path under `root` to a `${workspace}`-relative one. The
// root itself becomes "${workspace}"; a child becomes "${workspace}/<rel>".
// Returns null when the path doesn't live under root (caller keeps it as-is).
export function toWorkspace(path: string, root: string): string | null {
  if (typeof path !== 'string' || !path) return null;
  if (path.startsWith(WORKSPACE)) return path;      // already parameterized
  if (!isUnder(path, root)) return null;
  const p = trimSlash(path), r = trimSlash(root);
  return p === r ? WORKSPACE : WORKSPACE + p.slice(r.length);
}

// Resolve a `${workspace}`-relative path back to an absolute one against the
// target machine's workspace root. A non-parameterized path passes through.
export function fromWorkspace(path: string, workspace: string): string {
  if (typeof path !== 'string' || !path.startsWith(WORKSPACE)) return path;
  const rel = path.slice(WORKSPACE.length);          // "" or "/sub/dir"
  const w = trimSlash(workspace);
  return rel ? w + rel : w;
}

export interface Parameterized { group: any; external: string[]; }

// Rewrite a group's machine-specific paths to `${workspace}` form for export.
// Returns the rewritten group plus the list of paths that fell OUTSIDE the
// workspace root and were left absolute (so the caller can warn). Does not
// mutate the input; `createdAt`/`id` handling stays the caller's job.
export function parameterizeGroup(group: any, root: string): Parameterized {
  const g = { ...(group || {}) };
  const external: string[] = [];
  if (typeof g.cwd === 'string' && g.cwd) {
    const w = toWorkspace(g.cwd, root);
    if (w !== null) g.cwd = w; else external.push(g.cwd);
  }
  if (Array.isArray(g.pinnedPaths)) {
    g.pinnedPaths = g.pinnedPaths.map((p: any) => {
      if (typeof p !== 'string') return p;
      const w = toWorkspace(p, root);
      if (w !== null) return w;
      external.push(p);
      return p;
    });
  }
  return { group: g, external };
}

// Reverse of parameterizeGroup: resolve every `${workspace}` path against the
// target workspace root. Does not mutate the input.
export function resolveGroup(group: any, workspace: string): any {
  const g = { ...(group || {}) };
  if (typeof g.cwd === 'string') g.cwd = fromWorkspace(g.cwd, workspace);
  if (Array.isArray(g.pinnedPaths)) {
    g.pinnedPaths = g.pinnedPaths.map((p: any) =>
      typeof p === 'string' ? fromWorkspace(p, workspace) : p);
  }
  return g;
}

// Resolve `${workspace}` in every `groups/*.json` of a bundle file-map, against
// the target workspace root. Returns a NEW file-map; non-group files pass
// through untouched. Run this right after readBundle and BEFORE planGroupInstalls
// so a re-imported group's resolved (absolute) paths match the existing group on
// disk — otherwise idempotency breaks and the group installs as a " (2)" dup.
export function resolveBundleGroups(
  files: Record<string, string>,
  workspace: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const path of Object.keys(files || {})) {
    if (!/^groups\/.+\.json$/.test(path)) { out[path] = files[path]; continue; }
    try {
      const resolved = resolveGroup(JSON.parse(files[path]), workspace);
      out[path] = JSON.stringify(resolved, null, 2) + '\n';
    } catch { out[path] = files[path]; }   // leave unparseable JSON for the planner to skip
  }
  return out;
}
