"""
POST /servers/{serverId}/git — Git operations on a remote server.
Actions:
  - diff-summary: List changed files with status
  - diff-file: Get diff for a specific file
  - log: Get recent commit log
  - commit: Stage and commit changes
  - create-pr: Create a pull request via gh CLI
"""
import base64
import json
import shlex

from src.lib.auth import extract_auth_header, verify_token
from src.lib.db import get_server, get_session
from src.lib.kms import decrypt
from src.lib.ssh import ssh_connect, ssh_disconnect, ssh_exec
from src.lib.team_auth import can_access_owned_resource


def respond(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def _resolve_workdir(server_id, user_id, body):
    """Returns (workdir, error_response).

    Since Tier 1, every repo-bound session has `worktreePath` set. Sessions
    without one (setup sessions, or scratch sessions with no repo) fall back to
    the shared `~/projects` dir.
    """
    session_id = body.get("sessionId")
    workdir = body.get("workdir") or "~/projects"

    if not session_id:
        return workdir, None

    session = get_session(session_id)
    if not session:
        return None, respond(404, {"error": "Session not found"})
    if not can_access_owned_resource(user_id, session):
        return None, respond(403, {"error": "Not your session"})
    if session.get("serverId") != server_id:
        return None, respond(400, {"error": "Session belongs to a different server"})

    return session.get("worktreePath") or workdir, None


# ── Remote Scripts ─────────────────────────────────────────────────────────────

DIFF_SUMMARY_SCRIPT = r"""
# Ship 1: four-category diff summary.
# Returns { base, branch, ahead, behind, categories: {branch, staged, unstaged, untracked}, files[], totalFiles }.
# `files[]` is a back-compat flattened view the legacy UI still reads; new clients should use `categories`.
import json, os, subprocess, sys

workdir = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/projects")
workdir = os.path.realpath(os.path.expanduser(workdir))

def git(*args):
    try:
        return subprocess.check_output(
            ["git", "-C", workdir] + list(args),
            stderr=subprocess.DEVNULL, text=True
        ).strip()
    except Exception:
        return ""

root = git("rev-parse", "--show-toplevel")
if not root:
    # Not a git repo — scan immediate subdirectories
    import glob
    for d in sorted(glob.glob(os.path.join(workdir, "*", ".git"))):
        candidate = os.path.dirname(d)
        workdir = candidate
        root = subprocess.check_output(
            ["git", "-C", workdir, "rev-parse", "--show-toplevel"],
            stderr=subprocess.DEVNULL, text=True
        ).strip()
        break
    if not root:
        print(json.dumps({"error": "Not a git repository"}))
        raise SystemExit(1)

branch = git("rev-parse", "--abbrev-ref", "HEAD") or None

# ── Resolve base ref: `origin/HEAD` first, fall back to common names. ───────
base = None
symref = git("symbolic-ref", "refs/remotes/origin/HEAD", "--short")
if symref and git("rev-parse", "--verify", symref):
    base = symref
else:
    for candidate in ("origin/main", "origin/master", "origin/develop"):
        if git("rev-parse", "--verify", candidate):
            base = candidate
            break

# ── ahead / behind vs base ───────────────────────────────────────────────────
ahead = 0
behind = 0
if base and branch and branch != "HEAD":
    counts = git("rev-list", "--left-right", "--count", f"{base}...HEAD")
    if counts:
        parts = counts.split()
        if len(parts) == 2:
            try:
                behind, ahead = int(parts[0]), int(parts[1])
            except ValueError:
                pass

# ── Helpers ─────────────────────────────────────────────────────────────────
IGNORE = {"__pycache__", ".pyc", ".pyo", "node_modules", ".DS_Store",
          ".egg-info", ".venv", "venv", ".tox", ".pytest_cache", ".mypy_cache"}

def _ignored(path):
    return any(part in path for part in IGNORE)

def _parse_name_status(raw):
    # Parse `git diff --name-status` output -> list of {path, status}.
    out = []
    for line in raw.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        status = parts[0].strip()
        # R and C come as "R100\told\tnew" — take the new path
        path = parts[-1].strip()
        out.append({"path": path, "status": status[0] if status else "M"})
    return out

def _apply_numstat(raw, entries):
    # Overlay --numstat add/del counts onto a list of entries (by path).
    by_path = {e["path"]: e for e in entries}
    for line in raw.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        added, deleted, path = parts[0], parts[1], parts[-1]
        entry = by_path.get(path)
        if not entry:
            continue
        try:
            entry["additions"] = int(added) if added != "-" else 0
            entry["deletions"] = int(deleted) if deleted != "-" else 0
        except ValueError:
            pass

# ── Category: branch (committed, not upstream) ──────────────────────────────
branch_list = []
if base and ahead > 0:
    merge_base = git("merge-base", base, "HEAD")
    if merge_base:
        branch_list = _parse_name_status(git("diff", "--name-status", merge_base, "HEAD"))
        _apply_numstat(git("diff", "--numstat", merge_base, "HEAD"), branch_list)

# ── Category: staged ────────────────────────────────────────────────────────
staged_list = _parse_name_status(git("diff", "--cached", "--name-status"))
_apply_numstat(git("diff", "--cached", "--numstat"), staged_list)

# ── Category: unstaged ──────────────────────────────────────────────────────
unstaged_list = _parse_name_status(git("diff", "--name-status"))
_apply_numstat(git("diff", "--numstat"), unstaged_list)

# ── Category: untracked ─────────────────────────────────────────────────────
untracked_raw = git("ls-files", "--others", "--exclude-standard")
untracked_list = []
for line in untracked_raw.splitlines():
    path = line.strip()
    if not path or _ignored(path):
        continue
    untracked_list.append({"path": path, "status": "?"})

for lst in (branch_list, staged_list, unstaged_list, untracked_list):
    lst.sort(key=lambda e: e["path"])

# ── Back-compat flat files[] — merged view with legacy flags ────────────────
# Priority when same path shows up in multiple categories: branch > staged > unstaged > untracked.
# This matches the prior UI behavior where committed-to-branch "won" if also dirty.
flat = {}
for e in branch_list:
    flat[e["path"]] = dict(e, staged=True, unstaged=False)
for e in staged_list:
    flat.setdefault(e["path"], dict(e, staged=True, unstaged=False))["staged"] = True
for e in unstaged_list:
    cur = flat.get(e["path"])
    if cur is None:
        flat[e["path"]] = dict(e, staged=False, unstaged=True)
    else:
        cur["unstaged"] = True
for e in untracked_list:
    flat.setdefault(e["path"], dict(e, staged=False, unstaged=False, untracked=True))

result = {
    "base": base,
    "branch": branch,
    "ahead": ahead,
    "behind": behind,
    "categories": {
        "branch": branch_list,
        "staged": staged_list,
        "unstaged": unstaged_list,
        "untracked": untracked_list,
    },
    # Back-compat fields consumed by the current web UI.
    "files": sorted(flat.values(), key=lambda f: f["path"]),
    "totalFiles": len(flat),
}
print(json.dumps(result))
"""

DIFF_FILE_SCRIPT = r"""
# Category-aware per-file diff.
# sys.argv[3] is `category` (branch|staged|unstaged|untracked|auto).
import json, os, subprocess, sys

workdir = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/projects")
file_path = sys.argv[2] if len(sys.argv) > 2 else ""
category = sys.argv[3] if len(sys.argv) > 3 else "auto"
workdir = os.path.realpath(os.path.expanduser(workdir))

if category not in ("branch", "staged", "unstaged", "untracked", "auto"):
    category = "auto"

def git(*args):
    try:
        return subprocess.check_output(
            ["git", "-C", workdir] + list(args),
            stderr=subprocess.DEVNULL, text=True
        ).strip()
    except Exception:
        return ""

root = git("rev-parse", "--show-toplevel")
if not root:
    import glob
    for d in sorted(glob.glob(os.path.join(workdir, "*", ".git"))):
        candidate = os.path.dirname(d)
        workdir = candidate
        root = subprocess.check_output(
            ["git", "-C", workdir, "rev-parse", "--show-toplevel"],
            stderr=subprocess.DEVNULL, text=True
        ).strip()
        break
    if not root:
        print(json.dumps({"error": "Not a git repository"}))
        raise SystemExit(1)

def _base_ref():
    symref = git("symbolic-ref", "refs/remotes/origin/HEAD", "--short")
    if symref and git("rev-parse", "--verify", symref):
        return symref
    for candidate in ("origin/main", "origin/master", "origin/develop"):
        if git("rev-parse", "--verify", candidate):
            return candidate
    return ""

def _untracked_as_diff(path):
    full_path = os.path.join(root, path)
    if not os.path.isfile(full_path):
        return ""
    try:
        with open(full_path, "r") as f:
            content = f.read(200000)
    except Exception:
        return ""
    lines = content.splitlines()
    diff_lines = [f"+{line}" for line in lines]
    return (
        f"--- /dev/null\n+++ b/{path}\n"
        f"@@ -0,0 +1,{len(lines)} @@\n" + "\n".join(diff_lines)
    )

diff = ""

if category == "branch":
    base = _base_ref()
    if base:
        merge_base = git("merge-base", base, "HEAD")
        if merge_base:
            diff = git("diff", merge_base, "HEAD", "--", file_path)

elif category == "staged":
    diff = git("diff", "--cached", "--", file_path)

elif category == "unstaged":
    diff = git("diff", "--", file_path)

elif category == "untracked":
    diff = _untracked_as_diff(file_path)

else:  # auto — legacy fallback: try branch, then staged, then unstaged, then untracked.
    base = _base_ref()
    if base:
        merge_base = git("merge-base", base, "HEAD")
        if merge_base:
            diff = git("diff", merge_base, "HEAD", "--", file_path)
    if not diff:
        diff = git("diff", "--cached", "--", file_path)
    if not diff:
        diff = git("diff", "--", file_path)
    if not diff:
        diff = _untracked_as_diff(file_path)

# Truncate if massive
if len(diff) > 200000:
    diff = diff[:200000] + "\n... (truncated)"

print(json.dumps({"path": file_path, "diff": diff, "category": category}))
"""

GIT_LOG_SCRIPT = r"""
import json, os, subprocess, sys

workdir = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/projects")
count = sys.argv[2] if len(sys.argv) > 2 else "20"
workdir = os.path.realpath(os.path.expanduser(workdir))

def git(*args):
    try:
        return subprocess.check_output(
            ["git", "-C", workdir] + list(args),
            stderr=subprocess.DEVNULL, text=True
        ).strip()
    except Exception:
        return ""

log_raw = git("log", f"-{count}", "--format=%H%n%h%n%s%n%an%n%ai%n---END---")
commits = []
lines = log_raw.split("\n")
i = 0
while i < len(lines):
    if i + 4 >= len(lines):
        break
    full_hash = lines[i].strip()
    short_hash = lines[i+1].strip()
    message = lines[i+2].strip()
    author = lines[i+3].strip()
    date = lines[i+4].strip()
    if full_hash:
        commits.append({
            "hash": full_hash,
            "shortHash": short_hash,
            "message": message,
            "author": author,
            "date": date,
        })
    # skip ---END--- separator
    i += 6

print(json.dumps({"commits": commits}))
"""

GIT_COMMIT_SCRIPT = r"""
import json, os, subprocess, sys

workdir = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/projects")
message = sys.argv[2] if len(sys.argv) > 2 else "Update"
# files to stage: comma-separated or "." for all
stage = sys.argv[3] if len(sys.argv) > 3 else "."
workdir = os.path.realpath(os.path.expanduser(workdir))

def git(*args):
    try:
        result = subprocess.run(
            ["git", "-C", workdir] + list(args),
            capture_output=True, text=True
        )
        return result.stdout.strip(), result.stderr.strip(), result.returncode
    except Exception as e:
        return "", str(e), 1

# Stage files
if stage == ".":
    out, err, code = git("add", "-A")
else:
    for f in stage.split(","):
        f = f.strip()
        if f:
            git("add", "--", f)

# Commit
out, err, code = git("commit", "-m", message)
if code != 0:
    print(json.dumps({"error": err or out or "Commit failed", "success": False}))
    raise SystemExit(1)

# Get the new commit hash
hash_out, _, _ = git("rev-parse", "--short", "HEAD")
branch_out, _, _ = git("rev-parse", "--abbrev-ref", "HEAD")

print(json.dumps({
    "success": True,
    "hash": hash_out,
    "branch": branch_out,
    "message": message,
}))
"""

CREATE_PR_SCRIPT = r"""
import json, os, subprocess, sys

workdir = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/projects")
title = sys.argv[2] if len(sys.argv) > 2 else ""
body = sys.argv[3] if len(sys.argv) > 3 else ""
workdir = os.path.realpath(os.path.expanduser(workdir))

def run(*args, cwd=None):
    try:
        result = subprocess.run(
            list(args), capture_output=True, text=True, cwd=cwd or workdir
        )
        return result.stdout.strip(), result.stderr.strip(), result.returncode
    except Exception as e:
        return "", str(e), 1

# Push current branch
out, err, code = run("git", "-C", workdir, "push", "-u", "origin", "HEAD")
if code != 0:
    print(json.dumps({"error": f"Push failed: {err}", "success": False}))
    raise SystemExit(1)

# Create PR via gh CLI
args = ["gh", "pr", "create", "--fill"]
if title:
    args = ["gh", "pr", "create", "--title", title, "--body", body or ""]

out, err, code = run(*args, cwd=workdir)
if code != 0:
    # Maybe PR already exists
    if "already exists" in err.lower():
        print(json.dumps({"success": True, "message": "PR already exists", "url": ""}))
        raise SystemExit(0)
    print(json.dumps({"error": f"PR creation failed: {err}", "success": False}))
    raise SystemExit(1)

# out should contain the PR URL
print(json.dumps({"success": True, "url": out, "message": "PR created"}))
"""


def _run_remote_script(client, script, args, timeout=25):
    script_b64 = base64.b64encode(script.encode()).decode()
    bootstrap = (
        "import os, base64; "
        "exec(compile(base64.b64decode(os.environ['PE_GIT_SCRIPT']).decode(), '<pe-git>', 'exec'))"
    )

    args_str = " ".join(shlex.quote(a) for a in args)
    cmd = (
        "PYTHON_BIN=$(command -v python3 || command -v python || true); "
        "[ -n \"$PYTHON_BIN\" ] || { "
        "echo '{\"error\":\"Python is required on the remote server\",\"errorCode\":\"missing_python\"}'; "
        "exit 127; }; "
        f"export PE_GIT_SCRIPT={shlex.quote(script_b64)}; "
        f"\"$PYTHON_BIN\" -c {shlex.quote(bootstrap)} {args_str}"
    )

    stdout, stderr, exit_code = ssh_exec(client, cmd, timeout=timeout)
    raw = stdout.strip() or stderr.strip()
    if not raw:
        return None, respond(500, {"error": "Git script returned no output"})

    try:
        return json.loads(raw), None
    except json.JSONDecodeError:
        return None, respond(500, {"error": raw})


def handler(event, context):
    try:
        try:
            claims = verify_token(extract_auth_header(event.get("headers", {})))
        except Exception as exc:
            return respond(401, {"error": str(exc)})

        user_id = claims["sub"]
        server_id = (event.get("pathParameters") or {}).get("serverId")
        if not server_id:
            return respond(400, {"error": "serverId required"})

        body = json.loads(event.get("body") or "{}")
        action = body.get("action")
        if not action:
            return respond(400, {"error": "action required"})

        server = get_server(server_id)
        if not server:
            return respond(404, {"error": "Server not found"})
        if not can_access_owned_resource(user_id, server):
            return respond(403, {"error": "Not your server"})
        if server.get("instanceState") != "running":
            return respond(400, {"error": "Server is not running"})

        public_ip = server.get("publicIp")
        if not public_ip or not server.get("sshPrivateKey"):
            return respond(400, {"error": "Server not ready (no IP or key)"})

        workdir, error = _resolve_workdir(server_id, user_id, body)
        if error:
            return error

        private_key = decrypt(server["sshPrivateKey"])
        username = server.get("sshUser", "ec2-user")
        client = ssh_connect(public_ip, private_key, username=username)

        try:
            if action == "diff-summary":
                result, err = _run_remote_script(client, DIFF_SUMMARY_SCRIPT, [workdir])
                if err:
                    return err
                return respond(200, result)

            elif action == "diff-file":
                file_path = body.get("path", "")
                if not file_path:
                    return respond(400, {"error": "path required"})
                # `category` is optional: branch|staged|unstaged|untracked|auto.
                category = body.get("category") or "auto"
                result, err = _run_remote_script(client, DIFF_FILE_SCRIPT, [workdir, file_path, category])
                if err:
                    return err
                return respond(200, result)

            elif action == "log":
                count = str(body.get("count", 20))
                result, err = _run_remote_script(client, GIT_LOG_SCRIPT, [workdir, count])
                if err:
                    return err
                return respond(200, result)

            elif action == "commit":
                message = body.get("message", "Update from PocketEngineer")
                files = body.get("files", ".")
                result, err = _run_remote_script(client, GIT_COMMIT_SCRIPT, [workdir, message, files])
                if err:
                    return err
                if result.get("error"):
                    return respond(400, result)
                return respond(200, result)

            elif action == "create-pr":
                title = body.get("title", "")
                pr_body = body.get("body", "")
                result, err = _run_remote_script(client, CREATE_PR_SCRIPT, [workdir, title, pr_body], timeout=30)
                if err:
                    return err
                if result.get("error"):
                    return respond(400, result)
                return respond(200, result)

            else:
                return respond(400, {"error": f"Unknown action: {action}"})

        finally:
            ssh_disconnect(client)

    except Exception as exc:
        print(f"[git] Error: {exc}")
        return respond(500, {"error": str(exc)})
