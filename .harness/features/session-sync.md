---
type: reference
status: canonical
last_reviewed: 2026-04-27
related:
  - references/architecture-overview.md
  - learnings/2026-04-codex-duplicate-sessions.md
  - learnings/2026-04-cursor-nextseq-off-by-one.md
  - learnings/2026-04-long-session-initial-load-drops-assistant-replies.md
  - ../docs/session-sync-implementation.md
  - ../docs/session-sync-integration-protocol.md
  - protocols/testing-protocol.md
  - playbooks/browser-testing.md
tags: [feature, session-sync, sync, agents]
---

# Feature: Session Sync

**When to read:** before changing any code path that handles agent session files, chat persistence, or the sync daemon.
**When to update:** when a new sync flow, agent, or invariant lands.

## Summary

Session sync makes a laptop coding session and a cloud coding session the same session. It covers three agents (Claude Code, Cursor, Codex), four flows, and three identity layers. Content lives in the existing feature docs under `docs/` — this file is the router plus the scar list.

---

## Start here

| Goal | Go to |
|---|---|
| Understand the implementation end-to-end | [`../../docs/session-sync-implementation.md`](../../docs/session-sync-implementation.md) |
| Add support for a new agent | [`../../docs/session-sync-integration-protocol.md`](../../docs/session-sync-integration-protocol.md) |
| Understand the invariants in one page | the "Invariants" section below |
| Run the E2E test pass | [`../playbooks/browser-testing.md`](../playbooks/browser-testing.md) |

---

## Invariants (one-page version)

1. `_launch_turn` **owns** the transcript once `currentRunSeqBase > 0`. The sync daemon's re-register must not re-parse tail messages for that session.
2. `put_message(sessionId, seq, …)` is idempotent on `(sessionId, seq)`. Duplicates mean two writers picked different `seq` for the same logical turn — fix the writer, not the symptom.
3. `remoteSessionId` is the **agent's** ID, not ours. Prefer `thread.started.thread_id` over `system/init.session_id` when they disagree.
4. For agents that support native resume (Codex, Claude), prefer it over synthetic preambles. Detect the existing rollout file on EC2 and pass the resume flag.
5. `nextSeq` / `currentRunOffset` must cover both the raw `line_count` and the highest parsed `seq`. Some agents (Cursor) skip trailing newlines — trust the parser, not `wc -l`.

---

## Agents supported

| Agent | Session location | Notes |
|---|---|---|
| Claude Code | `~/.claude/projects/<path-hash>/<session-id>.jsonl` | Native resume. Simple parse. |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` | Global, date-based dirs — sync daemon filters by project `cwd`. Native resume via `resumeThread`. |
| Cursor | `~/.cursor/projects/<path-hash>/agent-transcripts/<id>/<id>.jsonl` + `store.db` | Trailing-newline quirk (see the Known scars). |

Adding a new agent? Follow [`../../docs/session-sync-integration-protocol.md`](../../docs/session-sync-integration-protocol.md).

---

## Known scars

One row per real-world bug. Each row links to a one-file story under `learnings/`.

| Date | Agent | Symptom | Learning |
|---|---|---|---|
| 2026-04 | Codex + Cursor | UI follow-up on synced session creates a duplicate DDB session + duplicate transcript content | [`../learnings/2026-04-codex-duplicate-sessions.md`](../learnings/2026-04-codex-duplicate-sessions.md) |
| 2026-04 | Cursor | First local assistant reply clobbered by the user's first UI follow-up | [`../learnings/2026-04-cursor-nextseq-off-by-one.md`](../learnings/2026-04-cursor-nextseq-off-by-one.md) |
| 2026-04 | Claude + Codex + Cursor | Reopening a long session shows consecutive user bubbles with assistant replies missing | [`../learnings/2026-04-long-session-initial-load-drops-assistant-replies.md`](../learnings/2026-04-long-session-initial-load-drops-assistant-replies.md) |

Before coding in this area, scan this table.

---

## Test entry points

| Layer | Path |
|---|---|
| Unit | `backend/tests/test_chat_persistence.py`, in particular `TestRegisterSyncedSessionTailInsertGate` |
| Integration | `backend/tests/agents/test_integration.py` (gated on bridge + API keys) |
| Real browser | [`../playbooks/browser-testing.md`](../playbooks/browser-testing.md) |

---

## See also

- [`../references/architecture-overview.md`](../references/architecture-overview.md) — three identity layers, four flows
- [`../../docs/session-sync-implementation.md`](../../docs/session-sync-implementation.md)
- [`../../docs/session-sync-integration-protocol.md`](../../docs/session-sync-integration-protocol.md)
- [`../protocols/testing-protocol.md`](../protocols/testing-protocol.md)

## Referenced by

- `README.md`
- `references/architecture-overview.md`
- `learnings/2026-04-codex-duplicate-sessions.md`
- `learnings/2026-04-cursor-nextseq-off-by-one.md`
- `learnings/2026-04-long-session-initial-load-drops-assistant-replies.md`
