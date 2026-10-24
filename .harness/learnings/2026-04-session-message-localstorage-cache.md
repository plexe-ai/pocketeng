---
type: learning
status: canonical
last_reviewed: 2026-04-27
related:
  - playbooks/bench-load-time.mjs
  - playbooks/browser-testing.md
tags: [learning, web, perf, cache, chatwindow, localstorage]
---

# Session Messages Re-fetch on Every Open — Cached in localStorage (2026-04)

**When to read:** before touching `web/components/ChatWindow.tsx`'s
`loadSessionRecord`, or before changing the shape of
`getSessionMessages` response in `web/lib/api.ts`. Also before
adding new caches with the `pe:cache:v1:` prefix.

**When to update:** never edit the story. Add cross-links as new
related scars appear.

## One-line

Opening any session via deeplink/refresh hit the network for the
full transcript every time (~100 KB / ~180 ms RTT for a 120-message
session) and painted an empty pane until the response arrived. We
already had a TTL-bounded localStorage cache in
`web/lib/cache.ts` — used for the dashboard server list — so the fix
was to wire `loadSessionRecord` through it.

---

## Symptom

Returning users reported the chat pane sat empty for a beat before
the conversation appeared, especially on long sessions. Reproduced
with a synthetic 120-message session (74 KB transcript, 103 KB JSON
payload) on a localhost prod build:

| Phase | mean paint | network on /messages |
|---|---|---|
| First open (cold) | 920 ms | 211 ms · 103,620 B |
| Re-open without cache | ~920 ms | 211 ms · 103,620 B |
| Re-open with cache (post-fix) | **705 ms** | **0 ms · 0 B** |

Same payload re-downloaded on every open. No staleness check, no
client-side memo across navigations.

---

## Root cause

`ChatWindow.loadSessionRecord` awaited
`getSessionMessages(sessionId)` before any `setMessages` call. The
network round-trip was on the critical path of "what does the user
see when they open this session." Both deeplink (`/dashboard/{server}?session={sid}`)
and history-pane click went through this path — there was no place
where prior transcript content was held across navigations.

We had `readCache`/`writeCache` in `web/lib/cache.ts` from PR #78
(dashboard server list), TTL-bounded and quota-safe. Pattern
already used elsewhere — it just hadn't been pointed at session
messages.

---

## Fix

Wire `loadSessionRecord` through `readCache`/`writeCache` keyed by
session id. Read before fetch (paint stale-but-plausible content
instantly); write after fetch (so the next open is a cache hit).

```ts
// web/components/ChatWindow.tsx (excerpt)
const SESSION_MSG_CACHE_TTL_MS = 5 * 60 * 1000
const sessionMsgCacheKey = (sessionId: string) => `session-messages:${sessionId}`

const cached = readCache<{ messages: ChatMessage[]; transcript?: ChatTranscriptMessage[] }>(
  sessionMsgCacheKey(record.sessionId), SESSION_MSG_CACHE_TTL_MS,
)
if (cached) {
  const cachedMsgs = responseToMsgs(cached, shouldPoll)
  if (cachedMsgs.length > 0) {
    setSelectedRecord(record)
    setMessages(cachedMsgs)
    setSession(agent ? { sessionId: record.sessionId, pid: '', agent } : null)
    setOffset(record.currentRunOffset ?? 0)
  }
}

const response = await getSessionMessages(record.sessionId)
writeCache(sessionMsgCacheKey(record.sessionId), {
  messages: response.messages,
  transcript: response.transcript,
})
// existing don't-shrink reconciliation runs unchanged
```

Reuses the `pe:cache:v1:` prefix. TTL is 5 min — short enough that a
session with new turns from another device doesn't stay hidden
behind stale cache for long, and the network fetch still
reconciles via the existing don't-shrink logic the moment it
returns.

---

## Why this couldn't bypass the don't-shrink reconciler

Three pre-existing safety nets that kept us from breaking message
state on race conditions had to keep working:

1. **mid-send guard** — `if (runningRef.current) return` at the top
   of `loadSessionRecord` short-circuits when an optimistic message
   is in flight. The cache read sits BELOW that guard, so we never
   paint cached content over an optimistic bubble.
2. **don't-shrink updater** — when the network response comes back
   shorter than the local state (DDB persistence lag, transcript
   tool-blocks the messages table doesn't store), we keep the
   richer local state. Cache-paint goes through the same
   `setMessages(prev => ...)` updater downstream, so the same logic
   guards against the cache replacing live event-stream content.
3. **per-session keying** — the cache key is namespaced by sessionId.
   Switching sessions reads a different key; the don't-shrink check
   `sessionRef.current?.sessionId !== record.sessionId` continues
   to short-circuit when the user navigates away mid-fetch.

---

## Evidence

Per-iteration measurements via
`.harness/playbooks/bench-load-time.mjs` against a 120-message /
103,620-byte session on a localhost prod build (`next build && next start`):

- Run folders:
  - `test-screenshots/20260427095410-bench-baseline/` — dev build, no cache code, cold mean 1364 ms / warm mean 1330 ms (basically identical, confirms no caching today)
  - `test-screenshots/20260427095638-bench-after-fix/` — dev build, cache code on, warm netRttMs=null across all 5 iters
  - `test-screenshots/20260427095838-bench-after-fix-prod/` — prod build, cache code on. Cold mean 920 ms / warm mean 705 ms. **23% faster, 100% network elimination, 103.6 KB saved per warm load.**

The cleanest signal that the win is not network jitter: warm-mode
`netRttMs` is `null` and `netBytes` is `0` across every iteration.
That's binary — the request never goes out. Wall-clock improvement
follows from skipping the round-trip plus painting from the
synchronous localStorage read.

---

## What it did NOT change

- Live session events polling — untouched. Running sessions still
  stream via `getSessionEvents` and fold into messages via the same
  reducer. Cache only affects the initial paint of a session you've
  opened before.
- `getSessionMessages` always still runs after the cached paint —
  cache is a head-start, not a source of truth. Stale entries get
  reconciled on the very next render.
- Dashboard server-list cache (`dashboard:active-servers`) is
  unaffected — it sits under the same `pe:cache:v1:` prefix but a
  different namespace key.

---

## Related files

- `web/lib/cache.ts` — TTL-bounded localStorage cache (read/write/clear)
- `web/components/ChatWindow.tsx::loadSessionRecord` — where the
  cache was wired in
- `.harness/playbooks/bench-load-time.mjs` — repro/benchmark script

## Cross-links

- PR #78 (dashboard server list) introduced `web/lib/cache.ts`
- See `2026-04-session-polling-single-flight-stuck.md` for the
  related polling/reconcile machinery this cache had to coexist with.
