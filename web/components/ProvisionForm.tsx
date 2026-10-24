'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { provisionServer, getServer, Server, listAgentCredentials, getMyTeam, type AgentCredentialId } from '@/lib/api'
import {
  createHarnessSkillCatalog,
  HARNESS_CATEGORY_BADGE_LABELS,
  HARNESS_CATEGORY_SECTION_LABELS,
  type HarnessCustomSkill,
  type HarnessSkillCatalogItem,
} from '@/lib/harnessSkills'
import { getRestoredSession, supabase } from '@/lib/supabase'

interface Props {
  onProvisioned: (server: Server) => void
}

interface Repo {
  full_name: string
  name: string
  private: boolean
  description: string | null
}

/* ── .env file parser ── */

function parseEnvFile(text: string): { key: string; value: string }[] {
  const results: { key: string; value: string }[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx < 1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = trimmed.slice(eqIdx + 1).trim()
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    results.push({ key, value })
  }
  return results
}


/* ── Environment types ──
 *
 * v1 ships with a single envType. The "iOS Development" option (mac2.metal
 * Dedicated Hosts) was dropped — too expensive (24hr host minimums), too
 * slow to provision, and orthogonal to the cloud-coding-agent core. Linux
 * EC2 covers everything Claude/Codex/Cursor/OpenCode need to do.
 *
 * Kept as an array for future expansion (BYO regions, GPU instances, etc.)
 * even though there's only one entry today. */

const ENV_TYPES = [
  {
    id: 'general' as const,
    name: 'General',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7m0 0a3 3 0 01-3 3m0 3h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008zm-3 6h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008z" />
      </svg>
    ),
  },
] as const

/* ── Agent definitions ── */

const AGENTS = [
  { id: 'claude',   name: 'Claude Code', by: 'Anthropic',    color: '#D97757', logo: '/logos/claude.png', comingSoon: false },
  { id: 'codex',    name: 'Codex',       by: 'OpenAI',       color: '#FFFFFF', logo: '/logos/openai.svg', comingSoon: false },
  { id: 'cursor',   name: 'Cursor',      by: 'Anysphere',    color: '#00A3FF', logo: '/logos/cursor.svg', comingSoon: false },
  { id: 'opencode', name: 'OpenCode',    by: 'OpenCode',     color: '#22C55E', logo: '/logos/opencode.png', comingSoon: false },
] as const

function HarnessSkillPreviewDialog({
  skill,
  selected,
  onClose,
  onToggleSelected,
}: {
  skill: HarnessSkillCatalogItem | null
  selected: boolean
  onClose: () => void
  onToggleSelected: () => void
}) {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!skill) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKeyDown)

    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [skill, onClose])

  if (!mounted || !skill || typeof document === 'undefined') return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end md:items-center md:justify-center" onPointerUp={onClose}>
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" />
      <div
        className="relative w-full max-h-[86vh] overflow-hidden rounded-t-[24px] border border-line bg-ink shadow-[0_24px_80px_rgba(0,0,0,0.55)] md:max-h-[78vh] md:max-w-xl md:rounded-2xl"
        onPointerUp={event => event.stopPropagation()}
      >
        <div className="border-b border-line px-4 py-4 md:px-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-[16px] font-semibold text-bright">{skill.name}</p>
                <span className="rounded-full border border-line bg-l1 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-tertiary">
                  {HARNESS_CATEGORY_BADGE_LABELS[skill.category]}
                </span>
                {skill.hasOverride && (
                  <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent">
                    Customized
                  </span>
                )}
              </div>
              <p className="mt-2 text-[12px] leading-relaxed text-secondary">{skill.description}</p>
            </div>
            <button
              type="button"
              onPointerUp={onClose}
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-tertiary transition-colors hover:bg-l1 hover:text-secondary cursor-pointer"
              aria-label="Close preview"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="overflow-y-auto px-4 py-4 md:px-5 md:py-5">
          <div className="rounded-xl border border-accent/15 bg-accent/5 px-3.5 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-accent/80">What this adds</p>
            <p className="mt-1.5 text-[12px] leading-relaxed text-secondary">
              This instruction pack changes how the agent plans, writes, and reviews work in this workspace. It guides behavior only and does not connect tools or install credentials.
            </p>
          </div>

          <div className="mt-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-tertiary">Instructions preview</p>
            <pre className="mt-2 max-h-[44vh] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-l1/60 p-3 text-[11.5px] leading-relaxed text-secondary">
              {skill.content}
            </pre>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3 md:px-5">
          <p className="text-[11px] text-tertiary">
            {selected ? 'Included in this workspace' : 'Not included in this workspace yet'}
          </p>
          <button
            type="button"
            onPointerUp={onToggleSelected}
            className={selected ? 'btn btn-ghost cursor-pointer text-[12px]' : 'btn btn-primary cursor-pointer'}
          >
            {selected ? 'Remove pack' : 'Use this pack'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/* ── Component ── */

export default function ProvisionForm({ onProvisioned }: Props) {
  const [busy, setBusy]         = useState(false)
  const [stepIdx, setStepIdx]   = useState(0)
  const [error, setError]       = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)

  // Single envType shipped in v1 — see ENV_TYPES comment above. Kept as a
  // state value (not a constant) so the UI scaffolding can grow without
  // ripping out the form when we add another env later.
  const [workspaceName, setWorkspaceName] = useState('')
  const [ownerType, setOwnerType]         = useState<'team' | 'personal'>('personal')
  const [teamId, setTeamId]               = useState<string | null>(null)
  const [teamName, setTeamName]           = useState<string | null>(null)
  const [envType, setEnvType]             = useState<'general'>('general')
  const [agents, setAgents]               = useState<string[]>(['claude'])
  const [repos, setRepos]                 = useState<Repo[]>([])
  const [selectedRepos, setSelectedRepos] = useState<string[]>([])
  const [repoSearch, setRepoSearch]       = useState('')
  const [loadingRepos, setLoadingRepos]   = useState(false)
  const [ghConnected, setGhConnected]     = useState(false)

  const [selectedSkills, setSelectedSkills] = useState<string[]>([])
  const [customSkills, setCustomSkills] = useState<HarnessCustomSkill[]>([])
  const [skillOverrides, setSkillOverrides] = useState<Record<string, string>>({})
  const [previewSkillId, setPreviewSkillId] = useState<string | null>(null)

  const [vercelEnabled, setVercelEnabled]       = useState(false)
  const [vercelToken, setVercelToken]           = useState('')
  const [supabaseEnabled, setSupabaseEnabled]   = useState(false)
  const [supabaseUrl, setSupabaseUrl]           = useState('')
  const [supabaseServiceKey, setSupabaseServiceKey] = useState('')
  const [envVars, setEnvVars] = useState<{ key: string; value: string; showValue: boolean }[]>([])
  const [envPasteMode, setEnvPasteMode] = useState(false)
  const [envPasteText, setEnvPasteText] = useState('')
  const [setupFiles, setSetupFiles] = useState<{ name: string; content: string }[]>([])
  const [showAddFile, setShowAddFile] = useState(false)
  const [newFileName, setNewFileName] = useState('')
  const [newFileContent, setNewFileContent] = useState('')
  const [setupInstructions, setSetupInstructions] = useState('')
  const envVarsScrollRef = useRef<HTMLDivElement>(null)

  const [apiKey, setApiKey]           = useState('')
  const [hasStoredKey, setHasStoredKey] = useState(false)
  const [openaiKey, setOpenaiKey]         = useState('')
  const [hasStoredOpenaiKey, setHasStoredOpenaiKey] = useState(false)
  const [cursorKey, setCursorKey]         = useState('')
  const [hasStoredCursorKey, setHasStoredCursorKey] = useState(false)
  // Agents the user has already connected via /onboarding or /dashboard/agents
  // (credentials stored in the agent-credentials table). When set, we suppress
  // the "paste your API key" prompt for those agents entirely.
  const [connectedAgents, setConnectedAgents] = useState<Set<AgentCredentialId>>(new Set())
  const [needsKey, setNeedsKey]       = useState(false)
  const [validatingKey, setValidatingKey] = useState(false)
  const [anthropicKeyError, setAnthropicKeyError] = useState<string | null>(null)
  const [openaiKeyError, setOpenaiKeyError] = useState<string | null>(null)
  const [cursorKeyError, setCursorKeyError] = useState<string | null>(null)

  const needsAnthropicKey = agents.includes('claude')
  const needsOpenaiKey = agents.includes('codex')
  const needsCursorKey = agents.includes('cursor')
  const needsOpenCode = agents.includes('opencode')

  const openCodeEnvKeys = new Set(
    envVars
      .map(row => row.key.trim().toUpperCase())
      .filter(Boolean),
  )
  const hasOpenCodeProviderEnv = openCodeEnvKeys.has('ANTHROPIC_API_KEY') || openCodeEnvKeys.has('OPENAI_API_KEY')

  useEffect(() => {
    // Prefill from the locally restored session — using getUser() here
    // would let a flaky mobile-resume network call drop the prefill on
    // the floor, leaving the form empty even though the metadata is
    // sitting in the JWT on disk. Same fix-shape as the dashboard
    // route guards. See learnings/2026-04-mobile-route-guards-must-not-use-getuser.md.
    let cancelled = false
    void getRestoredSession().then(session => {
      if (cancelled) return
      const meta = session?.user.user_metadata ?? {}
      if (meta.githubToken) { setGhConnected(true); fetchRepos(meta.githubToken) }
      if (meta.defaultAgent && AGENTS.some(a => a.id === meta.defaultAgent)) {
        setAgents([meta.defaultAgent])
      }
      if (meta.anthropicApiKey) {
        setApiKey(meta.anthropicApiKey)
        setHasStoredKey(true)
      }
      if (meta.openaiApiKey) {
        setOpenaiKey(meta.openaiApiKey)
        setHasStoredOpenaiKey(true)
      }
      if (meta.cursorApiKey) {
        setCursorKey(meta.cursorApiKey)
        setHasStoredCursorKey(true)
      }
      if (meta.customSkills?.length) {
        setCustomSkills(meta.customSkills.map((s: any) => ({
          id: s.id,
          name: s.name,
          description: s.description || 'Custom skill',
          content: s.content,
        })))
      }
      if (meta.skillOverrides) setSkillOverrides(meta.skillOverrides)
    })
    // Also pull the new agent-credentials table; if the user already connected
    // Claude/Codex/Cursor via /onboarding or Settings → Coding Agents, we don't
    // need to ask for an API key in this form.
    listAgentCredentials().then(({ credentials }) => {
      if (cancelled) return
      const ids = new Set<AgentCredentialId>(credentials.map(c => c.agent))
      setConnectedAgents(ids)
      if (ids.has('claude')) setHasStoredKey(true)
      if (ids.has('codex')) setHasStoredOpenaiKey(true)
      if (ids.has('cursor')) setHasStoredCursorKey(true)
    }).catch(() => { /* silent — user may not have connected anything yet */ })
    getMyTeam().then(({ team }) => {
      if (cancelled || !team) return
      setTeamId(team.teamId)
      setTeamName(team.name)
      setOwnerType('team')
    }).catch(() => {})

    return () => { cancelled = true }
  }, [])

  async function fetchRepos(token: string) {
    setLoadingRepos(true)
    try {
      const res = await fetch(
        'https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member',
        { headers: { Authorization: `Bearer ${token}` } },
      )
      if (res.ok) {
        const data = await res.json()
        setRepos(data.map((r: any) => ({
          full_name: r.full_name, name: r.name, private: r.private, description: r.description,
        })))
      }
    } catch { /* ignore */ }
    setLoadingRepos(false)
  }

  function toggleRepo(fullName: string) {
    setSelectedRepos(prev =>
      prev.includes(fullName) ? prev.filter(r => r !== fullName) : [...prev, fullName]
    )
  }

  const activeAgent = AGENTS.find(a => a.id === agents[0])!

  function toggleAgent(id: string) {
    setAgents(prev => {
      if (prev.includes(id)) {
        if (prev.length === 1) return prev
        return prev.filter(a => a !== id)
      }
      return [...prev, id]
    })
  }

  function toggleSkill(id: string) {
    setSelectedSkills(prev => (
      prev.includes(id)
        ? prev.filter(skillId => skillId !== id)
        : [...prev, id]
    ))
  }

  const timeoutMs = 5 * 60_000
  const harnessSkills = createHarnessSkillCatalog(customSkills, skillOverrides)
  const previewSkill = harnessSkills.find(skill => skill.id === previewSkillId) ?? null

  const agentNames = agents.map(id => AGENTS.find(a => a.id === id)?.name ?? id).join(', ')
  const STEPS = ['Creating workspace', 'Booting instance', `Installing ${agentNames}`, selectedRepos.length > 0 ? 'Cloning repos' : 'Configuring SSH', 'Ready']

  function addEnvVar() {
    setEnvVars(prev => [...prev, { key: '', value: '', showValue: false }])
    setTimeout(() => {
      if (envVarsScrollRef.current) envVarsScrollRef.current.scrollTop = envVarsScrollRef.current.scrollHeight
    }, 0)
  }
  function removeEnvVar(i: number) {
    setEnvVars(prev => prev.filter((_, idx) => idx !== i))
  }
  function updateEnvVar(i: number, field: 'key' | 'value', val: string) {
    setEnvVars(prev => prev.map((row, idx) => idx === i ? { ...row, [field]: val } : row))
  }
  function toggleEnvVarVisibility(i: number) {
    setEnvVars(prev => prev.map((row, idx) => idx === i ? { ...row, showValue: !row.showValue } : row))
  }

  async function validateApiKey(provider: 'anthropic' | 'openai', key: string): Promise<string | null> {
    try {
      if (provider === 'anthropic') {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json', 'anthropic-dangerous-direct-browser-access': 'true' },
          body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
        })
        if (res.status === 401) return 'Invalid API key. Check that you copied it correctly.'
        if (res.status === 403) return 'API key lacks permission. Check your Anthropic account.'
        if (res.status === 429) return null // rate limited = key is valid
        if (!res.ok && res.status !== 200) {
          const body = await res.json().catch(() => null)
          if (body?.error?.message) return body.error.message
          return `Anthropic API returned ${res.status}`
        }
      } else {
        const res = await fetch('https://api.openai.com/v1/models', {
          headers: { 'Authorization': `Bearer ${key}` },
        })
        if (res.status === 401) return 'Invalid API key. Check that you copied it correctly.'
        if (res.status === 403) return 'API key lacks permission. Check your OpenAI account.'
        if (res.status === 429) return null // rate limited = key is valid
        if (!res.ok && res.status !== 200) return `OpenAI API returned ${res.status}`
      }
      return null
    } catch {
      return null // network error = assume ok, will fail later with a clearer message
    }
  }

  async function handleLaunch() {
    // Agents connected via the new agent-credentials flow don't need an API
    // key pasted in this form — the backend syncs their stored credential
    // blob to the EC2 host at session launch.
    const claudeConnected = connectedAgents.has('claude')
    const codexConnected = connectedAgents.has('codex')
    const cursorConnected = connectedAgents.has('cursor')

    if (needsAnthropicKey && !claudeConnected && (!apiKey || !apiKey.startsWith('sk-ant-'))) {
      setNeedsKey(true)
      return
    }
    if (needsOpenaiKey && !codexConnected && (!openaiKey || !openaiKey.startsWith('sk-'))) {
      setNeedsKey(true)
      return
    }
    if (needsCursorKey && !cursorConnected && (!cursorKey || !cursorKey.startsWith('crsr_'))) {
      setNeedsKey(true)
      return
    }
    if (needsOpenCode && !hasOpenCodeProviderEnv) {
      setError('OpenCode requires ANTHROPIC_API_KEY or OPENAI_API_KEY in Environment Variables.')
      return
    }

    // Validate keys against live APIs
    setAnthropicKeyError(null)
    setOpenaiKeyError(null)
    setCursorKeyError(null)
    setValidatingKey(true)
    let hasError = false
    if (needsAnthropicKey && !hasStoredKey) {
      const err = await validateApiKey('anthropic', apiKey)
      if (err) { setAnthropicKeyError(err); hasError = true }
    }
    if (needsOpenaiKey && !hasStoredOpenaiKey) {
      const err = await validateApiKey('openai', openaiKey)
      if (err) { setOpenaiKeyError(err); hasError = true }
    }
    if (needsCursorKey && !hasStoredCursorKey) {
      if (!cursorKey.startsWith('crsr_')) { setCursorKeyError('Cursor API key should start with crsr_'); hasError = true }
    }
    setValidatingKey(false)
    if (hasError) return

    const metaUpdates: Record<string, string> = {}
    if (needsAnthropicKey && !hasStoredKey) metaUpdates.anthropicApiKey = apiKey
    if (needsOpenaiKey && !hasStoredOpenaiKey) metaUpdates.openaiApiKey = openaiKey
    if (needsCursorKey && !hasStoredCursorKey) metaUpdates.cursorApiKey = cursorKey
    if (Object.keys(metaUpdates).length) {
      await supabase.auth.updateUser({ data: metaUpdates })
      if (metaUpdates.anthropicApiKey) setHasStoredKey(true)
      if (metaUpdates.openaiApiKey) setHasStoredOpenaiKey(true)
      if (metaUpdates.cursorApiKey) setHasStoredCursorKey(true)
    }

    setError(null); setBusy(true); setStepIdx(0)
    try {
      // Read metadata from the locally restored session — the user is
      // already past the dashboard's auth guard at this point, so the
      // session is proven and getSession() is sufficient. Using
      // getUser() here would let a flaky network at submit time
      // silently provision the workspace WITHOUT the user's stored
      // credentials, which is much worse than just provisioning with
      // them. Same scar as the dashboard guards.
      const session = await getRestoredSession()
      const meta = session?.user.user_metadata ?? {}
      const { serverId } = await provisionServer({
        ...(workspaceName.trim() ? { label: workspaceName.trim() } : {}),
        ownerType,
        ...(ownerType === 'team' && teamId ? { teamId } : {}),
        ...(needsAnthropicKey ? { anthropicApiKey: apiKey || meta.anthropicApiKey || '' } : {}),
        ...(needsOpenaiKey ? { openaiApiKey: openaiKey || meta.openaiApiKey || '' } : {}),
        ...(needsCursorKey ? { cursorApiKey: cursorKey || meta.cursorApiKey || '' } : {}),
        agents,
        repos: selectedRepos,
        envType,
        ...(meta.githubUsername && meta.githubToken
          ? { githubUsername: meta.githubUsername, githubToken: meta.githubToken } : {}),
        ...(vercelEnabled && vercelToken.trim() ? { vercelToken: vercelToken.trim() } : {}),
        ...(supabaseEnabled && supabaseUrl.trim() ? { supabaseUrl: supabaseUrl.trim() } : {}),
        ...(supabaseEnabled && supabaseServiceKey.trim() ? { supabaseServiceKey: supabaseServiceKey.trim() } : {}),
        ...(selectedSkills.length > 0 ? {
          skills: selectedSkills.filter(
            id =>
              !id.startsWith('custom-') &&
              !Object.prototype.hasOwnProperty.call(skillOverrides, id)
          ),
          customSkills: [
            // Built-in skills with user overrides
            ...selectedSkills
              .filter(
                id =>
                  !id.startsWith('custom-') &&
                  Object.prototype.hasOwnProperty.call(skillOverrides, id)
              )
              .map(id => ({ name: id, content: skillOverrides[id] })),
            // User-created custom skills
            ...customSkills
              .filter(s => selectedSkills.includes(s.id))
              .map(s => ({ name: s.name, content: s.content })),
          ],
        } : {}),
        ...(envVars.length > 0 ? {
          envVars: Object.fromEntries(
            envVars
              .filter(r => r.key.trim() && /^[A-Za-z_][A-Za-z0-9_]*$/.test(r.key.trim()))
              .map(r => [r.key.trim(), r.value])
          )
        } : {}),
        ...(setupFiles.length > 0 ? { setupFiles } : {}),
        ...(setupInstructions.trim() ? { setupInstructions: setupInstructions.trim() } : {}),
      })
      let idx = 0
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 5000))
        idx = Math.min(idx + 1, STEPS.length - 1); setStepIdx(idx)
        const status = await getServer(serverId)
        if (status.instanceState === 'running' && status.publicIp && status.sshPrivateKey) {
          setStepIdx(STEPS.length - 1) // "Ready"
          await new Promise(r => setTimeout(r, 800))
          onProvisioned(status); return
        }
        if (status.instanceState === 'terminated') throw new Error('Workspace was terminated unexpectedly')
      }
      throw new Error(`Timed out after ${timeoutMs / 60_000} minutes`)
    } catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }

  const filteredRepos = repos.filter(r =>
    r.full_name.toLowerCase().includes(repoSearch.toLowerCase())
  )

  const isReadyStep = stepIdx === STEPS.length - 1

  /* ── Progress state ── */
  if (busy) {
    return (
      <div className="flex flex-col gap-5 animate-fade-in">
        <div className="flex gap-1">
          {STEPS.map((_, i) => (
            <div key={i} className="flex-1 h-[2px] rounded-full bg-l1 overflow-hidden">
              <div className="h-full rounded-full transition-all duration-700 ease-out"
                style={{ width: i <= stepIdx ? '100%' : '0%', background: i <= stepIdx ? 'var(--color-accent)' : 'transparent' }} />
            </div>
          ))}
        </div>

        {isReadyStep ? (
          <div className="flex flex-col items-center gap-3 animate-fade-in">
            <div className="w-10 h-10 rounded-full bg-accent/10 flex items-center justify-center">
              <svg className="w-5 h-5 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
            </div>
            <p className="text-[13px] font-medium text-bright">Workspace ready</p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-center gap-2.5">
              <img src={activeAgent.logo} alt="" className="w-4 h-4 object-contain" />
              <div className="w-3 h-3 border-[1.5px] border-accent/20 border-t-accent rounded-full animate-spin" />
              <p className="text-[13px] text-secondary">{STEPS[stepIdx]}&hellip;</p>
            </div>
            <p className="text-[11px] text-tertiary text-center">
              Usually takes 2&ndash;3 minutes
            </p>
          </>
        )}
      </div>
    )
  }

  /* ── Form ── */
  return (
    <div className="flex flex-col gap-6">

      {/* ── Workspace name ── */}
      <div>
        <label htmlFor="workspace-name" className="block text-[12px] font-medium text-bright mb-1.5">Workspace name</label>
        <p id="workspace-name-description" className="text-[11px] text-tertiary mb-3">Optional display name for this workspace.</p>
        <input
          id="workspace-name"
          type="text"
          value={workspaceName}
          onChange={e => setWorkspaceName(e.target.value)}
          placeholder="e.g. my-backend-project"
          maxLength={80}
          spellCheck={false}
          aria-describedby="workspace-name-description"
          className="w-full appearance-none border-0 rounded-md bg-l2/60 px-2.5 py-2 text-[13px] text-bright placeholder:text-tertiary transition-colors focus:bg-l2/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/35"
        />
      </div>

      {teamId && (
        <div>
          <p className="text-[12px] font-medium text-bright mb-1.5">Visibility</p>
          <p className="text-[11px] text-tertiary mb-3">Choose whether this workspace is shared with your team.</p>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => setOwnerType('team')}
              className="flex items-center gap-2 px-2.5 h-8 rounded-md cursor-pointer transition-all duration-150"
              style={{ background: ownerType === 'team' ? 'var(--hover-bg)' : 'transparent' }}
            >
              <span className="text-[12px] font-medium" style={{ color: ownerType === 'team' ? 'var(--bright)' : 'var(--text-tertiary)' }}>
                Team{teamName ? ` · ${teamName}` : ''}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setOwnerType('personal')}
              className="flex items-center gap-2 px-2.5 h-8 rounded-md cursor-pointer transition-all duration-150"
              style={{ background: ownerType === 'personal' ? 'var(--hover-bg)' : 'transparent' }}
            >
              <span className="text-[12px] font-medium" style={{ color: ownerType === 'personal' ? 'var(--bright)' : 'var(--text-tertiary)' }}>
                Personal
              </span>
            </button>
          </div>
        </div>
      )}

      {/* ── Workspace type ── */}
      <div>
        <p className="text-[12px] font-medium text-bright mb-1.5">Workspace type</p>
        <p className="text-[11px] text-tertiary mb-3">Choose the instance type for your workspace.</p>
        <div className="flex gap-1.5">
        {ENV_TYPES.map(env => {
          const sel = envType === env.id
          return (
            <button
              key={env.id}
              onClick={() => setEnvType(env.id)}
              className="flex items-center gap-2 px-2.5 h-7 rounded-md cursor-pointer transition-all duration-150"
              style={{ background: sel ? 'var(--hover-bg)' : 'transparent' }}
            >
              <span style={{ color: sel ? 'var(--bright)' : 'var(--text-tertiary)' }}>{env.icon}</span>
              <span className="text-[12px] font-medium" style={{ color: sel ? 'var(--bright)' : 'var(--text-tertiary)' }}>
                {env.name}
              </span>
            </button>
          )
        })}
        </div>
      </div>

      {/* ── Agent pills (multi-select) ── */}
      <div>
        <p className="text-[12px] font-medium text-bright mb-1.5">Coding agents</p>
        <p className="text-[11px] text-tertiary mb-3">Select which AI agents to install. You can pick multiple.</p>
        <div className="flex gap-1.5">
          {AGENTS.map(a => {
            const sel = agents.includes(a.id)
            return (
              <button
                key={a.id}
                onClick={() => !a.comingSoon && toggleAgent(a.id)}
                className={`flex items-center gap-2 px-2.5 h-7 rounded-md transition-all duration-150 ${a.comingSoon ? 'opacity-40 cursor-default' : 'cursor-pointer'}`}
                style={{ background: sel && !a.comingSoon ? 'var(--hover-bg)' : 'transparent' }}
                aria-label={`Toggle ${a.name}`}
                disabled={a.comingSoon}
              >
                <img src={a.logo} alt="" className="w-[14px] h-[14px] object-contain" draggable={false} />
                <span className="text-[12px] font-medium" style={{ color: sel && !a.comingSoon ? 'var(--bright)' : 'var(--text-tertiary)' }}>
                  {a.name}
                </span>
                {a.comingSoon && (
                  <span className="text-[9px] text-tertiary bg-l1 rounded-full px-1.5 py-0.5">Soon</span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* ── Repos ── */}
      {ghConnected && (
        <div>
          <div className="flex items-center justify-between gap-3 mb-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[12px] font-medium text-bright">Repositories</p>
              <span className="text-[10px] text-tertiary px-1.5 py-0.5 rounded-full border border-line">
                optional
              </span>
            </div>
            {selectedRepos.length > 0 ? (
              <div className="flex items-center gap-2">
                <span className="rounded-full border border-line bg-l1 px-2 py-0.5 text-[10px] text-tertiary">
                  {selectedRepos.length} selected
                </span>
                <button onClick={() => setSelectedRepos([])}
                  className="text-[11px] text-tertiary hover:text-secondary transition-colors cursor-pointer">
                  Clear
                </button>
              </div>
            ) : null}
          </div>
          <p className="text-[11px] text-tertiary mb-3">Select the repositories to clone into this workspace.</p>

          {!loadingRepos && repos.length > 0 && (
            <div className="flex items-center gap-2 mb-2 rounded-md bg-l2/60 px-2.5 py-2 transition-colors focus-within:bg-l2/80 focus-within:ring-1 focus-within:ring-accent/35">
              <svg className="w-3 h-3 text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
              </svg>
              <input type="text" value={repoSearch} onChange={e => setRepoSearch(e.target.value)}
                aria-label="Filter repositories"
                placeholder="Filter&hellip;"
                className="flex-1 appearance-none border-0 bg-transparent text-[13px] text-bright placeholder:text-tertiary focus-visible:outline-none" />
            </div>
          )}

          {loadingRepos ? (
            <div className="flex items-center gap-2 py-3">
              <div className="w-3 h-3 border-[1.5px] border-secondary/30 border-t-secondary rounded-full animate-spin" />
              <p className="text-[12px] text-tertiary">Loading&hellip;</p>
            </div>
          ) : repos.length > 0 ? (
            <div className="max-h-[160px] overflow-y-auto -mx-1">
              {filteredRepos.length === 0 ? (
                <p className="text-[11px] text-tertiary py-3 px-1">No results</p>
              ) : filteredRepos.map(repo => {
                const sel = selectedRepos.includes(repo.full_name)
                return (
                  <button key={repo.full_name} onClick={() => toggleRepo(repo.full_name)}
                    className="w-full flex items-center gap-2 px-1 py-[6px] text-left cursor-pointer rounded-md transition-colors duration-100 hover:bg-[var(--hover-bg)]"
                  >
                    <span className="w-3 flex-shrink-0 text-center">
                      {sel ? (
                        <svg className="w-3 h-3 inline-block" style={{ color: activeAgent.color }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                        </svg>
                      ) : (
                        <span className="block w-1.5 h-1.5 rounded-full bg-l1 mx-auto" />
                      )}
                    </span>
                    <span className="text-[12px] truncate" style={{ color: sel ? activeAgent.color : '#8a8f98' }}>
                      {repo.full_name}
                    </span>
                    {repo.private && (
                      <svg className="w-2.5 h-2.5 text-tertiary flex-shrink-0 ml-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                      </svg>
                    )}
                  </button>
                )
              })}
            </div>
          ) : (
            <p className="text-[11px] text-tertiary py-2">No repositories found.</p>
          )}
        </div>
      )}

      {/* ── Advanced toggle ── */}
      <button
        type="button"
        onClick={() => setShowAdvanced(v => !v)}
        className="w-full text-left border-t border-line pt-5 cursor-pointer group"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[12px] font-medium text-bright">Skills & configuration</p>
              <span className="text-[10px] text-tertiary px-1.5 py-0.5 rounded-full border border-line">
                optional
              </span>
            </div>
            <p className="mt-1 text-[11px] text-tertiary">
              Harness packs, tools, environment variables, setup files, and setup instructions.
            </p>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            {(selectedSkills.length > 0 || envVars.length > 0 || vercelEnabled || supabaseEnabled || setupFiles.length > 0 || setupInstructions.trim()) && (
              <span className="text-[10px] text-accent bg-accent/10 px-1.5 py-0.5 rounded-full">
                configured
              </span>
            )}
            <span className="flex h-7 w-7 items-center justify-center rounded-full border border-line text-tertiary transition-colors group-hover:text-secondary group-hover:border-line2">
              <svg
                className={`w-3 h-3 transition-transform duration-200 ${showAdvanced ? 'rotate-90' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
              </svg>
            </span>
          </div>
        </div>
      </button>

      {showAdvanced && (
      <div className="animate-fade-in">

      {/* ── Harness ── */}
      <div className="border-t border-line pt-5">
        <div className="flex items-center justify-between gap-3 mb-1">
          <p className="text-[12px] font-medium text-bright">Harness</p>
          {selectedSkills.length > 0 && (
            <span className="rounded-full border border-line bg-l1 px-2 py-0.5 text-[10px] text-tertiary">
              {selectedSkills.length} selected
            </span>
          )}
        </div>
        <p className="text-[11px] text-tertiary mb-4">
          Instruction packs that shape how the agent works in this workspace. They guide behavior only and do not connect tools or install credentials.
        </p>

        <div className="space-y-4">
          {(['framework', 'workflow', 'tool', 'custom'] as const).map(category => {
            const categorySkills = harnessSkills.filter(skill => skill.category === category)
            if (categorySkills.length === 0) return null

            return (
              <div key={category}>
                <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.18em] text-tertiary">
                  {HARNESS_CATEGORY_SECTION_LABELS[category]}
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {categorySkills.map(skill => {
                    const selected = selectedSkills.includes(skill.id)

                    return (
                      <div
                        key={skill.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => toggleSkill(skill.id)}
                        onKeyDown={event => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            toggleSkill(skill.id)
                          }
                        }}
                        aria-pressed={selected}
                        className={`group rounded-xl border p-3 text-left transition-all duration-150 cursor-pointer ${
                          selected
                            ? 'border-accent/35 bg-accent/5 shadow-[0_0_0_1px_rgba(64,189,255,0.08)_inset]'
                            : 'border-line bg-l1/30 hover:border-line2 hover:bg-l1/60'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <p className="text-[12.5px] font-medium text-bright">{skill.name}</p>
                              <span className="rounded-full border border-line bg-ink/60 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-tertiary">
                                {HARNESS_CATEGORY_BADGE_LABELS[skill.category]}
                              </span>
                              {skill.hasOverride && (
                                <span className="rounded-full bg-accent/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-accent">
                                  Customized
                                </span>
                              )}
                            </div>
                            <p className="mt-1 text-[11px] leading-relaxed text-tertiary">
                              {skill.description}
                            </p>
                          </div>

                          <div
                            className={`mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border transition-colors ${
                              selected ? 'border-accent/40 bg-accent/10 text-accent' : 'border-line bg-ink text-transparent'
                            }`}
                          >
                            <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                            </svg>
                          </div>
                        </div>

                        <div className="mt-3 flex items-center justify-between gap-3 border-t border-line/70 pt-2.5">
                          <span className="text-[10px] text-tertiary">
                            {selected ? 'Selected for this workspace' : 'Tap to include'}
                          </span>
                          <button
                            type="button"
                            onClick={event => {
                              event.stopPropagation()
                              setPreviewSkillId(skill.id)
                            }}
                            className="text-[11px] font-medium text-accent hover:text-accent/80 transition-colors cursor-pointer"
                          >
                            Preview
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Tools ── */}
      <div className="border-t border-line pt-5">
        <p className="text-[12px] font-medium text-bright mb-1">Tools</p>
        <p className="text-[11px] text-tertiary mb-3">Pre-configure CLI tools and credentials in the workspace.</p>

        <div className="mb-2">
          <button onClick={() => { setVercelEnabled(v => !v); if (vercelEnabled) setVercelToken('') }}
            className="w-full flex items-center gap-2.5 py-1.5 cursor-pointer group">
            <div className={`w-7 h-4 rounded-full transition-colors duration-200 flex items-center ${vercelEnabled ? 'bg-accent justify-end' : 'bg-l1 justify-start'}`}>
              <div className="w-3 h-3 rounded-full bg-ink mx-0.5 transition-all duration-200" />
            </div>
            <svg className="w-3 h-3 text-tertiary" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1L24 22H0L12 1z" /></svg>
            <span className="text-[12px] text-secondary group-hover:text-bright transition-colors">Vercel</span>
            <span className="text-[10px] text-tertiary ml-auto">deploy previews</span>
          </button>
          {vercelEnabled && (
            <div className="ml-[38px] mt-1.5 animate-fade-in">
              <input type="password" value={vercelToken} onChange={e => setVercelToken(e.target.value)}
                placeholder="Vercel token" autoComplete="off" autoFocus
                className="w-full bg-transparent text-[12px] text-bright font-mono placeholder:text-tertiary outline-none border-b border-line pb-1.5 focus:border-accent/30 transition-colors" />
            </div>
          )}
        </div>

        <div className="mb-1">
          <button onClick={() => { setSupabaseEnabled(v => !v); if (supabaseEnabled) { setSupabaseUrl(''); setSupabaseServiceKey('') } }}
            className="w-full flex items-center gap-2.5 py-1.5 cursor-pointer group">
            <div className={`w-7 h-4 rounded-full transition-colors duration-200 flex items-center ${supabaseEnabled ? 'bg-accent justify-end' : 'bg-l1 justify-start'}`}>
              <div className="w-3 h-3 rounded-full bg-ink mx-0.5 transition-all duration-200" />
            </div>
            <svg className="w-3 h-3 text-tertiary" viewBox="0 0 109 113" fill="currentColor">
              <path d="M63.7 110.3c-2.6 3.3-8 1.5-8.1-2.8l-.5-55.4h37.2c6.7 0 10.4 7.7 6.2 12.9L63.7 110.3z" opacity=".6" />
              <path d="M45.3 2.7c2.6-3.3 8-1.5 8.1 2.8l.2 55.4H16.6c-6.7 0-10.4-7.7-6.2-12.9L45.3 2.7z" />
            </svg>
            <span className="text-[12px] text-secondary group-hover:text-bright transition-colors">Supabase</span>
            <span className="text-[10px] text-tertiary ml-auto">database access</span>
          </button>
          {supabaseEnabled && (
            <div className="ml-[38px] mt-1.5 flex flex-col gap-1.5 animate-fade-in">
              <input type="text" value={supabaseUrl} onChange={e => setSupabaseUrl(e.target.value)}
                placeholder="Project URL" autoComplete="off" autoFocus
                className="w-full bg-transparent text-[12px] text-bright font-mono placeholder:text-tertiary outline-none border-b border-line pb-1.5 focus:border-accent/30 transition-colors" />
              <input type="password" value={supabaseServiceKey} onChange={e => setSupabaseServiceKey(e.target.value)}
                placeholder="Service role key" autoComplete="off"
                className="w-full bg-transparent text-[12px] text-bright font-mono placeholder:text-tertiary outline-none border-b border-line pb-1.5 focus:border-accent/30 transition-colors" />
            </div>
          )}
        </div>
      </div>

      </div>
      )}

      <HarnessSkillPreviewDialog
        skill={previewSkill}
        selected={previewSkill ? selectedSkills.includes(previewSkill.id) : false}
        onClose={() => setPreviewSkillId(null)}
        onToggleSelected={() => {
          if (!previewSkill) return
          toggleSkill(previewSkill.id)
        }}
      />

      {/* ── API Key (just-in-time) ─────────────────────────────────────────
          Only shows when a selected agent has NOT been connected via the
          onboarding flow. Agents connected there set hasStored* to true, so
          this entire section collapses away. */}
      {needsKey && (needsAnthropicKey && !hasStoredKey || needsOpenaiKey && !hasStoredOpenaiKey || needsCursorKey && !hasStoredCursorKey) && (
        <div className="border-t border-line pt-4 animate-fade-in">
          <p className="text-[13px] text-bright mb-1">Add an API key</p>
          <p className="text-[12px] text-tertiary mb-3">
            Needed for agents you haven&apos;t connected yet.
            <a href="/dashboard/agents" className="text-accent hover:underline ml-1">Or connect with your account →</a>
          </p>

          {needsAnthropicKey && !hasStoredKey && (
            <div className="mb-3">
              <p className="text-[11px] text-secondary mb-1">Anthropic API Key</p>
              <input
                type="password"
                value={apiKey}
                onChange={e => { setApiKey(e.target.value); setAnthropicKeyError(null) }}
                onKeyDown={e => { if (e.key === 'Enter') handleLaunch() }}
                placeholder="sk-ant-api03-..."
                autoFocus
                className={`w-full bg-transparent text-[13px] text-bright font-mono placeholder:text-tertiary outline-none border-b pb-2 mb-1 transition-colors ${anthropicKeyError ? 'border-danger' : 'border-line focus:border-accent/30'}`}
                autoComplete="off"
              />
              {anthropicKeyError ? (
                <p className="text-[11px] text-danger animate-fade-in">{anthropicKeyError}</p>
              ) : (
                <p className="text-[11px] text-tertiary">
                  <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer"
                    className="text-accent/70 hover:text-accent transition-colors">
                    console.anthropic.com ↗
                  </a>
                </p>
              )}
            </div>
          )}

          {needsOpenaiKey && !hasStoredOpenaiKey && (
            <div className="mb-3">
              <p className="text-[11px] text-secondary mb-1">OpenAI API Key</p>
              <input
                type="password"
                value={openaiKey}
                onChange={e => { setOpenaiKey(e.target.value); setOpenaiKeyError(null) }}
                onKeyDown={e => { if (e.key === 'Enter') handleLaunch() }}
                placeholder="sk-..."
                autoFocus={!needsAnthropicKey || hasStoredKey}
                className={`w-full bg-transparent text-[13px] text-bright font-mono placeholder:text-tertiary outline-none border-b pb-2 mb-1 transition-colors ${openaiKeyError ? 'border-danger' : 'border-line focus:border-accent/30'}`}
                autoComplete="off"
              />
              {openaiKeyError ? (
                <p className="text-[11px] text-danger animate-fade-in">{openaiKeyError}</p>
              ) : (
                <p className="text-[11px] text-tertiary">
                  <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer"
                    className="text-accent/70 hover:text-accent transition-colors">
                    platform.openai.com ↗
                  </a>
                </p>
              )}
            </div>
          )}

          {needsCursorKey && !hasStoredCursorKey && (
            <div className="mb-3">
              <p className="text-[11px] text-secondary mb-1">Cursor API Key</p>
              <input
                type="password"
                value={cursorKey}
                onChange={e => { setCursorKey(e.target.value); setCursorKeyError(null) }}
                onKeyDown={e => { if (e.key === 'Enter') handleLaunch() }}
                placeholder="crsr_…"
                autoFocus={(!needsAnthropicKey || hasStoredKey) && (!needsOpenaiKey || hasStoredOpenaiKey)}
                className={`w-full bg-transparent text-[13px] text-bright font-mono placeholder:text-tertiary outline-none border-b pb-2 mb-1 transition-colors ${cursorKeyError ? 'border-danger' : 'border-line focus:border-accent/30'}`}
                autoComplete="off"
              />
              {cursorKeyError ? (
                <p className="text-[11px] text-danger animate-fade-in">{cursorKeyError}</p>
              ) : (
                <p className="text-[11px] text-tertiary">
                  <a href="https://cursor.com/settings" target="_blank" rel="noreferrer"
                    className="text-accent/70 hover:text-accent transition-colors">
                    cursor.com/settings ↗
                  </a>
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {showAdvanced && (
      <div className="animate-fade-in">

      {/* ── Environment Variables ── */}
      <div className="border-t border-line pt-5">
        <div className="flex items-center justify-between mb-1">
          <p className="text-[12px] font-medium text-bright">Environment Variables</p>
          {envVars.length > 0 && (
            <span className="text-[11px] text-tertiary">{envVars.length} var{envVars.length !== 1 ? 's' : ''}</span>
          )}
        </div>
        <p className="text-[11px] text-tertiary mb-3">Exported in your workspace shell. Use for API keys, tokens, or config.</p>

        {needsOpenCode && (
          <div className="mb-3 rounded-xl border border-accent/20 bg-accent/5 px-3 py-2.5 animate-fade-in">
            <p className="text-[11.5px] font-medium text-bright mb-1">OpenCode auth for v1</p>
            <p className="text-[11px] text-tertiary leading-relaxed">
              OpenCode uses provider-specific credentials. For v1, add one of these here:
              {' '}
              <span className="font-mono text-secondary">ANTHROPIC_API_KEY=sk-ant-...</span>
              {' '}
              or
              {' '}
              <span className="font-mono text-secondary">OPENAI_API_KEY=sk-...</span>.
            </p>
          </div>
        )}

        {envVars.length > 0 && (
          <div ref={envVarsScrollRef} className="max-h-48 overflow-y-auto flex flex-col gap-2 mb-2.5 pr-0.5" style={{ scrollbarWidth: 'thin', scrollbarColor: '#e2e8f0 transparent' }}>
            {envVars.map((row, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="text"
                  value={row.key}
                  onChange={e => updateEnvVar(i, 'key', e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
                  placeholder="KEY"
                  spellCheck={false}
                  className="w-32 flex-shrink-0 bg-transparent text-[12px] text-bright font-mono placeholder:text-tertiary outline-none border-b border-line pb-1.5 focus:border-accent/30 transition-colors"
                />
                <div className="flex-1 flex items-center gap-1 border-b border-line focus-within:border-accent/30 transition-colors pb-1.5">
                  <input
                    type={row.showValue ? 'text' : 'password'}
                    value={row.value}
                    onChange={e => updateEnvVar(i, 'value', e.target.value)}
                    placeholder="value"
                    autoComplete="off"
                    spellCheck={false}
                    className="flex-1 bg-transparent text-[12px] text-bright font-mono placeholder:text-tertiary outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => toggleEnvVarVisibility(i)}
                    className="text-tertiary hover:text-secondary transition-colors cursor-pointer flex-shrink-0 p-0.5"
                    tabIndex={-1}
                  >
                    {row.showValue ? (
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
                      </svg>
                    ) : (
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                    )}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => removeEnvVar(i)}
                  className="text-tertiary hover:text-danger transition-colors cursor-pointer flex-shrink-0 p-0.5 press-scale"
                  tabIndex={-1}
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {envPasteMode ? (
          <div className="space-y-2">
            <textarea
              value={envPasteText}
              onChange={e => setEnvPasteText(e.target.value)}
              placeholder={"# Paste your .env file here\nDATABASE_URL=postgres://...\nSECRET_KEY=\"my secret\"\nNEXT_PUBLIC_API_URL=https://..."}
              spellCheck={false}
              className="w-full h-32 bg-l1 text-[12px] font-mono text-bright placeholder:text-tertiary/50 rounded-lg border border-line p-3 outline-none focus:border-accent/30 transition-colors resize-none"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  const parsed = parseEnvFile(envPasteText)
                  if (parsed.length === 0) return
                  setEnvVars(prev => {
                    const map = new Map(prev.map(v => [v.key, v]))
                    for (const { key, value } of parsed) map.set(key, { key, value, showValue: false })
                    return Array.from(map.values())
                  })
                  setEnvPasteText('')
                  setEnvPasteMode(false)
                }}
                className="text-[12px] font-medium text-accent hover:text-accent/80 transition-colors cursor-pointer"
              >
                Parse & add
              </button>
              <button
                type="button"
                onClick={() => { setEnvPasteMode(false); setEnvPasteText('') }}
                className="text-[12px] text-tertiary hover:text-secondary transition-colors cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={addEnvVar}
              className="flex items-center gap-1.5 text-[12px] text-tertiary hover:text-secondary transition-colors cursor-pointer group"
            >
              <span className="w-4 h-4 rounded-full border border-line group-hover:border-line flex items-center justify-center transition-colors">
                <svg className="w-2 h-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
              </span>
              Add variable
            </button>
            <button
              type="button"
              onClick={() => setEnvPasteMode(true)}
              className="flex items-center gap-1.5 text-[12px] text-tertiary hover:text-secondary transition-colors cursor-pointer"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
              </svg>
              Paste .env file
            </button>
          </div>
        )}
      </div>

      {/* ── Setup Files ── */}
      <div className="border-t border-line pt-5">
        <div className="flex items-center justify-between mb-1">
          <p className="text-[12px] font-medium text-bright">Setup Files</p>
          {setupFiles.length > 0 && (
            <span className="text-[11px] text-tertiary">{setupFiles.length} file{setupFiles.length !== 1 ? 's' : ''}</span>
          )}
        </div>
        <p className="text-[11px] text-tertiary mb-3">Config files for project setup (.env, firebase.json, .npmrc, etc.). Claude will place them in the right locations.</p>

        {setupFiles.length > 0 && (
          <div className="flex flex-col gap-2 mb-2.5">
            {setupFiles.map((f, i) => (
              <div key={i} className="flex items-center gap-2 bg-l1 rounded-lg px-3 py-2">
                <svg className="w-3 h-3 text-tertiary flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
                <span className="text-[12px] font-mono text-bright flex-1 truncate">{f.name}</span>
                <span className="text-[10px] text-tertiary">{f.content.length} chars</span>
                <button type="button" onClick={() => setSetupFiles(prev => prev.filter((_, j) => j !== i))}
                  className="text-tertiary hover:text-danger transition-colors cursor-pointer p-0.5">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {showAddFile ? (
          <div className="space-y-2">
            <input
              type="text"
              value={newFileName}
              onChange={e => setNewFileName(e.target.value)}
              placeholder="Filename (e.g. .env.local, firebase.json)"
              spellCheck={false}
              className="w-full bg-transparent text-[12px] font-mono text-bright placeholder:text-tertiary outline-none border-b border-line pb-1.5 focus:border-accent/30 transition-colors"
            />
            <textarea
              value={newFileContent}
              onChange={e => setNewFileContent(e.target.value)}
              placeholder="Paste file content here..."
              spellCheck={false}
              className="w-full h-28 bg-l1 text-[12px] font-mono text-bright placeholder:text-tertiary/50 rounded-lg border border-line p-3 outline-none focus:border-accent/30 transition-colors resize-none"
            />
            <div className="flex items-center gap-2">
              <button type="button"
                onClick={() => {
                  if (!newFileName.trim() || !newFileContent.trim()) return
                  setSetupFiles(prev => [...prev, { name: newFileName.trim(), content: newFileContent }])
                  setNewFileName(''); setNewFileContent(''); setShowAddFile(false)
                }}
                className="text-[12px] font-medium text-accent hover:text-accent/80 transition-colors cursor-pointer">
                Add file
              </button>
              <button type="button" onClick={() => { setShowAddFile(false); setNewFileName(''); setNewFileContent('') }}
                className="text-[12px] text-tertiary hover:text-secondary transition-colors cursor-pointer">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setShowAddFile(true)}
            className="flex items-center gap-1.5 text-[12px] text-tertiary hover:text-secondary transition-colors cursor-pointer group">
            <span className="w-4 h-4 rounded-full border border-line group-hover:border-line flex items-center justify-center transition-colors">
              <svg className="w-2 h-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
            </span>
            Add file
          </button>
        )}
      </div>

      {/* ── Setup Instructions ── */}
      <div className="border-t border-line pt-5">
        <p className="text-[12px] font-medium text-bright mb-1">Setup Instructions</p>
        <p className="text-[11px] text-tertiary mb-3">Optional notes for the agent during project setup — package manager preferences, migration commands, services to skip, etc.</p>
        <textarea
          value={setupInstructions}
          onChange={e => setSetupInstructions(e.target.value)}
          placeholder={"e.g. Use pnpm instead of npm. Run prisma db push, not migrate. The Redis service isn't needed for local dev."}
          spellCheck={false}
          rows={3}
          className="w-full bg-l1 text-[12px] text-bright placeholder:text-tertiary/50 rounded-lg border border-line p-3 outline-none focus:border-accent/30 transition-colors resize-none"
        />
      </div>

      </div>
      )}

      {/* ── Launch ── */}
      <div className="flex justify-end pt-1">
        <button onClick={handleLaunch} disabled={validatingKey} className="btn btn-primary cursor-pointer disabled:opacity-50">
          {validatingKey ? (
            <>
              <span className="w-3.5 h-3.5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
              Validating key...
            </>
          ) : (
            <>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.59 14.37a6 6 0 01-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 006.16-12.12A14.98 14.98 0 009.631 8.41m5.96 5.96a14.926 14.926 0 01-5.841 2.58m-.119-8.54a6 6 0 00-7.381 5.84h4.8m2.581-5.84a14.927 14.927 0 00-2.58 5.84m2.699 2.7c-.103.021-.207.041-.311.06a15.09 15.09 0 01-2.448-2.448 14.9 14.9 0 01.06-.312m-2.24 2.39a4.493 4.493 0 00-1.757 4.306 4.493 4.493 0 004.306-1.758M16.5 9a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z" />
              </svg>
              Launch
            </>
          )}
        </button>
      </div>

      {error && (
        <p className="text-[12px] text-danger animate-fade-in">{error}</p>
      )}
    </div>
  )
}
