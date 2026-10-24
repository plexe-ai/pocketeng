import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  const { code, redirectUri } = await req.json()

  if (!code || !redirectUri) {
    return NextResponse.json({ error: 'code and redirectUri required' }, { status: 400 })
  }

  const clientId = process.env.NEXT_PUBLIC_LINEAR_CLIENT_ID
  const clientSecret = process.env.LINEAR_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    return NextResponse.json({ error: 'Linear OAuth not configured' }, { status: 500 })
  }

  const res = await fetch('https://api.linear.app/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    console.error('Linear token exchange failed:', res.status, text)
    return NextResponse.json({ error: 'Token exchange failed' }, { status: 502 })
  }

  const data = await res.json()

  return NextResponse.json({
    accessToken: data.access_token,
    tokenType: data.token_type,
    expiresIn: data.expires_in,
    scope: data.scope,
  })
}
