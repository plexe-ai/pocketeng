---
type: learning
status: canonical
last_reviewed: 2026-04-27
related:
  - playbooks/browser-testing.md
  - learnings/2026-04-mobile-chat-scroll-leaks-to-landing.md
tags: [learning, mobile, ios, chat, css, flexbox, overflow-wrap]
---

# User-message Bubble Overflows the Chat Column on iPhone (2026-04)

**When to read:** before touching the user-message bubble in
`web/components/ChatWindow.tsx` (around line 3340 — the
`msg.role === 'user'` branch), or any flex child that uses
`max-w-[%]` to clamp width inside a chat / message column.

**When to update:** never edit the story. Add cross-links at the
bottom as new related scars appear.

## One-line

A flex child with `max-w-[85%]` but no `min-w-0` will not clamp to
85% when its content is an unbreakable string (an API key the user
pasted). Flex's default `min-width: auto` overrides `max-width`, the
bubble pushes the message column wider than the viewport, and the
chat feed becomes horizontally scrollable on iPhone.

---

## Symptom

Reported by an iPhone 17 Pro user:

> There is an overflow when the user text is super long, especially
> when using API keys and all, it overflows on the right side and
> then also there is a weird horizontal scrolled enabled which
> should never happen, gives a bad experience.

Reproducible in a desktop browser at iPhone-class viewport
(402×874, DPR 3) with a static layout that mirrors the production
DOM (`/tmp/overflow-repro/before.html`):

1. Outer chain is correct: `.shell` is `h-dvh overflow-hidden`,
   `dashboard-content` is `min-h-0 overflow-hidden`,
   `chat-section` is `flex h-full flex-col min-h-0`,
   `chat-col` is `flex-col flex-1 min-w-0 min-h-0`,
   `chat-feed` is `flex-1 overflow-y-auto`.
2. Inside the feed, the user-message row is `flex justify-end` and
   the bubble wrapper is `max-w-[85%]` — but **without** `min-w-0`.
3. The `<p>` inside the bubble is `whitespace-pre-wrap`, which only
   wraps at whitespace; an unbreakable token (an API key, a hash, a
   URL with no slashes) blows past the bubble's intended width.
4. Combined, those two gaps let the bubble push the message column
   wider than the chat feed. The feed becomes horizontally
   scrollable; on iOS, that produces the "drag-to-pan" / horizontal
   bounce the user reported.

Numerical evidence (from the static repro at iPhone 17 Pro):

| metric                          | before | after |
| ------------------------------- | -----: | ----: |
| `chat-feed.scrollWidth`         | 1357px | 402px |
| `chat-feed.clientWidth`         |  402px | 402px |
| `bubble-wrap.right` vs viewport |  >402  |  <402 |

Screenshots (committed alongside this learning):

- BEFORE — bubble extending past the right edge, API key clipped:
  ![before — iPhone 17 Pro viewport](media/2026-04-chat-user-bubble-overflow/before-iphone17pro.png)
- AFTER — same string wrapped into ~7 lines inside `max-w-[85%]`,
  fully contained:
  ![after — iPhone 17 Pro viewport](media/2026-04-chat-user-bubble-overflow/after-iphone17pro.png)
- BEFORE / AFTER wide-canvas variants (rendered at a viewport
  wide enough to capture the overflow into the screenshot):
  [`media/2026-04-chat-user-bubble-overflow/before-wide.png`](media/2026-04-chat-user-bubble-overflow/before-wide.png),
  [`media/2026-04-chat-user-bubble-overflow/after-wide.png`](media/2026-04-chat-user-bubble-overflow/after-wide.png).

Raw probe artifacts (not committed): the `run.mjs` harness +
`{before,after}-metrics.json` + `.webm` recordings live at
`/tmp/overflow-repro/runs/20260427131820/`.

### Real-app verification (Playwright + dev server)

Per [`../playbooks/browser-testing.md`](../playbooks/browser-testing.md),
the same probe was re-run against the actual Next.js app — not a
hand-built static repro. The harness mounts the *exact* user-bubble
JSX from `ChatWindow.tsx` inside the *exact* chat-feed wrappers via
a small test-only page, and toggles the fix on/off with a query
param so a single dev-server build verifies both states.

| metric                  | before (`?fix=0`) | after (`?fix=1`) |
| ----------------------- | ----------------: | ---------------: |
| `feed.scrollWidth`      |          **1303** |          **402** |
| `feed.clientWidth`      |               402 |              402 |
| `bubble-wrap.className` |       `max-w-[85%]` | `max-w-[85%] min-w-0` |
| `<p>.className` (tail)  | `whitespace-pre-wrap text-bright` | `whitespace-pre-wrap break-words text-bright` |

Screenshots committed alongside the learning under
`media/2026-04-chat-user-bubble-overflow/` with the `realapp-` prefix:

- BEFORE — bubble cropped off the iPhone 17 Pro right edge:
  ![real-app before — iPhone 17 Pro](media/2026-04-chat-user-bubble-overflow/realapp-before-iphone17pro.png)
- AFTER — same string wrapped inside the bubble:
  ![real-app after — iPhone 17 Pro](media/2026-04-chat-user-bubble-overflow/realapp-after-iphone17pro.png)
- Wide-canvas variants:
  [`realapp-before-wide.png`](media/2026-04-chat-user-bubble-overflow/realapp-before-wide.png),
  [`realapp-after-wide.png`](media/2026-04-chat-user-bubble-overflow/realapp-after-wide.png).

Metrics JSON: [`realapp-before-metrics.json`](media/2026-04-chat-user-bubble-overflow/realapp-before-metrics.json),
[`realapp-after-metrics.json`](media/2026-04-chat-user-bubble-overflow/realapp-after-metrics.json).

The `run.mjs` harness + `.webm` session recordings live at
`/tmp/overflow-real-app/runs/{before,after}-20260427140122/` —
not committed (they reference a temp test-only page that was
removed before merge).

---

## Root cause

Two CSS gaps in the user-bubble branch of `ChatWindow.tsx`, both
local to the same JSX subtree:

1. **`max-w-[85%]` on a flex child without `min-w-0`.** A flex
   item's default `min-width` is `auto`, which is the size of its
   content for the purpose of overflow. When the content is an
   unbreakable string, the computed `min-width` defeats the
   `max-width` constraint — the child grows to fit its content,
   not to fit 85% of the parent.
2. **`whitespace-pre-wrap` on the `<p>` without `break-words`.**
   `pre-wrap` preserves newlines and wraps at whitespace, but does
   not break inside a long unbroken token. `overflow-wrap:
   break-word` (Tailwind `break-words`) is what allows the wrap
   point inside an API key.

Either fix alone is incomplete: `min-w-0` without `break-words`
still lets the unbreakable string force the bubble to its
content-width (now clamped at 85% of the column, but with the
string clipped under `overflow: hidden`). `break-words` without
`min-w-0` lets the bubble expand past 85% before the wrapping
kicks in. The bug needs both.

This is a sibling of the prior chat-scroll bug (see
[`2026-04-mobile-chat-scroll-leaks-to-landing.md`](2026-04-mobile-chat-scroll-leaks-to-landing.md))
in that both surface as "the user dragged and the screen moved
unexpectedly," but the mechanics are different — that one is
*vertical* document scroll bubbling out of the chat feed; this
one is *horizontal* content overflow inside the chat feed.

---

## Fix

Two-class change, no logic change, in
`web/components/ChatWindow.tsx` (`msg.role === 'user'` branch):

```tsx
// flex child wrapper:
- <div className="max-w-[85%]">
+ <div className="max-w-[85%] min-w-0">

// the <p> inside the bubble:
- <p className="text-[14px] leading-[1.6] whitespace-pre-wrap text-bright">
+ <p className="text-[14px] leading-[1.6] whitespace-pre-wrap break-words text-bright">
```

This mirrors local convention: `break-all` and `break-words` are
already used elsewhere in the same file for tool-output text,
URLs, and code spans.

---

## Tests that now guard this

- Static Playwright repro at
  `/tmp/overflow-repro/{before,after}.html` + `run.mjs`. iPhone
  17 Pro viewport (402×874, DPR 3). BEFORE asserts
  `chat-feed.scrollWidth > clientWidth` (bug); AFTER asserts
  equality (fix). Captures viewport screenshots and a wide-canvas
  screenshot so the visual symptom is unambiguous.

If that harness goes red, the fix has regressed.

---

## How to catch a regression fast

On the iOS app (or a desktop browser at ≤420px viewport), open any
chat session and paste an API key as a user message. The bubble
must wrap inside its column — there must be no horizontal scroll
on the chat feed and no horizontal bounce on iOS.

---

## Subtle traps to avoid

- **Don't drop `min-w-0` thinking `max-w-[%]` is enough.**
  `max-width` does not win against flex's default `min-width:
  auto` when the content can't shrink. This is a frequent
  Tailwind-on-flex pitfall — search for `max-w-` siblings of flex
  items and check for `min-w-0`.
- **Don't replace `whitespace-pre-wrap` with `break-words`.** The
  `pre-wrap` is what preserves newlines inside multi-line user
  messages. We need both.
- **Don't add `overflow-x: hidden` on the chat feed as a band-aid.**
  It hides the overflow but leaves the row width wrong, which
  breaks copy-selection geometry and produces inconsistent column
  widths across messages. Fix the bubble, not the scroller.
- **Don't generalise the fix to assistant messages.** Assistant
  rendering goes through markdown / code-block components that
  have their own width handling; touching them is out of scope.

---

## See also

- [`../playbooks/browser-testing.md`](../playbooks/browser-testing.md)
  — how to set up the Playwright harness used here
- [`2026-04-mobile-chat-scroll-leaks-to-landing.md`](2026-04-mobile-chat-scroll-leaks-to-landing.md)
  — the prior, *vertical* chat-scroll-to-landing scar; same
  symptom shape ("touch and the screen moves wrong") but a
  different layer

## Referenced by

- `web/components/ChatWindow.tsx` (the `min-w-0` and `break-words`
  added at the user-message branch, ~line 3340)
