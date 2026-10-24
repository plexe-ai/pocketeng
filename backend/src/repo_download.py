"""
GET /servers/{serverId}/repo/download — Download a file from the remote server.

Binary-safe: streams raw bytes over SSH, returns with Content-Disposition: attachment.
100 MB cap (no inline-view 150 KB cap).
"""
import base64
import json
import os
import re
import shlex
from urllib.parse import quote, unquote

from src.lib.auth import extract_auth_header, verify_token
from src.lib.db import get_server, get_session
from src.lib.kms import decrypt
from src.lib.ssh import ssh_connect, ssh_disconnect, ssh_exec, ssh_exec_bytes

MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024  # 100 MB

REMOTE_DOWNLOAD_SCRIPT = r"""
import json, os, sys

MAX_BYTES = 100 * 1024 * 1024

def emit_error(code, message):
    print(json.dumps({"error": message, "errorCode": code}))
    raise SystemExit(1)

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

import subprocess
def git_output(args, cwd):
    try:
        return subprocess.check_output(
            ["git", "-C", cwd] + args,
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
    except Exception:
        return ""

_args = [a for a in sys.argv[1:] if a != "--"]
primary_anchor = _args[0] if len(_args) > 0 else "~/projects"
fallback_anchor = _args[1] if len(_args) > 1 else ""
requested_path = (_args[2] if len(_args) > 2 else "").strip().replace("\\", "/").lstrip("/")

anchor = choose_anchor(primary_anchor, fallback_anchor)
repo_root = git_output(["rev-parse", "--show-toplevel"], anchor)
root = os.path.realpath(repo_root or anchor)

target = os.path.realpath(os.path.join(root, requested_path))
if target != root and not target.startswith(root + os.sep):
    emit_error("outside_root", "Requested path escapes the repo root")

if not os.path.exists(target):
    emit_error("not_found", "Requested path does not exist")

if os.path.isdir(target):
    emit_error("is_directory", "Cannot download a directory")

size = os.path.getsize(target)
if size > MAX_BYTES:
    emit_error("too_large", f"File is {size} bytes, exceeds {MAX_BYTES} byte limit")

# Write metadata line to stderr, raw bytes to stdout
sys.stderr.write(json.dumps({"name": os.path.basename(target), "size": size}) + "\n")
sys.stderr.flush()

with open(target, "rb") as f:
    while True:
        chunk = f.read(65536)
        if not chunk:
            break
        sys.stdout.buffer.write(chunk)
sys.stdout.buffer.flush()
"""


def respond(status, body, headers=None):
    h = {"Content-Type": "application/json"}
    if headers:
        h.update(headers)
    return {
        "statusCode": status,
        "headers": h,
        "body": json.dumps(body) if isinstance(body, dict) else body,
    }


def _content_disposition(filename: str) -> str:
    # RFC 6266 / 5987: send both an ASCII-fallback `filename=` (for legacy
    # clients) and a percent-encoded `filename*=UTF-8''…` (for modern ones).
    # Without escaping, a filename containing `"` or `\` produces a malformed
    # header that browsers either reject or mangle into a wrong suggested
    # name. The fallback strips control chars + quotes; the * form preserves
    # Unicode.
    ascii_fallback = re.sub(r'[\\"\x00-\x1f\x7f]', "_", filename) or "download"
    encoded = quote(filename, safe="")
    return f"attachment; filename=\"{ascii_fallback}\"; filename*=UTF-8''{encoded}"


def respond_binary(data: bytes, filename: str):
    return {
        "statusCode": 200,
        "headers": {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": _content_disposition(filename),
        },
        "body": base64.b64encode(data).decode(),
        "isBase64Encoded": True,
    }


def _query_value(event, name):
    raw_value = (event.get("queryStringParameters") or {}).get(name)
    if raw_value is None:
        return None
    return unquote(raw_value)


def _resolve_anchor(server_id, user_id, session_id=None):
    fallback_anchor = "~"

    if not session_id:
        return (fallback_anchor, fallback_anchor), None

    session = get_session(session_id)
    if not session:
        return None, respond(404, {"error": "Session not found"})
    if session.get("userId") != user_id:
        return None, respond(403, {"error": "Not your session"})
    if session.get("serverId") != server_id:
        return None, respond(400, {"error": "Session belongs to a different server"})

    primary_anchor = session.get("worktreePath") or session.get("repoDir") or fallback_anchor
    fallback = session.get("repoDir") or fallback_anchor
    return (primary_anchor, fallback), None


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
        if server.get("userId") != user_id:
            return respond(403, {"error": "Not your server"})
        if server.get("instanceState") != "running":
            return respond(400, {"error": "Server is not running"})

        public_ip = server.get("publicIp")
        if not public_ip or not server.get("sshPrivateKey"):
            return respond(400, {"error": "Server not ready (no IP or key)"})

        session_id = _query_value(event, "sessionId")
        requested_path = (_query_value(event, "path") or "").strip()
        if not requested_path:
            return respond(400, {"error": "path query param required"})

        anchors, error_response = _resolve_anchor(server_id, user_id, session_id=session_id)
        if error_response:
            return error_response

        primary_anchor, fallback_anchor = anchors
        private_key = decrypt(server["sshPrivateKey"])
        username = server.get("sshUser", "ec2-user")
        client = ssh_connect(public_ip, private_key, username=username)

        try:
            script_b64 = base64.b64encode(REMOTE_DOWNLOAD_SCRIPT.encode()).decode()
            bootstrap = (
                "import os, base64; "
                "exec(compile(base64.b64decode(os.environ['PE_DL_SCRIPT']).decode(), '<pe-dl>', 'exec'))"
            )
            cmd = (
                "PYTHON_BIN=$(command -v python3 || command -v python || true); "
                '[ -n "$PYTHON_BIN" ] || { '
                'echo \'{"error":"Python is required on the remote server","errorCode":"missing_python"}\'; '
                "exit 127; }; "
                f"export PE_DL_SCRIPT={shlex.quote(script_b64)}; "
                f"\"$PYTHON_BIN\" -c {shlex.quote(bootstrap)} -- "
                f"{shlex.quote(primary_anchor)} "
                f"{shlex.quote(fallback_anchor)} "
                f"{shlex.quote(requested_path)}"
            )

            stdout_bytes, stderr_bytes, exit_code = ssh_exec_bytes(client, cmd, timeout=60)

            if exit_code != 0:
                # The remote script's emit_error() prints structured JSON to
                # STDOUT (line 26 in REMOTE_DOWNLOAD_SCRIPT). Stderr is only
                # used for success-path metadata + any incidental Python
                # warnings. Read stdout first; fall back to stderr only if
                # stdout is empty (e.g. the bootstrap died before emit_error
                # ran). Reversing this order silently downgrades 404/413/400
                # errors to a generic 500 whenever the interpreter writes
                # anything to stderr (deprecation notices, .pth side effects).
                error_text = stdout_bytes.decode(errors="replace").strip() or stderr_bytes.decode(errors="replace").strip()
                try:
                    payload = json.loads(error_text)
                    code = payload.get("errorCode", "")
                    if code == "not_found":
                        return respond(404, {"error": payload.get("error", "File not found")})
                    if code == "outside_root":
                        return respond(400, {"error": payload.get("error", "Path escapes root")})
                    if code == "is_directory":
                        return respond(400, {"error": payload.get("error", "Cannot download a directory")})
                    if code == "too_large":
                        return respond(413, {"error": payload.get("error", "File too large")})
                    return respond(500, {"error": payload.get("error", "Download failed")})
                except json.JSONDecodeError:
                    return respond(500, {"error": error_text[:500]})

            # Parse metadata from stderr
            stderr_text = stderr_bytes.decode(errors="replace").strip()
            filename = requested_path.rsplit("/", 1)[-1] or "download"
            try:
                meta = json.loads(stderr_text.split("\n")[0])
                filename = meta.get("name", filename)
            except (json.JSONDecodeError, IndexError):
                pass

            if len(stdout_bytes) > MAX_DOWNLOAD_BYTES:
                return respond(413, {"error": f"File exceeds {MAX_DOWNLOAD_BYTES} byte limit"})

            return respond_binary(stdout_bytes, filename)

        finally:
            ssh_disconnect(client)

    except Exception as exc:
        print(f"[repo_download] Error: {exc}")
        return respond(500, {"error": str(exc)})
