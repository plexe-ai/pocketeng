"""
POST /account/welcome — fire the onboarding welcome email exactly once
per user.

Triggered by the web `/onboarding` page on mount. Idempotent: a flag
on the user's Supabase metadata (`welcomeEmailSent: true`) prevents
double-sends if the user revisits onboarding.

Why a frontend-pinged endpoint and not a Supabase database webhook:
  Webhooks are cleaner for decoupling but require setup outside the
  codebase (Supabase dashboard config we don't yet automate). The
  frontend ping is one fetch from a place we already control, fully
  self-contained, no infrastructure step.

Why a separate Lambda function and not a sub-route on AccountFunction:
  AccountFunction is currently DELETE-only. Mixing a public-ish welcome
  trigger with a destructive account-deletion handler in one Lambda
  meant either bumping AccountFunction's permission scope or layering
  in defensive auth checks. Cheaper to keep them separate.

Auth: Supabase JWT (same shape as every other authenticated endpoint).
The user is authenticating themselves to send their own welcome.
"""
from __future__ import annotations
import json
import os
import urllib.error
import urllib.request

from src.lib.auth import extract_auth_header, verify_token
from src.lib.email import send_email
from src.lib.email_templates import welcome as render_welcome
from src.lib.supabase_admin import get_user_info


def respond(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def _set_user_metadata_flag(user_id: str) -> bool:
    """Mark welcomeEmailSent=true on the user's Supabase metadata.
    Returns True on success, False on any failure. Failure here is
    fine: worst case a duplicate email on the user's next /onboarding
    visit, which is acceptable given how rare that path is.

    We MERGE the flag with whatever metadata is already there. The PUT
    endpoint replaces user_metadata wholesale, so we'd clobber other
    fields (githubUsername, defaultAgent, etc.) without the read-merge
    dance below.
    """
    service_role_key = (os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    supabase_url = (os.environ.get("SUPABASE_URL") or "").strip().rstrip("/")
    if not service_role_key or not supabase_url:
        return False

    # Read existing metadata so we can merge rather than replace.
    try:
        get_req = urllib.request.Request(
            f"{supabase_url}/auth/v1/admin/users/{user_id}",
            headers={
                "apikey": service_role_key,
                "Authorization": f"Bearer {service_role_key}",
            },
            method="GET",
        )
        with urllib.request.urlopen(get_req, timeout=10) as resp:
            current = json.loads(resp.read().decode("utf-8") or "{}")
    except Exception as exc:
        print(f"welcome: failed to read user metadata for {user_id}: {exc}")
        return False

    metadata = dict(current.get("user_metadata") or {})
    metadata["welcomeEmailSent"] = True

    try:
        put_req = urllib.request.Request(
            f"{supabase_url}/auth/v1/admin/users/{user_id}",
            data=json.dumps({"user_metadata": metadata}).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "apikey": service_role_key,
                "Authorization": f"Bearer {service_role_key}",
            },
            method="PUT",
        )
        with urllib.request.urlopen(put_req, timeout=10) as _:
            return True
    except Exception as exc:
        print(f"welcome: failed to set welcomeEmailSent for {user_id}: {exc}")
        return False


def _already_sent(user_id: str) -> bool:
    """Best-effort idempotency check. Returns True if the flag is
    confirmed set; False on any failure or if the flag is unset/missing.
    On lookup failure we err on "send anyway" because a duplicate email
    is preferable to never welcoming the user at all."""
    service_role_key = (os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    supabase_url = (os.environ.get("SUPABASE_URL") or "").strip().rstrip("/")
    if not service_role_key or not supabase_url:
        return False
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
            data = json.loads(resp.read().decode("utf-8") or "{}")
        return bool((data.get("user_metadata") or {}).get("welcomeEmailSent"))
    except Exception:
        return False


def handler(event, context):
    """POST /account/welcome with empty body.

    Returns:
      200 {"sent": true}        on first invocation per user
      200 {"sent": false, "reason": "already-sent"}  on subsequent calls
      200 {"sent": false, "reason": "..."}  if config missing or send failed
                                            (still 200 — this is a fire-and-
                                            forget convenience endpoint,
                                            not user-facing critical path)
      401 if JWT missing/invalid
    """
    try:
        try:
            claims = verify_token(extract_auth_header(event.get("headers", {})))
        except Exception as e:
            return respond(401, {"error": str(e)})
        user_id = claims["sub"]

        if _already_sent(user_id):
            return respond(200, {"sent": False, "reason": "already-sent"})

        email, name = get_user_info(user_id)
        if not email:
            return respond(200, {"sent": False, "reason": "no-email"})

        subject, html, text = render_welcome(name=name)
        ok = send_email(email, subject, html, text=text)
        if not ok:
            # Don't set the flag if the email failed; let a subsequent
            # /onboarding mount retry (rare but possible if Resend was
            # temporarily down or DNS just propagated).
            return respond(200, {"sent": False, "reason": "send-failed"})

        _set_user_metadata_flag(user_id)
        return respond(200, {"sent": True})

    except Exception as exc:
        # Never raise to the client — frontend treats this as best-effort.
        print(f"welcome: unhandled error: {exc}")
        return respond(200, {"sent": False, "reason": "internal-error"})
