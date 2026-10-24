---
type: reference
status: canonical
last_reviewed: 2026-04-30
related:
  - protocols/safety-protocol.md
  - playbooks/dev-environment-setup.md
  - playbooks/deploy-to-test-stack.md
  - playbooks/browser-testing.md
  - references/aws-debugging.md
  - learnings/2026-04-cloudflare-tunnel-preview-dispatcher.md
tags: [reference, env, secrets]
---

# Env Variables

**When to read:** when you need to know where a credential or config lives.
**When to update:** when a new env var is added, renamed, or retired.

## Summary

Single map of every env var / secret we touch: which file carries it, which component reads it, and whether it has a safe example counterpart. Playbooks and code link here — this is the only place they get enumerated.

---

## The three secret files (all gitignored)

| File | Scope | What's in it |
|---|---|---|
| `web/.env.local` | Next.js dashboard runtime | Supabase + backend API URL |
| `backend/samconfig.test.toml` | `sam deploy` to the test stack | Stack name + `parameter_overrides` (Supabase JWT, Slack, Linq, …) |
| `.env.test` (repo root, sourceable) | Shell sessions for tests + agents | Agent API keys, `PE_TEST_EMAIL/PASSWORD`, `AWS_PROFILE`, `POCKETENG_API_BASE` |

To load `.env.test` for a shell session:

```bash
set -a; source .env.test; set +a
```

All three are listed in `.gitignore` and `backend/.gitignore`. Verify, don't assume.

---

## Web dashboard — `web/.env.local`

| Var | Purpose | Example |
|---|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | Backend API Gateway URL. Currently `https://<api-id>.execute-api.<region>.amazonaws.com/prod` (the test stack's URL — API-Gateway stage path is literally `prod` despite being our test environment). | `https://<api-id>.execute-api.us-west-1.amazonaws.com/prod` |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL | `https://<proj>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key | `sb_publishable_…` |
| `NEXT_PUBLIC_CLOUDFLARE_PREVIEW_WORKER_URL` | Public base URL of the deployed `pe-preview-proxy` Cloudflare Worker. Managed-workspace previews load from `{worker-url}/{serverId}-{port}/`. Must match backend `CLOUDFLARE_PREVIEW_WORKER_URL`. Empty → legacy `/api/preview` proxy for all workspaces. | `https://preview.pocketeng.co` |

Template: `web/.env.example`. The **critical switch** — if a separate true-prod stack ever exists, `NEXT_PUBLIC_API_BASE_URL` must point at the **test** stack during dev and E2E. Never at the real prod. Today that risk is theoretical because only one stack exists, but name it out loud so no one forgets.

Restart the Next.js dev server after editing this file — it only reads env on startup.

---

## Backend — `backend/samconfig.test.toml`

The `parameter_overrides` line carries every backend secret. Current stack:

| Field | Value |
|---|---|
| `stack_name` | `pocketeng-backend-test` |
| `profile` | `prod` (the local AWS CLI profile name — see note below) |
| `region` | `us-west-1` |

Inside `parameter_overrides`:

| Override | Purpose |
|---|---|
| `SupabaseUrl`, `SupabaseJwtSecret` | JWT verification |
| `CompletionCallbackSecret` | Completion hook HMAC |
| `SlackSigningSecret` | Slack integration |
| `LinqApiKey`, `LinqFromNumber`, `LinqSigningSecret` | Linq (SMS) integration |
| `CloudflareApiToken` | Scoped API token. **Required scopes:** Cloudflare Tunnel: Edit, Zone: DNS: Edit (for the preview zone), Workers KV Storage: Edit, Account: Read. Exposed to ProvisionFunction / ActionFunction / ChatFunction as `CLOUDFLARE_API_TOKEN`. Empty disables the preview tunnel feature — provision skips tunnel creation and preview URLs fall back to `/api/preview`. |
| `CloudflareAccountId` | Cloudflare account that owns the tunnels and the KV namespace. |
| `CloudflareZoneId` | Zone id for the preview domain (e.g. the zone that owns `pocketeng.co`). Used to create the per-workspace CNAME `w-<wsId>.<preview-domain>` → `<tunnelId>.cfargotunnel.com` at provision time. |
| `CloudflarePreviewDomain` | Apex zone for per-workspace CNAMEs, e.g. `pocketeng.co`. Must match the domain whose id is in `CloudflareZoneId`. Combined with `w-<wsId>.` to form the workspace public hostname. |
| `CloudflareKvNamespaceId` | Workers-KV namespace id that stores the `workspaceId → tunnelId` map. Backend writes into it on provision / terminate; the `pe-preview-proxy` Worker reads from it on every request for liveness / branded 404s. Create with `wrangler kv:namespace create TUNNEL_MAP` from `cloudflare-worker/preview-proxy/`. |
| `CloudflarePreviewWorkerUrl` | Public base URL of the deployed preview Worker — e.g. `https://preview.pocketeng.co`. Combined with `{serverId}-{port}/` to form every managed preview URL. Must match `NEXT_PUBLIC_CLOUDFLARE_PREVIEW_WORKER_URL` on the frontend. |

Template: `backend/samconfig.toml.example`.

### Cloudflare preview proxy

The `CloudflareApiToken` must stay in `backend/samconfig.test.toml` (gitignored). A leaked copy at repo-root `./token` was removed in a prior migration commit — if you ever see a file at `/token` again, delete it and rotate the token at dash.cloudflare.com/profile/api-tokens. The same token goes into `.env.test` for shell sessions that want to exercise the tunnel / DNS / KV API directly (e.g. a cleanup script iterating every tunnel or CNAME on the account). **Rotation note:** all four scopes above are required together. A token missing `Zone: DNS: Edit` will provision fresh workspaces that fail silently at the CNAME step (logged but swallowed); missing `Workers KV Storage: Edit` breaks branded 404s; missing `Cloudflare Tunnel: Edit` breaks everything. See [`../learnings/2026-04-cloudflare-tunnel-preview-dispatcher.md`](../learnings/2026-04-cloudflare-tunnel-preview-dispatcher.md) for the full architecture.

**Naming gotcha:** the stack is called `pocketeng-backend-test`, the region is `us-west-1`, but the SAM `Stage` parameter defaults to `prod`, so DDB tables are `pe-*-prod` (not `pe-*-test`). Don't be misled by table names when debugging — this is still the test stack.

---

## Shell — `.env.test` (repo root, sourceable)

| Var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude Code CLI + integration tests |
| `OPENAI_API_KEY` | Codex CLI + SDK |
| `CURSOR_API_KEY` | `cursor-agent` CLI |
| `PE_TEST_EMAIL` | Browser E2E login — real Supabase test user |
| `PE_TEST_PASSWORD` | ↑ |
| `AWS_PROFILE` | The local AWS CLI profile to use (currently `prod` on this machine — see warning below) |
| `AWS_REGION` | `us-west-1` for every dev / deploy / debug call |
| `POCKETENG_API_BASE` | Backend URL for the `pocketeng` CLI — mirrors `NEXT_PUBLIC_API_BASE_URL` |
| `CLOUDFLARE_API_TOKEN` | Scoped CF token (Cloudflare Tunnel: Edit + Zone: DNS: Edit + Workers KV Storage: Edit + Account: Read). Used by any local script that calls the CF API directly. |
| `CLOUDFLARE_ACCOUNT_ID` | CF account holding the tunnels + KV namespace. |
| `CLOUDFLARE_ZONE_ID` | Zone id for the preview domain. Needed for any local script that creates / deletes per-workspace CNAMEs. |
| `CLOUDFLARE_PREVIEW_DOMAIN` | Preview apex — e.g. `pocketeng.co`. Mirrors backend. |
| `CLOUDFLARE_KV_NAMESPACE_ID` | Workspace-to-tunnel KV namespace id. Must match the id pasted into `cloudflare-worker/preview-proxy/wrangler.toml`. |
| `CLOUDFLARE_PREVIEW_WORKER_URL` | Public Worker URL — e.g. `https://preview.pocketeng.co`. Mirrors the backend + frontend config. |

**`AWS_PROFILE=prod` warning:** the value `prod` here is **just the local profile name** in `~/.aws/credentials`. It's not saying you're deploying to prod. Our only deployed stack is `pocketeng-backend-test` in `us-west-1`, and that's what this profile reaches. If you use a different profile name on your machine, edit `.env.test` accordingly.

---

## CLI — shell env + `~/.pocketeng/`

| Var / file | Purpose |
|---|---|
| `POCKETENG_API_BASE` | Override default API endpoint. Set this to the test stack URL before running `pocketeng` against test (sourced from `.env.test` above). |
| `PE_AGENT` | Per-workspace agent (`claude`, `codex`, `cursor`). Usually set in the workspace `.conf` file. |
| `~/.pocketeng/servers/<name>.serverid` | Cache of server IDs. Stale caches silently point at the wrong stack — clear with `rm -f ~/.pocketeng/servers/*.serverid` before a stack-sensitive test. |
| `~/.pocketeng/servers/<name>.conf` | Per-workspace config: remote host, user, PE_AGENT. |
| `~/.pocketeng/bridge/` | Local copy of the agent bridge (Node.js). Required only for local integration tests. |

---

## Agent API keys

| Env var | Required for | Where the agent reads it |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude Code integration tests | `claude` CLI |
| `OPENAI_API_KEY` | Codex integration tests | `codex` CLI + SDK |
| `CURSOR_API_KEY` | Cursor integration tests | `cursor-agent` CLI |

Never paste these in chat or a commit. Source them from `.env.test`.

---

## Browser testing

Used by [`../playbooks/browser-testing.md`](../playbooks/browser-testing.md) and its example script.

| Var | Required? | Purpose |
|---|---|---|
| `PE_TEST_EMAIL` | yes | Test-account email for Supabase login |
| `PE_TEST_PASSWORD` | yes | Test-account password (keep out of chat) |
| `PE_BASE_URL` | no | Override the dashboard URL. Default `http://localhost:3000`. |
| `PE_HEADLESS` | no | Set to `0` to watch the browser run. Default is headless. |

Source from `.env.test` before running the harness.

---

## AWS credentials

We do **not** manage AWS creds through env vars in source. We use `~/.aws/credentials` profiles, and we expect every dev machine to already be `aws configure`'d. See [`aws-debugging.md`](aws-debugging.md) for what that unlocks.

| Var / profile | Purpose |
|---|---|
| `AWS_PROFILE` | Which profile to use. Every deploy / DDB / CloudWatch call in this harness respects it. |
| `AWS_REGION` | `us-west-1` for the current test stack. Hard-code in scripts that talk to the stack. |

Profile convention today:

| Profile | What it reaches |
|---|---|
| `prod` (local profile name on repo-owner's machine) | `pocketeng-backend-test` stack in `us-west-1`. **Not** a true-prod environment. |

When a separate real-prod stack exists, we'll add a second profile row here and the scripts will compare `aws sts get-caller-identity` against the expected account ID before deploying.

---

## Never committed

These files, if present, are gitignored:

- `web/.env.local`, `web/.env.*.local`
- `backend/samconfig.toml`, `backend/samconfig.test.toml`
- `.env`, `.env.test`, `.env.*.local`
- `.claude/settings.local.json`
- `*.pem`
- `ExportOptions.plist`

See [`../protocols/safety-protocol.md`](../protocols/safety-protocol.md) for the rules.

---

## Adding a new env var

1. Add it to the real env file on your machine.
2. If the var is safe to share a template value, add it to the `.example` counterpart.
3. Update this file — row in the right section, one-line purpose.
4. Wire any new playbook that needs it to link here, don't duplicate the description.

---

## See also

- [`../protocols/safety-protocol.md`](../protocols/safety-protocol.md) — how to handle secrets
- [`aws-debugging.md`](aws-debugging.md) — what an AWS-CLI-logged-in dev machine unlocks
- [`../playbooks/dev-environment-setup.md`](../playbooks/dev-environment-setup.md) — where the env files come from
- [`../playbooks/deploy-to-test-stack.md`](../playbooks/deploy-to-test-stack.md) — `AWS_PROFILE`, region, stack

## Referenced by

- `README.md`
- `protocols/safety-protocol.md`
- `playbooks/dev-environment-setup.md`
- `playbooks/deploy-to-test-stack.md`
- `playbooks/browser-testing.md`
- `references/aws-debugging.md`
