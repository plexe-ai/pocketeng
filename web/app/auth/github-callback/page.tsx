'use client'

import { useEffect, useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'

function GitHubCallbackInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const from = searchParams.get('from') || 'onboarding'
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let handled = false

    // Listen for auth state change to capture provider_token and identity data
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (handled) return
      if (!session) return

      handled = true

      const providerToken = session.provider_token
      // Get username from GitHub identity (always available from Supabase)
      const ghIdentity = session.user?.identities?.find((i: any) => i.provider === 'github')
      const username = ghIdentity?.identity_data?.user_name
        || ghIdentity?.identity_data?.preferred_username
        || session.user?.user_metadata?.githubUsername

      if (username) {
        // If we have a provider token, try to verify it. If it fails (401), store username anyway.
        let validToken: string | null = null
        if (providerToken) {
          try {
            const res = await fetch('https://api.github.com/user', {
              headers: { Authorization: `Bearer ${providerToken}` },
            })
            if (res.ok) validToken = providerToken
          } catch { /* token invalid, skip */ }
        }

        await supabase.auth.updateUser({
          data: {
            githubUsername: username,
            ...(validToken ? { githubToken: validToken } : {}),
          },
        })
      }

      const dest = from === 'settings' ? '/dashboard/settings'
        : from === 'signin' ? '/dashboard'
        : '/onboarding'
      router.replace(dest)
    })

    // Fallback: if no auth event fires within 5s, try getSession directly
    const timeout = setTimeout(async () => {
      if (handled) return
      handled = true
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        setError('Session not found. Please try again.')
        return
      }
      const dest = from === 'settings' ? '/dashboard/settings'
        : from === 'signin' ? '/dashboard'
        : '/onboarding'
      router.replace(dest)
    }, 5000)

    return () => {
      subscription.unsubscribe()
      clearTimeout(timeout)
    }
  }, [router, from])

  if (error) {
    const dest = from === 'settings' ? '/dashboard/settings'
        : from === 'signin' ? '/dashboard'
        : '/onboarding'
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center gap-4 px-6 page-gradient">
        <p className="text-danger text-[13px]">{error}</p>
        <button
          onClick={() => router.replace(dest)}
          className="btn btn-ghost text-[13px] cursor-pointer"
        >
          Go back
        </button>
      </div>
    )
  }

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center gap-4 page-gradient">
      <div className="relative">
        <span className="block w-6 h-6 border-2 border-l3 border-t-accent rounded-full animate-spin" />
        <div className="absolute -inset-2 rounded-full bg-accent/[0.06] blur-lg -z-10" />
      </div>
      <p className="text-secondary text-[13px]">Connecting GitHub&hellip;</p>
    </div>
  )
}

export default function GitHubCallback() {
  return (
    <Suspense
      fallback={
        <div className="min-h-dvh flex items-center justify-center page-gradient">
          <span className="block w-6 h-6 border-2 border-l3 border-t-accent rounded-full animate-spin" />
        </div>
      }
    >
      <GitHubCallbackInner />
    </Suspense>
  )
}
