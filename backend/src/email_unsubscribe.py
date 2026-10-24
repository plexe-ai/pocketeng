"""
GET /email/unsubscribe?token=<hmac> — public, no auth required.

Validates the HMAC token, sets `emailUnsubscribed=true` on the user's
Supabase metadata, returns a tiny confirmation HTML page.

Token format: `<base64url(user_id)>.<base64url(hmac_sha256(user_id, secret))>`

Why HMAC and not just user_id:
  Putting the bare user UUID in an unsub link would let anyone with
  read access to a forwarded email unsubscribe that user — trivial
  abuse vector. HMAC means only the holder of UNSUBSCRIBE_SECRET
  (i.e. our backend) could have generated a valid link.

Why not a DDB-stored opaque token:
  Stateless verification keeps this Lambda dependency-free of DDB.
  Tokens never expire (CAN-SPAM doesn't require expiry; users want
  unsub to keep working forever).

Idempotent: re-clicking the same link is a no-op (still returns the
"unsubscribed" page).
"""
from __future__ import annotations
import base64
import hashlib
import hmac
import json
import os
import urllib.error
import urllib.request


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(s: str) -> bytes:
    padding = b"=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s.encode("ascii") + padding)


def make_unsubscribe_token(user_id: str, secret: str) -> str:
    """Generate the token a sender Lambda embeds in an outgoing email.
    Reused by the activity-nudge scheduler. Format documented in this
    module's docstring."""
    if not secret:
        # Fail loudly. A live email with an invalid unsub link is worse
        # than no email — CAN-SPAM violations stack.
        raise RuntimeError("UNSUBSCRIBE_SECRET not configured — refusing to mint token")
    user_part = _b64url(user_id.encode("utf-8"))
    sig = hmac.new(secret.encode("utf-8"), user_id.encode("utf-8"), hashlib.sha256).digest()
    sig_part = _b64url(sig)
    return f"{user_part}.{sig_part}"


def _verify_token(token: str, secret: str) -> str | None:
    """Return user_id if token is valid; None on any failure (bad
    format, mismatched signature, etc). Constant-time comparison to
    avoid timing-leaked length info on the secret."""
    if not token or "." not in token:
        return None
    try:
        user_part, sig_part = token.split(".", 1)
        user_id = _b64url_decode(user_part).decode("utf-8")
        provided_sig = _b64url_decode(sig_part)
    except Exception:
        return None
    expected_sig = hmac.new(
        secret.encode("utf-8"), user_id.encode("utf-8"), hashlib.sha256,
    ).digest()
    if not hmac.compare_digest(provided_sig, expected_sig):
        return None
    return user_id


def _set_unsubscribed(user_id: str) -> bool:
    """Merge `emailUnsubscribed: true` into Supabase user metadata.
    Returns True on success. We read-merge-write to avoid clobbering
    other metadata fields."""
    service_role_key = (os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    supabase_url = (os.environ.get("SUPABASE_URL") or "").strip().rstrip("/")
    if not service_role_key or not supabase_url:
        return False
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
        print(f"unsubscribe: failed to read user metadata for {user_id}: {exc}")
        return False
    metadata = dict(current.get("user_metadata") or {})
    metadata["emailUnsubscribed"] = True
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
        print(f"unsubscribe: failed to set emailUnsubscribed for {user_id}: {exc}")
        return False


def _html_page(title: str, body: str, status: int = 200) -> dict:
    """Friendly HTML response. The user just clicked a link from their
    inbox — they expect a page, not JSON."""
    html = f"""<!doctype html>
<html><head>
  <meta charset="utf-8">
  <title>{title}</title>
  <style>
    body {{ background: #0a0a0f; color: #eaeaef;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      margin: 0; padding: 0; min-height: 100vh; display: flex;
      align-items: center; justify-content: center; }}
    .card {{ background: #15151a; border: 1px solid #2a2a32;
      border-radius: 16px; padding: 32px; max-width: 420px;
      margin: 24px; }}
    h1 {{ font-size: 20px; margin: 0 0 12px; color: #ffffff;
      font-weight: 600; }}
    p {{ font-size: 14px; line-height: 1.55; color: #c4c4cc;
      margin: 0 0 12px; }}
    a {{ color: #6b9eff; text-decoration: none; }}
  </style>
</head><body>
  <div class="card">{body}</div>
</body></html>"""
    return {
        "statusCode": status,
        "headers": {"Content-Type": "text/html; charset=utf-8"},
        "body": html,
    }


def handler(event, context):
    secret = (os.environ.get("UNSUBSCRIBE_SECRET") or "").strip()
    if not secret:
        # No secret = can't verify anything = refuse all.
        return _html_page(
            "Unavailable",
            "<h1>Unsubscribe is temporarily unavailable.</h1>"
            "<p>Please email support@plexe.ai if this persists.</p>",
            status=503,
        )
    qs = event.get("queryStringParameters") or {}
    token = (qs.get("token") or "").strip()
    user_id = _verify_token(token, secret)
    if not user_id:
        return _html_page(
            "Invalid link",
            "<h1>This unsubscribe link is invalid or expired.</h1>"
            "<p>If you keep getting Pocket Eng emails you don't want, "
            "reply to one and we'll sort it out manually.</p>",
            status=400,
        )
    ok = _set_unsubscribed(user_id)
    if not ok:
        return _html_page(
            "Couldn't unsubscribe",
            "<h1>Something went wrong.</h1>"
            "<p>Please email support@plexe.ai and we'll handle it manually.</p>",
            status=500,
        )
    return _html_page(
        "Unsubscribed",
        "<h1>You're unsubscribed.</h1>"
        "<p>You won't get any more activity nudges or marketing emails "
        "from Pocket Eng. Transactional notifications (workspace ready, "
        "session complete) still go through, since those are tied to "
        "actions you took yourself.</p>"
        "<p><a href=\"https://console.pocketeng.ai\">Back to Pocket Eng &rarr;</a></p>",
    )
