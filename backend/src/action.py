"""
POST /servers/{serverId}/action
Actions: start, stop, terminate
"""
import base64
import json
import shlex
from datetime import datetime, timezone

from src.lib.auth import extract_auth_header, verify_token
from src.lib import cloudflare
from src.lib.db import get_server, update_server, delete_server
from src.lib.ec2 import (
    start_instance, stop_instance, terminate_instance,
    delete_security_group, delete_key_pair,
)
from src.lib.env_vars import sanitize_env_vars
from src.lib.kms import decrypt, encrypt
from src.lib.ssh import ssh_connect, ssh_exec, ssh_disconnect
from src.lib.team_auth import can_access_owned_resource, can_delete_owned_resource, can_manage_owned_resource


def respond(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def handler(event, context):
    try:
        try:
            claims = verify_token(extract_auth_header(event.get("headers", {})))
        except Exception as e:
            return respond(401, {"error": str(e)})

        user_id = claims["sub"]
        server_id = (event.get("pathParameters") or {}).get("serverId")
        body = json.loads(event.get("body") or "{}")
        action = body.get("action")

        if not server_id or not action:
            return respond(400, {"error": "serverId and action required"})

        server = get_server(server_id)
        if not server:
            return respond(404, {"error": "Server not found"})
        if not can_access_owned_resource(user_id, server):
            return respond(403, {"error": "Not your server"})

        now = datetime.now(timezone.utc).isoformat()
        is_byos = server.get("envType") == "byos"

        if action == "start":
            if is_byos:
                return respond(200, {"status": "byos_always_running"})

            if server.get("instanceState") == "running":
                return respond(200, {"status": "already_running"})
            start_instance(server["instanceId"])
            update_server(server_id, {"instanceState": "pending", "lastActivityAt": now})
            return respond(200, {"status": "starting"})

        elif action == "stop":
            if is_byos:
                return respond(200, {"status": "byos_cannot_stop"})
            if server.get("instanceState") == "stopped":
                return respond(200, {"status": "already_stopped"})
            stop_instance(server["instanceId"])
            update_server(server_id, {"instanceState": "stopping"})
            return respond(200, {"status": "stopping"})

        elif action == "terminate":
            if not can_delete_owned_resource(user_id, server):
                return respond(403, {"error": "Only team admins can delete team workspaces"})
            if not is_byos:
                terminate_instance(server["instanceId"])
            delete_key_pair(server.get("keyPairName", ""))
            delete_security_group(server.get("securityGroupId", ""))
            # Best-effort Cloudflare cleanup, in order:
            #   1. KV delete  — Worker's liveness lookup starts 404ing
            #                   immediately, so any bookmarked preview
            #                   URL shows the branded "workspace not
            #                   found" page instead of a stale dev-server
            #                   response.
            #   2. DNS CNAME  — remove the per-workspace public hostname.
            #                   Stragglers resolve to 1016 which is
            #                   harmless but noisy in logs.
            #   3. Tunnel     — tear down the tunnel last so any in-flight
            #                   request still has a chance to complete.
            # Each step is logged-and-swallowed by the cloudflare
            # module — terminate must always succeed from the user's
            # perspective so EC2 cleanup is never blocked on a CF
            # outage.
            tunnel_id = server.get("tunnelId")
            if tunnel_id:
                cloudflare.kv_delete(server_id)
                if cloudflare.is_configured():
                    try:
                        hostname = cloudflare.workspace_hostname(server_id)
                        cloudflare.delete_dns_records_for_hostname(hostname)
                    except cloudflare.CloudflareError as exc:
                        print(f"action.terminate: dns cleanup failed for {server_id}: {exc}")
                cloudflare.delete_tunnel(tunnel_id)
            update_server(server_id, {"instanceState": "terminated", "publicIp": None})
            return respond(200, {"status": "terminated"})

        elif action == "rename":
            if not can_manage_owned_resource(user_id, server):
                return respond(403, {"error": "You cannot rename this workspace"})
            label = body.get("label", "").strip()
            if not label:
                return respond(400, {"error": "label required for rename"})
            update_server(server_id, {"label": label})
            return respond(200, {"status": "renamed", "label": label})

        elif action == "update-overview":
            # Persist the human-curated description + components list
            # displayed in the Architecture tab of the workspace card.
            # Components are arbitrary user-defined service slices —
            # we don't validate names or ports against reality, just
            # the shape and reasonable size caps.
            if not can_manage_owned_resource(user_id, server):
                return respond(403, {"error": "You cannot edit this workspace"})

            description = body.get("description")
            if description is not None and not isinstance(description, str):
                return respond(400, {"error": "description must be a string"})
            if isinstance(description, str) and len(description) > 280:
                return respond(400, {"error": "description must be 280 chars or less"})

            components = body.get("components")
            if components is not None:
                if not isinstance(components, list):
                    return respond(400, {"error": "components must be a list"})
                if len(components) > 20:
                    return respond(400, {"error": "max 20 components per workspace"})
                cleaned = []
                for raw in components:
                    if not isinstance(raw, dict):
                        return respond(400, {"error": "each component must be an object"})
                    name = (raw.get("name") or "").strip()
                    if not name:
                        return respond(400, {"error": "each component needs a name"})
                    if len(name) > 60:
                        return respond(400, {"error": f"component name too long: {name[:30]}…"})
                    item = {"name": name}
                    role = (raw.get("role") or "").strip()
                    if role:
                        if len(role) > 100:
                            return respond(400, {"error": "role must be 100 chars or less"})
                        item["role"] = role
                    port = raw.get("port")
                    if port is not None:
                        try:
                            port = int(port)
                        except (TypeError, ValueError):
                            return respond(400, {"error": f"port must be an integer (got {port!r})"})
                        if not (1 <= port <= 65535):
                            return respond(400, {"error": f"port out of range: {port}"})
                        item["port"] = port
                    cleaned.append(item)
                components = cleaned

            updates = {}
            if description is not None:
                updates["description"] = description.strip()
            if components is not None:
                updates["components"] = components
            if not updates:
                return respond(400, {"error": "nothing to update (provide description and/or components)"})
            update_server(server_id, updates)
            return respond(200, {"status": "updated", **updates})

        elif action == "update-env-vars":
            if not can_manage_owned_resource(user_id, server):
                return respond(403, {"error": "You cannot update this workspace"})
            env_vars = sanitize_env_vars(body.get("envVars"))

            # Persist to DynamoDB (encrypted)
            encrypted_env_vars = encrypt(json.dumps(env_vars)) if env_vars else None
            update_server(server_id, {"envVars": encrypted_env_vars, "lastActivityAt": now})

            # Apply immediately via SSH if server is running
            applied = False
            if server.get("instanceState") == "running" and server.get("publicIp") and server.get("sshPrivateKey"):
                try:
                    ssh_key = decrypt(server["sshPrivateKey"])
                    client = ssh_connect(
                        server["publicIp"], ssh_key,
                        username=server.get("sshUser", "ec2-user"), timeout=15
                    )
                    try:
                        # Linux EC2 only — iOS/macOS provisioning was dropped in v1.
                        env_file = "$HOME/.bashrc"
                        if env_vars:
                            valid_pairs = list(env_vars.items())
                            export_lines = "\n".join(
                                f"export {k}={shlex.quote(v)}" for k, v in valid_pairs
                            )
                            block = f"# >>> PE_CUSTOM_ENV\n{export_lines}\n# <<< PE_CUSTOM_ENV"
                            b64 = base64.b64encode(block.encode()).decode()
                            cmd = (
                                f"sed -i.bak '/# >>> PE_CUSTOM_ENV/,/# <<< PE_CUSTOM_ENV/d' {env_file} 2>/dev/null || true; "
                                f"rm -f {env_file}.bak 2>/dev/null || true; "
                                f"printf '%s\\n' \"$(echo '{b64}' | base64 -d)\" >> {env_file}"
                            )
                        else:
                            # Clear all custom env vars
                            cmd = (
                                f"sed -i.bak '/# >>> PE_CUSTOM_ENV/,/# <<< PE_CUSTOM_ENV/d' {env_file} 2>/dev/null || true; "
                                f"rm -f {env_file}.bak 2>/dev/null || true"
                            )
                        ssh_exec(client, cmd, timeout=15)
                        applied = True
                    finally:
                        ssh_disconnect(client)
                except Exception as e:
                    print(f"SSH env var update failed: {e}")

            return respond(200, {
                "status": "updated",
                "envVars": env_vars,
                "applied": applied,
                "note": None if applied else "Env vars saved. Reconnect your shell or restart the server to apply.",
            })

        else:
            return respond(400, {"error": f"Unknown action: {action}. Use start, stop, terminate, rename, or update-env-vars."})

    except Exception as e:
        print(f"Action error: {e}")
        return respond(500, {"error": "Action failed", "detail": str(e)})
