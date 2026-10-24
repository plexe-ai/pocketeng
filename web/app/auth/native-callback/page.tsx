'use client'

import { useEffect } from 'react'

/**
 * Bridge page for native OAuth callbacks (iOS/Android + desktop).
 *
 * Flow:
 * 1. Client (Capacitor on iOS, Electron on desktop) opens Supabase OAuth in
 *    SFSafariViewController / system browser.
 * 2. Supabase redirects here with tokens in `#` fragment.
 * 3. This page converts `#` → `?` (custom URL schemes strip fragments on iOS)
 *    and redirects to the right scheme for the originating client:
 *      - iOS (default)    → com.pocketengineer.coder://callback?...
 *      - Desktop Electron → pocketeng-desktop://callback?...
 *    Desktop uses its own scheme so mobile simulators / native mobile shells
 *    cannot claim desktop OAuth callbacks.
 * 4. The app's deep-link handler picks up the tokens.
 */
export default function NativeCallback() {
  useEffect(() => {
    const hash = window.location.hash.substring(1)
    if (!hash) return

    const params = new URLSearchParams(hash)
    const searchParams = new URLSearchParams(window.location.search)
    const accessToken = params.get('access_token')
    const refreshToken = params.get('refresh_token')
    const provider = searchParams.get('provider')
    const providerToken = params.get('provider_token')
    const providerRefreshToken = params.get('provider_refresh_token')
    const from = searchParams.get('from')

    if (accessToken && refreshToken) {
      const redirectParams = new URLSearchParams({
        access_token: accessToken,
        refresh_token: refreshToken,
      })
      if (provider) redirectParams.set('provider', provider)
      if (providerToken) redirectParams.set('provider_token', providerToken)
      if (providerRefreshToken) redirectParams.set('provider_refresh_token', providerRefreshToken)
      if (from) redirectParams.set('from', from)

      const client = searchParams.get('client')
      const scheme = client === 'desktop'
        ? 'pocketeng-desktop'
        : 'com.pocketengineer.coder'

      window.location.href = `${scheme}://callback?${redirectParams.toString()}`
    }
  }, [])

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center gap-4">
      <div className="relative">
        <span className="block w-6 h-6 border-2 border-l3 border-t-accent rounded-full animate-spin" />
        <div className="absolute -inset-2 rounded-full bg-accent/[0.06] blur-lg -z-10" />
      </div>
      <p className="text-secondary text-[13px]">Completing sign-in…</p>
    </div>
  )
}
