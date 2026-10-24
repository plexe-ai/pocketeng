/**
 * OpenAI OAuth (Codex / ChatGPT subscription login) driven from the Electron
 * main process on the user's desktop machine.
 *
 * Why main (not the renderer, not our backend Lambda):
 *   - OpenAI's OAuth flow for the Codex CLI client_id uses a localhost
 *     redirect URI (http://localhost:1455/auth/callback). We need to spin up
 *     a short-lived HTTP server on that port to catch the redirect — a
 *     renderer or Lambda can't do that.
 *   - Keeping the PKCE verifier in main process memory avoids leaking it
 *     across the contextBridge boundary.
 *   - Token exchange originates from the user's residential IP, same
 *     rationale as the Anthropic flow.
 *
 * Flow (different from Anthropic — no manual paste step):
 *   renderer → startOpenAIOAuth()   → main: generates PKCE + state, binds an
 *                                      HTTP server to 127.0.0.1:1455,
 *                                      caches verifier+resolver keyed by
 *                                      sessionId, returns { sessionId, url }
 *   user opens URL in system browser, signs in with their ChatGPT account
 *   OpenAI redirects to http://localhost:1455/auth/callback?code=...&state=...
 *   main's HTTP server receives the request, validates state, POSTs to the
 *   token endpoint, wraps the response in Codex's on-disk `{ tokens: {...} }`
 *   shape, resolves the pending promise
 *   renderer → awaitOpenAIOAuth(sessionId) → resolves with the wrapped bundle
 *
 * The wrapped bundle is shaped to match what Codex CLI writes to
 * ~/.codex/auth.json after a native `codex login`:
 *   {
 *     "OPENAI_API_KEY": null,
 *     "tokens": {
 *       "id_token": "...",
 *       "access_token": "...",
 *       "refresh_token": "...",
 *       "account_id": "..."
 *     },
 *     "last_refresh": "<ISO8601>"
 *   }
 *
 * backend/src/lib/agent_credentials_sync.py already detects this shape
 * (`parsed.get("tokens")` is a dict) and SFTPs the blob verbatim to
 * ~/.codex/auth.json on the EC2 at session launch.
 *
 * OAuth constants are sourced from the open-source Codex CLI crate at
 * github.com/openai/codex — see codex-rs/login/src/auth/manager.rs for
 * CLIENT_ID and codex-rs/login/src/server.rs for URLs + scopes.
 */

import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { ipcMain } from 'electron'

// Public Codex CLI OAuth constants. Same values the open-source `codex`
// CLI uses. OpenAI validates the client_id — do NOT substitute your own.
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const ISSUER = 'https://auth.openai.com'
const AUTHORIZE_URL = `${ISSUER}/oauth/authorize`
const TOKEN_URL = `${ISSUER}/oauth/token`
// Codex CLI defaults to 1455. The OAuth client_id is registered with this
// exact redirect URI — changing the port would be rejected by OpenAI. If
// 1455 is occupied on the user's machine (rare), we surface a clear error
// instead of silently picking a different port.
const CALLBACK_PORT = 1455
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/auth/callback`
const SCOPES =
  'openid profile email offline_access api.connectors.read api.connectors.invoke'

// Session TTL shorter than Anthropic's (15m) because we're holding an open
// TCP port during this window — we don't want to camp on 1455 forever if
// the user abandons the flow.
const SESSION_TTL_MS = 10 * 60 * 1000

interface PendingSession {
  verifier: string
  state: string
  createdAt: number
  server: Server
  resolve: (bundle: OpenAIOAuthBundle) => void
  reject: (err: Error) => void
  timeout: NodeJS.Timeout
  /**
   * True once resolve() or reject() has been invoked. Set by the caller
   * immediately BEFORE invoking either, so cleanupSession() can tell a
   * pending session apart from one whose promise already fired.
   *
   * Used ONLY to prevent double-settling. NOT to record whether the
   * renderer has called awaitOpenAIOAuth — that's a separate concept,
   * irrelevant to the state machine.
   */
  settled: boolean
  /**
   * The promise awaitFlow() returns to the renderer. Lives on the
   * session so awaitOpenAIOAuth can retrieve it without any unsafe
   * casting and without needing to be called in any particular order
   * (it can run before or after the callback arrives).
   */
  bundlePromise: Promise<OpenAIOAuthBundle>
}

const sessions = new Map<string, PendingSession>()

export interface StartResult {
  sessionId: string
  url: string
}

/**
 * Shape Codex CLI writes to ~/.codex/auth.json after a successful browser
 * login. We return this verbatim so the renderer can POST it straight to
 * /account/agent-credentials with no shape munging — the backend already
 * knows how to handle it.
 */
export interface OpenAIOAuthBundle {
  OPENAI_API_KEY: string | null
  tokens: {
    id_token: string
    access_token: string
    refresh_token: string
    account_id: string | null
  }
  last_refresh: string
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function cleanupSession(sessionId: string, err?: Error): void {
  const s = sessions.get(sessionId)
  if (!s) return
  clearTimeout(s.timeout)
  try { s.server.close() } catch { /* already closed */ }
  sessions.delete(sessionId)
  // Only reject if an error was passed AND the happy-path resolve hasn't
  // already fired. Set `settled` here too so a duplicate cleanup (e.g.
  // timeout + cancel racing) can't re-enter and double-reject.
  if (err && !s.settled) {
    s.settled = true
    s.reject(err)
  }
}

async function startFlow(): Promise<StartResult> {
  // Reject if a prior flow is still camping on the port. User must cancel
  // or let it time out before retrying. This is preferable to auto-cancelling
  // the prior session — we don't know if the user is mid-browser-dance.
  for (const [id, s] of sessions) {
    if (s.server.listening) {
      // If it's expired but somehow still listening, force-clean it.
      if (Date.now() - s.createdAt > SESSION_TTL_MS) {
        cleanupSession(id, new Error('Session expired'))
      } else {
        throw new Error('A Codex sign-in is already in progress. Finish it or cancel and retry.')
      }
    }
  }

  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  const state = base64url(randomBytes(32))
  const sessionId = base64url(randomBytes(16))

  // Bind the local HTTP server BEFORE returning the URL — otherwise the
  // user could conceivably finish the browser flow faster than we can
  // listen (rare but possible on very fast networks + auto-fill).
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleCallback(sessionId, req, res)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(
          `Port ${CALLBACK_PORT} is in use. Close any running \`codex login\` or other Codex CLI processes and try again.`,
        ))
      } else {
        reject(err)
      }
    })
    server.listen(CALLBACK_PORT, '127.0.0.1', () => resolve())
  })

  // Wire up the Promise that awaitOpenAIOAuth() consumes. Capture the
  // resolve/reject handles first (the Promise constructor executor runs
  // synchronously, so these are set before we proceed), then build the
  // session with all fields populated in one go — no post-hoc patching,
  // no unsafe casts.
  let resolveBundle!: (bundle: OpenAIOAuthBundle) => void
  let rejectBundle!: (err: Error) => void
  const bundlePromise = new Promise<OpenAIOAuthBundle>((resolve, reject) => {
    resolveBundle = resolve
    rejectBundle = reject
  })
  // Prevent unhandled-rejection warnings if the renderer never calls
  // awaitOpenAIOAuth (defense in depth — shouldn't happen in practice).
  bundlePromise.catch(() => { /* swallowed */ })

  const timeout = setTimeout(
    () => cleanupSession(sessionId, new Error('Codex sign-in timed out. Start again.')),
    SESSION_TTL_MS,
  )
  sessions.set(sessionId, {
    verifier,
    state,
    createdAt: Date.now(),
    server,
    resolve: resolveBundle,
    reject: rejectBundle,
    timeout,
    settled: false,
    bundlePromise,
  })

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    // Codex CLI sends this extra param so OpenAI's login page knows to show
    // the "Codex" branding. Harmless to include from our Electron client.
    id_token_add_organizations: 'true',
  })

  return { sessionId, url: `${AUTHORIZE_URL}?${params.toString()}` }
}

async function handleCallback(
  sessionId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const session = sessions.get(sessionId)
  if (!session) {
    res.statusCode = 410
    res.end('Session expired. Close this tab and start again from PocketEngineer.')
    return
  }

  try {
    const url = new URL(req.url ?? '/', `http://localhost:${CALLBACK_PORT}`)
    if (!url.pathname.startsWith('/auth/callback')) {
      res.statusCode = 404
      res.end('Not found')
      return
    }

    const err = url.searchParams.get('error')
    if (err) {
      const desc = url.searchParams.get('error_description') ?? err
      writeHtmlResponse(res, 400, 'Sign-in cancelled', desc)
      cleanupSession(sessionId, new Error(`OpenAI OAuth returned error: ${desc}`))
      return
    }

    const code = url.searchParams.get('code') ?? ''
    const state = url.searchParams.get('state') ?? ''
    if (!code || !state) {
      writeHtmlResponse(res, 400, 'Missing code or state', 'The callback URL was malformed.')
      cleanupSession(sessionId, new Error('Callback missing code or state'))
      return
    }
    if (state !== session.state) {
      writeHtmlResponse(res, 400, 'State mismatch', 'This can happen if you started sign-in twice. Start again.')
      cleanupSession(sessionId, new Error('State mismatch'))
      return
    }

    // Token exchange from residential IP. Codex CLI uses form-urlencoded
    // here, not JSON — match exactly.
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: session.verifier,
    })
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      writeHtmlResponse(res, 500, 'Token exchange failed', `HTTP ${resp.status}`)
      cleanupSession(sessionId, new Error(`OpenAI token exchange failed (${resp.status}): ${text.slice(0, 300)}`))
      return
    }
    const data = await resp.json() as {
      access_token?: string
      refresh_token?: string
      id_token?: string
      token_type?: string
      expires_in?: number
    }
    if (
      typeof data.access_token !== 'string' ||
      typeof data.refresh_token !== 'string' ||
      typeof data.id_token !== 'string'
    ) {
      writeHtmlResponse(res, 500, 'Malformed token response', 'OpenAI returned an unexpected response.')
      cleanupSession(sessionId, new Error('OpenAI returned a malformed token response.'))
      return
    }

    const bundle: OpenAIOAuthBundle = {
      OPENAI_API_KEY: null,
      tokens: {
        id_token: data.id_token,
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        // Codex CLI populates account_id from claims inside id_token; we
        // leave it null — the Codex CLI on the EC2 will refresh it on first
        // use if it needs to.
        account_id: null,
      },
      last_refresh: new Date().toISOString(),
    }

    // Friendly success page in the user's browser. They don't need to do
    // anything more — the PE window picks up the result.
    writeHtmlResponse(
      res,
      200,
      'Signed in to Codex',
      'You can close this tab and return to PocketEngineer.',
    )

    // Mark settled BEFORE invoking resolve — cleanupSession checks this
    // flag to decide whether to reject, and we don't want the cleanup
    // below (fired synchronously after) to see an unsettled state.
    session.settled = true
    session.resolve(bundle)
    cleanupSession(sessionId)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    writeHtmlResponse(res, 500, 'Sign-in failed', msg)
    cleanupSession(sessionId, e instanceof Error ? e : new Error(msg))
  }
}

function writeHtmlResponse(
  res: ServerResponse,
  status: number,
  title: string,
  body: string,
): void {
  const safeTitle = title.replace(/[<>&]/g, '')
  const safeBody = body.replace(/[<>&]/g, '')
  const html = `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>${safeTitle}</title>
<style>
  body { margin: 0; padding: 48px 24px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f7f7f8; color: #1a1a2e; }
  .card { max-width: 420px; margin: 40px auto; padding: 32px; background: white; border-radius: 16px; box-shadow: 0 8px 24px rgba(0,0,0,0.08); text-align: center; }
  h1 { font-size: 18px; margin: 0 0 12px; font-weight: 600; }
  p { font-size: 14px; color: #52525b; margin: 0; line-height: 1.5; }
</style>
</head><body>
<div class="card">
  <h1>${safeTitle}</h1>
  <p>${safeBody}</p>
</div>
</body></html>`
  res.statusCode = status
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(html)
}

async function awaitFlow(sessionId: string): Promise<OpenAIOAuthBundle> {
  const session = sessions.get(sessionId)
  if (!session) {
    throw new Error('Codex sign-in session not found. Start again.')
  }
  // Just hand back the promise. It's already wired to resolve when the
  // callback lands or reject when cleanupSession fires with an error.
  // We intentionally don't mutate any session state here — the `settled`
  // flag is about the promise's state, not about whether someone's
  // listening to it.
  return session.bundlePromise
}

function cancelFlow(sessionId: string): void {
  cleanupSession(sessionId, new Error('Cancelled'))
}

/**
 * Register IPC handlers. Call once at app startup.
 *
 * Renderer-facing API (via preload contextBridge):
 *   pe:openai-oauth-start     → { sessionId, url }  (starts local server)
 *   pe:openai-oauth-await     → OpenAIOAuthBundle   (blocks until callback)
 *   pe:openai-oauth-cancel    → void                (shuts down server)
 */
export function registerOpenAIOAuthHandlers(): void {
  ipcMain.handle('pe:openai-oauth-start', () => startFlow())
  ipcMain.handle('pe:openai-oauth-await',
    (_event, sessionId: string) => awaitFlow(sessionId))
  ipcMain.handle('pe:openai-oauth-cancel',
    (_event, sessionId: string) => cancelFlow(sessionId))
}
