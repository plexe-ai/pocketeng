import base64
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

import jwt


class AppleConfigurationError(RuntimeError):
    pass


class AppleRevocationError(RuntimeError):
    pass


def _required_env(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise AppleConfigurationError(f"{name} is not configured")
    return value


def _private_key():
    inline_key = os.environ.get("APPLE_PRIVATE_KEY", "").strip()
    if inline_key:
        return inline_key.replace("\\n", "\n")

    b64_key = os.environ.get("APPLE_PRIVATE_KEY_B64", "").strip()
    if b64_key:
        return base64.b64decode(b64_key).decode("utf-8")

    raise AppleConfigurationError("APPLE_PRIVATE_KEY or APPLE_PRIVATE_KEY_B64 is not configured")


def generate_client_secret(now=None):
    issued_at = int(now or time.time())
    client_id = _required_env("APPLE_CLIENT_ID")
    team_id = _required_env("APPLE_TEAM_ID")
    key_id = _required_env("APPLE_KEY_ID")
    private_key = _private_key()

    token = jwt.encode(
        {
            "iss": team_id,
            "iat": issued_at,
            "exp": issued_at + 86400 * 180,
            "aud": "https://appleid.apple.com",
            "sub": client_id,
        },
        private_key,
        algorithm="ES256",
        headers={"kid": key_id},
    )
    return token if isinstance(token, str) else token.decode("utf-8")


def revoke_apple_token(*, refresh_token=None, access_token=None):
    token = (refresh_token or access_token or "").strip()
    if not token:
        raise AppleRevocationError("No Apple token available for revocation")

    client_id = _required_env("APPLE_CLIENT_ID")
    client_secret = generate_client_secret()
    token_type_hint = "refresh_token" if refresh_token else "access_token"

    request = urllib.request.Request(
        "https://appleid.apple.com/auth/revoke",
        data=urllib.parse.urlencode({
            "client_id": client_id,
            "client_secret": client_secret,
            "token": token,
            "token_type_hint": token_type_hint,
        }).encode("utf-8"),
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            response.read()
            return True
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        try:
            payload = json.loads(detail or "{}")
        except Exception:
            payload = {}
        error_code = payload.get("error")
        if exc.code == 400 and error_code == "invalid_grant":
            return False
        raise AppleRevocationError(
            f"Apple token revocation failed ({exc.code}): {detail[:200]}"
        ) from exc
