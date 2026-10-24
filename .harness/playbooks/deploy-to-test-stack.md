---
type: playbook
status: canonical
last_reviewed: 2026-04-23
related:
  - playbooks/deploy-to-test-stack.sh
  - protocols/testing-protocol.md
  - protocols/safety-protocol.md
  - references/env-variables.md
  - references/aws-debugging.md
tags: [playbook, deploy, sam, aws]
---

# Deploy to Test Stack

**When to read:** before running any integration test or real-browser pass.
**When to update:** when the SAM layout, region, or stack name changes.

## Summary

Deploy the backend to our only non-prod stack: **`pocketeng-backend-test`** in **`us-west-1`**, using `backend/samconfig.test.toml`. The local UI (`web/.env.local`) and the `pocketeng` CLI (`POCKETENG_API_BASE`) point at that stack's API Gateway URL.

**Never deploy to a prod stack.** If a true-prod stack ever exists, it gets its own playbook, its own profile, and an explicit human ask. The scripts here refuse anything that smells like prod.

---

## Critical facts about the current setup

| Thing | Value |
|---|---|
| SAM stack name | `pocketeng-backend-test` |
| Region | `us-west-1` |
| Config file | `backend/samconfig.test.toml` |
| AWS profile on the repo-owner's machine | `prod` (local profile name — **not** a prod environment) |
| API Gateway stage path | `/prod` — literal, comes from the `Stage` parameter defaulting to `prod` |
| DynamoDB tables | `pe-sessions-prod`, `pe-messages-prod`, `pe-servers-prod`, `pe-session-events-prod`, `pe-push-devices-prod` |

**Yes, the tables end in `-prod` on the test stack.** This is a historical quirk of the `Stage` parameter default. It's still the test stack. When you debug via `aws dynamodb`, look at `pe-*-prod` — not `pe-*-test`.

---

## Prereqs

| Thing | Source |
|---|---|
| AWS CLI v2 configured | See [`../references/aws-debugging.md`](../references/aws-debugging.md) |
| AWS SAM CLI installed | `brew install aws-sam-cli` |
| `backend/samconfig.test.toml` present | Ask the repo owner if missing — gitignored |
| Shell sourced from `.env.test` | `set -a; source .env.test; set +a` (sets `AWS_PROFILE`, `AWS_REGION`) |

---

## Run the script

```bash
bash .harness/playbooks/deploy-to-test-stack.sh
```

What it does, in order:

1. Checks `AWS_PROFILE` is set.
2. Parses `samconfig.test.toml`; refuses if `stack_name` contains `prod`/`production` **as a whole segment** (but allows the literal `Stage=prod` override because that's our current quirk).
3. Verifies the region in the config is **`us-west-1`** — refuses otherwise.
4. `aws sts get-caller-identity` sanity print.
5. `sam build` from `backend/`.
6. `sam deploy --config-file samconfig.test.toml --no-confirm-changeset`.
7. Reads the `ApiUrl` output from CloudFormation and reminds you to sync `web/.env.local` and `POCKETENG_API_BASE`.

Idempotent and safe to re-run.

---

## Wire the UI at the test stack

Update `web/.env.local`:

```
NEXT_PUBLIC_API_BASE_URL=<ApiUrl from deploy output>
```

Then restart the dev server (`cd web && npm run dev`) — Next.js picks up env changes on restart, not hot-reload.

And for the `pocketeng` CLI:

```bash
export POCKETENG_API_BASE=<ApiUrl>
rm -f ~/.pocketeng/servers/*.serverid   # clear stale caches that might still hit the old URL
```

This cache-clear step has bitten every major test session we've run. Make it muscle memory.

---

## Verify the stack is alive

```bash
aws cloudformation describe-stacks --stack-name pocketeng-backend-test \
  --query 'Stacks[0].[StackStatus, Outputs[?OutputKey==`ApiUrl`].OutputValue | [0]]'

aws dynamodb list-tables | grep pe-
```

You should see `UPDATE_COMPLETE` (or `CREATE_COMPLETE`) and the `pe-*-prod` tables. If the API URL differs from what's in `web/.env.local`, update.

More probes: [`../references/aws-debugging.md`](../references/aws-debugging.md).

---

## Rolling back

If a deploy breaks the test stack:

```bash
cd backend
sam deploy --config-file samconfig.test.toml --no-confirm-changeset \
  --template-file <previous good template or commit>
```

Or, if the stack is wedged and it's *only* the test stack:

```bash
aws cloudformation delete-stack --stack-name pocketeng-backend-test
aws cloudformation wait stack-delete-complete --stack-name pocketeng-backend-test
```

Never do this to a prod stack. See [`../protocols/safety-protocol.md`](../protocols/safety-protocol.md).

---

## If you ever see a *real* prod stack

We'll know because it will:

- Live in a separate CloudFormation stack name (e.g. `pocketeng-backend-prod`),
- Use a different AWS profile (not the same `prod`-named local profile that reaches test),
- Have `Stage=prod` **and** a different account ID from the test stack's.

If you find yourself about to deploy to one of those — stop. Surface it to the user and ask. See [`../protocols/no-bypass.md`](../protocols/no-bypass.md).

---

## See also

- [`deploy-to-test-stack.sh`](deploy-to-test-stack.sh)
- [`../protocols/testing-protocol.md`](../protocols/testing-protocol.md)
- [`../protocols/safety-protocol.md`](../protocols/safety-protocol.md)
- [`../references/env-variables.md`](../references/env-variables.md)
- [`../references/aws-debugging.md`](../references/aws-debugging.md)

## Referenced by

- `README.md`
- `protocols/testing-protocol.md`
- `playbooks/browser-testing.md`
- `playbooks/dev-environment-setup.md`
- `references/aws-debugging.md`
