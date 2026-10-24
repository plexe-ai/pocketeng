'use client'

/**
 * AuthViewportShell — the full-screen surface used by auth-boundary
 * routes (/, /onboarding) so they own the viewport from first commit.
 *
 * Why this exists: in WKWebView (the iOS / Android Capacitor shell)
 * and to a lesser extent backgrounded Chromium, the previous route's
 * DOM is not torn down the moment React unmounts it — it stays
 * painted until the new route puts something opaque over it. A route
 * that returns `null` (or a non-fixed `min-h-dvh` container) during a
 * loading state therefore leaves stale dashboard content visible
 * underneath.
 *
 * The fix is exactly the pattern the dashboard layout uses to claim
 * the viewport: an opaque `fixed inset-0` element that scrolls itself,
 * plus an html+body lock on mount that's restored on unmount so
 * navigating away to the dashboard doesn't strand the body in a
 * locked state.
 *
 * See:
 *   .harness/learnings/2026-04-landing-auth-restore-must-own-viewport.md
 *   .harness/learnings/2026-04-mobile-chat-scroll-leaks-to-landing.md
 *
 * The two are mirror images of the same stale-route-DOM bug class:
 * one is "dashboard scrolls and reveals landing", the other is
 * "landing loads and reveals dashboard."
 */

import { useEffect, type ReactNode } from 'react'

interface Props {
  children?: ReactNode
  /** Defaults centered (the sign-in card use case). Pass `false` for
   *  longer flows like /onboarding where the content needs to start
   *  from the top of the scroll container. */
  centerContent?: boolean
}

export default function AuthViewportShell({ children, centerContent = true }: Props) {
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
    window.scrollTo(0, 0)

    return () => {
      html.style.overflow = prevHtmlOverflow
      body.style.overflow = prevBodyOverflow
      html.style.height = prevHtmlHeight
      body.style.height = prevBodyHeight
    }
  }, [])

  const inner = centerContent
    ? 'min-h-full px-6 flex flex-col items-center justify-center'
    : 'min-h-full px-6'

  // Pad past the iOS Dynamic Island / Android status bar so the logo and
  // first form controls aren't drawn under the system status bar in the
  // Capacitor WKWebView. On non-native (browser, desktop Electron) the
  // env() values are 0 so we still get the original 2rem of breathing
  // room from the max() floor.
  const safePadding = {
    paddingTop: 'max(2rem, calc(var(--safe-area-top) + 1rem))',
    paddingBottom: 'max(2rem, calc(var(--safe-area-bottom) + 1rem))',
  }

  return (
    <div className="fixed inset-0 z-40 overflow-y-auto bg-ink page-gradient isolate">
      <div className={inner} style={safePadding}>
        {children}
      </div>
    </div>
  )
}
