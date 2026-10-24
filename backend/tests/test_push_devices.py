"""Unit tests for push device registration and unregistration."""
import json
import os
from unittest.mock import patch

os.environ.setdefault("SUPABASE_URL", "https://test.supabase.co")
os.environ.setdefault("SUPABASE_JWT_SECRET", "test-secret")
os.environ.setdefault("PUSH_DEVICES_TABLE", "pe-push-devices-test")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")

FAKE_CLAIMS = {"sub": "user-123"}


def _make_event(method="POST", body=None):
    return {
        "headers": {"authorization": "Bearer fake-token"},
        "requestContext": {"http": {"method": method}},
        "body": json.dumps(body or {}),
    }


class TestRegisterPushDevice:
    def test_registers_ios_device(self):
        with patch("src.push_devices.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.push_devices.get_push_device", return_value=None), \
             patch("src.push_devices.ensure_push_endpoint", return_value="arn:aws:sns:endpoint"), \
             patch("src.push_devices.put_push_device") as mock_put:
            from src.push_devices import handler

            result = handler(_make_event(body={
                "installationId": "install-1",
                "token": "abc123",
                "platform": "ios",
                "pushEnvironment": "sandbox",
                "bundleId": "com.pocketengineer.coder",
            }), {})

            assert result["statusCode"] == 200
            item = mock_put.call_args[0][0]
            assert item["installationId"] == "install-1"
            assert item["userId"] == "user-123"
            assert item["endpointArn"] == "arn:aws:sns:endpoint"

    def test_returns_503_when_push_is_not_configured(self):
        from src.lib.push import PushConfigurationError

        with patch("src.push_devices.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.push_devices.get_push_device", return_value=None), \
             patch("src.push_devices.ensure_push_endpoint", side_effect=PushConfigurationError("APNs push is not configured")):
            from src.push_devices import handler

            result = handler(_make_event(body={
                "installationId": "install-1",
                "token": "abc123",
                "platform": "ios",
                "pushEnvironment": "sandbox",
            }), {})

            assert result["statusCode"] == 503

    def test_requires_token(self):
        with patch("src.push_devices.verify_token", return_value=FAKE_CLAIMS):
            from src.push_devices import handler

            result = handler(_make_event(body={
                "installationId": "install-1",
                "platform": "ios",
                "pushEnvironment": "sandbox",
            }), {})

            assert result["statusCode"] == 400


class TestUnregisterPushDevice:
    def test_unregisters_existing_device(self):
        existing = {
            "installationId": "install-1",
            "userId": "user-123",
            "endpointArn": "arn:aws:sns:endpoint",
        }
        with patch("src.push_devices.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.push_devices.get_push_device", return_value=existing), \
             patch("src.push_devices.delete_push_endpoint") as mock_delete_endpoint, \
             patch("src.push_devices.delete_push_device") as mock_delete_item:
            from src.push_devices import handler

            result = handler(_make_event(method="DELETE", body={
                "installationId": "install-1",
            }), {})

            assert result["statusCode"] == 200
            mock_delete_endpoint.assert_called_once_with("arn:aws:sns:endpoint")
            mock_delete_item.assert_called_once_with("install-1")

    def test_unregister_is_idempotent_when_missing(self):
        with patch("src.push_devices.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.push_devices.get_push_device", return_value=None):
            from src.push_devices import handler

            result = handler(_make_event(method="DELETE", body={
                "installationId": "install-1",
            }), {})

            assert result["statusCode"] == 200
