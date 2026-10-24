"""Tests for `_ensure_tunnel_for_server`'s `previewHealed` flag.

Why this exists
---------------
Before the flag was introduced, every call to `_ensure_tunnel_for_server`
(one per `_discover_services` call, one per preview-panel refresh)
fired ~5 outbound Cloudflare API calls + one SSH round-trip to re-
install the dispatcher. Multi-second latency per preview click, for a
state that almost never changed. Greptile P2 on PR #127.

The flag (`previewHealed: true` on the DDB server record) is set once
after a full heal succeeds end-to-end, and short-circuits subsequent
calls. If any step of the heal path fails we leave the flag unset so
the next call tries again — self-healing without cementing a bad
state.

These tests pin the contract of the flag:

  1. `previewHealed=True` + existing tunnel → function returns the
     tunnel id WITHOUT calling any Cloudflare API or SSH helper.
  2. `previewHealed=False` + existing tunnel, all 4 heal steps succeed
     → flag is written to DDB.
  3. `previewHealed=False` + existing tunnel, one step fails → flag
     is NOT written (next call retries).
  4. Fresh tunnel path (no `tunnelId`), all steps succeed → both
     tunnelId AND previewHealed are persisted in one update call.
"""
import os
from unittest.mock import MagicMock, patch

os.environ.setdefault("SUPABASE_URL", "https://test.supabase.co")
os.environ.setdefault("SUPABASE_JWT_SECRET", "test-secret")
os.environ.setdefault("SERVERS_TABLE", "pe-servers-test")
os.environ.setdefault("SESSIONS_TABLE", "pe-sessions-test")
os.environ.setdefault("MESSAGES_TABLE", "pe-messages-test")
os.environ.setdefault("KMS_KEY_ID", "test-key-id")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")

# Import after env setup — chat.py reads SERVERS_TABLE etc. at import.
from src import chat  # noqa: E402


class TestFastPathWhenHealed:
    """When `previewHealed=True`, no CF API calls, no SSH."""

    def test_healed_flag_short_circuits(self):
        server = {
            "serverId": "srv-healed",
            "tunnelId": "t-abc",
            "previewHealed": True,
        }
        client = MagicMock()
        with (
            patch("src.chat.cloudflare.is_configured", return_value=True),
            patch("src.chat.cloudflare.kv_put") as mk_kv,
            patch("src.chat.cloudflare.upsert_dns_cname") as mk_cname,
            patch("src.chat.cloudflare.ensure_workspace_ingress") as mk_ingress,
            patch("src.chat._install_preview_dispatcher_via_ssh") as mk_disp,
            patch("src.chat.update_server") as mk_update,
        ):
            result = chat._ensure_tunnel_for_server(client, server)

        assert result == "t-abc"
        # Proves the cost-avoidance: zero CF / SSH traffic on a healthy
        # workspace's preview-panel refresh.
        mk_kv.assert_not_called()
        mk_cname.assert_not_called()
        mk_ingress.assert_not_called()
        mk_disp.assert_not_called()
        mk_update.assert_not_called()


class TestHealPathSetsFlagOnSuccess:
    """When flag is missing and the full heal succeeds, flag gets set."""

    def test_first_successful_heal_writes_flag(self):
        server = {"serverId": "srv-pending", "tunnelId": "t-xyz"}
        client = MagicMock()
        with (
            patch("src.chat.cloudflare.is_configured", return_value=True),
            patch("src.chat.cloudflare.kv_put"),
            patch("src.chat.cloudflare.workspace_hostname", return_value="w-srv-pending.example"),
            patch("src.chat.cloudflare.upsert_dns_cname"),
            patch("src.chat.cloudflare.ensure_workspace_ingress"),
            patch("src.chat._install_preview_dispatcher_via_ssh", return_value=True),
            patch("src.chat.update_server") as mk_update,
        ):
            result = chat._ensure_tunnel_for_server(client, server)

        assert result == "t-xyz"
        mk_update.assert_called_once_with("srv-pending", {"previewHealed": True})


class TestHealPathSkipsFlagOnFailure:
    """Any step failing must NOT flip the flag — next call should retry."""

    def test_kv_put_failure_leaves_flag_unset(self):
        server = {"serverId": "srv-broken", "tunnelId": "t-xyz"}
        client = MagicMock()
        with (
            patch("src.chat.cloudflare.is_configured", return_value=True),
            patch(
                "src.chat.cloudflare.kv_put",
                side_effect=chat.cloudflare.CloudflareError("kv 500"),
            ),
            patch("src.chat.cloudflare.workspace_hostname", return_value="w-srv-broken.example"),
            patch("src.chat.cloudflare.upsert_dns_cname"),
            patch("src.chat.cloudflare.ensure_workspace_ingress"),
            patch("src.chat._install_preview_dispatcher_via_ssh", return_value=True),
            patch("src.chat.update_server") as mk_update,
        ):
            result = chat._ensure_tunnel_for_server(client, server)

        # Still returns the tunnel id — we don't fail the user's
        # preview click on a transient heal blip.
        assert result == "t-xyz"
        # But the flag MUST NOT have been written.
        mk_update.assert_not_called()

    def test_dispatcher_install_failure_leaves_flag_unset(self):
        server = {"serverId": "srv-broken2", "tunnelId": "t-xyz"}
        client = MagicMock()
        with (
            patch("src.chat.cloudflare.is_configured", return_value=True),
            patch("src.chat.cloudflare.kv_put"),
            patch("src.chat.cloudflare.workspace_hostname", return_value="w-srv-broken2.example"),
            patch("src.chat.cloudflare.upsert_dns_cname"),
            patch("src.chat.cloudflare.ensure_workspace_ingress"),
            patch("src.chat._install_preview_dispatcher_via_ssh", return_value=False),
            patch("src.chat.update_server") as mk_update,
        ):
            result = chat._ensure_tunnel_for_server(client, server)

        assert result == "t-xyz"
        mk_update.assert_not_called()

    def test_cname_failure_leaves_flag_unset(self):
        server = {"serverId": "srv-broken3", "tunnelId": "t-xyz"}
        client = MagicMock()
        with (
            patch("src.chat.cloudflare.is_configured", return_value=True),
            patch("src.chat.cloudflare.kv_put"),
            patch("src.chat.cloudflare.workspace_hostname", return_value="w-srv-broken3.example"),
            patch(
                "src.chat.cloudflare.upsert_dns_cname",
                side_effect=chat.cloudflare.CloudflareError("dns 429"),
            ),
            patch("src.chat.cloudflare.ensure_workspace_ingress"),
            patch("src.chat._install_preview_dispatcher_via_ssh", return_value=True),
            patch("src.chat.update_server") as mk_update,
        ):
            result = chat._ensure_tunnel_for_server(client, server)

        assert result == "t-xyz"
        mk_update.assert_not_called()


class TestFreshTunnelPath:
    """No existing `tunnelId` → create + wire + (if all ok) write both
    tunnelId AND previewHealed in the same update."""

    def test_fresh_create_all_green_persists_both_fields(self):
        server = {"serverId": "srv-fresh"}
        client = MagicMock()
        with (
            patch("src.chat.cloudflare.is_configured", return_value=True),
            patch(
                "src.chat.cloudflare.create_tunnel",
                return_value={"id": "t-new", "token": "tok-new"},
            ),
            patch("src.chat._install_cloudflared_via_ssh", return_value=True),
            patch("src.chat._install_preview_dispatcher_via_ssh", return_value=True),
            patch("src.chat.cloudflare.workspace_hostname", return_value="w-srv-fresh.example"),
            patch("src.chat.cloudflare.upsert_dns_cname"),
            patch("src.chat.cloudflare.ensure_workspace_ingress"),
            patch("src.chat.cloudflare.kv_put"),
            patch("src.chat.update_server") as mk_update,
        ):
            result = chat._ensure_tunnel_for_server(client, server)

        assert result == "t-new"
        # Single update call with BOTH fields — the flag piggybacks on
        # the tunnelId persistence to avoid two round-trips to DDB.
        mk_update.assert_called_once_with(
            "srv-fresh",
            {"tunnelId": "t-new", "previewHealed": True},
        )

    def test_fresh_create_partial_failure_persists_tunnelId_only(self):
        """Even if a later step fails, we still persist tunnelId so a
        retry reuses this tunnel instead of creating another (tunnel
        leak prevention)."""
        server = {"serverId": "srv-fresh-partial"}
        client = MagicMock()
        with (
            patch("src.chat.cloudflare.is_configured", return_value=True),
            patch(
                "src.chat.cloudflare.create_tunnel",
                return_value={"id": "t-part", "token": "tok-part"},
            ),
            patch("src.chat._install_cloudflared_via_ssh", return_value=True),
            patch("src.chat._install_preview_dispatcher_via_ssh", return_value=True),
            patch("src.chat.cloudflare.workspace_hostname", return_value="w-srv-fresh-partial.example"),
            patch("src.chat.cloudflare.upsert_dns_cname"),
            patch("src.chat.cloudflare.ensure_workspace_ingress"),
            patch(
                "src.chat.cloudflare.kv_put",
                side_effect=chat.cloudflare.CloudflareError("kv 500"),
            ),
            patch("src.chat.update_server") as mk_update,
        ):
            result = chat._ensure_tunnel_for_server(client, server)

        assert result == "t-part"
        mk_update.assert_called_once_with(
            "srv-fresh-partial",
            {"tunnelId": "t-part"},  # NO previewHealed
        )
