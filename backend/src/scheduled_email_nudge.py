"""
Scheduled Lambda — fires the 24h activity-nudge email to users whose
workspace has been ready for >24h but who haven't sent any messages.

Triggered by EventBridge on a fixed cadence (rate(1 hour) by default).
On each tick:
  1. Scan pe-servers-prod for `readiness.status == "ready"`.
  2. For each ready server, look up the owning user's metadata via
     Supabase admin API.
  3. Skip if `nudgeEmailSent`, `emailUnsubscribed`, or
     `welcomeEmailSent` is missing (welcome unsent → user is mid-onboarding).
  4. Skip if the server was created less than 24h ago (still in the
     fresh-signup window — they'll come back on their own).
  5. Skip if any session exists on the server (they've already kicked
     off real work).
  6. Send the activity-nudge email with a unique unsubscribe token,
     mark `nudgeEmailSent: true` on the user's metadata.

Best-effort throughout: any single user's failure to send doesn't
abort the loop. Errors logged + skipped.

Why scan and not query: pe-servers-prod has no GSI on
`readiness.status`. Adding one for one cron job not worth it. Scan
+ FilterExpression is fine at our user count and DDB charges by
returned bytes (not scanned bytes for filtered scans).

Bound on cost: at ~10K users this loop is still O(seconds). When that
breaks, switch to a `sentNudgeStatus` GSI pattern.
"""
from __future__ import annotations
import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

from src.email_unsubscribe import make_unsubscribe_token
from src.lib.db import _ddb, get_sessions_by_server  # type: ignore
from src.lib.email import send_email
from src.lib.email_templates import activity_nudge as render_activity_nudge


_SERVERS_TABLE = os.environ.get("SERVERS_TABLE", "pe-servers-prod")

# How long after server creation before we consider the user "stuck".
# 24h is the canonical window — long enough that a user who was just
# distracted has settled, short enough that we catch them while
# they still remember signing up.
_NUDGE_AGE_THRESHOLD_S = 24 * 3600

# Hard ceiling on how many users we email per tick. Defensive — if
# something goes wrong (e.g. flag-write fails for everyone, scan keeps
# returning the same users) we cap blast radius.
_MAX_EMAILS_PER_TICK = 100


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _parse_iso(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        # Python 3.11+ accepts trailing Z natively; 3.9/3.10 don't.
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except Exception:
        return None


def _scan_ready_servers() -> list[dict]:
    """All servers whose readiness.status == 'ready'.

    Inline FilterExpression rather than calling out to db.py — this
    is the only consumer of this exact filter and adding a generic
    helper there would just be one more thing to keep in sync.
    """
    servers = _ddb.Table(_SERVERS_TABLE)
    items: list[dict] = []
    last_key = None
    while True:
        kwargs = {
            "FilterExpression": "readiness.#s = :ready",
            "ExpressionAttributeNames": {"#s": "status"},
            "ExpressionAttributeValues": {":ready": "ready"},
        }
        if last_key:
            kwargs["ExclusiveStartKey"] = last_key
        resp = servers.scan(**kwargs)
        items.extend(resp.get("Items", []))
        last_key = resp.get("LastEvaluatedKey")
        if not last_key:
            break
    return items


def _supabase_admin_get(user_id: str) -> dict | None:
    service_role_key = (os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    supabase_url = (os.environ.get("SUPABASE_URL") or "").strip().rstrip("/")
    if not service_role_key or not supabase_url:
        return None
    try:
        req = urllib.request.Request(
            f"{supabase_url}/auth/v1/admin/users/{user_id}",
            headers={
                "apikey": service_role_key,
                "Authorization": f"Bearer {service_role_key}",
            },
            method="GET",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8") or "{}")
    except Exception as exc:
        print(f"nudge: supabase get failed for {user_id}: {exc}")
        return None


def _supabase_admin_set_metadata(user_id: str, patch: dict) -> bool:
    """Read-merge-write so we don't clobber other metadata fields."""
    service_role_key = (os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    supabase_url = (os.environ.get("SUPABASE_URL") or "").strip().rstrip("/")
    if not service_role_key or not supabase_url:
        return False
    current = _supabase_admin_get(user_id) or {}
    metadata = dict(current.get("user_metadata") or {})
    metadata.update(patch)
    try:
        req = urllib.request.Request(
            f"{supabase_url}/auth/v1/admin/users/{user_id}",
            data=json.dumps({"user_metadata": metadata}).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "apikey": service_role_key,
                "Authorization": f"Bearer {service_role_key}",
            },
            method="PUT",
        )
        with urllib.request.urlopen(req, timeout=10) as _:
            return True
    except Exception as exc:
        print(f"nudge: supabase set failed for {user_id}: {exc}")
        return False


def _eligible(server: dict, user: dict) -> tuple[bool, str]:
    """Decide whether to email this user. Returns (eligible, reason).

    The reason string is just for log clarity — every skip path
    surfaces in CloudWatch with a one-word "why."
    """
    metadata = user.get("user_metadata") or {}
    if metadata.get("nudgeEmailSent"):
        return False, "already-nudged"
    if metadata.get("emailUnsubscribed"):
        return False, "unsubscribed"
    if not metadata.get("welcomeEmailSent"):
        # Welcome path didn't run yet — user hasn't even hit /onboarding.
        # Don't preempt the welcome by sending the nudge instead.
        return False, "no-welcome-yet"
    created_at = _parse_iso(server.get("createdAt"))
    if not created_at:
        return False, "no-created-at"
    age_s = (_utcnow() - created_at).total_seconds()
    if age_s < _NUDGE_AGE_THRESHOLD_S:
        return False, f"too-fresh:{int(age_s)}s"
    # Did they kick off any session on this server? get_sessions_by_server
    # returns by-server, not by-user, but a user with multiple servers
    # would have hit at least one. Acceptable approximation.
    sessions = get_sessions_by_server(server["serverId"], limit=1)
    if sessions:
        return False, "has-session"
    return True, "eligible"


def handler(event, context):
    """EventBridge cron entry point. Returns a small report so you can
    eyeball CloudWatch invocations and see "X eligible, Y sent"."""
    secret = (os.environ.get("UNSUBSCRIBE_SECRET") or "").strip()
    if not secret:
        # Without an unsub secret we can't include a valid unsubscribe
        # link, and unsubscribed-able marketing email without a working
        # unsub link is a CAN-SPAM violation. Refuse to send.
        print("nudge: UNSUBSCRIBE_SECRET unset — refusing to send")
        return {"sent": 0, "reason": "no-unsub-secret"}

    api_base = (os.environ.get("PUBLIC_API_BASE_URL") or "").strip().rstrip("/")
    if not api_base:
        print("nudge: PUBLIC_API_BASE_URL unset — refusing to send")
        return {"sent": 0, "reason": "no-api-base"}

    sent = 0
    skipped: dict[str, int] = {}
    seen_users: set[str] = set()

    started = time.time()
    for server in _scan_ready_servers():
        if sent >= _MAX_EMAILS_PER_TICK:
            print(f"nudge: hit per-tick cap of {_MAX_EMAILS_PER_TICK} — stopping early")
            break
        user_id = server.get("userId")
        if not user_id or user_id in seen_users:
            # User has multiple ready servers — only consider once.
            continue
        seen_users.add(user_id)

        user = _supabase_admin_get(user_id)
        if not user:
            skipped["lookup-failed"] = skipped.get("lookup-failed", 0) + 1
            continue

        ok, reason = _eligible(server, user)
        if not ok:
            skipped[reason] = skipped.get(reason, 0) + 1
            continue

        email = user.get("email")
        if not email:
            skipped["no-email"] = skipped.get("no-email", 0) + 1
            continue

        # Whether to soft-pitch trial credits depends on if they have
        # their own creds connected. Quick check via the per-user
        # agent_credentials table is overkill — we just look at the
        # user_metadata flag the onboarding flow already maintains.
        metadata = user.get("user_metadata") or {}
        has_own_creds = bool(metadata.get("hasOwnAgentCredentials"))

        token = make_unsubscribe_token(user_id, secret)
        unsubscribe_url = f"{api_base}/email/unsubscribe?token={token}"

        subject, html, text = render_activity_nudge(
            unsubscribe_url=unsubscribe_url,
            has_own_credentials=has_own_creds,
        )
        if send_email(email, subject, html, text=text):
            _supabase_admin_set_metadata(user_id, {"nudgeEmailSent": True})
            sent += 1
        else:
            skipped["send-failed"] = skipped.get("send-failed", 0) + 1

    duration = round(time.time() - started, 2)
    summary = {"sent": sent, "skipped": skipped, "duration_s": duration}
    print(f"nudge: tick complete — {summary}")
    return summary
