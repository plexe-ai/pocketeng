'use client'

import { useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { getRestoredSession, supabase } from '@/lib/supabase'

export default function UserProfile() {
  const router = useRouter()
  const [email, setEmail] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Read from the locally restored session instead of a network
    // getUser() — same reason the dashboard guards swapped: mobile
    // resume / network churn would leave the avatar showing a
    // placeholder for no good reason. See learnings/
    // 2026-04-mobile-route-guards-must-not-use-getuser.md.
    let cancelled = false
    void getRestoredSession().then(session => {
      if (cancelled) return
      setEmail(session?.user.email ?? null)
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  async function handleSignOut() {
    // Drop localStorage caches first so the next user (or the same user
    // signed in as someone else) doesn't see the previous account's
    // dashboard flash before their own data loads.
    const { clearAllCache } = await import('@/lib/cache')
    clearAllCache()
    await supabase.auth.signOut()
    router.replace('/')
  }

  const initial = email ? email[0].toUpperCase() : '?'

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(v => !v)}
        className="w-8 h-8 rounded-full bg-l1 border border-line flex items-center justify-center text-[12px] font-semibold text-secondary hover:bg-l2 hover:text-bright transition-all duration-150 cursor-pointer"
        aria-label="User menu"
      >
        {initial}
      </button>

      {open && (
        <div className="absolute right-0 top-10 rounded-xl z-30 w-56 animate-scale-in bg-ink border border-line shadow-[0_16px_48px_rgba(0,0,0,0.2)]">
          {email && (
            <div className="px-4 py-3 border-b border-line">
              <p className="text-[11px] text-tertiary truncate" title={email}>{email}</p>
            </div>
          )}
          <button
            onClick={() => { setOpen(false); router.push('/dashboard/settings') }}
            className="w-full text-left px-4 py-2.5 text-[13px] text-secondary hover:bg-[var(--hover-bg)] hover:text-bright transition-colors duration-150 cursor-pointer flex items-center gap-2.5"
          >
            <svg className="w-3.5 h-3.5 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7}>
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            Settings
          </button>
          <button
            onClick={handleSignOut}
            className="w-full text-left px-4 py-2.5 text-[13px] text-tertiary hover:bg-[var(--hover-bg)] hover:text-secondary transition-colors duration-150 cursor-pointer border-t border-line flex items-center gap-2.5"
          >
            <svg className="w-3.5 h-3.5 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
            </svg>
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}
