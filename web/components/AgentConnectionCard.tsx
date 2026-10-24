'use client'

/**
 * Single source of truth for the "connect a coding agent" UX — used in the
 * onboarding flow and on /dashboard/agents.
 *
 * Clicking Connect opens an inline choice panel. Up to three options appear:
 *   1. "Use detected local sign-in" — shown when the desktop bridge found
 *      an extractable credential in the user's macOS keychain / local files.
 *      One-click import, no browser flow.
 *   2. "Sign in with your <Agent> subscription" — browser OAuth, run in
 *      Electron main (residential IP so Anthropic's Cloudflare block on
 *      Lambda IPs doesn't apply).
 *   3. "Use an API key" — universal paste fallback. Billing copy differs
 *      per agent: Claude/Codex API keys bill the provider console, Cursor's
 *      User API key bills from the user's Pro/Team plan (same credit pool
 *      as the IDE) — see AgentDef.apiKeyBillsFromSubscription.
 *
 * State is derived on mount from:
 *   - Desktop bridge (if present): `detectAgents()` → installed / hasCreds / identifier
 *   - Server:                     `listAgentCredentials()` → already-saved state
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  deleteAgentCredential,
  listAgentCredentials,
  saveAgentCredential,
  type AgentCredentialId,
  type AgentCredentialSummary,
} from '@/lib/api'
import {
  isDesktop,
  isDesktopMac,
  type DesktopAgentId,
  type DesktopAgentDetection,
} from '@/lib/native'

interface AgentDef {
  id: AgentCredentialId
  name: string
  vendor: string
  logo: string
  color: string
  /** Where the user gets a manual API key if they want the paste path. */
  apiKeyUrl: string
  apiKeyUrlLabel: string
  /** Install command for when the CLI isn't present. */
  installCmd: string
  /** Prefix(es) expected for raw API keys (best-effort validation only). */
  apiKeyPrefix?: string | string[]
  apiKeyPlaceholder: string
  /**
   * True when the API key pasted in the API-key path is vendor-issued and
   * bills from the user's subscription plan (same credit pool as the IDE) —
   * not a pay-per-token provider key. Cursor's API key from
   * cursor.com/dashboard/integrations is the canonical example: it
   * authenticates as the user's Cursor account and draws from their
   * Pro/Team plan credits, verified against docs.cursor.com/api and
   * confirmed by Cursor staff on forum.cursor.com. Claude/Codex API keys
   * are the opposite: pasting them bills the provider's console, not the
   * user's Max/ChatGPT subscription. The UI uses this flag to pick the
   * right copy for the "Use an API key" option so users know what they're
   * signing up for.
   */
  apiKeyBillsFromSubscription?: boolean
}

const DEFS: AgentDef[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    vendor: 'Anthropic',
    logo: '/logos/claude.png',
    color: '#D97757',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    apiKeyUrlLabel: 'console.anthropic.com',
    installCmd: 'npm install -g @anthropic-ai/claude-code',
    apiKeyPrefix: 'sk-ant-',
    apiKeyPlaceholder: 'sk-ant-api03-…',
  },
  {
    id: 'codex',
    name: 'Codex',
    vendor: 'OpenAI',
    logo: '/logos/openai.svg',
    color: '#10A37F',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    apiKeyUrlLabel: 'platform.openai.com',
    installCmd: 'npm install -g @openai/codex',
    apiKeyPrefix: 'sk-',
    apiKeyPlaceholder: 'sk-…',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    vendor: 'Anysphere',
    logo: '/logos/cursor.svg',
    color: '#00A3FF',
    // Link goes to the dashboard page where the user clicks "Create API
    // key". NOT /integrations (that page is for *provider* keys that
    // bypass Cursor's billing — the opposite of what we want).
    apiKeyUrl: 'https://cursor.com/dashboard/integrations',
    apiKeyUrlLabel: 'cursor.com/dashboard',
    installCmd: 'curl https://cursor.com/install -fsS | bash',
    // Cursor rotated their User API key prefix from `key_` to `crsr_`. The
    // prefix check is best-effort — the backend doesn't enforce it — but the
    // paste field rejected valid new-format keys with "should start with key_"
    // before this. Match what ProvisionForm already validates for.
    apiKeyPrefix: 'crsr_',
    apiKeyPlaceholder: 'crsr_…',
    // Cursor User API keys bill from the user's Pro/Team plan credits
    // (same pool as the IDE). See apiKeyBillsFromSubscription below.
    apiKeyBillsFromSubscription: true,
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    vendor: 'OpenCode',
    logo: '/logos/opencode.png',
    color: '#FF6B35',
    // OpenCode Zen is a multi-provider client. Its sign-in page lets the
    // user create a key for OpenCode Zen specifically (their own paid
    // backend), which is what we wire up here. Connecting Anthropic /
    // OpenAI / Cursor THROUGH opencode is already covered by those agents'
    // own cards — opencode reads them from the same workspace creds.
    apiKeyUrl: 'https://opencode.ai/auth',
    apiKeyUrlLabel: 'opencode.ai/auth',
    installCmd: 'npm install -g opencode-ai',
    // OpenCode Zen keys share the OpenAI prefix (`sk-`) but aren't OpenAI
    // keys — they bill from the OpenCode Zen prepaid balance, not OpenAI.
    apiKeyPrefix: 'sk-',
    apiKeyPlaceholder: 'sk-…',
    // OpenCode Zen is pay-per-token from a prepaid balance, not a flat
    // subscription. Keep apiKeyBillsFromSubscription false (default) so
    // the UI shows "Pay per token from opencode.ai/auth" disclosure.
  },
]

export function AgentConnectionList({
  compact = false,
  onConnectedChange,
}: {
  compact?: boolean
  onConnectedChange?: (count: number) => void
}) {
  const webOnly = typeof window !== 'undefined' && !isDesktop
  const [detections, setDetections] = useState<Partial<Record<DesktopAgentId, DesktopAgentDetection>>>({})
  const [saved, setSaved] = useState<Record<AgentCredentialId, AgentCredentialSummary | undefined>>({} as Record<AgentCredentialId, AgentCredentialSummary | undefined>)
  const [scanning, setScanning] = useState(false)
  const [refreshTick, setRefreshTick] = useState(0)

  const refreshSaved = useCallback(async () => {
    try {
      const { credentials } = await listAgentCredentials()
      const next = {} as Record<AgentCredentialId, AgentCredentialSummary | undefined>
      for (const c of credentials) next[c.agent] = c
      setSaved(next)
      onConnectedChange?.(credentials.length)
    } catch { /* silent — empty state is fine */ }
  }, [onConnectedChange])

  // Load saved credentials from the backend
  useEffect(() => { void refreshSaved() }, [refreshSaved, refreshTick])

  // Scan local machine for credentials (macOS desktop only). Windows desktop
  // v1 supports subscription OAuth and API keys, but not local credential import.
  useEffect(() => {
    if (!isDesktopMac || !window.pocketengDesktop) return
    let cancelled = false
    setScanning(true)
    window.pocketengDesktop.detectAgents().then(res => {
      if (!cancelled && res.ok && res.agents) setDetections(res.agents)
    }).finally(() => {
      if (!cancelled) setScanning(false)
    })
    return () => { cancelled = true }
  }, [refreshTick])

  return (
    <div className="flex flex-col gap-2">
      {scanning && (
        <div className="flex items-center gap-2 text-[11px] text-tertiary px-1 animate-fade-in">
          <span className="w-3 h-3 border-2 border-line border-t-secondary rounded-full animate-spin" />
          Scanning
        </div>
      )}
      {DEFS.map(def => (
        <AgentConnectionCard
          key={def.id}
          def={def}
          detection={detections[def.id as DesktopAgentId]}
          saved={saved[def.id]}
          compact={compact}
          onChange={() => setRefreshTick(t => t + 1)}
        />
      ))}
    </div>
  )
}

function AgentConnectionCard({
  def,
  detection,
  saved,
  compact,
  onChange,
}: {
  def: AgentDef
  detection?: DesktopAgentDetection
  saved?: AgentCredentialSummary
  compact: boolean
  onChange: () => void
}) {
  const [busy, setBusy] = useState<'use' | 'paste' | 'subscribe' | 'remove' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandPaste, setExpandPaste] = useState(false)
  const [pasteValue, setPasteValue] = useState('')
  // Expands the inline choice panel ("Sign in with subscription" vs "Use an
  // API key" vs "Use detected local sign-in"). Click Connect → choose one.
  const [expandChoice, setExpandChoice] = useState(false)
  // When a subscription flow is in progress, this holds the active OAuth
  // session (Electron sessionId + authorize URL). Null otherwise. Rendering
  // this transitions the panel from "pick method" → "paste the code".
  const [oauthSession, setOauthSession] = useState<{ sessionId: string; url: string } | null>(null)
  const [oauthCode, setOauthCode] = useState('')

  const connected = !!saved
  // A local sign-in was detected AND we can extract it to the cloud with one click.
  const localExtractable = isDesktopMac && detection?.installed && detection.hasCredentials && detection.extractable
  // Signed in locally but credentials are sealed (e.g. Cursor's app-encrypted store).
  const localSealed = isDesktopMac && detection?.installed && detection.hasCredentials && !detection.extractable
  const localInstalledNoCreds = isDesktopMac && detection?.installed && !detection.hasCredentials
  const localNotInstalled = isDesktopMac && detection && !detection.installed

  async function importFromLocalFile(source: 'file' | 'keychain' = 'file') {
    if (!isDesktopMac || !window.pocketengDesktop) return
    setBusy('use')
    setError(null)
    try {
      const read = await window.pocketengDesktop.readAgentCredentials(def.id as DesktopAgentId)
      if (!read.ok || !read.contents) throw new Error(read.error ?? 'No readable credentials')
      await saveAgentCredential({
        agent: def.id,
        contents: read.contents,
        source,
        identifier: detection?.identifier,
      })
      onChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setBusy(null)
    }
  }

  async function handlePasteKey() {
    const value = pasteValue.trim()
    if (!value) return
    if (def.apiKeyPrefix) {
      const prefixes = Array.isArray(def.apiKeyPrefix) ? def.apiKeyPrefix : [def.apiKeyPrefix]
      if (!prefixes.some(p => value.startsWith(p))) {
        setError(`Key should start with ${prefixes.join(' or ')}`)
        return
      }
    }
    setBusy('paste')
    setError(null)
    try {
      await saveAgentCredential({
        agent: def.id,
        apiKey: value,
        identifier: maskKey(value),
      })
      setPasteValue('')
      setExpandPaste(false)
      onChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save key')
    } finally {
      setBusy(null)
    }
  }

  async function handleDisconnect() {
    setBusy('remove')
    setError(null)
    try {
      await deleteAgentCredential(def.id)
      onChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect')
    } finally {
      setBusy(null)
    }
  }

  // The best available method for THIS runtime + detection state. The UI
  // surfaces one button that silently picks this; the user never chooses.
  //
  //   'subscribe' — browser OAuth into the user's real subscription, run
  //                 on their EC2 via agent_login.py. Default when we have
  //                 a serverId; works on any platform, no desktop needed.
  //   'use'       — we have an extractable local sign-in (desktop only),
  //                 one-click import from the user's keychain/file.
  //   'signin'    — spawn the CLI's OAuth on the desktop app, then prompt
  //                 "I've signed in". Legacy path kept for desktop users
  //                 without a serverId context (rare).
  //   'paste'     — paste-key input. Fallback for API-key users.
  // One-line status shown under the agent name. Kept short and literal.
  const statusLine = useMemo<React.ReactNode>(() => {
    if (connected) {
      return (
        <span>
          <span className="text-accent">● Connected</span>
          {saved?.identifier && <span className="text-tertiary"> · {saved.identifier}</span>}
        </span>
      )
    }
    if (busy === 'use' || busy === 'paste' || busy === 'subscribe') {
      return <span className="text-tertiary">Connecting…</span>
    }
    if (localExtractable) {
      return <span className="text-tertiary">Local sign-in detected{detection?.identifier ? ` · ${detection.identifier}` : ''}</span>
    }
    if (localSealed) {
      return <span className="text-tertiary">Signed in locally{detection?.identifier ? ` · ${detection.identifier}` : ''}</span>
    }
    if (localInstalledNoCreds) return <span className="text-tertiary">Ready to sign in</span>
    if (localNotInstalled) return <span className="text-tertiary">Not installed</span>
    return <span className="text-tertiary">Not connected</span>
  }, [connected, saved?.identifier, busy, localExtractable, localSealed, localInstalledNoCreds, localNotInstalled, detection?.identifier])

  async function handleConnect() {
    // Open the inline choice panel. The user picks: subscription (browser
    // OAuth), API key (paste), or "use the local sign-in we detected".
    // We don't pre-pick for them anymore — both paths exist legitimately
    // (API-key users bill per-token; subscription users use their plan)
    // and it was confusing to silently auto-pick keychain for people who
    // actually wanted to connect a Max subscription.
    setError(null)
    setExpandChoice(true)
  }

  /** Does this agent's subscription OAuth flow require the user to paste
   * a code back (Anthropic pattern), or does it resolve via a localhost
   * callback (Codex pattern)? Drives which in-progress UI we render. */
  const isPasteCodeFlow = def.id === 'claude'
  const isLocalhostCallbackFlow = def.id === 'codex'

  /** Subscription path for Claude. Drives the OAuth flow through Electron
   * main (residential IP, bypasses Cloudflare on Lambda). See
   * desktop/src/main/anthropic-oauth.ts for the PKCE + token exchange. */
  async function handleSubscribeClaude() {
    if (!isDesktop || !window.pocketengDesktop?.startAnthropicOAuth) {
      setError('Subscription login requires the desktop app.')
      return
    }
    setBusy('subscribe')
    setError(null)
    try {
      const { sessionId, url } = await window.pocketengDesktop.startAnthropicOAuth()
      // Stash the session so the rendered panel switches to paste-code mode.
      setOauthSession({ sessionId, url })
      // Open Anthropic's OAuth URL in the user's system browser. Electron
      // main's `openExternal` hands it to the OS default browser — the
      // user logs in with their Max plan, Anthropic shows a code on the
      // callback page, user pastes it back into our input below.
      void window.pocketengDesktop.openExternal(url)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start subscription login')
    } finally {
      setBusy(null)
    }
  }

  /** Finish the subscription flow: user has pasted the `code#state` string
   * from Anthropic's callback page. Electron main exchanges it for an
   * OAuth bundle and we upload the bundle to our backend verbatim. */
  async function handleSubmitSubscriptionCode() {
    if (!oauthSession || !window.pocketengDesktop?.completeAnthropicOAuth) return
    const code = oauthCode.trim()
    if (!code) return
    setBusy('subscribe')
    setError(null)
    try {
      const bundle = await window.pocketengDesktop.completeAnthropicOAuth(
        oauthSession.sessionId,
        code,
      )
      // Upload the OAuth bundle to the backend as the credential blob.
      // agent_credentials_sync.py already detects the `claudeAiOauth`
      // shape and SFTPs it verbatim to ~/.claude/.credentials.json on
      // the EC2 at session launch.
      await saveAgentCredential({
        agent: def.id,
        contents: JSON.stringify(bundle),
        source: 'browser-oauth',
        identifier: `${def.name} subscription`,
      })
      setOauthSession(null)
      setOauthCode('')
      setExpandChoice(false)
      onChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Subscription login failed')
    } finally {
      setBusy(null)
    }
  }

  function handleCancelSubscription() {
    if (oauthSession) {
      // Dispatch to the right cancel IPC based on which flow this agent uses.
      if (def.id === 'claude' && window.pocketengDesktop?.cancelAnthropicOAuth) {
        void window.pocketengDesktop.cancelAnthropicOAuth(oauthSession.sessionId)
      } else if (def.id === 'codex' && window.pocketengDesktop?.cancelOpenAIOAuth) {
        void window.pocketengDesktop.cancelOpenAIOAuth(oauthSession.sessionId)
      } else if (def.id === 'cursor' && window.pocketengDesktop?.cancelCursorOAuth) {
        void window.pocketengDesktop.cancelCursorOAuth(oauthSession.sessionId)
      }
    }
    setOauthSession(null)
    setOauthCode('')
    setError(null)
    setBusy(null)
  }

  /** Subscription path for Cursor. Cursor doesn't publish a public OAuth
   * client_id, so the flow uses Cursor's own polling endpoint
   * (api2.cursor.sh/auth/poll) — same shape as `cursor-agent login`.
   * No paste step, no localhost callback. Start → open URL → await
   * bundle. Bundle gets uploaded verbatim and the backend writes it to
   * ~/.config/cursor/auth.json on the EC2 (mode 0600).
   *
   * The cursor-agent install script runs on every workspace via
   * userdata.py; provided that's true, this credential gets picked up
   * by `cursor-agent` automatically on the next session launch. */
  async function handleSubscribeCursor() {
    if (
      !isDesktop
      || !window.pocketengDesktop?.startCursorOAuth
      || !window.pocketengDesktop?.awaitCursorOAuth
    ) {
      setError('Cursor subscription login requires the desktop app.')
      return
    }
    setBusy('subscribe')
    setError(null)
    let sessionId: string | null = null
    try {
      const result = await window.pocketengDesktop.startCursorOAuth()
      sessionId = result.sessionId
      setOauthSession(result)
      // Open the cursor.com login URL in the system browser. Same fire-
      // and-forget pattern as the other subscription flows.
      void window.pocketengDesktop.openExternal(result.url)
      // Long-running IPC — resolves when api2.cursor.sh/auth/poll returns
      // the token bundle. Up to ~25 minutes; rejects on cancel or repeated
      // network errors.
      const bundle = await window.pocketengDesktop.awaitCursorOAuth(result.sessionId)
      await saveAgentCredential({
        agent: def.id,
        contents: JSON.stringify(bundle),
        source: 'browser-oauth',
        identifier: `${def.name} subscription`,
      })
      setOauthSession(null)
      setExpandChoice(false)
      onChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cursor sign-in failed')
      if (sessionId && window.pocketengDesktop?.cancelCursorOAuth) {
        void window.pocketengDesktop.cancelCursorOAuth(sessionId)
      }
      setOauthSession(null)
    } finally {
      setBusy(null)
    }
  }

  /** Subscription path for Codex / ChatGPT. Unlike Claude's paste-code flow,
   * this one completes via a localhost HTTP callback captured by Electron
   * main (see desktop/src/main/openai-oauth.ts). No paste step — start the
   * flow, open the URL, then await the bundle. */
  async function handleSubscribeCodex() {
    if (
      !isDesktop
      || !window.pocketengDesktop?.startOpenAIOAuth
      || !window.pocketengDesktop?.awaitOpenAIOAuth
    ) {
      setError('Codex subscription login requires the desktop app.')
      return
    }
    setBusy('subscribe')
    setError(null)
    let sessionId: string | null = null
    try {
      const result = await window.pocketengDesktop.startOpenAIOAuth()
      sessionId = result.sessionId
      setOauthSession(result)
      // Open the OAuth URL in the system browser. OpenAI will redirect back
      // to http://localhost:1455/auth/callback which Electron main catches.
      // `openExternal` returns Promise<void> — explicit `void` marks the
      // fire-and-forget intent and matches the no-floating-promises pattern
      // used elsewhere in this file.
      void window.pocketengDesktop.openExternal(result.url)
      // Long-running IPC — resolves when OpenAI redirects back + main
      // finishes token exchange. Rejects on timeout / cancel / auth error.
      const bundle = await window.pocketengDesktop.awaitOpenAIOAuth(result.sessionId)
      // Upload the bundle verbatim — backend's agent_credentials_sync.py
      // detects the `tokens` shape and SFTPs it to ~/.codex/auth.json on
      // the EC2 at session launch.
      await saveAgentCredential({
        agent: def.id,
        contents: JSON.stringify(bundle),
        source: 'browser-oauth',
        identifier: `${def.name} subscription`,
      })
      setOauthSession(null)
      setExpandChoice(false)
      onChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Codex sign-in failed')
      // Session on main is already cleaned up on its own error paths; this
      // is defensive cleanup if the error happened before the callback.
      if (sessionId && window.pocketengDesktop?.cancelOpenAIOAuth) {
        void window.pocketengDesktop.cancelOpenAIOAuth(sessionId)
      }
      setOauthSession(null)
    } finally {
      setBusy(null)
    }
  }


  return (
    <div className="rounded-xl border border-line bg-transparent transition-colors duration-150 hover:border-line2">
      <div className="flex items-center gap-3.5 px-4 py-3.5">
        <span
          className="flex items-center justify-center flex-shrink-0 rounded-lg bg-l1 border border-line"
          style={{ width: 36, height: 36 }}
        >
          <img
            src={def.logo}
            alt=""
            className="w-[18px] h-[18px] object-contain"
            draggable={false}
          />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[13.5px] font-medium text-bright tracking-tight">{def.name}</div>
          <div className="mt-0.5 truncate text-[11.5px]">
            {statusLine}
          </div>
        </div>
        {/* ONE button. Label changes based on state; we handle method-picking. */}
        <div className="flex-shrink-0">
          {connected ? (
            <button
              onClick={handleDisconnect}
              disabled={busy === 'remove'}
              className="h-8 px-3 rounded-md text-[12px] font-medium text-tertiary hover:text-bright transition-colors cursor-pointer disabled:opacity-60"
            >
              {busy === 'remove' ? 'Removing' : 'Disconnect'}
            </button>
          ) : (
            <button
              onClick={handleConnect}
              disabled={!!busy || expandPaste || expandChoice}
              className="h-8 px-3.5 rounded-md text-[12px] font-medium text-ink bg-bright cursor-pointer transition-opacity duration-150 hover:opacity-90 active:opacity-80 disabled:opacity-40"
            >
              {busy ? 'Connecting' : 'Connect'}
            </button>
          )}
        </div>
      </div>

      {/* Inline choice panel — replaces the old silent method picker. User
          sees the options explicitly:
            1. "Use detected local sign-in" (only if agent-detection found one)
            2. "Sign in with <Agent> subscription" (opens browser OAuth via
               Electron main on the user's desktop)
            3. "Use an API key" (paste box; universal fallback)
          If the user already started subscription OAuth (oauthSession set),
          this panel morphs into the code-paste step instead. */}
      {!connected && expandChoice && !expandPaste && !oauthSession && (
        <div className="px-4 pb-3.5 pt-0 border-t border-line/60 animate-fade-in">
          <p className="text-[11px] text-tertiary mt-3 mb-2">How would you like to sign in?</p>

          {/* Option 1: already-detected local sign-in (desktop only). */}
          {localExtractable && (
            <button
              onClick={() => { setExpandChoice(false); void importFromLocalFile('file') }}
              disabled={!!busy}
              className="w-full text-left rounded-lg border border-line px-3 py-2.5 mb-2 transition-colors hover:bg-l1 cursor-pointer disabled:opacity-50"
            >
              <div className="text-[12.5px] font-medium text-bright">Use detected local sign-in</div>
              <div className="text-[11px] text-tertiary mt-0.5">
                {detection?.identifier ?? 'From your macOS keychain'}
              </div>
            </button>
          )}

          {/* Option 2: subscription OAuth — desktop-only because each flow
              relies on Electron main running locally (PKCE + redirect or
              poll). Three different flows under the hood:
                claude — paste-code (anthropic-oauth.ts)
                codex  — localhost callback (openai-oauth.ts)
                cursor — server poll (cursor-oauth.ts)
              All three result in the same outcome: credentials uploaded to
              the backend and synced to the EC2 at session launch. */}
          {(def.id === 'claude' || def.id === 'codex' || def.id === 'cursor') && isDesktop && (
            <button
              onClick={
                def.id === 'claude' ? handleSubscribeClaude
                  : def.id === 'codex' ? handleSubscribeCodex
                  : handleSubscribeCursor
              }
              disabled={!!busy}
              className="w-full text-left rounded-lg border border-line px-3 py-2.5 mb-2 transition-colors hover:bg-l1 cursor-pointer disabled:opacity-50"
            >
              <div className="text-[12.5px] font-medium text-bright">
                Sign in with your {def.name} subscription
              </div>
              <div className="text-[11px] text-tertiary mt-0.5">
                {def.id === 'claude'
                  ? 'Uses your Max plan — no API tokens billed'
                  : def.id === 'codex'
                  ? 'Uses your ChatGPT Plus / Pro / Business plan — no API tokens billed'
                  : 'Uses your Pro / Team plan — same credits as the IDE, no API tokens billed'}
              </div>
            </button>
          )}

          {/* Option 3: API key — universal fallback, always shown.
              Billing disclosure depends on the agent: Cursor's API key
              uses the same subscription credit pool as the IDE; Claude/
              Codex API keys bill the provider's console directly. */}
          <button
            onClick={() => { setExpandPaste(true) }}
            disabled={!!busy}
            className="w-full text-left rounded-lg border border-line px-3 py-2.5 transition-colors hover:bg-l1 cursor-pointer disabled:opacity-50"
          >
            <div className="text-[12.5px] font-medium text-bright">Use an API key</div>
            <div className="text-[11px] text-tertiary mt-0.5">
              {def.apiKeyBillsFromSubscription
                ? `Uses your ${def.name} plan — same credits as the IDE`
                : `Pay per token from ${def.apiKeyUrlLabel}`}
            </div>
          </button>

          <div className="flex justify-end mt-3">
            <button
              onClick={() => { setExpandChoice(false); setError(null) }}
              className="text-[11px] text-tertiary hover:text-secondary cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Subscription OAuth step 2 — paste the code. Only renders for
          agents whose OAuth flow returns the code on a user-visible page
          (Anthropic). Codex uses a localhost-callback flow — the UI below
          renders instead for that. */}
      {!connected && oauthSession && isPasteCodeFlow && (
        <div className="px-4 pb-3.5 pt-0 border-t border-line/60 animate-fade-in">
          <p className="text-[11px] text-tertiary mt-3">
            Sign in in your browser, then paste the code Anthropic shows you.
          </p>
          <div className="flex items-center gap-2 mt-2">
            <input
              autoFocus
              value={oauthCode}
              onChange={e => setOauthCode(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void handleSubmitSubscriptionCode() }}
              placeholder="Paste code#state from Anthropic"
              className="flex-1 input text-[12.5px] h-9 font-mono"
              spellCheck={false}
              autoComplete="off"
            />
            <button
              onClick={handleCancelSubscription}
              className="h-9 px-3 rounded-lg text-[11.5px] font-medium text-tertiary hover:text-secondary hover:bg-[var(--hover-bg)] transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmitSubscriptionCode}
              disabled={!oauthCode.trim() || busy === 'subscribe'}
              className="h-9 px-3.5 rounded-lg text-[11.5px] font-semibold text-white bg-accent hover:bg-accent/90 transition-colors cursor-pointer disabled:opacity-30"
            >
              {busy === 'subscribe' ? 'Signing in…' : 'Submit'}
            </button>
          </div>
          <p className="text-[10.5px] text-tertiary mt-2">
            Didn't open?{' '}
            <button
              onClick={() => void window.pocketengDesktop?.openExternal(oauthSession.url)}
              className="text-accent hover:underline cursor-pointer"
            >
              Open the {def.name} login link again
            </button>
          </p>
        </div>
      )}

      {/* Subscription OAuth — Codex localhost-callback flow. No paste
          step: OpenAI redirects to http://localhost:1455/auth/callback
          which Electron main catches. UI just shows "waiting in browser"
          with a way to re-open the link and cancel. */}
      {!connected && oauthSession && isLocalhostCallbackFlow && (
        <div className="px-4 pb-3.5 pt-0 border-t border-line/60 animate-fade-in">
          <div className="flex items-center gap-2.5 mt-3">
            <span className="w-3.5 h-3.5 border-2 border-line border-t-secondary rounded-full animate-spin flex-shrink-0" />
            <p className="text-[11.5px] text-tertiary">
              Finish signing in in your browser. We'll pick it up automatically.
            </p>
          </div>
          <div className="flex items-center gap-2 mt-3">
            <button
              onClick={() => void window.pocketengDesktop?.openExternal(oauthSession.url)}
              className="h-8 px-3 rounded-lg text-[11.5px] font-medium bg-l1 border border-line text-bright hover:border-line2 transition-colors cursor-pointer"
            >
              Re-open browser
            </button>
            <button
              onClick={handleCancelSubscription}
              className="h-8 px-3 rounded-lg text-[11.5px] font-medium text-tertiary hover:text-secondary hover:bg-[var(--hover-bg)] transition-colors cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Paste-key panel — expanded from the choice above. */}
      {!connected && expandPaste && (
        <div className="px-4 pb-3.5 pt-0 border-t border-line/60 animate-fade-in">
          <div className="flex items-center gap-2 mt-3">
            <input
              type="password"
              autoFocus
              value={pasteValue}
              onChange={e => setPasteValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void handlePasteKey() }}
              placeholder={`Paste your ${def.name} API key — ${def.apiKeyPlaceholder}`}
              className="flex-1 input text-[12.5px] h-9 font-mono"
              spellCheck={false}
              autoComplete="off"
            />
            <button
              onClick={() => { setExpandPaste(false); setPasteValue(''); setError(null) }}
              className="h-9 px-3 rounded-lg text-[11.5px] font-medium text-tertiary hover:text-secondary hover:bg-[var(--hover-bg)] transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handlePasteKey}
              disabled={!pasteValue.trim() || busy === 'paste'}
              className="h-9 px-3.5 rounded-lg text-[11.5px] font-semibold text-white bg-accent hover:bg-accent/90 transition-colors cursor-pointer disabled:opacity-30"
            >
              {busy === 'paste' ? 'Saving…' : 'Save'}
            </button>
          </div>
          <p className="text-[10.5px] text-tertiary mt-2">
            Get one at{' '}
            <a href={def.apiKeyUrl} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
              {def.apiKeyUrlLabel}
            </a>
            {localNotInstalled && isDesktopMac && (
              <> · or install the CLI: <code className="font-mono bg-l1 px-1 py-0.5 rounded text-secondary">{def.installCmd}</code></>
            )}
          </p>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="px-4 pb-3 text-[11px] text-danger animate-fade-in">
          {error}
        </div>
      )}
    </div>
  )
}

function maskKey(key: string): string {
  const trimmed = key.trim()
  if (trimmed.length < 10) return '••••••••'
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`
}
