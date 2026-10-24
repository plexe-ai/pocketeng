---
type: reference
status: canonical
last_reviewed: 2026-04-28
related:
  - references/architecture-overview.md
  - ../CLAUDE.md
  - ../AGENTS.md
tags: [reference, repo, layout]
---

# Repo Map

**When to read:** when you don't know which folder to start in.
**When to update:** when a top-level folder is added or meaningfully changes scope.

## Summary

One table. Each row points to a folder and its local `CLAUDE.md` (where present). Use this to skip to the right place fast.

---

## Top-level folders

| Path | What it is | Start here |
|---|---|---|
| `pocketeng` | Bash CLI — SSH + tmux + sync daemon | the file itself (single-file bash) |
| `web/` | Next.js 16 dashboard | `web/CLAUDE.md` |
| `ios/` | Capacitor web shell for iOS | `ios/` (Xcode project) |
| `desktop/` | Electron web shell for macOS / Windows | `desktop/` (package.json) |
| `backend/` | AWS SAM Python Lambdas | `backend/CLAUDE.md` |
| `backend/src/lib/bridge/` | Agent bridge (Node.js, SFTP'd to EC2) | `../AGENTS.md` row |
| `mcp-server/` | MCP server (Node.js, stdio) | `mcp-server/` README |
| `skills/` | Built-in agent skills (markdown) | `skills/` directory |
| `docs/` | Feature-level docs (Markdown) | index below |
| `scripts/` | One-off ops scripts | `scripts/` |
| `test/` | Top-level fixtures and manual test assets | `test/` |
| `.harness/` | This knowledge base | [`../README.md`](../README.md) |

---

## `backend/` sub-map

| Path | Purpose |
|---|---|
| `backend/src/chat.py` | Session launch, message persistence, synced-session registration |
| `backend/src/session_events_ingest.py` | Lambda that ingests bridge events incl. `session.remote` |
| `backend/src/lib/bridge/` | Node.js bridge source (`bridge.mjs`, `uploader.mjs`) — SFTP'd to EC2 |
| `backend/src/lib/session_file_parser.py` | Agent-specific `.jsonl` parsing (Claude, Codex, Cursor) |
| `backend/src/lib/transcript.py` | Materializes DDB rows into frontend transcripts |
| `backend/src/lib/script_builder.py` | Builds the agent CLI command (incl. `--codex-resume`) |
| `backend/src/lib/db.py` | DDB wrappers (`put_session`, `put_message`, etc.) |
| `backend/tests/` | Unit + (skipped) integration tests |

---

## `docs/` — existing feature docs

These predate the harness. The harness links to them from feature files rather than duplicating.

| Doc | Topic |
|---|---|
| `docs/session-sync-implementation.md` | Full session-sync implementation writeup |
| `docs/session-sync-integration-protocol.md` | Protocol for adding a new agent to session sync |
| others | see `docs/` directly |

When you update or add a feature doc, link it from the corresponding `.harness/features/<feature>.md`.

---

## How to find code quickly

```bash
# find a class / function
rg -n "def _register_synced_session" backend/

# find every place a constant is used
rg -n "POCKETENG_API_BASE"

# list files in an area
rg --files backend/src/lib
```

Everything in `.harness/` uses `rg` — keep it installed (see [`../playbooks/dev-environment-setup.md`](../playbooks/dev-environment-setup.md)).

---

## See also

- [`architecture-overview.md`](architecture-overview.md)
- [`../../CLAUDE.md`](../../CLAUDE.md)
- [`../../AGENTS.md`](../../AGENTS.md)

## Referenced by

- `README.md`
- `references/architecture-overview.md`
- `playbooks/dev-environment-setup.md`
