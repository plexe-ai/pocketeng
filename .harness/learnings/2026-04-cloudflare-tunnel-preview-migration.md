---
type: learning
status: deprecated
last_reviewed: 2026-04-30
supersededBy: 2026-04-cloudflare-tunnel-worker-preview-proxy.md
related:
  - protocols/testing-protocol.md
  - references/env-variables.md
  - playbooks/deploy-to-test-stack.md
  - learnings/2026-04-cloudflare-tunnel-worker-preview-proxy.md
tags: [learning, cloudflare, tunnel, preview, migration, ssh, userdata, superseded]
---

> **SUPERSEDED.** This document describes the *per-port CNAME* approach
> (one DNS record minted per `(workspace, port)`). It shipped briefly
> in a previous PR and was replaced two days later by the
> **Cloudflare Worker + KV** design in
> [`2026-04-cloudflare-tunnel-worker-preview-proxy.md`](2026-04-cloudflare-tunnel-worker-preview-proxy.md).
>
> Why: the per-port CNAME path suffered a 30-minute NXDOMAIN race
> (resolvers that queried the hostname seconds before we created it
> cached the miss for the zone's SOA `min_ttl` — 1800s on Free / Pro /
> Business plans, only tunable on Enterprise). First-preview-per-port
> silently failed for those users.
>
> Keep reading **only** if you're digging up history on that old
> approach. Every code reference below (`upsert_dns_cname`,
> `preview_hostname`, `CLOUDFLARE_PREVIEW_DOMAIN`, etc.) was removed
> when the Worker shipped.

# Cloudflare Tunnel Preview Migration — Verified End-to-End (2026-04) *(superseded)*

**When to read:** before touching `backend/src/lib/cloudflare.py`,
`_discover_services` in `backend/src/chat.py`, `provision.py`'s tunnel
bootstrap, `userdata.py`'s `_cloudflared_block`, or the frontend
`buildPreviewUrl` / `isCloudflareManaged` helpers.

**When to update:** only to add cross-links as new related scars appear,
or if we swap the Cloudflare primitive (e.g. off Named Tunnels + Public
Hostnames). Do not rewrite the story.

---

## One-line

Managed workspaces (`envType: "general"`) stopped exposing dev ports
3000–9000 on the EC2 security group and started receiving public traffic
through a per-workspace Cloudflare Named Tunnel; preview URLs are
`https://<serverId>-<port>.pocketeng.co` instead of the `/api/preview`
reverse proxy. BYOS stays on the legacy proxy.

---

## The four moving parts

1. **Named Tunnel** per workspace (Cloudflare API v4). Created either at
   provision time (`provision.py`) or lazy-created on first
   `discover-services` for pre-migration workspaces. Tunnel id is
   stored in DDB as `server.tunnelId`.
2. **`cloudflared` on EC2.** Installed + registered as a systemd service
   (`cloudflared.service`, enabled + active). On new workspaces this
   happens in `userdata.py::_cloudflared_block` during first boot. On
   pre-migration workspaces it's SFTP/SSH-installed on demand by
   `_install_cloudflared_via_ssh` inside `chat.py`.
3. **Public Hostname (ingress) + DNS CNAME** registered lazily on
   every `discover-services` call — one pair per `(serverId, port)`.
   Cloudflare is the source of truth for both; we re-upsert idempotently.
4. **Frontend routing.** `web/lib/preview.ts::buildPreviewUrl` uses
   `isCloudflareManaged(envType)` to decide between the Cloudflare URL
   and the legacy `/api/preview` proxy; BYOS still goes through the
   proxy + preview cookie.

## Evidence (2026-04-29 production test stack `pocketeng-backend-test`, us-west-1)

Running `_discover_services` against a real pre-migration managed
workspace (`7be455ae-079d-4d81-b51f-f727085e2665`) with port 3000
listening produced:

```text
[probe]   tunnelId: None           # pre-call
... (tunnel created, cloudflared installed via SSH) ...
response.body = {"services": [{"port": 3000, "process": "python3",
  "url": "https://7be455ae-079d-4d81-b51f-f727085e2665-3000.pocketeng.co"}]}
[probe] POST tunnelId in DDB: b5bd9ef7-d163-4aeb-9c43-bf6b63fad354
```

On the EC2:

```text
cloudflared version 2026.3.0
systemctl is-active cloudflared    → active
systemctl is-enabled cloudflared   → enabled
journal: Registered tunnel connection connIndex=0..3 protocol=quic
journal: Updated to new configuration {"ingress":[{"hostname":
  "7be455ae-...-3000.pocketeng.co","service":"http://localhost:3000"},
  {"service":"http_status:404"}],"warp-routing":{"enabled":false}}
```

`curl https://7be455ae-079d-4d81-b51f-f727085e2665-3000.pocketeng.co/`
returned HTTP 200 with the served HTML. DNS resolved to Cloudflare edge
IPs (`104.21.85.78`, `172.67.203.215`).

## Known unresolved: first-preview DNS negative-cache race

On the first time any `<serverId>-<port>.pocketeng.co` is queried, the
user's resolver (especially consumer-grade routers that forward to the
ISP) can fetch authoritative just before we write the CNAME, get
`NXDOMAIN`, and cache it for the zone's **SOA minimum TTL — currently
1800s (30 minutes)** on `pocketeng.co`. Subsequent lookups keep returning
the stale `NXDOMAIN` until that TTL expires, and the user sees
`DNS_PROBE_FINISHED_NXDOMAIN` in the browser while Cloudflare
authoritative already serves the record correctly. Reproduced 2026-04-29
with `3694ef9e-...-5000.pocketeng.co` (authoritative + `1.1.1.1` + `8.8.8.8`
all resolved fine; the dev laptop's router returned `NXDOMAIN`).

**Correct fix is a plan change, not a code change.** Attempted via the
Cloudflare API:

```text
PATCH /zones/{id}/dns_settings  {"soa":{"min_ttl":60,"ttl":300}}
→ 1003: Custom SOA records are not available to this account or zone.
```

Custom SOA is a Pro-tier feature. Recommended resolution (in order):

1. **Upgrade `pocketeng.co` to the Cloudflare Pro plan** (~$20/month).
   Then PATCH `min_ttl` to ~60s so any NXDOMAIN cache tops out at a
   minute. No code change, no per-request latency, one-time op.
2. **Interim mitigation for users who hit it before (1) lands:** switch
   the browser's Secure DNS to Cloudflare / Google, set `1.1.1.1` or
   `8.8.8.8` on the laptop, or wait 30 minutes. These are support-desk
   answers, not a fix.

### Fixes we considered and rejected (or deferred)

- **DoH warming inside `_discover_services`** (poll `1.1.1.1` after
  `upsert_dns_cname`, wait until authoritative sees the name). Closes a
  sub-second write-side window but does **not** un-poison a resolver
  that already cached NXDOMAIN. Doesn't fix the user-observed bug; adds
  0.5–2s to every first-preview click. Not worth the latency tax.
- **Wildcard DNS per workspace** (`*.<serverId>.pocketeng.co` pre-created
  at provision time, URL format flips to `<port>.<serverId>.pocketeng.co`).
  Clean engineering but it's a URL-format + provisioning-flow change
  larger than a bug fix, and still has one race on the wildcard itself.
  Deferred — revisit if the Pro upgrade isn't possible.

## Gotchas worth remembering

- **The Cloudflare API token needs both `Tunnel:Edit` and `DNS:Edit` on
  the preview zone.** A `Tunnel:Edit`-only token will happily create
  tunnels but fail silently-ish when `upsert_dns_cname` tries to write
  the CNAME, and Preview URLs will never resolve. Keep `DNS:Edit` on
  the exact zone, not "All zones" — tightest scope that still works.
- **`envType` is the single source of truth for frontend URL choice.**
  `isCloudflareManaged(envType)` returns true for `"general"`; BYOS
  (`"byos"`) and anything else falls back to `/api/preview`. Don't
  special-case on `tunnelId` on the frontend — by the time the URL is
  built, the backend has guaranteed the tunnel if it's going to exist.
- **`_discover_services` upserts ingress + DNS on every call.** This is
  intentional — it's the recovery path if Cloudflare state drifts from
  DDB. The ops cost is two Cloudflare API calls per discover; worth it.
- **Pre-migration SGs stay permissive.** `create_security_group()` was
  tightened to port 22 only, but existing SGs are not rewritten. If a
  workspace predates the migration, port 3000 is still reachable over
  the public internet via its EC2 IP — document it, don't clean it up
  in this change.
- **The `tunnelId` in DDB is the cleanup handle.** `action.py` deletes
  the tunnel + DNS records best-effort on terminate. Losing the id
  orphans Cloudflare resources; they're cheap but they leak.
- **Named Tunnels prefer QUIC.** `cloudflared` registered 4 connIndex
  connections over QUIC in sjc* — if a workspace's outbound UDP is
  blocked, expect connection churn. We haven't hit this yet; note it
  if we do.

## Related files

- `backend/src/lib/cloudflare.py` — API wrapper (stdlib `urllib`).
- `backend/src/lib/userdata.py::_cloudflared_block` — new-workspace
  install.
- `backend/src/chat.py::_discover_services`,
  `_ensure_tunnel_for_server`, `_install_cloudflared_via_ssh`,
  `_preview_url_for_port` — lazy-create + URL composition.
- `backend/src/provision.py` — create tunnel before `build_userdata`.
- `backend/src/action.py` — terminate-time cleanup.
- `backend/template.yaml` — `CloudflareApiToken` etc. parameters.
- `web/lib/preview.ts`, `web/components/PreviewPanel.tsx`,
  `web/components/ChatWindow.tsx` — frontend URL choice.
- `.harness/references/env-variables.md` — `CLOUDFLARE_*` vars
  and `NEXT_PUBLIC_CLOUDFLARE_PREVIEW_DOMAIN`.
