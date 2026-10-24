---
type: learning
status: deprecated
last_reviewed: 2026-04-30
superseded_by: learnings/2026-04-cloudflare-tunnel-preview-dispatcher.md
oversized_justification: |
  Captures the full DNS-NXDOMAIN race diagnosis + the five evaluated
  alternatives + the Worker/KV architecture + data-flow walkthroughs +
  failure matrix + ops notes. Splitting any of those into a separate
  doc would fragment "why this shape, not the shape before it",
  which is the main thing a future maintainer needs to see at a
  glance when they get paged for a preview outage. The soft 200-line
  cap is the right default for most scars; this one is a design
  record and the cost of cross-file archaeology outweighs the cost
  of one long page.
related:
  - protocols/testing-protocol.md
  - references/env-variables.md
  - playbooks/deploy-to-test-stack.md
  - learnings/2026-04-cloudflare-tunnel-preview-migration.md
  - learnings/2026-04-cloudflare-tunnel-preview-dispatcher.md
tags: [learning, cloudflare, tunnel, worker, kv, preview, dns, design, deprecated]
---

# Cloudflare preview proxy — Worker + KV (supersedes per-port CNAMEs) [DEPRECATED]

> **Superseded by** [`2026-04-cloudflare-tunnel-preview-dispatcher.md`](2026-04-cloudflare-tunnel-preview-dispatcher.md).
>
> The "Worker fetches `<tunnelId>.cfargotunnel.com`" idea documented
> below **does not work** from a Worker on our account plan — every
> request 522s because that hostname isn't reachable from outside
> Cloudflare's internal network without an Enterprise-gated
> `resolveOverride` hack. Keep reading for historical context, but
> the running architecture is per-workspace CNAME + on-EC2 dispatcher.

**When to read:** before touching
`backend/src/lib/cloudflare.py`, `_discover_services` /
`_ensure_tunnel_for_server` in `backend/src/chat.py`, `provision.py`'s
tunnel bootstrap, `action.py`'s terminate-path cleanup, the
`web/lib/preview.ts` URL builder, or the Worker in
`cloudflare-worker/preview-proxy/`.

**When to update:** if the single-hostname contract changes
(e.g. we move to per-account Worker subdomains, or add a separate
hostname for authenticated previews), or the Host-header port-routing
scheme gets replaced. Do NOT edit the history; the per-port CNAME
scar in [`2026-04-cloudflare-tunnel-preview-migration.md`](2026-04-cloudflare-tunnel-preview-migration.md)
is context for why we landed here, not a decision to re-litigate.

---

## One-line

Managed-workspace preview traffic now routes through **one** global
Cloudflare Worker (`pe-preview-proxy` at `preview.pocketeng.co`) that
looks up `workspaceId → tunnelId` in a Workers-KV namespace and
proxies to the per-workspace Cloudflare Tunnel with a `Host:
pe-port-<N>` header. No DNS records are minted per preview — exactly
one exists for the Worker hostname, forever.

## The bug that forced the redesign

Shipped the per-port-CNAME migration (previous learning). First real
user click produced:

```
DNS_PROBE_FINISHED_NXDOMAIN
3694ef9e-df5e-4a60-9b6b-6c82966e499a-5000.pocketeng.co
```

Dig pathway:

1. User clicks **Preview → Port 5000** in the dashboard.
2. Backend calls `cloudflare.upsert_dns_cname(...)` — CNAME is
   created in Cloudflare's authoritative DNS within ~400ms.
3. Browser issues DNS lookup. The user's resolver (8.8.8.8, 1.1.1.1,
   ISP, doesn't matter) hits Cloudflare auth, gets the new CNAME back.
4. **Usually** works. But if the resolver had queried that hostname
   seconds before we created it (e.g. a dashboard preflight, another
   user on the same ISP poking around), it already cached an
   **NXDOMAIN** response. It won't re-ask the authoritative server
   until its negative-cache TTL expires.

The TTL in question is the zone's **SOA `min_ttl`**, which on the
Cloudflare Free / Pro / Business plans is hard-wired to **1800s**.
Only Enterprise lets you edit it. So the first preview per `(ISP,
port)` could appear broken for up to 30 minutes, with no in-loop fix.

### Options we evaluated

| Option | Why we didn't pick it |
|---|---|
| **Wait-then-verify loop in the dashboard** — poll until DNS resolves | Doesn't help. The user's resolver is the one with the bad cache; our backend's resolver sees the record instantly. Polling from the backend would falsely clear the loading state. |
| **Multi-level subdomains per workspace** — e.g. `5000.abc123.pocketeng.co`, with a wildcard CNAME `*.abc123.pocketeng.co → tunnel` | Multi-level wildcards on a custom domain need a paid Advanced Certificate on Cloudflare (~$10/month). Works, but a recurring cost for every user workspace and the wildcard pattern still has edge cases with strict resolvers. |
| **Upgrade to Cloudflare Enterprise and drop `min_ttl` to 60s** | Doesn't actually solve it — shrinks the window from 30min to 1min, but "preview link sometimes flaky for 60s" is still a bad experience. And Enterprise pricing is 4+ figures/month for a feature we'd also get from the design below. |
| **Run our own proxy (Lambda / EC2)** — what we had before this whole series | Kills WebSockets (API Gateway WS is a different API), adds latency, and we already tried it; the per-port CNAME migration was the exit from this. |
| **Cloudflare Worker with a single hostname + KV routing** ← chosen | One DNS record ever, created once. No per-preview DNS operation exists to race. Workers handle WebSockets natively. KV lookups are ~1ms edge-side. Free tier covers 100k requests/day which is ~three orders of magnitude more than we need for months. |

## Architecture

```
user browser
    │ https://preview.pocketeng.co/<workspaceId>-<port>/<path>
    ▼
Cloudflare Worker (pe-preview-proxy)
    │   1. Parse first path segment → (workspaceId, port)
    │   2. KV.get(workspaceId) → tunnelId (or 404)
    │   3. fetch(`https://<tunnelId>.cfargotunnel.com/<path>`)
    │      with Host: pe-port-<port>
    ▼
Cloudflare network (internal routing — no external DNS)
    │
    ▼
cloudflared on EC2 (per-workspace tunnel)
    │   ingress:
    │     - hostname: pe-port-3000 → http://localhost:3000
    │     - hostname: pe-port-5000 → http://localhost:5000
    │     - service: http_status:404    (catch-all)
    ▼
dev server on the workspace
```

**Critical invariants** — change any of these and previews break:

1. **One DNS record.** `preview.pocketeng.co` (AAAA → `100::`,
   proxied). Created by the deploy step, never again touched. The
   discard-prefix address means even if the orange cloud accidentally
   gets turned off, the record doesn't resolve to a real host.
2. **Worker name is the route.** `wrangler.toml` pins
   `preview.pocketeng.co/*` → `pe-preview-proxy`. A rename, or
   running two Workers on overlapping patterns, drops traffic
   silently to whichever wins.
3. **KV key shape = workspaceId.** UUID v4 only. Any encoding change
   needs the Worker regex + `backend/src/lib/cloudflare.py::_encode_kv_key`
   to move together.
4. **Host header contract.** Worker sets `Host: pe-port-<N>`; tunnel
   ingress matches on `hostname: pe-port-<N>`. The prefix is the
   shared `PORT_HOST_PREFIX` constant in `cloudflare.py` — Python and
   the Worker both hard-code `pe-port-`. Any change requires a
   coordinated Worker redeploy + ingress drain on every active
   tunnel, otherwise previews 404.
5. **Ingress always ends in a catch-all.** `set_tunnel_config` enforces
   `{"service": "http_status:404"}` as the last rule — Cloudflare
   rejects configs without one and silently 530s everything.

## Data flow

### Provision (new workspace, happy path)

1. `provision.py` mints `serverId` (UUID).
2. `cloudflare.create_tunnel(f"pe-{serverId}")` → returns
   `{id, token}`.
3. `cloudflare.kv_put(serverId, tunnelId)` — Worker can now find the
   tunnel for future preview clicks.
4. `build_userdata(...)` embeds the connector token; EC2 boots,
   `cloudflared` starts, registers its connection.
5. Server record saved with `tunnelId`. Tunnel ingress is *empty*
   (just the catch-all) — discover-services adds rules on demand.

### Preview click

1. Dashboard calls `GET /servers/{id}/discover-services` which runs
   `chat._discover_services`.
2. `_discover_services` per-port:
   - `cloudflare.upsert_port_ingress(tunnelId, port)` → idempotent
     PUT of the tunnel config with a rule for this port.
   - `cloudflare.preview_url_for_port(serverId, port)` → returns
     `https://preview.pocketeng.co/<serverId>-<port>/`.
3. User clicks the link; Worker serves it. No DNS creation ever
   happens on the hot path.

### Lazy path (pre-migration workspaces)

If `tunnelId` is missing on an existing server record, the first
`_discover_services` call:
1. Creates the tunnel (`cloudflare.create_tunnel`).
2. Writes the KV entry.
3. SSH-installs `cloudflared` on the box with the returned token.
4. Persists `tunnelId` on the server record.

Kv_put is also re-run on every `_discover_services` call for servers
that *already* have a `tunnelId` — cheap self-healing for the case
where the provision-time write failed.

### Terminate

1. `cloudflare.kv_delete(serverId)` — Worker 404s bookmarked previews
   within seconds (KV eventual-consistency window is sub-second in
   practice).
2. `cloudflare.delete_tunnel(tunnelId)` — drains connectors then
   deletes. Best-effort; failures log but never block EC2 cleanup.

Both calls treat missing-config as "skip cleanly, don't raise" because
terminate must always succeed from the user's perspective.

## Failure modes and their user-visible shape

| Upstream failure | Worker response | Dashboard action needed |
|---|---|---|
| KV has no entry for workspaceId | Friendly HTML 404 ("workspace not found") | None; user-facing — next preview click re-runs discover, which writes KV |
| Tunnel id exists but tunnel was deleted | `fetch` returns 502 from cfargotunnel.com — passed through | Check backend logs; orphan KV entry. `kv_delete` on next `action=terminate` will clear |
| Workspace's cloudflared is down | Tunnel returns 530 or cloudflared's branded "origin unreachable" page | User restarts the workspace; `lifecycle.py` will also catch this in reconciliation |
| CF API outage during discover | `upsert_port_ingress` raises; `_preview_url_for_port` falls back to `http://IP:port` (broken since port 3000-9000 not open on SG for new workspaces anymore) | Surface the legacy proxy UI path; accept short outage |
| User pastes old per-port CNAME URL (from bookmarks) | DNS fails (we never created those records) | Dashboard preview button regenerates the Worker URL |

## Operational notes

### Rotating the API token

Old token had `DNS:Edit` + `Cloudflare Tunnel:Edit` + `Account:Read`.
**New scope needed:** `Cloudflare Tunnel: Edit` +
`Workers KV Storage: Edit` + `Account: Read`. If you rotate without
adding `Workers KV Storage: Edit`, every `kv_put` will fail with a
403 — the symptom is fresh workspaces that provision fine but whose
previews land on the Worker's 404 page.

### Deploying the Worker

From `cloudflare-worker/preview-proxy/`:
```bash
wrangler deploy               # test
wrangler deploy --env prod    # prod
wrangler tail                 # live logs
```

Miniflare (`wrangler dev`) runs locally but can't reach
`<tunnelId>.cfargotunnel.com` — that hostname is reachable only from
inside Cloudflare's network. KV + path parsing work fine locally; the
`fetch()` will fail. Real integration testing is against the deployed
test stack.

### Verifying a tunnel by hand

```bash
# what does KV think for this workspace?
curl "https://api.cloudflare.com/client/v4/accounts/$CF_ACC/storage/kv/namespaces/$KV_NS/values/$SID" \
  -H "Authorization: Bearer $CF_TOKEN"

# what ingress does the tunnel think it has?
curl "https://api.cloudflare.com/client/v4/accounts/$CF_ACC/cfd_tunnel/$TUN/configurations" \
  -H "Authorization: Bearer $CF_TOKEN" | jq .result.config.ingress
```

A working workspace has (a) KV value = tunnelId, (b) ingress
includes a rule with `hostname: pe-port-<port>` for each open port,
(c) `cloudflared` running on the box and registered.

## What we did NOT do

- **We did NOT delete the old per-workspace CNAME records.** Any
  records left behind from the previous migration are harmless — the
  frontend never navigates to them, and they share the free tier's
  "as many DNS records as you want" quota. A cleanup pass can run
  at any point by listing all records with `content LIKE
  '*.cfargotunnel.com'` and filtering.
- **We did NOT keep `CLOUDFLARE_ZONE_ID` / `CLOUDFLARE_PREVIEW_DOMAIN`
  as required config.** They're unused but tolerated in the
  environment so existing deploys don't break on rollout. Drop them
  from SAM params on the next backwards-incompatible deploy.
- **We did NOT scope tunnels to accept Worker-only traffic.** Anyone
  who happens to learn the `<tunnelId>.cfargotunnel.com` hostname
  could bypass the Worker. Not a leak because (a) tunnel IDs are
  random UUIDs, (b) the ingress requires the `pe-port-<N>` Host
  header to return anything, (c) the product has no secret data on
  dev-server ports. A follow-up if we ever add auth'd previews:
  sign a Worker→tunnel header and reject others in cloudflared
  ingress via access rules.

## Revert plan (if the Worker path ever misbehaves)

1. Flip `NEXT_PUBLIC_CLOUDFLARE_PREVIEW_WORKER_URL=""` on the web
   deploy. `isCloudflareManaged()` will return false and every
   preview will fall back to `/api/preview/...`.
2. Leave the backend as-is — no env changes are required on the
   Lambda side for the rollback. Tunnels continue to get provisioned
   but the URLs surfaced to the user are the legacy proxy.
3. Debug the Worker (`wrangler tail`) and redeploy when fixed.

One-edit rollback was a design constraint from the start; keep it
that way. If we ever add a feature that breaks it, mark it explicit
in this file.
