'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { clearAppleOAuthCredential, getAppleOAuthCredential, hasAppleIdentity } from '@/lib/oauthCredentials'
import { deleteAccount, getMyTeam, listPendingTeamInvites, type Team } from '@/lib/api'
import { getRestoredSession, supabase } from '@/lib/supabase'
import { isNative, isDesktop } from '@/lib/native'
import { useTheme } from '@/components/ThemeProvider'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-medium text-tertiary uppercase tracking-widest mb-3">{title}</p>
      <div className="card-surface">
        {children}
      </div>
    </div>
  )
}

function Row({ label, children }: {
  label: string
  children?: React.ReactNode
}) {
  return (
    <div className="px-5 py-4 flex flex-col gap-2.5 border-b border-line last:border-b-0">
      <p className="text-[13px] text-bright font-medium">{label}</p>
      {children}
    </div>
  )
}

export default function SettingsPage() {
  const router = useRouter()
  const { theme, setTheme } = useTheme()

  const [ghUsername, setGhUsername]     = useState<string | null>(null)
  const [accountEmail, setAccountEmail] = useState<string>('')
  const [usesAppleSignIn, setUsesAppleSignIn] = useState(false)
  const [ghLoading, setGhLoading]       = useState(false)
  const [ghError, setGhError]           = useState<string | null>(null)

  const [saving, setSaving]             = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deleteConfirmation, setDeleteConfirmation] = useState('')
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [accountDeleted, setAccountDeleted] = useState(false)
  // Team management itself lives at `/dashboard/team`. We still fetch a
  // small summary here so the Settings card can show "Acme · 4 members"
  // (or "Not on a team"/"3 pending invites") without duplicating any of
  // the create/invite/member-list UI.
  const [team, setTeam] = useState<Team | null>(null)
  const [teamMemberCount, setTeamMemberCount] = useState(0)
  const [pendingInviteCount, setPendingInviteCount] = useState(0)

  async function reloadTeamSummary() {
    const [teamResult, pendingResult] = await Promise.all([
      getMyTeam().catch(() => ({ team: null, members: [], invites: [] })),
      listPendingTeamInvites().catch(() => ({ invites: [] })),
    ])
    setTeam(teamResult.team)
    setTeamMemberCount(teamResult.members?.length ?? 0)
    setPendingInviteCount(pendingResult.invites?.length ?? 0)
  }

  useEffect(() => {
    let cancelled = false

    void (async () => {
      const session = await getRestoredSession()
      if (cancelled) return
      if (!session) { router.replace('/'); return }

      const sessionUser = session.user
      const m = sessionUser.user_metadata ?? {}
      setAccountEmail(sessionUser.email ?? '')
      setUsesAppleSignIn(hasAppleIdentity(sessionUser.identities))
      setGhUsername(m.githubUsername ?? null)

      try {
        const { data: { user } } = await supabase.auth.getUser()
        if (cancelled || !user) return
        setUsesAppleSignIn(hasAppleIdentity(user.identities))
      } catch { /* best-effort refresh only; session already proved auth */ }
      try {
        await reloadTeamSummary()
      } catch { /* ignore */ }
    })()

    return () => {
      cancelled = true
    }
  }, [router])

  useEffect(() => {
    if (!accountDeleted) return

    const redirectTimer = window.setTimeout(async () => {
      await supabase.auth.signOut().catch(() => {})
      router.replace('/')
    }, 1800)

    return () => window.clearTimeout(redirectTimer)
  }, [accountDeleted, router])

  async function handleConnectGitHub() {
    setGhError(null)
    setGhLoading(true)

    const isShell = isNative || isDesktop

    if (isShell) {
      const redirectTo = `https://console.pocketeng.ai/auth/native-callback?provider=github&from=settings${
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
          redirectTo: `${window.location.origin}/auth/github-callback?from=settings`,
        },
      })
      if (error) {
        setGhError(error.message)
        setGhLoading(false)
      }
    }
  }

  async function handleDisconnectGitHub() {
    setSaving(true)
    try {
      await supabase.auth.updateUser({
        data: { githubUsername: null, githubToken: null },
      })
      const { data: { user } } = await supabase.auth.getUser()
      const ghIdentity = user?.identities?.find((i: any) => i.provider === 'github')
      if (ghIdentity) {
        await supabase.auth.unlinkIdentity(ghIdentity).catch(() => {})
      }
      setGhUsername(null)
    } finally {
      setSaving(false)
    }
  }

  async function handleDeleteAccount() {
    if (deleteConfirmation.trim().toUpperCase() !== 'DELETE') return

    setDeleteError(null)
    setDeleteLoading(true)

    try {
      const appleCredential = getAppleOAuthCredential()
      await deleteAccount({
        hasAppleIdentity: usesAppleSignIn,
        ...(appleCredential?.providerToken ? { appleAccessToken: appleCredential.providerToken } : {}),
        ...(appleCredential?.providerRefreshToken ? { appleRefreshToken: appleCredential.providerRefreshToken } : {}),
      })
      clearAppleOAuthCredential()
      setAccountDeleted(true)
      setDeleteConfirmOpen(false)
    } catch (err) {
      setDeleteError((err as Error).message || 'Could not delete your account')
    } finally {
      setDeleteLoading(false)
    }
  }

  if (accountDeleted) {
    return (
      <div className="px-5 md:px-8 py-10 max-w-xl animate-fade-in">
        <div className="card-surface p-6 flex flex-col items-center text-center gap-4">
          <div className="w-11 h-11 rounded-full bg-accent/12 flex items-center justify-center">
            <svg className="w-5 h-5 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <div>
            <h1 className="text-[17px] font-semibold text-bright tracking-tight">Account deleted</h1>
            <p className="text-[12px] text-secondary mt-1 leading-relaxed">
              Your Pocket Eng account and associated app data have been removed. Managed workspaces are being terminated.
            </p>
          </div>
          <p className="text-[11px] text-tertiary">Redirecting to sign in…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="px-5 md:px-8 py-4 md:py-8 max-w-xl animate-fade-in">
      <div className="hidden md:block mb-8">
        <h1 className="text-[16px] font-semibold text-bright tracking-tight">Settings</h1>
        <p className="text-[12px] text-tertiary mt-1">Manage your account</p>
      </div>

      <div className="flex flex-col gap-6 md:gap-8">

        {/* Appearance */}
        <Section title="Appearance">
          <Row label="Theme">
            <div className="flex gap-2">
              {(['light', 'dark'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTheme(t)}
                  className={`px-4 py-2 rounded-lg text-[13px] font-medium capitalize transition-colors cursor-pointer ${
                    theme === t
                      ? 'bg-accent/15 text-accent border border-accent/30'
                      : 'bg-l2 text-tertiary border border-line hover:text-secondary'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </Row>
        </Section>

        {/* Team summary card — full management lives at /dashboard/team
            (linked from the sidebar). We show only a one-line status here
            so mobile users (who get to settings via the bottom tab and
            don't see the sidebar) can still discover the team page. */}
        <Section title="Team">
          <Link
            href="/dashboard/team"
            className="block px-5 py-4 hover:bg-l2/40 transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-[13px] text-bright font-medium">
                  {team ? team.name : 'No team yet'}
                </p>
                <p className="text-[12px] text-tertiary mt-0.5">
                  {team
                    ? `${teamMemberCount} member${teamMemberCount === 1 ? '' : 's'} · you are ${team.role === 'admin' ? 'an admin' : 'a member'}`
                    : pendingInviteCount > 0
                      ? `${pendingInviteCount} pending invite${pendingInviteCount === 1 ? '' : 's'} — tap to view`
                      : 'Create a team or accept an invite'}
                </p>
              </div>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-tertiary shrink-0"
              >
                <path d="M9 6l6 6-6 6" />
              </svg>
            </div>
          </Link>
        </Section>

        {/* GitHub */}
        <Section title="GitHub">
          <Row label="Connected account">
            {ghUsername ? (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-2 h-2 rounded-full bg-accent" />
                  <span className="text-[13px] text-accent font-medium">@{ghUsername}</span>
                </div>
                <button
                  onClick={handleDisconnectGitHub}
                  disabled={saving}
                  className="text-[12px] text-tertiary hover:text-danger transition-colors duration-150 cursor-pointer"
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <button
                  onClick={handleConnectGitHub}
                  disabled={ghLoading}
                  className="btn btn-secondary w-full cursor-pointer flex items-center justify-center gap-2.5"
                >
                  {ghLoading ? (
                    <div className="w-3.5 h-3.5 border-[1.5px] border-secondary/30 border-t-secondary rounded-full animate-spin" />
                  ) : (
                    <svg className="w-[16px] h-[16px]" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 2C6.477 2 2 6.477 2 12c0 4.418 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.868-.013-1.703-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z" />
                    </svg>
                  )}
                  {ghLoading ? 'Redirecting\u2026' : 'Connect with GitHub'}
                </button>
                {ghError && <p className="text-[11px] text-danger animate-fade-in">{ghError}</p>}
              </div>
            )}
          </Row>
          <div className="px-5 py-3 text-[11px] text-tertiary">
            Used to pre-configure git credentials in new workspaces.
          </div>
        </Section>

        <Section title="Danger Zone">
          <Row label="Delete account">
            <div className="flex flex-col gap-3">
              <p className="text-[12px] text-secondary leading-relaxed">
                Permanently deletes {accountEmail || 'this account'}, removes chat history and app metadata, disconnects integrations, unregisters push devices, and terminates managed workspaces.
              </p>
              {usesAppleSignIn && (
                <p className="text-[11px] text-tertiary leading-relaxed">
                  Because this account uses Sign in with Apple, the app also revokes the linked Apple authorization during deletion.
                </p>
              )}

              {deleteConfirmOpen ? (
                <div className="rounded-xl border border-danger/20 bg-danger/5 p-4 flex flex-col gap-3">
                  <p className="text-[12px] text-bright font-medium">This action cannot be undone.</p>
                  <p className="text-[11px] text-secondary leading-relaxed">
                    Type <span className="text-bright font-medium">DELETE</span> to confirm permanent account deletion.
                  </p>
                  <input
                    value={deleteConfirmation}
                    onChange={e => setDeleteConfirmation(e.target.value)}
                    placeholder="Type DELETE"
                    disabled={deleteLoading}
                    className="input"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        setDeleteConfirmOpen(false)
                        setDeleteConfirmation('')
                        setDeleteError(null)
                      }}
                      disabled={deleteLoading}
                      className="btn btn-secondary flex-1 cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleDeleteAccount}
                      disabled={deleteLoading || deleteConfirmation.trim().toUpperCase() !== 'DELETE'}
                      className="btn btn-danger flex-1 cursor-pointer"
                    >
                      {deleteLoading ? (
                        <div className="w-4 h-4 border-2 border-danger/20 border-t-white rounded-full animate-spin" />
                      ) : (
                        'Delete account'
                      )}
                    </button>
                  </div>
                  {deleteError && <p className="text-[11px] text-danger">{deleteError}</p>}
                </div>
              ) : (
                <button
                  onClick={() => {
                    setDeleteConfirmOpen(true)
                    setDeleteError(null)
                  }}
                  className="btn btn-danger w-full cursor-pointer"
                >
                  Delete account…
                </button>
              )}
            </div>
          </Row>
        </Section>

        {/* Sign out (mobile) */}
        <div className="md:hidden">
          <button
            onClick={async () => {
              // Clear localStorage caches so the next user doesn't see a
              // flash of the previous account's data on reopen.
              const { clearAllCache } = await import('@/lib/cache')
              clearAllCache()
              await supabase.auth.signOut()
              router.replace('/')
            }}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-[14px] text-danger font-medium transition-colors active:opacity-60 cursor-pointer"
            style={{ background: 'var(--card-bg)' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
            </svg>
            Sign out
          </button>
        </div>

      </div>
    </div>
  )
}
