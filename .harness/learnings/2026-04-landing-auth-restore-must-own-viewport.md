---
type: learning
status: canonical
last_reviewed: 2026-04-27
related:
  - playbooks/browser-testing.md
  - learnings/2026-04-mobile-chat-scroll-leaks-to-landing.md
tags: [learning, mobile, ios, auth, landing, wkwebview, viewport, supabase]
---

# Landing Auth Restore Must Own the Viewport (2026-04)

**When to read:** before touching `web/app/page.tsx`, especially the
cached-session loading path, or before changing how the mobile app
lands on `/` after sign-out / auth expiry.
**When to update:** never edit the story. Add cross-links at the bottom
as new related scars appear.

## One-line

The landing page returned `null` while Supabase restored a cached
session. On mobile WKWebView, that meant `/` briefly did not own the
screen, so stale dashboard DOM could stay visible underneath — users
reported the sign-in page with a session list below it.

## Symptom

- In the phone app, user lands on the sign-in page.
- Under or below the sign-in card, old dashboard content is still
  visible, most commonly the Sessions list.
- UX feels like two pages are tied together or stacked.

This is the auth-route counterpart to
[`2026-04-mobile-chat-scroll-leaks-to-landing.md`](2026-04-mobile-chat-scroll-leaks-to-landing.md):
same stale-route family, different direction.

## Root cause

`web/app/page.tsx` started with:

```tsx
const [loading, setLoading] = useState(() => hasCachedSupabaseSession())

if (loading) {
  return null
}
```

That "render nothing while checking `getSession()`" optimization is fine
on a clean browser tab. It is not fine in a mobile shell that may still
be holding the previous route's DOM or scroll position for a beat.

While `/` was returning `null`, nothing opaque or full-screen claimed
the viewport. So if the old dashboard route was still physically there,
its content remained visible until the auth check resolved.

## Fix

Make `/` own the screen immediately, even during the loading state:

1. Extract a shared `AuthViewportShell` to
   [`../../web/components/AuthViewportShell.tsx`](../../web/components/AuthViewportShell.tsx).
2. Render it both for the real sign-in UI **and** for the loading
   phase that used to return `null`.
3. Make the shell:
   - `fixed inset-0`
   - opaque (`bg-ink`)
   - above stale content (`z-40`)
   - scrollable itself (`overflow-y-auto`)
4. On mount, lock `html` and `body` to `overflow:hidden; height:100%`
   and `window.scrollTo(0, 0)` so the auth route owns the viewport the
   same way the dashboard shell does. Restore the previous styles on
   unmount so navigating away to the dashboard doesn't strand the
   body in a locked state.

**Apply the same shell to any other route that returns `null`
between mount and first useful paint.** `/onboarding` had the same
hydration-guard pattern (`if (!mounted) return null`) and was at risk
of the same symptom — same fix, with `centerContent={false}` because
the onboarding flow has substantial vertical content that should
start at the top of the scroll area instead of being centered.

## Evidence

- `cd web && npm run build` passed after the change.
- The landing route no longer returns `null` during cached-session
  validation, so there is always a full-screen auth surface in place.

No real-device browser pass was run in this session.

## How to catch a regression fast

On the phone app:

1. Open a dashboard route with visible session history.
2. Force a trip back to `/` (sign out, session expiry, or auth failure).
3. Watch the landing page appear.

Expected: the sign-in page fully owns the screen immediately. No
session list, workspace list, or other dashboard content should be
visible underneath or below it.

## Subtle traps to avoid

- **Do not return `null` from the landing route during auth restore.**
  On mobile, "nothing rendered" means "old route may still be visible."
- **`min-h-dvh` is not enough.** The route must actively cover the
  viewport and sit above stale content.
- **This is related to, but not the same as, scroll leakage.** The old
  chat scar was "dashboard reveals landing page while scrolling." This
  one is "landing page reveals dashboard while loading."

## See also

- [`../playbooks/browser-testing.md`](../playbooks/browser-testing.md)
  — how to run a real-browser regression pass for mobile UI issues
- [`2026-04-mobile-chat-scroll-leaks-to-landing.md`](2026-04-mobile-chat-scroll-leaks-to-landing.md)
  — same stale-route class from the opposite direction

## Referenced by

- `web/components/AuthViewportShell.tsx`
- `web/app/page.tsx`
- `web/app/onboarding/page.tsx`
