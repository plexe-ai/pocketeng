"""
Shared core for running Claude Code on a remote server.
Used by both slack_worker and sms_worker.
"""
from __future__ import annotations

import base64
import re
import shlex
import time
from typing import Callable

import boto3

from src.lib.db import get_server, get_servers_by_user, update_server
from src.lib.ec2 import start_instance, describe_instance
from src.lib.kms import decrypt
from src.lib.ssh import ssh_connect, ssh_exec, ssh_disconnect

_ddb = boto3.resource("dynamodb")

RESET_PHRASES = {"new session", "start fresh", "reset", "fresh start", "new chat", "clear session"}


def ensure_github_credentials(client, user_id: str):
    """Write GitHub token + git credentials to the server if not already present.
    Fetches the token from Supabase user metadata via the auth module."""
    try:
        # Check if token already exists on the server
        stdout, _, _ = ssh_exec(client, "[ -f ~/.pocketeng/github_token ] && echo EXISTS || echo MISSING", timeout=5)
        if "EXISTS" in stdout:
            return

        # Get GitHub token from user's server records (any managed server has it from provisioning)
        # Or from the Supabase JWT claims if available
        servers = get_servers_by_user(user_id)
        github_token = None
        github_username = None
        for s in servers:
            # Managed servers store the token in userdata during provisioning
            # But we don't persist it separately. Check if any server already has it on disk.
            pass

        # Fallback: try to get from any managed server that has it
        for s in servers:
            if s.get("envType") == "byos" or not s.get("sshPrivateKey"):
                continue
            live = describe_instance(s["instanceId"])
            if not live or live["state"] != "running" or not live.get("publicIp"):
                continue
            try:
                key = decrypt(s["sshPrivateKey"])
                src_client = ssh_connect(live["publicIp"], key, s.get("sshUser", "ec2-user"), timeout=10)
                try:
                    out, _, _ = ssh_exec(src_client, "cat ~/.pocketeng/github_token 2>/dev/null", timeout=5)
                    if out.strip():
                        github_token = out.strip()
                    out2, _, _ = ssh_exec(src_client, "git config --global user.name 2>/dev/null", timeout=5)
                    if out2.strip():
                        github_username = out2.strip()
                finally:
                    ssh_disconnect(src_client)
                if github_token:
                    break
            except Exception:
                continue

        if not github_token:
            return

        # Write to the target server
        cmds = [
            "mkdir -p ~/.pocketeng",
            f"echo {shlex.quote(github_token)} > ~/.pocketeng/github_token",
            "chmod 600 ~/.pocketeng/github_token",
            f"export GH_TOKEN={shlex.quote(github_token)}",
        ]
        if github_username:
            cmds.append(f"git config --global user.name {shlex.quote(github_username)}")
            cmds.append(f"git config --global credential.helper store")
            cmds.append(f"echo 'https://{github_username}:{github_token}@github.com' > ~/.git-credentials")
            cmds.append("chmod 600 ~/.git-credentials")
        ssh_exec(client, " && ".join(cmds), timeout=15)
    except Exception as e:
        print(f"ensure_github_credentials failed (non-fatal): {e}")

_REPO_PATTERN = re.compile(
    r'(?:(?:https?://)?github\.com/)?([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)'
)


# ── Session persistence (generic — caller provides table + key) ──────────────

class SessionStore:
    """Wraps DynamoDB session get/save/clear for any table + partition key."""

    def __init__(self, table_name: str, key_name: str, key_value: str):
        self._table = _ddb.Table(table_name)
        self._key = {key_name: key_value}

    def ensure_map(self):
        try:
            self._table.update_item(
                Key=self._key,
                UpdateExpression="SET sessions = if_not_exists(sessions, :empty)",
                ExpressionAttributeValues={":empty": {}},
            )
        except Exception:
            pass

    def get(self, server_id: str) -> str | None:
        resp = self._table.get_item(Key=self._key)
        sessions = resp.get("Item", {}).get("sessions", {})
        if isinstance(sessions, dict):
            return sessions.get(server_id)
        return None

    def save(self, server_id: str, session_id: str):
        self._table.update_item(
            Key=self._key,
            UpdateExpression="SET sessions.#sid = :val",
            ExpressionAttributeNames={"#sid": server_id},
            ExpressionAttributeValues={":val": session_id},
        )

    def clear(self, server_id: str):
        try:
            self._table.update_item(
                Key=self._key,
                UpdateExpression="REMOVE sessions.#sid",
                ExpressionAttributeNames={"#sid": server_id},
            )
        except Exception:
            pass


# ── Server discovery ─────────────────────────────────────────────────────────

def find_server_by_label(user_id: str, label: str) -> tuple:
    """Find a server by label (case-insensitive fuzzy match). Returns (server_dict, needs_start)."""
    servers = get_servers_by_user(user_id)
    active = [s for s in servers if s.get("instanceState") != "terminated" and s.get("sshPrivateKey")]
    label_lower = label.lower().strip()

    # Exact match first
    for s in active:
        if (s.get("label") or "").lower() == label_lower:
            return _resolve_server_state(s)

    # Prefix/substring match
    for s in active:
        if label_lower in (s.get("label") or "").lower():
            return _resolve_server_state(s)

    return None, False


def _resolve_server_state(server: dict) -> tuple:
    """Check live EC2 state for a server. Returns (server_dict, needs_start)."""
    if server.get("envType") == "byos":
        return server, False
    live = describe_instance(server["instanceId"])
    if not live:
        return None, False
    if live["state"] == "running" and live.get("publicIp"):
        server["publicIp"] = live["publicIp"]
        server["instanceState"] = "running"
        return server, False
    if live["state"] in ("stopped", "stopping"):
        return server, True
    return None, False


def find_server_by_id(server_id: str) -> tuple:
    """Find a specific server by ID. Returns (server_dict, needs_start)."""
    server = get_server(server_id)
    if not server or not server.get("sshPrivateKey"):
        return None, False

    if server.get("envType") == "byos":
        return server, False

    live = describe_instance(server["instanceId"])
    if not live:
        return None, False

    if live["state"] != server.get("instanceState"):
        update_server(server["serverId"], {
            "instanceState": live["state"],
            "publicIp": live.get("publicIp"),
        })

    if live["state"] == "running" and live.get("publicIp"):
        server["publicIp"] = live["publicIp"]
        server["instanceState"] = "running"
        return server, False

    if live["state"] in ("stopped", "stopping"):
        return server, True

    return None, False


def find_any_server(user_id: str) -> tuple:
    """Find any usable server for a user. Returns (server_dict, needs_start)."""
    servers = get_servers_by_user(user_id)
    active = [s for s in servers if s.get("instanceState") != "terminated"]

    for s in active:
        if not s.get("sshPrivateKey"):
            continue
        if s.get("envType") == "byos":
            return s, False
        live = describe_instance(s["instanceId"])
        if not live:
            continue
        if live["state"] == "running" and live.get("publicIp"):
            s["publicIp"] = live["publicIp"]
            s["instanceState"] = "running"
            return s, False
        if live["state"] in ("stopped", "stopping"):
            return s, True

    return None, False


# ── EC2 lifecycle helpers ────────────────────────────────────────────────────

def wait_for_stopped(server: dict, max_wait: int = 120) -> bool:
    instance_id = server["instanceId"]
    deadline = time.time() + max_wait
    while time.time() < deadline:
        time.sleep(5)
        live = describe_instance(instance_id)
        if live and live["state"] in ("stopped", "running"):
            return True
    return False


def wait_for_running(server: dict, max_wait: int = 180) -> dict | None:
    instance_id = server["instanceId"]
    deadline = time.time() + max_wait
    ip = None

    while time.time() < deadline:
        time.sleep(10)
        live = describe_instance(instance_id)
        if live and live["state"] == "running" and live.get("publicIp"):
            ip = live["publicIp"]
            update_server(server["serverId"], {
                "instanceState": "running",
                "publicIp": ip,
            })
            break

    if not ip:
        return None

    private_key_pem = decrypt(server["sshPrivateKey"])
    ssh_user = server.get("sshUser", "ec2-user")
    while time.time() < deadline:
        try:
            client = ssh_connect(ip, private_key_pem, ssh_user, timeout=5)
            ssh_disconnect(client)
            break
        except Exception:
            time.sleep(5)

    return {**server, "instanceState": "running", "publicIp": ip}


# ── Auto-start ───────────────────────────────────────────────────────────────

def auto_start_server(server: dict, reply: Callable[[str], None]) -> dict | None:
    """Start a stopped server. Sends status messages via reply(). Returns updated server or None."""
    live = describe_instance(server["instanceId"])
    if live and live["state"] == "stopping":
        reply("Workspace is shutting down, waiting to restart...")
        if not wait_for_stopped(server):
            reply("Workspace stuck. Try again in a minute.")
            return None

    reply("Starting your workspace... ~1 min.")
    start_instance(server["instanceId"])
    update_server(server["serverId"], {"instanceState": "pending"})

    server = wait_for_running(server)
    if not server:
        reply("Workspace failed to start in time.")
        return None
    return server


# ── Repo detection & cloning ─────────────────────────────────────────────────

def detect_repos(text: str) -> list[str]:
    matches = _REPO_PATTERN.findall(text)
    repos = []
    seen = set()
    for m in matches:
        if '/' not in m:
            continue
        owner, name = m.split('/', 1)
        if owner.startswith('.') or name.startswith('.'):
            continue
        if m.lower() not in seen:
            seen.add(m.lower())
            repos.append(m)
    return repos


def clone_repos(client, repos: list[str]) -> list[str]:
    cloned = []
    for repo in repos:
        name = repo.split('/')[-1]
        stdout, _, _ = ssh_exec(client, f"test -d ~/projects/{shlex.quote(name)} && echo YES || echo NO")
        if stdout.strip() == "YES":
            continue
        _, _, exit_code = ssh_exec(
            client,
            f"bash -l -c {shlex.quote(f'cd ~/projects && git clone https://github.com/{repo}.git')}",
            timeout=60,
        )
        if exit_code == 0:
            cloned.append(repo)
    return cloned


# ── Run Claude via SSH ───────────────────────────────────────────────────────

def run_claude(server: dict, prompt: str, prev_session_id: str | None = None,
               workdir: str = "~/projects") -> tuple[str, str | None]:
    """
    SSH into server, run Claude Code with the prompt, return (output, new_session_id).
    """
    private_key_pem = decrypt(server["sshPrivateKey"])
    ssh_user = server.get("sshUser", "ec2-user")
    client = ssh_connect(server["publicIp"], private_key_pem, ssh_user)

    try:
        prompt_b64 = base64.b64encode(prompt.encode()).decode()
        resume_flag = ""
        if prev_session_id:
            resume_flag = f"--resume {shlex.quote(prev_session_id)} "
            print(f"Resuming session: {prev_session_id}")

        cmd = (
            f"cd {shlex.quote(workdir)} 2>/dev/null || cd ~/projects; "
            f"echo {shlex.quote(prompt_b64)} | base64 -d | "
            f"claude --print --dangerously-skip-permissions --verbose {resume_flag}2>&1"
        )
        print(f"CMD: {cmd[:200]}")

        stdout, stderr, exit_code = ssh_exec(
            client,
            f"bash -l -c {shlex.quote(cmd)}",
            timeout=270,
        )

        new_session_id = _extract_session_from_server(client, prev_session_id)

        raw = stdout.strip() or stderr.strip() or "(no output)"
        raw = strip_verbose_lines(raw)
        return raw, new_session_id

    finally:
        ssh_disconnect(client)


# ── Output helpers ───────────────────────────────────────────────────────────

def _extract_session_from_server(client, prev_session_id: str | None) -> str | None:
    """Find the latest Claude session ID from ~/.claude/projects/*/*.jsonl"""
    cmd = "ls -t ~/.claude/projects/*/*.jsonl 2>/dev/null | head -1"
    stdout, _, _ = ssh_exec(client, cmd, timeout=5)
    path = stdout.strip()

    if path:
        filename = path.split('/')[-1]
        session_id = filename.replace('.jsonl', '')
        if session_id and len(session_id) > 8:
            print(f"Found session: {session_id} from {path}")
            return session_id

    return prev_session_id


def strip_verbose_lines(output: str) -> str:
    """Remove Claude --verbose metadata lines from output."""
    lines = output.split('\n')
    filtered = []
    for line in lines:
        if line.startswith('Session:') or line.startswith('Model:'):
            continue
        if line.startswith('Context:') or line.startswith('Cost:'):
            continue
        if line.startswith('Duration:') or line.startswith('Tools:'):
            continue
        filtered.append(line)
    while filtered and not filtered[0].strip():
        filtered.pop(0)
    while filtered and not filtered[-1].strip():
        filtered.pop()
    return '\n'.join(filtered)
