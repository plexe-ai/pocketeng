'use client'

import { useEffect, useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { consumeLinearOAuthState } from '@/lib/linear-oauth'

type LinearTeam = { id: string; name: string; key: string }

type LinearRegisterResult = {
  ok?: boolean
  verified?: boolean
  labelCreated?: boolean
  webhookCreated?: boolean
  setupErrors?: string[]
  error?: string
}

function LinearCallbackInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let handled = false

    async function handle() {
      if (handled) return
      handled = true

      const code = searchParams.get('code')
      const errorParam = searchParams.get('error')
      const returnedState = searchParams.get('state')

      const expectedState = consumeLinearOAuthState()
      if (!returnedState || !expectedState || returnedState !== expectedState) {
        setError('Could not verify the Linear sign-in request. Please try connecting Linear again.')
        return
      }

      if (errorParam) {
        setError(`Linear denied access: ${errorParam}`)
        return
      }
      if (!code) {
        setError('No authorization code received.')
        return
      }

      try {
        await new Promise(r => setTimeout(r, 500))

        const { data: { session } } = await supabase.auth.getSession()
        if (!session) {
          setError('Your session expired during the redirect. Please sign in and try connecting Linear again.')
          return
        }

        const exchangeRes = await fetch('/api/linear/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code,
            redirectUri: 'https://console.pocketeng.ai/auth/linear-callback',
          }),
        })

        if (!exchangeRes.ok) {
          const data = await exchangeRes.json().catch(() => ({}))
          throw new Error(data.error || 'Token exchange failed')
        }

        const { accessToken } = await exchangeRes.json()

        const viewerRes = await fetch('https://api.linear.app/graphql', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': accessToken,
          },
          body: JSON.stringify({
            query: `{ viewer { name email } teams { nodes { id name key } } }`,
          }),
        })

        const viewerPayload = await viewerRes.json().catch(() => ({}))
        if (!viewerRes.ok) {
          const gqlError = viewerPayload?.errors?.[0]?.message
          throw new Error(gqlError || 'Could not verify your Linear account. Please try again.')
        }

        const linearName = viewerPayload.data?.viewer?.name ?? ''
        const linearTeams: LinearTeam[] = viewerPayload.data?.teams?.nodes ?? []
        const primaryTeam = linearTeams[0]

        if (!primaryTeam) {
          throw new Error('Your Linear account connected, but no team was available to configure Pocket Engineer.')
        }

        const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL
        if (!apiBase) {
          throw new Error('Pocket Engineer is missing its API configuration, so Linear setup could not be verified.')
        }

        const { data: { session: authSession } } = await supabase.auth.getSession()
        if (!authSession?.access_token) {
          throw new Error('Your session expired before Linear setup could be verified. Please sign in and try again.')
        }

        const registerRes = await fetch(`${apiBase}/linear/register`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authSession.access_token}`,
          },
          body: JSON.stringify({
            linearTeamId: primaryTeam.key,
            linearTeamUuid: primaryTeam.id,
            accessToken,
          }),
        })

        const registerData: LinearRegisterResult = await registerRes.json().catch(() => ({}))
        if (!registerRes.ok) {
          throw new Error(registerData.error || 'Pocket Engineer could not finish connecting to Linear.')
        }

        if (!registerData.verified) {
          const setupMessage = registerData.setupErrors?.find(Boolean)
            || 'Pocket Engineer could not verify the Linear label and webhook setup.'
          throw new Error(`Linear connected, but setup verification failed: ${setupMessage}`)
        }

        const { error: updateError } = await supabase.auth.updateUser({
          data: {
            linearAccessToken: accessToken,
            linearName,
            linearTeamId: primaryTeam.key,
            linearTeams: linearTeams.map(team => ({ id: team.id, name: team.name, key: team.key })),
          },
        })

        if (updateError) {
          throw new Error(`Failed to save: ${updateError.message}`)
        }

        router.replace('/dashboard/integrations')
      } catch (e) {
        setError((e as Error).message)
      }
    }

    handle()
  }, [router, searchParams])

  if (error) {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center gap-4 px-6 page-gradient">
        <p className="text-danger text-[13px] text-center max-w-sm">{error}</p>
        <div className="flex gap-3">
          <button
            onClick={() => router.replace('/dashboard/integrations')}
            className="btn btn-ghost text-[13px] cursor-pointer"
          >
            Back to Integrations
          </button>
          <button
            onClick={() => router.replace('/')}
            className="btn btn-secondary text-[13px] cursor-pointer"
          >
            Sign in
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center gap-4 page-gradient">
      <div className="relative">
        <span className="block w-6 h-6 border-2 border-l3 border-t-accent rounded-full animate-spin" />
        <div className="absolute -inset-2 rounded-full bg-accent/[0.06] blur-lg -z-10" />
      </div>
      <p className="text-secondary text-[13px]">Connecting Linear&hellip;</p>
    </div>
  )
}

export default function LinearCallback() {
  return (
    <Suspense
      fallback={
        <div className="min-h-dvh flex items-center justify-center page-gradient">
          <span className="block w-6 h-6 border-2 border-l3 border-t-accent rounded-full animate-spin" />
        </div>
      }
    >
      <LinearCallbackInner />
    </Suspense>
  )
}
