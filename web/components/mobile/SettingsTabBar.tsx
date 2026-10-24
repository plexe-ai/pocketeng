'use client'

import { usePathname, useRouter } from 'next/navigation'
import { hapticLight } from '@/lib/native'

const TABS = [
  { href: '/dashboard/settings', label: 'Account' },
  { href: '/dashboard/agents', label: 'Agents' },
  { href: '/dashboard/harness', label: 'Harness' },
  { href: '/dashboard/integrations', label: 'Integrations' },
]

const SETTINGS_PATHS = new Set(TABS.map(t => t.href))

export function isSettingsPath(pathname: string) {
  return SETTINGS_PATHS.has(pathname)
}

export default function SettingsTabBar() {
  const pathname = usePathname()
  const router = useRouter()

  if (!isSettingsPath(pathname)) return null

  return (
    <div
      className="md:hidden flex items-center gap-1 px-4 py-2 overflow-x-auto border-b"
      style={{ borderColor: 'var(--line)', background: 'var(--glass-bg)' }}
    >
      {TABS.map(tab => {
        const active = pathname === tab.href
        return (
          <button
            key={tab.href}
            onClick={() => {
              if (active) return
              void hapticLight()
              router.replace(tab.href)
            }}
            className={`flex-shrink-0 px-3.5 py-1.5 rounded-full text-[13px] font-medium transition-colors cursor-pointer ${
              active
                ? 'bg-accent/12 text-accent'
                : 'text-tertiary active:opacity-60'
            }`}
            aria-current={active ? 'page' : undefined}
          >
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}
