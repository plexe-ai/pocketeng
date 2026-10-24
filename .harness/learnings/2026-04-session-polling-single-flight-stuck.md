---
type: learning
status: canonical
last_reviewed: 2026-04-24
related:
  - playbooks/test-polling-resume.mjs
  - playbooks/browser-testing.md
tags: [learning, chat, polling, webview, ios, capacitor, single-flight, abortcontroller]
---

# Polling Freezes After App Backgrounding (2026-04)

**When to read:** before touching `ChatWindow.doOnePoll`, the visibility /
pageshow / `onAppResume` handlers, or `getSessionEvents` in `web/lib/api.ts`.

**When to update:** never edit the story. Add cross-links at the bottom
as new related scars appear.

## One-line

A single-flight guard around the events poll (`pollInFlightRef.current =
true`) was only cleared in the fetch's `finally`. iOS WKWebView and
backgrounded Chromium windows suspend in-flight fetches — the promise
never resolves, `finally` never runs, the flag stays stuck, and every
subsequent poll returns early at the guard until the user reloads.

---

## Symptom

- User sends a prompt. Assistant-message header appears ("Claude is
  thinking…").
- User switches away from the app (Home button on iOS, ⌘Tab on desktop,
  phone screen off).
- Agent finishes on the backend. `run.finished` + `assistant_message`
  events land in DynamoDB.
- User returns. Header is still there. Body is blank. Connection
  indicator reads "live". No error, no reconnecting state.
- Pull-to-refresh or a full reload instantly materializes the full
  response.

Reported as "if I moved away from the app, the Claude response never
came — when I reload on desktop, it comes fine."

---

## Root cause

`doOnePoll` uses a classic single-flight pattern: guard on
`pollInFlightRef.current`, set to `true` on entry, clear in `finally`.
That pattern assumes the awaited promise eventually settles. It doesn't
on two platforms we ship to:

- **iOS WKWebView (Capacitor shell):** when the app is backgrounded,
  the OS freezes the render process. In-flight `fetch()` sockets stall.
  On foreground, the suspended fetch does NOT auto-resume — promise
  stays pending forever, `finally` never runs.
- **Chromium backgrounded windows (Electron / browser tab in back):**
  same thing, less aggressive but reproducible after ~30s.
- **Electron windows that lost focus but stayed visible (added 2026-04
  scar):** ⌘Tab to another macOS app and the Electron window does NOT
  flip to `visibilityState === 'hidden'` — only minimize/hide does that.
  So the original `visibilitychange` listener never fires on app-switch,
  yet macOS still deprioritizes the renderer enough to suspend the
  in-flight fetch. Symptom on the desktop app was identical to the iOS
  scar above: send a prompt, ⌘Tab away, agent finishes, ⌘Tab back —
  body stays blank until reload. Fix is in the same `useEffect`: also
  listen to `window.focus` (and `online` for network-recovery, which is
  cheap and catches a different class of stuck fetch). Order matters
  here: a desktop user can lose focus several times during a single
  long agent run, so resumeAndPoll has to be idempotent against
  rapid-fire calls. It is — abort + reset-flag + kick is safe to call
  on every focus event.

So the flag stays `true` permanently. The 200ms setInterval keeps
firing — every tick bails at the guard. The visibility-resume handler
just called `pollNowRef.current()` which hit the same guard. Only a
full reload (fresh `useRef`) fixed it.

---

## Fix

Two things have to happen on app resume:

1. **Cancel the pending fetch.** Track an `AbortController` on a ref,
   hand its signal to `getSessionEvents`. The visibility / pageshow /
   Capacitor `appStateChange` handlers abort the controller when the
   app comes back. That resolves the pending promise (as a rejection
   with `AbortError`), which runs `finally`, which clears the flag.
2. **Belt-and-suspenders reset of the flag.** Even if the abort didn't
   propagate in some environment, force `pollInFlightRef.current = false`
   before kicking the next poll. Then call `pollNowRef.current()` so the
   catch-up fetch actually runs.

```tsx
const pollAbortRef = useRef<AbortController | null>(null)

// inside doOnePoll:
const controller = new AbortController()
pollAbortRef.current = controller
try {
  const result = await getSessionEvents(s.sessionId, eventCursorRef.current, controller.signal)
  // …
} catch (err) {
  // Don't count deliberate aborts against the error budget.
  if ((err as Error | undefined)?.name === 'AbortError' || controller.signal.aborted) {
    return
  }
  // … original error path …
} finally {
  pollInFlightRef.current = false
  // Only clear the ref if we're still the active controller.
  if (pollAbortRef.current === controller) {
    pollAbortRef.current = null
  }
}

// visibility / pageshow / Capacitor onAppResume:
const resumeAndPoll = () => {
  pollAbortRef.current?.abort()
  pollInFlightRef.current = false
  pollNowRef.current()
}
```

`getSessionEvents` in `web/lib/api.ts` grew an optional `signal?:
AbortSignal` parameter. Existing call sites are unchanged.

---

## Tests that now guard this

- `.harness/playbooks/test-polling-resume.mjs` — Playwright regression.
  Holds the next `/sessions/:id/events` request open indefinitely via
  `page.route(... => new Promise(() => {}))`, dispatches a
  `visibilitychange` hidden→visible cycle **without unrouting**, and
  asserts at least one new events request fires after resume. The
  `without unrouting` part matters — `page.unroute()` releases held
  requests back to the network, which would resolve the fetch and
  clear the flag even on pre-fix code, masking the bug.

Pre-fix run on this test: 0 new requests after resume → FAIL.
Post-fix run: 2 new requests after resume → PASS.

Run it:

```bash
bash .harness/playbooks/browser-testing.sh      # install Playwright harness
cd web && npm run dev &                         # or whatever dev port
export PE_TEST_EMAIL=... PE_TEST_PASSWORD=...
cd ~/.pocketeng/browser-harness                 # ESM module resolution
PE_BASE_URL=http://localhost:3001 node test-polling-resume.mjs
```

---

## How to catch a regression fast

Real-device manual repro (no harness needed):

1. Open the iOS app, start a session, send a prompt that takes 20+s.
2. Press the Home button within ~2s (must be while the fetch is
   in-flight, i.e. before the next 200ms tick).
3. Wait 30s. Return to the app.
4. Agent response should fill in within ~1 second. If the header stays
   but body is blank, the fix has regressed.

Signal to look for in network inspector: after `visibilitychange`
visible, a new `/sessions/:id/events?after=N` request should fire
within ~500ms. If the pending request from before background is still
showing "stalled" and no new one ever fires — the flag is stuck again.

---

## Subtle traps to avoid

- **Don't `finally { pollAbortRef.current = null }` unconditionally.** A
  concurrent visibility-resume might have swapped in a newer controller
  while the old fetch was unwinding. Only null it if you're still the
  owner.
- **Don't treat `AbortError` as a connection failure.** It doesn't
  increment the error budget; otherwise rapid background↔foreground
  cycles would paint the user "reconnecting" for no reason.
- **`page.unroute` in Playwright is not a no-op for held requests.** It
  releases them to the network. That's a testing-time leak that makes
  pre-fix code look fine. Leave the route installed through the
  assertion window.

---

## See also

- [`../playbooks/test-polling-resume.mjs`](../playbooks/test-polling-resume.mjs) — the regression test
- [`../playbooks/browser-testing.md`](../playbooks/browser-testing.md) — how to set up the Playwright harness

## Referenced by

- `web/components/ChatWindow.tsx` (inline comments on `pollAbortRef`
  and the two `resumeAndPoll` closures)
- `web/lib/api.ts` (comment on the optional `signal` parameter of
  `getSessionEvents`)
