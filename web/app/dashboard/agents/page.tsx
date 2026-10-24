'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getRestoredSession, supabase } from '@/lib/supabase'
import { AgentConnectionList } from '@/components/AgentConnectionCard'

/**
 * Coding-agent connections. One card per supported agent; the card handles
 * its own detection, sign-in, paste-key, and disconnect states.
 *
 * Also lets the user pick a default agent — unchanged from before but now
 * lives alongside the connection UI instead of inside each row.
 */
const AGENTS = [
  { id: 'claude',   label: 'Claude Code' },
  { id: 'codex',    label: 'Codex' },
  { id: 'cursor',   label: 'Cursor' },
  { id: 'opencode', label: 'OpenCode' },
] as const

export default function AgentsPage() {
  const router = useRouter()
  const [defaultAgent, setDefaultAgent] = useState('claude')

  useEffect(() => {
    let cancelled = false

    void (async () => {
      const session = await getRestoredSession()
      if (cancelled) return
      if (!session) { router.replace('/'); return }
      setDefaultAgent(session.user.user_metadata?.defaultAgent ?? 'claude')
    })()

    return () => {
      cancelled = true
    }
  }, [router])

  async function handleSetDefault(id: string) {
    setDefaultAgent(id)
    await supabase.auth.updateUser({ data: { defaultAgent: id } })
  }

  return (
    <div className="px-5 py-4 md:px-8 md:py-8 max-w-2xl animate-fade-in">
      <div className="mb-6 md:mb-8">
        <h1 className="hidden md:block text-[16px] font-semibold text-bright tracking-tight">Coding Agents</h1>
        <p className="text-[12px] text-tertiary md:mt-1">
          Connect the agents you use. We copy your local sign-in to the cloud so your agents run as you — same subscription, same identity.
        </p>
      </div>

      <AgentConnectionList />

      <div className="mt-8">
        <h2 className="text-[13px] font-semibold text-bright mb-2">Default agent</h2>
        <p className="text-[11.5px] text-tertiary mb-3">
          The agent pre-selected when you start a new task.
        </p>
        <div className="inline-flex items-center gap-1 p-[3px] rounded-lg bg-l1 border border-line">
          {AGENTS.map(a => (
            <button
              key={a.id}
              onClick={() => handleSetDefault(a.id)}
              className={`px-3 py-1.5 rounded-md text-[12px] font-medium transition-all duration-150 cursor-pointer ${
                defaultAgent === a.id
                  ? 'bg-ink text-bright shadow-sm'
                  : 'text-tertiary hover:text-secondary'
              }`}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
