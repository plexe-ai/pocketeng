'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { captureAppleOAuthCredential } from '@/lib/oauthCredentials'
import { supabase } from '@/lib/supabase'

export default function AuthCallback() {
  const router = useRouter()

  useEffect(() => {
    const provider = new URLSearchParams(window.location.search).get('provider')

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' && session) {
        void captureAppleOAuthCredential({ session, provider })
        const dest = session.user.user_metadata?.onboarded ? '/dashboard' : '/onboarding'
        router.replace(dest)
      }
    })

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        void captureAppleOAuthCredential({ session, provider })
        const dest = session.user.user_metadata?.onboarded ? '/dashboard' : '/onboarding'
        router.replace(dest)
      }
    })

    return () => subscription.unsubscribe()
  }, [router])

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center gap-4">
      <div className="relative">
        <span className="block w-6 h-6 border-2 border-l3 border-t-accent rounded-full animate-spin" />
        <div className="absolute -inset-2 rounded-full bg-accent/[0.06] blur-lg -z-10" />
      </div>
      <p className="text-secondary text-[13px]">Signing you in\u2026</p>
    </div>
  )
}
