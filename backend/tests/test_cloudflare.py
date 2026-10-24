"""Unit tests for backend/src/lib/cloudflare.py.

The module only uses stdlib urllib.request, so mocking `urlopen` is
enough to assert on every HTTP interaction — we don't need to spin up
a fake Cloudflare API. Tests verify:

* config env-var gating — `is_configured()` flips based on presence
* error mapping — HTTPError / success=false both surface as
  CloudflareError
* idempotent wiring — workspace ingress + CNAME upserts don't
  duplicate on repeat calls
* catch-all protection — `set_tunnel_config` always ends the ingress
  list with `http_status:404` so we don't push a broken config
* URL convention — `preview_url_for_port` matches what the Worker
  expects (kept in sync with web/lib/preview.ts + Worker source)
* KV round-trip — `kv_put` / `kv_delete` hit the right namespace URL
  with the right method and encode keys safely
"""
import io
import json
import os
from unittest.mock import patch

import pytest

# Pin test env so real values in the developer shell (e.g. sourced from
# .env.test) don't leak in and flip assertions that hard-code
# "test-account" etc. Use direct assignment, not setdefault, so we
# always win.
os.environ["CLOUDFLARE_API_TOKEN"] = "test-token"
os.environ["CLOUDFLARE_ACCOUNT_ID"] = "test-account"
os.environ["CLOUDFLARE_ZONE_ID"] = "test-zone"
os.environ["CLOUDFLARE_PREVIEW_DOMAIN"] = "preview.test"
os.environ["CLOUDFLARE_KV_NAMESPACE_ID"] = "test-kv-ns"
os.environ["CLOUDFLARE_PREVIEW_WORKER_URL"] = "https://preview.pocketeng.co"

from src.lib import cloudflare  # noqa: E402


class _FakeResp:
    """Context-manager stand-in for urllib.request.urlopen's return."""

    def __init__(self, payload, *, raw: bytes | None = None):
        if raw is not None:
            self._payload = raw
        else:
            self._payload = json.dumps(payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._payload


def _capture_request(urlopen_mock):
    """Pull the Request object passed to the most recent urlopen call."""
    assert urlopen_mock.call_args, "urlopen was not called"
    return urlopen_mock.call_args.args[0]


# ── Config -----------------------------------------------------------


class TestConfigured:
    def test_is_configured_true_when_all_vars_set(self):
        assert cloudflare.is_configured() is True

    def test_is_configured_false_when_api_token_missing(self):
        with patch.dict(os.environ, {"CLOUDFLARE_API_TOKEN": ""}, clear=False):
            assert cloudflare.is_configured() is False

    def test_is_configured_false_when_zone_id_missing(self):
        # Zone id is required — we can't create the workspace CNAME
        # without it. Any deploy that forgets to wire this up must
        # fail closed.
        with patch.dict(os.environ, {"CLOUDFLARE_ZONE_ID": ""}, clear=False):
            assert cloudflare.is_configured() is False

    def test_is_configured_false_when_preview_domain_missing(self):
        with patch.dict(os.environ, {"CLOUDFLARE_PREVIEW_DOMAIN": ""}, clear=False):
            assert cloudflare.is_configured() is False

    def test_config_raises_with_descriptive_missing_list(self):
        with patch.dict(
            os.environ,
            {
                "CLOUDFLARE_API_TOKEN": "",
                "CLOUDFLARE_KV_NAMESPACE_ID": "",
            },
            clear=False,
        ):
            with pytest.raises(cloudflare.CloudflareError) as exc:
                cloudflare._config()
            assert "CLOUDFLARE_API_TOKEN" in str(exc.value)
            assert "CLOUDFLARE_KV_NAMESPACE_ID" in str(exc.value)


class TestWorkspaceHostname:
    def test_builds_prefixed_hostname_under_preview_domain(self):
        # The Worker hardcodes the same `w-` prefix + the same domain
        # resolution rule, so any change here has to land with a
        # Worker redeploy. Strict test to make that coupling visible.
        assert (
            cloudflare.workspace_hostname("abc-123")
            == "w-abc-123.preview.test"
        )

    def test_strips_leading_and_trailing_dots_in_domain(self):
        with patch.dict(
            os.environ, {"CLOUDFLARE_PREVIEW_DOMAIN": ".example.com."}, clear=False
        ):
            assert (
                cloudflare.workspace_hostname("id")
                == "w-id.example.com"
            )


class TestPreviewUrlForPort:
    def test_matches_frontend_convention(self):
        # web/lib/preview.ts builds the same scheme. Keep the test
        # strict so a rename shows up on both sides.
        assert (
            cloudflare.preview_url_for_port("abc-123", 3000)
            == "https://preview.pocketeng.co/abc-123-3000/"
        )

    def test_coerces_port_to_int(self):
        assert (
            cloudflare.preview_url_for_port("abc", "4000")
            == "https://preview.pocketeng.co/abc-4000/"
        )

    def test_strips_trailing_slash_from_worker_url(self):
        # We store worker URL without a trailing slash, but if someone
        # configures one the output should still have exactly one
        # slash between segments.
        with patch.dict(
            os.environ,
            {"CLOUDFLARE_PREVIEW_WORKER_URL": "https://preview.pocketeng.co/"},
            clear=False,
        ):
            assert (
                cloudflare.preview_url_for_port("abc", 5000)
                == "https://preview.pocketeng.co/abc-5000/"
            )


# ── Low-level HTTP behaviour ----------------------------------------


class TestRequestErrors:
    def test_http_error_becomes_cloudflare_error(self):
        import urllib.error

        err = urllib.error.HTTPError(
            "url",
            401,
            "unauth",
            hdrs=None,
            fp=io.BytesIO(b'{"errors":[{"code":10000,"message":"unauth"}]}'),
        )
        with patch("urllib.request.urlopen", side_effect=err):
            with pytest.raises(cloudflare.CloudflareError) as exc:
                cloudflare._request("GET", "/whatever")
            assert "HTTP 401" in str(exc.value)

    def test_success_false_becomes_cloudflare_error(self):
        with patch(
            "urllib.request.urlopen",
            return_value=_FakeResp({"success": False, "errors": ["bad"]}),
        ):
            with pytest.raises(cloudflare.CloudflareError) as exc:
                cloudflare._request("GET", "/whatever")
            assert "success=false" in str(exc.value)

    def test_success_true_returns_parsed(self):
        with patch(
            "urllib.request.urlopen",
            return_value=_FakeResp({"success": True, "result": {"x": 1}}),
        ):
            assert cloudflare._request("GET", "/whatever") == {
                "success": True,
                "result": {"x": 1},
            }


# ── Tunnel CRUD -----------------------------------------------------


class TestCreateTunnel:
    def test_posts_with_config_src_cloudflare_and_returns_result(self):
        payload = {
            "success": True,
            "result": {"id": "tun-1", "name": "pe-abc", "token": "tok-xyz"},
        }
        with patch("urllib.request.urlopen", return_value=_FakeResp(payload)) as mock:
            out = cloudflare.create_tunnel("pe-abc")

        assert out == payload["result"]
        req = _capture_request(mock)
        assert req.get_method() == "POST"
        assert req.full_url.endswith("/accounts/test-account/cfd_tunnel")
        body = json.loads(req.data.decode())
        # config_src=cloudflare is what lets us drive ingress via API
        assert body == {"name": "pe-abc", "config_src": "cloudflare"}
        assert req.headers["Authorization"] == "Bearer test-token"


class TestGetTunnelToken:
    def test_returns_bare_string_token(self):
        with patch(
            "urllib.request.urlopen",
            return_value=_FakeResp({"success": True, "result": "tok-abc"}),
        ):
            assert cloudflare.get_tunnel_token("tun-1") == "tok-abc"

    def test_raises_on_empty_token(self):
        with patch(
            "urllib.request.urlopen",
            return_value=_FakeResp({"success": True, "result": ""}),
        ):
            with pytest.raises(cloudflare.CloudflareError):
                cloudflare.get_tunnel_token("tun-1")


class TestDeleteTunnel:
    def test_is_best_effort_never_raises(self):
        # Even if CF returns 500 on the connections cleanup AND the
        # tunnel delete, we must not raise — terminate depends on it.
        import urllib.error

        err = urllib.error.HTTPError(
            "url", 500, "boom", hdrs=None, fp=io.BytesIO(b"")
        )
        with patch("urllib.request.urlopen", side_effect=err):
            cloudflare.delete_tunnel("tun-1")  # no exception

    def test_cleans_connections_then_deletes_tunnel(self):
        calls: list[tuple[str, str]] = []

        def fake_urlopen(req, timeout=None):
            calls.append((req.get_method(), req.full_url))
            return _FakeResp({"success": True, "result": None})

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            cloudflare.delete_tunnel("tun-1")

        assert calls == [
            ("DELETE", "https://api.cloudflare.com/client/v4/accounts/test-account/cfd_tunnel/tun-1/connections"),
            ("DELETE", "https://api.cloudflare.com/client/v4/accounts/test-account/cfd_tunnel/tun-1"),
        ]

    def test_skips_silently_when_config_missing(self):
        with patch.dict(os.environ, {"CLOUDFLARE_API_TOKEN": ""}, clear=False):
            # Should NOT call urlopen at all — bail before any network work
            with patch("urllib.request.urlopen") as mock:
                cloudflare.delete_tunnel("tun-1")
                mock.assert_not_called()


# ── Tunnel configuration -------------------------------------------


class TestTunnelConfig:
    def test_get_tunnel_config_normalises_null_ingress(self):
        with patch(
            "urllib.request.urlopen",
            return_value=_FakeResp({"success": True, "result": {"config": {"ingress": None}}}),
        ):
            cfg = cloudflare.get_tunnel_config("tun-1")
        assert cfg["ingress"] == []

    def test_set_tunnel_config_always_appends_catch_all(self):
        with patch(
            "urllib.request.urlopen",
            return_value=_FakeResp({"success": True, "result": {}}),
        ) as mock:
            cloudflare.set_tunnel_config(
                "tun-1",
                [{"hostname": "w-ws-1.preview.test", "service": "http://127.0.0.1:8844"}],
            )
        body = json.loads(_capture_request(mock).data.decode())
        rules = body["config"]["ingress"]
        assert rules[-1] == {"service": "http_status:404"}
        assert len(rules) == 2

    def test_set_tunnel_config_dedups_catch_all(self):
        # If caller already included the catch-all in the middle somewhere
        # (bug) we must end up with exactly one catch-all, at the end.
        with patch(
            "urllib.request.urlopen",
            return_value=_FakeResp({"success": True, "result": {}}),
        ) as mock:
            cloudflare.set_tunnel_config(
                "tun-1",
                [
                    {"service": "http_status:404"},
                    {"hostname": "w-ws-1.preview.test", "service": "http://127.0.0.1:8844"},
                ],
            )
        rules = json.loads(_capture_request(mock).data.decode())["config"]["ingress"]
        catch_alls = [r for r in rules if r.get("service") == "http_status:404"]
        assert len(catch_alls) == 1
        assert rules[-1] == {"service": "http_status:404"}


class TestEnsureWorkspaceIngress:
    def test_writes_single_rule_pointing_workspace_host_at_dispatcher(self):
        # First call: GET current config (empty tunnel).
        # Second call: PUT new config with one rule.
        responses = iter([
            _FakeResp({"success": True, "result": {"config": {"ingress": []}}}),
            _FakeResp({"success": True, "result": {}}),
        ])
        with patch(
            "urllib.request.urlopen", side_effect=lambda *a, **kw: next(responses)
        ) as mock:
            hostname = cloudflare.ensure_workspace_ingress("tun-1", "ws-1")

        assert hostname == "w-ws-1.preview.test"
        put_call = mock.call_args_list[-1]
        body = json.loads(put_call.args[0].data.decode())
        rules = body["config"]["ingress"]
        # Exactly two: our single workspace rule + the forced catch-all.
        assert len(rules) == 2
        assert rules[0] == {
            "hostname": "w-ws-1.preview.test",
            # 127.0.0.1 not localhost: AL2023 resolves localhost to
            # ::1 first and the dispatcher binds IPv4 only.
            "service": f"http://127.0.0.1:{cloudflare.DISPATCHER_PORT}",
        }
        assert rules[1] == {"service": "http_status:404"}

    def test_replaces_stale_per_port_rules_from_old_design(self):
        # A workspace might have been provisioned before the Option-B
        # migration, with per-port rules (`pe-port-3000` etc.). When
        # ensure_workspace_ingress runs on such a tunnel it should
        # REPLACE all legacy rules with the single workspace rule —
        # not leave them lying around where cloudflared will still
        # match them.
        responses = iter([
            _FakeResp({
                "success": True,
                "result": {
                    "config": {
                        "ingress": [
                            {"hostname": "pe-port-3000", "service": "http://localhost:3000"},
                            {"hostname": "pe-port-5000", "service": "http://localhost:5000"},
                            {"service": "http_status:404"},
                        ]
                    }
                },
            }),
            _FakeResp({"success": True, "result": {}}),
        ])
        with patch(
            "urllib.request.urlopen", side_effect=lambda *a, **kw: next(responses)
        ) as mock:
            cloudflare.ensure_workspace_ingress("tun-1", "ws-1")
        body = json.loads(mock.call_args_list[-1].args[0].data.decode())
        rules = body["config"]["ingress"]
        # Legacy per-port rules should NOT survive. We keep the one
        # workspace rule + catch-all.
        hostnames = [r.get("hostname") for r in rules if r.get("hostname")]
        assert hostnames == ["w-ws-1.preview.test"]

    def test_idempotent_when_rule_already_current(self):
        # Second provision run / lazy retry: the rule already exists
        # with the right service URL. Result should be exactly the
        # same PUT — no duplicates.
        expected_rule = {
            "hostname": "w-ws-1.preview.test",
            "service": f"http://127.0.0.1:{cloudflare.DISPATCHER_PORT}",
        }
        responses = iter([
            _FakeResp({
                "success": True,
                "result": {
                    "config": {
                        "ingress": [expected_rule, {"service": "http_status:404"}]
                    }
                },
            }),
            _FakeResp({"success": True, "result": {}}),
        ])
        with patch(
            "urllib.request.urlopen", side_effect=lambda *a, **kw: next(responses)
        ) as mock:
            cloudflare.ensure_workspace_ingress("tun-1", "ws-1")
        body = json.loads(mock.call_args_list[-1].args[0].data.decode())
        rules = body["config"]["ingress"]
        workspace_rules = [r for r in rules if r.get("hostname") == "w-ws-1.preview.test"]
        assert len(workspace_rules) == 1
        assert workspace_rules[0] == expected_rule


# ── DNS CNAME helpers -----------------------------------------------


class TestUpsertDnsCname:
    def test_posts_new_record_when_none_exists(self):
        responses = iter([
            # _find_dns_record: no matches
            _FakeResp({"success": True, "result": []}),
            # upsert: POST returns the new record
            _FakeResp({
                "success": True,
                "result": {"id": "dns-1", "name": "w-ws-1.preview.test"},
            }),
        ])
        with patch(
            "urllib.request.urlopen", side_effect=lambda *a, **kw: next(responses)
        ) as mock:
            out = cloudflare.upsert_dns_cname("w-ws-1.preview.test", "tun-1")

        assert out["id"] == "dns-1"
        # The POST call is the second one.
        post = mock.call_args_list[-1].args[0]
        assert post.get_method() == "POST"
        assert post.full_url.endswith("/zones/test-zone/dns_records")
        body = json.loads(post.data.decode())
        assert body["type"] == "CNAME"
        assert body["name"] == "w-ws-1.preview.test"
        assert body["content"] == "tun-1.cfargotunnel.com"
        assert body["proxied"] is True

    def test_puts_existing_record_when_found(self):
        # Re-running provision (e.g. a lazy retry) must not duplicate;
        # it must PUT the existing record by id.
        responses = iter([
            _FakeResp({
                "success": True,
                "result": [{"id": "dns-existing", "name": "w-ws-1.preview.test"}],
            }),
            _FakeResp({"success": True, "result": {"id": "dns-existing"}}),
        ])
        with patch(
            "urllib.request.urlopen", side_effect=lambda *a, **kw: next(responses)
        ) as mock:
            out = cloudflare.upsert_dns_cname("w-ws-1.preview.test", "tun-2")
        assert out["id"] == "dns-existing"
        put = mock.call_args_list[-1].args[0]
        assert put.get_method() == "PUT"
        assert put.full_url.endswith("/zones/test-zone/dns_records/dns-existing")
        body = json.loads(put.data.decode())
        # New tunnel id must land in the record — that's the whole
        # point of upsert.
        assert body["content"] == "tun-2.cfargotunnel.com"


class TestDeleteDnsRecordsForHostname:
    def test_deletes_found_record(self):
        calls: list[tuple[str, str]] = []

        def fake(req, timeout=None):
            calls.append((req.get_method(), req.full_url))
            if req.get_method() == "GET":
                return _FakeResp({
                    "success": True,
                    "result": [{"id": "dns-1", "name": "w-ws-1.preview.test"}],
                })
            return _FakeResp({"success": True, "result": None})

        with patch("urllib.request.urlopen", side_effect=fake):
            cloudflare.delete_dns_records_for_hostname("w-ws-1.preview.test")

        # GET to find the record, then DELETE by id.
        assert any(
            method == "DELETE" and url.endswith("/zones/test-zone/dns_records/dns-1")
            for method, url in calls
        )

    def test_noop_when_no_record(self):
        def fake(req, timeout=None):
            return _FakeResp({"success": True, "result": []})

        with patch("urllib.request.urlopen", side_effect=fake) as mock:
            cloudflare.delete_dns_records_for_hostname("w-missing.preview.test")
        # Only the GET — no DELETE call should follow.
        methods = [call.args[0].get_method() for call in mock.call_args_list]
        assert "DELETE" not in methods

    def test_best_effort_never_raises(self):
        import urllib.error

        err = urllib.error.HTTPError(
            "url", 500, "boom", hdrs=None, fp=io.BytesIO(b""),
        )
        with patch("urllib.request.urlopen", side_effect=err):
            cloudflare.delete_dns_records_for_hostname("w-ws-1.preview.test")


# ── KV namespace helpers -------------------------------------------


class TestKvPut:
    def test_puts_tunnel_id_as_plain_text_value(self):
        with patch(
            "urllib.request.urlopen",
            return_value=_FakeResp(b"", raw=b""),
        ) as mock:
            cloudflare.kv_put("wsp-123", "tun-abc")

        req = _capture_request(mock)
        assert req.get_method() == "PUT"
        # URL must address the right namespace + the URL-encoded key.
        assert req.full_url.endswith(
            "/accounts/test-account/storage/kv/namespaces/test-kv-ns/values/wsp-123"
        )
        # Value is the raw tunnel id — no JSON wrapping, the Worker
        # reads it with env.TUNNEL_MAP.get(key) and expects a string.
        assert req.data == b"tun-abc"
        assert req.headers.get("Content-type") == "text/plain"

    def test_encodes_non_uuid_keys_safely(self):
        # Defensive — current callers only pass UUIDs but if someone
        # later passes `foo/bar` we must not 404 with a path-split.
        with patch(
            "urllib.request.urlopen",
            return_value=_FakeResp(b"", raw=b""),
        ) as mock:
            cloudflare.kv_put("foo/bar", "tun-1")
        req = _capture_request(mock)
        assert req.full_url.endswith("/values/foo%2Fbar")

    def test_http_error_surfaces_as_cloudflare_error(self):
        # Provision uses this on the hot path — a raise is what makes
        # the higher-level handler log + persist the tunnel id for
        # later retry. Silencing here would mean the Worker 404s and
        # we never figure out why.
        import urllib.error

        err = urllib.error.HTTPError(
            "url", 403, "forbidden", hdrs=None, fp=io.BytesIO(b"bad scope"),
        )
        with patch("urllib.request.urlopen", side_effect=err):
            with pytest.raises(cloudflare.CloudflareError):
                cloudflare.kv_put("wsp", "tun")


class TestKvDelete:
    def test_deletes_by_workspace_key(self):
        calls: list[tuple[str, str]] = []

        def fake(req, timeout=None):
            calls.append((req.get_method(), req.full_url))
            return _FakeResp(b"", raw=b"")

        with patch("urllib.request.urlopen", side_effect=fake):
            cloudflare.kv_delete("wsp-123")

        assert calls == [(
            "DELETE",
            "https://api.cloudflare.com/client/v4/accounts/test-account/storage/kv/namespaces/test-kv-ns/values/wsp-123",
        )]

    def test_best_effort_never_raises(self):
        import urllib.error

        err = urllib.error.HTTPError(
            "url", 500, "boom", hdrs=None, fp=io.BytesIO(b""),
        )
        with patch("urllib.request.urlopen", side_effect=err):
            cloudflare.kv_delete("wsp-123")  # no exception

    def test_skips_silently_when_config_missing(self):
        # Mirrors delete_tunnel — terminate depends on never blocking.
        with patch.dict(os.environ, {"CLOUDFLARE_API_TOKEN": ""}, clear=False):
            with patch("urllib.request.urlopen") as mock:
                cloudflare.kv_delete("wsp-123")
                mock.assert_not_called()


class TestKvGet:
    def test_returns_raw_value_on_200(self):
        with patch(
            "urllib.request.urlopen",
            return_value=_FakeResp({}, raw=b"tun-abc"),
        ):
            assert cloudflare.kv_get("wsp-123") == "tun-abc"

    def test_returns_none_on_404(self):
        import urllib.error

        err = urllib.error.HTTPError(
            "url", 404, "not found", hdrs=None, fp=io.BytesIO(b""),
        )
        with patch("urllib.request.urlopen", side_effect=err):
            assert cloudflare.kv_get("wsp-123") is None

    def test_surfaces_other_errors(self):
        import urllib.error

        err = urllib.error.HTTPError(
            "url", 500, "boom", hdrs=None, fp=io.BytesIO(b""),
        )
        with patch("urllib.request.urlopen", side_effect=err):
            with pytest.raises(cloudflare.CloudflareError):
                cloudflare.kv_get("wsp-123")
