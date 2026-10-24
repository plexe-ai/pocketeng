"""Focused tests for Slack and Linear registration handlers."""
import json
import os
from importlib import import_module
from unittest.mock import MagicMock, patch

os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
os.environ.setdefault("SUPABASE_URL", "https://test.supabase.co")
os.environ.setdefault("SUPABASE_JWT_SECRET", "test-secret")
os.environ.setdefault("LINEAR_MAPPINGS_TABLE", "pe-linear-mappings-test")
os.environ.setdefault("SLACK_MAPPINGS_TABLE", "pe-slack-mappings-test")
os.environ.setdefault("PUBLIC_API_BASE_URL", "https://api.test")
os.environ.setdefault("LINEAR_WEBHOOK_SECRET", "linear-secret")


FAKE_CLAIMS = {"sub": "user-123"}


def _event(body: dict):
    return {
        "headers": {"authorization": "Bearer fake-token"},
        "body": json.dumps(body),
    }


class TestLinearRegister:
    def test_returns_401_when_verify_token_fails(self):
        linear_register = import_module("src.linear_register")

        with patch("src.linear_register.extract_auth_header", return_value="Bearer fake-token"), \
             patch("src.linear_register.verify_token", side_effect=Exception("bad token")):
            result = linear_register.handler(_event({}), {})

        assert result["statusCode"] == 401

    def test_requires_linear_team_id_and_access_token(self):
        linear_register = import_module("src.linear_register")

        with patch("src.linear_register.extract_auth_header", return_value="Bearer fake-token"), \
             patch("src.linear_register.verify_token", return_value=FAKE_CLAIMS):
            result = linear_register.handler(_event({"linearTeamId": "ENG"}), {})

        assert result["statusCode"] == 400
        body = json.loads(result["body"])
        assert body["error"] == "linearTeamId and accessToken required"

    def test_returns_verified_when_label_and_webhook_are_ready(self):
        linear_register = import_module("src.linear_register")
        table = MagicMock()
        fake_ddb = MagicMock()
        fake_ddb.Table.return_value = table

        with patch("src.linear_register._ddb", fake_ddb), \
             patch("src.linear_register.extract_auth_header", return_value="Bearer fake-token"), \
             patch("src.linear_register.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.linear_register.encrypt", return_value="encrypted-token"), \
             patch("src.linear_register.find_or_create_label", return_value="label-123"), \
             patch("src.linear_register.create_webhook", return_value="webhook-123"):
            result = linear_register.handler(_event({
                "linearTeamId": "ENG",
                "linearTeamUuid": "team-uuid-123",
                "accessToken": "linear-token",
            }), {})

        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert body == {
            "ok": True,
            "linearTeamId": "ENG",
            "webhookCreated": True,
            "labelCreated": True,
            "verified": True,
            "setupErrors": [],
        }
        assert table.put_item.call_count == 2
        first_item = table.put_item.call_args_list[0].kwargs["Item"]
        second_item = table.put_item.call_args_list[1].kwargs["Item"]
        assert first_item["userId"] == "user-123"
        assert first_item["accessToken"] == "encrypted-token"
        assert first_item["botLabelId"] == "label-123"
        assert first_item["linearTeamId"] == "ENG"
        assert second_item["linearTeamId"] == "team-uuid-123"
        assert second_item["linearTeamKey"] == "ENG"

    def test_reports_setup_errors_when_label_and_webhook_fail(self):
        linear_register = import_module("src.linear_register")
        table = MagicMock()
        fake_ddb = MagicMock()
        fake_ddb.Table.return_value = table

        with patch("src.linear_register._ddb", fake_ddb), \
             patch("src.linear_register.extract_auth_header", return_value="Bearer fake-token"), \
             patch("src.linear_register.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.linear_register.encrypt", return_value="encrypted-token"), \
             patch("src.linear_register.find_or_create_label", side_effect=Exception("label failed")), \
             patch("src.linear_register.create_webhook", side_effect=Exception("webhook failed")):
            result = linear_register.handler(_event({
                "linearTeamId": "ENG",
                "linearTeamUuid": "team-uuid-123",
                "accessToken": "linear-token",
            }), {})

        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert body["verified"] is False
        assert body["labelCreated"] is False
        assert body["webhookCreated"] is False
        assert "Could not create or verify the Pocket Eng label." in body["setupErrors"]
        assert "Could not create or verify the Linear webhook." in body["setupErrors"]
        stored_item = table.put_item.call_args_list[0].kwargs["Item"]
        assert stored_item["botLabelId"] is None


class TestSlackRegister:
    def test_returns_401_when_verify_token_fails(self):
        slack_register = import_module("src.slack_register")

        with patch("src.slack_register.extract_auth_header", return_value="Bearer fake-token"), \
             patch("src.slack_register.verify_token", side_effect=Exception("bad token")):
            result = slack_register.handler(_event({}), {})

        assert result["statusCode"] == 401

    def test_requires_slack_team_id(self):
        slack_register = import_module("src.slack_register")

        with patch("src.slack_register.extract_auth_header", return_value="Bearer fake-token"), \
             patch("src.slack_register.verify_token", return_value=FAKE_CLAIMS):
            result = slack_register.handler(_event({"botToken": "xoxb-token"}), {})

        assert result["statusCode"] == 400
        body = json.loads(result["body"])
        assert body["error"] == "slackTeamId required"

    def test_persists_mapping_with_bot_token(self):
        slack_register = import_module("src.slack_register")
        table = MagicMock()
        fake_ddb = MagicMock()
        fake_ddb.Table.return_value = table

        with patch("src.slack_register._ddb", fake_ddb), \
             patch("src.slack_register.extract_auth_header", return_value="Bearer fake-token"), \
             patch("src.slack_register.verify_token", return_value=FAKE_CLAIMS):
            result = slack_register.handler(_event({
                "slackTeamId": "T123",
                "botToken": "xoxb-token",
            }), {})

        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert body == {"ok": True}
        # Must use a non-destructive update_item (never put_item), so re-connecting
        # Slack does not clobber channelMappings / sessions on the team record.
        table.put_item.assert_not_called()
        kwargs = table.update_item.call_args.kwargs
        assert kwargs["Key"] == {"slackTeamId": "T123"}
        # Both userId and botToken are set; the exact placeholder names are an
        # implementation detail, so resolve them via the expression maps.
        names = kwargs["ExpressionAttributeNames"]
        values = kwargs["ExpressionAttributeValues"]
        resolved = {
            names[ph]: values[val]
            for ph, val in (
                part.strip().split(" = ")
                for part in kwargs["UpdateExpression"].removeprefix("SET ").split(",")
            )
        }
        assert resolved == {"userId": "user-123", "botToken": "xoxb-token"}

    def test_update_omits_bot_token_when_absent(self):
        slack_register = import_module("src.slack_register")
        table = MagicMock()
        fake_ddb = MagicMock()
        fake_ddb.Table.return_value = table

        with patch("src.slack_register._ddb", fake_ddb), \
             patch("src.slack_register.extract_auth_header", return_value="Bearer fake-token"), \
             patch("src.slack_register.verify_token", return_value=FAKE_CLAIMS):
            result = slack_register.handler(_event({"slackTeamId": "T123"}), {})

        assert result["statusCode"] == 200
        table.put_item.assert_not_called()
        kwargs = table.update_item.call_args.kwargs
        assert "botToken" not in kwargs["ExpressionAttributeNames"].values()
        assert kwargs["ExpressionAttributeValues"] == {":u": "user-123"}
