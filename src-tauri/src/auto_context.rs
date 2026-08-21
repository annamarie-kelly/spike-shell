// auto_context.rs — "active-work" context resolution for the status line.
//
// Resolves the work a session is on (current git branch + its GitHub PR number)
// from a cwd, so the title bar can show `feature-x · gh#456` at a glance.
//
// DISPLAY-ONLY: nothing here touches the agent's system prompt. It only feeds
// the status line. Every lookup is fail-soft — a missing repo, a detached HEAD,
// `gh` not installed/authed, or no PR all degrade to `None`; we never return Err
// to the UI. The branch read is cheap (local git) and runs every focus; the
// `gh` lookup is cached per "{repo}@{branch}" in AppState so it runs once per
// branch, not once per focus.

use crate::state::AppState;
use crate::worktree::{git, repo_root};
use serde::Serialize;
use std::path::Path;
use std::process::Command;
use tauri::State;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoContext {
    /// Current branch name, or None when not in a repo / detached HEAD.
    pub branch: Option<String>,
    /// Open PR number for the branch via `gh`, or None when gh is unavailable
    /// or the branch has no PR.
    pub pr_number: Option<u64>,
    /// Web URL for that PR, so the title bar can link straight to it. Present
    /// exactly when `pr_number` is.
    pub pr_url: Option<String>,
    /// True when `cwd` sits in a linked git worktree (e.g. a Spike auto-worktree),
    /// not the main checkout. Drives the worktree glyph in the title bar.
    pub is_worktree: bool,
}

/// Resolve the active-work context for `cwd`. Never errors — see module note.
#[tauri::command]
pub fn resolve_auto_context(cwd: String, state: State<'_, AppState>) -> AutoContext {
    let dir = Path::new(&cwd);
    let Some(root) = repo_root(dir) else {
        return AutoContext::default();
    };

    // Branch is cheap and local — always read it fresh so checkout is reflected.
    let branch = git(dir, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .filter(|b| !b.is_empty() && b != "HEAD");
    let Some(branch) = branch else {
        return AutoContext::default();
    };

    let key = format!("{}@{}", root.to_string_lossy(), branch);
    if let Some(hit) = state.auto_context.lock().unwrap().get(&key).cloned() {
        return hit;
    }

    // Cache miss → the one expensive lookup. `gh` exits non-zero when there's no
    // PR (or it isn't installed/authed); both map cleanly to None.
    let (pr_number, pr_url) = gh_pr(dir);
    let ctx = AutoContext {
        branch: Some(branch),
        pr_number,
        pr_url,
        is_worktree: is_linked_worktree(dir),
    };
    state.auto_context.lock().unwrap().insert(key, ctx.clone());
    ctx
}

/// True when `dir` is inside a linked git worktree. A linked worktree's git dir
/// always lives at `<common>/worktrees/<name>`, so an absolute git dir containing
/// a `worktrees` path segment identifies one. The main checkout's git dir is a
/// plain `.git`, so it returns false. Fail-soft: any git failure → false.
fn is_linked_worktree(dir: &Path) -> bool {
    git(dir, &["rev-parse", "--absolute-git-dir"])
        .ok()
        .map(|gd| gd.replace('\\', "/").contains("/worktrees/"))
        .unwrap_or(false)
}

/// `gh pr view --json number,url` scoped to `dir`, returning the PR's number and
/// web URL together (so the title bar can both label and link it). Both are None
/// on any failure (gh missing, not authed, no PR, unparseable output); they are
/// always present or absent as a pair.
fn gh_pr(dir: &Path) -> (Option<u64>, Option<String>) {
    let out = match Command::new("gh")
        .current_dir(dir)
        .args(["pr", "view", "--json", "number,url", "--jq", "[.number, .url] | @tsv"])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return (None, None),
    };
    let line = String::from_utf8_lossy(&out.stdout);
    let mut cols = line.trim().split('\t');
    let number = cols.next().and_then(|n| n.parse::<u64>().ok());
    let url = cols
        .next()
        .map(str::trim)
        .filter(|u| u.starts_with("https://"));
    match (number, url) {
        (Some(n), Some(u)) => (Some(n), Some(u.to_string())),
        _ => (None, None),
    }
}
