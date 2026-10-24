---
type: playbook
status: canonical
last_reviewed: 2026-04-23
related:
  - playbooks/dev-environment-setup.sh
  - playbooks/browser-testing.md
  - playbooks/deploy-to-test-stack.md
  - references/env-variables.md
  - references/repo-map.md
tags: [playbook, setup, env]
---

# Dev Environment Setup

**When to read:** first time on a new machine, or when setup drifts.
**When to update:** when a required tool or version changes.

## Summary

Bring a laptop from "fresh clone" to "can run unit + integration + browser tests" with one script plus a handful of manual steps. The script is idempotent — re-run it any time.

---

## Prereqs (manual, one-time)

| Tool | Why | Install |
|---|---|---|
| AWS CLI v2 + configured profiles | Deploys, DDB inspection | `brew install awscli` + `aws configure --profile <name>` |
| AWS SAM CLI | Backend deploys | `brew install aws-sam-cli` |
| Node.js 20+ | Web dashboard, bridge | `brew install node` |
| Python 3.12 | Backend, tests | `brew install python@3.12` |
| `jq` | JSON inspection | `brew install jq` |
| `ripgrep` (`rg`) | Searching the repo | `brew install ripgrep` |
| `gh` | GitHub CLI for PRs | `brew install gh && gh auth login` |

Everything else is installed by the script.

---

## Run the script

```bash
cd /path/to/pocketeng
bash .harness/playbooks/dev-environment-setup.sh
```

The script:

1. Installs backend Python deps (`backend/requirements.txt` + `boto3` into `~/.local`).
2. Installs web deps (`cd web && npm install`).
3. Installs the bridge runtime deps (only needed for local integration tests — `npm install @openai/codex-sdk` in `~/.pocketeng/bridge/`).
4. Copies the bridge `.mjs` files from `backend/src/lib/bridge/` to `~/.pocketeng/bridge/` if missing.
5. Prints a summary of what it did and what still needs manual attention.

Re-run it safely. If a step's prereq isn't met, it prints a clear message and exits.

---

## Env files

See [`../references/env-variables.md`](../references/env-variables.md) for the full map.

Copy examples to real files:

```bash
cp web/.env.example web/.env.local
# edit values — Supabase, API base, etc.

cp backend/samconfig.toml.example backend/samconfig.toml
# edit values — stage, region, parameter overrides
```

These are gitignored. Do not commit.

---

## Verify

```bash
# Unit
cd backend && python3 -m pytest tests -q --ignore=tests/agents/test_integration.py

# Web builds / typechecks
cd web && npm run build

# Bridge tests (no SDK needed)
cd backend/src/lib/bridge && node --test
```

If any of these fail for reasons not obviously related to missing secrets, something is off — open the relevant component's `CLAUDE.md` (`backend/CLAUDE.md`, `web/CLAUDE.md`) or an applicable `learnings/` file.

---

## Agent CLIs (for integration tests)

Install only if you intend to run `tests/agents/test_integration.py`:

| CLI | Install |
|---|---|
| `claude` (Claude Code) | Follow the official Claude Code docs |
| `codex` | Follow the Codex SDK docs |
| `cursor-agent` | Follow the Cursor agent docs |

Each needs an API key — see `../references/env-variables.md`.

---

## Playwright (for browser testing)

Not needed unless you'll run the browser harness. When you're ready, [`browser-testing.md`](browser-testing.md) installs Playwright + Chromium for you (one command, ~60s). It lands in `~/.pocketeng/browser-harness/` so every repo on your machine reuses it.

---

## See also

- [`dev-environment-setup.sh`](dev-environment-setup.sh) — the script this playbook runs
- [`../references/env-variables.md`](../references/env-variables.md) — every env var and where it lives
- [`../references/repo-map.md`](../references/repo-map.md) — what each folder does

## Referenced by

- `README.md`
- `playbooks/browser-testing.md`
- `playbooks/deploy-to-test-stack.md`
