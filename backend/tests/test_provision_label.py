"""Workspace label behavior for POST /servers provisioning."""
import json
import os
from contextlib import ExitStack
from unittest.mock import patch

os.environ.setdefault("SUPABASE_URL", "https://test.supabase.co")
os.environ.setdefault("SUPABASE_JWT_SECRET", "test-secret")
os.environ.setdefault("SERVERS_TABLE", "pe-servers-test")
os.environ.setdefault("KMS_KEY_ID", "test-key-id")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")

from src.provision import _resolve_workspace_label, handler


FAKE_CLAIMS = {"sub": "user-123"}


def _event(body: dict):
    return {
        "headers": {"authorization": "Bearer fake-token"},
        "body": json.dumps(body),
    }


class TestResolveWorkspaceLabel:
    def test_user_supplied_label_wins(self):
        assert _resolve_workspace_label({
            "label": "Search API",
            "repos": ["acme/web"],
        }) == "Search API"

    def test_label_is_trimmed(self):
        assert _resolve_workspace_label({"label": "  Mobile polish  "}) == "Mobile polish"

    def test_repo_name_fallback(self):
        assert _resolve_workspace_label({"repos": ["acme/billing-service"]}) == "billing-service workspace"

    def test_empty_fallback(self):
        assert _resolve_workspace_label({}) == "Cloud Workspace"

    def test_non_string_label_falls_back(self):
        assert _resolve_workspace_label({"label": 123, "repos": ["acme/api"]}) == "api workspace"


class TestProvisionWorkspaceLabel:
    def test_persists_and_returns_supplied_label(self):
        with ExitStack() as stack:
            stack.enter_context(patch("src.provision.verify_token", return_value=FAKE_CLAIMS))
            stack.enter_context(patch("src.provision.get_servers_by_user", return_value=[]))
            stack.enter_context(patch("src.provision.find_latest_ami", return_value="ami-123"))
            stack.enter_context(patch("src.provision.import_key_pair"))
            stack.enter_context(patch("src.provision.create_security_group", return_value="sg-123"))
            stack.enter_context(patch("src.provision.build_userdata", return_value="#!/bin/bash"))
            stack.enter_context(patch("src.provision.launch_instance", return_value="i-123"))
            stack.enter_context(patch("src.provision.encrypt", side_effect=lambda value: f"enc:{value}"))
            put_server = stack.enter_context(patch("src.provision.put_server"))

            result = handler(_event({
                "label": " Search API ",
                "agents": ["claude"],
                "repos": ["acme/web"],
            }), {})

        assert result["statusCode"] == 201
        body = json.loads(result["body"])
        assert body["label"] == "Search API"

        record = put_server.call_args.args[0]
        assert record["label"] == "Search API"


class TestProvisionTunnel:
    """The Cloudflare tunnel is created BEFORE userdata so the connector
    token can be baked into userdata. These tests pin that contract."""

    def test_tunnel_token_is_passed_into_userdata_and_id_is_persisted(self):
        build_userdata_mock = None
        with ExitStack() as stack:
            stack.enter_context(patch("src.provision.verify_token", return_value=FAKE_CLAIMS))
            stack.enter_context(patch("src.provision.get_servers_by_user", return_value=[]))
            stack.enter_context(patch("src.provision.find_latest_ami", return_value="ami-123"))
            stack.enter_context(patch("src.provision.import_key_pair"))
            stack.enter_context(patch("src.provision.create_security_group", return_value="sg-123"))
            build_userdata_mock = stack.enter_context(
                patch("src.provision.build_userdata", return_value="#!/bin/bash")
            )
            stack.enter_context(patch("src.provision.launch_instance", return_value="i-123"))
            stack.enter_context(patch("src.provision.encrypt", side_effect=lambda value: f"enc:{value}"))
            put_server = stack.enter_context(patch("src.provision.put_server"))
            stack.enter_context(patch(
                "src.provision.cloudflare.is_configured", return_value=True
            ))
            stack.enter_context(patch(
                "src.provision.cloudflare.create_tunnel",
                return_value={"id": "tun-abc", "token": "ctok-xyz"},
            ))
            stack.enter_context(patch(
                "src.provision.cloudflare.workspace_hostname",
                return_value="w-wsp.preview.test",
            ))
            upsert_dns_mock = stack.enter_context(patch("src.provision.cloudflare.upsert_dns_cname"))
            ingress_mock = stack.enter_context(patch("src.provision.cloudflare.ensure_workspace_ingress"))
            kv_put_mock = stack.enter_context(patch("src.provision.cloudflare.kv_put"))

            result = handler(_event({"agents": ["claude"]}), {})

        assert result["statusCode"] == 201
        record = put_server.call_args.args[0]
        assert record["tunnelId"] == "tun-abc"
        # build_userdata got the connector token as a kwarg
        assert build_userdata_mock.call_args.kwargs["tunnel_token"] == "ctok-xyz"
        # KV was populated so the preview Worker can find this
        # workspace. The key is the workspace id; value is the tunnel id.
        kv_put_mock.assert_called_once()
        _serverId, tunnel_arg = kv_put_mock.call_args.args
        assert tunnel_arg == "tun-abc"
        # DNS CNAME created pointing at the new tunnel. We pass the
        # full hostname (derived via workspace_hostname) + tunnel id.
        upsert_dns_mock.assert_called_once_with("w-wsp.preview.test", "tun-abc")
        # Single ingress rule wired up — no per-port churn on click.
        ingress_mock.assert_called_once()
        ingress_tunnel, ingress_server = ingress_mock.call_args.args
        assert ingress_tunnel == "tun-abc"
        assert ingress_server == _serverId

    def test_provision_continues_with_null_tunnel_when_cloudflare_fails(self):
        # A flaky CF API must not fail provision — the workspace boots,
        # just without a tunnel, and the chat path can lazy-create later.
        from src.lib.cloudflare import CloudflareError

        with ExitStack() as stack:
            stack.enter_context(patch("src.provision.verify_token", return_value=FAKE_CLAIMS))
            stack.enter_context(patch("src.provision.get_servers_by_user", return_value=[]))
            stack.enter_context(patch("src.provision.find_latest_ami", return_value="ami-123"))
            stack.enter_context(patch("src.provision.import_key_pair"))
            stack.enter_context(patch("src.provision.create_security_group", return_value="sg-123"))
            build_userdata_mock = stack.enter_context(
                patch("src.provision.build_userdata", return_value="#!/bin/bash")
            )
            stack.enter_context(patch("src.provision.launch_instance", return_value="i-123"))
            stack.enter_context(patch("src.provision.encrypt", side_effect=lambda value: f"enc:{value}"))
            put_server = stack.enter_context(patch("src.provision.put_server"))
            stack.enter_context(patch(
                "src.provision.cloudflare.is_configured", return_value=True
            ))
            stack.enter_context(patch(
                "src.provision.cloudflare.create_tunnel",
                side_effect=CloudflareError("CF 500"),
            ))
            kv_put_mock = stack.enter_context(patch("src.provision.cloudflare.kv_put"))
            upsert_dns_mock = stack.enter_context(patch("src.provision.cloudflare.upsert_dns_cname"))
            ingress_mock = stack.enter_context(patch("src.provision.cloudflare.ensure_workspace_ingress"))

            result = handler(_event({"agents": ["claude"]}), {})

        assert result["statusCode"] == 201
        record = put_server.call_args.args[0]
        assert record["tunnelId"] is None
        assert build_userdata_mock.call_args.kwargs["tunnel_token"] is None
        # No tunnel -> no downstream CF wiring calls. A stale
        # "workspaceId → <nothing>" entry or an orphan CNAME would
        # make the Worker return confusing 404s / 1016s after the
        # chat handler later succeeds at lazy-creating a tunnel.
        kv_put_mock.assert_not_called()
        upsert_dns_mock.assert_not_called()
        ingress_mock.assert_not_called()

    def test_provision_skips_tunnel_when_cloudflare_not_configured(self):
        with ExitStack() as stack:
            stack.enter_context(patch("src.provision.verify_token", return_value=FAKE_CLAIMS))
            stack.enter_context(patch("src.provision.get_servers_by_user", return_value=[]))
            stack.enter_context(patch("src.provision.find_latest_ami", return_value="ami-123"))
            stack.enter_context(patch("src.provision.import_key_pair"))
            stack.enter_context(patch("src.provision.create_security_group", return_value="sg-123"))
            stack.enter_context(patch("src.provision.build_userdata", return_value="#!/bin/bash"))
            stack.enter_context(patch("src.provision.launch_instance", return_value="i-123"))
            stack.enter_context(patch("src.provision.encrypt", side_effect=lambda value: f"enc:{value}"))
            put_server = stack.enter_context(patch("src.provision.put_server"))
            stack.enter_context(patch(
                "src.provision.cloudflare.is_configured", return_value=False
            ))
            # create_tunnel must NOT be called when cloudflare isn't configured
            create_tunnel_mock = stack.enter_context(patch("src.provision.cloudflare.create_tunnel"))

            result = handler(_event({"agents": ["claude"]}), {})

        assert result["statusCode"] == 201
        create_tunnel_mock.assert_not_called()
        record = put_server.call_args.args[0]
        assert record["tunnelId"] is None

    def test_kv_put_failure_still_persists_tunnel_id_and_succeeds(self):
        # CF scenario: tunnel create succeeds but KV write fails
        # (token missing KV scope, namespace id wrong, transient 5xx).
        # We must:
        #   - persist the tunnelId on the server record
        #   - not fail provision
        # so the chat path can retry kv_put the first time a user
        # clicks Preview. If we dropped the tunnelId here instead,
        # the retry branch would create a *second* tunnel.
        from src.lib.cloudflare import CloudflareError

        with ExitStack() as stack:
            stack.enter_context(patch("src.provision.verify_token", return_value=FAKE_CLAIMS))
            stack.enter_context(patch("src.provision.get_servers_by_user", return_value=[]))
            stack.enter_context(patch("src.provision.find_latest_ami", return_value="ami-123"))
            stack.enter_context(patch("src.provision.import_key_pair"))
            stack.enter_context(patch("src.provision.create_security_group", return_value="sg-123"))
            stack.enter_context(patch("src.provision.build_userdata", return_value="#!/bin/bash"))
            stack.enter_context(patch("src.provision.launch_instance", return_value="i-123"))
            stack.enter_context(patch("src.provision.encrypt", side_effect=lambda value: f"enc:{value}"))
            put_server = stack.enter_context(patch("src.provision.put_server"))
            stack.enter_context(patch(
                "src.provision.cloudflare.is_configured", return_value=True
            ))
            stack.enter_context(patch(
                "src.provision.cloudflare.create_tunnel",
                return_value={"id": "tun-abc", "token": "ctok-xyz"},
            ))
            stack.enter_context(patch(
                "src.provision.cloudflare.upsert_dns_cname",
                return_value={"id": "dns-1"},
            ))
            stack.enter_context(patch("src.provision.cloudflare.ensure_workspace_ingress"))
            stack.enter_context(patch(
                "src.provision.cloudflare.kv_put",
                side_effect=CloudflareError("KV 500"),
            ))

            result = handler(_event({"agents": ["claude"]}), {})

        assert result["statusCode"] == 201
        record = put_server.call_args.args[0]
        assert record["tunnelId"] == "tun-abc"
