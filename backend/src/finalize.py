"""
POST /servers/{serverId}/finalize — Drive a freshly-provisioned workspace to
"ready". Idempotent; safe to call many times.

This is the single source of truth for "is the workspace usable?". A workspace
is ready when:
  1. EC2 is running with a public IP
  2. SSH is reachable
  3. Userdata has finished (~/.pocketeng-ready marker exists — agent CLIs
     installed, base packages present)
  4. Every configured agent has its API key on disk at ~/.pocketeng/<agent>_key
     (pushed from our DynamoDB credential store)
  5. Every configured agent passes an auth verify (e.g. `claude auth status`
     reports `loggedIn: true` when ANTHROPIC_API_KEY is exported)

The readiness state is written back to the server record so the UI can poll
GET /servers/{id} to show live progress and unlock the "Open" button.

Invocation paths:
  - Async from ProvisionFunction right after `put_server` (via lambda.invoke
    with InvocationType='Event') — the workspace primes itself in the
    background while the HTTP provision response returns immediately.
  - Explicit retry via POST /servers/{id}/finalize (e.g. if userdata failed
    and the user reconnected agents).
"""
import json
import os
import time
import traceback
from datetime import datetime, timezone

from src.lib.agent_credentials_sync import push_credentials_for_user
from src.lib.auth import extract_auth_header, verify_token
from src.lib.db import get_server, update_server
from src.lib.ec2 import describe_instance
from src.lib.email import send_email
from src.lib.email_templates import workspace_ready as render_workspace_ready
from src.lib.kms import decrypt
from src.lib.ssh import ssh_connect, ssh_disconnect, ssh_exec
from src.lib.supabase_admin import get_user_info

# Total wall-clock budget for one finalize pass. Userdata on Amazon Linux
# 2023 with our package set typically completes in 60-120s. We keep headroom
# for slow network but cap well under the 300s Lambda timeout.
_MAX_SECONDS = 240
_POLL_INTERVAL = 5


def _now():
    return datetime.now(timezone.utc).isoformat()


def _write_readiness(server_id: str, patch: dict) -> dict:
    """Merge-update the readiness object. Returns the new readiness."""
    srv = get_server(server_id) or {}
    current = srv.get("readiness") or {}
    # Shallow-merge top level; deep-merge the agents dict specifically.
    merged = dict(current)
    for k, v in patch.items():
        if k == "agents" and isinstance(v, dict):
            merged_agents = dict(current.get("agents") or {})
            for aid, astate in v.items():
                prev = merged_agents.get(aid) or {}
                merged_agents[aid] = {**prev, **astate}
            merged["agents"] = merged_agents
        else:
            merged[k] = v
    merged["updatedAt"] = _now()
    update_server(server_id, {"readiness": merged})
    return merged


def respond(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def handler(event, context):
    """Two invocation paths:
      - API Gateway: authenticated HTTP (user retry). event has headers/path.
      - Lambda-to-Lambda async: event is {serverId, userId} — no auth needed
        because the invoker is our own ProvisionFunction behind IAM.
    """
    try:
        server_id = None
        user_id = None

        if "pathParameters" in event and event.get("pathParameters"):
            # HTTP invocation
            try:
                claims = verify_token(extract_auth_header(event.get("headers", {})))
            except Exception as e:
                return respond(401, {"error": str(e)})
            user_id = claims["sub"]
            server_id = event["pathParameters"].get("serverId")
            if not server_id:
                return respond(400, {"error": "serverId required"})
        else:
            # Internal async invocation
            server_id = event.get("serverId")
            user_id = event.get("userId")
            if not server_id or not user_id:
                print(f"finalize: bad internal event: {event}")
                return {"error": "serverId+userId required"}

        server = get_server(server_id)
        if not server:
            return respond(404, {"error": "server not found"})
        if server.get("userId") != user_id:
            return respond(403, {"error": "not your server"})

        # Already done? No-op.
        readiness = server.get("readiness") or {}
        if readiness.get("status") == "ready":
            return respond(200, {"readiness": readiness})

        result = _finalize(server)
        return respond(200, {"readiness": result})

    except Exception as e:
        print(f"finalize: unhandled error: {e}\n{traceback.format_exc()}")
        try:
            if server_id:
                _write_readiness(server_id, {
                    "status": "failed",
                    "stage": "error",
                    "error": str(e)[:500],
                })
        except Exception:
            pass
        return respond(500, {"error": str(e)})


def _finalize(server: dict) -> dict:
    """Drive the state machine to completion (or failure)."""
    server_id = server["serverId"]
    user_id = server["userId"]
    agents = server.get("agents") or []

    # Initialize per-agent state if missing.
    agents_state = {a: {"installed": None, "authenticated": None, "error": None}
                    for a in agents}
    _write_readiness(server_id, {
        "status": "installing",
        "stage": "awaiting-ip",
        "agents": agents_state,
        "error": None,
    })

    deadline = time.time() + _MAX_SECONDS

    # ── Stage 1: wait for EC2 running + public IP ─────────────────────────
    instance_id = server.get("instanceId")
    public_ip = server.get("publicIp")
    ssh_user = server.get("sshUser") or "ec2-user"
    while not public_ip and time.time() < deadline:
        live = describe_instance(instance_id) if instance_id else None
        if live and live.get("state") == "running" and live.get("publicIp"):
            public_ip = live["publicIp"]
            update_server(server_id, {
                "instanceState": "running",
                "publicIp": public_ip,
            })
            break
        time.sleep(_POLL_INTERVAL)

    if not public_ip:
        return _write_readiness(server_id, {
            "status": "failed",
            "stage": "awaiting-ip",
            "error": "EC2 did not acquire a public IP before the finalize deadline",
        })

    # ── Stage 2: wait for SSH to accept connections ───────────────────────
    _write_readiness(server_id, {"stage": "awaiting-ssh"})

    try:
        private_key = decrypt(server["sshPrivateKey"])
    except Exception as e:
        return _write_readiness(server_id, {
            "status": "failed", "stage": "awaiting-ssh",
            "error": f"decrypt ssh key: {e}",
        })

    client = None
    while client is None and time.time() < deadline:
        try:
            client = ssh_connect(public_ip, private_key, username=ssh_user, timeout=10)
        except Exception:
            time.sleep(_POLL_INTERVAL)

    if client is None:
        return _write_readiness(server_id, {
            "status": "failed", "stage": "awaiting-ssh",
            "error": "SSH never reachable before deadline",
        })

    try:
        # ── Stage 3: wait for userdata marker ─────────────────────────────
        _write_readiness(server_id, {"stage": "installing-agents"})
        while time.time() < deadline:
            stdout, _, code = ssh_exec(
                client,
                "test -f ~/.pocketeng-ready && echo READY || echo WAIT",
                timeout=8,
            )
            if "READY" in stdout:
                break
            time.sleep(_POLL_INTERVAL)
        else:
            return _write_readiness(server_id, {
                "status": "failed", "stage": "installing-agents",
                "error": "userdata did not finish before deadline "
                         "(check /var/log/pocketeng-setup.log on the host)",
            })

        # Report which binaries exist. Useful diag even when auth fails.
        for agent in agents:
            binary = _binary_for(agent)
            stdout, _, _ = ssh_exec(client, f"which {binary} 2>/dev/null", timeout=5)
            agents_state[agent]["installed"] = bool(stdout.strip())
        _write_readiness(server_id, {"agents": agents_state})

        # ── Stage 4: push credentials from DynamoDB → ~/.pocketeng/*_key ─
        _write_readiness(server_id, {
            "status": "authenticating",
            "stage": "pushing-credentials",
        })
        push_results = push_credentials_for_user(client, user_id, agents=agents)
        for agent in agents:
            r = push_results.get(agent, "skipped:no-credential-stored")
            agents_state[agent]["credentialStatus"] = r

        # ── Stage 5: verify each agent authenticates ─────────────────────
        # NOTE: auth failure is NOT treated as a finalize failure anymore.
        # With subscription-login, users complete the browser flow AFTER the
        # workspace is provisioned (we route the login through this same
        # EC2 via agent_login.py). The workspace is "ready" the moment the
        # CLIs are installed; each agent's `authenticated` flag is an
        # independent field the UI surfaces per-agent so the user knows
        # which Connect buttons they still need to click. The old behavior
        # (failing the whole provision on one missing API key) was a leftover
        # from the API-key-only era.
        _write_readiness(server_id, {"stage": "verifying-auth", "agents": agents_state})
        for agent in agents:
            ok, detail = _verify_agent(client, agent)
            agents_state[agent]["authenticated"] = ok
            # "not yet connected" is a soft state — surface as null error so
            # the UI distinguishes between "you need to click Connect" and
            # "something actually went wrong".
            agents_state[agent]["error"] = None if ok else detail
            if not ok and "no API key on host" in (detail or ""):
                agents_state[agent]["needsLogin"] = True
        _write_readiness(server_id, {"agents": agents_state})

        # Workspace just hit "ready" — fire the transactional email.
        # Best-effort: failures here MUST NOT block the readiness flip
        # (the user is more interested in their workspace working than
        # in our email going through). Idempotent via a per-server flag
        # so retries / replays don't double-send.
        try:
            _maybe_send_workspace_ready_email(server)
        except Exception as exc:
            # Defensive — anything email-side falls through to log only.
            print(f"finalize: workspace-ready email failed for {server_id}: {exc}")

        return _write_readiness(server_id, {
            "status": "ready",
            "stage": "done",
            "error": None,
        })

    finally:
        ssh_disconnect(client)


def _maybe_send_workspace_ready_email(server: dict) -> None:
    """Fire the transactional "your workspace is ready" email once per
    server. Idempotent via a `workspaceReadyEmailSent` flag persisted on
    the server record.

    Best-effort throughout — any failure here is swallowed by the caller
    so the readiness=ready transition still completes. Reasons we might
    skip silently:
      - Flag already set (this is a re-run, e.g. a manual finalize retry)
      - SUPABASE_SERVICE_ROLE_KEY unset (we can't look up the user's email)
      - RESEND_API_KEY unset (early-deploy environments before DNS lands)
      - Resend rejects the send (unverified domain, rate limit, etc.)
    """
    if server.get("workspaceReadyEmailSent"):
        return  # Idempotent — finalize is safe to retry without spam.

    user_id = server.get("userId")
    if not user_id:
        return

    email, name = get_user_info(user_id)
    if not email:
        # No email = nothing to send. Most common cause: SUPABASE_SERVICE_ROLE_KEY
        # not configured on this Lambda (lookup helper logs that case).
        return

    workspace_label = server.get("label") or "Your cloud workspace"
    subject, html, text = render_workspace_ready(
        name=name,
        workspace_label=workspace_label,
        dashboard_url=f"https://console.pocketeng.ai/dashboard/{server['serverId']}",
    )
    sent = send_email(email, subject, html, text=text)
    if sent:
        # Lock in the flag so a finalize retry doesn't re-send.
        try:
            update_server(server["serverId"], {
                "workspaceReadyEmailSent": True,
                "workspaceReadyEmailSentAt": _now(),
            })
        except Exception as exc:
            # Flag write failed but email already went out — small risk
            # of a duplicate on retry. Acceptable; finalize retries are
            # rare in practice.
            print(f"finalize: failed to persist workspaceReadyEmailSent: {exc}")


def _binary_for(agent: str) -> str:
    return {
        "claude": "claude",
        "codex": "codex",
        "cursor": "cursor-agent",
        "opencode": "opencode",
    }.get(agent, agent)


def _verify_agent(client, agent: str) -> tuple[bool, str]:
    """Run a cheap auth check for *agent* over SSH.

    The script mirrors what script_builder does at session launch: source the
    API-key file and export it as the agent's env var, then run a built-in
    status command / API ping.

    Returns (ok, detail). `detail` is a short string for UI surfacing.
    """
    if agent == "claude":
        cmd = (
            "set +e; "
            "[ -f ~/.pocketeng/anthropic_key ] || { echo MISSING_KEY_FILE; exit 0; }; "
            "export ANTHROPIC_API_KEY=$(tr -d ' \\n\\r' < ~/.pocketeng/anthropic_key); "
            "[ -n \"$ANTHROPIC_API_KEY\" ] || { echo EMPTY_KEY; exit 0; }; "
            "claude auth status 2>&1"
        )
        stdout, stderr, _ = ssh_exec(client, cmd, timeout=20)
        text = (stdout or "") + (stderr or "")
        if "MISSING_KEY_FILE" in text:
            return False, "no API key on host — credential push failed"
        if "EMPTY_KEY" in text:
            return False, "API key file is empty"
        if '"loggedIn": true' in text or '"loggedIn":true' in text:
            return True, "ok"
        return False, f"claude auth status returned: {text[:200]}"

    if agent == "codex":
        # Codex CLI has no `auth status` command. Verify the key with a cheap
        # GET /v1/models ping (no spend, no state change). 200 = authenticated.
        cmd = (
            "set +e; "
            "[ -f ~/.pocketeng/openai_key ] || { echo MISSING_KEY_FILE; exit 0; }; "
            "export OPENAI_API_KEY=$(tr -d ' \\n\\r' < ~/.pocketeng/openai_key); "
            "[ -n \"$OPENAI_API_KEY\" ] || { echo EMPTY_KEY; exit 0; }; "
            "curl -sS -o /dev/null -w 'HTTP_%{http_code}\\n' "
            "  -H \"Authorization: Bearer $OPENAI_API_KEY\" "
            "  https://api.openai.com/v1/models"
        )
        stdout, stderr, _ = ssh_exec(client, cmd, timeout=20)
        text = (stdout or "") + (stderr or "")
        if "MISSING_KEY_FILE" in text:
            return False, "no API key on host — credential push failed"
        if "EMPTY_KEY" in text:
            return False, "API key file is empty"
        if "HTTP_200" in text:
            return True, "ok"
        return False, f"openai ping: {text.strip()[:200]}"

    if agent == "cursor":
        # cursor-agent has --version but no auth check. Existence of the key
        # file is sufficient — cursor-agent verifies at exec time.
        cmd = "test -s ~/.pocketeng/cursor_key && echo OK || echo MISSING"
        stdout, _, _ = ssh_exec(client, cmd, timeout=8)
        if "OK" in stdout:
            return True, "key present"
        return False, "no cursor key on host"

    if agent == "opencode":
        # v1: PocketEng supports OpenCode via provider env vars in the
        # workspace shell profile, not via `/connect` or auth.json sync.
        cmd = (
            "set +e; "
            "source ~/.bashrc 2>/dev/null || true; "
            "source ~/.zprofile 2>/dev/null || true; "
            "if [ -n \"$ANTHROPIC_API_KEY\" ]; then echo ANTHROPIC; "
            "elif [ -n \"$OPENAI_API_KEY\" ]; then echo OPENAI; "
            "else echo MISSING; fi"
        )
        stdout, _, _ = ssh_exec(client, cmd, timeout=8)
        text = (stdout or "").strip()
        if text == "ANTHROPIC":
            return True, "using ANTHROPIC_API_KEY from workspace env vars"
        if text == "OPENAI":
            return True, "using OPENAI_API_KEY from workspace env vars"
        return False, "missing ANTHROPIC_API_KEY or OPENAI_API_KEY in workspace env vars"

    return False, f"unknown agent {agent}"
