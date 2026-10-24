'use client'

import { useState, useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { Server, serverAction, renameServer, discoverServices, updateEnvVars, finalizeServer, installAgent, listAgentCredentials, saveAgentCredential, type AgentCredentialSummary } from '@/lib/api'
import { WorkspaceOverview } from '@/components/WorkspaceOverview'

/** Portal-based menu for mobile — renders on document.body so WKWebView touch events work.
 *  Uses onPointerUp instead of onClick because WKWebView swallows click on portal elements. */
function MobileMenu({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => { setIsMobile(window.innerWidth < 768) }, [])
  if (typeof document === 'undefined' || !isMobile) return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center" onPointerUp={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div className="relative w-64 rounded-2xl overflow-hidden animate-scale-in bg-ink border border-line shadow-[0_12px_40px_rgba(0,0,0,0.5)]"
        onPointerUp={e => e.stopPropagation()}>
        {children}
      </div>
    </div>,
    document.body
  )
}

interface Props {
  server: Server
  onStateChange: (server: Server) => void
  onDeleted: () => void
}

const STATE_LABEL: Record<string, string> = {
  running: 'Running', stopped: 'Stopped', stopping: 'Stopping',
  pending: 'Starting', launching: 'Launching', terminated: 'Terminated',
  deleting: 'Deleting',
}

// Readiness stage → short human label surfaced next to the state badge while
// FinalizeFunction is still working. Mirrors the stages emitted by
// backend/src/finalize.py → _write_readiness.
const READINESS_STAGE_LABEL: Record<string, string> = {
  'booting-ec2': 'Booting EC2…',
  'awaiting-ip': 'Getting IP…',
  'awaiting-ssh': 'Waiting for SSH…',
  'installing-agents': 'Installing agents…',
  'pushing-credentials': 'Pushing credentials…',
  'verifying-auth': 'Verifying auth…',
  'done': 'Ready',
  'error': 'Setup failed',
}
const STATE_BADGE_CLASS: Record<string, string> = {
  running: 'text-green bg-green/10',
  stopped: 'text-tertiary bg-l2',
  stopping: 'text-amber bg-amber/10',
  pending: 'text-amber bg-amber/10',
  launching: 'text-amber bg-amber/10',
  terminated: 'text-danger bg-danger/10',
  deleting: 'text-danger bg-danger/10',
}
const AGENT_META: Record<string, { name: string; logo: string }> = {
  claude: { name: 'Claude Code', logo: '/logos/claude.png' },
  codex: { name: 'Codex', logo: '/logos/openai.svg' },
  cursor: { name: 'Cursor', logo: '/logos/cursor.svg' },
  opencode: { name: 'OpenCode', logo: '/logos/opencode.png' },
}
const WEB_CHAT_AGENTS = ['claude', 'codex', 'cursor', 'opencode']

/** Metadata for the "add agent" flow — key prefixes + where to get keys. */
const AGENT_KEY_INFO: Record<string, { prefixes: string[]; placeholder: string; url: string; urlLabel: string }> = {
  claude: { prefixes: ['sk-ant-'],         placeholder: 'sk-ant-api03-…',    url: 'https://console.anthropic.com/settings/keys', urlLabel: 'console.anthropic.com' },
  codex:  { prefixes: ['sk-'],             placeholder: 'sk-…',               url: 'https://platform.openai.com/api-keys',        urlLabel: 'platform.openai.com' },
  cursor: { prefixes: ['key_', 'crsr_'],   placeholder: 'key_… or crsr_…',    url: 'https://cursor.com/dashboard/integrations',   urlLabel: 'cursor.com/dashboard' },
}

/** All agents that can be added to a workspace. */
const INSTALLABLE_AGENTS = ['claude', 'codex', 'cursor'] as const

export default function ServerCard({ server, onStateChange, onDeleted }: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showDelete, setShowDelete] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [activeTab, setActiveTab] = useState<'overview' | 'environment'>('overview')
  const [services, setServices] = useState<{ port: number; process: string; url: string }[]>(server.services ?? [])
  const [scanning, setScanning] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameLabel, setRenameLabel] = useState(server.label ?? '')
  const [envVarsOpen, setEnvVarsOpen] = useState(false)
  const [envVarRows, setEnvVarRows] = useState<{ key: string; value: string; showValue: boolean }[]>(
    Object.entries(server.envVars ?? {}).map(([k, v]) => ({ key: k, value: v, showValue: false }))
  )
  // Sync env var rows when server.envVars changes (e.g. after provisioning or polling)
  const envVarsJson = JSON.stringify(server.envVars ?? {})
  useEffect(() => {
    const parsed = JSON.parse(envVarsJson) as Record<string, string>
    if (Object.keys(parsed).length > 0) {
      setEnvVarRows(Object.entries(parsed).map(([k, v]) => ({ key: k, value: v, showValue: false })))
    }
  }, [envVarsJson])
  const [savingEnvVars, setSavingEnvVars] = useState(false)
  const [envVarsNote, setEnvVarsNote] = useState<string | null>(null)
  // ── Add agent flow state ──
  const [addAgentOpen, setAddAgentOpen] = useState(false)
  const [addAgentTarget, setAddAgentTarget] = useState<string | null>(null) // agent id being added
  const [addAgentStep, setAddAgentStep] = useState<'pick' | 'key' | 'installing'>('pick')
  const [addAgentKey, setAddAgentKey] = useState('')
  const [addAgentError, setAddAgentError] = useState<string | null>(null)
  const [connectedAgents, setConnectedAgents] = useState<Set<string>>(new Set())

  const deleteRef = useRef<HTMLDivElement>(null)
  const envVarsScrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!showDelete) return
    const handleClick = (e: MouseEvent) => {
      if (deleteRef.current && !deleteRef.current.contains(e.target as Node)) setShowDelete(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showDelete])

  async function pollUntil(serverId: string, targetState: string, maxMs = 180_000) {
    const { getServer } = await import('@/lib/api')
    const deadline = Date.now() + maxMs
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 5000))
      const updated = await getServer(serverId)
      onStateChange(updated)
      if (updated.instanceState === targetState) return
      if (updated.instanceState === 'terminated') throw new Error('Deleted')
    }
    throw new Error('Timed out')
  }

  async function handleStart() {
    setError(null); setBusy('starting')
    try { await serverAction(server.serverId, 'start'); await pollUntil(server.serverId, 'running') }
    catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  async function handleStop() {
    setError(null); setBusy('stopping')
    try {
      await serverAction(server.serverId, 'stop')
      onStateChange({ ...server, instanceState: 'stopping', publicIp: null, sshPrivateKey: null })
      await pollUntil(server.serverId, 'stopped')
    } catch (e) { const msg = (e as Error).message; setError(msg); console.error('handleStop failed:', msg) } finally { setBusy(null) }
  }
  async function handleDelete() {
    setShowDelete(false); setError(null); setBusy('deleting')
    try { await serverAction(server.serverId, 'terminate'); onDeleted() }
    catch (e) { const msg = (e as Error).message; setError(msg); console.error('handleDelete failed:', msg); setBusy(null) }
  }

  async function handleRename() {
    const trimmed = renameLabel.trim()
    if (!trimmed) return
    try {
      await renameServer(server.serverId, trimmed)
      onStateChange({ ...server, label: trimmed })
      setRenaming(false)
    } catch { /* ignore */ }
  }

  async function handleScanServices() {
    setScanning(true)
    try { const res = await discoverServices(server.serverId); setServices(res.services) }
    catch { /* ignore */ }
    finally { setScanning(false) }
  }

  function addEnvVarRow() {
    setEnvVarRows(prev => [...prev, { key: '', value: '', showValue: false }])
    setTimeout(() => { if (envVarsScrollRef.current) envVarsScrollRef.current.scrollTop = envVarsScrollRef.current.scrollHeight }, 0)
  }
  function removeEnvVarRow(i: number) { setEnvVarRows(prev => prev.filter((_, idx) => idx !== i)) }
  function updateEnvVarRow(i: number, field: 'key' | 'value', val: string) {
    setEnvVarRows(prev => prev.map((row, idx) => idx === i ? { ...row, [field]: val } : row))
  }
  function toggleEnvVarRowVisibility(i: number) {
    setEnvVarRows(prev => prev.map((row, idx) => idx === i ? { ...row, showValue: !row.showValue } : row))
  }
  async function handleSaveEnvVars() {
    setSavingEnvVars(true); setEnvVarsNote(null)
    try {
      const envVars = Object.fromEntries(
        envVarRows.filter(r => r.key.trim() && /^[A-Za-z_][A-Za-z0-9_]*$/.test(r.key.trim())).map(r => [r.key.trim(), r.value])
      )
      const res = await updateEnvVars(server.serverId, envVars)
      onStateChange({ ...server, envVars: res.envVars })
      if (res.note) setEnvVarsNote(res.note)
    } catch (e) { setEnvVarsNote((e as Error).message) }
    finally { setSavingEnvVars(false) }
  }

  // ── Add agent handlers ──

  // Fetch stored agent credentials so we know which agents already have keys.
  useEffect(() => {
    if (!expanded) return
    listAgentCredentials().then(({ credentials }) => {
      setConnectedAgents(new Set(credentials.map((c: AgentCredentialSummary) => c.agent)))
    }).catch(() => { /* silent */ })
  }, [expanded])

  // `serverAgents` is the single source of truth for which agents are installed
  // on this workspace. Computed here (instead of below) because the Add Agent
  // flow and related hooks reference it.
  const serverAgents = server.agents?.length ? server.agents : ['claude']

  /** Agents the user could add — not already on this workspace. */
  const addableAgents = INSTALLABLE_AGENTS.filter(a => !serverAgents.includes(a))

  function startAddAgent() {
    setAddAgentOpen(true)
    setAddAgentStep('pick')
    setAddAgentTarget(null)
    setAddAgentKey('')
    setAddAgentError(null)
  }

  function pickAgentToAdd(agentId: string) {
    setAddAgentTarget(agentId)
    setAddAgentError(null)
    // If user already has credentials stored for this agent, skip the key step
    if (connectedAgents.has(agentId)) {
      doInstallAgent(agentId)
    } else {
      setAddAgentStep('key')
    }
  }

  async function handleSaveKeyAndInstall() {
    if (!addAgentTarget) return
    const keyInfo = AGENT_KEY_INFO[addAgentTarget]
    const key = addAgentKey.trim()
    if (!key) { setAddAgentError('API key is required'); return }
    if (keyInfo?.prefixes?.length && !keyInfo.prefixes.some(p => key.startsWith(p))) {
      setAddAgentError(`Key should start with ${keyInfo.prefixes.join(' or ')}`)
      return
    }
    // Save the credential first
    try {
      await saveAgentCredential({
        agent: addAgentTarget as any,
        apiKey: key,
        identifier: key.length >= 10 ? `${key.slice(0, 6)}…${key.slice(-4)}` : undefined,
      })
      setConnectedAgents(prev => new Set([...prev, addAgentTarget!]))
    } catch (err) {
      setAddAgentError(err instanceof Error ? err.message : 'Failed to save key')
      return
    }
    doInstallAgent(addAgentTarget)
  }

  async function doInstallAgent(agentId: string) {
    setAddAgentStep('installing')
    setAddAgentError(null)
    try {
      const result = await installAgent(server.serverId, agentId)
      // Update the local server state with the new agents list
      const updatedAgents = result.agents ?? [...serverAgents, agentId]
      onStateChange({ ...server, agents: updatedAgents })
      // Reset the add-agent flow
      setAddAgentOpen(false)
      setAddAgentTarget(null)
      setAddAgentKey('')
      setAddAgentStep('pick')
    } catch (err) {
      setAddAgentError(err instanceof Error ? err.message : 'Installation failed')
      setAddAgentStep('pick')
    }
  }

  const displayState = busy === 'deleting' ? 'deleting' : busy === 'stopping' ? 'stopping' : busy === 'starting' ? 'pending' : server.instanceState
  const isRunning = server.instanceState === 'running'
  const isStopped = server.instanceState === 'stopped'
  const isTransitioning = ['pending', 'launching', 'stopping'].includes(server.instanceState) || busy !== null
  const badgeClass = STATE_BADGE_CLASS[displayState] ?? 'text-tertiary bg-l2'
  const canOpenWebChat = serverAgents.some(agent => WEB_CHAT_AGENTS.includes(agent))

  // Readiness gate: a workspace is "open-able" only after FinalizeFunction
  // writes status=='ready'. Legacy servers predating this have no readiness
  // object — treat them as ready for backwards compatibility.
  const readiness = server.readiness
  const isReady = !readiness || readiness.status === 'ready'
  const isPrepFailed = readiness?.status === 'failed'
  const isPreparing = isRunning && !!readiness && !isReady && !isPrepFailed
  const canOpen = isRunning && canOpenWebChat && isReady && !isPrepFailed
  const prepStageLabel =
    (readiness?.stage && READINESS_STAGE_LABEL[readiness.stage]) || 'Preparing…'

  // While readiness is in-flight, poll GET /servers/{id} every 4s so the
  // stage label + per-agent check marks stay live without the user refreshing.
  useEffect(() => {
    if (!isPreparing) return
    let cancelled = false
    const tick = async () => {
      try {
        const { getServer } = await import('@/lib/api')
        const updated = await getServer(server.serverId)
        if (!cancelled) onStateChange(updated)
      } catch {
        /* swallow — we'll retry on next tick */
      }
    }
    const id = setInterval(tick, 4000)
    return () => { cancelled = true; clearInterval(id) }
  }, [isPreparing, server.serverId, onStateChange])

  async function handleRetryFinalize() {
    try {
      const { readiness: r } = await finalizeServer(server.serverId)
      onStateChange({ ...server, readiness: r })
    } catch (e) { setError((e as Error).message) }
  }

  return (
    <div className={`relative rounded-xl bg-ink border border-line animate-fade-in hover-lift ${showDelete ? 'z-30' : ''}`}>
      {/* ── Header row ── */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => {
          if (showDelete) return // Don't act while dropdown is open
          // Mobile: tap whole card to open chat (running + ready) or start (stopped).
          // If running-but-still-preparing, expand instead so the stage is visible.
          if (window.innerWidth < 768) {
            if (canOpen) { router.push(`/dashboard/${server.serverId}`); return }
            if (isStopped && !busy) { handleStart(); return }
          }
          setExpanded(v => !v)
        }}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(v => !v) } }}
        className="w-full flex items-center gap-3.5 px-5 py-4 text-left cursor-pointer active:opacity-60 md:active:opacity-100"
      >
        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {renaming ? (
              <form onSubmit={e => { e.preventDefault(); handleRename() }} className="flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
                <input autoFocus value={renameLabel} onChange={e => setRenameLabel(e.target.value)}
                  onBlur={handleRename}
                  onKeyDown={e => { if (e.key === 'Escape') { setRenaming(false); setRenameLabel(server.label ?? '') } }}
                  className="text-[14px] font-semibold text-bright tracking-tight bg-transparent border-b border-accent outline-none w-40" />
              </form>
            ) : (
              <span className="text-[14px] font-semibold text-bright tracking-tight">
                {server.label || (server.envType === 'byos' ? 'Server' : 'Workspace')}
              </span>
            )}
            <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full border border-line text-tertiary">
              {server.ownerType === 'team' ? 'Team' : 'Personal'}
            </span>
            <span className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full ${badgeClass}`}>
              {isTransitioning && <span className="inline-block w-2 h-2 border border-current border-t-transparent rounded-full animate-spin mr-1 align-middle" />}
              {STATE_LABEL[displayState] ?? displayState}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-1">
            {serverAgents.map(id => {
              const meta = AGENT_META[id]
              if (!meta) return null
              const agentReady = readiness?.agents?.[id]
              // Icon decoration next to agent name: green check = authenticated,
              // amber dot = mid-install, red X = finalize failed for this agent.
              let marker: ReactNode = null
              if (readiness && readiness.status !== 'ready') {
                if (agentReady?.authenticated === true) {
                  marker = <span className="text-green text-[10px]" aria-label="Ready">✓</span>
                } else if (isPrepFailed || agentReady?.error) {
                  marker = <span className="text-danger text-[10px]" aria-label="Failed" title={agentReady?.error ?? ''}>✕</span>
                } else {
                  marker = <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber animate-pulse" aria-label="Preparing" />
                }
              }
              return (
                <div key={id} className="flex items-center gap-1.5">
                  <img src={meta.logo} alt={meta.name} className="w-3.5 h-3.5 object-contain opacity-50" />
                  <span className="text-[11px] text-tertiary">{meta.name}</span>
                  {marker}
                </div>
              )
            })}
          </div>
        </div>

        {/* Mobile: chevron + more menu */}
        <div className="flex md:hidden items-center gap-1" onClick={e => e.stopPropagation()}>
          {!busy && server.instanceState !== 'terminated' && (
            <div className="relative" ref={deleteRef}>
              <button onClick={() => setShowDelete(v => !v)}
                className="text-tertiary p-2.5 -mr-2 cursor-pointer active:opacity-60"
                aria-label="More actions">
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
                </svg>
              </button>
              {showDelete && (
                <MobileMenu onClose={() => setShowDelete(false)}>
                  {canOpen && (
                    <button onPointerUp={() => { setShowDelete(false); router.push(`/dashboard/${server.serverId}`) }}
                      className="w-full text-left px-4 py-3 text-[13px] text-bright active:bg-[var(--hover-bg)] transition-colors cursor-pointer">
                      Open
                    </button>
                  )}
                  {isPreparing && (
                    <div className="w-full text-left px-4 py-3 text-[13px] text-tertiary border-b border-line">
                      {prepStageLabel}
                    </div>
                  )}
                  {isPrepFailed && (
                    <button onPointerUp={() => { setShowDelete(false); handleRetryFinalize() }}
                      className="w-full text-left px-4 py-3 text-[13px] text-amber active:bg-amber/10 transition-colors cursor-pointer border-b border-line">
                      Retry setup
                    </button>
                  )}
                  {isRunning && (
                    <button onPointerUp={() => { setShowDelete(false); handleStop() }}
                      className="w-full text-left px-4 py-3 text-[13px] text-secondary active:bg-[var(--hover-bg)] transition-colors cursor-pointer border-t border-line">
                      Stop
                    </button>
                  )}
                  {isStopped && (
                    <button onPointerUp={() => { setShowDelete(false); handleStart() }}
                      className="w-full text-left px-4 py-3 text-[13px] text-accent active:bg-[var(--hover-bg)] transition-colors cursor-pointer">
                      Start
                    </button>
                  )}
                  <button onPointerUp={() => { setShowDelete(false); setRenaming(true) }}
                    className="w-full text-left px-4 py-3 text-[13px] text-secondary active:bg-[var(--hover-bg)] transition-colors cursor-pointer border-t border-line">
                    Rename
                  </button>
                  <button onPointerUp={() => { setShowDelete(false); handleDelete() }}
                    className="w-full text-left px-4 py-3 text-[13px] text-danger active:bg-danger/10 transition-colors cursor-pointer border-t border-line">
                    Delete
                  </button>
                  <button onPointerUp={() => setShowDelete(false)}
                    className="w-full text-left px-4 py-3 text-[13px] text-tertiary active:bg-[var(--hover-bg)] transition-colors cursor-pointer border-t border-line">
                    Cancel
                  </button>
                </MobileMenu>
              )}
            </div>
          )}
          {!isTransitioning && (
            <svg className="w-4 h-4 text-tertiary flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18l6-6-6-6" />
            </svg>
          )}
        </div>

        {/* Desktop: primary action + expand + more-menu */}
        <div className="hidden md:flex items-center gap-2" onClick={e => e.stopPropagation()}>
          {!isTransitioning && isStopped && (
            <button onClick={handleStart} className="btn btn-primary btn-sm cursor-pointer">
              Start
            </button>
          )}
          {!isTransitioning && canOpen && (
            <button onClick={() => router.push(`/dashboard/${server.serverId}`)}
              className="btn btn-primary btn-sm cursor-pointer">
              Open
            </button>
          )}
          {isPreparing && (
            <div className="flex items-center gap-1.5 text-[11px] text-tertiary px-2 py-1"
              title={readiness?.error ?? 'Finalizing workspace'}>
              <span className="inline-block w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
              {prepStageLabel}
            </div>
          )}
          {isPrepFailed && (
            <button onClick={handleRetryFinalize}
              className="btn btn-secondary btn-sm cursor-pointer text-amber"
              title={readiness?.error ?? 'Setup failed'}>
              Retry setup
            </button>
          )}
          <button
            onClick={() => setExpanded(v => !v)}
            className="p-1.5 rounded-md text-tertiary hover:text-secondary hover:bg-[var(--hover-bg)] transition-colors cursor-pointer"
            aria-label={expanded ? 'Collapse details' : 'Expand details'}
          >
            <svg className={`w-3.5 h-3.5 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
            </svg>
          </button>
          {!busy && server.instanceState !== 'terminated' && (
            <div className="relative" ref={deleteRef}>
              <button onClick={() => setShowDelete(v => !v)}
                className="p-1.5 -mr-1 rounded-md text-tertiary hover:text-secondary hover:bg-[var(--hover-bg)] transition-colors cursor-pointer"
                aria-label="More actions">
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" />
                </svg>
              </button>
              {showDelete && (
                <div className="absolute right-0 top-9 rounded-xl overflow-hidden z-20 w-44 animate-scale-in bg-ink border border-line shadow-[0_12px_40px_rgba(0,0,0,0.25)]">
                  {isRunning && (
                    <button onClick={() => { setShowDelete(false); handleStop() }}
                      className="w-full text-left px-3.5 py-2.5 text-[13px] text-secondary hover:bg-[var(--hover-bg)] transition-colors cursor-pointer">
                      Stop
                    </button>
                  )}
                  <button onClick={() => { setShowDelete(false); setRenaming(true) }}
                    className={`w-full text-left px-3.5 py-2.5 text-[13px] text-secondary hover:bg-[var(--hover-bg)] transition-colors cursor-pointer ${isRunning ? 'border-t border-line' : ''}`}>
                    Rename
                  </button>
                  <button onClick={handleDelete}
                    className="w-full text-left px-3.5 py-2.5 text-[13px] text-danger hover:bg-danger/10 transition-colors cursor-pointer border-t border-line">
                    Delete
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Expanded panel with tabs ── */}
      {expanded && (
        <div className="border-t border-line animate-fade-in">
          {/* Tab bar */}
          <div className="flex items-center gap-0 px-5 border-b border-line">
            {(['overview', 'environment'] as const).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)}
                className={`px-3 py-2.5 text-[11px] font-medium uppercase tracking-wider transition-colors cursor-pointer border-b-2 -mb-px ${
                  activeTab === tab
                    ? 'text-bright border-accent'
                    : 'text-tertiary border-transparent hover:text-secondary'
                }`}>
                {tab}
              </button>
            ))}
          </div>

          {activeTab === 'overview' ? (
            <div>
              {/* About this workspace — Architecture / Infrastructure / Docs
                  tabs. Sits above the runtime sections (Agents, Previews)
                  because the customer-facing "what is this and what's in
                  it" matters before the operational state. */}
              <WorkspaceOverview server={server} liveServices={services} />
              <div className="px-5 py-4 space-y-4">
              {/* Agents section */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[10px] font-medium text-tertiary uppercase tracking-wider">Agents</p>
                  {isRunning && addableAgents.length > 0 && !addAgentOpen && (
                    <button onClick={startAddAgent}
                      className="flex items-center gap-1 text-[10px] text-accent hover:text-accent/80 font-medium transition-colors cursor-pointer press-scale">
                      <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                      </svg>
                      Add agent
                    </button>
                  )}
                </div>
                <div className="space-y-1.5">
                  {serverAgents.map(id => {
                    const meta = AGENT_META[id]
                    return (
                      <div key={id} className="flex items-center justify-between py-1.5 px-3 rounded-lg bg-l1">
                        <div className="flex items-center gap-2.5">
                          {meta && <img src={meta.logo} alt="" className="w-4 h-4 object-contain" />}
                          <span className="text-[12px] font-medium text-bright">{meta?.name ?? id}</span>
                        </div>
                        <span className="text-[10px] font-semibold text-green uppercase tracking-wider">active</span>
                      </div>
                    )
                  })}

                  {/* ── Add agent inline flow ── */}
                  {addAgentOpen && (
                    <div className="animate-fade-in">
                      {addAgentStep === 'pick' && (
                        <div className="mt-1">
                          <p className="text-[11px] text-tertiary mb-2">Choose an agent to add:</p>
                          <div className="space-y-1.5">
                            {addableAgents.map(id => {
                              const meta = AGENT_META[id]
                              if (!meta) return null
                              const hasCred = connectedAgents.has(id)
                              return (
                                <button key={id} onClick={() => pickAgentToAdd(id)}
                                  className="w-full flex items-center justify-between py-2 px-3 rounded-lg border border-line hover:border-accent/30 hover:bg-l1 transition-colors cursor-pointer">
                                  <div className="flex items-center gap-2.5">
                                    <img src={meta.logo} alt="" className="w-4 h-4 object-contain" />
                                    <span className="text-[12px] font-medium text-bright">{meta.name}</span>
                                  </div>
                                  {hasCred && (
                                    <span className="text-[10px] text-tertiary">Key saved</span>
                                  )}
                                </button>
                              )
                            })}
                          </div>
                          <div className="flex justify-end mt-2">
                            <button onClick={() => setAddAgentOpen(false)}
                              className="text-[11px] text-tertiary hover:text-secondary cursor-pointer">
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}

                      {addAgentStep === 'key' && addAgentTarget && (
                        <div className="mt-1">
                          <div className="flex items-center gap-2 mb-2">
                            {AGENT_META[addAgentTarget] && (
                              <img src={AGENT_META[addAgentTarget].logo} alt="" className="w-3.5 h-3.5 object-contain" />
                            )}
                            <p className="text-[11px] text-secondary font-medium">
                              Enter your {AGENT_META[addAgentTarget]?.name ?? addAgentTarget} API key
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <input
                              type="password"
                              autoFocus
                              value={addAgentKey}
                              onChange={e => setAddAgentKey(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') void handleSaveKeyAndInstall() }}
                              placeholder={AGENT_KEY_INFO[addAgentTarget]?.placeholder ?? 'Paste API key'}
                              className="flex-1 bg-ink border border-line rounded-lg px-3 py-2 text-[12px] text-bright font-mono placeholder:text-tertiary outline-none focus:border-accent/40 transition-colors"
                              spellCheck={false}
                              autoComplete="off"
                            />
                            <button onClick={handleSaveKeyAndInstall}
                              disabled={!addAgentKey.trim()}
                              className="h-8 px-3 rounded-lg text-[11.5px] font-semibold text-ink bg-accent hover:bg-accent/90 transition-colors cursor-pointer disabled:opacity-30">
                              Install
                            </button>
                          </div>
                          {AGENT_KEY_INFO[addAgentTarget] && (
                            <p className="text-[10px] text-tertiary mt-1.5">
                              Get one at{' '}
                              <a href={AGENT_KEY_INFO[addAgentTarget].url} target="_blank" rel="noopener noreferrer"
                                className="text-accent hover:underline">
                                {AGENT_KEY_INFO[addAgentTarget].urlLabel}
                              </a>
                            </p>
                          )}
                          <div className="flex justify-end mt-2">
                            <button onClick={() => { setAddAgentStep('pick'); setAddAgentKey(''); setAddAgentError(null) }}
                              className="text-[11px] text-tertiary hover:text-secondary cursor-pointer">
                              Back
                            </button>
                          </div>
                        </div>
                      )}

                      {addAgentStep === 'installing' && (
                        <div className="flex items-center gap-2 py-3 px-3 rounded-lg bg-l1 mt-1">
                          <span className="w-3.5 h-3.5 border-2 border-accent/20 border-t-accent rounded-full animate-spin" />
                          <span className="text-[12px] text-secondary">
                            Installing {AGENT_META[addAgentTarget!]?.name ?? addAgentTarget}…
                          </span>
                        </div>
                      )}

                      {addAgentError && (
                        <p className="text-[11px] text-danger mt-1.5 animate-fade-in">{addAgentError}</p>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Integrations section */}
              <div>
                <p className="text-[10px] font-medium text-tertiary uppercase tracking-wider mb-2">Integrations</p>
                <div className="space-y-1.5">
                  {server.hasVercel && (
                    <div className="flex items-center justify-between py-1.5 px-3 rounded-lg bg-l1">
                      <div className="flex items-center gap-2.5">
                        <svg className="w-3.5 h-3.5 text-bright" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1L24 22H0L12 1z" /></svg>
                        <span className="text-[12px] font-medium text-bright">Vercel</span>
                      </div>
                      <svg className="w-3.5 h-3.5 text-green" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
                    </div>
                  )}
                  {server.hasSupabase && (
                    <div className="flex items-center justify-between py-1.5 px-3 rounded-lg bg-l1">
                      <div className="flex items-center gap-2.5">
                        <svg className="w-3.5 h-3.5 text-bright" viewBox="0 0 109 113" fill="currentColor">
                          <path d="M63.7 110.3c-2.6 3.3-8 1.5-8.1-2.8l-.5-55.4h37.2c6.7 0 10.4 7.7 6.2 12.9L63.7 110.3z" opacity=".6" />
                          <path d="M45.3 2.7c2.6-3.3 8-1.5 8.1 2.8l.2 55.4H16.6c-6.7 0-10.4-7.7-6.2-12.9L45.3 2.7z" />
                        </svg>
                        <span className="text-[12px] font-medium text-bright">Supabase</span>
                      </div>
                      <svg className="w-3.5 h-3.5 text-green" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
                    </div>
                  )}
                  {!server.hasVercel && !server.hasSupabase && (
                    <p className="text-[11px] text-tertiary px-3">No integrations connected</p>
                  )}
                </div>
              </div>

              {/* Previews */}
              {isRunning && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] font-medium text-tertiary uppercase tracking-wider">Previews</p>
                    <button onClick={handleScanServices} disabled={scanning}
                      className="text-[10px] text-accent hover:text-accent/80 transition-colors cursor-pointer font-medium press-scale disabled:opacity-50">
                      {scanning ? (
                        <span className="flex items-center gap-1">
                          <span className="w-2.5 h-2.5 border-[1.5px] border-accent/20 border-t-accent rounded-full animate-spin" />
                          Scanning
                        </span>
                      ) : 'Scan'}
                    </button>
                  </div>
                  {services.length > 0 ? (
                    <div className="space-y-1.5">
                      {services.map(svc => (
                        <a key={svc.port} href={svc.url} target="_blank" rel="noopener noreferrer"
                          className="flex items-center gap-2.5 group rounded-lg border border-line hover:border-accent/30 px-3 py-2 transition-colors">
                          <span className="text-[12px] font-mono font-semibold text-accent bg-accent/10 rounded px-1.5 py-0.5 flex-shrink-0">
                            {svc.port}
                          </span>
                          <span className="text-[11px] text-secondary font-mono truncate min-w-0 flex-1">{svc.url}</span>
                          <svg className="w-3.5 h-3.5 text-tertiary group-hover:text-accent transition-colors flex-shrink-0"
                            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                          </svg>
                        </a>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[11px] text-tertiary">{scanning ? '' : 'No services detected'}</p>
                  )}
                  {server.envType === 'byos' && services.length > 0 && (
                    <p className="text-[10px] text-tertiary mt-1.5 italic">Ensure ports are open on your server&apos;s firewall</p>
                  )}
                </div>
              )}

              {/* Meta */}
              <div className="flex items-center gap-4 pt-2 border-t border-line">
                <span className="text-[10px] text-tertiary">Auto-stop: {server.autoStopMinutes ?? 30}m</span>
                {server.region && <span className="text-[10px] text-tertiary">{server.region}</span>}
              </div>
              </div>
            </div>
          ) : (
            /* Environment tab — env vars */
            <div className="px-5 py-4">
              <div>
                {envVarRows.length > 0 && (
                  <div ref={envVarsScrollRef} className="max-h-44 overflow-y-auto flex flex-col gap-1.5 mb-3 pr-0.5" style={{ scrollbarWidth: 'thin' }}>
                    {envVarRows.map((row, i) => (
                      <div key={i} className="flex items-center gap-2 py-1 px-3 rounded-lg bg-l1">
                        <input type="text" value={row.key}
                          onChange={e => updateEnvVarRow(i, 'key', e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
                          placeholder="KEY" spellCheck={false}
                          className="w-28 flex-shrink-0 bg-transparent text-[11px] text-bright font-mono placeholder:text-tertiary outline-none" />
                        <span className="text-tertiary text-[11px]">=</span>
                        <div className="flex-1 flex items-center gap-1">
                          <input type={row.showValue ? 'text' : 'password'} value={row.value}
                            onChange={e => updateEnvVarRow(i, 'value', e.target.value)}
                            placeholder="value" autoComplete="off" spellCheck={false}
                            className="flex-1 bg-transparent text-[11px] text-bright font-mono placeholder:text-tertiary outline-none" />
                          <button type="button" onClick={() => toggleEnvVarRowVisibility(i)}
                            className="text-tertiary hover:text-secondary transition-colors cursor-pointer p-0.5" tabIndex={-1}>
                            {row.showValue ? (
                              <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" /></svg>
                            ) : (
                              <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                            )}
                          </button>
                        </div>
                        <button type="button" onClick={() => removeEnvVarRow(i)}
                          className="text-tertiary hover:text-danger transition-colors cursor-pointer p-0.5 press-scale flex-shrink-0" tabIndex={-1}>
                          <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <button type="button" onClick={addEnvVarRow}
                    className="flex items-center gap-1.5 text-[11px] text-tertiary hover:text-secondary transition-colors cursor-pointer">
                    <span className="w-4 h-4 rounded-full border border-line flex items-center justify-center">
                      <svg className="w-2 h-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
                    </span>
                    Add variable
                  </button>
                  <button onClick={handleSaveEnvVars} disabled={savingEnvVars}
                    className="flex items-center gap-1 text-[11px] text-accent hover:text-accent/80 font-medium transition-colors cursor-pointer press-scale disabled:opacity-50">
                    {savingEnvVars ? (
                      <><span className="w-2.5 h-2.5 border-[1.5px] border-accent/20 border-t-accent rounded-full animate-spin" />Saving</>
                    ) : 'Save'}
                  </button>
                </div>
                {envVarsNote && <p className="text-[10px] text-amber mt-2 animate-fade-in">{envVarsNote}</p>}
                {envVarRows.length === 0 && (
                  <p className="text-[11px] text-tertiary mt-2">No environment variables configured</p>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {error && <p className="text-[11px] text-danger px-5 pb-3 animate-fade-in">{error}</p>}
    </div>
  )
}
