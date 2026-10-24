import json
from datetime import datetime, timezone

from src.lib.auth import extract_auth_header, verify_token
from src.lib.db import (
    get_team,
    get_team_invite,
    get_team_membership,
    list_team_invites_for_email,
    put_team_membership,
    update_team_invite,
)
from src.lib.team_auth import get_active_team_membership


def _now():
    return datetime.now(timezone.utc)


def respond(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def _method(event):
    return (
        (event.get("requestContext") or {}).get("http", {}).get("method")
        or event.get("httpMethod")
        or "GET"
    ).upper()


def handler(event, context):
    try:
        try:
            claims = verify_token(extract_auth_header(event.get("headers", {})))
        except Exception as exc:
            return respond(401, {"error": str(exc)})

        user_id = claims["sub"]
        email = str(claims.get("email") or "").strip().lower()
        method = _method(event)
        invite_id = (event.get("pathParameters") or {}).get("inviteId")
        path = ((event.get("requestContext") or {}).get("http") or {}).get("path", "")

        if path.endswith("/team-invites") and method == "GET":
            invites = list_team_invites_for_email(email) if email else []
            now = _now()
            visible = []
            for invite in invites:
                if invite.get("status") != "pending":
                    continue
                expires_at = invite.get("expiresAt")
                if expires_at and datetime.fromisoformat(expires_at) < now:
                    continue
                team = get_team(invite["teamId"])
                visible.append({
                    **invite,
                    "teamName": team.get("name") if team else None,
                })
            return respond(200, {"invites": visible})

        if path.endswith("/accept") and invite_id and method == "POST":
            invite = get_team_invite(invite_id)
            if not invite:
                return respond(404, {"error": "Invite not found"})
            if invite.get("status") != "pending":
                return respond(400, {"error": "Invite is no longer active"})
            if not email or invite.get("email") != email:
                return respond(403, {"error": "Invite email does not match signed-in user"})
            expires_at = invite.get("expiresAt")
            if expires_at and datetime.fromisoformat(expires_at) < _now():
                update_team_invite(invite_id, {"status": "expired"})
                return respond(400, {"error": "Invite expired"})
            # Verify the inviting team still exists. Without this check an
            # invite issued before the team was dissolved (e.g. via
            # sole-member account deletion) would create a membership row
            # pointing at a tombstone, locking the user out of joining or
            # creating any team going forward.
            if not get_team(invite["teamId"]):
                update_team_invite(invite_id, {"status": "revoked", "revokedAt": _now().isoformat()})
                return respond(410, {"error": "Team no longer exists"})
            if get_active_team_membership(user_id):
                return respond(409, {"error": "User already belongs to a team"})
            if get_team_membership(user_id, invite["teamId"]):
                return respond(409, {"error": "User already belongs to this team"})
            now = _now().isoformat()
            put_team_membership({
                "userId": user_id,
                "teamId": invite["teamId"],
                "role": invite.get("role", "member"),
                "status": "active",
                "joinedAt": now,
                "email": email or None,
            })
            update_team_invite(invite_id, {
                "status": "accepted",
                "acceptedAt": now,
                "acceptedByUserId": user_id,
            })
            return respond(200, {"ok": True, "teamId": invite["teamId"]})

        return respond(405, {"error": "Unsupported route"})

    except Exception as exc:
        import traceback
        print(f"Team invites handler error: {exc}\n{traceback.format_exc()}")
        return respond(500, {"error": str(exc)})
