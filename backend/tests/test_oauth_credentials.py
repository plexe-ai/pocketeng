"""Unit tests for OAuth credential storage handler."""
import json
import os
from unittest.mock import patch

os.environ.setdefault("SUPABASE_URL", "https://test.supabase.co")
os.environ.setdefault("SUPABASE_JWT_SECRET", "test-secret")
os.environ.setdefault("OAUTH_CREDENTIALS_TABLE", "pe-oauth-credentials-test")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")

FAKE_CLAIMS = {"sub": "user-123"}


def _make_event(body=None):
    return {
        "headers": {"authorization": "Bearer fake-token"},
        "requestContext": {"http": {"method": "POST"}},
        "body": json.dumps(body or {}),
    }


class TestStoreOAuthCredential:
    def test_rejects_invalid_provider(self):
        with patch("src.oauth_credentials.verify_token", return_value=FAKE_CLAIMS):
            from src.oauth_credentials import handler

            result = handler(_make_event({"provider": "google", "providerToken": "x"}), {})

            assert result["statusCode"] == 400

    def test_creates_new_credential(self):
        with patch("src.oauth_credentials.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.oauth_credentials.get_oauth_credential", return_value=None), \
             patch("src.oauth_credentials.encrypt", side_effect=lambda value: f"enc:{value}"), \
             patch("src.oauth_credentials.put_oauth_credential") as mock_put:
            from src.oauth_credentials import handler

            result = handler(_make_event({
                "provider": "apple",
                "providerRefreshToken": "refresh-123",
            }), {})

            assert result["statusCode"] == 200
            item = mock_put.call_args[0][0]
            assert item["userId"] == "user-123"
            assert item["provider"] == "apple"
            assert item["refreshToken"] == "enc:refresh-123"

    def test_updates_existing_credential(self):
        with patch("src.oauth_credentials.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.oauth_credentials.get_oauth_credential", return_value={"userId": "user-123", "provider": "apple"}), \
             patch("src.oauth_credentials.encrypt", side_effect=lambda value: f"enc:{value}"), \
             patch("src.oauth_credentials.update_oauth_credential") as mock_update:
            from src.oauth_credentials import handler

            result = handler(_make_event({
                "provider": "apple",
                "providerToken": "access-123",
                "providerRefreshToken": "refresh-123",
            }), {})

            assert result["statusCode"] == 200
            updates = mock_update.call_args[0][2]
            assert updates["accessToken"] == "enc:access-123"
            assert updates["refreshToken"] == "enc:refresh-123"
