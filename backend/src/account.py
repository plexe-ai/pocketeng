"""
DELETE /account — permanently delete the authenticated user's account.
"""
import json
import os
import urllib.error
import urllib.request
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Attr

from src.lib.apple_auth import AppleConfigurationError, AppleRevocationError, revoke_apple_token
from src.lib.auth import extract_auth_header, verify_token
from src.lib.db import (
    delete_harness_run_summaries,
    delete_harness_suggestions,
    delete_harness_versions,
    delete_messages_for_session,
    delete_session_events_for_session,
    delete_oauth_credentials_by_user,
    delete_push_device,
    delete_server,
    delete_session,
    delete_team,
    delete_team_membership,
    get_all_push_devices_by_user,
    get_all_sessions_by_server,
    get_oauth_credential,
    get_servers_by_team,
    get_servers_by_user,
    list_team_invites_for_team,
    update_server,
    update_team_invite,
)
from src.lib.ec2 import (
    delete_key_pair,
    delete_security_group,
    terminate_instance,
)
from src.lib.kms import decrypt
from src.lib.push import delete_push_endpoint
from src.lib.team_auth import get_active_team_membership, list_active_team_members

_ddb = boto3.resource("dynamodb")
_SLACK_MAPPINGS_TABLE = os.environ.get("SLACK_MAPPINGS_TABLE", "pe-slack-mappings-prod")
_LINEAR_MAPPINGS_TABLE = os.environ.get("LINEAR_MAPPINGS_TABLE", "pe-linear-mappings-prod")
_SMS_MAPPINGS_TABLE = os.environ.get("SMS_MAPPINGS_TABLE", "pe-sms-mappings-prod")


def respond(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def _http_method(event):
    request_context = event.get("requestContext") or {}
    http_context = request_context.get("http") or {}
    return (
        http_context.get("method")
        or event.get("httpMethod")
        or "DELETE"
    ).upper()


def _delete_supabase_user(user_id):
    service_role_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    supabase_url = os.environ.get("SUPABASE_URL", "").strip()

    if not service_role_key:
        raise RuntimeError("SUPABASE_SERVICE_ROLE_KEY is not configured")
    if not supabase_url:
        raise RuntimeError("SUPABASE_URL is not configured")

    request = urllib.request.Request(
        f"{supabase_url}/auth/v1/admin/users/{user_id}",
        data=json.dumps({"should_soft_delete": False}).encode(),
        headers={
            "Content-Type": "application/json",
            "apikey": service_role_key,
            "Authorization": f"Bearer {service_role_key}",
        },
        method="DELETE",
    )

    try:
        with urllib.request.urlopen(request, timeout=10):
            return
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Supabase account deletion failed ({exc.code}): {detail[:200]}") from exc


def _parse_body(event):
    try:
        return json.loads(event.get("body") or "{}")
    except Exception:
        return {}


def _maybe_revoke_apple(user_id, body):
    has_apple_identity = bool(body.get("hasAppleIdentity"))
    if not has_apple_identity:
        return False

    refresh_token = str(body.get("appleRefreshToken") or "").strip()
    access_token = str(body.get("appleAccessToken") or "").strip()

    if not refresh_token and not access_token:
        stored = get_oauth_credential(user_id, "apple") or {}
        if stored.get("refreshToken"):
            refresh_token = decrypt(stored["refreshToken"])
        if stored.get("accessToken"):
            access_token = decrypt(stored["accessToken"])

    if not refresh_token and not access_token:
        raise RuntimeError("Apple authorization token unavailable. Sign in with Apple again, then retry account deletion.")

    try:
        revoke_apple_token(refresh_token=refresh_token or None, access_token=access_token or None)
        return True
    except AppleConfigurationError as exc:
        raise RuntimeError(str(exc)) from exc
    except AppleRevocationError as exc:
        raise RuntimeError(str(exc)) from exc


def _cleanup_sessions_for_server(server_id):
    deleted_sessions = 0
    deleted_messages = 0

    for session in get_all_sessions_by_server(server_id):
        session_id = session.get("sessionId")
        if not session_id:
            continue
        deleted_messages += delete_messages_for_session(session_id)
        delete_session_events_for_session(session_id)
        delete_session(session_id)
        deleted_sessions += 1

    return {
        "sessionsDeleted": deleted_sessions,
        "messagesDeleted": deleted_messages,
    }


def _cleanup_servers_for_user(user_id):
    counts = {
        "serversDeleted": 0,
        "managedServersTerminated": 0,
        "sessionsDeleted": 0,
        "messagesDeleted": 0,
    }

    for server in get_servers_by_user(user_id):
        server_id = server.get("serverId")
        if not server_id:
            continue

        # Team-owned servers must survive an individual member's account
        # deletion: they belong to the team, not the leaving user. The
        # outer handler already verified the user has no active membership,
        # so any team-owned record we hit here is a tombstone from a team
        # they previously left — the team still owns it via teamId.
        if server.get("ownerType") == "team":
            continue

        session_counts = _cleanup_sessions_for_server(server_id)
        counts["sessionsDeleted"] += session_counts["sessionsDeleted"]
        counts["messagesDeleted"] += session_counts["messagesDeleted"]

        if server.get("envType") != "byos":
            instance_id = server.get("instanceId")
            if instance_id and server.get("instanceState") != "terminated":
                terminate_instance(instance_id)
                counts["managedServersTerminated"] += 1

            if server.get("keyPairName"):
                delete_key_pair(server["keyPairName"])
            if server.get("securityGroupId"):
                delete_security_group(server["securityGroupId"])
            # `dedicatedHostId` release path was removed when the mac2.metal
            # iOS-build workspace type was dropped in v1 (see root CLAUDE.md).
            # No current envType produces one, so nothing to clean up here.

        delete_server(server_id)
        counts["serversDeleted"] += 1

    return counts


def _cleanup_push_devices_for_user(user_id):
    deleted_devices = 0

    for device in get_all_push_devices_by_user(user_id):
        try:
            delete_push_endpoint(device.get("endpointArn"))
        except Exception:
            pass

        installation_id = device.get("installationId")
        if installation_id:
            delete_push_device(installation_id)
            deleted_devices += 1

    return deleted_devices


def _delete_mappings_for_user(table_name, key_name, user_id):
    table = _ddb.Table(table_name)
    deleted = 0
    last_key = None

    while True:
        scan_kwargs = {
            "FilterExpression": Attr("userId").eq(user_id),
            "ProjectionExpression": "#pk",
            "ExpressionAttributeNames": {"#pk": key_name},
        }
        if last_key is not None:
            scan_kwargs["ExclusiveStartKey"] = last_key

        response = table.scan(**scan_kwargs)
        items = response.get("Items", [])

        if items:
            with table.batch_writer() as batch:
                for item in items:
                    if key_name not in item:
                        continue
                    batch.delete_item(Key={key_name: item[key_name]})
                    deleted += 1

        last_key = response.get("LastEvaluatedKey")
        if not last_key:
            break

    return deleted


def handler(event, context):
    try:
        if _http_method(event) != "DELETE":
            return respond(405, {"error": "Unsupported method"})

        try:
            claims = verify_token(extract_auth_header(event.get("headers", {})))
        except Exception as exc:
            return respond(401, {"error": str(exc)})

        if not os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip():
            return respond(503, {"error": "SUPABASE_SERVICE_ROLE_KEY is not configured"})

        user_id = claims["sub"]
        membership = get_active_team_membership(user_id)
        if membership:
            team_id = membership["teamId"]
            # If the user has teammates, they must hand off / leave first.
            # If they're the sole member of their team (the common
            # billing-owner-trap case), dissolve the team here so account
            # deletion can proceed: convert team-owned servers to personal
            # so the standard cleanup path picks them up, then drop the
            # team and membership rows.
            others = [
                m for m in list_active_team_members(team_id)
                if m.get("userId") != user_id
            ]
            if others:
                return respond(400, {"error": "Leave your team before deleting this account"})
            for srv in get_servers_by_team(team_id):
                # Rewrite userId/ownerUserId to the dissolving user too, not
                # just ownerType/teamId. Servers created by ex-members keep
                # the ex-member's userId, which means the standard cleanup
                # below (queries userId-index for the billing owner) would
                # never find them — leaving EC2 instances running with no
                # live owner. createdByUserId stays as-is for audit.
                update_server(srv["serverId"], {
                    "ownerType": "personal",
                    "teamId": None,
                    "userId": user_id,
                    "ownerUserId": user_id,
                })
            # Revoke pending invites before deleting the team. Otherwise a
            # recipient who later accepts an orphaned invite would create a
            # membership row pointing at a deleted team and lock themselves
            # out of joining or creating any team going forward.
            now_iso = datetime.now(timezone.utc).isoformat()
            for invite in list_team_invites_for_team(team_id):
                if invite.get("status") == "pending":
                    update_team_invite(invite["inviteId"], {"status": "revoked", "revokedAt": now_iso})
            delete_team_membership(user_id, team_id)
            delete_team(team_id)
        body = _parse_body(event)
        apple_revoked = _maybe_revoke_apple(user_id, body)
        counts = _cleanup_servers_for_user(user_id)
        counts["pushDevicesDeleted"] = _cleanup_push_devices_for_user(user_id)
        counts["oauthCredentialsDeleted"] = delete_oauth_credentials_by_user(user_id)
        counts["harnessRunSummariesDeleted"] = delete_harness_run_summaries(user_id)
        counts["harnessSuggestionsDeleted"] = delete_harness_suggestions(user_id)
        counts["harnessVersionsDeleted"] = delete_harness_versions(user_id)
        counts["slackMappingsDeleted"] = _delete_mappings_for_user(_SLACK_MAPPINGS_TABLE, "slackTeamId", user_id)
        counts["linearMappingsDeleted"] = _delete_mappings_for_user(_LINEAR_MAPPINGS_TABLE, "linearTeamId", user_id)
        counts["smsMappingsDeleted"] = _delete_mappings_for_user(_SMS_MAPPINGS_TABLE, "phoneNumber", user_id)
        counts["appleTokensRevoked"] = apple_revoked

        _delete_supabase_user(user_id)

        return respond(200, {"ok": True, **counts})

    except Exception as exc:
        import traceback
        print(f"Account deletion error: {exc}\n{traceback.format_exc()}")
        return respond(500, {"error": str(exc)})
