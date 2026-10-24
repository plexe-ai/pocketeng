---
type: learning
status: canonical
last_reviewed: 2026-04-23
related:
  - features/session-sync.md
  - references/architecture-overview.md
tags: [learning, session-sync, codex, cursor, dynamodb]
---

# Codex + Cursor: Duplicate Sessions on UI Follow-up (2026-04)

**When to read:** before touching `_register_synced_session`, `_insert_tail_messages`, `put_message`, or anything that writes `pe-messages`.
**When to update:** never edit the story. Add cross-links at the bottom as new related scars appear.

## One-line

A UI follow-up on a synced session created a second DDB session + duplicated transcript content, because the sync daemon's tail-insert kept running after the cloud-launch path had taken ownership of the transcript.

---

## Symptom

- User creates a local session with Codex or Cursor.
- Sync daemon pushes the `.jsonl` up; session appears in the web UI.
- User sends a follow-up from the UI.
- Result: sidebar shows **two** sessions for the same conversation; the open session shows the user prompt twice and the assistant reply twice.

DDB state before the fix:

- `pe-sessions-test` had two rows with different `sessionId` but the same `remoteSessionId`.
- `pe-messages-test` had overlapping `seq` values with mismatched content.

---

## Root cause

Two writers on the hot path:

1. `_launch_turn` (chat path) — allocates seqs from `currentRunSeqBase + currentRunOffset`.
2. `_register_synced_session` → `_insert_tail_messages` (sync daemon path) — allocates seqs as `line_count + parsed_msg_seq`.

For Codex and Cursor, `parsed_msg_seq` (ordinal index of *parsed* messages) diverges from the raw `line_count` because many rollout lines are skipped during parsing (`developer` messages, system-injected user context, `session_meta`, `turn_context`, most `event_msg` subtypes).

After the first UI follow-up, the two writers chose different `seq` values for the same logical turn. `put_message`'s `(sessionId, seq)` idempotency could not deduplicate across different seqs — so both rows landed.

Compounding the bug: a new session was also being created because the daemon's merge key wasn't reconciling the real agent `remoteSessionId` correctly (Codex SDK and our `_persist_agent_output` both wrote `remoteSessionId`, and ours was clobbering the agent's).

---

## Fix

In `backend/src/chat.py::_register_synced_session`:

- Gate `_insert_tail_messages` on `was_cloud_launched = currentRunSeqBase > 0`.
- When the session was cloud-launched, **skip** tail-insert and **do not** reset `currentRunOffset` / `nextSeq`. The bridge rows own the transcript.
- For pure-laptop sessions (never touched from the UI), keep re-hydrating on every pull.

In `backend/src/chat.py::_persist_agent_output`:

- Prefer `thread.started.thread_id` over `system/init.session_id` when extracting `remoteSessionId`. Our PE sessionId stops clobbering the agent's real ID.

In `backend/src/session_events_ingest.py`:

- Accept a new `session.remote` kind. On ingest, `update_session(session_id, {"remoteSessionId": rsid})`.

In `backend/src/lib/bridge/bridge.mjs`:

- On `thread.started`, emit `{type: "thread.started", thread_id, session_id}` and forward to the uploader as `session.remote`.

Native Codex resume was also added (`_launch_turn` probe + `--codex-resume` flag) so a UI follow-up reuses the existing rollout instead of starting a new one.

---

## Tests that now guard this

- `backend/tests/test_chat_persistence.py::TestRegisterSyncedSessionTailInsertGate::test_cloud_launched_session_skips_tail_insert`
- `…::test_cloud_launched_session_preserves_bridge_counters`
- `…::test_pure_laptop_session_still_hydrates_tail_messages`

Plus the real-browser pass described in [`../playbooks/browser-testing.md`](../playbooks/browser-testing.md).

---

## How to catch a regression fast

1. Fresh state (see [`../playbooks/cleanup-between-runs.md`](../playbooks/cleanup-between-runs.md)).
2. Create a local Codex session, push it via sync.
3. Open it in the UI, send one follow-up.
4. `aws dynamodb scan --table-name pe-sessions-test …` — expect **one** row for this conversation.
5. `aws dynamodb query --table-name pe-messages-test --key-condition-expression "sessionId = :s" …` — expect strictly increasing `seq`, no duplicate content.

---

## See also

- [`../features/session-sync.md`](../features/session-sync.md)
- [`2026-04-cursor-nextseq-off-by-one.md`](2026-04-cursor-nextseq-off-by-one.md) — adjacent scar in the same code path

## Referenced by

- `features/session-sync.md`
