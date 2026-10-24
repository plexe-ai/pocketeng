/**
 * Anthropic OAuth (Claude subscription login) driven from the Electron main
 * process on the user's desktop machine.
 *
 * Why main (not the renderer, not our backend Lambda):
 *   - The token exchange POST to console.anthropic.com/v1/oauth/token is
 *     blocked by Cloudflare when originating from AWS Lambda IP ranges
 *     (error 1010). From the user's desktop machine the same request works
 *     because the egress IP is residential. Superset uses the same pattern
 *     (packages/chat/src/server/desktop/auth/anthropic/oauth.ts).
 *   - Keeping the PKCE verifier in the renderer would expose it via the
 *     contextBridge boundary where any web-surface-origin script could
 *     read it. Main process memory is isolated.
 *
 * Flow:
 *   renderer → startAnthropicOAuth()  → main: generates PKCE + state,
 *                                        caches verifier keyed by sessionId,
 *                                        returns { sessionId, url }
 *   user opens URL in system browser, logs in, copies `code#state` code
 *   from the Anthropic callback page, pastes it back into the UI
 *   renderer → completeAnthropicOAuth(sessionId, pastedCode) → main: POSTs
 *                                        to /v1/oauth/token, returns an
 *                                        OAuth bundle shaped exactly like
 *                                        Claude Code's local on-disk file.
 *
 * The caller uploads the returned bundle to our backend's existing
 * /account/agent-credentials endpoint (same place API-key pastes go).
 * agent_credentials_sync.py on the server side already detects the
 * `claudeAiOauth` shape and SFTPs it verbatim to EC2 at session launch.
 */

import { createHash, randomBytes } from 'node:crypto'
import { ipcMain } from 'electron'

// Public Anthropic OAuth constants — same values Claude Code's CLI uses.
// client_id is published so any third-party integrator can implement this
// flow. Do NOT substitute your own client_id — Anthropic validates it.
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'
const REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback'
const SCOPES = 'org:create_api_key user:profile user:inference'

// PKCE + state sit in main process memory between /start and /complete.
// A user who takes longer than 15 minutes to finish the browser flow must
// start over; that's shorter than Anthropic's own code expiry and keeps
// zombie sessions from accumulating if users close the dialog mid-flow.
const SESSION_TTL_MS = 15 * 60 * 1000
interface Session { verifier: string; state: string; createdAt: number }
const sessions = new Map<string, Session>()

function base64url(buf: Buffer): string {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function pruneExpired(): void {
  const now = Date.now()
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(id)
  }
}

export interface StartResult { sessionId: string; url: string }
export interface OAuthBundle {
  claudeAiOauth: {
    accessToken: string
    refreshToken: string
    expiresAt: number          // epoch ms
    scopes: string[]
    subscriptionType: string
  }
}

function startFlow(): StartResult {
  pruneExpired()
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  const state = base64url(randomBytes(32))
  const sessionId = base64url(randomBytes(16))
  sessions.set(sessionId, { verifier, state, createdAt: Date.now() })

  const params = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  })
  return { sessionId, url: `${AUTHORIZE_URL}?${params.toString()}` }
}

/**
 * Parse either `code#state` (what Anthropic's callback page displays) or
 * a full callback URL the user might have copy-pasted from their address
 * bar. Returns [code, state] or throws.
 */
function parseCode(raw: string): { code: string; state: string } {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('Empty code')

  // Full URL form: https://console.anthropic.com/oauth/code/callback?code=...&state=...
  if (trimmed.startsWith('http')) {
    try {
      const u = new URL(trimmed)
      const code = (u.searchParams.get('code') ?? '').trim()
      const state = (u.searchParams.get('state') ?? '').trim()
      if (!code || !state) throw new Error('URL missing code/state')
      return { code, state }
    } catch {
      throw new Error('Could not parse URL. Paste code#state instead.')
    }
  }

  // Hash-separated form: `<code>#<state>`
  const hashIdx = trimmed.indexOf('#')
  if (hashIdx < 0) {
    throw new Error(
      'Paste the full code from Anthropic\'s page — it should contain a # separator.',
    )
  }
  const code = trimmed.slice(0, hashIdx).trim()
  const state = trimmed.slice(hashIdx + 1).trim()
  if (!code || !state) throw new Error('Code or state missing')
  return { code, state }
}

async function completeFlow(sessionId: string, rawCode: string): Promise<OAuthBundle> {
  pruneExpired()
  const session = sessions.get(sessionId)
  if (!session) throw new Error('Login session expired or not found. Start again.')

  const { code, state } = parseCode(rawCode)
  if (state !== session.state) {
    throw new Error(
      'State mismatch. This can happen if you clicked Connect twice — close the dialog and start again.',
    )
  }

  // The actual POST happens from THIS machine's network stack (residential
  // IP) so Cloudflare does not apply the 1010 block it applies to Lambdas.
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      state,
      redirect_uri: REDIRECT_URI,
      code_verifier: session.verifier,
    }),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Anthropic token exchange failed (${resp.status}): ${text.slice(0, 300)}`)
  }
  const data = await resp.json() as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    subscriptionType?: string
  }
  if (
    typeof data.access_token !== 'string' ||
    typeof data.refresh_token !== 'string' ||
    typeof data.expires_in !== 'number'
  ) {
    throw new Error('Anthropic returned a malformed token response.')
  }

  // One-shot: consume the session on success so a second submit can't
  // double-exchange (Anthropic would reject anyway, but defense in depth).
  sessions.delete(sessionId)

  return {
    claudeAiOauth: {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      // ms epoch — matches what Claude Code writes to
      // ~/.claude/.credentials.json on a native install.
      expiresAt: Date.now() + data.expires_in * 1000,
      scopes: SCOPES.split(' '),
      subscriptionType: data.subscriptionType ?? 'max',
    },
  }
}

/** Cancel an in-flight session (user closed the dialog). Main also prunes
 *  on TTL so this is nice-to-have, not required. */
function cancelFlow(sessionId: string): void {
  sessions.delete(sessionId)
}

/**
 * Register IPC handlers. Call once at app startup.
 *
 * Renderer-facing API (via preload contextBridge):
 *   pe:anthropic-oauth-start     → { sessionId, url }
 *   pe:anthropic-oauth-complete  → OAuthBundle   (throws on failure)
 *   pe:anthropic-oauth-cancel    → void
 */
export function registerAnthropicOAuthHandlers(): void {
  ipcMain.handle('pe:anthropic-oauth-start', () => startFlow())
  ipcMain.handle('pe:anthropic-oauth-complete',
    (_event, sessionId: string, code: string) => completeFlow(sessionId, code))
  ipcMain.handle('pe:anthropic-oauth-cancel',
    (_event, sessionId: string) => cancelFlow(sessionId))
}
