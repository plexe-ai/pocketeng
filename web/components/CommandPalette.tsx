'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { ChatSessionRecord, Server, listServers, getSessions } from '@/lib/api'

type SessionItem = ChatSessionRecord & { workspaceLabel: string }

function fuzzyMatch(text: string, query: string): boolean {
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  let qi = 0
  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) qi++
  }
  return qi === q.length
}

function formatTime(value: string | null | undefined): string {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  const s = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

function statusDot(status: ChatSessionRecord['status']): string {
  switch (status) {
    case 'running': return 'bg-green'
    case 'error': return 'bg-danger'
    case 'cancelled': return 'bg-amber'
    default: return 'bg-tertiary/40'
  }
}

export default function CommandPalette() {
  const router = useRouter()
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [sessions, setSessions] = useState<SessionItem[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedIdx, setSelectedIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Current chat page context
  const chatMatch = pathname.match(/^\/dashboard\/([^/]+)$/)
  const activeServerId = chatMatch?.[1] ?? null

  // Fetch sessions when palette opens
  const fetchSessions = useCallback(async () => {
    setLoading(true)
    try {
      const { servers } = await listServers()
      const active = servers.filter((s: Server) => s.instanceState !== 'terminated')
      const results = await Promise.all(
        active.filter((s: Server) => s.instanceState === 'running').map(async (s: Server) => {
          try {
            const { sessions } = await getSessions(s.serverId, 20)
            return sessions.map(sess => ({
              ...sess,
              workspaceLabel: s.label || (s.envType === 'byos' ? 'Server' : 'Workspace'),
            }))
          } catch { return [] }
        })
      )
      const SMOKE = /^Reply with exactly: smoke-/
      const merged = results.flat()
        .filter(s => !SMOKE.test(s.prompt ?? ''))
        .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime())
      setSessions(merged)
    } catch {}
    setLoading(false)
  }, [])

  // Open/close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey

      // Cmd+K — toggle command palette
      if (isMod && e.key === 'k') {
        e.preventDefault()
        setOpen(prev => {
          if (!prev) {
            setQuery('')
            setSelectedIdx(0)
            fetchSessions()
          }
          return !prev
        })
      }

      // Cmd+[ — previous session (only on chat page)
      if (isMod && e.key === '[' && activeServerId) {
        e.preventDefault()
        navigateSession(-1)
      }

      // Cmd+] — next session (only on chat page)
      if (isMod && e.key === ']' && activeServerId) {
        e.preventDefault()
        navigateSession(1)
      }

      // Cmd+Shift+N — new workspace
      if (isMod && e.shiftKey && e.key === 'N') {
        e.preventDefault()
        router.push('/dashboard?manage')
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [activeServerId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Navigate to adjacent session
  const navigateSession = useCallback((direction: number) => {
    if (sessions.length === 0) return
    const currentUrl = new URLSearchParams(window.location.search)
    const currentSessionId = currentUrl.get('session')
    const idx = sessions.findIndex(s => s.sessionId === currentSessionId)
    const nextIdx = idx === -1
      ? 0
      : Math.max(0, Math.min(sessions.length - 1, idx + direction))
    const next = sessions[nextIdx]
    if (next) router.push(`/dashboard/${next.serverId}?session=${next.sessionId}`)
  }, [sessions, router])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setOpen(false) }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open])

  // Focus input when opened
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0)
  }, [open])

  // Filter sessions
  const filtered = query.trim()
    ? sessions.filter(s => {
        const text = `${s.lastPrompt || s.prompt || ''} ${s.workspaceLabel}`
        return fuzzyMatch(text, query)
      })
    : sessions

  // Clamp selection
  useEffect(() => {
    setSelectedIdx(0)
  }, [query])

  // Scroll selected into view
  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.children[selectedIdx] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIdx(i => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIdx(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = filtered[selectedIdx]
      if (item) {
        router.push(`/dashboard/${item.serverId}?session=${item.sessionId}`)
        setOpen(false)
      }
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[min(20vh,140px)]"
      onClick={() => setOpen(false)}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />

      {/* Palette */}
      <div
        className="relative w-full max-w-lg mx-4 rounded-2xl bg-ink border border-line shadow-[0_20px_60px_rgba(0,0,0,0.4)] animate-scale-in overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 h-14 border-b border-line">
          <svg className="w-4 h-4 text-tertiary flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Jump to session..."
            className="flex-1 bg-transparent text-[15px] text-bright placeholder:text-tertiary outline-none"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="hidden md:flex items-center text-[11px] text-tertiary bg-l2 rounded px-1.5 py-0.5 font-mono">
            esc
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[320px] overflow-y-auto py-1" style={{ scrollbarWidth: 'thin' }}>
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8">
              <span className="w-3 h-3 border-[1.5px] border-accent/20 border-t-accent rounded-full animate-spin" />
              <span className="text-[12px] text-tertiary">Loading sessions...</span>
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-[13px] text-tertiary">{query ? 'No matching sessions' : 'No sessions yet'}</p>
            </div>
          ) : (
            filtered.map((s, i) => {
              const isSelected = i === selectedIdx
              const title = s.lastPrompt || s.prompt || 'Untitled session'
              return (
                <button
                  key={s.sessionId}
                  onClick={() => {
                    router.push(`/dashboard/${s.serverId}?session=${s.sessionId}`)
                    setOpen(false)
                  }}
                  onMouseEnter={() => setSelectedIdx(i)}
                  className={`w-full flex items-center gap-3 px-4 py-2.5 text-left cursor-pointer transition-colors ${
                    isSelected ? 'bg-accent/8' : ''
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusDot(s.status)}`} />
                  <div className="flex-1 min-w-0">
                    <p className={`text-[13px] truncate ${isSelected ? 'text-bright' : 'text-secondary'}`}>
                      {title}
                    </p>
                    <p className="text-[11px] text-tertiary truncate">
                      {s.workspaceLabel}
                    </p>
                  </div>
                  <span className="text-[10px] text-tertiary flex-shrink-0 tabular-nums">
                    {formatTime(s.updatedAt || s.createdAt)}
                  </span>
                </button>
              )
            })
          )}
        </div>

        {/* Footer hints */}
        <div className="flex items-center gap-4 px-4 py-2 border-t border-line">
          <span className="flex items-center gap-1.5 text-[10px] text-tertiary">
            <kbd className="bg-l2 rounded px-1 py-0.5 font-mono">↑↓</kbd> navigate
          </span>
          <span className="flex items-center gap-1.5 text-[10px] text-tertiary">
            <kbd className="bg-l2 rounded px-1 py-0.5 font-mono">↵</kbd> open
          </span>
          <span className="flex items-center gap-1.5 text-[10px] text-tertiary">
            <kbd className="bg-l2 rounded px-1 py-0.5 font-mono">esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  )
}
