import json
import uuid
from datetime import datetime, timedelta, timezone

from src.lib.auth import extract_auth_header, verify_token
from src.lib.db import (
    get_team,
    get_team_invite,
    get_team_membership,
    list_team_invites_for_team,
    put_team,
    put_team_invite,
    put_team_membership,
    update_team,
    update_team_invite,
    update_team_membership,
    delete_team_membership,
)
from src.lib.email import send_email
from src.lib.email_templates import team_invite as render_team_invite
from src.lib.team_auth import (
    get_active_team_membership,
    get_team_for_user,
    is_team_admin,
    list_active_team_members,
)


def _now():
    return datetime.now(timezone.utc)


def _now_iso():
    return _now().isoformat()


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


def _active_admin_count(team_id):
    members = list_active_team_members(team_id)
    return len([item for item in members if item.get("role") == "admin"])


def _serialize_team(team, membership):
    if not team or not membership:
        return None
    return {
        "teamId": team["teamId"],
        "name": team.get("name"),
        "billingOwnerUserId": team.get("billingOwnerUserId"),
        "createdAt": team.get("createdAt"),
        "role": membership.get("role"),
    }


def handler(event, context):
    try:
        try:
            claims = verify_token(extract_auth_header(event.get("headers", {})))
        except Exception as exc:
            return respond(401, {"error": str(exc)})

        user_id = claims["sub"]
        user_email = (claims.get("email") or "").strip().lower() or None
        method = _method(event)
        path_params = event.get("pathParameters") or {}
        team_id = path_params.get("teamId")
        member_user_id = path_params.get("userId")
        path = ((event.get("requestContext") or {}).get("http") or {}).get("path", "")
        body = json.loads(event.get("body") or "{}")

        if path.endswith("/teams/me") and method == "GET":
            team, membership = get_team_for_user(user_id)
            # Self-heal: pre-email-persistence membership rows lack `email`,
            # which makes teammates render the caller as a UUID. Backfill
            # from the JWT claim on first read.
            if team and user_email and membership.get("email") != user_email:
                update_team_membership(user_id, team["teamId"], {"email": user_email})
                membership = {**membership, "email": user_email}
            members = list_active_team_members(team["teamId"]) if team else []
            members = [
                {**m, "email": user_email} if m.get("userId") == user_id and user_email and not m.get("email") else m
                for m in members
            ]
            invites = list_team_invites_for_team(team["teamId"]) if team and membership.get("role") == "admin" else []
            return respond(200, {
                "team": _serialize_team(team, membership),
                "members": members,
                "invites": invites,
            })

        if path.endswith("/teams") and method == "POST":
            if get_active_team_membership(user_id):
                return respond(409, {"error": "User already belongs to a team"})
            name = str(body.get("name") or "").strip()
            if not name:
                return respond(400, {"error": "name required"})
            now = _now_iso()
            team_id = str(uuid.uuid4())
            put_team({
                "teamId": team_id,
                "name": name[:120],
                "billingOwnerUserId": user_id,
                "createdAt": now,
                "createdByUserId": user_id,
            })
            put_team_membership({
                "userId": user_id,
                "teamId": team_id,
                "role": "admin",
                "status": "active",
                "joinedAt": now,
                "email": user_email,
            })
            return respond(201, {"team": {
                "teamId": team_id,
                "name": name[:120],
                "billingOwnerUserId": user_id,
                "createdAt": now,
                "role": "admin",
            }})

        if not team_id:
            return respond(400, {"error": "teamId required"})

        team = get_team(team_id)
        if not team:
            return respond(404, {"error": "Team not found"})

        # Gate: must be a member of the team. Per-route handlers below enforce
        # whatever finer-grained admin/self checks they need (e.g. self-leave
        # is allowed on DELETE /members/{userId} even for non-admin members).
        if not get_team_membership(user_id, team_id):
            return respond(403, {"error": "Not a team member"})

        if path.endswith(f"/teams/{team_id}") and method == "PATCH":
            if not is_team_admin(user_id, team_id):
                return respond(403, {"error": "Admin access required"})
            name = str(body.get("name") or "").strip()
            if not name:
                return respond(400, {"error": "name required"})
            update_team(team_id, {"name": name[:120]})
            return respond(200, {"ok": True, "name": name[:120]})

        if path.endswith(f"/teams/{team_id}/invites"):
            if not is_team_admin(user_id, team_id):
                return respond(403, {"error": "Admin access required"})
            if method == "GET":
                return respond(200, {"invites": list_team_invites_for_team(team_id)})
            if method == "POST":
                email = str(body.get("email") or "").strip().lower()
                role = str(body.get("role") or "member").strip().lower()
                if not email or "@" not in email:
                    return respond(400, {"error": "valid email required"})
                if role not in {"admin", "member"}:
                    return respond(400, {"error": "role must be admin or member"})
                for invite in list_team_invites_for_team(team_id):
                    if invite.get("email") == email and invite.get("status") == "pending":
                        update_team_invite(invite["inviteId"], {"status": "revoked", "revokedAt": _now_iso()})
                now = _now()
                invite_id = str(uuid.uuid4())
                put_team_invite({
                    "inviteId": invite_id,
                    "teamId": team_id,
                    "email": email,
                    "role": role,
                    "status": "pending",
                    "createdAt": now.isoformat(),
                    "expiresAt": (now + timedelta(days=7)).isoformat(),
                    "invitedByUserId": user_id,
                })
                # Best-effort invite email. Wrapped so that any unexpected
                # failure (Resend network blip, etc.) never blocks the API
                # response — the invite row is already persisted and an
                # admin can re-POST the same email to retry (the loop
                # above revokes the prior pending row first, making
                # re-POST behave like a resend).
                # We render the inviter's email (from the JWT claim, no
                # extra lookup) rather than a display name. Less pretty
                # for long emails but avoids wiring SUPABASE_SERVICE_ROLE_KEY
                # into this Lambda just for one optional cosmetic field.
                # TODO: persist email-delivery status on the invite row
                # (e.g. lastEmailAttemptAt / lastEmailStatus) and surface
                # it in the settings UI so admins can see when delivery
                # failed and trigger an explicit resend without having to
                # recreate the invite. Out of scope for this PR.
                try:
                    subject, html, text = render_team_invite(
                        team_name=team.get("name") or "your team",
                        inviter_email=user_email,
                    )
                    send_email(email, subject, html, text=text)
                except Exception as exc:
                    print(f"team: invite email send failed for inviteId={invite_id}: {exc}")
                return respond(201, {"inviteId": invite_id, "email": email, "role": role})

        if path.endswith(f"/teams/{team_id}/members/{member_user_id}"):
            membership = get_team_membership(member_user_id, team_id)
            if not membership:
                return respond(404, {"error": "Member not found"})

            if method == "PATCH":
                if not is_team_admin(user_id, team_id):
                    return respond(403, {"error": "Admin access required"})
                role = str(body.get("role") or "").strip().lower()
                if role not in {"admin", "member"}:
                    return respond(400, {"error": "role must be admin or member"})
                if member_user_id == team.get("billingOwnerUserId") and role != "admin":
                    return respond(400, {"error": "Billing owner must remain admin"})
                # Last-admin invariant: an admin cannot demote themselves (or
                # another admin) to member if they're the only active admin.
                # The DELETE path enforces the same — keep them in sync so
                # role-demotion isn't an accidental escape hatch.
                if (
                    membership.get("role") == "admin"
                    and role != "admin"
                    and _active_admin_count(team_id) <= 1
                ):
                    return respond(400, {"error": "Team must keep at least one admin"})
                update_team_membership(member_user_id, team_id, {"role": role})
                return respond(200, {"ok": True, "role": role})

            if method == "DELETE":
                is_self = member_user_id == user_id
                if not is_self and not is_team_admin(user_id, team_id):
                    return respond(403, {"error": "Admin access required"})
                if member_user_id == team.get("billingOwnerUserId"):
                    return respond(400, {"error": "Billing owner cannot be removed"})
                if membership.get("role") == "admin" and _active_admin_count(team_id) <= 1:
                    return respond(400, {"error": "Team must keep at least one admin"})
                delete_team_membership(member_user_id, team_id)
                return respond(200, {"ok": True})

        return respond(405, {"error": "Unsupported route"})

    except Exception as exc:
        import traceback
        print(f"Team handler error: {exc}\n{traceback.format_exc()}")
        return respond(500, {"error": str(exc)})
