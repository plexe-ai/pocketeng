'use client'

import { useEffect, useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { consumeSlackOAuthState } from '@/lib/slack-oauth'

type SlackExchangeResult = {
  teamName?: string
  teamId?: string
  channel?: string
  webhookUrl?: string
  botToken?: string
  error?: string
}

function SlackCallbackInner() {
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

      const expectedState = consumeSlackOAuthState()
      if (!returnedState || !expectedState || returnedState !== expectedState) {
        setError('Could not verify the Slack sign-in request. Please try connecting Slack again.')
        return
      }

      if (errorParam) {
        setError(`Slack denied access: ${errorParam}`)
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
          setError('Your session expired during the redirect. Please sign in and try connecting Slack again.')
          return
        }

        const exchangeRes = await fetch('/api/slack/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code,
            redirectUri: 'https://console.pocketeng.ai/auth/slack-callback',
          }),
        })

        const exchangeData: SlackExchangeResult = await exchangeRes.json().catch(() => ({}))
        if (!exchangeRes.ok) {
          throw new Error(exchangeData.error || 'Token exchange failed')
        }

        const teamId = exchangeData.teamId ?? ''
        const webhookUrl = exchangeData.webhookUrl ?? ''
        const botToken = exchangeData.botToken ?? ''
        const teamName = exchangeData.teamName ?? ''
        const channel = exchangeData.channel ?? ''

        if (!teamId || !webhookUrl || !botToken) {
          throw new Error('Slack connected, but Pocket Engineer did not receive the workspace details it needs to finish setup.')
        }

        const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL
        if (!apiBase) {
          throw new Error('Pocket Engineer is missing its API configuration, so Slack setup could not be verified.')
        }

        const { data: { session: authSession } } = await supabase.auth.getSession()
        if (!authSession?.access_token) {
          throw new Error('Your session expired before Slack setup could be verified. Please sign in and try again.')
        }

        const registerRes = await fetch(`${apiBase}/slack/register`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authSession.access_token}`,
          },
          body: JSON.stringify({ slackTeamId: teamId, botToken }),
        })

        const registerData = await registerRes.json().catch(() => ({}))
        if (!registerRes.ok) {
          throw new Error(registerData.error || 'Pocket Engineer could not finish connecting to Slack.')
        }

        const { error: updateError } = await supabase.auth.updateUser({
          data: {
            slackWebhookUrl: webhookUrl,
            slackBotToken: botToken,
            slackTeamName: teamName,
            slackTeamId: teamId,
            slackChannel: channel,
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
        <button
          onClick={() => router.replace('/dashboard/integrations')}
          className="btn btn-ghost text-[13px] cursor-pointer"
        >
          Back to Integrations
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
      <p className="text-secondary text-[13px]">Connecting Slack&hellip;</p>
    </div>
  )
}

export default function SlackCallback() {
  return (
    <Suspense
      fallback={
        <div className="min-h-dvh flex items-center justify-center page-gradient">
          <span className="block w-6 h-6 border-2 border-l3 border-t-accent rounded-full animate-spin" />
        </div>
      }
    >
      <SlackCallbackInner />
    </Suspense>
  )
}
