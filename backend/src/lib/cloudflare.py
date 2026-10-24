"""
Cloudflare Tunnel + DNS + Workers-KV wrapper for managed-workspace previews.

Why this module exists
----------------------
Managed workspaces expose dev-server ports through a per-workspace
Cloudflare Tunnel. Every preview URL a user clicks is served by a
single global Cloudflare Worker (`pe-preview-proxy`) at
`preview.pocketeng.co`. This module talks to the Cloudflare API to:

1. Create / delete the per-workspace tunnel.
2. Create ONE DNS CNAME per workspace (`w-<wsId>.pocketeng.co` →
   `<tunnelId>.cfargotunnel.com`, proxied). This hostname is what the
   Worker fetches through — Cloudflare's edge refuses to route
   `<tunnelId>.cfargotunnel.com` for Workers unless a DNS record in
   the same zone points at it (see
   https://developers.cloudflare.com/tunnel/routing/#dns-records).
3. Register ONE ingress rule per tunnel pointing the workspace
   hostname at the local preview dispatcher on 127.0.0.1:8844. The
   dispatcher reads the `X-Preview-Port` header (set by the Worker)
   and routes to the right local dev server. Per-port ingress churn
   is deliberately avoided — the ingress set is static for the life
   of the workspace.
4. Write / delete the `workspaceId → tunnelId` entry in the shared KV
   namespace the Worker reads for liveness + 404ing terminated
   workspaces with a branded page.

What we tried that didn't work
------------------------------
- **Per-port CNAME** (`<wsId>-<port>.pocketeng.co`): works in theory
  but hits a 30-minute NXDOMAIN negative-cache race. SOA `min_ttl` is
  1800s on Free/Pro/Business; only tunable on Enterprise.
- **Worker fetches `<tunnelId>.cfargotunnel.com` directly**: 522s. CF
  docs: "The cfargotunnel.com subdomain only proxies traffic for DNS
  records in the same Cloudflare account" — Workers aren't DNS
  records, so the edge can't route them.
- **Per-port tunnel ingress rule with Host-header matching**: fine for
  cloudflared, but Worker `fetch()` overwrites the Host header to the
  target URL hostname. No escape.

What we landed on (Option B)
----------------------------
- ONE public DNS record per workspace: `w-<wsId>.pocketeng.co` CNAME
  to the tunnel, proxied (orange cloud). Race happens once per
  workspace lifetime at provision, during a ~30s provision window —
  no negative cache by the time the user sees the URL.
- ONE ingress rule on the tunnel: that hostname → `http://127.0.0.1:8844`
  (the preview dispatcher).
- Worker fetches `https://w-<wsId>.pocketeng.co/<path>` with
  `X-Preview-Port: <N>`. CF routes via CNAME → tunnel → dispatcher →
  dev server on port N.

See `.harness/learnings/2026-04-cloudflare-tunnel-worker-preview-proxy.md`
for the full design write-up + failure inventory.

HTTP uses stdlib `urllib.request` (same pattern as `lib/slack.py`,
`lib/linq.py`) so we don't pull `requests` into the Lambda bundle.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

_BASE = "https://api.cloudflare.com/client/v4"
_TUNNEL_CATCH_ALL = {"service": "http_status:404"}

# Local port the preview dispatcher listens on (inside the EC2 box).
# MUST match what `backend/src/lib/preview-dispatcher.cjs` binds to.
# If you change this here, change it there AND bump the systemd unit.
DISPATCHER_PORT = 8844

# Hostname prefix for per-workspace preview CNAMEs. `w-<wsId>` keeps
# the preview subdomain namespace separate from anything else we
# might ever register under pocketeng.co, and avoids a leading-digit
# label (UUIDs start with a hex digit — valid DNS, but some older
# tools flake). Format:  `w-<wsId>.pocketeng.co`.
WORKSPACE_HOST_PREFIX = "w-"


class CloudflareError(RuntimeError):
    """Raised when the Cloudflare API returns a non-2xx response or the
    response body's `success` field is False."""


# ── Config ───────────────────────────────────────────────────────────


def _config() -> dict[str, str]:
    """Read config from environment. Raises CloudflareError if anything
    required is missing so callers don't silently attempt a call with
    an empty token (which returns a misleading 400/401 from CF).

    Required vars:
      - CLOUDFLARE_API_TOKEN            Tunnel:Edit + DNS:Edit + KV:Edit
      - CLOUDFLARE_ACCOUNT_ID           owns the tunnels + KV namespace
      - CLOUDFLARE_ZONE_ID              zone id for the preview domain
      - CLOUDFLARE_PREVIEW_DOMAIN       e.g. `pocketeng.co` — the apex
      - CLOUDFLARE_KV_NAMESPACE_ID      the `TUNNEL_MAP` namespace
      - CLOUDFLARE_PREVIEW_WORKER_URL   e.g. https://preview.pocketeng.co

    If the Worker URL's host is itself under the preview domain (normal
    case — `preview.pocketeng.co` under `pocketeng.co`) we reuse the
    same zone for the workspace CNAMEs. No separate zone needed.
    """
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
    zone = os.environ.get("CLOUDFLARE_ZONE_ID", "").strip()
    preview_domain = os.environ.get("CLOUDFLARE_PREVIEW_DOMAIN", "").strip()
    kv_namespace = os.environ.get("CLOUDFLARE_KV_NAMESPACE_ID", "").strip()
    worker_url = os.environ.get("CLOUDFLARE_PREVIEW_WORKER_URL", "").strip()
    missing = [
        name for name, val in (
            ("CLOUDFLARE_API_TOKEN", token),
            ("CLOUDFLARE_ACCOUNT_ID", account),
            ("CLOUDFLARE_ZONE_ID", zone),
            ("CLOUDFLARE_PREVIEW_DOMAIN", preview_domain),
            ("CLOUDFLARE_KV_NAMESPACE_ID", kv_namespace),
            ("CLOUDFLARE_PREVIEW_WORKER_URL", worker_url),
        ) if not val
    ]
    if missing:
        raise CloudflareError(
            f"Cloudflare config missing: {', '.join(missing)}"
        )
    return {
        "token": token,
        "account_id": account,
        "zone_id": zone,
        "preview_domain": preview_domain.lstrip(".").rstrip("."),
        "kv_namespace_id": kv_namespace,
        "worker_url": worker_url.rstrip("/"),
    }


def is_configured() -> bool:
    """Cheap check callers can use to decide whether to attempt a CF
    operation at all. Avoids raising in best-effort paths like
    terminate, where we silently skip if someone happens to deploy
    without the vars set."""
    try:
        _config()
        return True
    except CloudflareError:
        return False


def workspace_hostname(server_id: str) -> str:
    """The public per-workspace hostname. Every preview for a given
    workspace goes through this single CNAME, regardless of dev-server
    port. Returned fully-qualified (includes the zone apex)."""
    cfg = _config()
    return f"{WORKSPACE_HOST_PREFIX}{server_id}.{cfg['preview_domain']}"


def preview_url_for_port(server_id: str, port: int) -> str:
    """Public URL a browser should hit for `(server_id, port)`.

    Shape: `{WORKER_URL}/{serverId}-{port}/`. The trailing slash is
    important — dev servers (Next.js, Vite) typically require it for
    SPA routing to work on a bare root visit.
    """
    cfg = _config()
    return f"{cfg['worker_url']}/{server_id}-{int(port)}/"


# ── Low-level HTTP ───────────────────────────────────────────────────


def _request(
    method: str,
    path: str,
    body: Any = None,
    timeout: int = 15,
    raw_body: bytes | None = None,
    content_type: str = "application/json",
    expect_json: bool = True,
) -> dict:
    """Authenticated request against the CF v4 API.

    Most endpoints take + return JSON. Workers-KV value writes are the
    exception — they accept arbitrary bytes with `Content-Type:
    text/plain` (or any) and return an empty body on 204. `raw_body`,
    `content_type`, and `expect_json` let this one wrapper handle both.

    Returns the parsed dict on JSON responses, `{}` on empty/non-JSON
    responses when `expect_json=False`. Raises CloudflareError on
    non-2xx or `success=False`.
    """
    cfg = _config()
    url = f"{_BASE}{path}"
    headers = {
        "Authorization": f"Bearer {cfg['token']}",
    }
    if raw_body is not None:
        headers["Content-Type"] = content_type
        data = raw_body
    elif body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")
    else:
        data = None

    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = resp.read()
    except urllib.error.HTTPError as exc:
        try:
            body_txt = exc.read().decode("utf-8", errors="replace")
        except Exception:
            body_txt = ""
        raise CloudflareError(
            f"Cloudflare {method} {path} failed: HTTP {exc.code} {body_txt[:400]}"
        )
    except urllib.error.URLError as exc:
        raise CloudflareError(
            f"Cloudflare {method} {path} network error: {exc.reason}"
        )

    if not expect_json:
        # KV value writes return empty bodies. Nothing to parse.
        return {}

    text = payload.decode("utf-8") if isinstance(payload, (bytes, bytearray)) else payload
    try:
        parsed = json.loads(text) if text else {}
    except Exception as exc:
        raise CloudflareError(
            f"Cloudflare {method} {path} returned non-JSON: {exc}"
        )
    if not parsed.get("success", False):
        errors = parsed.get("errors") or []
        raise CloudflareError(
            f"Cloudflare {method} {path} returned success=false: {errors}"
        )
    return parsed


# ── Tunnel CRUD ──────────────────────────────────────────────────────


def create_tunnel(name: str) -> dict:
    """Create a new Named Tunnel with `config_src=cloudflare`.

    `config_src=cloudflare` means the tunnel's ingress configuration is
    owned by the dashboard / API, not by a config file on the EC2 host.
    That's the whole point — we want to set the workspace ingress rule
    by API call from provision, without reaching onto the box.

    Returns the full `result` dict from CF. Keys you'll care about:
      - `id`: tunnel UUID (this is what we store as `tunnelId` in DDB
        AND in the KV map keyed by workspaceId).
      - `token`: base64 string that `cloudflared service install` takes.
    """
    cfg = _config()
    result = _request(
        "POST",
        f"/accounts/{cfg['account_id']}/cfd_tunnel",
        body={"name": name, "config_src": "cloudflare"},
    )
    return result["result"]


def get_tunnel_token(tunnel_id: str) -> str:
    """Fetch the connector token for an existing tunnel.

    The tunnel-create response already contains a token, so this is
    mostly useful for (a) re-fetching the token when we lazy-create a
    tunnel long after the workspace was provisioned and (b) tests that
    want to assert on the exact endpoint shape.
    """
    cfg = _config()
    result = _request(
        "GET", f"/accounts/{cfg['account_id']}/cfd_tunnel/{tunnel_id}/token"
    )
    token = result.get("result")
    if not isinstance(token, str) or not token:
        raise CloudflareError(f"tunnel {tunnel_id}: empty token response")
    return token


def delete_tunnel(tunnel_id: str) -> None:
    """Best-effort delete. Cleans up active connections first so CF
    doesn't reject the delete with "tunnel has active connectors".

    NEVER raises — the contract with callers is "try to clean up, log
    any failure, don't break the main workflow". A left-over tunnel is
    a dashboard cleanup task, not a user-facing outage.
    """
    try:
        cfg = _config()
    except CloudflareError as exc:
        print(f"cloudflare.delete_tunnel({tunnel_id}): skipped: {exc}")
        return
    try:
        _request(
            "DELETE",
            f"/accounts/{cfg['account_id']}/cfd_tunnel/{tunnel_id}/connections",
            timeout=10,
        )
    except CloudflareError as exc:
        print(f"cloudflare.delete_tunnel({tunnel_id}): cleanup connections failed: {exc}")
    try:
        _request(
            "DELETE",
            f"/accounts/{cfg['account_id']}/cfd_tunnel/{tunnel_id}",
            timeout=10,
        )
    except CloudflareError as exc:
        print(f"cloudflare.delete_tunnel({tunnel_id}): delete failed: {exc}")


# ── Tunnel configuration (ingress rules) ─────────────────────────────


def get_tunnel_config(tunnel_id: str) -> dict:
    """Fetch the current configuration for a tunnel. Empty tunnels
    return a `config` dict with `ingress: null`; we normalise that to
    `[]` so callers can treat the list uniformly."""
    cfg = _config()
    result = _request(
        "GET",
        f"/accounts/{cfg['account_id']}/cfd_tunnel/{tunnel_id}/configurations",
    )
    config = (result.get("result") or {}).get("config") or {}
    if config.get("ingress") is None:
        config["ingress"] = []
    return config


def set_tunnel_config(tunnel_id: str, ingress_rules: list[dict]) -> None:
    """Overwrite a tunnel's ingress rules.

    Caller is responsible for ensuring the list ends with a catch-all
    (e.g. ``{"service": "http_status:404"}``). We enforce it defensively
    here so a bad caller can't leave a tunnel in an "always 530"
    state — Cloudflare will reject a config missing the catch-all.
    """
    cfg = _config()
    if not ingress_rules or ingress_rules[-1].get("service") != _TUNNEL_CATCH_ALL["service"]:
        ingress_rules = [
            *[r for r in ingress_rules if r.get("service") != _TUNNEL_CATCH_ALL["service"]],
            _TUNNEL_CATCH_ALL,
        ]
    _request(
        "PUT",
        f"/accounts/{cfg['account_id']}/cfd_tunnel/{tunnel_id}/configurations",
        body={"config": {"ingress": ingress_rules}},
    )


def ensure_workspace_ingress(tunnel_id: str, server_id: str) -> str:
    """Ensure the tunnel has ONE ingress rule routing the workspace
    hostname at the local preview dispatcher.

    Shape:
      - hostname: w-<wsId>.pocketeng.co
      - service:  http://127.0.0.1:8844

    The Worker sets `X-Preview-Port: <N>` when fetching; the dispatcher
    on the box uses that to pick the dev-server port. No per-port
    ingress churn. Called at provision time (once) and idempotently
    from chat.py on lazy tunnel creation for pre-migration workspaces.

    Returns the workspace hostname so callers can log / trace it.

    Why 127.0.0.1 and not `localhost`: on AL2023 `localhost` can
    resolve to `::1` first, and the dispatcher listens on 0.0.0.0 IPv4
    only. Pinning to the literal IPv4 address dodges the happy-eyeballs
    problem that previously produced 522 timeouts.
    """
    hostname = workspace_hostname(server_id)
    service_url = f"http://127.0.0.1:{DISPATCHER_PORT}"
    # "One rule per tunnel" is the invariant Option-B depends on — if
    # a legacy `pe-port-*` rule from the old design still matched
    # first, cloudflared would short-circuit on it and never reach
    # the dispatcher. So we don't preserve any hostname rules here;
    # the single workspace rule replaces every non-catch-all entry.
    # This is also how a freshly-created tunnel naturally ends up
    # (no existing rules), so the fresh + lazy paths converge.
    new_rule = {"hostname": hostname, "service": service_url}
    set_tunnel_config(tunnel_id, [new_rule])
    return hostname


# ── DNS (per-workspace CNAME to tunnel) ──────────────────────────────


def upsert_dns_cname(hostname: str, tunnel_id: str) -> dict:
    """Create or update the CNAME that points `hostname` at the tunnel.

    Shape:  `<hostname>` CNAME → `<tunnelId>.cfargotunnel.com` (proxied).

    Called once per workspace at provision time. The NXDOMAIN race we
    fought before is bounded here — the record is created before the
    user ever sees the URL (provisioning takes ~30s), and after that
    it exists forever for the workspace's lifetime. Per-port
    variations are handled in-path by the Worker, not by new DNS
    records, so there's no per-click DNS creation to race.

    Idempotent: if a CNAME for `hostname` already exists we update it
    in place instead of creating a duplicate (CF would return a 81058
    "record already exists" error on the second POST otherwise).

    Returns the full record dict from CF on success so callers can
    log the record id for audit.
    """
    cfg = _config()
    target = f"{tunnel_id}.cfargotunnel.com"
    existing = _find_dns_record(cfg, hostname)
    body = {
        "type": "CNAME",
        "name": hostname,
        "content": target,
        "proxied": True,
        "ttl": 1,  # 1 = "automatic" when proxied
        "comment": f"pe-preview managed CNAME for tunnel {tunnel_id}",
    }
    if existing:
        result = _request(
            "PUT",
            f"/zones/{cfg['zone_id']}/dns_records/{existing['id']}",
            body=body,
        )
    else:
        result = _request(
            "POST",
            f"/zones/{cfg['zone_id']}/dns_records",
            body=body,
        )
    return result["result"]


def delete_dns_records_for_hostname(hostname: str) -> None:
    """Best-effort DNS cleanup on workspace terminate.

    There is exactly one CNAME per workspace (the one written by
    upsert_dns_cname). We look it up by name and delete it. Never
    raises — stranded records produce a 1016 at the browser which is
    graceful enough, and the CF dashboard sweep is a separate cleanup
    concern.
    """
    try:
        cfg = _config()
    except CloudflareError as exc:
        print(f"cloudflare.delete_dns_records_for_hostname({hostname}): skipped: {exc}")
        return
    try:
        record = _find_dns_record(cfg, hostname)
    except CloudflareError as exc:
        print(f"cloudflare.delete_dns_records_for_hostname({hostname}): list failed: {exc}")
        return
    if not record:
        return
    try:
        _request(
            "DELETE",
            f"/zones/{cfg['zone_id']}/dns_records/{record['id']}",
            timeout=10,
        )
    except CloudflareError as exc:
        print(
            f"cloudflare.delete_dns_records_for_hostname({hostname}): "
            f"delete id={record['id']} failed: {exc}"
        )


def _find_dns_record(cfg: dict[str, str], hostname: str) -> dict | None:
    """Look up the DNS record for `hostname` by exact name match.

    Uses the `name` query param so we don't pull the whole zone. CF
    returns 0 or 1 matches for an exact CNAME lookup — multiple
    records sharing the same name is only possible for A/AAAA, which
    we don't use here. If multiple are ever returned we prefer the
    first to avoid caller-side fanout.
    """
    path = (
        f"/zones/{cfg['zone_id']}/dns_records"
        f"?type=CNAME&name={urllib.parse.quote(hostname, safe='')}"
    )
    result = _request("GET", path)
    records = result.get("result") or []
    return records[0] if records else None


# ── KV (workspaceId → tunnelId) ──────────────────────────────────────


def kv_put(server_id: str, tunnel_id: str) -> None:
    """Write the `serverId → tunnelId` entry the Worker reads.

    Called on workspace create (sync path: provision holds the request
    until this succeeds) and on lazy-tunnel-create from the chat
    handler. The value is stored as plain text — no JSON wrapper —
    because the Worker reads it as a string. The Worker uses this for
    LIVENESS — it's a quick check to render a branded 404 for
    terminated / unknown workspaces instead of the default CF 1016
    page. The actual routing happens through the per-workspace CNAME.

    Raises CloudflareError on failure. Callers on the hot path (chat
    discover) should treat this as best-effort and fall back to a
    legacy URL if it fails; provision should fail loudly (a provisioned
    workspace with a tunnel but no KV entry would hit a branded 404
    on the first preview click).
    """
    cfg = _config()
    _request(
        "PUT",
        (
            f"/accounts/{cfg['account_id']}/storage/kv/namespaces/"
            f"{cfg['kv_namespace_id']}/values/{_encode_kv_key(server_id)}"
        ),
        raw_body=tunnel_id.encode("utf-8"),
        content_type="text/plain",
        expect_json=False,
    )


def kv_delete(server_id: str) -> None:
    """Best-effort KV delete. Mirrors the tunnel-delete contract —
    logs on failure, never raises. A stale KV entry would leave the
    Worker pointing at a nonexistent workspace hostname, which
    produces a CF 1016 on the user side — acceptable, not a blocker
    for the terminate flow."""
    try:
        cfg = _config()
    except CloudflareError as exc:
        print(f"cloudflare.kv_delete({server_id}): skipped: {exc}")
        return
    try:
        _request(
            "DELETE",
            (
                f"/accounts/{cfg['account_id']}/storage/kv/namespaces/"
                f"{cfg['kv_namespace_id']}/values/{_encode_kv_key(server_id)}"
            ),
            timeout=10,
            expect_json=False,
        )
    except CloudflareError as exc:
        print(f"cloudflare.kv_delete({server_id}): failed: {exc}")


def kv_get(server_id: str) -> str | None:
    """Read the tunnel id for a workspace. Returns None on 404.

    Only used by tests + debug tooling — the Worker is the primary
    reader. Provided so test-stack integration tests can assert "yes,
    KV actually has what we think it has" without dragging in the
    full `wrangler` CLI.
    """
    cfg = _config()
    path = (
        f"/accounts/{cfg['account_id']}/storage/kv/namespaces/"
        f"{cfg['kv_namespace_id']}/values/{_encode_kv_key(server_id)}"
    )
    # KV value GET returns the raw value with 200, or 404 if missing.
    # _request wraps the v4 envelope for JSON; for value reads we have
    # to call urllib directly so we see the raw body.
    url = f"{_BASE}{path}"
    req = urllib.request.Request(
        url, method="GET",
        headers={"Authorization": f"Bearer {cfg['token']}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.read().decode("utf-8") or None
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise CloudflareError(f"kv_get({server_id}) HTTP {exc.code}")
    except urllib.error.URLError as exc:
        raise CloudflareError(f"kv_get({server_id}) network error: {exc.reason}")


def _encode_kv_key(key: str) -> str:
    """URL-encode a KV key. Keys containing `/` or other reserved
    characters must be percent-encoded or the CF router picks up the
    wrong path. Workspace IDs are UUIDs so they're already safe, but
    we encode defensively in case a future caller passes something
    richer."""
    return urllib.parse.quote(key, safe="")
