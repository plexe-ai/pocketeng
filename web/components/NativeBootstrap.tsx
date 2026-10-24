'use client'

import { useEffect } from 'react'
import { isNative, isIOS, isAndroid, isDesktop, hideSplash, setStatusBarDark, registerPush, addPushListeners, listenForDeepLinks } from '@/lib/native'
import { captureAppleOAuthCredential } from '@/lib/oauthCredentials'
import { supabase } from '@/lib/supabase'
import { registerPushDevice } from '@/lib/api'
import { initClientLog } from '@/lib/clientLog'

/**
 * Bootstraps native features on app mount.
 * Active on Capacitor (iOS/Android) and the Electron desktop shell; no-op in a plain browser.
 */
// localStorage key where we remember the last-seen deployment ID. Bumped
// (and reload triggered) whenever /api/version returns something new.
const BUILD_ID_KEY = 'pe:build-id'
// Rate-limit: once we've force-reloaded for a cache-bust, don't do it
// again within this window. Protects against a loop if something is
// stuck (e.g. the new HTML still somehow references the old build id).
const CACHE_BUST_COOLDOWN_KEY = 'pe:last-cache-bust-at'
const CACHE_BUST_COOLDOWN_MS = 30 * 1000

/**
 * On Capacitor native shells, check whether we're running a stale cache
 * of the web frontend. WKWebView (iOS) and Android WebView aggressively
 * hold onto the old HTML across app relaunches — when we deploy a new
 * frontend, users get served the previous version's HTML, which
 * references JS chunks that no longer exist on the origin. Observed in
 * production as rendering glitches (two pages stacked, broken buttons).
 *
 * The fix: compare our cached build ID against the origin's current
 * build ID. If they differ, we know the WebView is serving stale HTML —
 * write the new ID and force a reload. The reload pulls fresh HTML
 * from the origin (served with `Cache-Control: no-store` so the WebView
 * can't cheat), which references the correct current chunks.
 *
 * Only runs on native. Plain browsers handle HTTP cache correctly via
 * normal Cache-Control; the Electron shell also doesn't exhibit this
 * specific issue. Limiting to `isNative` also means our Vercel preview
 * deploys don't trigger reloads during active testing.
 */
async function checkForStaleCache(): Promise<void> {
  try {
    const res = await fetch('/api/version', {
      // Ensure THIS fetch itself isn't served from the WebView cache.
      // Without this, the bug could be self-protecting.
      cache: 'no-store',
      // Short timeout: if the network is bad, don't block app start on
      // this check. Skipping it is fine — next launch will catch up.
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return
    const { buildId } = (await res.json()) as { buildId?: string }
    if (!buildId || typeof buildId !== 'string') return

    const cached = localStorage.getItem(BUILD_ID_KEY)
    if (!cached) {
      // First run or fresh install — just remember what we saw. Don't
      // reload: the user is already on the current build.
      localStorage.setItem(BUILD_ID_KEY, buildId)
      return
    }
    if (cached === buildId) return // Still current. No-op.

    // Mismatch means the WebView is running stale HTML. Check cooldown
    // first — if we JUST reloaded and still see a mismatch, something
    // is genuinely broken and looping won't help.
    const lastBust = Number(localStorage.getItem(CACHE_BUST_COOLDOWN_KEY) ?? '0')
    if (Date.now() - lastBust < CACHE_BUST_COOLDOWN_MS) {
      console.warn('[NativeBootstrap] build-id mismatch within cooldown — skipping reload')
      return
    }

    // Write new id FIRST so the post-reload check sees the expected
    // value and doesn't loop, then bust the cache + reload.
    localStorage.setItem(BUILD_ID_KEY, buildId)
    localStorage.setItem(CACHE_BUST_COOLDOWN_KEY, String(Date.now()))

    // Also blow away any service-worker caches (future-proof — we don't
    // ship one today but a registered SW would defeat the whole point).
    if ('caches' in window) {
      try {
        const names = await caches.keys()
        await Promise.all(names.map((n) => caches.delete(n)))
      } catch { /* fine — no SW present */ }
    }

    console.log(`[NativeBootstrap] build-id changed ${cached} → ${buildId} — reloading`)
    window.location.reload()
  } catch {
    // Any failure is non-fatal. Next cold start will catch up.
  }
}

export default function NativeBootstrap() {
  useEffect(() => {
    if (!isNative && !isDesktop) return

    // Mirror console.* to backend /debug/log so TestFlight builds emit
    // visible logs (Web Inspector is disabled on distribution-signed apps).
    // Idempotent and only active on Capacitor native; no-op on desktop.
    initClientLog()

    // Hide splash screen (Capacitor only — no-op on desktop)
    void hideSplash()

    // Set status bar to dark (Capacitor only — no-op on desktop)
    void setStatusBarDark()

    // Detect stale-HTML cache and force-reload if we've shipped a new
    // frontend since the user's last cold-start. ONLY on Capacitor
    // native — the Electron shell and plain browsers handle cache
    // correctly via HTTP semantics.
    if (isNative) {
      void checkForStaleCache()
    }

    // Handle OAuth deep link callbacks
    // iOS may deliver tokens as # fragment or ? query params (fragments can be stripped).
    // Electron always delivers ? query params via the preload bridge.
    listenForDeepLinks(async (url) => {
      // Close any open browser sheet
      try {
        const { Browser } = await import('@capacitor/browser')
        await Browser.close()
      } catch { /* browser might not be open */ }

      // Try fragment first, then query params
      const hashIndex = url.indexOf('#')
      const queryIndex = url.indexOf('?')
      const paramString = hashIndex !== -1
        ? url.substring(hashIndex + 1)
        : queryIndex !== -1
          ? url.substring(queryIndex + 1)
          : ''
      if (!paramString) return

      const params = new URLSearchParams(paramString)
      const provider = params.get('provider')
      const accessToken = params.get('access_token')
      const refreshToken = params.get('refresh_token')
      const providerToken = params.get('provider_token')
      const providerRefreshToken = params.get('provider_refresh_token')
      const from = params.get('from')

      if (accessToken && refreshToken) {
        // Connect-GitHub from settings/onboarding: hand off to github-callback
        // with tokens in the URL hash so Supabase picks up `provider_token`
        // (needed to query api.github.com for the username + store the repo
        // scope token in user_metadata). setSession alone can't restore it.
        if (from === 'settings' || from === 'onboarding') {
          window.location.href = `/auth/github-callback?from=${from}#${paramString}`
          return
        }

        // setSession returns the freshly-constructed user along with the
        // session — no need to follow up with getUser() (which is a full
        // network round-trip to Supabase). Saves one call on the OAuth
        // return path, which lives on the critical-sub-second-after-auth
        // UX window.
        const { data: sessionData, error: setSessionError } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        })
        // setSession fails when the token is expired or malformed — fairly
        // rare but possible if the deep-link sat in a retry queue too long,
        // or if Supabase rotated session keys. Send the user back to the
        // landing page instead of silently falling through to /onboarding
        // (which is what happened before when sessionData.user was null).
        if (setSessionError || !sessionData.user) {
          console.warn('[NativeBootstrap] setSession failed:', setSessionError)
          window.location.href = '/'
          return
        }
        // Apple provider token capture is fire-and-forget — the redirect
        // doesn't need to wait for it. It writes to the backend for later
        // token refresh and is non-blocking for navigation.
        void captureAppleOAuthCredential({
          provider,
          providerToken,
          providerRefreshToken,
        })
        const dest = sessionData.user.user_metadata?.onboarded ? '/dashboard' : '/onboarding'
        window.location.href = dest
      }
    })

    // Register for push notifications — wait for auth session first
    void (async () => {
      // Wait for Supabase to restore the session (may take a moment on cold start)
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        // Not signed in yet — listen for sign-in, then register
        const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event) => {
          if (event === 'SIGNED_IN') {
            subscription.unsubscribe()
            await doRegisterPush()
          }
        })
        return
      }
      await doRegisterPush()
    })()

    async function doRegisterPush() {
      console.log('[push] starting registration flow')
      const token = await registerPush()
      if (!token) {
        console.warn('[push] no token — banners will not be delivered')
        return
      }
      const platform = isIOS ? 'ios' : isAndroid ? 'android' : null
      if (!platform) {
        console.warn('[push] unsupported platform, skipping backend register')
        return
      }
      const installationId = `${platform}-${token.slice(-12)}`
      const pushEnvironment =
        process.env.NODE_ENV === 'development' ? 'sandbox' : 'production'
      try {
        const res = await registerPushDevice({
          installationId,
          token,
          platform,
          pushEnvironment,
        })
        console.log('[push] backend registered:', res.installationId, `(${pushEnvironment})`)
      } catch (err) {
        // Backend returns 503 when APNs is unconfigured in the deployed stack.
        console.warn('[push] backend registration failed:', err)
      }
    }

    void addPushListeners({
      onNotification: (data) => {
        console.log('[NativeBootstrap] push received:', data)
      },
      onAction: (data) => {
        // Deep-link to the relevant session/workspace
        const serverId = data.serverId as string | undefined
        const sessionId = data.sessionId as string | undefined
        if (serverId) {
          const url = sessionId
            ? `/dashboard/${serverId}?session=${sessionId}`
            : `/dashboard/${serverId}`
          window.location.href = url
        }
      },
    })
  }, [])

  return null
}
