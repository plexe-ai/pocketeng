'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { isNative, isDesktop } from '@/lib/native'
import AuthViewportShell from '@/components/AuthViewportShell'

// Supabase persists the session as `sb-<project-ref>-auth-token` in
// localStorage. Presence of ANY such key ≈ "there's a cached session
// worth validating" — which lets us decide synchronously at mount time
// whether to render the auth card or suppress it until getSession
// resolves. This is the difference between: (a) signed-in user on
// returning visit sees a brief flash of the sign-in card before the
// redirect fires, and (b) they see nothing and land on dashboard.
function hasCachedSupabaseSession(): boolean {
  if (typeof window === 'undefined') return false
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) {
        // Be slightly more careful than presence — Supabase writes a
        // stringified token object; empty string means signed out.
        const raw = localStorage.getItem(key)
        if (raw && raw.length > 10) return true
      }
    }
  } catch { /* private-mode browsers throw on localStorage access */ }
  return false
}

export default function LandingPage() {
  const router = useRouter()
  // Start in "loading" state ONLY if there's evidence of a cached session
  // — otherwise show the auth card immediately on first paint (no spinner,
  // no flash). getSession() below still runs to handle the edge case where
  // localStorage says there's a session but it's actually invalid.
  const [loading, setLoading]     = useState(() => hasCachedSupabaseSession())
  const [signingIn, setSigningIn] = useState(false)
  const [email, setEmail]         = useState('')
  const [password, setPassword]   = useState('')
  const [authMode, setAuthMode]   = useState<'signin' | 'signup'>('signin')
  const [magicSent, setMagicSent] = useState(false)
  const [error, setError]         = useState<string | null>(null)
  const [confirmEmail, setConfirmEmail] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        router.replace(session.user.user_metadata?.onboarded ? '/dashboard' : '/onboarding')
      } else {
        setLoading(false)
      }
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' && session) {
        router.replace(session.user.user_metadata?.onboarded ? '/dashboard' : '/onboarding')
      }
    })
    return () => subscription.unsubscribe()
  }, [router])

  function getRedirectUrl(path: string) {
    const base = typeof window !== 'undefined' ? window.location.origin : ''
    return `${base}${path}`
  }

  function getEmailAuthRedirectUrl() {
    if (!isDesktop) return getRedirectUrl('/auth/callback')
    return getRedirectUrl('/auth/native-callback?client=desktop')
  }

  async function handleOAuthSignIn(provider: 'apple' | 'google' | 'github', params?: {
    redirectPath?: string
    scopes?: string
  }) {
    setError(null)
    setSigningIn(true)

    // Both Capacitor (iOS/Android) and the Electron desktop shell use the
    // native-callback bridge. Desktop tags the redirect with `client=desktop`
    // so the bridge page routes to `pocketeng-desktop://` instead of the
    // mobile `com.pocketengineer.coder://` scheme.
    const isShell = isNative || isDesktop
    const options = {
      redirectTo: isShell
        ? `https://console.pocketeng.ai/auth/native-callback?provider=${encodeURIComponent(provider)}${
            isDesktop ? '&client=desktop' : ''
          }`
        : getRedirectUrl(params?.redirectPath ?? `/auth/callback?provider=${provider}`),
      ...(params?.scopes ? { scopes: params.scopes } : {}),
    }

    if (isShell) {
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          ...options,
          skipBrowserRedirect: true,
        },
      })
      if (error) { setError(error.message); setSigningIn(false); return }
      if (data?.url) {
        if (isDesktop) {
          // Electron routes window.open to shell.openExternal → system browser.
          // Keeps the user signed in to Google/Apple/GitHub in their real browser.
          window.pocketengDesktop?.openExternal(data.url)
        } else {
          const { Browser } = await import('@capacitor/browser')
          await Browser.open({ url: data.url, presentationStyle: 'popover' })
        }
      }
      setSigningIn(false)
    } else {
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options,
      })
      if (error) { setError(error.message); setSigningIn(false) }
    }
  }

  async function handleAppleSignIn() {
    await handleOAuthSignIn('apple', { redirectPath: '/auth/callback?provider=apple' })
  }

  async function handleGoogleSignIn() {
    await handleOAuthSignIn('google')
  }

  async function handleGitHubSignIn() {
    await handleOAuthSignIn('github', {
      redirectPath: '/auth/github-callback?from=signin',
      scopes: 'repo',
    })
  }

  async function runEmailPasswordAuth(form: HTMLFormElement) {
    const fd = new FormData(form)
    const em = String(fd.get('email') ?? '').trim()
    const pw = String(fd.get('password') ?? '')
    if (!em || !pw) {
      setError('Please enter your email and password.')
      return
    }
    setEmail(em)
    setPassword(pw)
    setError(null)
    setSigningIn(true)

    if (authMode === 'signup') {
      const { data, error } = await supabase.auth.signUp({
        email: em,
        password: pw,
        options: { emailRedirectTo: getEmailAuthRedirectUrl() },
      })
      setSigningIn(false)
      if (error) {
        setError(error.message)
      } else if (data.user?.identities?.length === 0) {
        setError('An account with this email already exists. Try signing in instead.')
      } else {
        setConfirmEmail(true)
      }
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email: em, password: pw })
      setSigningIn(false)
      if (error) setError(error.message)
    }
  }

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault()
    if (!email) return
    setError(null)
    setSigningIn(true)
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: getEmailAuthRedirectUrl() },
    })
    setSigningIn(false)
    if (error) setError(error.message)
    else setMagicSent(true)
  }

  if (loading) {
    // Keep the landing page in control of the full viewport during the
    // cached-session validation check. Returning null here lets stale
    // dashboard DOM remain visible on mobile, which is how users ended up
    // seeing session lists below the sign-in page.
    return <AuthViewportShell />
  }

  return (
    <AuthViewportShell>
      <div className="w-full max-w-[340px] flex flex-col gap-10 animate-fade-in-up relative z-10">

        {/* Brand */}
        <div className="flex flex-col items-center gap-4">
          <div className="relative">
            <span className="text-[26px] font-semibold text-bright tracking-tight">Pocket Eng</span>
            <div className="absolute -inset-4 bg-accent/[0.06] blur-2xl -z-10 rounded-full" />
          </div>
          <p className="text-[13px] text-secondary leading-relaxed text-center">
            Cloud dev workspaces,<br />connect from anywhere
          </p>
        </div>

        {/* Auth card */}
        <div className="card-surface p-6 flex flex-col gap-4">
          {/* Apple */}
          <button
            onClick={handleAppleSignIn}
            disabled={signingIn}
            className="btn btn-apple w-full h-[42px]"
          >
            {signingIn ? (
              <div className="w-4 h-4 border-2 border-white/25 border-t-white rounded-full animate-spin" />
            ) : (
              <svg className="w-[15px] h-[15px]" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M16.365 1.43c0 1.14-.415 2.02-1.244 2.907-.83.879-1.827 1.385-2.915 1.296-.133-1.094.425-2.218 1.162-2.997.81-.86 1.93-1.475 2.997-1.206zM20.53 17.51c-.42.974-.62 1.408-1.16 2.292-.754 1.234-1.821 2.772-3.145 2.784-1.174.012-1.476-.764-3.07-.754-1.596.008-1.927.768-3.102.756-1.324-.012-2.336-1.395-3.09-2.629-2.11-3.456-2.333-7.512-1.03-9.514.925-1.421 2.385-2.256 3.757-2.256 1.399 0 2.28.77 3.44.77 1.126 0 1.814-.772 3.428-.772 1.223 0 2.52.666 3.444 1.817-3.03 1.662-2.54 5.98.528 7.506z" />
              </svg>
            )}
            {signingIn ? 'Redirecting\u2026' : 'Sign in with Apple'}
          </button>

          {/* Google */}
          <button
            onClick={handleGoogleSignIn}
            disabled={signingIn}
            className="btn btn-secondary w-full h-[42px]"
          >
            {signingIn ? (
              <div className="w-4 h-4 border-2 border-line border-t-secondary rounded-full animate-spin" />
            ) : (
              <svg className="w-[15px] h-[15px]" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A10.96 10.96 0 001 12c0 1.77.42 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
            )}
            {signingIn ? 'Redirecting\u2026' : 'Continue with Google'}
          </button>

          {/* GitHub */}
          <button
            onClick={handleGitHubSignIn}
            disabled={signingIn}
            className="btn btn-secondary w-full h-[42px]"
          >
            {signingIn ? (
              <div className="w-4 h-4 border-2 border-line border-t-secondary rounded-full animate-spin" />
            ) : (
              <svg className="w-[16px] h-[16px]" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.477 2 2 6.477 2 12c0 4.418 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.868-.013-1.703-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z" />
              </svg>
            )}
            {signingIn ? 'Redirecting\u2026' : 'Continue with GitHub'}
          </button>

          {/* Divider */}
          <div className="divider-text">
            <span className="text-[11px] text-tertiary select-none">or</span>
          </div>

          {/* Email / Password */}
          {(confirmEmail || magicSent) ? (
            <div className="py-3 text-center animate-fade-in">
              <div className="w-8 h-8 rounded-full bg-accent/10 flex items-center justify-center mx-auto mb-3">
                <svg className="w-4 h-4 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
                </svg>
              </div>
              <p className="text-[13px] font-medium text-accent">Check your inbox</p>
              <p className="text-[12px] text-secondary mt-1">
                {confirmEmail ? 'Confirmation email' : 'Magic link'} sent to{' '}
                <span className="text-bright font-medium">{email}</span>
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {/* Sign in / Sign up tabs */}
              <div className="flex gap-1 p-0.5 rounded-lg bg-l1 mb-1">
                <button
                  type="button"
                  onClick={() => { setAuthMode('signin'); setError(null) }}
                  className={`flex-1 text-[12px] py-1.5 rounded-md transition-all cursor-pointer ${
                    authMode === 'signin'
                      ? 'bg-l2 text-bright font-medium shadow-sm'
                      : 'text-tertiary hover:text-secondary'
                  }`}
                >
                  Sign in
                </button>
                <button
                  type="button"
                  onClick={() => { setAuthMode('signup'); setError(null) }}
                  className={`flex-1 text-[12px] py-1.5 rounded-md transition-all cursor-pointer ${
                    authMode === 'signup'
                      ? 'bg-l2 text-bright font-medium shadow-sm'
                      : 'text-tertiary hover:text-secondary'
                  }`}
                >
                  Sign up
                </button>
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  void runEmailPasswordAuth(e.currentTarget)
                }}
                className="flex flex-col gap-2.5"
              >
                <label htmlFor="signin-email" className="sr-only">Email address</label>
                <input
                  id="signin-email"
                  name="email"
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  disabled={signingIn}
                  className="input"
                  autoComplete="email"
                />
                <label htmlFor="signin-password" className="sr-only">Password</label>
                <input
                  id="signin-password"
                  name="password"
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Password"
                  disabled={signingIn}
                  className="input"
                  autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'}
                  minLength={6}
                />
                <button
                  type="button"
                  disabled={signingIn}
                  className="btn btn-secondary w-full h-[38px] text-tertiary hover:text-secondary"
                  onClick={(e) => {
                    const f = (e.currentTarget as HTMLButtonElement).closest('form')
                    if (f) void runEmailPasswordAuth(f)
                  }}
                >
                  {signingIn ? (
                    <div className="w-4 h-4 border-2 border-line border-t-secondary rounded-full animate-spin" />
                  ) : (
                    authMode === 'signup' ? 'Create account' : 'Sign in with email'
                  )}
                </button>
              </form>

              {/* Magic link fallback */}
              <button
                type="button"
                onClick={(e) => handleMagicLink(e as unknown as React.FormEvent)}
                disabled={signingIn || !email}
                className="text-[11px] text-tertiary hover:text-secondary transition-colors cursor-pointer text-center"
              >
                Send magic link instead
              </button>
            </div>
          )}

          {error && (
            <p className="text-[12px] text-danger text-center animate-fade-in">{error}</p>
          )}
        </div>

        <p className="text-[11px] text-tertiary text-center leading-relaxed">
          Your API keys are stored encrypted<br />and never shared with third parties.
        </p>
      </div>
    </AuthViewportShell>
  )
}
