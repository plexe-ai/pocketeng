'use client'

import { Suspense, useEffect, useState, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { getRestoredSession } from '@/lib/supabase'
import { listServers, Server } from '@/lib/api'
import { readCache, writeCache } from '@/lib/cache'
import ServerCard from '@/components/ServerCard'
import ProvisionForm from '@/components/ProvisionForm'
import ConnectForm from '@/components/ConnectForm'

const TRANSITIONING = new Set(['launching', 'pending', 'stopping'])
const MAX_ENVIRONMENTS = 5

const WEB_CHAT_AGENTS = ['claude', 'codex', 'cursor', 'opencode']

// Cache key for the "active servers" list. Namespaced so a future shape
// change (e.g. Server gains a required field) can invalidate stale caches
// by bumping the version here and in lib/cache.ts's CACHE_PREFIX.
const SERVERS_CACHE_KEY = 'dashboard:active-servers'
// Don't trust cached servers older than 2 minutes — short enough that
// state-machine values (launching → running) don't linger long after a
// user deletes/reprovisions from another device.
const SERVERS_CACHE_TTL_MS = 2 * 60 * 1000

export default function DashboardPage() {
  return (
    <Suspense fallback={
      <div className="px-8 py-8">
        <div className="skeleton w-32 h-5 mb-2" />
        <div className="skeleton w-48 h-3 mb-8" />
        <div className="skeleton w-full h-12 mb-3" />
        <div className="skeleton w-full h-12" />
      </div>
    }>
      <DashboardContent />
    </Suspense>
  )
}

function DashboardContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const forceManage = searchParams.get('manage') !== null

  // Cached-first paint. If we have a recent snapshot of the user's server
  // list in localStorage, hydrate state from it so the dashboard renders
  // real content on first paint instead of a skeleton. The useEffect
  // below still fires a fresh listServers() in the background and diff-
  // updates state when it resolves — the cache is a visual head-start,
  // not a source of truth.
  //
  // Note: this only helps the "dashboard list view" render path. For
  // returning users with a running workspace, auto-redirect still fires
  // off FRESH data (not cache) — we don't want to send someone to a
  // workspace that was terminated from another device.
  const cachedServers = useState(() =>
    readCache<Server[]>(SERVERS_CACHE_KEY, SERVERS_CACHE_TTL_MS) ?? null
  )[0]

  const [loading, setLoading]             = useState(cachedServers === null)
  const [servers, setServers]             = useState<Server[]>(cachedServers ?? [])
  const [fetchError, setFetchError]       = useState<string | null>(null)
  const [showProvision, setShowProvision] = useState(false)
  const [showConnect, setShowConnect]     = useState(false)

  const fetchServers = useCallback(async () => {
    setFetchError(null)
    const { servers: all } = await listServers()
    const active = all.filter(s => s.instanceState !== 'terminated')
    setServers(active)
    // Persist for the next cold open. Fire and forget — cache.ts's
    // writeCache swallows quota/private-mode errors.
    writeCache(SERVERS_CACHE_KEY, active)
    return active
  }, [])

  const anyTransitioning = servers.some(s => TRANSITIONING.has(s.instanceState))
  const atLimit = servers.length >= MAX_ENVIRONMENTS

  useEffect(() => {
    if (!anyTransitioning) return
    const interval = setInterval(async () => {
      try {
        const { servers: all } = await listServers()
        const active = all.filter(s => s.instanceState !== 'terminated')
        setServers(active)
        // Keep the cache fresh on the polling path too — a user who
        // cold-opens while a workspace is launching elsewhere shouldn't
        // see a 2-minute-old "launching" snapshot.
        writeCache(SERVERS_CACHE_KEY, active)
      } catch { /* ignore */ }
    }, 5000)
    return () => clearInterval(interval)
  }, [anyTransitioning])

  useEffect(() => {
    // Fire the auth check (cached, ~synchronous from localStorage) and the
    // workspaces fetch (network → Lambda) IN PARALLEL, not in series. For a
    // user in Asia hitting us-east-1 Supabase + Lambda, this halves the
    // perceived "dashboard is loading" window — ~200-400ms saved.
    //
    // Two deliberate choices:
    //   1. `getSession()` (localStorage-cached) instead of `getUser()`
    //      (network). getSession includes user_metadata so we can gate on
    //      `onboarded` without a round-trip.
    //   2. We kick off fetchServers even before we've confirmed the session
    //      is valid. For signed-in users this is the common path; for
    //      signed-out users the request 401s but we catch it below and
    //      redirect to `/` — the servers-error banner is only surfaced when
    //      the user IS authenticated and the Lambda genuinely broke.
    //
    // Use `Promise.allSettled` (not `Promise.all`) so a fetchServers
    // rejection (e.g. 401 for an unauthenticated user) doesn't short-circuit
    // past our auth check. Session-state is always evaluated first, even if
    // the parallel fetch exploded — that's what actually protects the
    // signed-out redirect.
    const authPromise = getRestoredSession()
    const serversPromise = fetchServers()

    Promise.allSettled([authPromise, serversPromise])
      .then(([authResult, serversResult]) => {
        const session = authResult.status === 'fulfilled' ? authResult.value : null

        // Auth check runs unconditionally — no amount of network churn
        // from fetchServers can prevent us from catching a signed-out user.
        if (!session) { router.replace('/'); return }
        if (!session.user.user_metadata?.onboarded) {
          router.replace('/onboarding')
          return
        }

        // Authenticated user — surface fetchServers failures here (now we
        // know a rejection means "Lambda is broken," not "user is logged
        // out and got a 401").
        if (serversResult.status === 'rejected') {
          setFetchError((serversResult.reason as Error)?.message ?? 'Failed to load workspaces.')
          setLoading(false)
          return
        }

        const active = serversResult.value
        // Auto-redirect to a session unless user explicitly wants workspace list (?manage)
        if (!forceManage && active.length > 0) {
          const running = active.find(s =>
            s.instanceState === 'running' && s.agents?.some(a => WEB_CHAT_AGENTS.includes(a))
          )
          const target = running ?? active[0]
          router.replace(`/dashboard/${target.serverId}?new=1`)
          return
        }
        setLoading(false)
      })
  }, [router, fetchServers, forceManage])

  // State updates also rewrite the cache so a subsequent cold-open
  // doesn't paint stale data — a user who just deleted a workspace
  // shouldn't see it flash back in for a moment on the next open.
  function handleStateChange(updated: Server) {
    setServers(prev => {
      const next = prev.map(s => s.serverId === updated.serverId ? updated : s)
      writeCache(SERVERS_CACHE_KEY, next)
      return next
    })
  }
  function handleDeleted(serverId: string) {
    setServers(prev => {
      const next = prev.filter(s => s.serverId !== serverId)
      writeCache(SERVERS_CACHE_KEY, next)
      return next
    })
  }

  const hasServers = servers.length > 0

  if (loading) {
    return (
      <div className="px-8 py-8">
        <div className="skeleton w-32 h-5 mb-2" />
        <div className="skeleton w-48 h-3 mb-8" />
        <div className="skeleton w-full h-12 mb-3" />
        <div className="skeleton w-full h-12" />
      </div>
    )
  }

  return (
    <div className="px-5 py-4 md:px-8 md:py-8 max-w-4xl animate-fade-in">

      {/* Page heading */}
      <div className="mb-6 md:mb-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="hidden md:block text-[16px] font-semibold text-bright tracking-tight">Workspaces</h1>
            <p className="text-[13px] text-secondary md:mt-1">
              {hasServers && <span className="text-tertiary">{servers.length}/{MAX_ENVIRONMENTS} workspaces</span>}
              <span className="hidden md:inline">
                {hasServers ? ' · ' : ''}Your cloud dev workspaces with AI coding agents.
              </span>
            </p>
          </div>
          {hasServers && !showProvision && !showConnect && (
            <div className="flex items-center gap-3 flex-shrink-0">
              {!atLimit && (
                <button
                  onClick={() => setShowProvision(true)}
                  className="btn btn-primary btn-sm cursor-pointer"
                >
                  + New
                </button>
              )}
              <button
                onClick={() => setShowConnect(true)}
                className="hidden md:inline text-[12px] text-tertiary hover:text-secondary transition-colors cursor-pointer"
              >
                Connect existing
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Fetch error */}
      {fetchError && (
        <div className="flex items-center gap-2 mb-6 animate-fade-in">
          <p className="text-[12px] text-danger">{fetchError}</p>
          <button
            onClick={() => fetchServers().catch(e => setFetchError((e as Error).message))}
            className="text-[11px] text-tertiary hover:text-secondary cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}

      {/* Server list */}
      {hasServers && (
        <div className="flex flex-col gap-3 mb-8">
          {servers.map(server => (
            <ServerCard
              key={server.serverId}
              server={server}
              onStateChange={handleStateChange}
              onDeleted={() => handleDeleted(server.serverId)}
            />
          ))}
        </div>
      )}

      {/* Provision form */}
      {(showProvision || (!hasServers && !showConnect)) && !atLimit && (
        <div className="rounded-xl bg-ink border border-line p-6 animate-fade-in">
          <div className="flex items-center justify-between mb-5">
            <div>
              <p className="text-[15px] font-semibold text-bright">New workspace</p>
              <p className="text-[12px] text-tertiary mt-0.5">Configure and launch a cloud dev workspace.</p>
            </div>
            {hasServers && (
              <button
                onClick={() => setShowProvision(false)}
                className="text-tertiary hover:text-secondary transition-colors cursor-pointer"
                aria-label="Close"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
          <ProvisionForm
            onProvisioned={s => {
              setServers(prev => [...prev, s])
              setShowProvision(false)
            }}
          />
        </div>
      )}

      {/* Connect existing */}
      {showConnect && (
        <div className="rounded-xl bg-ink border border-line p-6 animate-fade-in">
          <ConnectForm
            onConnected={async () => {
              setShowConnect(false)
              try { await fetchServers() } catch {}
            }}
            onCancel={() => setShowConnect(false)}
          />
        </div>
      )}

      {/* Limit reached */}
      {atLimit && showProvision && (
        <p className="text-[12px] text-tertiary pt-3 animate-fade-in">
          Limit reached ({MAX_ENVIRONMENTS}). Delete one to create another.
        </p>
      )}
    </div>
  )
}
