/**
 * Cursor subscription login driven from the Electron main process.
 *
 * Cursor doesn't publish an OAuth client_id like Codex does. The
 * `cursor-agent` CLI's login flow uses a polling pattern (think OAuth
 * device-code, but Cursor's own API):
 *
 *   1. Generate PKCE-style verifier + sha256 challenge + a uuid.
 *   2. Open https://cursor.com/loginDeepControl?challenge=...&uuid=...&mode=login&redirectTarget=cli
 *      in the user's system browser.
 *   3. Poll https://api2.cursor.sh/auth/poll?uuid=...&verifier=... .
 *      404 → keep polling (exponential backoff 1s → 10s, ratio 1.2).
 *      200 → response body is `{accessToken, refreshToken}` (both JWTs).
 *
 * This is exactly what `cursor-agent login` itself does (verified against
 * the binary at ~/.local/share/cursor-agent/.../index.js — see the
 * `startLogin` and `waitForResult` functions). We're not reverse-
 * engineering anything internal; we're hitting the same public endpoints
 * the official CLI hits, with the same param shape.
 *
 * Why main (not renderer, not Lambda):
 *   - Token exchange happens from the user's residential IP — same
 *     rationale as anthropic-oauth.ts and openai-oauth.ts.
 *   - PKCE verifier never crosses the contextBridge.
 *   - Long-running poll (up to ~25 minutes) doesn't tie up renderer.
 *
 * Final bundle uploaded to our backend:
 *   { accessToken, refreshToken }
 *
 * The backend writes this verbatim to ~/.config/cursor/auth.json on the
 * EC2 (mode 0600). cursor-agent on the EC2 reads it on startup and the
 * user is signed in — same effect as if they'd run `cursor-agent login`
 * inside an SSH session, minus the chicken-and-egg of needing a browser
 * on the EC2 host.
 *
 * Path verified empirically by running a real `cursor-agent login` on a
 * pocketeng EC2 workspace and observing where the file landed.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'

// Public host names the cursor-agent CLI itself defaults to. Both are
// override-able via env in the CLI (CURSOR_WEBSITE_URL / CURSOR_API_BASE_URL)
// — we don't bother since users on the desktop app aren't going to need
// to hit a staging Cursor backend.
const WEBSITE_URL = 'https://cursor.com'
const API_BASE_URL = 'https://api2.cursor.sh'
const POLL_URL = `${API_BASE_URL}/auth/poll`

// Match the CLI's polling parameters exactly: 1s start, 10s ceiling,
// 1.2x growth, 150 iterations max → ~25 minutes worst case before we
// give up. Long enough that a user can finish a 2FA dance with a slow
// authenticator, short enough that an abandoned flow doesn't camp on
// outbound HTTP forever.
const POLL_BASE_MS = 1_000
const POLL_MAX_MS = 10_000
const POLL_GROWTH = 1.2
const POLL_MAX_ITERATIONS = 150
// Number of consecutive non-404 errors we tolerate before giving up.
// Matches the CLI — guards against transient network blips.
const POLL_MAX_TRANSIENT_ERRORS = 3

interface PendingSession {
  uuid: string
  verifier: string
  createdAt: number
  /** Set just before resolve() / reject() to keep cleanupSession from
   * double-settling. Same pattern as the OpenAI flow. */
  settled: boolean
  /** Promise the renderer awaits via awaitCursorOAuth. */
  bundlePromise: Promise<CursorOAuthBundle>
  resolve: (bundle: CursorOAuthBundle) => void
  reject: (err: Error) => void
  /** Set to true on cancel so the polling loop exits early without
   * waiting for the next tick. */
  cancelled: boolean
}

const sessions = new Map<string, PendingSession>()

export interface StartResult {
  sessionId: string
  url: string
}

/**
 * Bundle the renderer uploads verbatim to /account/agent-credentials.
 * Backend's agent_credentials_sync.py recognizes the cursor + accessToken/
 * refreshToken combo as oauth-json and SFTPs it to ~/.config/cursor/auth.json
 * on the EC2 (mode 0600).
 */
export interface CursorOAuthBundle {
  accessToken: string
  refreshToken: string
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function cleanupSession(sessionId: string, err?: Error): void {
  const s = sessions.get(sessionId)
  if (!s) return
  s.cancelled = true
  sessions.delete(sessionId)
  if (err && !s.settled) {
    s.settled = true
    s.reject(err)
  }
}

async function startFlow(): Promise<StartResult> {
  // Generate PKCE materials. Pattern matches what cursor-agent's CLI
  // does internally (verified against the bundled JS).
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  const uuid = randomUUID()
  const sessionId = base64url(randomBytes(16))

  // Wire the renderer-facing promise up front. Capture handles
  // synchronously inside the executor.
  let resolveBundle!: (bundle: CursorOAuthBundle) => void
  let rejectBundle!: (err: Error) => void
  const bundlePromise = new Promise<CursorOAuthBundle>((resolve, reject) => {
    resolveBundle = resolve
    rejectBundle = reject
  })
  // Defensive: prevent unhandled-rejection warnings if the renderer
  // never calls awaitCursorOAuth (shouldn't happen, but cheap).
  bundlePromise.catch(() => { /* swallowed */ })

  const session: PendingSession = {
    uuid,
    verifier,
    createdAt: Date.now(),
    settled: false,
    bundlePromise,
    resolve: resolveBundle,
    reject: rejectBundle,
    cancelled: false,
  }
  sessions.set(sessionId, session)

  // Kick off the poll loop. We don't await it — the renderer awaits
  // bundlePromise via awaitCursorOAuth(sessionId).
  void pollForResult(sessionId).catch((err) => {
    if (!session.settled) {
      session.settled = true
      sessions.delete(sessionId)
      session.reject(err instanceof Error ? err : new Error(String(err)))
    }
  })

  const params = new URLSearchParams({
    challenge,
    uuid,
    mode: 'login',
    redirectTarget: 'cli',
  })
  return {
    sessionId,
    url: `${WEBSITE_URL}/loginDeepControl?${params.toString()}`,
  }
}

async function pollForResult(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId)
  if (!session) return
  let transientErrors = 0
  for (let i = 0; i < POLL_MAX_ITERATIONS; i++) {
    if (session.cancelled || session.settled) return
    try {
      const url = `${POLL_URL}?uuid=${encodeURIComponent(session.uuid)}&verifier=${encodeURIComponent(session.verifier)}`
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      })
      if (res.status === 404) {
        // Not yet authenticated — keep polling. Reset transient counter.
        transientErrors = 0
        await sleep(backoffDelay(i))
        continue
      }
      if (!res.ok) {
        transientErrors += 1
        if (transientErrors >= POLL_MAX_TRANSIENT_ERRORS) {
          throw new Error(`Cursor poll failed: HTTP ${res.status}`)
        }
        await sleep(backoffDelay(i))
        continue
      }
      const data = await res.json() as Partial<CursorOAuthBundle>
      if (typeof data.accessToken !== 'string' || typeof data.refreshToken !== 'string') {
        throw new Error('Cursor poll returned malformed body (missing tokens)')
      }
      // Mark settled BEFORE resolving so a concurrent cancel can't
      // double-settle. Same ordering as openai-oauth.ts.
      session.settled = true
      sessions.delete(sessionId)
      session.resolve({
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
      })
      return
    } catch (err) {
      // Network blip — count as transient. fetch() throws on DNS fail,
      // connection refused, etc.
      transientErrors += 1
      if (transientErrors >= POLL_MAX_TRANSIENT_ERRORS) {
        throw err instanceof Error ? err : new Error(String(err))
      }
      await sleep(backoffDelay(i))
    }
  }
  throw new Error('Cursor sign-in timed out. Start again.')
}

function backoffDelay(iteration: number): number {
  return Math.min(POLL_BASE_MS * Math.pow(POLL_GROWTH, iteration), POLL_MAX_MS)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function awaitFlow(sessionId: string): Promise<CursorOAuthBundle> {
  const session = sessions.get(sessionId)
  if (!session) {
    throw new Error('Cursor sign-in session not found. Start again.')
  }
  return session.bundlePromise
}

function cancelFlow(sessionId: string): void {
  cleanupSession(sessionId, new Error('Cancelled'))
}

/**
 * Register IPC handlers. Call once at app startup, alongside the
 * Anthropic and OpenAI OAuth handlers in main/index.ts.
 *
 * Renderer-facing API (via preload contextBridge):
 *   pe:cursor-oauth-start     → { sessionId, url }  (begins polling)
 *   pe:cursor-oauth-await     → CursorOAuthBundle   (resolves on success)
 *   pe:cursor-oauth-cancel    → void                (stops polling)
 */
export function registerCursorOAuthHandlers(): void {
  ipcMain.handle('pe:cursor-oauth-start', () => startFlow())
  ipcMain.handle('pe:cursor-oauth-await',
    (_event, sessionId: string) => awaitFlow(sessionId))
  ipcMain.handle('pe:cursor-oauth-cancel',
    (_event, sessionId: string) => cancelFlow(sessionId))
}
