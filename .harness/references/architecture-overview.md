---
type: reference
status: canonical
last_reviewed: 2026-04-28
related:
  - references/repo-map.md
  - references/chat-history-loading.md
  - features/session-sync.md
  - ../CLAUDE.md
tags: [reference, architecture]
---

# Architecture Overview

**When to read:** before making any non-trivial change that crosses components.
**When to update:** when a component is added, removed, or its contract changes.

## Summary

PocketEng runs AI coding agents on EC2 and surfaces them through a web dashboard, iOS / desktop shells, and a CLI. The backend is AWS SAM on Lambda + DynamoDB. An agent **bridge** on EC2 normalizes agent output to a common event stream. A **sync daemon** in the CLI mirrors session files bidirectionally so a laptop session and a cloud session are the same session.

This file covers the big picture. Deeper docs live alongside each component — see [`repo-map.md`](repo-map.md).

---

## Components at a glance

```
┌──────────┐   ┌──────────┐   ┌─────────────┐
│  CLI     │   │   Web    │   │ iOS/Desktop │
│(pocketeng│   │(Next 16) │   │ shells      │
└────┬─────┘   └────┬─────┘   └──────┬──────┘
     │              │                │
     │    SSH+tmux  │  HTTPS/REST    │  HTTPS
     │              ▼                ▼
     │       ┌──────────────────────────┐
     │       │   Backend API (SAM)      │
     │       │  Lambda + API Gateway    │
     │       │   DynamoDB + KMS         │
     │       └──────────┬───────────────┘
     │                  │ provisions / calls
     ▼                  ▼
  ┌───────────────────────────────────┐
  │          EC2 workspace            │
  │  tmux panes, agent bridge (Node)  │
  │  claude / codex / cursor CLIs     │
  └───────────────────────────────────┘
```

Detail: [`../CLAUDE.md`](../../CLAUDE.md), [`../AGENTS.md`](../../AGENTS.md).

---

## Key services

| Service | Runtime | Role |
|---|---|---|
| CLI (`pocketeng`) | Bash | SSH + tmux entry, sync daemon |
| Web (`web/`) | Next.js 16 + React 19 | Main UI |
| Backend (`backend/`) | AWS SAM, Python 3.12 Lambdas | API, persistence, chat orchestration |
| Bridge (`backend/src/lib/bridge/`) | Node.js (ESM), SFTP'd to EC2 | Normalizes agent output, emits session events |
| MCP server (`mcp-server/`) | Node.js | Sync + remote-exec tools for Claude Code |
| iOS / desktop (`ios/`, `desktop/`) | Capacitor / Electron shells | Thin wrappers around the web dashboard |

---

## The three identity layers (important)

Every session has three different IDs. Confusing them has been the root cause of at least four production bugs.

| Layer | Name | Produced by | Notes |
|---|---|---|---|
| PocketEng | `sessionId` | Our backend | Our internal primary key in DynamoDB. |
| Agent | `remoteSessionId` / `thread_id` | The agent SDK (Codex, Claude, Cursor) | The agent's own rollout-file ID. Emitted by the bridge as a `session.remote` event. |
| Message seq | `seq` | `_launch_turn` + `_register_synced_session` | Per-session integer ordering. Used as the DDB sort key. |

See [`features/session-sync.md`](../features/session-sync.md) for how they interact and [`learnings/`](../learnings/) for the bugs caused by mixing them up.

---

## The four sync flows

Session-sync is the most load-bearing feature. Four flows, each distinct:

1. **Laptop-only** — agent runs locally, session file on disk. Sync daemon pushes it up.
2. **Cloud-only** — agent runs on EC2, launched from the web UI. `_launch_turn` writes DDB rows directly.
3. **Laptop → UI follow-up** — local session synced up, then user sends a follow-up from the UI. The cloud launch becomes authoritative.
4. **UI → laptop mirror** — cloud session mirrors down via the daemon's pull cycle.

Invariants:

- A single session has one canonical transcript in DDB. `_launch_turn`'s bridge rows **own** it once `currentRunSeqBase > 0`.
- `put_message(sessionId, seq, …)` is idempotent on `(sessionId, seq)` — duplicates must be caused by different `seq` values, never by racing writers.
- Agent-native resume (Codex `resumeThread`, Claude rollout append) is preferred over synthetic preambles.

---

## Data stores

| Table | Purpose |
|---|---|
| `pe-sessions-<stage>` | Session records (`sessionId`, `userId`, `serverId`, counters, `remoteSessionId`, status) |
| `pe-messages-<stage>` | Materialized transcript rows (`sessionId`, `seq`, `role`, `content`) |
| `pe-session-events-<stage>` | Raw bridge events (incl. `session.remote`) |
| `pe-servers-<stage>` | Workspace records (managed + BYOS) |

---

## Non-obvious things

- **Bridge lives in `backend/src/lib/bridge/`** — it is the backend's property, SFTP'd to EC2 on launch. There is no separate package. See [`../AGENTS.md`](../../AGENTS.md).
- **BYOS (bring your own server)** servers have `envType: "byos"` and cannot be started / stopped by our Lambdas. Lifecycle and action handlers must guard explicitly.
- **Preview proxy** tries direct HTTP first and falls back to an SSH tunnel via Lambda. The tunnel path is the only reason `backend/` depends on SSH.
- **Cloud-initiated new sessions do not appear on the laptop.** That is by design — the sync daemon mirrors paired project directories, not arbitrary cloud-only paths.

---

## See also

- [`repo-map.md`](repo-map.md) — one level deeper, per-folder
- [`chat-history-loading.md`](chat-history-loading.md) — how transcript windows, `beforeSeq`, and long-session truncation work
- [`../features/session-sync.md`](../features/session-sync.md) — the load-bearing feature
- [`../../CLAUDE.md`](../../CLAUDE.md) — the repo-root overview (canonical)
- [`../../AGENTS.md`](../../AGENTS.md) — dev commands per component

## Referenced by

- `README.md`
- `references/repo-map.md`
- `features/session-sync.md`
- `learnings/2026-04-long-session-initial-load-drops-assistant-replies.md`
