'use client'

// Onboarding = 3 steps (down from 4 pre-quickstart):
//   1. "Start building" — one big button + optional GitHub repo picker
//      (shown only if the user has a connected GitHub token). Click →
//      provision a workspace in trial mode (PE's shared Anthropic key,
//      injected server-side). No agent-connect step, no API-key paste.
//   2. Provisioning — inline progress (reuses ProvisionProgress).
//   3. Install iOS app (QR code) + Finish. Kept — the user explicitly
//      wanted it retained for web users who'd benefit from moving to mobile.
//
// Skipped entirely if:
//   - User already has a workspace (short-circuits straight to step 3,
//     or past it on native shells since they're already on mobile).
//   - User is on a native shell AND already has a workspace (skip to
//     /dashboard — iOS QR is meaningless if you're already in the app).
//
// Agent credentials: users who have connected their own Claude / Codex /
// Cursor credentials via the desktop import or the Settings flow are
// recognized by `listAgentCredentials` — we do NOT set trial=true for
// them, so they keep using their own subscription. Users with no
// credentials get the trial path automatically.

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getRestoredSession, supabase } from '@/lib/supabase'
import { isNative, isDesktop, hapticMedium } from '@/lib/native'
import {
  listAgentCredentials,
  listServers,
  provisionServer,
  getServer,
  triggerWelcomeEmail,
  type Readiness,
} from '@/lib/api'
import { RepoQuickPicker } from '@/components/RepoQuickPicker'
import { ProvisionProgress } from '@/components/ProvisionProgress'
import AuthViewportShell from '@/components/AuthViewportShell'

type Step = 1 | 2 | 3
const TOTAL_STEPS = 3

// App Store URL the iOS-app QR code encodes. Hard-coded — rarely changes.
const IOS_APP_URL = 'https://apps.apple.com/gb/app/pocketeng/id6760352319'

// How long to wait between getServer() polls while watching readiness.
const POLL_MS = 3_000

export default function OnboardingPage() {
  const router = useRouter()
  const [mounted, setMounted] = useState(false)
  const [step, setStep] = useState<Step>(1)

  // Step 1 — signals we use to compose the provision request.
  const [ghUsername, setGhUsername] = useState<string | null>(null)
  const [ghToken, setGhToken] = useState<string | null>(null)
  // True if the user has connected at least one agent credential of their
  // own (Claude / Codex / Cursor). Decides whether we set trial=true on
  // the provision call — we never silently replace a user's own key.
  const [hasUserAgentCreds, setHasUserAgentCreds] = useState(false)

  // Step 2 — provisioning state.
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null)
  const [provisionedServerId, setProvisionedServerId] = useState<string | null>(null)
  const [provisioning, setProvisioning] = useState(false)
  const [readiness, setReadiness] = useState<Readiness | null>(null)
  const [provisionError, setProvisionError] = useState<string | null>(null)

  // Step 3 — finishing.
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setMounted(true)
    let cancelled = false

    // Resume at the most-advanced valid step. Three signals in parallel:
    //   - user metadata (GitHub username + token)
    //   - agent credentials table (do they have their own Claude key?)
    //   - existing servers (do they already have a workspace?)
    ;(async () => {
      // getRestoredSession() instead of getUser() — onboarding gets
      // hit immediately after sign-in on mobile, exactly the moment
      // when network can be flaky and a getUser() round-trip can
      // fail. Failure here would put the user back at step 0 even
      // when their persisted session knows their onboarding state.
      // See learnings/2026-04-mobile-route-guards-must-not-use-getuser.md.
      const [session, credsRes, serversRes] = await Promise.all([
        getRestoredSession(),
        listAgentCredentials().catch(() => ({ credentials: [] })),
        listServers().catch(() => ({ servers: [] })),
      ])
      if (cancelled) return

      const meta = session?.user.user_metadata ?? {}
      setGhUsername(meta.githubUsername ?? null)
      setGhToken(meta.githubToken ?? null)

      // Fire-and-forget: ping the welcome-email endpoint. Backend is
      // idempotent (gated by user_metadata.welcomeEmailSent), so
      // multiple onboarding visits result in a single email. Errors
      // are silent — this is best-effort and shouldn't block the UI.
      if (!meta.welcomeEmailSent) {
        void triggerWelcomeEmail()
      }

      const creds = credsRes?.credentials ?? []
      setHasUserAgentCreds(creds.length > 0)

      const hasServer = Array.isArray(serversRes?.servers) && serversRes.servers.length > 0
      if (hasServer) {
        // Existing user re-entering onboarding. Native shells get
        // bounced straight to /dashboard — the iOS-install QR is
        // meaningless if you're already in the app. Web users land
        // on step 3 so the QR is available if they want to move to
        // mobile.
        if (isNative) {
          await supabase.auth.updateUser({ data: { onboarded: true } }).catch(() => {})
          router.replace('/dashboard')
          return
        }
        setStep(3)
      }
    })()

    // Pick up GitHub linkage after the OAuth deep-link callback updates
    // the session in place (Capacitor / Electron paths don't navigate
    // away from this page; web does and remounts naturally). Without
    // this, the "Connect GitHub" button would stay visible after the
    // user has actually connected.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (cancelled) return
      const meta = session?.user.user_metadata ?? {}
      setGhUsername(meta.githubUsername ?? null)
      setGhToken(meta.githubToken ?? null)
    })

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [router])

  async function handleStartBuilding(repoFullName: string | null) {
    setProvisionError(null)
    setSelectedRepo(repoFullName)
    setProvisioning(true)
    setReadiness(null)
    setStep(2)
    void hapticMedium()

    try {
      // Same reasoning as the mount-time read above — getSession()
      // for metadata access during the provision call so a flaky
      // network can't silently provision without the user's stored
      // creds.
      const session = await getRestoredSession()
      const meta = session?.user.user_metadata ?? {}

      const { serverId } = await provisionServer({
        // Only opt into trial mode if the user has no agent credentials
        // of their own. If they connected Claude via desktop import or
        // pasted a key, respect that — no silent key substitution.
        trial: !hasUserAgentCreds,
        // Default agent is Claude for trial users. Users with their own
        // credentials get whatever they've connected (backend will pick
        // up from agent-credentials table at session launch).
        agents: hasUserAgentCreds ? undefined : ['claude'],
        repos: repoFullName ? [repoFullName] : [],
        envType: 'general',
        ...(meta.githubUsername && meta.githubToken
          ? { githubUsername: meta.githubUsername, githubToken: meta.githubToken }
          : {}),
      })
      setProvisionedServerId(serverId)
    } catch (e) {
      setProvisioning(false)
      setProvisionError(e instanceof Error ? e.message : 'Could not start workspace.')
    }
  }

  // Poll readiness once we have a serverId. Auto-advance on ready.
  const hasAdvancedRef = useRef(false)
  useEffect(() => {
    if (!provisionedServerId) return
    let cancelled = false

    const tick = async () => {
      try {
        const server = await getServer(provisionedServerId)
        if (cancelled) return
        setReadiness(server.readiness ?? null)

        const status = server.readiness?.status
        if (status === 'ready' && !hasAdvancedRef.current) {
          hasAdvancedRef.current = true
          setProvisioning(false)
          void hapticMedium()
          // First-time native users (iOS/Android) skip step 3 — that's
          // the iOS-app QR card, meaningless when you're already in
          // the iOS app. The hasServer branch above handles the
          // returning-native-user case; this is the just-provisioned
          // counterpart. Web users still see step 3 so they can move
          // their session to mobile.
          //
          // We inline the onboarded=true + replace('/dashboard') here
          // rather than calling handleFinish() — the latter lives outside
          // the useEffect closure and adding it as a dep would force
          // re-running the readiness poll on every render. Cheaper to
          // duplicate four lines.
          setTimeout(() => {
            if (isNative) {
              void supabase.auth
                .updateUser({ data: { onboarded: true } })
                .catch(() => { /* best-effort — proceed to dashboard either way */ })
                .finally(() => router.replace('/dashboard'))
              return
            }
            setStep(3)
          }, 600)
          return
        }
        if (status === 'failed') {
          setProvisioning(false)
          setProvisionError(
            server.readiness?.error ?? 'Workspace provisioning failed.',
          )
          return
        }
      } catch {
        // Transient getServer failure — swallow and keep polling.
      }

      if (!cancelled) setTimeout(tick, POLL_MS)
    }

    tick()
    return () => {
      cancelled = true
    }
  }, [provisionedServerId])

  function handleRetryProvision() {
    setProvisionError(null)
    setProvisionedServerId(null)
    setReadiness(null)
    setSelectedRepo(null)
    hasAdvancedRef.current = false
    setStep(1)
  }

  async function handleFinish() {
    setSaving(true)
    try {
      const { error } = await supabase.auth.updateUser({
        data: { onboarded: true },
      })
      if (error) throw error
      router.replace('/dashboard')
    } catch {
      setSaving(false)
    }
  }

  // Wrap in AuthViewportShell for both the pre-mount case AND the
  // rendered tree, for the same reason /  does. WKWebView can leave the
  // previous route's DOM visible until something opaque covers it; a
  // bare `return null` (or even a `min-h-dvh` non-fixed container)
  // doesn't qualify on mobile. Use `centerContent={false}` because the
  // onboarding flow has a header + body + back button — content needs
  // to start at the top of the scroll area, not vertically centered.
  // See learnings/2026-04-landing-auth-restore-must-own-viewport.md.
  if (!mounted) return <AuthViewportShell centerContent={false} />

  // Back-button policy: hide during active provisioning (step 2) AND once
  // we have a provisioned server (step 3) — there's nothing to go back to
  // once a workspace exists.
  const showBackButton = step > 1 && !(step === 2 && provisioning) && !(step === 3 && provisionedServerId)

  return (
    <AuthViewportShell centerContent={false}>
      <div className="w-full max-w-[480px] mx-auto flex-1 flex flex-col">
        <header className="flex items-center justify-between mb-16 gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {showBackButton && (
              <button
                onClick={() => setStep(((step - 1) as Step))}
                aria-label="Go back"
                className="flex items-center justify-center h-8 w-8 rounded-lg border border-line text-secondary hover:text-bright hover:border-line2 transition-colors cursor-pointer flex-shrink-0"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                </svg>
              </button>
            )}
            <span className="text-[15px] font-semibold text-bright tracking-tight">Pocket Eng</span>
          </div>
          <StepIndicator step={step} total={TOTAL_STEPS} />
        </header>

        <div key={step} className="animate-fade-in">
          {step === 1 && (
            <Step1Start
              ghToken={ghToken}
              ghUsername={ghUsername}
              onStart={handleStartBuilding}
            />
          )}
          {step === 2 && (
            <Step2Provisioning
              readiness={readiness}
              selectedRepo={selectedRepo}
              error={provisionError}
              onRetry={handleRetryProvision}
            />
          )}
          {step === 3 && (
            <Step3Mobile
              onFinish={handleFinish}
              saving={saving}
            />
          )}
        </div>
      </div>
    </AuthViewportShell>
  )
}

function StepIndicator({ step, total }: { step: number; total: number }) {
  return (
    <div className="flex items-center gap-1" aria-label={`Step ${step} of ${total}`}>
      {Array.from({ length: total }).map((_, i) => {
        const active = i + 1 === step
        const past = i + 1 < step
        return (
          <span
            key={i}
            className="h-[3px] w-5 rounded-full transition-colors duration-200"
            style={{
              background: active
                ? 'var(--color-bright)'
                : past
                  ? 'var(--color-tertiary)'
                  : 'var(--color-line)',
            }}
          />
        )
      })}
    </div>
  )
}

/* ── Step 1 — One button, optional repo picker ───────────────────────── */

function Step1Start({
  ghToken,
  ghUsername,
  onStart,
}: {
  ghToken: string | null
  ghUsername: string | null
  onStart: (repoFullName: string | null) => void
}) {
  const hasGithub = !!ghToken
  // The repo picker lives in a collapsed pane that the user can expand
  // to pick a specific repo before clicking "Start building". Default is
  // collapsed — we don't want to block users who just want to try the
  // product without a repo. If they never expand it, Start builds a blank
  // workspace and they can add a repo later from the dashboard.
  const [showRepoPicker, setShowRepoPicker] = useState(false)
  const [ghLoading, setGhLoading] = useState(false)
  const [ghError, setGhError] = useState<string | null>(null)

  // Mirrors the connect flow in dashboard/settings — same Supabase OAuth,
  // same isShell branching, just landing back on /onboarding instead of
  // /dashboard/settings. The auth state listener in OnboardingPage
  // refreshes ghToken once the deep-link callback completes.
  async function handleConnectGitHub() {
    setGhError(null)
    setGhLoading(true)

    const isShell = isNative || isDesktop

    if (isShell) {
      const redirectTo = `https://console.pocketeng.ai/auth/native-callback?provider=github&from=onboarding${
        isDesktop ? '&client=desktop' : ''
      }`
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'github',
        options: { scopes: 'repo', redirectTo, skipBrowserRedirect: true },
      })
      if (error) { setGhError(error.message); setGhLoading(false); return }
      if (data?.url) {
        if (isDesktop) {
          window.pocketengDesktop?.openExternal(data.url)
        } else {
          const { Browser } = await import('@capacitor/browser')
          await Browser.open({ url: data.url, presentationStyle: 'popover' })
        }
      }
      setGhLoading(false)
    } else {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'github',
        options: {
          scopes: 'repo',
          redirectTo: `${window.location.origin}/auth/github-callback?from=onboarding`,
        },
      })
      if (error) {
        setGhError(error.message)
        setGhLoading(false)
      }
    }
  }

  return (
    <>
      <h1
        className="text-[34px] font-semibold text-bright leading-[1.08]"
        style={{ letterSpacing: '-0.025em' }}
      >
        Ready to build?
      </h1>
      <p className="text-[14px] text-tertiary mt-3 mb-10 leading-relaxed">
        Your coding agent is standing by. Click below to spin up your workspace —
        we'll get you chatting in under a minute.
      </p>

      {/* Optional: add a GitHub repo. Only shown if the user has GitHub
          connected (e.g. signed in via GitHub OAuth). Otherwise there's
          nothing to pick from and the section just adds noise. */}
      {hasGithub && (
        <div className="mb-6">
          {!showRepoPicker ? (
            <button
              onClick={() => setShowRepoPicker(true)}
              className="w-full text-left rounded-xl border border-line bg-l1 px-4 py-3.5 flex items-center gap-3 transition-colors hover:border-line2 cursor-pointer"
            >
              <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-l2 flex-shrink-0">
                <GithubIcon className="w-4 h-4 text-bright" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[13.5px] font-medium text-bright">Attach a GitHub repo</div>
                <div className="text-[11.5px] text-tertiary mt-0.5 truncate">
                  Optional · picks from @{ghUsername}
                </div>
              </div>
              <svg className="w-4 h-4 text-tertiary flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
              </svg>
            </button>
          ) : (
            <RepoQuickPicker
              githubToken={ghToken}
              onSelect={(full) => onStart(full)}
              onSkip={() => onStart(null)}
            />
          )}
        </div>
      )}

      {/* The primary CTA. If the user has GitHub connected and is still
          deciding on a repo, they can click this to skip the picker and
          start a blank workspace. If they've expanded the picker, this
          button is hidden — they'll pick a repo (or "Skip for now" from
          inside the picker) instead. */}
      {!showRepoPicker && (
        <PrimaryButton onClick={() => onStart(null)}>
          Start building →
        </PrimaryButton>
      )}

      {!hasGithub && (
        <>
          <button
            type="button"
            onClick={handleConnectGitHub}
            disabled={ghLoading}
            className="mt-4 w-full flex items-center justify-center gap-2 text-[12.5px] text-tertiary hover:text-secondary transition-colors disabled:opacity-50 cursor-pointer"
          >
            {ghLoading ? (
              <span className="block w-3 h-3 border-2 border-l3 border-t-bright rounded-full animate-spin" />
            ) : (
              <GithubIcon className="w-3.5 h-3.5" />
            )}
            <span>{ghLoading ? 'Opening GitHub…' : 'Connect GitHub instead'}</span>
          </button>
          {ghError && (
            <p className="text-[11.5px] text-danger mt-2 text-center">{ghError}</p>
          )}
          <p className="text-[11px] text-tertiary/70 mt-3 leading-relaxed text-center">
            Or attach a repo later from the dashboard.
          </p>
        </>
      )}
    </>
  )
}

/* ── Step 2 — Provisioning progress ──────────────────────────────────── */

function Step2Provisioning({
  readiness,
  selectedRepo,
  error,
  onRetry,
}: {
  readiness: Readiness | null
  selectedRepo: string | null
  error: string | null
  onRetry: () => void
}) {
  const ready = readiness?.status === 'ready'

  return (
    <>
      <h1
        className="text-[34px] font-semibold text-bright leading-[1.08]"
        style={{ letterSpacing: '-0.025em' }}
      >
        {ready
          ? 'Your workspace is ready.'
          : error
            ? 'Something went wrong.'
            : 'Spinning up your workspace.'}
      </h1>
      <p className="text-[14px] text-tertiary mt-3 mb-10 leading-relaxed">
        {ready
          ? 'Let\'s get you one step closer to shipping.'
          : error
            ? 'Your workspace didn\'t start. Try again.'
            : 'This takes about 60 seconds. Hang tight.'}
      </p>

      {!error && (
        <ProvisionProgress
          readiness={readiness}
          repoLabel={selectedRepo ?? 'blank'}
        />
      )}

      {error && (
        <div className="flex flex-col gap-4">
          <div className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3">
            <p className="text-[13px] text-danger">{error}</p>
          </div>
          <button
            onClick={onRetry}
            className="text-[12.5px] text-bright hover:text-secondary transition-colors underline-offset-2 hover:underline self-start cursor-pointer"
          >
            Try again
          </button>
        </div>
      )}
    </>
  )
}

/* ── Step 3 — Install the iOS app (QR code) ──────────────────────────── */

function Step3Mobile({
  onFinish,
  saving,
}: {
  onFinish: () => void
  saving: boolean
}) {
  // QR code rendered by a public service so we don't carry a QR library
  // dep. The destination URL is public anyway (App Store page), so passing
  // it through a query param has no secrecy implications.
  const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=0&data=${encodeURIComponent(IOS_APP_URL)}`

  return (
    <>
      <h1
        className="text-[34px] font-semibold text-bright leading-[1.08]"
        style={{ letterSpacing: '-0.025em' }}
      >
        Take it with you.
      </h1>
      <p className="text-[14px] text-tertiary mt-3 mb-10 leading-relaxed">
        Monitor your agent, review PRs, and kick off new tasks from your phone.
        Scan to install the iOS app.
      </p>

      <div className="flex flex-col items-center gap-4 mb-10">
        <div className="p-4 rounded-xl bg-white">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={qrSrc}
            alt="Pocket Eng iOS app QR code"
            width={220}
            height={220}
            className="block"
          />
        </div>
        <a
          href={IOS_APP_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[12px] text-tertiary hover:text-bright transition-colors underline-offset-2 hover:underline"
        >
          …or open the App Store page directly
        </a>
      </div>

      <PrimaryButton onClick={onFinish} disabled={saving}>
        {saving ? 'Finishing…' : 'Finish'}
      </PrimaryButton>
    </>
  )
}

/* ── Shared bits ──────────────────────────────────────────────────────── */

function PrimaryButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="h-11 w-full rounded-lg text-[13.5px] font-medium bg-bright text-ink cursor-pointer transition-opacity duration-150 hover:opacity-90 active:opacity-80 disabled:opacity-40"
    >
      {children}
    </button>
  )
}

function GithubIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C6.477 2 2 6.477 2 12c0 4.418 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.868-.013-1.703-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z" />
    </svg>
  )
}
