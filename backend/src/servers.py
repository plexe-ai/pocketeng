"""
GET /servers — List all managed servers for the authenticated user.
Returns live EC2 state and decrypted SSH key for running servers.
"""
import json
from decimal import Decimal

from src.lib.auth import extract_auth_header, verify_token
from src.lib.db import get_servers_by_team, get_servers_by_user
from src.lib.ec2 import describe_instance
from src.lib.kms import decrypt
from src.lib.team_auth import get_team_for_user


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
        team, _ = get_team_for_user(user_id)
        servers = list(get_servers_by_user(user_id))
        if team:
            servers.extend(get_servers_by_team(team["teamId"]))
        deduped = {}
        for server in servers:
            deduped[server["serverId"]] = server
        servers = list(deduped.values())

        results = []
        for server in servers:
            result = {
                "serverId": server["serverId"],
                "instanceId": server["instanceId"],
                "instanceState": server.get("instanceState", "unknown"),
                "publicIp": server.get("publicIp"),
                "region": server.get("region"),
                "envType": server.get("envType", "general"),
                "instanceType": server.get("instanceType", "t3.medium"),
                "createdAt": server.get("createdAt"),
                "agents": server.get("agents"),
                "hasVercel": server.get("hasVercel", False),
                "hasSupabase": server.get("hasSupabase", False),
                "label": server.get("label"),
                "autoStopMinutes": server.get("autoStopMinutes"),
                "ownerType": server.get("ownerType", "personal"),
                "teamId": server.get("teamId"),
                "createdByUserId": server.get("createdByUserId"),
                # Architecture overview (user-edited via action.py
                # update-overview). Surfaced on the list so the
                # dashboard cards can show the one-line description
                # without N follow-up GET /servers/{id} calls. Full
                # infra block (volumes, cost, etc.) is status-only.
                "description": server.get("description"),
                "components": server.get("components"),
            }

            # Get live EC2 state (skip for BYOS — no EC2 instance to query)
            if server.get("envType") != "byos":
                live = describe_instance(server["instanceId"])
                if live:
                    result["instanceState"] = live["state"]
                    result["publicIp"] = live.get("publicIp")

            # Include decrypted SSH key for running servers
            if (
                result["instanceState"] == "running"
                and result["publicIp"]
                and server.get("sshPrivateKey")
            ):
                try:
                    result["sshPrivateKey"] = decrypt(server["sshPrivateKey"])
                except Exception:
                    pass

            # Include decrypted env vars
            if server.get("envVars"):
                try:
                    result["envVars"] = json.loads(decrypt(server["envVars"]))
                except Exception:
                    pass

            results.append(result)

        return respond(200, {"servers": results})

    except Exception as e:
        print(f"List servers error: {e}")
        return respond(500, {"error": "Internal server error"})
