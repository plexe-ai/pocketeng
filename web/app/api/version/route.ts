import { NextResponse } from 'next/server'

/**
 * GET /api/version — returns a unique identifier for the current Vercel
 * deployment. Used by Capacitor iOS/Android shells to detect when a new
 * frontend has shipped and force-reload to bust the WKWebView/WebView
 * HTML cache.
 *
 * Why this exists:
 *   WKWebView (Capacitor on iOS) aggressively caches the loaded HTML
 *   across app relaunches. When a new web deploy goes out, a chunk of
 *   users get the *old* HTML with references to JS chunks that no
 *   longer exist — renders weirdly, throws 404s on chunk loads, or
 *   (observed in production) layers old + new pages on top of each
 *   other. Reinstalling the app clears the WebView cache and fixes it,
 *   but users don't know to reinstall.
 *
 *   This endpoint gives the client a lightweight way to check "am I on
 *   the latest build?" on app cold-start. The client compares against
 *   a value it cached in localStorage, and if they differ, reloads the
 *   page (which pulls fresh HTML + fresh chunk references).
 *
 * Identifier source — falls through in this order:
 *   1. `VERCEL_GIT_COMMIT_SHA`   — the commit that built this deploy;
 *                                   Vercel sets this automatically on
 *                                   production builds.
 *   2. `VERCEL_DEPLOYMENT_ID`    — the opaque Vercel deployment ID;
 *                                   also auto-set but less readable.
 *   3. `NEXT_PUBLIC_BUILD_ID`    — manual override for local dev.
 *   4. `'dev'` fallback          — running `next dev` locally.
 *
 * Response headers explicitly disable caching — we never want a CDN
 * to hold onto this value longer than one request. The whole point is
 * "ask the origin what version it's on RIGHT NOW."
 */

// IMPORTANT: use truthy fall-through, not `??`. Vercel CLI deploys
// populate `VERCEL_GIT_COMMIT_SHA` with an empty string (not undefined)
// when the deploy isn't tied to a Git push, which defeated the
// nullish-coalescing operator and shipped `{"buildId":""}` in prod.
// A first-pick() that rejects empty + whitespace handles both cases.
function firstNonEmpty(...values: Array<string | undefined>): string | null {
  for (const v of values) {
    const trimmed = (v ?? '').trim()
    if (trimmed) return trimmed
  }
  return null
}

const BUILD_ID =
  firstNonEmpty(
    process.env.VERCEL_GIT_COMMIT_SHA,
    process.env.VERCEL_DEPLOYMENT_ID,
    process.env.NEXT_PUBLIC_BUILD_ID,
  )
  // Final fallback — build-time timestamp. Guarantees a non-empty
  // unique-per-build id even when all the env sources are stripped
  // (e.g. local `next dev`, or a CLI deploy that didn't populate
  // the Vercel-provided variables). Evaluated once at module load.
  ?? `build-${Date.now()}`

// Compute once at module-load time (safe — this file runs per-instance
// at cold-start; the build ID can't change within a process lifetime).
const RESPONSE_BODY = { buildId: BUILD_ID }

export async function GET() {
  return NextResponse.json(RESPONSE_BODY, {
    headers: {
      // `no-store` on BOTH the browser and any shared cache. The
      // response is tiny (~40 bytes) — the round-trip cost is trivial
      // compared to the value of never serving stale.
      'Cache-Control': 'no-store, max-age=0, must-revalidate',
      // Belt-and-suspenders for Cloudflare / older proxies that only
      // respect the non-standard Pragma header.
      Pragma: 'no-cache',
    },
  })
}
