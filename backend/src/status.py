"""
GET  /servers/{serverId}           — Get server status, deliver SSH key when ready.
POST /servers/{serverId}/heartbeat — Update lastActivityAt.
"""
import json
from datetime import datetime, timezone
from decimal import Decimal

from src.lib.auth import extract_auth_header, verify_token
from src.lib.db import get_server, update_server
from src.lib.ec2 import describe_instance, describe_instance_infra
from src.lib.kms import decrypt
from src.lib.pricing import estimate_monthly_usd
from src.lib.team_auth import can_access_owned_resource


def _default(obj):
    if isinstance(obj, Decimal):
        return int(obj) if obj % 1 == 0 else float(obj)
    raise TypeError


def respond(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body, default=_default),
    }


def handler(event, context):
    try:
        try:
            claims = verify_token(extract_auth_header(event.get("headers", {})))
        except Exception as e:
            return respond(401, {"error": str(e)})

        user_id = claims["sub"]
        server_id = (event.get("pathParameters") or {}).get("serverId")
        if not server_id:
            return respond(400, {"error": "serverId required"})

        path = event.get("requestContext", {}).get("http", {}).get("path", "")
        if "/heartbeat" in path:
            return handle_heartbeat(server_id, user_id)

        return handle_status(server_id, user_id)

    except Exception as e:
        print(f"Status error: {e}")
        return respond(500, {"error": "Internal server error"})


def handle_status(server_id, user_id):
    server = get_server(server_id)
    if not server:
        return respond(404, {"error": "Server not found"})
    if not can_access_owned_resource(user_id, server):
        return respond(403, {"error": "Not your server"})

    # BYOS servers — no EC2 to query, return stored state directly
    if server.get("envType") == "byos":
        result = {
            "serverId": server_id,
            "instanceId": "byos",
            "instanceState": server.get("instanceState", "running"),
            "publicIp": server.get("publicIp"),
            "region": server.get("region"),
            "envType": "byos",
            "instanceType": "external",
            "autoStopMinutes": None,
            "createdAt": server.get("createdAt"),
            "lastActivityAt": server.get("lastActivityAt"),
            "label": server.get("label"),
            "agents": server.get("agents"),
            "readiness": server.get("readiness"),
            "ownerType": server.get("ownerType", "personal"),
            "teamId": server.get("teamId"),
            "createdByUserId": server.get("createdByUserId"),
            # Architecture overview (user-edited via action.py update-overview).
            "description": server.get("description"),
            "components": server.get("components"),
            # BYOS infra is whatever the user pointed us at — we don't know
            # volumes, launch time, or cost. Emit an empty infra object so the
            # client can render a "BYOS — infra not tracked" placeholder
            # instead of crashing on a missing key.
            "infra": {"byos": True},
        }
        if server.get("sshPrivateKey"):
            try:
                result["sshPrivateKey"] = decrypt(server["sshPrivateKey"])
            except Exception:
                pass
        if server.get("envVars"):
            try:
                result["envVars"] = json.loads(decrypt(server["envVars"]))
            except Exception:
                pass
        return respond(200, result)

    # One AWS round-trip for both state-sync AND the Infra tab. Falls back to
    # the bare describe_instance shape if the extended call errors out so the
    # status response still returns; the Infra tab degrades to "unavailable"
    # rather than 404-ing the whole workspace view.
    infra_raw = describe_instance_infra(server["instanceId"])
    if infra_raw is None:
        live = describe_instance(server["instanceId"])
        if not live:
            return respond(404, {"error": "EC2 instance not found"})
        infra_raw = {**live, "launchTime": None, "volumes": []}

    # Update cached state if changed
    if infra_raw["state"] != server.get("instanceState") or infra_raw.get("publicIp") != server.get("publicIp"):
        update_server(server_id, {
            "instanceState": infra_raw["state"],
            "publicIp": infra_raw.get("publicIp"),
        })

    instance_type = server.get("instanceType", "t3.medium")
    infra = {
        "instanceType": instance_type,
        "region": server.get("region"),
        "launchTime": infra_raw.get("launchTime"),
        "volumes": infra_raw.get("volumes", []),
        # Public hostname coming through the Cloudflare tunnel — set during
        # provisioning (see cloudflare.workspace_hostname). Missing for
        # workspaces from before that migration.
        "tunnelHostname": server.get("tunnelHostname"),
        # Cost is an estimate (current state × 730h) — UI labels it as such.
        "estimatedMonthlyUsd": estimate_monthly_usd(instance_type, infra_raw.get("volumes")),
        # Skills + repos help the Infra tab read like a system summary
        # without needing yet another lookup. Cheap copies of fields the
        # client already had access to.
        "skills": server.get("skills", []),
        "repos": server.get("repos", []),
    }

    result = {
        "serverId": server_id,
        "instanceId": server["instanceId"],
        "instanceState": infra_raw["state"],
        "publicIp": infra_raw.get("publicIp"),
        "region": server.get("region"),
        "envType": server.get("envType", "general"),
        "instanceType": instance_type,
        "autoStopMinutes": server.get("autoStopMinutes"),
        "createdAt": server.get("createdAt"),
        "lastActivityAt": server.get("lastActivityAt"),
        "label": server.get("label"),
        "agents": server.get("agents"),
        "ownerType": server.get("ownerType", "personal"),
        "teamId": server.get("teamId"),
        "createdByUserId": server.get("createdByUserId"),
        # Drives the UI's "Preparing workspace…" gate. FinalizeFunction
        # updates this. status=="ready" means all configured agents are
        # installed and authenticated.
        "readiness": server.get("readiness"),
        # Architecture (user-edited) + Infra (auto-queried) — see the
        # "About this workspace" panel on ServerCard.
        "description": server.get("description"),
        "components": server.get("components"),
        "infra": infra,
    }

    if infra_raw["state"] == "running" and infra_raw.get("publicIp") and server.get("sshPrivateKey"):
        try:
            result["sshPrivateKey"] = decrypt(server["sshPrivateKey"])
        except Exception as e:
            print(f"Key decryption failed: {e}")

    if server.get("envVars"):
        try:
            result["envVars"] = json.loads(decrypt(server["envVars"]))
        except Exception:
            pass

    return respond(200, result)


def handle_heartbeat(server_id, user_id):
    server = get_server(server_id)
    if not server:
        return respond(404, {"error": "Server not found"})
    if not can_access_owned_resource(user_id, server):
        return respond(403, {"error": "Not your server"})

    update_server(server_id, {
        "lastActivityAt": datetime.now(timezone.utc).isoformat()
    })
    return respond(200, {"ok": True})
