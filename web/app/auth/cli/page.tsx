'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'

export default function CLIAuthPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-ink">
        <div className="w-5 h-5 border-2 border-line border-t-accent rounded-full animate-spin" />
      </div>
    }>
      <CLIAuthContent />
    </Suspense>
  )
}

function CLIAuthContent() {
  const searchParams = useSearchParams()
  const port = searchParams.get('port')
  const [status, setStatus] = useState<'checking' | 'signing-in' | 'sending' | 'error'>('checking')
  const [error, setError] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [magicSent, setMagicSent] = useState(false)

  // Redirect the browser to the CLI's local server to deliver the token
  function sendTokenToCLI(token: string) {
    if (!port) { setError('No port specified'); setStatus('error'); return }
    setStatus('sending')
    window.location.href = `http://localhost:${port}/callback?token=${encodeURIComponent(token)}`
  }

  // Check for existing session on mount
  useEffect(() => {
    if (!port) { setError('Missing port parameter'); setStatus('error'); return }

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.access_token) {
        sendTokenToCLI(session.access_token)
      } else {
        setStatus('signing-in')
      }
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.access_token && status !== 'sending') {
        sendTokenToCLI(session.access_token)
      }
    })
    return () => subscription.unsubscribe()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [port])

  async function handleGoogleSignIn() {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/cli?port=${port}` },
    })
    if (error) setError(error.message)
  }

  async function handleGitHubSignIn() {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'github',
      options: {
        scopes: 'repo',
        redirectTo: `${window.location.origin}/auth/cli?port=${port}`,
      },
    })
    if (error) setError(error.message)
  }

  async function handleMagicLink() {
    if (!email) return
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/cli?port=${port}` },
    })
    if (error) { setError(error.message); return }
    setMagicSent(true)
  }

  if (status === 'checking') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-ink">
        <div className="w-5 h-5 border-2 border-line border-t-accent rounded-full animate-spin" />
      </div>
    )
  }

  if (status === 'sending') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-ink">
        <div className="text-center">
          <div className="w-5 h-5 border-2 border-line border-t-accent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-secondary text-sm">Connecting to CLI...</p>
        </div>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-ink">
        <div className="text-center max-w-sm">
          <h1 className="text-bright text-lg font-semibold mb-2">Connection Failed</h1>
          <p className="text-secondary text-sm">{error}</p>
        </div>
      </div>
    )
  }

  // signing-in state: show auth buttons
  return (
    <div className="min-h-screen flex items-center justify-center bg-ink">
      <div className="w-full max-w-sm px-6">
        <div className="text-center mb-8">
          <h1 className="text-bright text-xl font-semibold mb-2">Sign in to Pocket Eng</h1>
          <p className="text-secondary text-sm">Connecting your CLI to your account</p>
        </div>

        <div className="flex flex-col gap-3">
          <button
            onClick={handleGoogleSignIn}
            className="btn btn-secondary w-full flex items-center justify-center gap-2"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24"><path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
            Continue with Google
          </button>

          <button
            onClick={handleGitHubSignIn}
            className="btn btn-secondary w-full flex items-center justify-center gap-2"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
            Continue with GitHub
          </button>

          <div className="flex items-center gap-3 my-2">
            <div className="flex-1 h-px bg-line" />
            <span className="text-tertiary text-xs">or</span>
            <div className="flex-1 h-px bg-line" />
          </div>

          {magicSent ? (
            <p className="text-center text-sm text-accent">Check your email for a sign-in link.</p>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); handleMagicLink() }} className="flex gap-2">
              <input
                type="email"
                placeholder="Email address"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="input flex-1"
              />
              <button type="submit" className="btn btn-primary">Send link</button>
            </form>
          )}
        </div>

        {error && (
          <p className="text-red-400 text-xs text-center mt-4">{error}</p>
        )}
      </div>
    </div>
  )
}
