'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getRestoredSession } from '@/lib/supabase'
import { ChatSessionRecord, Server, listServers, getSessions, deleteSession, getMyTeam } from '@/lib/api'
import { hapticMedium } from '@/lib/native'
import { getAgentLogo } from '@/lib/agents'

type SessionWithWorkspace = ChatSessionRecord & { workspaceLabel: string }

function formatRelativeTime(value: string | null | undefined): string {
  if (!value) return 'now'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'now'
  const s = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function groupByDate(sessions: SessionWithWorkspace[]): { label: string; items: SessionWithWorkspace[] }[] {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterday = today - 86400000
  const weekAgo = today - 7 * 86400000
  const groups: Record<string, SessionWithWorkspace[]> = { Today: [], Yesterday: [], 'This week': [], Earlier: [] }
  for (const s of sessions) {
    const t = new Date(s.updatedAt || s.createdAt).getTime()
    if (t >= today) groups.Today.push(s)
    else if (t >= yesterday) groups.Yesterday.push(s)
    else if (t >= weekAgo) groups['This week'].push(s)
    else groups.Earlier.push(s)
  }
  return Object.entries(groups).filter(([, items]) => items.length > 0).map(([label, items]) => ({ label, items }))
}

function statusColor(status: ChatSessionRecord['status']): string {
  switch (status) {
    case 'running': return 'var(--color-green)'
    case 'error': return 'var(--color-danger)'
    case 'cancelled': return 'var(--color-amber)'
    default: return 'var(--text-tertiary)'
  }
}

export default function SessionsPage() {
  const router = useRouter()
  const [sessions, setSessions] = useState<SessionWithWorkspace[]>([])
  const [currentUserId, setCurrentUserId] = useState<string>('')
  const [scope, setScope] = useState<'mine' | 'team' | 'all'>('mine')
  const [userEmails, setUserEmails] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [runningServerId, setRunningServerId] = useState<string | null>(null)
  const [runningServerLabel, setRunningServerLabel] = useState<string | null>(null)
  // Sessions currently mid-delete. Prevents double-taps from firing two
  // delete requests for the same row and lets us grey out the button
  // while the backend is churning through worktree cleanup + DDB rows.
  const [deleting, setDeleting] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current)
  }, [])

  async function handleDelete(sessionId: string) {
    if (deleting.has(sessionId)) return
    setDeleting(prev => new Set(prev).add(sessionId))
    try {
      await deleteSession(sessionId)
      setSessions(prev => prev.filter(s => s.sessionId !== sessionId))
    } catch (e) {
      // Backend errors carry useful messages (e.g. "Only team admins can
      // delete team sessions"); surface them as a transient banner instead
      // of letting the rejected promise die silently in the console.
      setError((e as Error).message || 'Failed to delete session')
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current)
      errorTimerRef.current = setTimeout(() => setError(null), 4000)
    }
    finally {
      setDeleting(prev => {
        const next = new Set(prev)
        next.delete(sessionId)
        return next
      })
    }
  }

  useEffect(() => {
    let cancelled = false

    async function load() {
      const session = await getRestoredSession()
      if (cancelled) return
      if (!session) { router.replace('/'); return }
      setCurrentUserId(session.user.id)

      // Pull the team membership list once so we can render
      // "by <email>" on team sessions created by other members.
      // Best-effort: failure leaves the map empty and rows fall
      // back to showing the createdByUserId prefix.
      try {
        const { members } = await getMyTeam()
        if (!cancelled) {
          const map: Record<string, string> = {}
          for (const m of members) {
            if (m.email) map[m.userId] = m.email
          }
          setUserEmails(map)
        }
      } catch { /* not on a team or backend unavailable */ }

      const { servers } = await listServers()
      if (cancelled) return
      const active = servers.filter(s => s.instanceState !== 'terminated')
      const running = active.find(s => s.instanceState === 'running')
      if (running) {
        setRunningServerId(running.serverId)
        setRunningServerLabel(running.label || running.serverId.slice(0, 8))
      }

      const all: SessionWithWorkspace[] = []
      await Promise.all(
        active.map(async (server: Server) => {
          try {
            const { sessions: serverSessions } = await getSessions(server.serverId, 10)
            for (const s of serverSessions) {
              all.push({ ...s, workspaceLabel: server.label || server.serverId.slice(0, 8) })
            }
          } catch { /* skip failed fetches */ }
        })
      )

      if (cancelled) return
      all.sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime())
      setSessions(all)
      setLoading(false)
    }
    void load()

    return () => {
      cancelled = true
    }
  }, [router])

  const hasTeamSessions = sessions.some(s => s.ownerType === 'team')
  const visibleSessions = sessions.filter(s => {
    if (scope === 'all') return true
    if (scope === 'team') return s.ownerType === 'team'
    if (s.ownerType === 'team') return (s.createdByUserId || s.userId) === currentUserId
    return (s.userId || s.createdByUserId) === currentUserId
  })
  const groups = groupByDate(visibleSessions)

  if (loading) {
    return (
      <div className="px-5 py-6">
        <div className="skeleton w-24 h-5 mb-6" />
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="skeleton w-full h-16 mb-3 rounded-xl" />
        ))}
      </div>
    )
  }

  const scopeToggle = hasTeamSessions ? (
    <div className="inline-flex items-center gap-1 p-[3px] rounded-lg bg-l1 border border-line mb-5">
      {([
        ['mine', 'Mine'],
        ['team', 'Team'],
        ['all', 'All'],
      ] as const).map(([value, label]) => (
        <button
          key={value}
          onClick={() => setScope(value)}
          className={`px-3 py-1.5 rounded-md text-[12px] font-medium transition-all duration-150 cursor-pointer ${
            scope === value ? 'bg-ink text-bright shadow-sm' : 'text-tertiary hover:text-secondary'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  ) : null

  if (visibleSessions.length === 0) {
    // The user might have sessions but they've all been filtered out by the
    // current scope (e.g. default Mine, but only teammate-created sessions
    // exist). Render the scope toggle in that case so they can switch to
    // Team/All without typing a URL — otherwise the empty state is a dead
    // end and they'd never discover the team sessions that exist.
    const filteredOutByScope = sessions.length > 0
    return (
      <div className="px-5 py-6 animate-fade-in">
        <h1 className="hidden md:block text-[16px] font-semibold text-bright tracking-tight mb-1">Sessions</h1>
        <p className="hidden md:block text-[12px] text-tertiary mb-8">Your recent coding sessions</p>

        {scopeToggle}

        {/* If there's a running workspace, surface "start new session" up
            top — so an empty-state user has a clear primary action instead
            of just the "no sessions yet" icon to look at. */}
        {runningServerId && (
          <div className="mb-8">
            <NewSessionRow
              workspaceLabel={runningServerLabel}
              onClick={() => router.push(`/dashboard/${runningServerId}?new=1`)}
            />
          </div>
        )}

        <div className="flex flex-col items-center justify-center py-16 text-center">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" className="text-tertiary mb-4">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <p className="text-[14px] text-tertiary">
            {filteredOutByScope ? 'No sessions match this filter' : 'No sessions yet'}
          </p>
          <p className="text-[12px] text-tertiary mt-1">
            {filteredOutByScope
              ? 'Try switching the filter above'
              : runningServerId ? 'Tap above to start your first one' : 'Open a workspace to start coding'}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="px-5 py-4 md:py-6 animate-fade-in">
      <h1 className="hidden md:block text-[16px] font-semibold text-bright tracking-tight mb-1">Sessions</h1>
      <p className="hidden md:block text-[12px] text-tertiary mb-5">Your recent coding sessions</p>
      {error && (
        <div
          role="alert"
          className="mb-4 px-3 py-2 rounded-md border border-danger/30 bg-danger/10 text-[12px] text-danger animate-in fade-in slide-in-from-top-1 duration-150"
        >
          {error}
        </div>
      )}
      {scopeToggle}

      {/* Inline "start new session" row — lives at the top of the list,
          before any date groups. Replaces the floating action button.
          Rationale: for a list people return to more than they create
          from, the FAB was the wrong pattern — covered content, visually
          loud, no context about which workspace the new session would
          belong to. An inline row feels like a proper list item and
          shows the target workspace label. */}
      {runningServerId && (
        <div className="mb-5">
          <NewSessionRow
            workspaceLabel={runningServerLabel}
            onClick={() => router.push(`/dashboard/${runningServerId}?new=1`)}
          />
        </div>
      )}

      {groups.map((group) => (
        <div key={group.label} className="mb-5">
          <p className="text-[11px] font-medium text-tertiary uppercase tracking-widest mb-2 px-1">
            {group.label}
          </p>
          <div className="flex flex-col gap-1.5">
            {group.items.map((s) => {
              const isDeleting = deleting.has(s.sessionId)
              return (
                // Nested buttons are invalid HTML, so the outer row is a
                // <div onClick> and the delete target is a <button> inside
                // with event.stopPropagation() so tapping the trash doesn't
                // also open the session.
                <div
                  key={s.sessionId}
                  role="button"
                  tabIndex={0}
                  onClick={() => { if (!isDeleting) router.push(`/dashboard/${s.serverId}?session=${s.sessionId}`) }}
                  onKeyDown={(e) => { if (!isDeleting && (e.key === 'Enter' || e.key === ' ')) router.push(`/dashboard/${s.serverId}?session=${s.sessionId}`) }}
                  className={`flex items-start gap-3 px-3.5 py-3 rounded-xl transition-all cursor-pointer active:opacity-60 text-left ${isDeleting ? 'opacity-50 pointer-events-none' : ''}`}
                  style={{ background: 'var(--card-bg)' }}
                >
                  <div
                    className="w-2 h-2 rounded-full mt-1.5 flex-shrink-0"
                    style={{ background: statusColor(s.status) }}
                  />
                  {getAgentLogo(s.agent) && (
                    <img
                      src={getAgentLogo(s.agent)!}
                      alt="Agent"
                      className="w-4 h-4 mt-1 flex-shrink-0 rounded-sm"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-[14px] text-bright font-medium truncate">
                      {s.title || s.lastPrompt || s.prompt || 'Untitled session'}
                    </p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-line text-tertiary">
                        {s.ownerType === 'team' ? 'Team' : 'Personal'}
                      </span>
                      <span className="text-[11px] text-tertiary">{s.workspaceLabel}</span>
                      <span className="text-[11px] text-tertiary">·</span>
                      <span className="text-[11px] text-tertiary">{formatRelativeTime(s.updatedAt || s.createdAt)}</span>
                      {s.ownerType === 'team' && s.createdByUserId && s.createdByUserId !== currentUserId && (
                        <>
                          <span className="text-[11px] text-tertiary">·</span>
                          <span className="text-[11px] text-tertiary truncate">
                            by {userEmails[s.createdByUserId] || `${s.createdByUserId.slice(0, 8)}…`}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); void handleDelete(s.sessionId) }}
                    disabled={isDeleting}
                    aria-label="Delete session"
                    className="flex items-center justify-center w-9 h-9 -mr-1 -mt-1 rounded-lg text-tertiary hover:text-danger hover:bg-danger/10 active:bg-danger/20 transition-colors cursor-pointer disabled:opacity-40"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 6h18" />
                      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                      <path d="M10 11v6" />
                      <path d="M14 11v6" />
                    </svg>
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      ))}

    </div>
  )
}

/* ── "Start new session" row ──────────────────────────────────────────
 * Sits at the top of the sessions list. Matches the visual rhythm of the
 * session rows below (same card bg, same horizontal padding) so it reads
 * as part of the list rather than a callout. The dark-indigo "+" chip on
 * the left replaces the status dot / agent logo a real session row would
 * have, keeping the grid consistent.
 */
function NewSessionRow({
  workspaceLabel,
  onClick,
}: {
  workspaceLabel: string | null
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={() => { void hapticMedium(); onClick() }}
      className="w-full flex items-center gap-3 px-3.5 py-3 rounded-xl transition-all cursor-pointer active:opacity-60 text-left group"
      style={{ background: 'var(--card-bg)' }}
    >
      <div
        className="flex items-center justify-center w-7 h-7 rounded-full flex-shrink-0"
        style={{ background: 'var(--color-bright)', color: 'var(--color-ink)' }}
        aria-hidden="true"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[14px] text-bright font-medium">Start new session</p>
        {workspaceLabel && (
          <p className="text-[11px] text-tertiary mt-0.5 truncate">in {workspaceLabel}</p>
        )}
      </div>
      <svg
        className="w-4 h-4 text-tertiary group-hover:text-bright transition-colors flex-shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
        aria-hidden="true"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
      </svg>
    </button>
  )
}
