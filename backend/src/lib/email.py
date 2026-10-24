"""
Tiny wrapper over Resend's REST API for transactional emails.

Why Resend (not Supabase SMTP, not Lambda+SES):
  - Supabase's default SMTP is fine for auth emails (magic link, reset)
    but doesn't let us author branded transactional emails — it's a
    closed system tied to auth events.
  - SES requires production-access verification, sender domain DKIM,
    and bounce/complaint handling we'd own. Resend handles all of that.
  - Resend's REST API is one HTTP call, no SDK needed. We dodge the
    weight of `resend` PyPI dep on every Lambda cold-start.

Behavior:
  - If RESEND_API_KEY is unset (e.g. early-deploy environments before
    DNS is wired), this is a deliberate no-op. Logs a single line and
    returns False. Callers MUST treat email as best-effort and never
    fail their parent flow on a None/False return.
  - If RESEND_FROM is unset, falls back to a placeholder so unit tests
    don't need the env var. Production deploys MUST set both.

Sender domain note:
  Resend rejects emails from unverified domains. Before this code can
  actually deliver, the operator needs to:
    1. Add the pocketeng.ai domain in Resend's dashboard
    2. Add the SPF + DKIM + DMARC DNS records Resend prints
    3. Wait a few minutes for DNS to propagate
    4. Set RESEND_FROM to e.g. "Pocket Eng <hello@pocketeng.ai>"
"""
import json
import os
import urllib.error
import urllib.request

# Resend's transactional-email endpoint. Public, stable since the API's
# launch. POST a JSON body, get back {"id": "..."} on success.
_RESEND_URL = "https://api.resend.com/emails"


def send_email(
    to: str,
    subject: str,
    html: str,
    text: str = None,
    *,
    from_address: str = None,
    reply_to: str = None,
) -> bool:
    """Send one email via Resend. Returns True on success, False on any
    failure (network, auth, rejected sender, etc).

    Best-effort by design — callers MUST NOT fail their parent flow on a
    False return. Email delivery is a side-quest to the actual work.
    """
    api_key = (os.environ.get("RESEND_API_KEY") or "").strip()
    if not api_key:
        # Pre-deploy / dev environments. No key, no email — be quiet
        # rather than failing visibly. Log once so we know it's a no-op.
        print(f"email: RESEND_API_KEY unset — skipping send to {to}")
        return False

    sender = (from_address or os.environ.get("RESEND_FROM") or "").strip()
    if not sender:
        print(f"email: RESEND_FROM unset and no from_address override — skipping send to {to}")
        return False

    payload = {
        "from": sender,
        "to": [to],
        "subject": subject,
        "html": html,
    }
    # text is optional but recommended — improves spam scoring and helps
    # text-only mail clients (yes, those still exist).
    if text:
        payload["text"] = text
    if reply_to:
        # Resend accepts a list — singleton for our case.
        payload["reply_to"] = [reply_to]

    request = urllib.request.Request(
        _RESEND_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            # Resend's API sits behind Cloudflare. Without an explicit
            # User-Agent, urllib defaults to "Python-urllib/3.12" which
            # Cloudflare's bot rules silently 403 with body "error code:
            # 1010". This shipped broken for 60+ days — every welcome /
            # workspace-ready / nudge / team-invite send was eaten by
            # Cloudflare before reaching Resend. Any non-default UA gets
            # through; the descriptive form below is also useful when
            # Resend's support team needs to identify our traffic.
            "User-Agent": "PocketEng-Backend (+https://pocketeng.ai)",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as resp:
            body = resp.read().decode("utf-8", errors="ignore")
            print(f"email: sent to {to} subject={subject!r} resp={body[:200]}")
            return True
    except urllib.error.HTTPError as exc:
        # 422 = validation (most common: unverified sender domain).
        # 401 = bad/missing API key. 429 = rate-limited.
        # We log + swallow — see best-effort note above.
        detail = ""
        try:
            detail = exc.read().decode("utf-8", errors="ignore")[:400]
        except Exception:
            pass
        print(f"email: HTTP {exc.code} sending to {to}: {detail}")
        return False
    except Exception as exc:
        print(f"email: unexpected error sending to {to}: {exc}")
        return False
