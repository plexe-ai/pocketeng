---
type: protocol
status: canonical
last_reviewed: 2026-04-23
related:
  - protocols/development-cycle.md
  - protocols/commit-and-pr-protocol.md
  - references/env-variables.md
  - references/operational-threat-model.md
tags: [protocol, safety, secrets, destructive]
---

# Safety Protocol

**When to read:** before touching anything that writes, deletes, or handles credentials.
**When to update:** when a new class of danger is introduced (human sign-off).

## Summary

- **Never commit secrets.** Never print them.
- **Never deploy to prod** from a dev task. Test stack only, unless explicitly asked.
- **Destructive ops** (DynamoDB deletes, EC2 terminations, force-pushes) require a paired human confirmation or an explicit user instruction.
- **Test against test stacks**, never against shared prod data.
- When in doubt, ask.

For the *why* behind these rules — the four categories of failure we're guarding against (overeager, honest mistake, prompt injection, misaligned) — see [`../references/operational-threat-model.md`](../references/operational-threat-model.md).

---

## Secrets — the hard list

Files that must never be committed:

| File | Why |
|---|---|
| `.env.local`, `.env.*.local` | Real API keys |
| `backend/samconfig.toml` | Deploy secrets via `parameter_overrides` |
| `backend/samconfig.test.toml` | Test stack secrets |
| `.claude/settings.local.json` | OAuth tokens |
| `*.pem` | SSH private keys |
| `ExportOptions.plist` | Apple Team ID |

The `.gitignore` covers most of these — verify, don't assume.

Never:

- Print an env var that looks like a credential in logs or terminal output.
- Paste a credential into a chat, PR description, or comment. Refer to the env variable name instead.
- Hard-code a credential in code, even temporarily. Use [`../references/env-variables.md`](../references/env-variables.md).

---

## Destructive operations

| Operation | Rule |
|---|---|
| `aws dynamodb delete-item` on a user-visible table | Only with explicit user instruction. Prefer marking `status: deleted` over row removal where possible. |
| `aws ec2 terminate-instances` | Only against known test / scratch instances. Verify `envType` before running. |
| `git push --force`, `git push --force-with-lease` | Never to `main`. On feature branches, only with explicit user ask. |
| `rsync --delete` on remote | Never silently. `pocketeng sync` deliberately uses `--update` without `--delete`. |
| `sam deploy` with `--stack-name` pointing at prod | Only with explicit user instruction. |
| `rm -rf` scripts | Scope to a specific temp dir. Never home-dir-rooted. |

If a user asks you to run a destructive op, repeat the exact command back and wait for confirmation.

---

## Prod vs test

- Default stack: **test**. `us-west-1` test backend + local UI.
- Prod stack is touched only when the user explicitly says "prod".
- The CLI defaults matter: check [`../references/env-variables.md`](../references/env-variables.md) for `POCKETENG_API_BASE` and the AWS profile. A stale `~/.pocketeng/servers/*.serverid` can silently point you at prod — clear it at the start of a stack-sensitive task.

---

## Git hygiene

- Never update `git config` (user, email, signing).
- Never skip hooks (`--no-verify`, `--no-gpg-sign`) unless the user explicitly asks.
- Never `git commit --amend` on a pushed commit unless the user explicitly asks.
- Never commit `.env*` or `samconfig*` files. If an IDE auto-stages one, unstage it.

See [`commit-and-pr-protocol.md`](commit-and-pr-protocol.md) for the full commit rules.

---

## Handling API keys passed in chat

If a user pastes a key (e.g. `crsr_…`, `sk_…`, `sk-ant-…`):

1. Use it only in memory / env for the duration of the task.
2. Do not write it to any file, not even a gitignored one, **unless the user explicitly asks**.
3. If the user *does* explicitly ask to save, write only to files listed in [`../references/env-variables.md`](../references/env-variables.md) as gitignored (`web/.env.local`, `backend/samconfig.test.toml`, `.env.test`). Verify with `git check-ignore` and `chmod 600` after writing.
4. When the task ends, do not repeat the key back in chat or logs.

---

## Browser automation safety

Real-browser tests drive real dashboards. Guard rails:

- Never click "delete account", "terminate all", or similar destructive controls while exploring.
- Work on a test account or a clearly labeled test workspace.
- If the UI prompts for a confirmation, read it — do not auto-dismiss.

---

## When in doubt

Ask. The cost of a 30-second clarification is orders of magnitude smaller than a prod incident or a leaked key.

---

## See also

- [`development-cycle.md`](development-cycle.md)
- [`commit-and-pr-protocol.md`](commit-and-pr-protocol.md)
- [`../references/env-variables.md`](../references/env-variables.md) — where every secret lives

## Referenced by

- `README.md`
- `protocols/development-cycle.md`
- `protocols/commit-and-pr-protocol.md`
- `references/env-variables.md`
