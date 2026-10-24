---
type: learning
status: canonical
last_reviewed: 2026-04-30
supersedes:
  - learnings/2026-04-cloudflare-tunnel-worker-preview-proxy.md
related:
  - learnings/2026-04-cloudflare-tunnel-worker-preview-proxy.md
  - learnings/2026-04-cloudflare-tunnel-preview-migration.md
  - protocols/testing-protocol.md
  - references/env-variables.md
  - playbooks/deploy-to-test-stack.md
tags: [learning, cloudflare, tunnel, worker, kv, preview, dns, dispatcher, design]
oversized_justification: |
  Documents the "why we stopped trusting `<tunnelId>.cfargotunnel.com`",
  the new three-hop architecture (Worker → workspace CNAME → on-EC2
  dispatcher), all the moving pieces (Worker, KV, DNS, ingress, systemd
  unit, lazy-migration path, env vars), failure matrix, and the revert
  plan in one page. Splitting would scatter the why/what/how across
  files and make the next paging session harder.
---

# Cloudflare preview proxy — Worker + per-workspace CNAME + on-EC2 dispatcher (supersedes single-hostname Worker)

**When to read:** before touching
`backend/src/lib/cloudflare.py`, `backend/src/lib/preview-dispatcher.cjs`,
`backend/src/lib/userdata.py` (`_preview_dispatcher_block`),
`_ensure_tunnel_for_server` / `_discover_services` in
`backend/src/chat.py`, `provision.py`'s tunnel bootstrap,
`action.py`'s terminate-path cleanup, `web/lib/preview.ts`,
or the Worker in `cloudflare-worker/preview-proxy/`.

**When to update:** if the per-workspace CNAME scheme changes
(e.g. we move to one shared hostname again, or `X-Preview-Port` is
renamed / signed), or the dispatcher's transport changes
(Unix socket instead of 127.0.0.1:8844, different runtime). Do NOT
edit the history; the two older scars
([`2026-04-cloudflare-tunnel-preview-migration.md`](2026-04-cloudflare-tunnel-preview-migration.md)
and [`2026-04-cloudflare-tunnel-worker-preview-proxy.md`](2026-04-cloudflare-tunnel-worker-preview-proxy.md))
are context for why we landed here, not decisions to re-litigate.

---

## One-line

Managed-workspace preview traffic routes through a thin global
Cloudflare Worker (`pe-preview-proxy` at `preview.pocketeng.co`) that
fetches the **per-workspace CNAME** `w-<wsId>.pocketeng.co` with an
`X-Preview-Port: <N>` header; an on-EC2 Node.js **dispatcher** on
`127.0.0.1:8844` reads the header and proxies to the local dev server.

## The bug that forced the redesign

Previous architecture had the Worker `fetch` directly against
`<tunnelId>.cfargotunnel.com` with `Host: pe-port-<N>`. Every request
from a real browser produced:

```
HTTP 522 Connection timed out
<tunnelId>.cfargotunnel.com — Host Error
```

even though:
- The local dev server was up and `curl http://localhost:5000/`
  returned 200 on the workspace itself.
- `cloudflared` was healthy and had picked up the ingress config
  (journalctl showed "Updated to new configuration").
- Cloudflare's cloud-to-origin leg was green (Cloudflare UI's
  diagnostic showed "Cloudflare: Working").

### Root cause

Workers are **not allowed** to `fetch` directly against
`*.cfargotunnel.com` hostnames from user zones in this account type.
The request goes out to the public internet where that hostname has
no A record → edge eventually 522s. The trick of
`fetch('https://<tunnelId>.cfargotunnel.com', { ...cf: { resolveOverride } })`
is account-gated and wasn't available to us. There is no combination
of Workers flags that makes `<tunnelId>.cfargotunnel.com` routable
from a Worker in our plan.

The only documented and officially-supported path is:
> Create a **public hostname** (CNAME in your zone) that points at the
> tunnel, and have the Worker fetch that public hostname.

Which is what Option B does.

### Options we evaluated (this iteration)

| Option | Why we didn't pick it |
|---|---|
| **Accept per-workspace-per-port CNAMEs** (the original scheme from the first scar) | Brought back the NXDOMAIN-negative-cache race (up to 30min of "broken preview" after each new port click). That's what the Worker design was supposed to *fix*. |
| **Pre-create the CNAME at workspace provision and route all ports through it + Host header** — but *without* a dispatcher; let cloudflared ingress route on Host | Works but puts us back on the hot-path ingress churn — every new preview port means mutating the tunnel config. Tunnels reload gracefully but the write is still a blocking API call, and the whole history of this module is bug-scars from that churn. |
| **Upgrade to Enterprise + `resolveOverride`** | Enterprise-gated Worker feature. Four-figure monthly spend for the one thing we need. |
| **Per-workspace CNAME + on-EC2 port dispatcher** ← chosen | One DNS op per workspace (at provision / lazy first click). One ingress rule per tunnel, forever. New ports require zero DNS / API action. Dispatcher handles routing locally based on `X-Preview-Port` header, including WebSocket upgrades. |

## Architecture

```
user browser
    │ https://preview.pocketeng.co/<workspaceId>-<port>/<path>
    ▼
Cloudflare Worker (pe-preview-proxy, single global)
    │   1. Parse first path segment → (workspaceId, port)
    │   2. KV.get(workspaceId) → tunnelId   (only for branded 404s)
    │   3. fetch(`https://w-<workspaceId>.pocketeng.co/<path>`)
    │      with X-Preview-Port: <port>
    ▼
public DNS (Cloudflare auth) — created once per workspace
    │ w-<workspaceId>.pocketeng.co  CNAME  <tunnelId>.cfargotunnel.com  (proxied)
    ▼
cloudflared on EC2 (per-workspace tunnel)
    │   ingress (one rule per tunnel, forever):
    │     - hostname: w-<wsId>.pocketeng.co → http://127.0.0.1:8844
    │     - service: http_status:404    (catch-all)
    ▼
pe-preview-dispatcher.service (Node.js, 127.0.0.1:8844)
    │   1. Read `X-Preview-Port: <N>` from request
    │   2. Strip it, set Host: localhost:<N>
    │   3. Proxy to http://127.0.0.1:<N> (incl. WebSocket upgrade)
    ▼
dev server on the workspace
```

**Critical invariants** — change any of these and previews break:

1. **Every workspace has exactly one CNAME.** `w-<wsId>.pocketeng.co`
   is created at provision time (and lazy-created on first preview
   click for pre-migration boxes). It is a proxied CNAME to
   `<tunnelId>.cfargotunnel.com`. Deleting the CNAME while the
   workspace is alive will 1014 every preview.
2. **One ingress rule per tunnel.** `cloudflare.ensure_workspace_ingress`
   overwrites the tunnel config with a single non-catch-all rule
   (`hostname: w-<wsId>.pocketeng.co → http://127.0.0.1:8844`).
   Any legacy `pe-port-<N>` rules from the previous migration are
   wiped on the next call — do NOT add code that preserves them.
3. **Dispatcher port = 8844 and is a reserved token.** Constant lives
   in `cloudflare.py` as `DISPATCHER_PORT` and in `preview-dispatcher.cjs`
   as `LISTEN_PORT` (env overrideable, default 8844). `_discover_services`
   filters this port out of the user-facing services list — if you
   change the port, update both constants AND the filter.
4. **`X-Preview-Port` contract.** Worker sets it; dispatcher reads,
   validates `1 < N ≤ 65535`, and strips it before proxying. If you
   rename the header you must redeploy the Worker and every on-box
   dispatcher at the same time — there is no backward-compatible path.
5. **Dispatcher binds to loopback only.** `127.0.0.1:8844`. If someone
   "fixes" it to `0.0.0.0:8844` to help debugging, ports 1-65535 on
   every workspace become drive-by accessible from anything on the
   VPC. Keep it loopback.
6. **Ingress always ends in a catch-all.** `set_tunnel_config` enforces
   `{"service": "http_status:404"}` as the final rule — Cloudflare
   rejects configs without one.

## Data flow

### Provision (new workspace, happy path)

1. `provision.py` mints `serverId` (UUID).
2. `cloudflare.create_tunnel(f"pe-{serverId}")` → `{id, token}`.
3. `cloudflare.upsert_dns_cname(workspace_hostname(serverId), tunnelId)`.
4. `cloudflare.ensure_workspace_ingress(tunnelId, serverId)` — one
   rule pointing to `http://127.0.0.1:8844`.
5. `cloudflare.kv_put(serverId, tunnelId)` — Worker can show branded
   404s for dead workspaces.
6. `build_userdata(...)` embeds the connector token; userdata script
   installs **both** the dispatcher (as `pe-preview-dispatcher.service`)
   and `cloudflared` (as `cloudflared.service`). Dispatcher bakes
   BEFORE cloudflared so the tunnel comes up pointing at a listening
   loopback.
7. EC2 boots; both services start.

### Preview click

1. Dashboard calls `_discover_services`, which SSH-scans for listening
   ports on the box and returns a list with the `preview.pocketeng.co/<wsId>-<port>/`
   URL per port (minus port 8844, filtered out).
2. User clicks; Worker derives `w-<wsId>.pocketeng.co` + port, sets
   `X-Preview-Port`, fetches. **No DNS or tunnel API call on the
   hot path.**

### Lazy path (pre-migration workspaces)

`_ensure_tunnel_for_server` in `chat.py` handles boxes missing the
new wiring. On the first preview click it:
1. Idempotently `upsert_dns_cname` (the CNAME may already exist from
   the previous architecture — works fine as long as it points at the
   same tunnel; if it doesn't, the upsert heals it).
2. Idempotently `ensure_workspace_ingress` (overwrites any legacy
   per-port rules).
3. SSHs to the box and runs `_install_preview_dispatcher_via_ssh`,
   which writes the script + systemd unit + `systemctl enable --now`.
4. Retries `kv_put` if missing.

All four are idempotent and safe to re-run on every click. This is
how we migrated the existing test workspace `3694ef9e-...` without
reprovisioning.

### Terminate

1. `cloudflare.kv_delete(serverId)` — Worker 404s bookmarked previews.
2. `cloudflare.delete_dns_records_for_hostname(workspace_hostname(serverId))`.
3. `cloudflare.delete_tunnel(tunnelId)` — drains connectors then
   deletes. Best-effort; failures log but never block EC2 cleanup.

All three treat missing-config as "skip cleanly, don't raise" because
terminate must always succeed from the user's perspective.

## Failure modes and their user-visible shape

| Upstream failure | Response the user sees | Fix |
|---|---|---|
| KV has no entry for workspaceId | Friendly HTML 404 from Worker ("workspace not found") | Normally self-heals — next preview click re-runs `_ensure_tunnel_for_server` which writes KV |
| CNAME missing (deleted by hand, or provision race) | Worker `fetch` returns 1014 / DNS error → Worker responds 502 | Click preview again — lazy path upserts it. Or `curl .../servers/<id>/discover-services` to force. |
| Ingress rule stale (still pointing at old `pe-port-*` rules) | Tunnel returns 404 or 530 | `_ensure_tunnel_for_server` on next click overwrites. Manual: `cloudflare.ensure_workspace_ingress(tunnelId, serverId)` from a Python REPL against prod. |
| `pe-preview-dispatcher.service` down | Tunnel returns 502 ("connection refused to 127.0.0.1:8844") | `sudo systemctl status pe-preview-dispatcher` on the box. `systemctl restart` fixes transient. If the unit file is missing, the SSH lazy-install path repairs it. |
| `X-Preview-Port` missing / invalid from the Worker | Dispatcher returns 400 with a hint | Bug in the Worker — `wrangler tail` will show it. |
| Dev server itself down | Dispatcher returns 502 with `upstream connection refused` | User starts the dev server. Our code can't help. |
| `cloudflared` down | Worker fetch gets 530 or a Cloudflare-branded "origin unreachable" page | Reconciliation in `lifecycle.py` catches this; user can also `sudo systemctl restart cloudflared`. |

## Operational notes

### Required env / config

| Name | Where | Purpose |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | backend Lambda env | Must have `Cloudflare Tunnel: Edit` + `Workers KV Storage: Edit` + `Zone: DNS: Edit` (for the preview zone) + `Account: Read`. |
| `CLOUDFLARE_ACCOUNT_ID` | backend Lambda env | Fixed per account. |
| `CLOUDFLARE_ZONE_ID` | backend Lambda env | Zone id of `pocketeng.co`. Re-added in this iteration — it was removed in the previous Worker-only design. |
| `CLOUDFLARE_PREVIEW_DOMAIN` | backend Lambda env | `pocketeng.co`. Used to build `w-<wsId>.<domain>`. |
| `CLOUDFLARE_KV_NAMESPACE_ID` | backend Lambda env | For branded 404s. |
| `PREVIEW_DOMAIN` | Worker `wrangler.toml` `[vars]` | Same `pocketeng.co` — Worker uses it to build the workspace host. |

### Deploying

- Backend (SAM): `cd backend && sam build && sam deploy --config-file samconfig.test.toml` (prod profile, us-west-1). Injects the four CF vars above.
- Worker: `cd cloudflare-worker/preview-proxy && wrangler deploy` (test) / `wrangler deploy --env prod` (prod).
- `wrangler tail` for live Worker logs. For dispatcher logs: `journalctl -u pe-preview-dispatcher -n 100`.

### Verifying a workspace end-to-end

```bash
WS=<uuid>

# 1. KV
curl "https://api.cloudflare.com/client/v4/accounts/$CF_ACC/storage/kv/namespaces/$KV_NS/values/$WS" \
  -H "Authorization: Bearer $CF_TOKEN"   # → should be the tunnelId

# 2. CNAME
dig +short w-$WS.pocketeng.co CNAME     # → should be <tunnelId>.cfargotunnel.com

# 3. Ingress
curl "https://api.cloudflare.com/client/v4/accounts/$CF_ACC/cfd_tunnel/$TUN/configurations" \
  -H "Authorization: Bearer $CF_TOKEN" | jq '.result.config.ingress'
# → should have exactly one non-catchall rule:
#   {"hostname": "w-$WS.pocketeng.co", "service": "http://127.0.0.1:8844"}

# 4. Dispatcher on the box
sudo systemctl status pe-preview-dispatcher   # → active (running)
curl -fsS -H "X-Preview-Port: 22" http://127.0.0.1:8844/   # → 502 (SSH doesn't speak HTTP) means dispatcher is alive

# 5. End-to-end from public internet
curl -sS -o /dev/null -w '%{http_code}\n' https://preview.pocketeng.co/$WS-<port>/
```

### Smoke recorded on PR #127 (P1 + P2, 2026-04-30)

Deploy: `sam deploy` → `pocketeng-backend-test` (us-west-1) UPDATE_COMPLETE;
`wrangler deploy` → version `e1bcd42c-bd20-49ae-9298-58ab0edbc09a`.
Workspace `c9a789b2-ff9b-4267-8cf8-d5139a3e74c5`, dev server port 5000.

Port-range gate at the Worker edge:
| URL | Result |
|---|---|
| `.../<ws>-22/` | `HTTP 400 preview-proxy: port 22 is not in the allowed dev-server range (3000-9000, excluding 8844)` |
| `.../<ws>-8844/` | `HTTP 400` with same message (self-loop block) |
| `.../<ws>-5000/` | `HTTP 200 <h1>hello from pocketeng preview (option B cold boot)</h1>` |

Heal-flag on three consecutive `discover-services` calls (same JWT):
| Call | `previewHealed` | Client total | Lambda body | Notes |
|------|-----------------|--------------|-------------|-------|
| before | *(unset)* | — | — | fresh state |
| 1 | flipped to `true` | 5.92s | 4025.59 ms (Init 1094.68 ms) | slow / heal path |
| 2 | `true` | 0.80s | 325.83 ms (warm) | short-circuit |
| 3 | `true` | 0.80s | 312.79 ms (warm) | short-circuit |

Lambda-body speedup: **12.4x** (4025ms → 325ms). End-to-end: **7.4x**
(5.92s → 0.80s). Zero `_discover_services: ... retry failed` log lines in
the same window — heal completed cleanly on call 1. Port 8844 is not
surfaced in the services list.

## What we explicitly did NOT do

- **We did NOT drop the Worker.** The Worker is still needed for
  (a) the clean `/<wsId>-<port>/` path URL (the per-workspace CNAME
  only resolves the host, not the path-to-port mapping), and (b)
  branded 404s for terminated workspaces (KV lookup).
- **We did NOT make the dispatcher listen on anything but loopback.**
  See invariant #5.
- **We did NOT sign or authenticate the preview URL itself.** Anyone
  who knows a workspace UUID can hit `preview.pocketeng.co/<wsId>-<N>/`
  and reach the allowed-range loopback ports on that workspace. The
  current mitigations are defense-in-depth only, not authorization:
  - **Port-range gate** (added post-initial-review, Greptile P1 on
    PR #127). Both the Worker and the dispatcher reject anything
    outside `3000-9000` and specifically block the dispatcher's own
    port (`8844`). This stops the obvious SSRF targets (SSH on 22,
    Postgres on 5432, the self-loop at 8844) but does NOT stop
    in-range loopback services (Redis on 6379, Django admin on 8000,
    a local metrics endpoint on 8080). Acceptable because those
    services shouldn't be running on managed workspaces, but the
    guarantee is "hygienic defaults", not "authorization".
  - **Real fix is signed URLs.** The plan: backend mints preview
    URLs with an HMAC over `(wsId, port, userId, exp)`, stored in a
    `wrangler secret` the Worker verifies. Shared links expire in
    e.g. 1h. Then optionally upgrade to a cookie handoff on first
    click so tokens don't stay in URLs (referer / log leaks). Not
    done in this PR — separate change, tracked in PR #127 body.
- **We did NOT gate the heal-path on a persisted flag in the first
  cut.** Greptile P2 on PR #127 pointed out that every preview-panel
  refresh re-ran `kv_put` + CNAME upsert + ingress upsert + dispatcher
  SSH install, adding multi-second latency to every click. The
  `previewHealed: true` flag (set on the DDB server record after a
  full successful heal) short-circuits the hot path. See
  `_ensure_tunnel_for_server` in `backend/src/chat.py` and
  `tests/test_chat_heal_flag.py`.
- **We did NOT delete the legacy per-port CNAMEs from the first
  scar.** They're harmless and free.
- **We did NOT write integration tests for the dispatcher against a
  live tunnel.** The dispatcher is unit-tested in isolation
  (`preview-dispatcher.test.cjs`); the tunnel-dispatcher integration
  is covered by the real-browser E2E in the commit that introduced
  this scar (see `docs/` or the PR).

## Revert plan

If the new path misbehaves:

1. Flip `NEXT_PUBLIC_CLOUDFLARE_PREVIEW_WORKER_URL=""` on the web
   deploy. Frontend falls back to `/api/preview/...` (legacy proxy
   through the backend Lambda).
2. Leave backend + tunnel state untouched. New workspaces keep
   provisioning CNAMEs + ingress + dispatcher — the web deploy is
   the only thing that changes.
3. Debug with `wrangler tail` + `journalctl -u pe-preview-dispatcher`
   + the verify script above.

One-edit rollback is a hard constraint; preserve it.

## See also

- [`2026-04-cloudflare-tunnel-preview-migration.md`](2026-04-cloudflare-tunnel-preview-migration.md) — first scar (per-port CNAMEs)
- [`2026-04-cloudflare-tunnel-worker-preview-proxy.md`](2026-04-cloudflare-tunnel-worker-preview-proxy.md) — second scar (Worker fetching `<tunnelId>.cfargotunnel.com` — this is the one this doc supersedes)
- [`../protocols/testing-protocol.md`](../protocols/testing-protocol.md) — why we test against real tunnels, not mocks
- [`../playbooks/deploy-to-test-stack.md`](../playbooks/deploy-to-test-stack.md) — how to safely redeploy both halves
