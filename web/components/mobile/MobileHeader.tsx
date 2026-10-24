'use client'

import { usePathname, useRouter } from 'next/navigation'
import { hapticLight } from '@/lib/native'

const PAGE_TITLES: Record<string, string> = {
  '/dashboard': 'Workspaces',
  '/dashboard/sessions': 'Sessions',
  '/dashboard/settings': 'Settings',
  '/dashboard/agents': 'Coding Agents',
  '/dashboard/skills': 'Harness',
  '/dashboard/integrations': 'Integrations',
}

// Pages reachable directly from BottomTabs or settings tab bar — no Back button needed.
const TAB_ROOTS = new Set([
  '/dashboard', '/dashboard/sessions', '/dashboard/settings',
  '/dashboard/agents', '/dashboard/skills', '/dashboard/integrations',
])

export default function MobileHeader() {
  const pathname = usePathname()
  const router = useRouter()

  const isTabRoot = TAB_ROOTS.has(pathname)
  const showBack = !isTabRoot
  const title = PAGE_TITLES[pathname] ?? null

  const handleBack = () => {
    void hapticLight()
    // Chat pages go to sessions list; others use history or fall back to dashboard.
    if (pathname.match(/^\/dashboard\/[^/]+$/)) {
      router.push('/dashboard/sessions')
    } else if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back()
    } else {
      router.push('/dashboard')
    }
  }

  return (
    <header
      className="flex items-center px-4 md:hidden flex-shrink-0 backdrop-blur-xl border-b"
      style={{
        borderColor: 'var(--line)',
        background: 'var(--glass-bg)',
        height: 'calc(44px + var(--safe-area-top))',
        paddingTop: 'var(--safe-area-top)',
      }}
    >
      {showBack ? (
        <button
          onClick={handleBack}
          className="flex items-center gap-0.5 -ml-1 py-2 pr-2 rounded-lg transition-all duration-150 cursor-pointer active:opacity-50"
          style={{ color: 'var(--color-accent)' }}
          aria-label="Back"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          <span className="text-[15px] font-normal">Back</span>
        </button>
      ) : null}

      {title && (
        <span
          className="text-[17px] font-semibold tracking-tight"
          style={{
            color: 'var(--text-bright)',
            ...(showBack ? { marginLeft: '4px' } : {}),
          }}
        >
          {title}
        </span>
      )}
    </header>
  )
}
