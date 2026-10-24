import json
import os
import urllib.request

import jwt
from jwt.algorithms import ECAlgorithm

_hs256_secret = None
_jwks_cache = None


def extract_auth_header(headers):
    if not isinstance(headers, dict):
        return None
    return headers.get("authorization") or headers.get("Authorization")


def _hs256_secret_val():
    global _hs256_secret
    if not _hs256_secret:
        _hs256_secret = os.environ.get("SUPABASE_JWT_SECRET", "")
    return _hs256_secret


def _get_public_key(kid):
    """Fetch Supabase JWKS and return the public key matching the given kid."""
    global _jwks_cache
    if _jwks_cache is None:
        url = f"{os.environ['SUPABASE_URL']}/auth/v1/.well-known/jwks.json"
        with urllib.request.urlopen(url, timeout=5) as resp:
            _jwks_cache = json.load(resp)
    for key in _jwks_cache.get("keys", []):
        if key.get("kid") == kid:
            return ECAlgorithm.from_jwk(json.dumps(key))
    return None


def verify_token(auth_header):
    """Verify a Supabase JWT (HS256 or ES256) from the Authorization header."""
    if not auth_header or not auth_header.startswith("Bearer "):
        raise Exception("Missing or invalid Authorization header")
    token = auth_header[7:]

    header = jwt.get_unverified_header(token)
    alg = header.get("alg", "HS256")
    issuer = f"{os.environ['SUPABASE_URL']}/auth/v1"

    if alg == "ES256":
        kid = header.get("kid")
        public_key = _get_public_key(kid)
        if not public_key:
            raise Exception(f"Unknown JWT kid: {kid}")
        payload = jwt.decode(
            token,
            public_key,
            algorithms=["ES256"],
            issuer=issuer,
            options={"verify_aud": False},
        )
    else:
        payload = jwt.decode(
            token,
            _hs256_secret_val(),
            algorithms=["HS256"],
            issuer=issuer,
            options={"verify_aud": False},
        )

    return payload  # payload["sub"] = userId (UUID string)
