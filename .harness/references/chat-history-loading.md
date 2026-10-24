---
type: reference
status: canonical
last_reviewed: 2026-04-27
related:
  - references/architecture-overview.md
  - features/session-sync.md
  - learnings/2026-04-long-session-initial-load-drops-assistant-replies.md
tags: [reference, chat, history, transcript, pagination]
---

# Chat History Loading

**When to read:** before changing `GET /sessions/{sessionId}/messages`, `web/components/ChatWindow.tsx`, or any transcript pagination logic.
**When to update:** when the client/server contract for loading older or newer chat history changes.

## Summary

- Initial chat loads return a transcript window, not necessarily the full raw message table.
- Large sessions are capped by raw-row count, then rewound to the nearest preceding user turn so the returned transcript is conversationally contiguous.
- The response now exposes `oldestRawSeq` + `hasMoreBefore` so the UI can request older pages.
- Older-history fetches use `beforeSeq`, while live catch-up still uses `afterSeq`.
- Older pages are materialized as settled transcript slices, even when the session itself is still running.

## Endpoint contract

`GET /sessions/{sessionId}/messages`

Query modes:

| Query | Purpose |
|---|---|
| none | Initial load of the current transcript window |
| `afterSeq=<raw-seq>` | Incremental tail rebuild / live catch-up |
| `beforeSeq=<raw-seq>` | Fetch an older transcript window ending strictly before that raw seq |

`afterSeq` and `beforeSeq` are mutually exclusive.

## Initial-load behavior

- Backend reads the raw DDB message rows for the session.
- If the raw row count is small, it returns the full transcript.
- If the raw row count exceeds the cap, it keeps a recent suffix of raw rows and rewinds the start of that suffix to the nearest preceding `user` row.
- The response includes:
  - `transcript`
  - `latestSeq`
  - `oldestRawSeq`
  - `hasMoreBefore`
  - `truncated` / `totalMessages` when the raw table was capped

Why the rewind matters: transcript materialization emits an assistant bubble only when the assistant-side raw rows are still present between user turns. Starting mid-assistant produces orphaned user bubbles.

## Older-history behavior

- The UI calls `beforeSeq=<oldestRawSeq currently loaded>`.
- Backend fetches the latest raw rows strictly before that seq.
- If that page starts mid-assistant, backend keeps rewinding until it finds the nearest preceding user turn.
- The returned page is materialized with `session_status="done"` even if the live session is running, because the page is historical, not the active tail.

The UI prepends that transcript slice and updates its `oldestRawSeq` / `hasMoreBefore` cursor.

## Frontend behavior

- `ChatWindow` prefers `transcript` over raw `messages`.
- It shows a `Load older messages` control when `hasMoreBefore` is true.
- When prepending older history, it preserves scroll position by snapshotting `scrollHeight` + `scrollTop` before the prepend and restoring the viewport offset after render.
- Chat message rows must not use array-index keys when prepending older items.

## See also

- [`architecture-overview.md`](architecture-overview.md) — broader system context for sessions and transcripts
- [`../features/session-sync.md`](../features/session-sync.md) — adjacent invariants around transcript ownership
- [`../learnings/2026-04-long-session-initial-load-drops-assistant-replies.md`](../learnings/2026-04-long-session-initial-load-drops-assistant-replies.md) — the bug that forced the contiguous-window rule

## Referenced by

- `references/architecture-overview.md`
