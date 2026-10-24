# PocketEngineer preview proxy (Cloudflare Worker)

Universal reverse proxy that fronts every managed-workspace dev-server
preview behind a single stable hostname (`preview.pocketeng.co`).
Replaces the per-port-CNAME scheme that suffered from the 30-minute
DNS NXDOMAIN race documented in
[`../../.harness/learnings/2026-04-cloudflare-tunnel-preview-migration.md`](../../.harness/learnings/2026-04-cloudflare-tunnel-preview-migration.md).

## URL shape

```
https://preview.pocketeng.co/<workspaceId>-<port>/<rest-of-path>?query
```

The Worker parses the first path segment, looks up the workspace's
tunnel id in KV, and proxies the request to
`https://<tunnelId>.cfargotunnel.com/<rest>` with `Host: pe-port-<port>`
so `cloudflared`'s ingress config on the EC2 host routes the request
to `http://localhost:<port>`.

## One-time setup

1. **Install Wrangler** (once per dev machine):

   ```bash
   npm install -g wrangler
   wrangler login
   ```

2. **Create the KV namespace** (once for your account — we run a single
   `TUNNEL_MAP` namespace, no test/prod split):

   ```bash
   wrangler kv:namespace create TUNNEL_MAP --preview=false
   ```

   Copy the returned `id` into `wrangler.toml` (`kv_namespaces[0].id`).
   The same id must go into the backend's `CloudflareKvNamespaceId`
   SAM parameter — backend writes, Worker reads, they must match.

3. **Add a DNS record** for the Worker hostname. Any type works — the
   proxy-orange cloud is what routes traffic to the Worker, not the
   underlying IP. Convention: AAAA to `100::` (RFC 6666 discard prefix,
   won't resolve to anything real even if the proxy flag got turned
   off). Must be **proxied** (orange cloud on).

   ```bash
   curl "https://api.cloudflare.com/client/v4/zones/$CF_ZONE/dns_records" \
     --header "Authorization: Bearer $CF_TOKEN" \
     --json '{
       "type": "AAAA",
       "name": "preview",
       "content": "100::",
       "proxied": true,
       "ttl": 1
     }'
   ```

4. **Deploy the Worker**:

   ```bash
   wrangler deploy
   ```

5. **Configure the backend** — set the following env vars on
   `ProvisionFunction`, `ActionFunction`, `ChatFunction`:

   | Var | Value |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | as before (needs Workers KV: Edit) |
   | `CLOUDFLARE_ACCOUNT_ID` | as before |
   | `CLOUDFLARE_KV_NAMESPACE_ID` | the namespace id from step 2 |
   | `CLOUDFLARE_PREVIEW_WORKER_URL` | `https://preview.pocketeng.co` |

   `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_PREVIEW_DOMAIN` are no longer
   used by the preview path and can be dropped (they're still fine to
   leave set; the code ignores them).

6. **Configure the frontend** — `web/.env.local`:

   ```
   NEXT_PUBLIC_CLOUDFLARE_PREVIEW_WORKER_URL=https://preview.pocketeng.co
   ```

## API-token permissions (updated)

The existing `CLOUDFLARE_API_TOKEN` needs **one extra scope** for this
migration:

- `Cloudflare Tunnel:Edit` — keep (tunnel create/delete)
- `DNS:Edit` — **not required anymore** for the preview path, but keep
  it scoped to `preview.pocketeng.co` if you want the backend to be
  able to provision the hostname record itself.
- `Workers KV Storage:Edit` — **NEW**. Needed for `kv_put` /
  `kv_delete`.
- `Account:Read` — keep.

If you rotate the token, rotate everywhere it's referenced (backend
SAM parameter overrides, `.env.test`).

## Local development

```bash
cd cloudflare-worker/preview-proxy
wrangler dev
# in another shell:
wrangler kv:key put --local --binding=TUNNEL_MAP <some-workspace-uuid> <some-tunnel-uuid>
curl http://localhost:8787/<some-workspace-uuid>-5000/
```

`wrangler dev` starts a local Miniflare instance. It can't reach
`<tunnelId>.cfargotunnel.com` from your laptop (that hostname only
routes from inside Cloudflare's network), so the `fetch()` call will
fail locally — but the path parsing and KV lookup work fine and the
error surface is exercised. Real integration testing happens against
the deployed test stack.

## Deleting a deploy

```bash
wrangler delete
```

This does NOT delete the KV namespace or the DNS record — do those
via dashboard or CLI separately if you really want a clean wipe.
