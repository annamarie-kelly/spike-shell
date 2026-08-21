// worktree.rs — git detection + the auto-worktree isolation engine
// (settings-v2, spec Feature 3).
//
// Per-workspace isolation mode "auto-worktree": the first agent in a workspace
// uses the main checkout; each ADDITIONAL concurrent agent spawns into a fresh
// `git worktree` on a new branch under the configured location. On tab close
// the global policy applies (auto-merge-clean | ask | keep-branch).
//
// All git operations shell out to the `git` binary (no libgit2 dependency).
// Every operation is fail-soft: worktree creation failure must never block a
// tab — callers degrade to the main checkout and warn in the terminal.

use std::path::{Path, PathBuf};
use std::process::Command;

/// Run git with args in `dir`; Ok(stdout-trimmed) on exit 0, Err(stderr) else.
pub(crate) fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| format!("git not runnable: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// The repo work-tree root containing `dir`, or None when `dir` isn't inside
/// a git repository (or git isn't installed).
pub fn repo_root(dir: &Path) -> Option<PathBuf> {
    if !dir.is_dir() {
        return None;
    }
    git(dir, &["rev-parse", "--show-toplevel"])
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// Is this directory inside a git work tree? Drives the workspace card's
/// Auto-worktree segment (disabled + tooltip when false).
#[tauri::command]
pub fn git_repo_check(path: String) -> Result<bool, String> {
    Ok(repo_root(Path::new(&path)).is_some())
}

// ── pure naming / policy helpers (unit-tested) ──────────────────────────────

/// Filesystem-safe slug for worktree dir / branch names — same rules as the
/// group-file slug (fs_ops::sanitize_group_name) so the two stay congruent.
pub fn slug(name: &str) -> String {
    let mut out = String::new();
    let mut in_run = false;
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-' {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push('-');
            in_run = true;
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "group".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Branch name for the n-th auto worktree of a workspace: `<prefix><slug>-<n>`.
pub fn branch_name(prefix: &str, group: &str, n: u32) -> String {
    format!("{}{}-{}", prefix, slug(group), n)
}

/// Worktree directory name for the n-th auto worktree: `<slug>-<n>`.
pub fn dir_name(group: &str, n: u32) -> String {
    format!("{}-{}", slug(group), n)
}

/// Resolve the configured worktree location against the repo root: absolute
/// locations pass through, relative ones live under the repo root.
pub fn resolve_location(repo_root: &Path, location: &str) -> PathBuf {
    let loc = location.trim();
    let loc = if loc.is_empty() { ".spike/worktrees/" } else { loc };
    let p = Path::new(loc);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        repo_root.join(p)
    }
}

/// The close policies the Git & worktrees pane offers. Unknown strings fall
/// back to the default (auto-merge-clean) — readers default missing fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClosePolicy {
    AutoMergeClean,
    Ask,
    KeepBranch,
}

pub fn parse_policy(s: &str) -> ClosePolicy {
    match s {
        "ask" => ClosePolicy::Ask,
        "keep-branch" => ClosePolicy::KeepBranch,
        _ => ClosePolicy::AutoMergeClean,
    }
}

/// The spawn-time trigger (spec: "when relevant", both must hold):
/// (a) the workspace cwd is inside a git repo, and (b) a second-or-later
/// concurrent agent is being spawned in that workspace. A lone agent never
/// gets a worktree.
pub fn should_isolate(isolation: &str, in_git_repo: bool, live_agents_in_group: usize) -> bool {
    isolation == "auto-worktree" && in_git_repo && live_agents_in_group >= 1
}

// ── worktree lifecycle ───────────────────────────────────────────────────────

/// One auto-created worktree, recorded on the owning PtyHandle at spawn
/// (the tab → worktree → branch mapping). `base` is the branch that was
/// checked out in the main checkout at creation time — the merge target.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub repo_root: String,
    pub path: String,
    pub branch: String,
    pub base: String,
}

fn branch_exists(repo: &Path, branch: &str) -> bool {
    git(repo, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok()
}

/// Create a fresh worktree + branch for `group` under `location`:
/// `git worktree add <location>/<slug>-<n> -b <prefix><slug>-<n>`, n = first
/// free index (neither the dir nor the branch may already exist — a renamed
/// workspace's older worktrees keep their old-name slugs untouched).
/// Fails (Err) rather than guessing on a detached HEAD: the close policy
/// needs a real base branch to merge into.
pub fn prepare_worktree(
    repo_root_dir: &Path,
    location: &str,
    prefix: &str,
    group: &str,
) -> Result<WorktreeInfo, String> {
    let base = git(repo_root_dir, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if base.is_empty() || base == "HEAD" {
        return Err("repository is on a detached HEAD — no base branch to merge back into".into());
    }
    let loc = resolve_location(repo_root_dir, location);
    std::fs::create_dir_all(&loc).map_err(|e| format!("cannot create {}: {e}", loc.display()))?;
    for n in 1..=200u32 {
        let dir = loc.join(dir_name(group, n));
        let branch = branch_name(prefix, group, n);
        if dir.exists() || branch_exists(repo_root_dir, &branch) {
            continue;
        }
        let dir_s = dir.to_string_lossy().into_owned();
        git(repo_root_dir, &["worktree", "add", &dir_s, "-b", &branch])?;
        return Ok(WorktreeInfo {
            repo_root: repo_root_dir.to_string_lossy().into_owned(),
            path: dir_s,
            branch,
            base,
        });
    }
    Err("no free worktree slot (200 in use?)".into())
}

/// Create a worktree for an agent HANDOFF: a fresh branch `<prefix><label>-<n>`
/// rooted at an explicit `start_point` commit (the source lane's HEAD OID),
/// under `location`. Unlike `prepare_worktree` (which branches from the repo's
/// *current* HEAD), this pins the fork to a specific commit so the target
/// continues the source's exact line even if the source is detached or its
/// branch later moves. `base` is the merge-back target recorded for the close
/// policy (the source's branch name, or the OID when the source is detached).
pub fn prepare_worktree_from(
    repo_root_dir: &Path,
    location: &str,
    prefix: &str,
    label: &str,
    start_point: &str,
    base: &str,
) -> Result<WorktreeInfo, String> {
    let loc = resolve_location(repo_root_dir, location);
    std::fs::create_dir_all(&loc).map_err(|e| format!("cannot create {}: {e}", loc.display()))?;
    for n in 1..=200u32 {
        let dir = loc.join(dir_name(label, n));
        let branch = branch_name(prefix, label, n);
        if dir.exists() || branch_exists(repo_root_dir, &branch) {
            continue;
        }
        let dir_s = dir.to_string_lossy().into_owned();
        git(repo_root_dir, &["worktree", "add", &dir_s, "-b", &branch, start_point])?;
        return Ok(WorktreeInfo {
            repo_root: repo_root_dir.to_string_lossy().into_owned(),
            path: dir_s,
            branch,
            base: base.to_string(),
        });
    }
    Err("no free worktree slot (200 in use?)".into())
}

/// Force-remove a worktree + delete its branch. The handoff atomicity path:
/// when a fork's snapshot application or engine spawn fails, the unused fork
/// must not linger. Best-effort — every step is independently ignorable.
pub fn discard_worktree(info: &WorktreeInfo) {
    let repo = Path::new(&info.repo_root);
    let _ = git(repo, &["worktree", "remove", "--force", &info.path]);
    let _ = git(repo, &["branch", "-D", &info.branch]);
    let _ = git(repo, &["worktree", "prune"]);
}

/// What applying a close policy did — or that it needs the user (NeedsAsk
/// carries the reason; the caller surfaces a merge/keep/discard prompt).
#[derive(Debug, PartialEq, Eq)]
pub enum CloseOutcome {
    Merged,
    Removed,     // branch had no unique commits; worktree + branch cleaned up
    BranchKept,
    NeedsAsk(String),
}

fn is_dirty(worktree_dir: &Path) -> Result<bool, String> {
    Ok(!git(worktree_dir, &["status", "--porcelain"])?.is_empty())
}

fn commits_ahead(repo: &Path, base: &str, branch: &str) -> Result<u32, String> {
    git(repo, &["rev-list", "--count", &format!("{base}..{branch}")])?
        .parse::<u32>()
        .map_err(|e| format!("bad rev-list output: {e}"))
}

/// Commit everything in the worktree as a snapshot so removing its directory
/// can never lose work. Falls back to an explicit identity when the user has
/// no git identity configured.
fn snapshot_commit(worktree_dir: &Path) -> Result<(), String> {
    git(worktree_dir, &["add", "-A"])?;
    let msg = "spike: worktree snapshot on tab close";
    if git(worktree_dir, &["commit", "-m", msg]).is_ok() {
        return Ok(());
    }
    git(worktree_dir, &[
        "-c", "user.name=Spike", "-c", "user.email=spike@localhost",
        "commit", "-m", msg,
    ])
    .map(|_| ())
}

fn remove_worktree(repo: &Path, worktree_dir: &str, force: bool) -> Result<(), String> {
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(worktree_dir);
    git(repo, &args).map(|_| ())
}

/// Merge `branch` into its base in the main checkout, then clean up the
/// worktree + branch. Never forces: any failure aborts the merge and reports
/// Err, leaving branch and worktree intact.
fn merge_and_clean(info: &WorktreeInfo) -> Result<(), String> {
    let repo = Path::new(&info.repo_root);
    let current = git(repo, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if current != info.base {
        return Err(format!(
            "main checkout is on '{current}', not the base branch '{}'", info.base
        ));
    }
    if let Err(e) = git(repo, &["merge", "--no-edit", &info.branch]) {
        let _ = git(repo, &["merge", "--abort"]); // never leave a half-merge
        return Err(format!("merge did not apply cleanly: {e}"));
    }
    remove_worktree(repo, &info.path, false)?;
    // -d (not -D): only deletes a fully-merged branch — guaranteed here.
    git(repo, &["branch", "-d", &info.branch]).map(|_| ())
}

/// Apply the configured on-close policy to a finished worktree. Fail-soft and
/// never destructive: every path that can't proceed safely degrades to
/// NeedsAsk (the caller prompts merge / keep / discard).
pub fn close_worktree(info: &WorktreeInfo, policy: ClosePolicy) -> CloseOutcome {
    let repo = Path::new(&info.repo_root);
    let wt = Path::new(&info.path);
    if !wt.is_dir() {
        return CloseOutcome::Removed; // already gone (cleaned by hand) — nothing to do
    }
    let dirty = match is_dirty(wt) {
        Ok(d) => d,
        Err(e) => return CloseOutcome::NeedsAsk(format!("could not read worktree status: {e}")),
    };
    match policy {
        ClosePolicy::Ask => CloseOutcome::NeedsAsk("close policy is set to always ask".into()),
        ClosePolicy::KeepBranch => {
            // keep the branch, remove the dir — snapshot first so a dirty
            // tree's work survives on the branch.
            if dirty {
                if let Err(e) = snapshot_commit(wt) {
                    return CloseOutcome::NeedsAsk(format!("could not snapshot the worktree: {e}"));
                }
            }
            match remove_worktree(repo, &info.path, false) {
                Ok(()) => CloseOutcome::BranchKept,
                Err(e) => CloseOutcome::NeedsAsk(format!("could not remove the worktree: {e}")),
            }
        }
        ClosePolicy::AutoMergeClean => {
            if dirty {
                return CloseOutcome::NeedsAsk("the worktree has uncommitted changes".into());
            }
            let ahead = match commits_ahead(repo, &info.base, &info.branch) {
                Ok(n) => n,
                Err(e) => return CloseOutcome::NeedsAsk(format!("could not compare branches: {e}")),
            };
            if ahead == 0 {
                // nothing unique on the branch — removing both loses nothing.
                if remove_worktree(repo, &info.path, false).is_ok()
                    && git(repo, &["branch", "-d", &info.branch]).is_ok()
                {
                    return CloseOutcome::Removed;
                }
                return CloseOutcome::NeedsAsk("could not remove the empty worktree".into());
            }
            match merge_and_clean(info) {
                Ok(()) => CloseOutcome::Merged,
                Err(e) => CloseOutcome::NeedsAsk(e),
            }
        }
    }
}

/// Is `branch` a spike-managed worktree branch? Accepts spike's canonical
/// namespace plus the (possibly customized) configured prefix, so a renamed
/// prefix still recognizes both old and new branches. This is the gate that
/// stops a stray/hostile call from `git branch -D`-ing `main` or any branch
/// the user actually cares about.
fn is_spike_branch(branch: &str) -> bool {
    if branch.starts_with("spike/wt-") {
        return true;
    }
    let cfg = crate::fs_ops::read_config_resolved();
    cfg["worktree"]["branchPrefix"]
        .as_str()
        .map(|p| !p.is_empty() && branch.starts_with(p))
        .unwrap_or(false)
}

/// Does git itself report `wt` as a SECONDARY worktree of `repo` checked out on
/// `branch`? Parses `git worktree list --porcelain` (records of `worktree
/// <path>` … `branch refs/heads/<name>`). Never matches the main checkout, so
/// it can't authorize removing the primary work tree. Paths are canonicalized
/// so symlinked tempdirs / `..` games don't slip a foreign dir through.
fn is_secondary_worktree(repo: &Path, wt: &Path, branch: &str) -> Result<bool, String> {
    let top = repo_root(repo).and_then(|p| p.canonicalize().ok());
    let want = wt
        .canonicalize()
        .map_err(|e| format!("worktree path unresolved: {e}"))?;
    let want_branch = format!("refs/heads/{branch}");
    let listing = git(repo, &["worktree", "list", "--porcelain"])?;
    let mut cur: Option<PathBuf> = None;
    for line in listing.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            cur = Path::new(p).canonicalize().ok();
        } else if let Some(b) = line.strip_prefix("branch ") {
            if cur.as_deref() == Some(want.as_path()) && b == want_branch && cur != top {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Guard the frontend-driven, destructive resolve before any git op runs. The
/// `repo_root`/`path`/`branch` arrive as raw strings from the webview, and the
/// arms below `git worktree remove --force` and `git branch -D` them — so a UI
/// bug (or, pre-CSP, an XSS) could otherwise nuke `main` or remove an arbitrary
/// directory. Bind the operation to git's ground truth instead:
///   * the branch must be spike-managed (never delete a user branch), and
///   * if the worktree dir still exists it must be a real secondary worktree of
///     this repo (never the main checkout, never an unrelated dir). A
///     dir that's already gone is fine — only the branch guard then applies.
fn validate_resolve_target(info: &WorktreeInfo) -> Result<(), String> {
    if !is_spike_branch(&info.branch) {
        return Err(format!(
            "refusing a destructive worktree op on '{}': not a spike-managed branch",
            info.branch
        ));
    }
    let repo = Path::new(&info.repo_root);
    if repo_root(repo).is_none() {
        return Err("not a git repository".into());
    }
    let wt = Path::new(&info.path);
    if wt.exists() && !is_secondary_worktree(repo, wt, &info.branch)? {
        return Err(format!(
            "'{}' is not a worktree of this repo on branch '{}' — refusing to remove it",
            info.path, info.branch
        ));
    }
    Ok(())
}

/// Resolve a NeedsAsk prompt from the frontend dialog.
/// choice: "merge" (snapshot dirty work, merge into base, clean up) |
///         "keep"  (snapshot dirty work, keep branch, remove dir) |
///         "discard" (drop worktree AND branch — the one explicitly
///                    destructive path, behind an explicit user click).
/// Ok(message) describes what happened; Err leaves branch + worktree intact.
#[tauri::command]
pub fn worktree_resolve(
    repo_root: String,
    path: String,
    branch: String,
    base: String,
    choice: String,
) -> Result<String, String> {
    let info = WorktreeInfo { repo_root, path, branch, base };
    // Never trust the raw path/branch from the webview for a destructive op.
    validate_resolve_target(&info)?;
    let repo = Path::new(&info.repo_root);
    let wt = Path::new(&info.path);
    let outcome = match choice.as_str() {
        "merge" => {
            if wt.is_dir() && is_dirty(wt)? {
                snapshot_commit(wt)?;
            }
            merge_and_clean(&info)?;
            format!("merged {} into {}", info.branch, info.base)
        }
        "keep" => {
            if wt.is_dir() {
                if is_dirty(wt)? {
                    snapshot_commit(wt)?;
                }
                remove_worktree(repo, &info.path, false)?;
            }
            format!("kept branch {}", info.branch)
        }
        "discard" => {
            if wt.is_dir() {
                remove_worktree(repo, &info.path, true)?;
            }
            git(repo, &["branch", "-D", &info.branch])?;
            format!("discarded {}", info.branch)
        }
        other => return Err(format!("unknown choice: {other}")),
    };
    crate::fs_ops::log_action(
        "worktree_resolve",
        serde_json::json!({ "branch": info.branch, "choice": choice }),
    );
    Ok(outcome)
}

// ── tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branch_and_dir_naming() {
        assert_eq!(branch_name("spike/wt-", "spike", 1), "spike/wt-spike-1");
        assert_eq!(branch_name("spike/wt-", "My Group!", 3), "spike/wt-My-Group-3");
        assert_eq!(dir_name("backend api", 2), "backend-api-2");
        assert_eq!(dir_name("", 1), "group-1");
    }

    #[test]
    fn location_resolution() {
        let root = Path::new("/repo");
        assert_eq!(resolve_location(root, ".spike/worktrees/"), PathBuf::from("/repo/.spike/worktrees/"));
        assert_eq!(resolve_location(root, "/tmp/wt"), PathBuf::from("/tmp/wt"));
        assert_eq!(resolve_location(root, ""), PathBuf::from("/repo/.spike/worktrees/"));
        assert_eq!(resolve_location(root, "  "), PathBuf::from("/repo/.spike/worktrees/"));
    }

    #[test]
    fn policy_parsing_defaults_safe() {
        assert_eq!(parse_policy("auto-merge-clean"), ClosePolicy::AutoMergeClean);
        assert_eq!(parse_policy("ask"), ClosePolicy::Ask);
        assert_eq!(parse_policy("keep-branch"), ClosePolicy::KeepBranch);
        // unknown/missing values fall back to the default policy
        assert_eq!(parse_policy(""), ClosePolicy::AutoMergeClean);
        assert_eq!(parse_policy("delete-everything"), ClosePolicy::AutoMergeClean);
    }

    #[test]
    fn isolation_trigger_conditions() {
        // both conditions hold → isolate
        assert!(should_isolate("auto-worktree", true, 1));
        assert!(should_isolate("auto-worktree", true, 4));
        // a lone agent never gets a worktree
        assert!(!should_isolate("auto-worktree", true, 0));
        // not a git repo → shared, regardless
        assert!(!should_isolate("auto-worktree", false, 3));
        // shared mode never isolates
        assert!(!should_isolate("shared", true, 5));
    }

    /// A throwaway repo with one commit and a configured identity. None when
    /// git isn't available (tests degrade to no-ops rather than failing CI
    /// boxes without git).
    fn temp_repo(tag: &str) -> Option<PathBuf> {
        let d = std::env::temp_dir().join(format!("spike-wt-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).ok()?;
        let ok = Command::new("git").arg("-C").arg(&d).args(["init", "-q", "-b", "main"]).status();
        if !ok.map(|s| s.success()).unwrap_or(false) {
            return None;
        }
        for args in [
            vec!["config", "user.email", "spike@test"],
            vec!["config", "user.name", "Spike Test"],
        ] {
            git(&d, &args.iter().map(|s| *s).collect::<Vec<_>>()).ok()?;
        }
        std::fs::write(d.join("README.md"), "hello\n").ok()?;
        git(&d, &["add", "-A"]).ok()?;
        git(&d, &["commit", "-q", "-m", "init"]).ok()?;
        Some(d)
    }

    #[test]
    fn prepare_creates_worktree_branch_and_records_base() {
        let Some(repo) = temp_repo("prep") else { return };
        let info = prepare_worktree(&repo, ".spike/worktrees/", "spike/wt-", "my ws").expect("prepare");
        assert_eq!(info.base, "main");
        assert_eq!(info.branch, "spike/wt-my-ws-1");
        assert!(Path::new(&info.path).is_dir());
        assert!(info.path.ends_with("my-ws-1"));
        assert!(branch_exists(&repo, &info.branch));
        // a second concurrent worktree takes the next slot
        let info2 = prepare_worktree(&repo, ".spike/worktrees/", "spike/wt-", "my ws").expect("prepare 2");
        assert_eq!(info2.branch, "spike/wt-my-ws-2");
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn auto_merge_clean_merges_and_cleans_up() {
        let Some(repo) = temp_repo("merge") else { return };
        let info = prepare_worktree(&repo, ".spike/worktrees/", "spike/wt-", "ws").expect("prepare");
        let wt = PathBuf::from(&info.path);
        std::fs::write(wt.join("agent.txt"), "work\n").unwrap();
        git(&wt, &["add", "-A"]).unwrap();
        git(&wt, &["commit", "-q", "-m", "agent work"]).unwrap();

        assert_eq!(close_worktree(&info, ClosePolicy::AutoMergeClean), CloseOutcome::Merged);
        assert!(repo.join("agent.txt").is_file(), "merge landed in the main checkout");
        assert!(!wt.exists(), "worktree dir removed");
        assert!(!branch_exists(&repo, &info.branch), "fully-merged branch deleted");
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn auto_merge_clean_with_no_commits_just_removes() {
        let Some(repo) = temp_repo("empty") else { return };
        let info = prepare_worktree(&repo, ".spike/worktrees/", "spike/wt-", "ws").expect("prepare");
        assert_eq!(close_worktree(&info, ClosePolicy::AutoMergeClean), CloseOutcome::Removed);
        assert!(!Path::new(&info.path).exists());
        assert!(!branch_exists(&repo, &info.branch));
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn dirty_worktree_falls_back_to_ask_and_destroys_nothing() {
        let Some(repo) = temp_repo("dirty") else { return };
        let info = prepare_worktree(&repo, ".spike/worktrees/", "spike/wt-", "ws").expect("prepare");
        std::fs::write(Path::new(&info.path).join("wip.txt"), "uncommitted\n").unwrap();
        match close_worktree(&info, ClosePolicy::AutoMergeClean) {
            CloseOutcome::NeedsAsk(_) => {}
            other => panic!("expected NeedsAsk, got {other:?}"),
        }
        assert!(Path::new(&info.path).is_dir(), "worktree untouched");
        assert!(branch_exists(&repo, &info.branch), "branch untouched");
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn merge_conflict_falls_back_to_ask_and_aborts() {
        let Some(repo) = temp_repo("conflict") else { return };
        let info = prepare_worktree(&repo, ".spike/worktrees/", "spike/wt-", "ws").expect("prepare");
        let wt = PathBuf::from(&info.path);
        // conflicting edits to the same file on both sides
        std::fs::write(wt.join("README.md"), "agent version\n").unwrap();
        git(&wt, &["commit", "-q", "-am", "agent edit"]).unwrap();
        std::fs::write(repo.join("README.md"), "main version\n").unwrap();
        git(&repo, &["commit", "-q", "-am", "main edit"]).unwrap();

        match close_worktree(&info, ClosePolicy::AutoMergeClean) {
            CloseOutcome::NeedsAsk(reason) => assert!(reason.contains("merge"), "reason: {reason}"),
            other => panic!("expected NeedsAsk, got {other:?}"),
        }
        // the abort left the main checkout clean (no tracked changes, no
        // half-merge; the untracked .spike/ worktree dir is expected)
        let status = git(&repo, &["status", "--porcelain"]).unwrap();
        assert!(
            status.lines().all(|l| l.starts_with("??")),
            "main checkout has tracked changes after abort: {status}"
        );
        assert!(wt.is_dir());
        assert!(branch_exists(&repo, &info.branch));
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn keep_branch_snapshots_dirty_work_then_removes_dir() {
        let Some(repo) = temp_repo("keep") else { return };
        let info = prepare_worktree(&repo, ".spike/worktrees/", "spike/wt-", "ws").expect("prepare");
        std::fs::write(Path::new(&info.path).join("wip.txt"), "save me\n").unwrap();
        assert_eq!(close_worktree(&info, ClosePolicy::KeepBranch), CloseOutcome::BranchKept);
        assert!(!Path::new(&info.path).exists(), "worktree dir removed");
        assert!(branch_exists(&repo, &info.branch), "branch kept");
        // the dirty file survives as a snapshot commit on the branch
        let shown = git(&repo, &["show", &format!("{}:wip.txt", info.branch)]).unwrap();
        assert_eq!(shown, "save me");
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn resolve_discard_drops_branch_and_dir() {
        let Some(repo) = temp_repo("discard") else { return };
        let info = prepare_worktree(&repo, ".spike/worktrees/", "spike/wt-", "ws").expect("prepare");
        std::fs::write(Path::new(&info.path).join("wip.txt"), "gone\n").unwrap();
        let msg = worktree_resolve(
            info.repo_root.clone(), info.path.clone(), info.branch.clone(), info.base.clone(),
            "discard".into(),
        ).expect("discard");
        assert!(msg.contains("discarded"));
        assert!(!Path::new(&info.path).exists());
        assert!(!branch_exists(&repo, &info.branch));
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn resolve_refuses_to_delete_a_non_spike_branch() {
        let Some(repo) = temp_repo("guard-branch") else { return };
        // A hostile/buggy call aiming at the main branch. The worktree path is
        // irrelevant — the branch guard rejects it before any git op.
        let err = worktree_resolve(
            repo.to_string_lossy().into(),
            repo.join(".spike/worktrees/x").to_string_lossy().into(),
            "main".into(),
            "main".into(),
            "discard".into(),
        )
        .unwrap_err();
        assert!(err.contains("not a spike-managed branch"), "got: {err}");
        assert!(branch_exists(&repo, "main"), "main branch must survive");
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn resolve_refuses_a_path_that_is_not_a_worktree() {
        let Some(repo) = temp_repo("guard-path") else { return };
        // Spike-looking branch, but the target dir is the main checkout itself
        // (exists, but is NOT a secondary worktree) → must be refused.
        let err = worktree_resolve(
            repo.to_string_lossy().into(),
            repo.to_string_lossy().into(),
            "spike/wt-ws-1".into(),
            "main".into(),
            "discard".into(),
        )
        .unwrap_err();
        assert!(err.contains("not a worktree of this repo"), "got: {err}");
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn repo_root_detects_real_and_non_repos() {
        // a throwaway temp repo
        let d = std::env::temp_dir().join(format!("spike-wt-detect-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("sub")).unwrap();
        assert!(repo_root(&d).is_none(), "bare temp dir must not read as a repo");
        let ok = Command::new("git").arg("-C").arg(&d).args(["init", "-q"]).status();
        if ok.map(|s| s.success()).unwrap_or(false) {
            let root = repo_root(&d.join("sub")).expect("subdir of a repo resolves to its root");
            // macOS tempdirs are symlinked (/var → /private/var); compare canonicalized
            assert_eq!(root.canonicalize().unwrap(), d.canonicalize().unwrap());
        }
        let _ = std::fs::remove_dir_all(&d);
    }
}
