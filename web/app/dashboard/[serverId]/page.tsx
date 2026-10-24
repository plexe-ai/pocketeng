'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { getRestoredSession } from '@/lib/supabase'
import { getServer, Server } from '@/lib/api'
import { readCache, writeCache } from '@/lib/cache'
import ChatWindow from '@/components/ChatWindow'

const SERVER_CACHE_TTL_MS = 2 * 60 * 1000
const serverCacheKey = (serverId: string) => `server:${serverId}`

function ChatPageInner() {
  const router = useRouter()
  const params = useParams()
  const serverId = params.serverId as string

  const [server, setServer] = useState<Server | null>(() =>
    readCache<Server>(serverCacheKey(serverId), SERVER_CACHE_TTL_MS),
  )
  const [loading, setLoading] = useState(() =>
    readCache<Server>(serverCacheKey(serverId), SERVER_CACHE_TTL_MS) === null,
  )
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    void (async () => {
      const session = await getRestoredSession()
      if (cancelled) return
      if (!session) { router.replace('/'); return }

      try {
        const fresh = await getServer(serverId)
        if (cancelled) return
        writeCache(serverCacheKey(serverId), fresh)
        setServer(fresh)
      } catch (e) {
        if (cancelled) return
        setError((e as Error).message)
      } finally {
        if (cancelled) return
        setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [serverId, router])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3 animate-fade-in">
          <div className="w-4 h-4 border-2 border-line border-t-accent rounded-full animate-spin" />
        </div>
      </div>
    )
  }

  if (error || !server) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <p className="text-[13px] text-danger">{error ?? 'Workspace not found'}</p>
      </div>
    )
  }

  const isRunning = server.instanceState === 'running'

  return (
    // Must be a top-level <section> so the parent dashboard layout's
    // [&:has(>section)]:overflow-hidden selector fires and disables its
    // own outer scroller. Without this, two nested overflow-y-auto
    // containers stack and iOS WKWebView locks out touch scrolling on
    // the inner chat feed entirely.
    <section className="flex flex-col h-full overflow-hidden">
      {!isRunning && (
        <div className="flex items-center gap-2 px-5 py-2 border-b border-amber/20 bg-amber/5 flex-shrink-0">
          <span className="h-1.5 w-1.5 rounded-full bg-amber" />
          <span className="text-[12px] text-amber">Workspace is not running</span>
        </div>
      )}
      <div className="flex-1 min-h-0">
        <ChatWindow server={server} />
      </div>
    </section>
  )
}

export default function ChatPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-full">
        <div className="w-4 h-4 border-2 border-line border-t-accent rounded-full animate-spin" />
      </div>
    }>
      <ChatPageInner />
    </Suspense>
  )
}
