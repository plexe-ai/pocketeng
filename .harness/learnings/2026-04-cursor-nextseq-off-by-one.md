---
type: learning
status: canonical
last_reviewed: 2026-04-23
related:
  - features/session-sync.md
  - learnings/2026-04-codex-duplicate-sessions.md
tags: [learning, session-sync, cursor, off-by-one]
---

# Cursor: nextSeq Off-by-One Clobbers Last Local Reply (2026-04)

**When to read:** before changing how `nextSeq` / `currentRunOffset` are advanced in `_register_synced_session`.
**When to update:** never edit the story. Add cross-links at the bottom as new related scars appear.

## One-line

Cursor's local rollout files often omit a trailing newline. `wc -l` reported `N-1` while the parser yielded `N` messages, so the first UI follow-up was written at a `seq` that overwrote the last local assistant reply.

---

## Symptom

- User writes a Cursor session locally, ending with an assistant reply.
- Sync daemon pushes it up. UI shows the full transcript.
- User types a follow-up in the UI.
- Result: the last local assistant reply **disappears** from the transcript. The new user prompt appears in its place.

DDB: one message row was silently overwritten by another with the same `(sessionId, seq)` because `put_message` is idempotent on that key — which is the right behavior when writers agree on seq, and the wrong behavior when they don't.

---

## Root cause

In `_register_synced_session`:

```
nextSeq = line_count   # line_count = wc -l on the rollout file
```

Cursor rollouts frequently don't end with `\n`, so `wc -l` is `N-1` while `parse_session_file` returns `N` messages. `_insert_tail_messages` happily wrote those `N` messages with `seq` up to `N-1`. Then the UI wrote the user's follow-up at `seq = N-1`, clobbering the last inserted assistant reply.

This was always latent — we only hit it once the other duplicate-session bug was fixed and Cursor started exercising the single-writer path.

---

## Fix

In `backend/src/chat.py::_insert_tail_messages`:

- Track `max_seq` across the inserts; return `max_seq + 1` (or `0` if nothing inserted).

In `_register_synced_session` (both the create path and the pure-laptop update path):

- `next_seq = max(line_count, next_seq_after_inserts)`
- Write that to `nextSeq` and `currentRunOffset`.

Net effect: `nextSeq` always lands strictly past both the raw line count and the highest inserted parsed `seq`. No follow-up ever collides with a prior message.

---

## Tests that now guard this

- `backend/tests/test_chat_persistence.py::TestRegisterSyncedSessionTailInsertGate::test_cursor_no_trailing_newline_advances_nextseq_past_messages`

Plus the Cursor scenario in the browser test pass.

---

## How to catch a regression fast

Quick DDB check after a Cursor follow-up:

```bash
aws dynamodb query --profile "$AWS_PROFILE" --table-name pe-messages-test \
  --key-condition-expression "sessionId = :s" \
  --expression-attribute-values '{":s":{"S":"<sessionId>"}}' \
  --output json | jq '.Items[] | {seq: .seq.N, role: .role.S, content: (.content.S | .[0:40])}'
```

Verify:

- Strictly increasing `seq`.
- The last local assistant reply is still there after the UI follow-up.
- The new user prompt's `seq` is strictly greater than the last local reply's `seq`.

---

## See also

- [`../features/session-sync.md`](../features/session-sync.md)
- [`2026-04-codex-duplicate-sessions.md`](2026-04-codex-duplicate-sessions.md) — the sibling bug in the same code path

## Referenced by

- `features/session-sync.md`
