"""
Tiny helper for looking up a Supabase user by ID using the admin API.

Why centralize this:
  account.py inlines its own Supabase admin call (for user deletion).
  finalize.py needs to look up emails to send "workspace ready"
  notifications. Moving the pattern here means future callers (welcome
  email, billing notifications, etc.) don't each rebuild the urllib
  dance.

Returns (email, display_name) tuples. display_name walks user_metadata
in priority order — display_name → name → full_name → first half of email
— so we always have something nicer than the raw user UUID to greet
the user with.

Best-effort: on any failure (missing env var, network error, 4xx) the
caller gets (None, None) and decides whether that's worth aborting.
Most callers (notifications) just skip the personalized bit.
"""
from __future__ import annotations  # `X | None` syntax under Python <3.10 unit tests
import json
import os
import urllib.error
import urllib.request


def get_user_info(user_id: str) -> tuple[str | None, str | None]:
    """Fetch (email, display_name) for a Supabase user.

    Returns (None, None) on missing config, missing user, or any HTTP
    error — caller treats that as "no info, send anyway with generic
    greeting" or skip entirely depending on context.
    """
    if not user_id:
        return None, None

    service_role_key = (os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    supabase_url = (os.environ.get("SUPABASE_URL") or "").strip().rstrip("/")
    if not service_role_key or not supabase_url:
        return None, None

    request = urllib.request.Request(
        f"{supabase_url}/auth/v1/admin/users/{user_id}",
        headers={
            "apikey": service_role_key,
            "Authorization": f"Bearer {service_role_key}",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        # 404 means the user was deleted between when our code captured
        # their id and when we tried to look them up. Not actionable.
        # Other 4xx/5xx — log + bail, caller continues.
        print(f"supabase_admin: HTTP {exc.code} fetching user {user_id}")
        return None, None
    except Exception as exc:
        print(f"supabase_admin: unexpected error fetching user {user_id}: {exc}")
        return None, None

    email = data.get("email") or None
    meta = data.get("user_metadata") or {}
    # Display name walks meta in priority order. Supabase OAuth providers
    # populate different fields (Google → name, GitHub → name+full_name,
    # Apple → display_name); falling through covers them all.
    display = (
        meta.get("display_name")
        or meta.get("name")
        or meta.get("full_name")
        or (email.split("@", 1)[0] if email else None)
    )
    return email, display
