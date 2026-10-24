'use client'

import { useCallback, useEffect, useState } from 'react'
import { discoverServices } from '@/lib/api'
import { supabase } from '@/lib/supabase'
import { buildPreviewUrl, ensurePreviewCookie, isCloudflareManaged, type PreviewEnvType } from '@/lib/preview'

interface Service {
  port: number
  process: string
  url: string
}

export default function PreviewPanel({
  serverId,
  envType,
  onClose,
}: {
  serverId: string
  /** Drives whether we route through Cloudflare (managed) or the
   *  authenticated `/api/preview/...` proxy (BYOS + fallback). */
  envType?: PreviewEnvType | string | null
  onClose: () => void
}) {
  const [services, setServices] = useState<Service[]>([])
  const [loading, setLoading] = useState(true)
  const usesProxy = !isCloudflareManaged(envType)

  // The legacy `/api/preview/...` proxy needs a Supabase JWT pinned to a
  // cookie. Cloudflare-served previews talk straight to the browser so
  // we skip the cookie write entirely — nothing on our Vercel origin
  // serves those requests.
  useEffect(() => {
    if (!usesProxy) return
    void ensurePreviewCookie()
    const { data: { subscription } } = supabase.auth.onAuthStateChange(() => {
      void ensurePreviewCookie()
    })
    return () => subscription.unsubscribe()
  }, [usesProxy])

  const scan = useCallback(async () => {
    setLoading(true)
    try {
      const { services: found } = await discoverServices(serverId)
      setServices(found)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [serverId])

  useEffect(() => { void scan() }, [scan])

  return (
    <div className="flex flex-col h-full w-full border-l border-line bg-ink">
      {/* Header — pads under iOS safe-area-top so the Dynamic Island
          doesn't overlap title/icons on mobile fullscreen. */}
      <div
        className="flex items-center justify-between px-4 border-b border-line flex-shrink-0"
        style={{
          paddingTop: 'max(0.75rem, var(--safe-area-top))',
          paddingBottom: '0.75rem',
        }}
      >
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.64 0 8.577 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.64 0-8.577-3.007-9.963-7.178z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <span className="text-[13px] font-semibold text-bright">Preview</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={scan}
            disabled={loading}
            className="p-1.5 rounded-md text-tertiary hover:text-secondary hover:bg-[var(--hover-bg)] transition-colors cursor-pointer disabled:opacity-50"
            title="Rescan services"
          >
            <svg className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" />
            </svg>
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-tertiary hover:text-secondary hover:bg-[var(--hover-bg)] transition-colors cursor-pointer"
            title="Close preview"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Services list */}
      <div className="flex-1 overflow-y-auto">
        {services.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 px-6 text-center">
            {loading ? (
              <>
                <div className="w-4 h-4 border-2 border-line border-t-accent rounded-full animate-spin" />
                <p className="text-[12px] text-tertiary">Scanning for services...</p>
              </>
            ) : (
              <>
                <svg className="w-8 h-8 text-tertiary/30" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 003 12c0-1.605.42-3.113 1.157-4.418" />
                </svg>
                <p className="text-[12px] text-tertiary">No services detected</p>
                <p className="text-[11px] text-tertiary/60">Start a dev server on the workspace, then tap rescan</p>
              </>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {services.map(s => (
              <li key={s.port}>
                <a
                  href={buildPreviewUrl(serverId, s.port, '', envType)}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => { if (usesProxy) void ensurePreviewCookie() }}
                  className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-[var(--hover-bg)] transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="h-2 w-2 rounded-full bg-green flex-shrink-0" />
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium text-bright">Port {s.port}</div>
                      {s.process && (
                        <div className="text-[11px] text-tertiary truncate">{s.process}</div>
                      )}
                    </div>
                  </div>
                  <svg className="w-3.5 h-3.5 text-tertiary flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                  </svg>
                </a>
              </li>
            ))}
          </ul>
        )}

        <p className="text-[11px] text-tertiary/60 text-center px-4 py-3">
          Previews open in a new tab. Live reload / HMR is disabled — refresh the tab to see updates.
        </p>
      </div>
    </div>
  )
}
