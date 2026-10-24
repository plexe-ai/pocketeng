'use client'

import { Suspense, useEffect } from 'react'
import Sidebar from '@/components/Sidebar'
import UserProfile from '@/components/UserProfile'
import MobileHeader from '@/components/mobile/MobileHeader'
import BottomTabs from '@/components/mobile/BottomTabs'
import SettingsTabBar from '@/components/mobile/SettingsTabBar'
import CommandPalette from '@/components/CommandPalette'

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Lock the document so it can't scroll while the dashboard shell is
  // mounted. The shell is already `h-dvh overflow-hidden`, but on iOS
  // WKWebView the BODY itself can still grow + scroll under specific
  // conditions (stale-HTML cache stacking two pages, transient layout
  // overflow during a route transition). When that happens the user
  // sees the old route — most visibly the sign-in page — slide into
  // view as they scroll the chat feed. Pinning html+body to viewport
  // height with overflow:hidden makes that physically impossible. Auth
  // / onboarding routes use the root layout (no `h-dvh` pin), so they
  // are intentionally unaffected.
  useEffect(() => {
    const html = document.documentElement
    const body = document.body
    const prevHtmlOverflow = html.style.overflow
    const prevBodyOverflow = body.style.overflow
    const prevHtmlHeight = html.style.height
    const prevBodyHeight = body.style.height
    html.style.overflow = 'hidden'
    body.style.overflow = 'hidden'
    html.style.height = '100%'
    body.style.height = '100%'
    return () => {
      html.style.overflow = prevHtmlOverflow
      body.style.overflow = prevBodyOverflow
      html.style.height = prevHtmlHeight
      body.style.height = prevBodyHeight
    }
  }, [])

  return (
    <div className="h-dvh flex flex-col md:flex-row bg-ink overflow-hidden">
      <CommandPalette />

      {/* Desktop sidebar */}
      <div className="hidden md:flex">
        <Suspense fallback={<aside className="w-[240px] flex-shrink-0 border-r border-line bg-[var(--sidebar-bg)]" />}>
          <Sidebar />
        </Suspense>
      </div>

      <div className="flex-1 min-w-0 min-h-0 flex flex-col">
        {/* Desktop top bar */}
        <div className="hidden md:flex items-center justify-end px-5 h-14 border-b border-line bg-[var(--topbar-bg)] flex-shrink-0">
          <UserProfile />
        </div>

        {/* Mobile header */}
        <div className="md:hidden">
          <MobileHeader />
        </div>

        {/* Mobile settings sub-nav — visible on settings-group pages */}
        <SettingsTabBar />

        {/* Content */}
        <div id="dashboard-content" className="flex-1 min-h-0 overflow-y-auto page-gradient [&:has(>section)]:overflow-hidden">
          {children}
        </div>

        {/* Mobile bottom tabs */}
        <div className="md:hidden">
          <BottomTabs />
        </div>
      </div>
    </div>
  )
}
