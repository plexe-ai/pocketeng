'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getRestoredSession, supabase } from '@/lib/supabase'
import { listServers, smsRegister, type Server } from '@/lib/api'
import { prepareLinearOAuthState } from '@/lib/linear-oauth'
import { prepareSlackOAuthState } from '@/lib/slack-oauth'

/* ── Types ── */

interface FieldIntegration {
  id: string
  name: string
  description: string
  icon: React.ReactNode
  oauth: false
  fields: { key: string; label: string; placeholder: string; type: 'text' | 'password' }[]
  helpLink: string
  helpLabel: string
}

interface OAuthIntegration {
  id: string
  name: string
  description: string
  icon: React.ReactNode
  oauth: true
  connectedKey: string   // user_metadata key that indicates connected state
  displayKey?: string    // key to show connected identity (e.g. linearName)
  comingSoon?: boolean
}

type Integration = FieldIntegration | OAuthIntegration

/* ── OAuth helpers ── */

const LINEAR_CLIENT_ID = process.env.NEXT_PUBLIC_LINEAR_CLIENT_ID ?? ''
const SLACK_CLIENT_ID = process.env.NEXT_PUBLIC_SLACK_CLIENT_ID ?? ''

function buildLinearAuthUrl(state: string) {
  const params = new URLSearchParams({
    client_id: LINEAR_CLIENT_ID,
    redirect_uri: 'https://console.pocketeng.ai/auth/linear-callback',
    response_type: 'code',
    scope: 'read,write,admin',
    prompt: 'consent',
    actor: 'application',
    region: 'eu',
    state,
  })
  return `https://linear.app/oauth/authorize?${params}`
}

function buildSlackAuthUrl(state: string) {
  const params = new URLSearchParams({
    client_id: SLACK_CLIENT_ID,
    redirect_uri: 'https://console.pocketeng.ai/auth/slack-callback',
    scope: 'incoming-webhook,chat:write,app_mentions:read,channels:history,channels:read,reactions:write',
    state,
  })
  return `https://slack.com/oauth/v2/authorize?${params}`
}

/* ── Integration definitions ── */

const LINEAR_ICON = (
  <svg className="w-5 h-5" viewBox="0 0 100 100" fill="currentColor">
    <path d="M1.22541 61.5228c-.2225-.9485.90748-1.5459 1.59638-.8437L39.3119 98.1706c.7016.7143.1329 1.8484-.8044 1.6075C17.7017 94.5765 3.64188 80.108 1.22541 61.5228zM.01171 50.5582C-.11956 51.9983.995987 53.1461 2.44393 53.1461H46.7032c1.0085 0 1.8261-.8176 1.8261-1.8261V7.13944c0-1.44795-1.1478-2.5635-2.5879-2.43175C21.5435 7.35364 2.65677 26.6375.01171 50.5582z" fillOpacity=".4" />
    <path d="M99.9996 47.5765C99.9996 73.0515 79.0766 93.9745 53.6016 93.9745c-6.8528 0-13.3836-1.4965-19.2448-4.1786-.6636-.3037-.7604-1.1939-.1866-1.6349L80.4713 52.2986c.4676-.3593.4039-1.0784-.1252-1.3495C74.9012 47.6862 68.7345 45.4782 62.088 45.4782c-16.7889 0-30.3966 13.6077-30.3966 30.3966 0 1.59.1221 3.1507.357 4.6753.0758.4925-.3737.8919-.8544.7596C14.0958 76.3002 1.62354 61.4189 1.62354 43.7397c0-22.0648 17.88866-39.9534 39.95346-39.9534 24.69 0 44.7082 20.0181 44.7082 44.7082.0014.3527-.0005.705-.0057 1.0571-.0037.2555.1922.4702.4477.483C93.7508 49.9974 99.9996 48.0766 99.9996 47.5765z" />
  </svg>
)

const SLACK_ICON = (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
    <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"/>
  </svg>
)

const VERCEL_ICON = (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 1L24 22H0L12 1z" />
  </svg>
)

const SUPABASE_ICON = (
  <svg className="w-5 h-5" viewBox="0 0 109 113" fill="currentColor">
    <path d="M63.7 110.3c-2.6 3.3-8 1.5-8.1-2.8l-.5-55.4h37.2c6.7 0 10.4 7.7 6.2 12.9L63.7 110.3z" opacity=".6" />
    <path d="M45.3 2.7c2.6-3.3 8-1.5 8.1 2.8l.2 55.4H16.6c-6.7 0-10.4-7.7-6.2-12.9L45.3 2.7z" />
  </svg>
)

const SMS_ICON = (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none">
    <defs>
      <linearGradient id="sms-g" x1="12" y1="1" x2="12" y2="23" gradientUnits="userSpaceOnUse">
        <stop stopColor="#5EF38C"/>
        <stop offset="1" stopColor="#34C759"/>
      </linearGradient>
    </defs>
    <path d="M2 11.5C2 5.7 6.48 1 12 1s10 4.7 10 10.5c0 5.8-4.48 10.5-10 10.5a10.7 10.7 0 0 1-4.5-.99L2.4 22.8a.75.75 0 0 1-1.02-.88l1.18-4.3A10.3 10.3 0 0 1 2 11.5Z" fill="url(#sms-g)"/>
  </svg>
)

const PHONE_ICON = (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none">
    <defs>
      <linearGradient id="phone-g" x1="12" y1="1" x2="12" y2="23" gradientUnits="userSpaceOnUse">
        <stop stopColor="#60A5FA"/>
        <stop offset="1" stopColor="#2563EB"/>
      </linearGradient>
    </defs>
    <path
      fill="url(#phone-g)"
      d="M5.75 3h3a1 1 0 0 1 .96.73l1.1 3.84a1 1 0 0 1-.5 1.14l-2.08 1.1a11.3 11.3 0 0 0 5.96 5.96l1.1-2.08a1 1 0 0 1 1.14-.5l3.84 1.1a1 1 0 0 1 .73.96v3A2.75 2.75 0 0 1 18.25 21C9.83 21 3 14.17 3 5.75A2.75 2.75 0 0 1 5.75 3Z"
    />
  </svg>
)

// Public call-in number bound to the Retell voice agent. Shown in the UI
// so registered users know where to dial. If we ever buy a per-region
// number or rotate, update here — nothing else reads this string.
const VOICE_PHONE_NUMBER = '+1 (844) 539-1053'

const INTEGRATIONS: Integration[] = [
  {
    id: 'linear',
    name: 'Linear',
    description: 'Let your coding agent read and update issues directly from Linear.',
    icon: LINEAR_ICON,
    oauth: true,
    connectedKey: 'linearAccessToken',
    displayKey: 'linearName',
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Get notifications when your workspace finishes a task or needs attention.',
    icon: SLACK_ICON,
    oauth: true,
    connectedKey: 'slackWebhookUrl',
    displayKey: 'slackChannel',
  },
  {
    id: 'vercel',
    name: 'Vercel',
    description: 'Deploy directly from your workspace with Vercel CLI pre-configured.',
    icon: VERCEL_ICON,
    oauth: false,
    fields: [
      { key: 'vercelToken', label: 'Token', placeholder: 'vercel_\u2026', type: 'password' },
    ],
    helpLink: 'https://vercel.com/account/tokens',
    helpLabel: 'Create a token',
  },
  {
    id: 'supabase',
    name: 'Supabase',
    description: 'Pre-configure Supabase credentials in your workspace.',
    icon: SUPABASE_ICON,
    oauth: false,
    fields: [
      { key: 'supabaseUrl', label: 'Project URL', placeholder: 'https://\u2026.supabase.co', type: 'text' },
      { key: 'supabaseServiceKey', label: 'Service role key', placeholder: 'eyJ\u2026', type: 'password' },
    ],
    helpLink: 'https://supabase.com/dashboard/project/_/settings/api',
    helpLabel: 'Find your keys',
  },
]

/* ── Component ── */

export default function IntegrationsPage() {
  const router = useRouter()
  const [meta, setMeta] = useState<Record<string, any>>({})
  const [editing, setEditing] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  // SMS state
  const [servers, setServers] = useState<Server[]>([])
  const [smsPhone, setSmsPhone] = useState('')
  const [smsServerId, setSmsServerId] = useState('')
  const [smsEditing, setSmsEditing] = useState(false)
  const [smsSaving, setSmsSaving] = useState(false)
  const [smsConnected, setSmsConnected] = useState(false)
  const [smsError, setSmsError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    void (async () => {
      const session = await getRestoredSession()
      if (cancelled) return
      if (!session) { router.replace('/'); return }
      const m = session.user.user_metadata ?? {}
      setMeta(m)
      // Restore SMS state from metadata
      if (m.smsPhoneNumber) {
        setSmsPhone(m.smsPhoneNumber)
        setSmsConnected(true)
      }
      if (m.smsDefaultServerId) setSmsServerId(m.smsDefaultServerId)
    })()
    // Fetch servers for the default env picker
    listServers().then(({ servers }) => {
      if (cancelled) return
      setServers(servers.filter(s => s.instanceState !== 'terminated'))
    }).catch(() => {})

    return () => {
      cancelled = true
    }
  }, [router])

  /* ── Field-based integration helpers ── */

  function startEditing(intg: FieldIntegration) {
    const d: Record<string, string> = {}
    for (const f of intg.fields) d[f.key] = meta[f.key] ?? ''
    setDrafts(d)
    setEditing(intg.id)
  }

  async function handleSave(intg: FieldIntegration) {
    setSaving(true)
    try {
      const updates: Record<string, string> = {}
      for (const f of intg.fields) updates[f.key] = drafts[f.key]?.trim() ?? ''
      await supabase.auth.updateUser({ data: updates })
      setMeta(prev => ({ ...prev, ...updates }))
      setEditing(null)
    } finally { setSaving(false) }
  }

  async function handleDisconnectField(intg: FieldIntegration) {
    setSaving(true)
    try {
      const updates: Record<string, null> = {}
      for (const f of intg.fields) updates[f.key] = null
      await supabase.auth.updateUser({ data: updates })
      const cleared: Record<string, string> = {}
      for (const f of intg.fields) cleared[f.key] = ''
      setMeta(prev => ({ ...prev, ...cleared }))
      setEditing(null)
    } finally { setSaving(false) }
  }

  function isFieldConnected(intg: FieldIntegration): boolean {
    return intg.fields.some(f => !!meta[f.key])
  }

  /* ── OAuth integration helpers ── */

  function isOAuthConnected(intg: OAuthIntegration): boolean {
    return !!meta[intg.connectedKey]
  }

  async function handleDisconnectOAuth(intg: OAuthIntegration) {
    setSaving(true)
    try {
      const updates: Record<string, null> = { [intg.connectedKey]: null }
      if (intg.displayKey) updates[intg.displayKey] = null
      // Clear any extra keys for this integration
      if (intg.id === 'linear') {
        updates.linearTeamId = null
        updates.linearTeams = null
        updates.linearName = null
      }
      if (intg.id === 'slack') {
        updates.slackBotToken = null
        updates.slackTeamName = null
        updates.slackChannel = null
      }
      await supabase.auth.updateUser({ data: updates })
      setMeta(prev => {
        const next = { ...prev }
        for (const k of Object.keys(updates)) delete next[k]
        return next
      })
    } finally { setSaving(false) }
  }

  /* ── Render helpers ── */

  function getOAuthDisplayText(intg: OAuthIntegration): string | null {
    if (!isOAuthConnected(intg)) return null
    if (intg.id === 'slack') {
      const team = meta.slackTeamName
      const channel = meta.slackChannel
      if (team && channel) return `${team} \u2014 ${channel}`
      if (channel) return channel
      return team || null
    }
    return intg.displayKey ? meta[intg.displayKey] : null
  }

  function renderOAuthCard(intg: OAuthIntegration) {
    const connected = isOAuthConnected(intg)
    const displayName = getOAuthDisplayText(intg)

    return (
      <div key={intg.id} className={`card-surface transition-all duration-200 ${intg.comingSoon ? 'opacity-60' : ''}`}>
        <div className="flex items-center gap-3.5 px-5 py-4">
          <div className="w-6 h-6 flex items-center justify-center flex-shrink-0"
            style={{ color: connected ? '#22c55e' : '#7c8799' }}
          >
            {intg.icon}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-medium text-bright">{intg.name}</span>
              {intg.comingSoon && (
                <span className="text-[10px] font-medium text-tertiary bg-l1 rounded-full px-2 py-0.5">
                  Coming soon
                </span>
              )}
              {!intg.comingSoon && connected && (
                <span className="badge text-[10px]" style={{ color: '#55C6E5', background: 'rgba(85,198,229,0.1)' }}>
                  Connected
                </span>
              )}
            </div>
            <p className="text-[12px] text-tertiary mt-0.5">
              {connected && displayName
                ? <span>Signed in as <span className="text-secondary">{displayName}</span></span>
                : intg.description}
            </p>
          </div>
        </div>
        {!intg.comingSoon && (
          <div className="px-5 pb-4">
            {connected ? (
              <div className="flex flex-col gap-3">
                {intg.id === 'linear' && (
                  <p className="text-[11px] text-tertiary">Add the "Pocket Eng" label to a Linear issue to trigger autopilot.</p>
                )}
                <button
                  onClick={() => handleDisconnectOAuth(intg)}
                  disabled={saving}
                  className="text-[12px] text-tertiary hover:text-danger transition-colors cursor-pointer"
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <button
                onClick={() => {
                  if (intg.id === 'linear') {
                    const state = prepareLinearOAuthState()
                    window.location.href = buildLinearAuthUrl(state)
                  }
                  if (intg.id === 'slack') {
                    const state = prepareSlackOAuthState()
                    window.location.href = buildSlackAuthUrl(state)
                  }
                }}
                className="btn btn-secondary btn-sm cursor-pointer flex items-center gap-2"
              >
                {intg.icon}
                Connect with {intg.name}
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  function renderFieldCard(intg: FieldIntegration) {
    const connected = isFieldConnected(intg)
    const isEditingThis = editing === intg.id

    return (
      <div key={intg.id} className="card-surface transition-all duration-200">
        <div className="flex items-center gap-3.5 px-5 py-4">
          <div className="w-6 h-6 flex items-center justify-center flex-shrink-0"
            style={{ color: connected ? '#22c55e' : '#7c8799' }}
          >
            {intg.icon}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-medium text-bright">{intg.name}</span>
              {connected && (
                <span className="badge text-[10px]" style={{ color: '#55C6E5', background: 'rgba(85,198,229,0.1)' }}>
                  Connected
                </span>
              )}
            </div>
            <p className="text-[12px] text-tertiary mt-0.5">{intg.description}</p>
          </div>
        </div>
        <div className="px-5 pb-4">
          {!isEditingThis ? (
            <div className="flex items-center gap-2">
              <button
                onClick={() => startEditing(intg)}
                className="text-[12px] text-tertiary hover:text-secondary transition-colors cursor-pointer"
              >
                {connected ? 'Edit' : '+ Connect'}
              </button>
              {connected && (
                <button
                  onClick={() => handleDisconnectField(intg)}
                  disabled={saving}
                  className="text-[12px] text-tertiary hover:text-danger transition-colors cursor-pointer"
                >
                  Disconnect
                </button>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3 animate-fade-in">
              {intg.fields.map(f => (
                <div key={f.key}>
                  <label className="text-[11px] text-tertiary mb-1 block">{f.label}</label>
                  <input
                    type={f.type}
                    value={drafts[f.key] ?? ''}
                    onChange={e => setDrafts(prev => ({ ...prev, [f.key]: e.target.value }))}
                    placeholder={f.placeholder}
                    className="input font-mono h-8 text-[12px]"
                    autoComplete="off"
                  />
                </div>
              ))}
              <div className="flex items-center gap-2 pt-1">
                <button onClick={() => handleSave(intg)} disabled={saving} className="btn btn-primary btn-sm cursor-pointer">
                  Save
                </button>
                <button onClick={() => setEditing(null)} className="btn btn-ghost btn-sm cursor-pointer">
                  Cancel
                </button>
                <a href={intg.helpLink} target="_blank" rel="noreferrer"
                  className="text-[11px] text-accent/50 hover:text-accent transition-colors ml-auto">
                  {intg.helpLabel} ↗
                </a>
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  /* ── SMS integration helpers ── */

  async function handleSmsSave() {
    if (!smsPhone.trim()) return
    setSmsSaving(true)
    setSmsError(null)
    try {
      await smsRegister({
        phoneNumber: smsPhone.trim(),
        defaultServerId: smsServerId || undefined,
      })
      // Store in user metadata for persistence
      await supabase.auth.updateUser({
        data: { smsPhoneNumber: smsPhone.trim(), smsDefaultServerId: smsServerId || null },
      })
      setSmsConnected(true)
      setSmsEditing(false)
    } catch (e: any) {
      setSmsError(e.message ?? 'Failed to register')
    } finally {
      setSmsSaving(false)
    }
  }

  async function handleSmsDisconnect() {
    setSmsSaving(true)
    try {
      await supabase.auth.updateUser({
        data: { smsPhoneNumber: null, smsDefaultServerId: null },
      })
      setSmsPhone('')
      setSmsServerId('')
      setSmsConnected(false)
      setSmsEditing(false)
    } finally {
      setSmsSaving(false)
    }
  }

  function renderPhoneCard() {
    return (
      <div className="card-surface transition-all duration-200">
        <div className="flex items-center gap-3.5 px-5 py-4">
          <div className="w-6 h-6 flex items-center justify-center flex-shrink-0"
            style={{ color: smsConnected ? '#22c55e' : '#7c8799' }}
          >
            {PHONE_ICON}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-medium text-bright">Phone</span>
              {smsConnected && (
                <span className="badge text-[10px]" style={{ color: '#55C6E5', background: 'rgba(85,198,229,0.1)' }}>
                  Connected
                </span>
              )}
            </div>
            <p className="text-[12px] text-tertiary mt-0.5">
              {smsConnected
                ? (
                  <>
                    Call <a
                      href={`tel:${VOICE_PHONE_NUMBER.replace(/[^+\d]/g, '')}`}
                      className="text-secondary hover:text-bright transition-colors"
                    >{VOICE_PHONE_NUMBER}</a> from <span className="text-secondary">{smsPhone}</span> to manage your workspaces by voice.
                  </>
                )
                : (
                  <>
                    Register your phone to call <span className="text-secondary">{VOICE_PHONE_NUMBER}</span> and talk to your cloud coding agents.
                  </>
                )}
            </p>
          </div>
        </div>
        <div className="px-5 pb-4">
          {!smsEditing ? (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setSmsEditing(true)}
                className="text-[12px] text-tertiary hover:text-secondary transition-colors cursor-pointer"
              >
                {smsConnected ? 'Edit' : '+ Connect'}
              </button>
              {smsConnected && (
                <button
                  onClick={handleSmsDisconnect}
                  disabled={smsSaving}
                  className="text-[12px] text-tertiary hover:text-danger transition-colors cursor-pointer"
                >
                  Disconnect
                </button>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3 animate-fade-in">
              <div>
                <label className="text-[11px] text-tertiary mb-1 block">Phone number (E.164)</label>
                <input
                  type="tel"
                  value={smsPhone}
                  onChange={e => setSmsPhone(e.target.value)}
                  placeholder="+447700900123"
                  className="input font-mono h-8 text-[12px]"
                  autoComplete="tel"
                />
              </div>
              <div>
                <label className="text-[11px] text-tertiary mb-1 block">Default workspace</label>
                <select
                  value={smsServerId}
                  onChange={e => setSmsServerId(e.target.value)}
                  className="input h-8 text-[12px]"
                >
                  <option value="">Auto (first available)</option>
                  {servers.map(s => (
                    <option key={s.serverId} value={s.serverId}>
                      {s.label || s.publicIp || s.serverId.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </div>
              {smsError && (
                <p className="text-[11px] text-danger">{smsError}</p>
              )}
              <div className="flex items-center gap-2 pt-1">
                <button onClick={handleSmsSave} disabled={smsSaving || !smsPhone.trim()} className="btn btn-primary btn-sm cursor-pointer">
                  {smsSaving ? 'Saving...' : 'Save'}
                </button>
                <button onClick={() => { setSmsEditing(false); setSmsError(null) }} className="btn btn-ghost btn-sm cursor-pointer">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="px-5 py-4 md:px-8 md:py-8 max-w-xl animate-fade-in">
      <div className="mb-6 md:mb-8">
        <h1 className="hidden md:block text-[16px] font-semibold text-bright tracking-tight">Integrations</h1>
        <p className="text-[12px] text-tertiary md:mt-1">Connect services to your workspaces. Credentials are injected at launch.</p>
      </div>

      <div className="flex flex-col gap-4 stagger">
        {INTEGRATIONS.map(intg =>
          intg.oauth ? renderOAuthCard(intg) : renderFieldCard(intg)
        )}
        {/* Phone/voice card. Registers the caller's number in
            pe-sms-mappings-prod (shared allowlist with the old SMS path).
            Voice tool-call webhooks in VoiceToolsFunction look up the
            caller's number in that table to identify the user — no PIN,
            just caller-ID. */}
        {renderPhoneCard()}
      </div>
    </div>
  )
}
