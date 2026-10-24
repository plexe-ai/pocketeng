"""Git worktree management for parallel sessions."""
import shlex
import uuid

from src.lib.ssh import ssh_exec


def _expand_remote(path):
    """Turn `~/foo` into `$HOME/foo` so shell-quoting doesn't swallow the tilde.

    Paramiko's non-interactive channel doesn't perform tilde expansion, and
    shlex.quote() wraps the string in single quotes which makes bash treat
    `~` as a literal. Expanding to `$HOME/...` sidesteps both problems.
    """
    if path == "~":
        return "$HOME"
    if path.startswith("~/"):
        return "$HOME/" + path[2:]
    return path


def find_repo_dir(client, workdir="~/projects"):
    """Find the first git repo in the working directory."""
    remote = _expand_remote(workdir)

    # Check if workdir itself is a repo.
    cmd = f"cd {remote} 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null"
    stdout, _, exit_code = ssh_exec(client, cmd, timeout=5)
    if exit_code == 0 and stdout.strip():
        return stdout.strip()

    # Check immediate subdirectories. Sort by most-recently-modified so a repo
    # the user actually worked on recently wins over an alphabetical neighbor.
    cmd = (
        f"ls -1dt {remote}/*/ 2>/dev/null | while read -r d; do "
        f'  [ -d "$d/.git" ] && echo "$d" && break; '
        f"done"
    )
    stdout, _, _ = ssh_exec(client, cmd, timeout=5)
    repo = stdout.strip().rstrip("/")
    return repo if repo else None


def create_worktree(client, repo_dir, session_id):
    """Create a git worktree for a session. Returns (worktree_path, branch_name) or (None, None)."""
    short_id = session_id[:12]
    branch_name = f"pe-session-{short_id}"
    worktree_path = f"{repo_dir}-worktrees/{short_id}"

    # Get the default branch
    cmd = f"cd {shlex.quote(repo_dir)} && git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||'"
    stdout, _, _ = ssh_exec(client, cmd, timeout=5)
    base_branch = stdout.strip() or "main"

    # Fetch the base branch so we branch from a current origin ref, not
    # whatever stale copy the workspace last pulled. Without this the
    # worktree can be hours/days/weeks behind main — which matters
    # because:
    #   - `.claude/settings.json` (PreToolUse hook) lives on main; a
    #     stale worktree has no hook to fire → verify-before-PR is
    #     silently bypassed.
    #   - `AGENTS.md`/skill files on main teach the agent the latest
    #     conventions; a stale worktree gets outdated guidance.
    #   - The agent's first `git log` looks like the repo is months
    #     behind, which can confuse "grep before you use" workflows.
    # Fetch only the base branch (fast; skip tags) and tolerate network
    # blips — if the fetch errors we still fall back to whatever local
    # origin/<base> says rather than failing the session.
    cmd = (
        f"cd {shlex.quote(repo_dir)} && "
        f"git fetch --no-tags origin {shlex.quote(base_branch)} 2>&1 "
        f"|| echo 'worktree.fetch: best-effort fetch failed, continuing with local origin/{shlex.quote(base_branch)}'"
    )
    ssh_exec(client, cmd, timeout=30)

    # Determine the start point for the new worktree branch.
    # Normal case: origin/<base_branch> exists → branch from it.
    # Edge case — fresh/empty repo: the remote has no commits yet so
    # origin/<base_branch> doesn't exist.  In that case we fall back to
    # HEAD (local commits exist but haven't been pushed), and if HEAD
    # itself doesn't exist (truly empty repo — no commits at all) we
    # seed the local clone with an initial empty commit so that git
    # worktree has something to branch from.
    cmd = (
        f"cd {shlex.quote(repo_dir)} && "
        f"git rev-parse --verify origin/{shlex.quote(base_branch)} >/dev/null 2>&1 "
        f"&& echo 'remote' || echo 'no-remote'"
    )
    stdout, _, _ = ssh_exec(client, cmd, timeout=5)
    has_remote_ref = stdout.strip() == "remote"

    if has_remote_ref:
        start_point = f"origin/{shlex.quote(base_branch)}"
    else:
        # No remote ref — check whether there are any local commits.
        cmd = (
            f"cd {shlex.quote(repo_dir)} && "
            f"git rev-parse --verify HEAD >/dev/null 2>&1 "
            f"&& echo 'head' || echo 'no-head'"
        )
        stdout, _, _ = ssh_exec(client, cmd, timeout=5)
        has_head = stdout.strip() == "head"

        if not has_head:
            # Truly empty repo (no commits at all). Seed it with an initial
            # empty commit so the worktree can branch from HEAD.
            # Make sure HEAD points to base_branch (clone sets this up, but
            # be explicit in case the local checkout is in a weird state).
            cmd = (
                f"cd {shlex.quote(repo_dir)} && "
                f"git symbolic-ref HEAD refs/heads/{shlex.quote(base_branch)} 2>/dev/null; "
                f"git commit --allow-empty -m 'Initial commit' 2>&1"
            )
            stdout, _, exit_code = ssh_exec(client, cmd, timeout=10)
            if exit_code != 0:
                print(f"Worktree seed (empty repo) failed: {stdout}")
                return None, None
            print(f"Seeded empty repo {repo_dir} with initial commit on {base_branch}")

        start_point = "HEAD"

    # Create worktree
    cmd = (
        f"mkdir -p $(dirname {shlex.quote(worktree_path)}) && "
        f"cd {shlex.quote(repo_dir)} && "
        f"git worktree add {shlex.quote(worktree_path)} -b {shlex.quote(branch_name)} {start_point} 2>&1"
    )
    stdout, _, exit_code = ssh_exec(client, cmd, timeout=15)
    if exit_code != 0:
        print(f"Worktree creation failed: {stdout}")
        return None, None

    # Symlink node_modules if it exists in the main repo
    cmd = (
        f"[ -d {shlex.quote(repo_dir)}/node_modules ] && "
        f"ln -sf {shlex.quote(repo_dir)}/node_modules {shlex.quote(worktree_path)}/node_modules 2>/dev/null; "
        # Also symlink .venv for Python projects
        f"[ -d {shlex.quote(repo_dir)}/.venv ] && "
        f"ln -sf {shlex.quote(repo_dir)}/.venv {shlex.quote(worktree_path)}/.venv 2>/dev/null; "
        # Copy CLAUDE.md from projects root if it exists
        f"[ -f ~/projects/CLAUDE.md ] && cp ~/projects/CLAUDE.md {shlex.quote(worktree_path)}/CLAUDE.md 2>/dev/null; "
        f"echo OK"
    )
    ssh_exec(client, cmd, timeout=10)

    print(f"Created worktree: {worktree_path} on branch {branch_name}")
    return worktree_path, branch_name


def cleanup_worktree(client, repo_dir, worktree_path):
    """Remove a worktree after the session is done."""
    if not worktree_path or not repo_dir:
        return

    cmd = (
        f"cd {shlex.quote(repo_dir)} && "
        f"git worktree remove --force {shlex.quote(worktree_path)} 2>/dev/null; "
        f"rm -rf {shlex.quote(worktree_path)} 2>/dev/null; "
        f"echo OK"
    )
    ssh_exec(client, cmd, timeout=10)
    print(f"Cleaned up worktree: {worktree_path}")
