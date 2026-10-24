---
type: reference
status: canonical
last_reviewed: 2026-04-23
related:
  - protocols/tdd-and-scope.md
  - protocols/testing-protocol.md
tags: [reference, tests, known-broken]
---

# Known Broken Tests

**When to read:** when a pre-task suite run shows a failure and you want to know whether to fix, defer, or ignore.
**When to update:** when a known-broken test lands, is fixed, or is retired.

## Summary

Tests that are red but not caused by in-flight work. If your baseline run fails on one of these, it is not your problem — proceed with your task. If a failure is **not** on this list, treat it as new (see [`../protocols/tdd-and-scope.md`](../protocols/tdd-and-scope.md)).

---

## Current list

| Test | Why it's red | Tracked in |
|---|---|---|
| `backend/tests/test_completion_hook.py::test_finalizes_session_output` | Pre-existing mock-leaking issue, unrelated to session-sync or chat persistence. Noted in `AGENTS.md`. | (none yet — open an issue when someone picks it up) |

Nothing else should live here without justification. Flaky tests (timing, network) are not "known broken" — they are their own category and don't get silenced here.

---

## How to add a row

1. Confirm the test is **verified red for reasons unrelated to any in-flight feature**. Reproduce it on a clean checkout.
2. One sentence on why, written so the next reader can skip past it safely.
3. If you have a tracking issue or learning, link it.
4. Keep the row small. This file grows rarely; the suite should generally be green.

---

## How to remove a row

Fix the test, commit the fix, delete the row in the same commit. Do not let a row outlive the bug it describes.

---

## See also

- [`../protocols/tdd-and-scope.md`](../protocols/tdd-and-scope.md)
- [`../protocols/testing-protocol.md`](../protocols/testing-protocol.md)

## Referenced by

- `protocols/tdd-and-scope.md`
- `protocols/testing-protocol.md`
