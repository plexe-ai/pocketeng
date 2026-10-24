---
type: learning
status: canonical
last_reviewed: 2026-04-27
related:
  - features/session-sync.md
  - references/architecture-overview.md
tags: [learning, chat, transcript, truncation, sessions]
---

# Long Session Initial Load Drops Assistant Replies (2026-04)

**When to read:** before touching `backend/src/sessions.py`, the initial `GET /sessions/{sessionId}/messages` load path, or any transcript-truncation logic.
**When to update:** never edit the story. Add cross-links at the bottom as related scars appear.

## One-line

Initial session loads truncated raw rows as "all user messages + last 500 raw rows", which let long threads reopen with user bubbles intact but their Claude/Codex/Cursor replies missing.

## Symptom

- Reopen or hard-refresh a long session in the web or desktop app.
- The feed shows several consecutive user bubbles with no assistant replies between them.
- The missing replies are older Claude / Codex / Cursor turns, not just the currently-running one.
- The problem appears only once the backing session has enough raw rows (tool calls, snapshots, deltas, results) to trip the initial-load cap.

Reported as: "once message session gets long, no claude code/coding agent msgs show."

## Root cause

`backend/src/sessions.py` capped large initial loads at 500 raw rows, but it did not keep a contiguous suffix. Instead it built:

1. every `role == "user"` row from the whole session, plus
2. only the last 500 raw rows overall.

That shape is sparse, not conversational. `materialize_transcript()` walks raw rows in order and emits an assistant bubble only when it sees assistant-side raw rows between user messages. Once an older assistant turn fell out of the 500-row tail, the materializer saw:

- user
- user
- assistant

So the UI rendered orphaned user bubbles with their paired assistant replies missing.

The bug was especially easy to trigger on Claude sessions because one visible reply can expand into hundreds of raw rows (`assistant`, `tool_use`, `tool_result`, `result`, deltas), so the raw cap was reached long before the human-visible transcript was actually large.

## Fix

- Keep the initial-load cap, but make the retained raw rows a **contiguous recent suffix**.
- If the 500-row tail starts mid-assistant turn, rewind the window to the nearest preceding user row.
- Materialize the transcript from that coherent suffix instead of stitching all user rows back in.
- Preserve `latestSeq` from the full message set so incremental follow-ups still advance from the real tail.

Net effect: older content may still be truncated on huge sessions, but every user bubble in the returned window keeps its assistant reply.

## Tests that now guard this

- `backend/tests/test_sessions.py::TestGetMessages::test_long_initial_load_keeps_recent_transcript_contiguous`

That test builds an 801-row session where the old logic returned `["user", "user", "assistant"]` in the transcript. The fixed path rewinds to the preceding user boundary and returns `["user", "assistant"]`.

## How to catch a regression fast

1. Create a session with at least two user turns and >500 raw message rows total.
2. Hard-refresh the session page or reopen it in the desktop app.
3. Verify the loaded window starts at a recent user turn and does not contain consecutive user bubbles with the assistant replies missing.
4. If you see "user, user, assistant" in the reconstructed transcript, the sparse-tail bug is back.

## See also

- [`../features/session-sync.md`](../features/session-sync.md) — the closest feature file covering chat persistence and transcript ownership
- [`../references/architecture-overview.md`](../references/architecture-overview.md) — background on DDB-backed transcript materialization

## Referenced by

- `features/session-sync.md`
- `references/architecture-overview.md`
