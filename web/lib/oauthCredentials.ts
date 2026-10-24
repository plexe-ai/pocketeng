import type { Session, UserIdentity } from '@supabase/supabase-js'
import { syncOAuthCredential } from './api'

const APPLE_STORAGE_KEY = 'pe.oauth.apple'

type StoredAppleCredential = {
  providerToken?: string
  providerRefreshToken?: string
  updatedAt: number
}

function isAppleIdentity(identity: UserIdentity | null | undefined) {
  return identity?.provider === 'apple'
}

export function hasAppleIdentity(identities?: UserIdentity[] | null): boolean {
  return (identities ?? []).some(isAppleIdentity)
}

export function saveAppleOAuthCredential(tokens: {
  providerToken?: string | null
  providerRefreshToken?: string | null
}) {
  if (typeof window === 'undefined') return

  const payload: StoredAppleCredential = {
    updatedAt: Date.now(),
    ...(tokens.providerToken ? { providerToken: tokens.providerToken } : {}),
    ...(tokens.providerRefreshToken ? { providerRefreshToken: tokens.providerRefreshToken } : {}),
  }

  if (!payload.providerToken && !payload.providerRefreshToken) return
  window.localStorage.setItem(APPLE_STORAGE_KEY, JSON.stringify(payload))
}

export function getAppleOAuthCredential(): StoredAppleCredential | null {
  if (typeof window === 'undefined') return null

  const raw = window.localStorage.getItem(APPLE_STORAGE_KEY)
  if (!raw) return null

  try {
    return JSON.parse(raw) as StoredAppleCredential
  } catch {
    return null
  }
}

export function clearAppleOAuthCredential() {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(APPLE_STORAGE_KEY)
}

export async function captureAppleOAuthCredential(params: {
  session?: Session | null
  provider?: string | null
  providerToken?: string | null
  providerRefreshToken?: string | null
}) {
  const provider = params.provider ?? null
  const isApple = provider === 'apple' || hasAppleIdentity(params.session?.user?.identities)
  if (!isApple) return

  const providerToken = params.providerToken ?? params.session?.provider_token ?? null
  const providerRefreshToken = params.providerRefreshToken ?? params.session?.provider_refresh_token ?? null
  if (!providerToken && !providerRefreshToken) return

  saveAppleOAuthCredential({ providerToken, providerRefreshToken })

  try {
    await syncOAuthCredential({
      provider: 'apple',
      ...(providerToken ? { providerToken } : {}),
      ...(providerRefreshToken ? { providerRefreshToken } : {}),
    })
  } catch (err) {
    console.warn('[oauthCredentials] failed to sync Apple credential:', err)
  }
}
