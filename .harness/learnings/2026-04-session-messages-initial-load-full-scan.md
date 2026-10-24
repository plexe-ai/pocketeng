---
type: learning
status: canonical
last_reviewed: 2026-04-28
related:
  - learnings/2026-04-long-session-initial-load-drops-assistant-replies.md
  - references/chat-history-loading.md
tags: [learning, backend, dynamodb, sessions, performance, lambda-timeout]
---

# GET /sessions/{id}/messages Did a Full Partition Scan (2026-04)

**When to read:** before touching the initial-load path in
`backend/src/sessions.py` or any DDB pagination on the messages
table.
**When to update:** never edit the story. Add cross-links at the
bottom as new related scars appear.

## One-line

The initial-load path called `get_messages(session_id)` with no
limit, paginating through the entire DDB partition before trimming to
a 500-row window — which timed out the Lambda for sessions with
thousands of raw rows. The user-visible symptom was "this session
just won't load."

## Symptom

- User opens a long-running agent session in the web or desktop app.
- Loading spinner stays up forever; the chat feed never paints.
- Browser console shows repeated
  `GET /sessions/<id>/messages net::ERR_INSUFFICIENT_RESOURCES`
  followed by `Failed to fetch` — Chrome refusing new fetches because
  it already has 6 in-flight against the origin (its per-host limit).
- CloudWatch Lambda logs show 29.5–30s `Duration` entries for
  SessionsFunction — the function is timing out at the configured
  cap.

The retry storm is downstream of the timeout: the page keeps
retrying because each fetch hangs for ~30s and never resolves before
the next render kicks one off.

## Root cause

`backend/src/sessions.py` initial-load handler:

```python
if after_seq is None and before_seq is None:
    messages = get_messages(session_id)            # ← O(N) full scan
    initial_window, truncated = _initial_load_window(messages)
    # ... transcript = materialize_transcript(initial_window, ...)
```

`get_messages(session_id)` paginates through every raw row in the
session's DDB partition with no `Limit`. Then `_initial_load_window`
throws away all but the trailing 500-row window.

For a session with ~10k raw rows (one Claude reply expands into many
`assistant` + `tool_use` + `tool_result` + `result` rows, see
[`2026-04-long-session-initial-load-drops-assistant-replies.md`](2026-04-long-session-initial-load-drops-assistant-replies.md)),
the scan plus the transcript materialization push the Lambda past
its 30s timeout. API Gateway returns no response, the client retries,
the browser eventually refuses with `ERR_INSUFFICIENT_RESOURCES`.

## Fix

Replace the full-scan-then-trim with a direct DDB Query that asks
for just the latest N rows: `ScanIndexForward=False` + `Limit=N`.
Then the existing user-row rewind rule re-runs only if the start of
that page lands mid-assistant — same conversational-boundary
guarantee as before, just bounded.

`backend/src/sessions.py` now exposes `_load_initial_window` for the
handler:

```python
tail_desc = get_messages(session_id, scan_forward=False,
                         limit=max_raw_messages)
window = list(reversed(tail_desc))
fetched_full_page = len(tail_desc) >= max_raw_messages
if window[0]["role"] != "user" and fetched_full_page:
    # rewind via additional descending Queries until a user row appears
    ...
return window, has_more_before
```

The old in-memory-only `_initial_load_window(messages)` helper is
kept for the test path that already has the full list in memory.

`totalMessages` was dropped from the response (it required either a
full scan or a separate `Select="COUNT"` query, and the client
doesn't read it). `truncated` is now derived from the new
`hasMoreBefore` flag, so the public-facing contract is preserved.

## Tests that now guard this

- `backend/tests/test_sessions.py::TestGetMessages::test_initial_load_never_does_full_unbounded_scan`
  — records every `get_messages` call from the initial-load path
  and asserts each carries either `limit=` or a bounded `to_seq=`.
  Pre-fix, the unbounded `get_messages(session_id)` call fails this
  assertion immediately.
- `test_long_initial_load_keeps_recent_transcript_contiguous`
  remains and now exercises the descending-page path, since the test
  helper got a smarter `get_messages` mock that honors
  `scan_forward` + `limit` + `to_seq` like the real DDB client.

## How to catch a regression fast

Real-prod observation:

1. Watch `Duration` on the SessionsFunction Lambda in CloudWatch
   Logs Insights:

   ```
   filter @type = "REPORT"
   | stats avg(@duration) as avg_ms, max(@duration) as max_ms by bin(5min)
   ```

2. Anything spiking past ~5s on the initial-load path is suspicious.
   Past ~15s and the long-session bug is back.

Real-device manual repro:

1. Open a session that already has >2000 raw rows. (Any session a
   real agent has been working in for a while qualifies.)
2. Load it from a cold tab.
3. The chat feed should paint within a couple of seconds.
4. If it stalls and the network panel shows the
   `/sessions/<id>/messages` request hanging, the bug is back.

## Subtle traps to avoid

- **Don't fetch the whole table just to trim it.** Even when you
  feel like you'll \"need it later for `totalMessages`\", you don't.
  Pay the COUNT separately if you genuinely need the count.
- **Don't drop the user-row rewind rule.** The 500-row window has
  to start on a user boundary; otherwise transcript materialization
  emits orphaned user bubbles. See the partner scar.
- **Mocks must honor query semantics.** The original test helper
  used `return_value=` on `get_messages`, which made an O(N) full
  scan look identical to a `limit=500` Query. Tests passed but prod
  burned. The helper now uses a `side_effect` that filters by
  `scan_forward` / `limit` / `to_seq` like the real DDB call.

## See also

- [`../references/chat-history-loading.md`](../references/chat-history-loading.md)
  — the client/server contract for transcript windows
- [`2026-04-long-session-initial-load-drops-assistant-replies.md`](2026-04-long-session-initial-load-drops-assistant-replies.md)
  — the partner scar that introduced the 500-row cap and the
  user-row rewind rule

## Referenced by

- `backend/src/sessions.py`
- `backend/tests/test_sessions.py`
