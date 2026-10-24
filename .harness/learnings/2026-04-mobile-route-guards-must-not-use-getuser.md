---
type: learning
status: canonical
last_reviewed: 2026-04-27
related:
  - playbooks/browser-testing.md
tags: [learning, mobile, auth, supabase, getuser, getsession, dashboard]
---

# Mobile Route Guards Must Not Use `getUser()` (2026-04)

**When to read:** before touching dashboard auth guards, any client-side
`router.replace('/')` on auth failure, or `web/lib/supabase.ts`.
**When to update:** never edit the story. Add cross-links at the bottom
as new related scars appear.

## One-line

Several dashboard pages used `supabase.auth.getUser()` as the thing
that decided "still signed in or not." On mobile, that was wrong:
`getUser()` is a live network read, so a transient resume / refresh
failure looked like "logged out" and bounced the user to `/`.

## Symptom

- User is already signed in inside the iOS / Android app.
- They open a dashboard route such as workspace chat, Sessions,
  Integrations, Agents, or Settings.
- On a cold open, after app resume, or during brief network churn,
  the app suddenly routes back to the landing / login page.
- Signing in again works, which is the clue that the session was not
  actually gone; the guard was.

The bug shape is "mobile feels randomly logged out" even though the
persisted Supabase session is still present locally.

## Root cause

We had multiple mount effects shaped like this:

```tsx
supabase.auth.getUser().then(({ data: { user } }) => {
  if (!user) { router.replace('/'); return }
  // load route data
})
```

That is safe only if `getUser()` is a stable local read. It is not.
`getUser()` is the authenticated network round-trip to Supabase. On
mobile resume, token refresh and network recovery are exactly the
moments most likely to be flaky. A null / failed `getUser()` there
does **not** prove the persisted session is gone.

The correct primitive for a client route guard is the restored session
snapshot from `getSession()`, because that comes from the locally
persisted auth state first and does not eject the user for a transient
network wobble.

## Fix

Add a tiny helper in [`../../web/lib/supabase.ts`](../../web/lib/supabase.ts):

```ts
export async function getRestoredSession() {
  const { data: { session } } = await supabase.auth.getSession()
  return session
}
```

Then use that helper for dashboard route guards:

- [`../../web/app/dashboard/page.tsx`](../../web/app/dashboard/page.tsx)
- [`../../web/app/dashboard/[serverId]/page.tsx`](../../web/app/dashboard/[serverId]/page.tsx)
- [`../../web/app/dashboard/sessions/page.tsx`](../../web/app/dashboard/sessions/page.tsx)
- [`../../web/app/dashboard/integrations/page.tsx`](../../web/app/dashboard/integrations/page.tsx)
- [`../../web/app/dashboard/agents/page.tsx`](../../web/app/dashboard/agents/page.tsx)
- [`../../web/app/dashboard/settings/page.tsx`](../../web/app/dashboard/settings/page.tsx)

Settings still does a best-effort `getUser()` afterward, but only to
refresh identity details like Apple / GitHub linkage **after** the
session has already proved the user is authenticated.

## Evidence

- `cd web && npm run build` stayed green after the guard swap.
- A grep pass confirmed the dashboard routes that redirect to `/`
  no longer tie that redirect to `getUser()`.

No real-device browser pass was run in this session, so the manual flow
below is still the right regression check.

## How to catch a regression fast

On the mobile app:

1. Sign in once.
2. Visit workspace chat, then Sessions, Integrations, Agents, and Settings.
3. Background the app and return, or briefly toggle network.
4. Re-open those routes.

Expected: the app may show stale data briefly or a fetch error, but it
must not jump back to `/` unless a real sign-out happened.

## Subtle traps to avoid

- **Do not use `getUser()` as a route guard.** It is a freshness check,
  not the local source of truth.
- **Best-effort refreshes are fine after auth is proven.** Settings is
  allowed to call `getUser()` for identities because failure there no
  longer means "redirect to login."
- **Don't hide real sign-outs.** The lesson is not "never redirect." It
  is "redirect only when the restored session is actually absent, or
  when an explicit sign-out event fires."

## See also

- [`../../web/lib/supabase.ts`](../../web/lib/supabase.ts) — the helper
  that centralizes the route-guard primitive
- [`../../web/app/dashboard/settings/page.tsx`](../../web/app/dashboard/settings/page.tsx)
  — example of "prove auth with session, then refresh user details"

## Referenced by

- `web/lib/supabase.ts`
- `web/app/dashboard/page.tsx`
- `web/app/dashboard/[serverId]/page.tsx`
- `web/app/dashboard/sessions/page.tsx`
- `web/app/dashboard/integrations/page.tsx`
- `web/app/dashboard/agents/page.tsx`
- `web/app/dashboard/settings/page.tsx`
