---
type: learning
status: canonical
last_reviewed: 2026-04-27
related:
  - playbooks/browser-testing.md
tags: [learning, mobile, ios, capacitor, wkwebview, scroll, overscroll, css]
---

# Chat-screen Scroll Exposes the Sign-in Page on iPhone (2026-04)

**When to read:** before touching `web/app/dashboard/layout.tsx`,
`web/components/ChatWindow.tsx` scroll containers, or any
`html`/`body` overflow rules in `web/app/globals.css`.

**When to update:** never edit the story. Add cross-links at the
bottom as new related scars appear.

## One-line

Document-level scroll wasn't locked while the dashboard shell was
mounted. On iPhone WKWebView, dragging on the chat feed bubbled to
the body, which was free to scroll because `body` only had
`min-h-dvh`. Scrolling exposed the previous route (the sign-in page,
left in the WebView's stale-HTML cache) — the user described it as
"both screens are tied up."

---

## Symptom

Reported by an iPhone 17 Pro user:

> When I'm on the chat screen and I touch the screen and scroll
> downwards, the whole screen gets scrolled and then I see the
> initial login page there, seems like both are tied up.

Reproducible in a desktop browser at iPhone-class viewport
(≥iPhone 15 Pro Max metrics) with a static layout that mirrors the
production DOM:

1. Outer shell is `h-dvh overflow-hidden` (good).
2. `dashboard-content` is `overflow-y-auto` with a `:has(>section)`
   override to `overflow-hidden` — but `:has` is unreliable in
   WKWebView (existing comment in `ChatWindow.tsx:2080-2083`).
3. Body is `min-h-dvh` only — i.e. *at least* viewport, no upper
   bound.
4. If anything pushes the body taller (a stale-HTML stack of two
   routes, a transient layout overflow during route transition), the
   document itself becomes scrollable. Every drag gesture that hits
   "end of chat feed" then chains up through `dashboard-content` to
   the body and pulls the second page into view.

Evidence: in `/tmp/scroll-repro/before.html` (mirrors production
classes), `window.scrollTo(0, 99999)` after the chat feed runs out
moves `window.scrollY` from 0 to 739 — exactly one viewport — and
the stacked landing block is visible in the next screenshot.

---

## Root cause

Three CSS gaps, in order of leverage:

1. **No `overscroll-behavior` on `html`/`body`.** iOS rubber-band
   over-scroll is free to expose whatever was painted behind, and
   inner-scroller chain bubbles freely up to the document.
2. **No `overflow:hidden` on `html`/`body` while the dashboard is
   mounted.** The dashboard layout is *visually* pinned to the
   viewport via `h-dvh overflow-hidden`, but the document around it
   isn't — so any rendering glitch that makes the body taller (most
   visibly the WKWebView "two pages stacked" failure mode flagged in
   `NativeBootstrap.tsx:22-29`) becomes a scrollable document.
3. **No `overscroll-behavior:contain` on the chat feed itself.** The
   inner scroller's overflow chains to its ancestors when the user
   passes the top/bottom edge.

Fix #1 alone wouldn't have been enough — `overscroll-behavior` only
governs *how* a container reacts at its scroll boundary, not whether
the document is scrollable in the first place. The bug needs both
"document can't scroll at all on this route" and "rubber-band can't
expose anything behind."

---

## Fix

Three minimal CSS / TSX edits, each one defensive on its own:

```css
/* web/app/globals.css — universal: kill iOS rubber-band overscroll */
html, body {
  overscroll-behavior: none;
}
```

```tsx
// web/app/dashboard/layout.tsx — pin html+body to viewport while
// the dashboard shell is mounted. Cleans up on unmount so auth /
// onboarding routes (which don't use the dashboard layout) are
// unaffected.
useEffect(() => {
  const html = document.documentElement
  const body = document.body
  const prev = {
    htmlOverflow: html.style.overflow, bodyOverflow: body.style.overflow,
    htmlHeight: html.style.height,    bodyHeight: body.style.height,
  }
  html.style.overflow = 'hidden'
  body.style.overflow = 'hidden'
  html.style.height = '100%'
  body.style.height = '100%'
  return () => {
    html.style.overflow = prev.htmlOverflow
    body.style.overflow = prev.bodyOverflow
    html.style.height = prev.htmlHeight
    body.style.height = prev.bodyHeight
  }
}, [])
```

```tsx
// web/components/ChatWindow.tsx — chat feed scroller, ~line 3177:
<div ... style={{ ..., overscrollBehavior: 'contain' }}>
```

The dashboard layout becomes a client component (`'use client'`)
because of the new `useEffect`. `next build` confirmed all routes
still prerender / are dynamic as before.

---

## Tests that now guard this

- Static Playwright repro at `/tmp/scroll-repro/{before,after}.html`
  + `run.mjs`. iPhone-class viewport, wheel-scroll then
  `window.scrollTo(0, 99999)`. BEFORE asserts `scrollY > 100`
  (bug); AFTER asserts `scrollY === 0` (fix).
- Real-app Playwright harness at
  `~/.pocketeng/browser-harness/verify-real-app.mjs`. Drives the
  Next.js dev server. `/` keeps `body{overflow:visible}` (landing
  unaffected); `/dashboard/sessions` reports
  `html,body{overflow:hidden; height:100%}` once the layout
  effect runs.

If either harness goes red, the fix has regressed.

---

## How to catch a regression fast

On the iOS app, open any workspace chat. Drag down hard at the top
of the chat feed. The feed alone should bounce — the screen must
not move and the sign-in page must not appear from below.

---

## Subtle traps to avoid

- **Don't lock overflow in `globals.css`.** Landing uses
  `min-h-dvh` and may need to scroll on small viewports. Scope to
  the dashboard layout's lifecycle.
- **`overscroll-behavior` ≠ overflow lock.** It governs the
  boundary, not whether the container scrolls. A grown body still
  needs `overflow:hidden`.
- **Don't rely on `:has()` in WKWebView.** The pre-existing
  `[&:has(>section)]:overflow-hidden` is what set up this bug
  class. The fix here is `:has`-free on purpose.
- **Stacking is a separate bug.** The "two pages stacked" failure
  flagged in `NativeBootstrap.tsx:22-29` is what makes the body
  grow. Don't remove `checkForStaleCache` — this fix hides the
  visible symptom, not the underlying cache stack.

---

## See also

- [`../playbooks/browser-testing.md`](../playbooks/browser-testing.md)
  — how to set up the Playwright harness used here
- [`2026-04-chat-user-bubble-overflow-iphone.md`](2026-04-chat-user-bubble-overflow-iphone.md)
  — the *horizontal* counterpart: long user-message bubbles
  overflowing the chat column. Same symptom shape ("touch and
  the screen moves wrong"), different layer.

## Referenced by

- `web/app/globals.css` (the `html, body { overscroll-behavior:
  none }` block)
- `web/app/dashboard/layout.tsx` (the body-lock `useEffect`)
- `web/components/ChatWindow.tsx` (the `overscrollBehavior:
  'contain'` on the chat feed scroller, ~line 3177)
- `learnings/2026-04-landing-auth-restore-must-own-viewport.md`
