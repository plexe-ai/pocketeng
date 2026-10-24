'use client'

import { usePathname, useRouter } from 'next/navigation'
import { hapticLight } from '@/lib/native'

function WorkspacesIcon({ active }: { active: boolean }) {
  if (active) return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
      <rect x="3" y="3" width="8" height="8" rx="2" />
      <rect x="13" y="3" width="8" height="8" rx="2" />
      <rect x="3" y="13" width="8" height="8" rx="2" />
      <rect x="13" y="13" width="8" height="8" rx="2" />
    </svg>
  )
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="3" y="3" width="8" height="8" rx="2" />
      <rect x="13" y="3" width="8" height="8" rx="2" />
      <rect x="3" y="13" width="8" height="8" rx="2" />
      <rect x="13" y="13" width="8" height="8" rx="2" />
    </svg>
  )
}

function SessionsIcon({ active }: { active: boolean }) {
  if (active) return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 3C6.5 3 2 6.58 2 11c0 2.13 1.02 4.07 2.7 5.5L3.5 21l4.6-2.15C9.3 19.26 10.62 19.5 12 19.5c5.5 0 10-3.58 10-8S17.5 3 12 3z" />
    </svg>
  )
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3C6.5 3 2 6.58 2 11c0 2.13 1.02 4.07 2.7 5.5L3.5 21l4.6-2.15C9.3 19.26 10.62 19.5 12 19.5c5.5 0 10-3.58 10-8S17.5 3 12 3z" />
    </svg>
  )
}

function SettingsIcon({ active }: { active: boolean }) {
  if (active) return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

const isSessionPage = (p: string) =>
  /^\/dashboard\/[^/]+/.test(p) &&
  !p.includes('/settings') &&
  !p.includes('/agents') &&
  !p.includes('/skills') &&
  !p.includes('/harness') &&
  !p.includes('/integrations')

const isSettingsPage = (p: string) =>
  p === '/dashboard/settings' ||
  p === '/dashboard/agents' ||
  p === '/dashboard/skills' ||
  p === '/dashboard/harness' ||
  p === '/dashboard/integrations'

export default function BottomTabs() {
  const pathname = usePathname()
  const router = useRouter()

  const tabs = [
    {
      id: 'workspaces',
      label: 'Workspaces',
      Icon: WorkspacesIcon,
      href: '/dashboard?manage',
      active: pathname === '/dashboard',
    },
    {
      id: 'sessions',
      label: 'Sessions',
      Icon: SessionsIcon,
      href: '/dashboard/sessions',
      active: pathname === '/dashboard/sessions' || isSessionPage(pathname),
    },
    {
      id: 'settings',
      label: 'Settings',
      Icon: SettingsIcon,
      href: '/dashboard/settings',
      active: isSettingsPage(pathname),
    },
  ]

  return (
    <nav
      className="flex items-stretch md:hidden backdrop-blur-2xl border-t"
      style={{
        borderColor: 'var(--line)',
        background: 'var(--glass-bg)',
        paddingBottom: 'var(--safe-area-bottom)',
      }}
    >
      {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => {
              if (tab.active) return
              void hapticLight()
              router.push(tab.href)
            }}
            className="flex flex-1 flex-col items-center justify-center gap-[3px] py-[7px] min-h-[49px] transition-colors duration-200 cursor-pointer active:opacity-60"
            style={{
              color: tab.active ? 'var(--color-accent)' : 'var(--text-tertiary)',
            }}
            aria-current={tab.active ? 'page' : undefined}
          >
            <tab.Icon active={tab.active} />
            <span className="text-[10px] font-medium">{tab.label}</span>
          </button>
        ))}
    </nav>
  )
}
