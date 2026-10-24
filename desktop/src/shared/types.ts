/**
 * Shape exposed to the renderer via contextBridge as `window.pocketengDesktop`.
 * Mirrors the minimum surface the web app needs to know it's inside Electron.
 */
import type { DesktopPlatform } from './platform'

export type AgentId = 'claude' | 'codex' | 'cursor'

export interface AgentDetection {
  installed: boolean
  hasCredentials: boolean
  extractable: boolean
  identifier?: string
}

/**
 * AWS profile summary returned by `detectAws()`. Safe to render — never
 * includes the secret access key. Matches the shape of
 * desktop/src/main/aws-detection.ts AwsProfileSummary.
 */
export interface AwsProfileSummary {
  name: string
  accessKeyId: string
  maskedAccessKeyId: string
  region?: string
  ssoOnly: boolean
}

/**
 * Shape Claude Code writes to ~/.claude/.credentials.json after a Max /login.
 * We return this verbatim from startAnthropicOAuth + completeAnthropicOAuth
 * so the renderer can POST it straight to /account/agent-credentials with
 * no shape munging.
 */
export interface AnthropicOAuthBundle {
  claudeAiOauth: {
    accessToken: string
    refreshToken: string
    /** Expiry as epoch milliseconds — matches Claude Code's on-disk format. */
    expiresAt: number
    scopes: string[]
    subscriptionType: string
  }
}

/**
 * Shape Codex CLI writes to ~/.codex/auth.json after a successful
 * `codex login`. We return this verbatim from awaitOpenAIOAuth so the
 * renderer can POST it straight to /account/agent-credentials —
 * `agent_credentials_sync.py` detects the `tokens` field and SFTPs the
 * blob to the EC2 unchanged.
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

/**
 * Shape `cursor-agent login` writes to ~/.config/cursor/auth.json (Linux)
 * or ~/.cursor/auth.json (macOS). The CLI's source carries optional
 * `apiKey` and `bedrockCredentials` fields but cursor-agent treats them
 * as nullable and we don't get either from the OAuth flow, so we omit.
 *
 * Both tokens are JWTs (~424 chars each at the time of writing). The
 * CLI uses the refreshToken to mint fresh accessTokens; we never refresh
 * client-side — the EC2's cursor-agent does that itself once it loads
 * this bundle.
 */
export interface CursorOAuthBundle {
  accessToken: string
  refreshToken: string
}

export interface PocketengDesktopBridge {
  /** App version from desktop/package.json */
  version: string
  /** Host desktop OS for the Electron shell. Null means unsupported. */
  platform: DesktopPlatform | null
  /**
   * Subscribe to deep-link events (pocketeng-desktop://...).
   * Returns an unsubscribe function.
   */
  onDeepLink: (handler: (url: string) => void) => () => void
  /** Open a URL in the user's default browser */
  openExternal: (url: string) => void
  /** Set the native app badge count where supported. Pass 0 to clear. */
  setBadgeCount: (n: number) => void
  /**
   * Bring the app window to the foreground from the renderer — used from
   * a notification's `onclick` handler to pop the app back up when the
   * user clicks a banner while working in another app. No-op if the
   * window was already focused.
   */
  focusWindow: () => void
  /**
   * Probe local install state for each supported coding agent. No credential
   * material is returned — this is safe to call from onboarding render paths.
   */
  detectAgents: () => Promise<{
    ok: boolean
    agents?: Record<AgentId, AgentDetection>
    error?: string
  }>
  /**
   * Read the credential file for one agent (e.g. ~/.claude/.credentials.json).
   * Caller must obtain user confirmation in the UI first; this returns the
   * raw JSON string so the caller can hand it straight to the backend.
   */
  readAgentCredentials: (agent: AgentId) => Promise<{
    ok: boolean
    contents?: string
    error?: string
  }>
  /**
   * Auto-detect AWS profiles configured in ~/.aws/credentials + ~/.aws/config.
   * Safe to call freely — NEVER returns secret access keys. The user picks
   * a profile in the UI, then the renderer calls `readAwsProfile(name)` to
   * fetch the secret for direct upload to the backend.
   */
  detectAws: () => Promise<{
    ok: boolean
    profiles?: AwsProfileSummary[]
    error?: string
  }>
  /**
   * Read the FULL credentials (including the secret access key) for a
   * named AWS profile. Call this ONLY after the user has explicitly
   * clicked "Use this profile" — the caller should hand the result
   * straight to the backend and not persist it in the renderer.
   */
  readAwsProfile: (name: string) => Promise<{
    ok: boolean
    accessKeyId?: string
    secretAccessKey?: string
    region?: string
    error?: string
  }>

  /**
   * Start the Anthropic subscription OAuth flow from the Electron main
   * process (the user's desktop). Generates PKCE locally and returns the
   * `claude.ai/oauth/authorize` URL the user must visit. Call
   * `completeAnthropicOAuth(sessionId, pastedCode)` with the code Anthropic
   * displays on their callback page to finish the exchange.
   *
   * Why main: `console.anthropic.com/v1/oauth/token` is Cloudflare-protected
   * and blocks Lambda IP ranges (error 1010). From the user's residential
   * IP the POST succeeds.
   */
  startAnthropicOAuth: () => Promise<{ sessionId: string; url: string }>
  /**
   * Finish the OAuth flow. `code` may be either `<code>#<state>` (as
   * displayed by Anthropic's callback page) or the full callback URL
   * pasted from the address bar. Throws on state mismatch / bad code /
   * expired session. On success returns the OAuth bundle in the exact
   * shape `~/.claude/.credentials.json` uses.
   */
  completeAnthropicOAuth: (
    sessionId: string,
    code: string,
  ) => Promise<AnthropicOAuthBundle>
  /** Cancel an in-flight Anthropic OAuth session (user closed the dialog). */
  cancelAnthropicOAuth: (sessionId: string) => Promise<void>

  /**
   * Start the OpenAI (Codex / ChatGPT subscription) OAuth flow from the
   * Electron main process. Binds a short-lived HTTP server to
   * 127.0.0.1:1455 for the OAuth callback, generates PKCE+state, returns
   * `{ sessionId, url }`. Renderer opens `url` via `openExternal` —
   * OpenAI redirects back to localhost, main captures the code, exchanges
   * it for tokens, and the promise returned by `awaitOpenAIOAuth` resolves.
   *
   * Unlike the Anthropic flow there's no manual paste step. If port 1455
   * is in use (another `codex login` is running) `startOpenAIOAuth` rejects
   * with a clear message — OpenAI's OAuth client is registered with this
   * exact redirect URI so a different port isn't an option.
   */
  startOpenAIOAuth: () => Promise<{ sessionId: string; url: string }>
  /**
   * Long-running IPC call that resolves when OpenAI's redirect lands on
   * our local server and the token exchange completes. Returns the OAuth
   * bundle in the exact shape ~/.codex/auth.json uses. Rejects on
   * timeout (10 minutes), user cancellation, or OpenAI error.
   */
  awaitOpenAIOAuth: (sessionId: string) => Promise<OpenAIOAuthBundle>
  /** Cancel an in-flight OpenAI OAuth session — shuts down the local HTTP server. */
  cancelOpenAIOAuth: (sessionId: string) => Promise<void>

  /**
   * Start the Cursor subscription OAuth flow from Electron main. Cursor
   * doesn't publish a public OAuth client_id — instead the CLI uses a
   * device-code-style poll: we generate PKCE verifier + challenge + uuid,
   * print a `cursor.com/loginDeepControl?...&redirectTarget=cli` URL for
   * the user to open, then poll `api2.cursor.sh/auth/poll` until they
   * finish the browser dance.
   *
   * Replicates `cursor-agent login` exactly — same endpoints, same
   * params, same poll cadence (1s start, 10s ceiling, 1.2x growth, 150
   * iterations max ≈ 25 minutes).
   */
  startCursorOAuth: () => Promise<{ sessionId: string; url: string }>
  /**
   * Long-running IPC call that resolves when cursor.com sees the user
   * finish the OAuth flow and api2.cursor.sh/auth/poll returns the
   * token bundle. Returns `{accessToken, refreshToken}` — both JWTs.
   * Rejects on timeout (~25 minutes), user cancellation, or repeated
   * non-404 errors from the poll endpoint.
   */
  awaitCursorOAuth: (sessionId: string) => Promise<CursorOAuthBundle>
  /** Cancel an in-flight Cursor OAuth session (stops the poll loop). */
  cancelCursorOAuth: (sessionId: string) => Promise<void>
}

declare global {
  interface Window {
    pocketengDesktop?: PocketengDesktopBridge
  }
}

export {}
