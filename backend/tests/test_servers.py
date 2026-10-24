"""Listing behavior for GET /servers.

Pins the team-merge-with-dedup added on the team-foundations branch:
when the caller is on a team, personal-owned and team-owned workspaces
are concatenated and deduped by serverId so a server the user created
in their team doesn't appear twice.
"""
import json
import os
from contextlib import ExitStack
from unittest.mock import patch

os.environ.setdefault("SUPABASE_URL", "https://test.supabase.co")
os.environ.setdefault("SUPABASE_JWT_SECRET", "test-secret")
os.environ.setdefault("SERVERS_TABLE", "pe-servers-test")
os.environ.setdefault("KMS_KEY_ID", "test-key-id")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")

from src.servers import handler


FAKE_CLAIMS = {"sub": "user-123"}


def _event():
    return {
        "headers": {"authorization": "Bearer fake-token"},
        "requestContext": {"http": {"method": "GET"}},
    }


def _server(server_id, **fields):
    base = {
        "serverId": server_id,
        "instanceId": f"i-{server_id}",
        "instanceState": "running",
        "publicIp": "1.2.3.4",
        "envType": "general",
    }
    base.update(fields)
    return base


class TestListServers:
    def test_personal_user_with_no_team_only_lists_own_servers(self):
        with ExitStack() as stack:
            stack.enter_context(patch("src.servers.verify_token", return_value=FAKE_CLAIMS))
            stack.enter_context(patch("src.servers.get_team_for_user", return_value=(None, None)))
            stack.enter_context(patch(
                "src.servers.get_servers_by_user",
                return_value=[_server("srv-personal", ownerType="personal", userId="user-123")],
            ))
            get_team_servers = stack.enter_context(patch("src.servers.get_servers_by_team"))
            stack.enter_context(patch("src.servers.describe_instance", return_value={"state": "running", "publicIp": "1.2.3.4"}))

            result = handler(_event(), {})

        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert [s["serverId"] for s in body["servers"]] == ["srv-personal"]
        get_team_servers.assert_not_called()

    def test_team_member_lists_personal_plus_team_servers(self):
        team = {"teamId": "team-1", "name": "Acme"}
        personal = _server("srv-personal", ownerType="personal", userId="user-123")
        team_owned = _server(
            "srv-team",
            ownerType="team",
            teamId="team-1",
            createdByUserId="user-456",
            userId="user-456",
        )
        with ExitStack() as stack:
            stack.enter_context(patch("src.servers.verify_token", return_value=FAKE_CLAIMS))
            stack.enter_context(patch("src.servers.get_team_for_user", return_value=(team, {"role": "member"})))
            stack.enter_context(patch("src.servers.get_servers_by_user", return_value=[personal]))
            stack.enter_context(patch("src.servers.get_servers_by_team", return_value=[team_owned]))
            stack.enter_context(patch("src.servers.describe_instance", return_value={"state": "running", "publicIp": "1.2.3.4"}))

            result = handler(_event(), {})

        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        ids = {s["serverId"] for s in body["servers"]}
        assert ids == {"srv-personal", "srv-team"}

        team_record = next(s for s in body["servers"] if s["serverId"] == "srv-team")
        assert team_record["ownerType"] == "team"
        assert team_record["teamId"] == "team-1"

    def test_team_workspace_created_by_caller_is_not_double_listed(self):
        """Server creator's userId is also their own; the same record will
        be returned by both get_servers_by_user (via userId GSI) and
        get_servers_by_team (via teamId GSI). Dedup must collapse them."""
        team = {"teamId": "team-1", "name": "Acme"}
        shared = _server(
            "srv-shared",
            ownerType="team",
            teamId="team-1",
            createdByUserId="user-123",
            userId="user-123",
        )
        with ExitStack() as stack:
            stack.enter_context(patch("src.servers.verify_token", return_value=FAKE_CLAIMS))
            stack.enter_context(patch("src.servers.get_team_for_user", return_value=(team, {"role": "admin"})))
            stack.enter_context(patch("src.servers.get_servers_by_user", return_value=[shared]))
            stack.enter_context(patch("src.servers.get_servers_by_team", return_value=[shared]))
            stack.enter_context(patch("src.servers.describe_instance", return_value={"state": "running", "publicIp": "1.2.3.4"}))

            result = handler(_event(), {})

        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert len(body["servers"]) == 1
        assert body["servers"][0]["serverId"] == "srv-shared"

    def test_response_exposes_ownership_fields_for_ui_badges(self):
        team = {"teamId": "team-1"}
        record = _server(
            "srv-1",
            ownerType="team",
            teamId="team-1",
            createdByUserId="user-456",
        )
        with ExitStack() as stack:
            stack.enter_context(patch("src.servers.verify_token", return_value=FAKE_CLAIMS))
            stack.enter_context(patch("src.servers.get_team_for_user", return_value=(team, {"role": "member"})))
            stack.enter_context(patch("src.servers.get_servers_by_user", return_value=[]))
            stack.enter_context(patch("src.servers.get_servers_by_team", return_value=[record]))
            stack.enter_context(patch("src.servers.describe_instance", return_value={"state": "running", "publicIp": "1.2.3.4"}))

            result = handler(_event(), {})

        body = json.loads(result["body"])
        srv = body["servers"][0]
        assert srv["ownerType"] == "team"
        assert srv["teamId"] == "team-1"
        assert srv["createdByUserId"] == "user-456"
