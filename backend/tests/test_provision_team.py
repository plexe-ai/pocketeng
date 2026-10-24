"""Team-ownership behavior for POST /servers provisioning.

Pins the authorization gate that decides whether a workspace can be
created with `ownerType=team` and the ownership fields persisted on
the server record.
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

from src.provision import handler


FAKE_CLAIMS = {"sub": "user-123"}


def _event(body: dict):
    return {
        "headers": {"authorization": "Bearer fake-token"},
        "body": json.dumps(body),
    }


def _stub_provision(stack, *, can_access_team_result=True, get_team_for_user_result=(None, None)):
    """Common scaffold so each test only varies the team-auth bits."""
    stack.enter_context(patch("src.provision.verify_token", return_value=FAKE_CLAIMS))
    stack.enter_context(patch("src.provision.get_servers_by_user", return_value=[]))
    stack.enter_context(patch("src.provision.find_latest_ami", return_value="ami-123"))
    stack.enter_context(patch("src.provision.import_key_pair"))
    stack.enter_context(patch("src.provision.create_security_group", return_value="sg-123"))
    stack.enter_context(patch("src.provision.build_userdata", return_value="#!/bin/bash"))
    stack.enter_context(patch("src.provision.launch_instance", return_value="i-123"))
    stack.enter_context(patch("src.provision.encrypt", side_effect=lambda value: f"enc:{value}"))
    stack.enter_context(patch("src.provision.can_access_team", return_value=can_access_team_result))
    stack.enter_context(patch("src.provision.get_team_for_user", return_value=get_team_for_user_result))


class TestProvisionTeamOwnership:
    def test_team_workspace_persists_team_ownership_fields(self):
        with ExitStack() as stack:
            _stub_provision(stack, can_access_team_result=True)
            put_server = stack.enter_context(patch("src.provision.put_server"))

            result = handler(_event({
                "agents": ["claude"],
                "ownerType": "team",
                "teamId": "team-1",
            }), {})

        assert result["statusCode"] == 201
        record = put_server.call_args.args[0]
        assert record["ownerType"] == "team"
        assert record["teamId"] == "team-1"
        assert record["createdByUserId"] == "user-123"

    def test_team_workspace_falls_back_to_user_active_team_when_team_id_omitted(self):
        active_team = {"teamId": "team-active", "name": "Acme"}
        with ExitStack() as stack:
            _stub_provision(
                stack,
                can_access_team_result=True,
                get_team_for_user_result=(active_team, {"role": "admin"}),
            )
            put_server = stack.enter_context(patch("src.provision.put_server"))

            result = handler(_event({
                "agents": ["claude"],
                "ownerType": "team",
            }), {})

        assert result["statusCode"] == 201
        record = put_server.call_args.args[0]
        assert record["teamId"] == "team-active"

    def test_team_workspace_rejected_when_user_not_a_member(self):
        with ExitStack() as stack:
            _stub_provision(stack, can_access_team_result=False)
            put_server = stack.enter_context(patch("src.provision.put_server"))

            result = handler(_event({
                "agents": ["claude"],
                "ownerType": "team",
                "teamId": "team-other",
            }), {})

        assert result["statusCode"] == 403
        put_server.assert_not_called()

    def test_team_workspace_rejected_when_user_has_no_team_and_no_team_id_supplied(self):
        with ExitStack() as stack:
            _stub_provision(
                stack,
                can_access_team_result=False,
                get_team_for_user_result=(None, None),
            )
            put_server = stack.enter_context(patch("src.provision.put_server"))

            result = handler(_event({
                "agents": ["claude"],
                "ownerType": "team",
            }), {})

        assert result["statusCode"] == 403
        put_server.assert_not_called()

    def test_personal_workspace_does_not_call_team_lookup(self):
        """Regression: personal-path provision must not query the team DB."""
        with ExitStack() as stack:
            stack.enter_context(patch("src.provision.verify_token", return_value=FAKE_CLAIMS))
            stack.enter_context(patch("src.provision.get_servers_by_user", return_value=[]))
            stack.enter_context(patch("src.provision.find_latest_ami", return_value="ami-123"))
            stack.enter_context(patch("src.provision.import_key_pair"))
            stack.enter_context(patch("src.provision.create_security_group", return_value="sg-123"))
            stack.enter_context(patch("src.provision.build_userdata", return_value="#!/bin/bash"))
            stack.enter_context(patch("src.provision.launch_instance", return_value="i-123"))
            stack.enter_context(patch("src.provision.encrypt", side_effect=lambda value: f"enc:{value}"))
            get_team = stack.enter_context(patch("src.provision.get_team_for_user"))
            can_access = stack.enter_context(patch("src.provision.can_access_team"))
            put_server = stack.enter_context(patch("src.provision.put_server"))

            result = handler(_event({"agents": ["claude"]}), {})

        assert result["statusCode"] == 201
        get_team.assert_not_called()
        can_access.assert_not_called()
        record = put_server.call_args.args[0]
        assert record["ownerType"] == "personal"
        assert record.get("teamId") is None
