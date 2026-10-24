"""
POST /servers — Provision a new EC2 instance for a managed user.

After EC2 is launched, we seed the server record with readiness.status =
"provisioning" and async-invoke FinalizeFunction. FinalizeFunction is
responsible for driving readiness → "ready" (installs complete, credentials
pushed, every agent passes auth verification). The client polls
GET /servers/{id} to watch the state machine progress.
"""
import json
import os
import uuid
from datetime import datetime, timezone

import boto3

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding, NoEncryption, PrivateFormat, PublicFormat,
)

from src.lib.auth import extract_auth_header, verify_token
from src.lib import cloudflare
from src.lib.db import get_servers_by_user, put_server, update_server
from src.lib.ec2 import (
    create_security_group, find_latest_ami,
    import_key_pair, launch_instance,
)
from src.lib.env_vars import sanitize_env_vars
from src.lib.kms import encrypt
from src.lib.team_auth import can_access_team, get_team_for_user, owner_fields_for_request
from src.lib.userdata import build_userdata

MAX_SERVERS = 5

# v1 ships with Linux EC2 only. The "ios" envType (mac2.metal dedicated
# hosts for Xcode workspaces) was dropped — it's expensive (24hr host
# billing minimum), slow to provision, and not needed for the cloud-agent
# core product. The build_macos_userdata / launch_mac_instance / etc.
# helpers were removed alongside. Existing servers in DynamoDB with
# envType="ios" still load (StatusFunction/ServersFunction don't filter
# by envType for reads), they just can't be re-provisioned.
ENV_TYPES = {
    "general": {
        "instanceType": "t3.medium",
        "autoStopMinutes": 30,
    },
}


def respond(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def _resolve_anthropic_key_for_provision(body: dict, env: dict) -> str:
    """Pick which Anthropic key to inject into the workspace.

    Precedence (highest first):
      1. User-supplied `anthropicApiKey` in the request body — if the user
         pasted their own key (or has a stored one that the frontend is
         forwarding), that wins unconditionally. We NEVER silently replace
         a user-provided key.
      2. PE's shared trial key (env var `PE_TRIAL_ANTHROPIC_KEY`), but
         only if the request is explicitly marked `trial: true` AND the
         env var is configured. Enables the quick-start flow where a
         first-time user clicks one button and gets a working workspace.
      3. Empty string — workspace provisions without a pre-seeded Anthropic
         credential. User lands at the connect-agent UI at first chat. Not
         an error; a legitimate state for users bringing their own agent
         via Claude login / desktop import / Settings paste flow.

    Extracted into a pure function so the substitution logic is
    independently unit-testable without having to mock AWS APIs.
    """
    user_key = body.get("anthropicApiKey", "").strip()
    if user_key:
        return user_key
    if bool(body.get("trial", False)):
        trial_key = env.get("PE_TRIAL_ANTHROPIC_KEY", "").strip()
        if trial_key:
            return trial_key
    return ""


def _resolve_workspace_label(body: dict) -> str:
    """Pick the persisted display label for a newly-created workspace."""
    raw_label = body.get("label", "")
    label = raw_label.strip() if isinstance(raw_label, str) else ""
    if label:
        return label

    repos = body.get("repos", [])
    if repos:
        first_repo = repos[0]
        if isinstance(first_repo, str) and first_repo.strip():
            repo_name = first_repo.split("/")[-1]
            if repo_name:
                return f"{repo_name} workspace"

    return "Cloud Workspace"


_lambda = boto3.client("lambda")


def _invoke_finalize_async(server_id: str, user_id: str) -> None:
    """Async-invoke FinalizeFunction so the workspace self-drives to ready.

    Uses InvocationType='Event' — no response body, no blocking. The target
    function name is configured via FINALIZE_FUNCTION_NAME env var in the SAM
    template. If invocation fails (e.g. IAM misconfig), we log and move on —
    the client can retry by calling POST /servers/{id}/finalize manually.
    """
    fn = os.environ.get("FINALIZE_FUNCTION_NAME")
    if not fn:
        print("finalize: FINALIZE_FUNCTION_NAME not set, skipping async kick")
        return
    try:
        _lambda.invoke(
            FunctionName=fn,
            InvocationType="Event",
            Payload=json.dumps({"serverId": server_id, "userId": user_id}).encode(),
        )
    except Exception as e:
        print(f"finalize: async invoke failed for {server_id}: {e}")


def handler(event, context):
    try:
        try:
            claims = verify_token(extract_auth_header(event.get("headers", {})))
        except Exception as e:
            return respond(401, {"error": str(e)})

        user_id = claims["sub"]
        body = json.loads(event.get("body") or "{}")
        owner_type = body.get("ownerType") or "personal"
        requested_team_id = body.get("teamId")
        if owner_type == "team":
            if not requested_team_id:
                team, _ = get_team_for_user(user_id)
                requested_team_id = team["teamId"] if team else None
            if not requested_team_id or not can_access_team(user_id, requested_team_id):
                return respond(403, {"error": "User cannot provision into that team"})

        env_type = body.get("envType", "general")

        # ── BYOS: Connect existing server (no provisioning) ──
        if env_type == "byos":
            host = body.get("host", "").strip()
            ssh_key = body.get("sshPrivateKey", "").strip()
            ssh_user = body.get("sshUser", "ec2-user").strip()
            if not host or not ssh_key:
                return respond(400, {"error": "host and sshPrivateKey required"})

            existing = get_servers_by_user(user_id)
            active = [s for s in existing if s.get("instanceState") != "terminated"]
            if len(active) >= MAX_SERVERS:
                return respond(409, {"error": f"Server limit reached (max {MAX_SERVERS})."})

            # Dedup — if this host already exists for this user, update it instead of creating a new one
            existing_byos = [s for s in active if s.get("publicIp") == host and s.get("envType") == "byos"]
            if existing_byos:
                # Already exists — just update the key and return the existing ID
                existing_server = existing_byos[0]
                from src.lib.ssh import ssh_connect, ssh_exec, ssh_disconnect
                agents_found = []
                try:
                    client = ssh_connect(host, ssh_key, username=ssh_user, timeout=10)
                    try:
                        stdout, _, _ = ssh_exec(client, "which claude codex agent opencode 2>/dev/null || true", timeout=10)
                        for line in stdout.strip().split("\n"):
                            if "claude" in line: agents_found.append("claude")
                            elif "codex" in line: agents_found.append("codex")
                            elif "/agent" in line or line.strip().endswith("/agent"): agents_found.append("cursor")
                            elif "opencode" in line: agents_found.append("opencode")
                    finally:
                        ssh_disconnect(client)
                except Exception as e:
                    return respond(400, {"error": f"Could not connect to server: {str(e)}"})

                encrypted_key = encrypt(ssh_key)
                update_server(existing_server["serverId"], {
                    "sshPrivateKey": encrypted_key,
                    "sshUser": ssh_user,
                    "instanceState": "running",
                    "agents": agents_found if agents_found else None,
                    # Persist ownership on reconnect so the dedup path doesn't
                    # silently drop ownerType: "team". The team auth gate above
                    # has already verified the caller can use requested_team_id.
                    **owner_fields_for_request(user_id=user_id, owner_type=owner_type, team_id=requested_team_id),
                })
                return respond(200, {
                    "serverId": existing_server["serverId"],
                    "agents": agents_found,
                    "warning": "No coding agents found. Install claude, codex, cursor, or opencode on your server." if not agents_found else None,
                })

            # Verify SSH connectivity and check installed agents
            from src.lib.ssh import ssh_connect, ssh_exec, ssh_disconnect
            agents_found = []
            try:
                client = ssh_connect(host, ssh_key, username=ssh_user, timeout=10)
                try:
                    # Check which agents are installed
                    stdout, _, _ = ssh_exec(client, "which claude codex agent opencode 2>/dev/null || true", timeout=10)
                    for line in stdout.strip().split("\n"):
                        line = line.strip()
                        if "claude" in line:
                            agents_found.append("claude")
                        elif "codex" in line:
                            agents_found.append("codex")
                        elif "/agent" in line or line.endswith("/agent"):
                            agents_found.append("cursor")
                        elif "opencode" in line:
                            agents_found.append("opencode")
                finally:
                    ssh_disconnect(client)
            except Exception as e:
                return respond(400, {"error": f"Could not connect to server: {str(e)}"})

            encrypted_key = encrypt(ssh_key)
            server_id = str(uuid.uuid4())
            region = os.environ.get("AWS_REGION", "us-east-1")
            now = datetime.now(timezone.utc).isoformat()

            put_server({
                "serverId": server_id,
                "instanceId": "byos",
                "region": region,
                "instanceState": "running",
                "publicIp": host,
                "sshPrivateKey": encrypted_key,
                "keyPairName": None,
                "securityGroupId": None,
                "anthropicApiKey": None,
                "autoStopMinutes": None,
                "envType": "byos",
                "instanceType": "external",
                "label": body.get("label", host),
                "sshUser": body.get("sshUser", "ec2-user"),
                "createdAt": now,
                "lastActivityAt": now,
                "agents": agents_found if agents_found else None,
                **owner_fields_for_request(user_id=user_id, owner_type=owner_type, team_id=requested_team_id),
            })

            return respond(201, {
                "serverId": server_id,
                "agents": agents_found,
                "warning": "No coding agents found. Install claude, codex, cursor, or opencode on your server." if not agents_found else None,
            })

        # ── Provisioned environments ──
        anthropic_api_key = _resolve_anthropic_key_for_provision(body, os.environ)
        openai_api_key = body.get("openaiApiKey", "")
        cursor_api_key = body.get("cursorApiKey", "")

        # Log-only telemetry for the trial path — the actual substitution
        # happens inside _resolve_anthropic_key_for_provision above.
        is_trial = bool(body.get("trial", False))
        user_provided_key = bool(body.get("anthropicApiKey", "").strip())
        if is_trial and not user_provided_key:
            if anthropic_api_key:
                print(f"[provision] user={user_id} trial=true — injecting shared trial Anthropic key")
            else:
                print(f"[provision] user={user_id} trial=true but PE_TRIAL_ANTHROPIC_KEY is empty — workspace will have no pre-seeded credential")

        # No API-key gate. We used to require at least one of anthropicApiKey
        # / openaiApiKey / cursorApiKey (or a previously-connected agent) to
        # provision. That's obsolete under the subscription-login model:
        # onboarding silently provisions the user's first workspace precisely
        # so it can host the `claude auth login` / `codex login` / `cursor-
        # agent login` flows. If a user ends up with a workspace that has no
        # connected agents, `readiness.agents[*].needsLogin` surfaces it in
        # the UI and the Connect cards guide them. Gating provision on creds
        # broke the chicken-and-egg for brand-new users.
        _agents_raw = body.get("agents") or (
            [body["agent"]] if "agent" in body else ["claude"]
        )
        _requested_agents = {
            a for a in _agents_raw if a in ("claude", "codex", "cursor", "opencode")
        }
        print(f"[provision] user={user_id} requested_agents={_requested_agents} "
              f"has_anthropic_key={bool(anthropic_api_key)} "
              f"has_openai_key={bool(openai_api_key)}")

        if env_type not in ENV_TYPES:
            return respond(400, {"error": f"Invalid envType: {env_type}. Use: {', '.join(ENV_TYPES)}"})

        # Server limit check
        existing = get_servers_by_user(user_id)
        active = [s for s in existing if s.get("instanceState") != "terminated"]
        if len(active) >= MAX_SERVERS:
            return respond(409, {"error": f"Server limit reached (max {MAX_SERVERS}). Terminate existing server first."})

        # Generate Ed25519 SSH key pair — cryptography outputs OpenSSH natively
        key = Ed25519PrivateKey.generate()
        private_openssh = key.private_bytes(
            Encoding.PEM, PrivateFormat.OpenSSH, NoEncryption()
        ).decode()
        public_openssh = key.public_key().public_bytes(
            Encoding.OpenSSH, PublicFormat.OpenSSH
        )

        key_pair_name = f"pe-managed-{str(uuid.uuid4())[:8]}"
        import_key_pair(key_pair_name, public_openssh)

        sg_name = f"pe-managed-{str(uuid.uuid4())[:8]}"
        sg_id = create_security_group(sg_name)

        # Allocate the workspace UUID up front so we can name the
        # Cloudflare tunnel deterministically (pe-{serverId}) — easy to
        # grep in the CF dashboard when tracing a workspace back to its
        # tunnel. `server_id` used to be generated after launch; the
        # reordering is cosmetic — it's only persisted in `put_server`
        # at the end of the flow.
        server_id = str(uuid.uuid4())

        # Create the Cloudflare tunnel BEFORE building userdata — we
        # need the connector token to embed into the userdata so the
        # EC2 box starts cloudflared on first boot. If Cloudflare isn't
        # configured (e.g. a regional dev stack), skip cleanly: the
        # workspace still boots without a tunnel and preview URLs fall
        # back to the legacy proxy path.
        #
        # After tunnel create, write the `serverId → tunnelId` entry
        # to the Workers-KV namespace the preview Worker reads. If the
        # KV write fails but the tunnel was created, we still persist
        # the tunnel id — a later retry (from the chat handler) can
        # re-attempt the KV write without leaking another tunnel.
        tunnel_id = None
        tunnel_token = None
        if cloudflare.is_configured():
            try:
                tunnel = cloudflare.create_tunnel(f"pe-{server_id}")
                tunnel_id = tunnel.get("id")
                tunnel_token = tunnel.get("token") or cloudflare.get_tunnel_token(tunnel_id)
            except cloudflare.CloudflareError as exc:
                # Don't fail provision on a transient CF outage — log,
                # continue without a tunnel, and let the chat path
                # lazy-create one later when the user opens preview.
                print(f"[provision] cloudflare tunnel create failed for {server_id}: {exc}")
                tunnel_id = None
                tunnel_token = None

            if tunnel_id:
                # Workspace CNAME + ingress rule: the tunnel only
                # routes traffic for hostnames with a CNAME in our
                # zone (CF docs), so we create that CNAME here and
                # register ONE ingress rule pointing it at the local
                # preview dispatcher. Per-port dispatch happens on the
                # box via the X-Preview-Port header. Doing this up
                # front means the first preview click is instant —
                # no per-click Cloudflare API calls.
                try:
                    hostname = cloudflare.workspace_hostname(server_id)
                    cloudflare.upsert_dns_cname(hostname, tunnel_id)
                    cloudflare.ensure_workspace_ingress(tunnel_id, server_id)
                except cloudflare.CloudflareError as exc:
                    # DNS or ingress write failed. Tunnel token is
                    # still valid so cloudflared will come up; the
                    # lazy path in chat.py retries this on first
                    # preview click. Log loudly — usually means the
                    # token is missing DNS:Edit or Tunnel:Edit scope.
                    print(
                        f"[provision] cloudflare DNS/ingress wiring failed for "
                        f"{server_id} (tunnel {tunnel_id}): {exc}"
                    )

                try:
                    cloudflare.kv_put(server_id, tunnel_id)
                except cloudflare.CloudflareError as exc:
                    # KV is a liveness check for the Worker. If this
                    # fails the first preview click surfaces the
                    # Worker's branded "workspace not found" page —
                    # chat.py retries kv_put on lazy-create so this
                    # self-heals. Log loudly for observability.
                    print(
                        f"[provision] cloudflare kv_put failed for "
                        f"{server_id} → {tunnel_id}: {exc}"
                    )
        else:
            print(f"[provision] cloudflare not configured; skipping tunnel for {server_id}")

        # Support both "agent" (single, legacy) and "agents" (array)
        agents_raw = body.get("agents") or ([body["agent"]] if "agent" in body else ["claude"])
        agents = [a for a in agents_raw if a in ("claude", "codex", "cursor", "opencode")]
        if not agents:
            agents = ["claude"]
        github_token = body.get("githubToken")
        github_username = body.get("githubUsername")
        repos = body.get("repos", [])
        vercel_token = body.get("vercelToken")
        supabase_url = body.get("supabaseUrl")
        supabase_service_key = body.get("supabaseServiceKey")
        skills = body.get("skills", [])
        custom_skills = body.get("customSkills", [])
        setup_files = body.get("setupFiles", [])
        setup_instructions = body.get("setupInstructions", "").strip() or None

        # Extract and validate custom env vars
        env_vars = sanitize_env_vars(body.get("envVars"))

        env_config = ENV_TYPES[env_type]

        # Standard Linux EC2. iOS / macOS Dedicated Host provisioning was
        # dropped — see ENV_TYPES comment above.
        ami_id = find_latest_ami()
        userdata = build_userdata(
            anthropic_key=anthropic_api_key,
            openai_key=openai_api_key,
            cursor_key=cursor_api_key,
            agents=agents,
            github_token=github_token,
            github_username=github_username,
            repos=repos,
            vercel_token=vercel_token,
            supabase_url=supabase_url,
            supabase_service_key=supabase_service_key,
            skills=skills,
            env_vars=env_vars,
            custom_skills=custom_skills,
            setup_files=setup_files,
            setup_instructions=setup_instructions,
            tunnel_token=tunnel_token,
        )
        instance_id = launch_instance(ami_id, key_pair_name, sg_id, userdata, user_id)

        encrypted_key = encrypt(private_openssh)
        encrypted_api_key = encrypt(anthropic_api_key) if anthropic_api_key else None
        encrypted_openai_key = encrypt(openai_api_key) if openai_api_key else None
        encrypted_cursor_key = encrypt(cursor_api_key) if cursor_api_key else None

        region = os.environ.get("AWS_REGION", "us-east-1")
        now = datetime.now(timezone.utc).isoformat()

        # Auto-generate label from first repo name, or fall back to generic
        label = _resolve_workspace_label(body)

        server_record = {
            "serverId": server_id,
            "instanceId": instance_id,
            "region": region,
            "instanceState": "launching",
            "publicIp": None,
            "sshPrivateKey": encrypted_key,
            "keyPairName": key_pair_name,
            "securityGroupId": sg_id,
            "anthropicApiKey": encrypted_api_key,
            "openaiApiKey": encrypted_openai_key,
            "cursorApiKey": encrypted_cursor_key,
            "autoStopMinutes": env_config["autoStopMinutes"],
            "envType": env_type,
            "instanceType": env_config["instanceType"],
            "agents": agents,
            "hasVercel": bool(vercel_token),
            "hasSupabase": bool(supabase_url),
            "envVars": encrypt(json.dumps(env_vars)) if env_vars else None,
            "repos": repos if repos else [],
            "label": label,
            "createdAt": now,
            "lastActivityAt": now,
            # Mark trial workspaces so we can meter usage / gate upgrade
            # flows later. Stored as a boolean so `get_server(...).trial`
            # is a clean read with no magic strings.
            "trial": is_trial,
            # Cloudflare Tunnel id used by _discover_services to
            # register a per-port ingress rule and by action.terminate
            # to delete the tunnel + its KV entry. None when provisioning
            # ran without Cloudflare configured or the CF API was
            # unhealthy; the chat path lazy-creates one the first time
            # the user opens the preview panel.
            "tunnelId": tunnel_id,
            # Seed readiness so the UI knows the workspace isn't usable yet.
            # FinalizeFunction drives this forward to {"status":"ready"}.
            "readiness": {
                "status": "provisioning",
                "stage": "booting-ec2",
                "agents": {a: {"installed": None, "authenticated": None} for a in agents},
                "error": None,
                "updatedAt": now,
            },
            **owner_fields_for_request(user_id=user_id, owner_type=owner_type, team_id=requested_team_id),
        }
        put_server(server_record)

        # Kick off finalize in the background. We don't block the provision
        # response on agent install + auth verification — that takes 1-3 min.
        # The client polls GET /servers/{id} for readiness.status == "ready".
        _invoke_finalize_async(server_id, user_id)

        return respond(201, {
            "serverId": server_id,
            "instanceId": instance_id,
            "status": "launching",
            "region": region,
            "envType": env_type,
            "instanceType": env_config["instanceType"],
            "label": label,
        })

    except Exception as e:
        import traceback
        print(f"Provision error: {e}\n{traceback.format_exc()}")
        return respond(500, {"error": "Provisioning failed", "detail": str(e)})
