"""
POST /account/oauth-credentials — securely store provider tokens needed for later cleanup.
"""
import json
from datetime import datetime, timezone

from src.lib.auth import extract_auth_header, verify_token
from src.lib.db import (
    get_oauth_credential,
    put_oauth_credential,
    update_oauth_credential,
)
from src.lib.kms import encrypt

_ALLOWED_PROVIDERS = {"apple"}


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def respond(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def handler(event, context):
    try:
        try:
            claims = verify_token(extract_auth_header(event.get("headers", {})))
        except Exception as exc:
            return respond(401, {"error": str(exc)})

        body = json.loads(event.get("body") or "{}")
        provider = str(body.get("provider") or "").strip().lower()
        provider_token = str(body.get("providerToken") or "").strip()
        provider_refresh_token = str(body.get("providerRefreshToken") or "").strip()

        if provider not in _ALLOWED_PROVIDERS:
            return respond(400, {"error": "provider must be apple"})
        if not provider_token and not provider_refresh_token:
            return respond(400, {"error": "providerToken or providerRefreshToken required"})

        user_id = claims["sub"]
        now = _now_iso()
        existing = get_oauth_credential(user_id, provider)
        updates = {"updatedAt": now}
        if provider_token:
            updates["accessToken"] = encrypt(provider_token)
        if provider_refresh_token:
            updates["refreshToken"] = encrypt(provider_refresh_token)

        if existing:
            update_oauth_credential(user_id, provider, updates)
        else:
            put_oauth_credential({
                "userId": user_id,
                "provider": provider,
                "createdAt": now,
                **updates,
            })

        return respond(200, {"ok": True, "provider": provider})

    except Exception as exc:
        import traceback
        print(f"OAuth credential store error: {exc}\n{traceback.format_exc()}")
        return respond(500, {"error": str(exc)})
