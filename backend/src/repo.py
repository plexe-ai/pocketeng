"""
GET /servers/{serverId}/repo — Browse a session worktree or repo on the remote server.
Query params:
  - sessionId: optional persisted backend session id
  - path: optional relative path within the resolved repo root
  - workdir: optional fallback working directory when no session root is available
"""
import base64
import json
import shlex
from urllib.parse import unquote

from src.lib.auth import extract_auth_header, verify_token
from src.lib.db import get_server, get_session
from src.lib.kms import decrypt
from src.lib.ssh import ssh_connect, ssh_disconnect, ssh_exec
from src.lib.team_auth import can_access_owned_resource


REMOTE_REPO_BROWSER_SCRIPT = r"""
import json
import os
import pathlib
import subprocess
import sys

MAX_FILE_BYTES = 150000


def emit(payload, exit_code=0):
    print(json.dumps(payload))
    raise SystemExit(exit_code)


def emit_error(code, message, exit_code=1):
    emit({"error": message, "errorCode": code}, exit_code=exit_code)


def normalize_candidate(raw_value):
    if not raw_value:
        return None
    expanded = os.path.realpath(os.path.expanduser(raw_value))
    if os.path.exists(expanded):
        if os.path.isfile(expanded):
            return os.path.dirname(expanded)
        return expanded
    return None


def choose_anchor(primary, fallback):
    for candidate in (primary, fallback, "~/projects", "~"):
        resolved = normalize_candidate(candidate)
        if resolved:
            return resolved
    emit_error("not_found", "Could not resolve a working directory")


def git_output(args, cwd):
    try:
        return subprocess.check_output(
            ["git", "-C", cwd] + args,
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
    except Exception:
        return ""


def relative_to_root(path, root):
    rel = os.path.relpath(path, root)
    if rel == ".":
        return ""
    return rel.replace(os.sep, "/")


def summarize_status(code):
    if code == "??":
        return "untracked"
    if "R" in code:
        return "renamed"
    if "D" in code:
        return "deleted"
    if "A" in code:
        return "added"
    if "M" in code or "U" in code or "T" in code:
        return "modified"
    return "modified"


def collect_git_statuses(root, is_git_repo):
    if not is_git_repo:
        return {}

    output = git_output(["status", "--porcelain=1", "--untracked-files=all"], root)
    statuses = {}
    for line in output.splitlines():
        if len(line) < 4:
            continue
        code = line[:2]
        raw_path = line[3:]
        if " -> " in raw_path:
            raw_path = raw_path.split(" -> ", 1)[1]
        normalized = raw_path.replace("\\", "/").lstrip("./")
        statuses[normalized] = summarize_status(code)
    return statuses


def status_for_path(path, kind, statuses):
    if kind == "file":
        return statuses.get(path)

    prefix = path.rstrip("/")
    if prefix:
        prefix += "/"
    matches = {
        status
        for changed_path, status in statuses.items()
        if changed_path == path or changed_path.startswith(prefix)
    }
    if not matches:
        return None
    if len(matches) == 1:
        return next(iter(matches))
    return "mixed"


def breadcrumbs_for(path):
    crumbs = [{"name": "workspace", "path": ""}]
    if not path:
        return crumbs

    parts = [part for part in path.split("/") if part]
    current = []
    for part in parts:
        current.append(part)
        crumbs.append({"name": part, "path": "/".join(current)})
    return crumbs


def list_directory(target, root, statuses):
    entries = []
    seen = set()

    for item in sorted(
        os.scandir(target),
        key=lambda entry: (not entry.is_dir(follow_symlinks=False), entry.name.lower()),
    ):
        if item.name == ".git":
            continue

        rel_path = relative_to_root(item.path, root)
        seen.add(rel_path)
        kind = "directory" if item.is_dir(follow_symlinks=False) else "file"
        size = None
        if kind == "file":
            try:
                size = item.stat(follow_symlinks=False).st_size
            except OSError:
                size = None

        entries.append({
            "name": item.name,
            "path": rel_path,
            "kind": kind,
            "size": size,
            "gitStatus": status_for_path(rel_path, kind, statuses),
        })

    current_path = relative_to_root(target, root)
    for rel_path, status in statuses.items():
        if status != "deleted" or rel_path in seen:
            continue
        parent = pathlib.PurePosixPath(rel_path).parent.as_posix()
        normalized_parent = "" if parent == "." else parent
        if normalized_parent != current_path:
            continue

        entries.append({
            "name": pathlib.PurePosixPath(rel_path).name,
            "path": rel_path,
            "kind": "file",
            "size": None,
            "gitStatus": status,
        })

    entries.sort(key=lambda entry: (entry["kind"] != "directory", entry["name"].lower()))
    return entries


def read_file(target, root, statuses):
    try:
        size = os.path.getsize(target)
    except OSError:
        size = None

    with open(target, "rb") as handle:
        data = handle.read(MAX_FILE_BYTES + 1)

    truncated = len(data) > MAX_FILE_BYTES
    if truncated:
        data = data[:MAX_FILE_BYTES]

    is_binary = b"\x00" in data
    content = None if is_binary else data.decode("utf-8", errors="replace")
    rel_path = relative_to_root(target, root)

    return {
        "kind": "file",
        "name": os.path.basename(target),
        "rootPath": root,
        "currentPath": rel_path,
        "breadcrumbs": breadcrumbs_for(rel_path),
        "size": size,
        "gitStatus": status_for_path(rel_path, "file", statuses),
        "binary": is_binary,
        "truncated": truncated,
        "content": content,
    }


_args = [a for a in sys.argv[1:] if a != "--"]
primary_anchor = _args[0] if len(_args) > 0 else "~/projects"
fallback_anchor = _args[1] if len(_args) > 1 else ""
requested_path = (_args[2] if len(_args) > 2 else "").strip().replace("\\", "/").lstrip("/")

anchor = choose_anchor(primary_anchor, fallback_anchor)
repo_root = git_output(["rev-parse", "--show-toplevel"], anchor)
root = os.path.realpath(repo_root or anchor)
is_git_repo = bool(repo_root)
branch = git_output(["rev-parse", "--abbrev-ref", "HEAD"], root) if is_git_repo else ""
statuses = collect_git_statuses(root, is_git_repo)

target = os.path.realpath(os.path.join(root, requested_path))
if target != root and not target.startswith(root + os.sep):
    emit_error("outside_root", "Requested path escapes the repo root")

if not os.path.exists(target):
    emit_error("not_found", "Requested path does not exist")

payload = {
    "rootPath": root,
    "repoRoot": repo_root or root,
    "currentPath": relative_to_root(target, root),
    "branch": branch or None,
    "isGitRepo": is_git_repo,
}

if os.path.isdir(target):
    payload.update({
        "kind": "directory",
        "name": os.path.basename(target.rstrip(os.sep)) or pathlib.Path(root).name or "workspace",
        "breadcrumbs": breadcrumbs_for(payload["currentPath"]),
        "entries": list_directory(target, root, statuses),
    })
    emit(payload)

payload.update(read_file(target, root, statuses))
emit(payload)
"""


def respond(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def _query_value(event, name):
    raw_value = (event.get("queryStringParameters") or {}).get(name)
    if raw_value is None:
        return None
    return unquote(raw_value)


def _resolve_anchor(server_id, user_id, session_id=None, workdir=None):
    fallback_anchor = workdir or "~"

    if not session_id:
        return (fallback_anchor, fallback_anchor), None

    session = get_session(session_id)
    if not session:
        return None, respond(404, {"error": "Session not found"})
    if not can_access_owned_resource(user_id, session):
        return None, respond(403, {"error": "Not your session"})
    if session.get("serverId") != server_id:
        return None, respond(400, {"error": "Session belongs to a different server"})

    primary_anchor = session.get("worktreePath") or session.get("repoDir") or fallback_anchor
    fallback = session.get("repoDir") or fallback_anchor
    return (primary_anchor, fallback), None


def _build_remote_command(primary_anchor, fallback_anchor, requested_path):
    script_b64 = base64.b64encode(REMOTE_REPO_BROWSER_SCRIPT.encode()).decode()
    bootstrap = (
        "import os, base64; "
        "exec(compile(base64.b64decode(os.environ['PE_REPO_BROWSER']).decode(), '<pe-repo-browser>', 'exec'))"
    )

    return (
        "PYTHON_BIN=$(command -v python3 || command -v python || true); "
        "[ -n \"$PYTHON_BIN\" ] || { "
        "echo '{\"error\":\"Python is required on the remote server\",\"errorCode\":\"missing_python\"}'; "
        "exit 127; }; "
        f"export PE_REPO_BROWSER={shlex.quote(script_b64)}; "
        f"\"$PYTHON_BIN\" -c {shlex.quote(bootstrap)} -- "
        f"{shlex.quote(primary_anchor)} "
        f"{shlex.quote(fallback_anchor)} "
        f"{shlex.quote(requested_path)}"
    )


def _run_remote_repo_browser(client, primary_anchor, fallback_anchor, requested_path):
    stdout, stderr, exit_code = ssh_exec(
        client,
        _build_remote_command(primary_anchor, fallback_anchor, requested_path),
        timeout=25,
    )

    raw_output = stdout.strip() or stderr.strip()
    if not raw_output:
        return None, 500, {"error": "Repo browser returned no output"}

    try:
        payload = json.loads(raw_output)
    except json.JSONDecodeError:
        return None, 500, {"error": raw_output}

    if exit_code == 0:
        return payload, None, None

    code = payload.get("errorCode")
    if code == "not_found":
        return None, 404, {"error": payload.get("error", "Requested path not found")}
    if code == "outside_root":
        return None, 400, {"error": payload.get("error", "Requested path escapes the repo root")}
    return None, 500, {"error": payload.get("error", "Repo browser failed")}


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

        session_id = _query_value(event, "sessionId")
        requested_path = (_query_value(event, "path") or "").strip()
        workdir = _query_value(event, "workdir")

        anchors, error_response = _resolve_anchor(
            server_id,
            user_id,
            session_id=session_id,
            workdir=workdir,
        )
        if error_response:
            return error_response

        primary_anchor, fallback_anchor = anchors
        private_key = decrypt(server["sshPrivateKey"])
        username = server.get("sshUser", "ec2-user")
        client = ssh_connect(public_ip, private_key, username=username)

        try:
            payload, error_status, error_body = _run_remote_repo_browser(
                client,
                primary_anchor,
                fallback_anchor,
                requested_path,
            )
            if error_body:
                return respond(error_status, error_body)
            return respond(200, payload)
        finally:
            ssh_disconnect(client)

    except Exception as exc:
        print(f"[repo] Error: {exc}")
        return respond(500, {"error": str(exc)})
