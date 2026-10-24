"""Unit tests for account deletion handler."""
import json
import os
from contextlib import ExitStack
from unittest.mock import patch

os.environ.setdefault("SUPABASE_URL", "https://test.supabase.co")
os.environ.setdefault("SUPABASE_JWT_SECRET", "test-secret")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "service-role-key")
os.environ.setdefault("SERVERS_TABLE", "pe-servers-test")
os.environ.setdefault("SESSIONS_TABLE", "pe-sessions-test")
os.environ.setdefault("MESSAGES_TABLE", "pe-messages-test")
os.environ.setdefault("PUSH_DEVICES_TABLE", "pe-push-devices-test")
os.environ.setdefault("HARNESS_RUN_SUMMARIES_TABLE", "pe-harness-runs-test")
os.environ.setdefault("HARNESS_SUGGESTIONS_TABLE", "pe-harness-suggestions-test")
os.environ.setdefault("HARNESS_VERSIONS_TABLE", "pe-harness-versions-test")
os.environ.setdefault("SLACK_MAPPINGS_TABLE", "pe-slack-mappings-test")
os.environ.setdefault("LINEAR_MAPPINGS_TABLE", "pe-linear-mappings-test")
os.environ.setdefault("SMS_MAPPINGS_TABLE", "pe-sms-mappings-test")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")

FAKE_CLAIMS = {"sub": "user-123"}


def _make_event(method="DELETE"):
    return {
        "headers": {"authorization": "Bearer fake-token"},
        "requestContext": {"http": {"method": method}},
        "body": json.dumps({}),
    }


class TestDeleteAccount:
    def test_requires_delete_method(self):
        with patch("src.account.verify_token", return_value=FAKE_CLAIMS):
            from src.account import handler

            result = handler(_make_event(method="GET"), {})

            assert result["statusCode"] == 405

    def test_deletes_app_data_and_auth_user(self):
        # envType "ios" + dedicatedHostId were for the mac2.metal workspace
        # type that was dropped in v1. No live server has either field now.
        # Keeping this test representative by setting envType to "general"
        # (the only managed type currently supported).
        server = {
            "serverId": "srv-1",
            "instanceId": "i-123",
            "instanceState": "running",
            "envType": "general",
            "keyPairName": "kp-1",
            "securityGroupId": "sg-1",
        }
        byos_server = {
            "serverId": "srv-2",
            "instanceId": "byos-1",
            "instanceState": "running",
            "envType": "byos",
        }
        sessions = [{"sessionId": "sess-1"}, {"sessionId": "sess-2"}]
        devices = [{"installationId": "install-1", "endpointArn": "arn:aws:sns:endpoint"}]

        with ExitStack() as stack:
            stack.enter_context(patch("src.account.verify_token", return_value=FAKE_CLAIMS))
            stack.enter_context(patch("src.account.get_active_team_membership", return_value=None))
            mock_revoke_apple = stack.enter_context(patch("src.account._maybe_revoke_apple", return_value=True))
            stack.enter_context(patch("src.account.get_servers_by_user", return_value=[server, byos_server]))
            stack.enter_context(patch("src.account.get_all_sessions_by_server", side_effect=[sessions, []]))
            mock_delete_messages = stack.enter_context(patch("src.account.delete_messages_for_session", side_effect=[3, 2]))
            mock_delete_events = stack.enter_context(patch("src.account.delete_session_events_for_session", return_value=0))
            mock_delete_session = stack.enter_context(patch("src.account.delete_session"))
            mock_terminate = stack.enter_context(patch("src.account.terminate_instance"))
            mock_delete_key_pair = stack.enter_context(patch("src.account.delete_key_pair"))
            mock_delete_sg = stack.enter_context(patch("src.account.delete_security_group"))
            mock_delete_server = stack.enter_context(patch("src.account.delete_server"))
            stack.enter_context(patch("src.account.get_all_push_devices_by_user", return_value=devices))
            mock_delete_endpoint = stack.enter_context(patch("src.account.delete_push_endpoint"))
            mock_delete_push_device = stack.enter_context(patch("src.account.delete_push_device"))
            stack.enter_context(patch("src.account.delete_oauth_credentials_by_user", return_value=1))
            stack.enter_context(patch("src.account.delete_harness_run_summaries", return_value=1))
            stack.enter_context(patch("src.account.delete_harness_suggestions", return_value=2))
            stack.enter_context(patch("src.account.delete_harness_versions", return_value=3))
            stack.enter_context(patch("src.account._delete_mappings_for_user", side_effect=[4, 5, 6]))
            mock_delete_supabase_user = stack.enter_context(patch("src.account._delete_supabase_user"))
            from src.account import handler

            result = handler(_make_event(), {})

            assert result["statusCode"] == 200
            body = json.loads(result["body"])
            assert body["ok"] is True
            assert body["serversDeleted"] == 2
            assert body["managedServersTerminated"] == 1
            assert body["sessionsDeleted"] == 2
            assert body["messagesDeleted"] == 5
            assert body["pushDevicesDeleted"] == 1
            assert body["appleTokensRevoked"] is True
            assert body["oauthCredentialsDeleted"] == 1
            assert body["slackMappingsDeleted"] == 4
            assert body["linearMappingsDeleted"] == 5
            assert body["smsMappingsDeleted"] == 6

            mock_revoke_apple.assert_called_once()
            assert mock_delete_messages.call_count == 2
            assert mock_delete_events.call_count == 2
            assert mock_delete_session.call_count == 2
            mock_terminate.assert_called_once_with("i-123")
            mock_delete_key_pair.assert_called_once_with("kp-1")
            mock_delete_sg.assert_called_once_with("sg-1")
            assert mock_delete_server.call_count == 2
            mock_delete_endpoint.assert_called_once_with("arn:aws:sns:endpoint")
            mock_delete_push_device.assert_called_once_with("install-1")
            mock_delete_supabase_user.assert_called_once_with("user-123")

    def test_blocks_deletion_when_user_has_teammates(self):
        # Active membership AND other members → must leave first
        members = [
            {"userId": "user-123", "teamId": "t-1", "role": "admin", "status": "active"},
            {"userId": "user-other", "teamId": "t-1", "role": "member", "status": "active"},
        ]
        with patch("src.account.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.account.get_active_team_membership", return_value={"teamId": "t-1", "role": "admin"}), \
             patch("src.account.list_active_team_members", return_value=members):
            from src.account import handler

            result = handler(_make_event(), {})

            assert result["statusCode"] == 400
            body = json.loads(result["body"])
            assert "team" in body["error"].lower()

    def test_dissolves_team_when_user_is_sole_member(self):
        """Billing-owner-trap mitigation: sole member of their team can
        delete their account; the team and its rows are torn down first."""
        sole = [{"userId": "user-123", "teamId": "t-1", "role": "admin", "status": "active"}]
        team_server = {"serverId": "srv-team", "ownerType": "team", "teamId": "t-1"}
        with ExitStack() as stack:
            stack.enter_context(patch("src.account.verify_token", return_value=FAKE_CLAIMS))
            stack.enter_context(patch("src.account.get_active_team_membership", return_value={"teamId": "t-1", "role": "admin"}))
            stack.enter_context(patch("src.account.list_active_team_members", return_value=sole))
            stack.enter_context(patch("src.account.get_servers_by_team", return_value=[team_server]))
            mock_update = stack.enter_context(patch("src.account.update_server"))
            mock_del_team = stack.enter_context(patch("src.account.delete_team"))
            mock_del_membership = stack.enter_context(patch("src.account.delete_team_membership"))
            stack.enter_context(patch("src.account.list_team_invites_for_team", return_value=[]))
            stack.enter_context(patch("src.account.update_team_invite"))
            stack.enter_context(patch("src.account._maybe_revoke_apple", return_value=False))
            # After dissolve the standard cleanup runs; stub the rest so we don't
            # exercise EC2/SNS calls.
            stack.enter_context(patch("src.account.get_servers_by_user", return_value=[]))
            stack.enter_context(patch("src.account.get_all_push_devices_by_user", return_value=[]))
            stack.enter_context(patch("src.account.delete_oauth_credentials_by_user", return_value=0))
            stack.enter_context(patch("src.account.delete_harness_run_summaries", return_value=0))
            stack.enter_context(patch("src.account.delete_harness_suggestions", return_value=0))
            stack.enter_context(patch("src.account.delete_harness_versions", return_value=0))
            stack.enter_context(patch("src.account._delete_mappings_for_user", return_value=0))
            stack.enter_context(patch("src.account._delete_supabase_user"))

            from src.account import handler
            result = handler(_make_event(), {})

            assert result["statusCode"] == 200
            mock_update.assert_called_once_with(
                "srv-team",
                {
                    "ownerType": "personal",
                    "teamId": None,
                    "userId": "user-123",
                    "ownerUserId": "user-123",
                },
            )
            mock_del_membership.assert_called_once_with("user-123", "t-1")
            mock_del_team.assert_called_once_with("t-1")

    def test_returns_503_when_service_role_key_missing(self):
        with patch("src.account.verify_token", return_value=FAKE_CLAIMS), \
             patch.dict(os.environ, {"SUPABASE_SERVICE_ROLE_KEY": ""}, clear=False):
            from src.account import handler

            result = handler(_make_event(), {})

            assert result["statusCode"] == 503

    def test_requires_reauth_if_apple_token_missing(self):
        with patch("src.account.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.account.get_oauth_credential", return_value=None):
            from src.account import _maybe_revoke_apple

            try:
                _maybe_revoke_apple("user-123", {"hasAppleIdentity": True})
                assert False, "expected exception"
            except RuntimeError as exc:
                assert "Sign in with Apple again" in str(exc)
