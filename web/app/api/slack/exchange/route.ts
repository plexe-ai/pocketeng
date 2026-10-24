import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  const { code, redirectUri } = await req.json()

  if (!code || !redirectUri) {
    return NextResponse.json({ error: 'code and redirectUri required' }, { status: 400 })
  }

  const clientId = process.env.NEXT_PUBLIC_SLACK_CLIENT_ID
  const clientSecret = process.env.SLACK_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    return NextResponse.json({ error: 'Slack OAuth not configured' }, { status: 500 })
  }

  const res = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  })

  const data = await res.json()

  if (!data.ok) {
    console.error('Slack token exchange failed:', data.error)
    return NextResponse.json({ error: data.error || 'Token exchange failed' }, { status: 502 })
  }

  return NextResponse.json({
    teamName: data.team?.name ?? '',
    teamId: data.team?.id ?? '',
    channel: data.incoming_webhook?.channel ?? '',
    channelId: data.incoming_webhook?.channel_id ?? '',
    webhookUrl: data.incoming_webhook?.url ?? '',
    botToken: data.access_token ?? '',
    scope: data.scope ?? '',
  })
}
