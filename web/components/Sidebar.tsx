'use client'

import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ChatSessionRecord, Server, listServers, getSessions, deleteSession, renameSession, pinSession, getTrialUsage, getMyTeam } from '@/lib/api'
import { getRestoredSession } from '@/lib/supabase'
import { getAgentLogo, getAgentName } from '@/lib/agents'
import { groupTasks, groupTasksByWorkspace, STATUS_META, toTaskView, type TaskView } from '@/lib/tasks'
import { RoleBadge, useSessionRole } from './sdlc'
import { useTheme } from './ThemeProvider'

/* ── Helpers ── */

function formatRelativeTimeShort(value: string | null | undefined): string {
  if (!value) return 'now'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'now'
  const s = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

function formatWorkspaceLabel(server: Server): string {
  if (server.label) return server.label
  if (server.envType === 'byos') return server.publicIp || `Server ${server.serverId.slice(0, 8)}`
  return `Workspace ${server.serverId.slice(0, 8)}`
}

/* ── Nav items ── */

const CONFIGURE_ITEMS = [
  {
    // SDLC Autopilot — the pipeline command center. First in the list:
    // it's the "what this product is becoming" page.
    href: '/dashboard/sdlc',
    label: 'SDLC Autopilot',
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="5" cy="12" r="2.5" /><circle cx="19" cy="12" r="2.5" /><path d="M7.5 12h9" /><path d="M13.5 9.5L16.5 12l-3 2.5" /></svg>,
  },
  {
    href: '/dashboard/agents',
    label: 'Coding Agents',
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" /><path d="M18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" /></svg>,
  },
  {
    // Per-user, not per-workspace — the harness applies wherever the
    // agent runs. Lives at /dashboard/harness alongside the other
    // configure-the-platform pages.
    href: '/dashboard/harness',
    label: 'Harness',
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2.25l8.25 3v6.3c0 5.1-3.45 9.6-8.25 10.95-4.8-1.35-8.25-5.85-8.25-10.95v-6.3L12 2.25z" /><path d="M8.55 12L11.1 14.55 16.05 9.6" /></svg>,
  },
  {
    href: '/dashboard/integrations',
    label: 'Integrations',
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M13.5 3H12H8C6.34315 3 5 4.34315 5 6V18C5 19.6569 6.34315 21 8 21H11M13.5 3L19 8.625M13.5 3V7.625C13.5 8.17728 13.9477 8.625 14.5 8.625H19M19 8.625V11.8125" /><path d="M17.5 15L17.5 21" /><path d="M14.5 18H20.5" /></svg>,
  },
  {
    // Team management — full page at /dashboard/team. The Settings card
    // also links here so mobile users (no sidebar) can still find it.
    href: '/dashboard/team',
    label: 'Team',
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>,
  },
  {
    href: '/dashboard/settings',
    label: 'Settings',
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>,
  },
]

/* ── Task card ── */

interface TaskCardProps {
  task: TaskView
  workspaceLabel?: string
  isActive: boolean
  onOpen: () => void
  onDelete: () => void
  onRename: (newTitle: string) => void
  onPin: () => void
  currentUserId?: string
  userEmails?: Record<string, string>
}

function TaskCard({ task, workspaceLabel, isActive, onOpen, onDelete, onRename, onPin, currentUserId, userEmails }: TaskCardProps) {
  const meta = STATUS_META[task.status]
  const time = formatRelativeTimeShort(task.updatedAt || task.createdAt)
  const agentLogo = getAgentLogo(task.agent)
  const agentName = getAgentName(task.agent)
  // SDLC role for this session — stored (if the user set one) or inferred
  // from the title. Reactive so reassigning from the chat header updates
  // the sidebar chip live.
  const [role] = useSessionRole(task.id, task.title)
  // Append "by <email>" when the task is a team session created by someone
  // other than the viewer, so members can tell whose chat is whose in the
  // sidebar list. Falls back to a userId prefix if the membership row hasn't
  // been backfilled with an email yet.
  const isTeammatesSession =
    task.session.ownerType === 'team' &&
    !!task.session.createdByUserId &&
    !!currentUserId &&
    task.session.createdByUserId !== currentUserId
  const creatorLabel = isTeammatesSession
    ? (userEmails?.[task.session.createdByUserId!] || `${task.session.createdByUserId!.slice(0, 8)}…`)
    : null
  const contextBits = [
    task.repo,
    task.branchLabel,
    task.prNumber ? `PR #${task.prNumber}` : null,
  ].filter(Boolean) as string[]
  const contextLine = contextBits.length > 0 ? contextBits.join(' · ') : workspaceLabel ?? ''

  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null)
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(task.title)
  /** Kebab wrapper — outer click-outside check. */
  const menuWrapRef = useRef<HTMLDivElement>(null)
  /** Kebab button — used to compute portal anchor position. */
  const kebabBtnRef = useRef<HTMLButtonElement>(null)
  /** Portal-rendered dropdown — second click-outside check (the dropdown
   * lives outside the kebab wrapper since we render it via createPortal
   * to escape the sidebar's overflow-y-auto clipping). */
  const menuPortalRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node
      const inWrap = menuWrapRef.current?.contains(target)
      const inPortal = menuPortalRef.current?.contains(target)
      if (!inWrap && !inPortal) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [menuOpen])

  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isRenaming])

  function handleRenameSubmit() {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== task.title) {
      onRename(trimmed)
    }
    setIsRenaming(false)
  }

  const rowShellClass = `group w-full flex items-start gap-2.5 px-2 py-1.5 rounded-md transition-colors text-left relative ${
    isActive ? 'bg-[var(--active-bg)]' : 'hover:bg-[var(--hover-bg)]'
  }`

  const avatar = (
    <span className="relative mt-[1px] flex-shrink-0" aria-label={`${agentName} — ${meta.label}`} title={`${agentName} · ${meta.label}`}>
      <span className="flex items-center justify-center w-[18px] h-[18px] rounded-[5px] bg-l2 overflow-hidden">
        {agentLogo ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={agentLogo} alt="" className="w-[14px] h-[14px] object-contain" />
        ) : (
          <span className="text-[9px] font-semibold text-tertiary">
            {(task.agent || '?').slice(0, 1).toUpperCase()}
          </span>
        )}
      </span>
      <span
        className={`absolute -right-[3px] -bottom-[3px] h-[7px] w-[7px] rounded-full ring-2 ring-[var(--sidebar-bg)] ${meta.dotClass}`}
      />
    </span>
  )

  const menuColumn = (
    <div
      ref={menuWrapRef}
      className="relative flex-shrink-0 mt-[1px]"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        ref={kebabBtnRef}
        className={`hidden group-hover:flex items-center justify-center w-5 h-5 rounded text-tertiary/60 hover:text-bright hover:bg-[var(--hover-bg)] transition-colors cursor-pointer ${menuOpen ? '!flex' : ''}`}
        onClick={(e) => {
          e.stopPropagation()
          // Anchor the portal dropdown right-aligned to the kebab + 4px
          // below it. Using fixed positioning means it escapes the
          // sidebar's overflow-y-auto clipping.
          if (!menuOpen && kebabBtnRef.current) {
            const rect = kebabBtnRef.current.getBoundingClientRect()
            const MENU_WIDTH = 130
            setMenuPosition({
              top: rect.bottom + 4,
              left: rect.right - MENU_WIDTH,
            })
          }
          setMenuOpen(!menuOpen)
        }}
        aria-label="Task options"
        aria-expanded={menuOpen}
        aria-haspopup="menu"
      >
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <circle cx="12" cy="5" r="1.5" />
          <circle cx="12" cy="12" r="1.5" />
          <circle cx="12" cy="19" r="1.5" />
        </svg>
      </button>
      {menuOpen && menuPosition && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuPortalRef}
          className="fixed z-50 w-[130px] py-1 rounded-lg border border-line bg-ink shadow-lg shadow-black/20 animate-in fade-in slide-in-from-top-1 duration-100"
          style={{ top: menuPosition.top, left: menuPosition.left }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[11px] text-secondary hover:text-bright hover:bg-[var(--hover-bg)] transition-colors text-left cursor-pointer"
            onClick={(e) => {
              e.stopPropagation()
              setMenuOpen(false)
              setRenameValue(task.title)
              setIsRenaming(true)
            }}
          >
            <svg className="w-3 h-3 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487z" />
            </svg>
            Rename
          </button>
          <button
            type="button"
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[11px] text-secondary hover:text-bright hover:bg-[var(--hover-bg)] transition-colors text-left cursor-pointer"
            onClick={(e) => {
              e.stopPropagation()
              setMenuOpen(false)
              onPin()
            }}
          >
            <svg className="w-3 h-3 opacity-60" viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <path d="M16 2l-4 4-5-2-3 3 4.5 4.5L2 18l.5.5 6.5-6.5L13.5 17l3-3-2-5 4-4 2 2 1.5-1.5L16 2z" />
            </svg>
            {task.pinned ? 'Unpin' : 'Pin'}
          </button>
          <div className="my-1 border-t border-line" />
          <button
            type="button"
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[11px] text-danger hover:bg-danger/10 transition-colors text-left cursor-pointer"
            onClick={(e) => {
              e.stopPropagation()
              setMenuOpen(false)
              onDelete()
            }}
          >
            <svg className="w-3 h-3 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
            </svg>
            Delete
          </button>
        </div>,
        document.body
      )}
    </div>
  )

  const titleBlock = isRenaming ? (
    <span className="flex-1 min-w-0">
      <input
        ref={inputRef}
        type="text"
        data-testid="rename-input"
        value={renameValue}
        onChange={(e) => setRenameValue(e.target.value)}
        onBlur={handleRenameSubmit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleRenameSubmit()
          if (e.key === 'Escape') { setIsRenaming(false); setRenameValue(task.title) }
        }}
        onClick={(e) => e.stopPropagation()}
        className="block w-full text-[12px] text-bright bg-transparent border border-accent/40 rounded px-1 py-0 outline-none focus:border-accent"
      />
    </span>
  ) : (
    <span className="flex-1 min-w-0">
      <span
        className={`block text-[12px] truncate ${isActive ? 'text-bright font-medium' : 'text-secondary'}`}
        title={task.title}
      >
        {task.pinned && (
          <svg className="inline-block w-[10px] h-[10px] mr-0.5 -mt-[1px] text-accent/70" viewBox="0 0 24 24" fill="currentColor" stroke="none">
            <path d="M16 2l-4 4-5-2-3 3 4.5 4.5L2 18l.5.5 6.5-6.5L13.5 17l3-3-2-5 4-4 2 2 1.5-1.5L16 2z" />
          </svg>
        )}
        {task.title}
      </span>
      <span className="flex items-center gap-1 mt-0.5 min-w-0">
        <RoleBadge role={role} size="xs" />
        {contextLine && (
          <span className="text-[10px] text-tertiary truncate min-w-0">
            {contextLine}
          </span>
        )}
      </span>
      {creatorLabel && (
        <span className="block text-[10px] text-tertiary truncate" title={`by ${creatorLabel}`}>
          by {creatorLabel}
        </span>
      )}
    </span>
  )

  const timeEl = (
    <span className="text-[10px] text-tertiary flex-shrink-0 tabular-nums mt-[3px] group-hover:hidden">
      {time}
    </span>
  )

  return (
    <div className={rowShellClass}>
      {isRenaming ? (
        <div
          className="flex min-w-0 flex-1 cursor-text items-start gap-2.5"
          onClick={(e) => e.stopPropagation()}
        >
          {avatar}
          {titleBlock}
          {timeEl}
        </div>
      ) : (
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 text-left"
          onClick={onOpen}
        >
          {avatar}
          {titleBlock}
          {timeEl}
        </button>
      )}
      {menuColumn}
    </div>
  )
}

/* ── Component ── */

type SessionWithLabel = ChatSessionRecord & { workspaceLabel: string }
type SidebarTaskViewMode = 'activity' | 'workspace'

const SIDEBAR_VIEW_MODE_KEY = 'pe-sidebar-task-view-mode'

function ActivityIcon({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 6h13" />
      <path d="M8 12h13" />
      <path d="M8 18h13" />
      <path d="M3 6h.01" />
      <path d="M3 12h.01" />
      <path d="M3 18h.01" />
    </svg>
  )
}

function WorkspaceIcon({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="7" height="7" rx="1.5" />
      <rect x="14" y="4" width="7" height="7" rx="1.5" />
      <rect x="3" y="15" width="7" height="5" rx="1.5" />
      <rect x="14" y="15" width="7" height="5" rx="1.5" />
    </svg>
  )
}

export default function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const { theme, setTheme } = useTheme()
  const [servers, setServers] = useState<Server[]>([])
  const [allSessions, setAllSessions] = useState<SessionWithLabel[]>([])
  const [loading, setLoading] = useState(true)
  const [taskViewMode, setTaskViewModeState] = useState<SidebarTaskViewMode>('activity')
  const [currentUserId, setCurrentUserId] = useState<string>('')
  const [userEmails, setUserEmails] = useState<Record<string, string>>({})
  // Transient error surface for failed task mutations (delete/rename/pin).
  // Without this the API client's thrown Error just dies in the console
  // and the user has no idea why their click did nothing.
  const [taskError, setTaskError] = useState<string | null>(null)
  const taskErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashTaskError = useCallback((message: string) => {
    setTaskError(message)
    if (taskErrorTimerRef.current) clearTimeout(taskErrorTimerRef.current)
    taskErrorTimerRef.current = setTimeout(() => setTaskError(null), 4000)
  }, [])
  useEffect(() => () => {
    if (taskErrorTimerRef.current) clearTimeout(taskErrorTimerRef.current)
  }, [])
  // Trial-pool consumption signal. `null` = haven't fetched / no
  // trial workspace; widget hides. Refetched alongside the regular
  // server-list refresh so the count stays roughly current as the
  // user runs sessions.
  const [trialUsage, setTrialUsage] = useState<{ used: number; has: boolean } | null>(null)

  const chatMatch = pathname.match(/^\/dashboard\/([^/]+)$/)
  const activeServerId = chatMatch?.[1] ?? null
  const activeSessionId = searchParams.get('session')
  const defaultServer = servers.find(s => s.instanceState === 'running') ?? servers[0]

  const refresh = useCallback(async () => {
    try {
      const { servers: all } = await listServers()
      const active = all.filter(s => s.instanceState !== 'terminated')
      setServers(active)
      const sessionResults = await Promise.all(
        active.filter(s => s.instanceState === 'running').map(async (s) => {
          try {
            const { sessions } = await getSessions(s.serverId, 15)
            const workspaceLabel = formatWorkspaceLabel(s)
            return sessions.map(sess => ({ ...sess, workspaceLabel }))
          } catch { return [] }
        })
      )
      const SMOKE_PATTERN = /^Reply with exactly: smoke-/
      const merged = sessionResults.flat()
        .filter(s => !SMOKE_PATTERN.test(s.prompt ?? ''))
        .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime())
      setAllSessions(merged)
    } catch {}
    setLoading(false)
    // Best-effort fetch in parallel with the server/session refresh.
    // Failures already soft-fall to {used: 0, has: false} so we just
    // store whatever comes back.
    try {
      const usage = await getTrialUsage()
      setTrialUsage({ used: usage.trialSessionsUsed, has: usage.hasTrialWorkspace })
    } catch {}
  }, [])

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 6000)
    return () => clearInterval(interval)
  }, [refresh])

  // Identify the current user and pull the team roster once so task rows
  // can render "by <teammate-email>". Best-effort — failure leaves the map
  // empty and rows fall back to a userId prefix or skip the suffix entirely.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const session = await getRestoredSession()
        if (cancelled || !session) return
        setCurrentUserId(session.user.id)
      } catch { /* unauth — caller will navigate away */ }
      try {
        const { members } = await getMyTeam()
        if (cancelled) return
        const map: Record<string, string> = {}
        for (const m of members) {
          if (m.email) map[m.userId] = m.email
        }
        setUserEmails(map)
      } catch { /* not on a team */ }
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(SIDEBAR_VIEW_MODE_KEY)
      if (stored === 'workspace') setTaskViewModeState('workspace')
    } catch { /* ignore */ }
  }, [])

  function setTaskViewMode(mode: SidebarTaskViewMode) {
    setTaskViewModeState(mode)
    try {
      window.localStorage.setItem(SIDEBAR_VIEW_MODE_KEY, mode)
    } catch { /* ignore */ }
  }

  // Derive tasks + keep a map back to workspace label for the context line fallback.
  const { grouped, workspaceGroups, labelFor, defaultTaskId } = useMemo(() => {
    const views: TaskView[] = allSessions.map(toTaskView)
    const labelMap = new Map<string, string>()
    for (const s of allSessions) labelMap.set(s.sessionId, s.workspaceLabel)
    const g = groupTasks(views)
    const first = g.running[0] ?? g.readyForReview[0] ?? g.recent[0]
    const labelForTask = (task: TaskView) => labelMap.get(task.id) ?? 'Workspace'
    return {
      grouped: g,
      workspaceGroups: groupTasksByWorkspace(views, labelForTask),
      labelFor: (id: string) => labelMap.get(id),
      defaultTaskId: first?.id,
    }
  }, [allSessions])

  const openTask = useCallback((t: TaskView) => {
    router.push(`/dashboard/${t.session.serverId}?session=${t.id}`)
  }, [router])

  const removeTask = useCallback(async (t: TaskView) => {
    const isActive = activeServerId === t.session.serverId && activeSessionId === t.id
    try {
      await deleteSession(t.id)
    } catch (e) {
      flashTaskError((e as Error).message || 'Failed to delete session')
      return
    }
    setAllSessions(prev => prev.filter(x => x.sessionId !== t.id))
    if (isActive) router.push(`/dashboard/${t.session.serverId}?new=1`)
  }, [activeServerId, activeSessionId, router, flashTaskError])

  const renameTask = useCallback(async (t: TaskView, newTitle: string) => {
    try {
      await renameSession(t.id, newTitle)
    } catch (e) {
      flashTaskError((e as Error).message || 'Failed to rename session')
      return
    }
    setAllSessions(prev => prev.map(s => s.sessionId === t.id ? { ...s, title: newTitle } : s))
  }, [flashTaskError])

  const pinTask = useCallback(async (t: TaskView) => {
    const newPinned = !t.pinned
    try {
      await pinSession(t.id, newPinned)
    } catch (e) {
      flashTaskError((e as Error).message || 'Failed to update session')
      return
    }
    setAllSessions(prev => prev.map(s => s.sessionId === t.id ? { ...s, pinned: newPinned } : s))
  }, [flashTaskError])

  const isTaskActive = (t: TaskView) =>
    activeServerId === t.session.serverId &&
    (activeSessionId === t.id || (!activeSessionId && defaultTaskId === t.id))

  const sections: { label: string; tasks: TaskView[] }[] = [
    { label: 'Running', tasks: grouped.running },
    { label: 'Ready for review', tasks: grouped.readyForReview },
    { label: 'Recent', tasks: grouped.recent },
  ].filter(s => s.tasks.length > 0)
  const hasTasks = sections.length > 0
  const viewOptions: { mode: SidebarTaskViewMode; label: string; icon: React.ReactNode }[] = [
    { mode: 'activity', label: 'Group by activity', icon: <ActivityIcon /> },
    { mode: 'workspace', label: 'Group by workspace', icon: <WorkspaceIcon /> },
  ]

  return (
    <aside className="w-[272px] flex-shrink-0 flex flex-col min-h-dvh border-r border-line bg-[var(--sidebar-bg)]">
      {/* Logo */}
      <div className="h-14 flex items-center px-5 border-b border-line">
        <Link href="/dashboard">
          {/* Logo removed for now — plain text wordmark until the brand mark is finalized. */}
          <span className="text-[14px] font-semibold text-bright tracking-tight">Pocket Eng</span>
        </Link>
      </div>

      {/* New task */}
      <div className="px-3 pt-3 pb-1">
        {defaultServer ? (
          <Link
            href={`/dashboard/${defaultServer.serverId}?new=1`}
            className="flex items-center gap-2 w-full px-2.5 py-2 rounded-lg text-[12px] font-medium text-secondary bg-accent/5 hover:bg-accent/10 hover:text-bright transition-colors cursor-pointer"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            <span className="flex-1">New task</span>
            <kbd className="text-[10px] text-tertiary/60 font-mono bg-l2 border border-line rounded px-1 py-0.5 leading-none">&#8984;N</kbd>
          </Link>
        ) : (
          <Link
            href="/dashboard"
            className="flex items-center gap-2 w-full px-2.5 py-2 rounded-lg text-[12px] font-medium text-tertiary hover:bg-[var(--hover-bg)] hover:text-secondary transition-colors cursor-pointer"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            Create a workspace
          </Link>
        )}
      </div>

      {/* Tasks */}
      <nav className="overflow-y-auto px-2.5 pb-1" style={{ scrollbarWidth: 'thin', maxHeight: 'calc(100dvh - 340px)' }}>
        <div className="flex items-center justify-between px-2 pt-2 pb-1">
          <p className="text-[10px] font-medium text-tertiary/50 uppercase tracking-[0.08em]">Tasks</p>
          {hasTasks && (
            <div className="inline-flex items-center gap-0.5 p-[2px] rounded-[7px] bg-[var(--hover-bg)]">
              {viewOptions.map(option => (
                <button
                  key={option.mode}
                  type="button"
                  onClick={() => setTaskViewMode(option.mode)}
                  aria-label={option.label}
                  aria-pressed={taskViewMode === option.mode}
                  title={option.label}
                  className={`flex items-center justify-center w-[22px] h-[22px] rounded-[5px] transition-all duration-150 cursor-pointer ${
                    taskViewMode === option.mode
                      ? 'bg-ink text-bright shadow-sm'
                      : 'text-tertiary hover:text-secondary'
                  }`}
                >
                  {option.icon}
                </button>
              ))}
            </div>
          )}
        </div>
        {taskError && (
          <div
            role="alert"
            className="mx-1 mb-2 px-2 py-1.5 rounded-md border border-danger/30 bg-danger/10 text-[11px] text-danger animate-in fade-in slide-in-from-top-1 duration-150"
          >
            {taskError}
          </div>
        )}
        {loading ? (
          <div className="px-1 py-1">
            {[1, 2, 3, 4].map(i => <div key={i} className="skeleton h-6 rounded mb-1.5" />)}
          </div>
        ) : !hasTasks ? (
          <div className="px-2 py-4 text-center">
            <p className="text-[11px] text-tertiary">No tasks yet</p>
          </div>
        ) : taskViewMode === 'activity' ? (
          sections.map(section => (
            <div key={section.label} className="mt-2.5 first:mt-0">
              <p className="text-[10px] font-medium text-tertiary/50 px-2 mb-0.5 uppercase tracking-[0.04em]">
                {section.label}
                <span className="ml-1 text-tertiary/40 normal-case tracking-normal">{section.tasks.length}</span>
              </p>
              {section.tasks.map(t => (
                <TaskCard
                  key={t.id}
                  task={t}
                  workspaceLabel={labelFor(t.id)}
                  isActive={isTaskActive(t)}
                  onOpen={() => openTask(t)}
                  onDelete={() => removeTask(t)}
                  onRename={(title) => renameTask(t, title)}
                  onPin={() => pinTask(t)}
                  currentUserId={currentUserId}
                  userEmails={userEmails}
                />
              ))}
            </div>
          ))
        ) : (
          workspaceGroups.map(group => (
            <div key={group.serverId} className="mt-2.5 first:mt-0">
              <p className="flex items-center justify-between gap-2 text-[10px] font-medium text-tertiary/50 px-2 mb-0.5 uppercase tracking-[0.04em]">
                <span className="truncate" title={group.label}>{group.label}</span>
                <span className="text-tertiary/40 normal-case tracking-normal">{group.tasks.length}</span>
              </p>
              {group.tasks.map(t => (
                <TaskCard
                  key={t.id}
                  task={t}
                  isActive={isTaskActive(t)}
                  onOpen={() => openTask(t)}
                  onDelete={() => removeTask(t)}
                  onRename={(title) => renameTask(t, title)}
                  onPin={() => pinTask(t)}
                  currentUserId={currentUserId}
                  userEmails={userEmails}
                />
              ))}
            </div>
          ))
        )}
      </nav>

      {/* Trial usage widget — only renders for users with at least
          one trial workspace and at least one session run on it.
          Surfaces the shared-pool consumption + a soft pitch toward
          connecting their own credentials. Sits above the bottom
          settings nav so it's visible without scrolling but not in
          the user's primary task path. */}
      {trialUsage?.has && trialUsage.used > 0 && (
        <Link
          href="/dashboard/agents"
          className="mt-auto mx-3 mb-3 px-3 py-2.5 rounded-lg bg-accent/5 border border-accent/15 hover:bg-accent/10 hover:border-accent/25 transition-colors cursor-pointer block"
          title="Connect your own Claude / Codex / Cursor subscription"
        >
          <div className="text-[11px] font-medium text-bright">
            {trialUsage.used} trial {trialUsage.used === 1 ? 'session' : 'sessions'} used
          </div>
          <div className="text-[10px] text-tertiary mt-0.5">
            Connect your subscription to keep going
          </div>
        </Link>
      )}

      {/* Bottom section */}
      <div className={`${trialUsage?.has && trialUsage.used > 0 ? '' : 'mt-auto'} border-t border-line px-2.5 pt-3 pb-3`}>
        <p className="text-[10px] font-medium text-tertiary/50 uppercase tracking-[0.08em] px-2 mb-1">Settings</p>
        <Link
          href="/dashboard?manage"
          className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] transition-colors ${
            pathname === '/dashboard' && !activeServerId ? 'bg-[var(--active-bg)] text-bright font-medium' : 'text-tertiary hover:bg-[var(--hover-bg)] hover:text-secondary'
          }`}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3" width="20" height="8" rx="2" /><rect x="2" y="13" width="20" height="8" rx="2" />
            <circle cx="6" cy="7" r="1" fill="currentColor" stroke="none" /><circle cx="6" cy="17" r="1" fill="currentColor" stroke="none" />
          </svg>
          Workspaces
        </Link>
        {CONFIGURE_ITEMS.map(item => {
          const active = pathname === item.href
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] transition-colors ${
                active ? 'bg-[var(--active-bg)] text-bright font-medium' : 'text-tertiary hover:bg-[var(--hover-bg)] hover:text-secondary'
              }`}
            >
              {item.icon}
              {item.label}
            </Link>
          )
        })}

        {/* Theme toggle — compact two-segment pill, centered */}
        <div className="mt-3 pt-3 border-t border-line text-center">
          <div className="inline-flex items-center gap-0.5 p-[2px] rounded-[7px] bg-[var(--hover-bg)] mx-auto">
            {(['light', 'dark'] as const).map(t => (
              <button
                key={t}
                onClick={() => setTheme(t)}
                aria-label={`Switch to ${t} theme`}
                aria-pressed={theme === t}
                title={t === 'light' ? 'Light' : 'Dark'}
                className={`flex items-center justify-center w-[22px] h-[22px] rounded-[5px] transition-all duration-150 cursor-pointer ${
                  theme === t
                    ? 'bg-ink text-bright shadow-sm'
                    : 'text-tertiary hover:text-secondary'
                }`}
              >
                {t === 'light' && <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><circle cx="12" cy="12" r="5" /><path strokeLinecap="round" d="M12 1v2m0 18v2m11-11h-2M3 12H1m16.364-7.364l-1.414 1.414M7.05 16.95l-1.414 1.414m12.728 0l-1.414-1.414M7.05 7.05L5.636 5.636" /></svg>}
                {t === 'dark' && <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" /></svg>}
              </button>
            ))}
          </div>
        </div>
      </div>
    </aside>
  )
}
