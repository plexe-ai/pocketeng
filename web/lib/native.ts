/**
 * Native platform abstraction layer.
 *
 * Detects whether the app is running inside a Capacitor native shell
 * and provides wrappers around native plugins that gracefully no-op
 * when running in a regular browser.
 */
import { Capacitor, registerPlugin } from '@capacitor/core'

// ── Electron desktop shell bridge ──────────────────────────────────────────
// Exposed by desktop/src/preload/index.ts via contextBridge. Present only
// when running inside the Electron desktop wrapper.
export type DesktopAgentId = 'claude' | 'codex' | 'cursor'
export type DesktopPlatform = 'macos' | 'windows'

export interface DesktopAgentDetection {
  installed: boolean
  hasCredentials: boolean
  extractable: boolean
  identifier?: string
}

/** AWS profile summary returned by `detectAws()`. Never includes secrets. */
export interface AwsProfileSummary {
  name: string
  accessKeyId: string
  maskedAccessKeyId: string
  region?: string
  ssoOnly: boolean
}

/**
 * The OAuth bundle Claude Code writes to `~/.claude/.credentials.json`
 * after a successful subscription login. Returned verbatim from the
 * Electron-side OAuth flow so the renderer can POST it straight to the
 * backend without any shape munging.
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
 * The OAuth bundle Codex CLI writes to `~/.codex/auth.json` after a
 * successful `codex login`. Returned verbatim from the Electron-side
 * OAuth flow so the renderer can POST it straight to the backend — the
 * shape is recognized by `agent_credentials_sync.py`.
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
 * The OAuth bundle `cursor-agent` CLI writes to `~/.config/cursor/auth.json`
 * (Linux) or `~/.cursor/auth.json` (macOS) after `cursor-agent login`.
 * The CLI's source has optional `apiKey` and `bedrockCredentials` fields
 * but they're nullable and we don't get either from the OAuth poll, so
 * we only carry the two that always come back. Returned verbatim from
 * the Electron-side OAuth flow.
 */
export interface CursorOAuthBundle {
  accessToken: string
  refreshToken: string
}

export interface PocketengDesktopBridge {
  version: string
  platform: DesktopPlatform | null
  onDeepLink: (handler: (url: string) => void) => () => void
  openExternal: (url: string) => void
  setBadgeCount: (n: number) => void
  /** Pop the desktop window to the front — called from a browser
   *  Notification's onclick so clicking a banner focuses the app. */
  focusWindow?: () => void
  detectAgents: () => Promise<{
    ok: boolean
    agents?: Record<DesktopAgentId, DesktopAgentDetection>
    error?: string
  }>
  readAgentCredentials: (agent: DesktopAgentId) => Promise<{
    ok: boolean
    contents?: string
    error?: string
  }>
  /** Auto-detect AWS profiles in ~/.aws/. Safe to call — no secrets returned. */
  detectAws: () => Promise<{
    ok: boolean
    profiles?: AwsProfileSummary[]
    error?: string
  }>
  /** Read full creds for a named profile. Call after user confirms import. */
  readAwsProfile: (name: string) => Promise<{
    ok: boolean
    accessKeyId?: string
    secretAccessKey?: string
    region?: string
    error?: string
  }>

  /**
   * Anthropic subscription OAuth — driven from Electron main (residential
   * IP), not our Lambda backend (Cloudflare-blocked). Call `start` to get
   * the `claude.ai/oauth/authorize` URL, open it via `openExternal`, and
   * have the user paste the code Anthropic displays on their callback
   * page into `complete(sessionId, pastedCode)` — that returns the OAuth
   * bundle ready to POST to `/account/agent-credentials`.
   */
  startAnthropicOAuth: () => Promise<{ sessionId: string; url: string }>
  completeAnthropicOAuth: (
    sessionId: string,
    code: string,
  ) => Promise<AnthropicOAuthBundle>
  cancelAnthropicOAuth: (sessionId: string) => Promise<void>

  /**
   * OpenAI (Codex / ChatGPT) subscription OAuth. Flow differs from the
   * Anthropic one: no manual code paste. Main binds an HTTP server to
   * 127.0.0.1:1455, OpenAI redirects back there, main resolves the
   * pending `awaitOpenAIOAuth(sessionId)` with a ready-to-upload bundle.
   *
   * Usage:
   *   const { sessionId, url } = await startOpenAIOAuth()
   *   openExternal(url)
   *   const bundle = await awaitOpenAIOAuth(sessionId)
   *   saveAgentCredential({ agent: 'codex', contents: JSON.stringify(bundle), ... })
   */
  startOpenAIOAuth: () => Promise<{ sessionId: string; url: string }>
  awaitOpenAIOAuth: (sessionId: string) => Promise<OpenAIOAuthBundle>
  cancelOpenAIOAuth: (sessionId: string) => Promise<void>

  /**
   * Cursor subscription OAuth. Cursor doesn't publish a public OAuth
   * client_id — instead `cursor-agent login` uses a polling pattern.
   * Main generates PKCE verifier + challenge + uuid, returns a URL
   * shaped like `cursor.com/loginDeepControl?challenge=...&uuid=...`,
   * polls `api2.cursor.sh/auth/poll` until the user completes the
   * browser dance, then resolves with `{accessToken, refreshToken}`.
   *
   * Same usage shape as the OpenAI flow:
   *   const { sessionId, url } = await startCursorOAuth()
   *   openExternal(url)
   *   const bundle = await awaitCursorOAuth(sessionId)
   *   saveAgentCredential({ agent: 'cursor', contents: JSON.stringify(bundle), ... })
   */
  startCursorOAuth: () => Promise<{ sessionId: string; url: string }>
  awaitCursorOAuth: (sessionId: string) => Promise<CursorOAuthBundle>
  cancelCursorOAuth: (sessionId: string) => Promise<void>
}

declare global {
  interface Window {
    pocketengDesktop?: PocketengDesktopBridge
  }
}

/** True when running inside a Capacitor iOS/Android shell. */
export const isNative = Capacitor.isNativePlatform()

/** True when running on iOS (native or Safari). */
export const isIOS = Capacitor.getPlatform() === 'ios'

/** True when running on Android. */
export const isAndroid = Capacitor.getPlatform() === 'android'

/**
 * True when running inside the Electron desktop shell.
 * Desktop routes OAuth through the system browser instead of
 * SFSafariViewController / Chrome Custom Tabs.
 */
export const isDesktop =
  typeof window !== 'undefined' && !!window.pocketengDesktop

interface PocketEngNativeConfigPlugin {
  getNativeConfig: () => Promise<{ fcmConfigured?: boolean }>
}

const PocketEngConfig = registerPlugin<PocketEngNativeConfigPlugin>('PocketEngConfig')

export const desktopPlatform: DesktopPlatform | null =
  typeof window !== 'undefined'
    ? window.pocketengDesktop?.platform ?? null
    : null

export const isDesktopMac = desktopPlatform === 'macos'
export const isDesktopWindows = desktopPlatform === 'windows'

// ── Haptics ─────────────────────────────────────────────────────────────────

export async function hapticLight() {
  if (!isNative) return
  const { Haptics, ImpactStyle } = await import('@capacitor/haptics')
  await Haptics.impact({ style: ImpactStyle.Light })
}

export async function hapticMedium() {
  if (!isNative) return
  const { Haptics, ImpactStyle } = await import('@capacitor/haptics')
  await Haptics.impact({ style: ImpactStyle.Medium })
}

export async function hapticHeavy() {
  if (!isNative) return
  const { Haptics, ImpactStyle } = await import('@capacitor/haptics')
  await Haptics.impact({ style: ImpactStyle.Heavy })
}

export async function hapticSelection() {
  if (!isNative) return
  const { Haptics } = await import('@capacitor/haptics')
  await Haptics.selectionStart()
  await Haptics.selectionChanged()
  await Haptics.selectionEnd()
}

// ── Status Bar ──────────────────────────────────────────────────────────────

export async function setStatusBarDark() {
  if (!isNative) return
  const { StatusBar, Style } = await import('@capacitor/status-bar')
  await StatusBar.setStyle({ style: Style.Dark })
}

export async function setStatusBarLight() {
  if (!isNative) return
  const { StatusBar, Style } = await import('@capacitor/status-bar')
  await StatusBar.setStyle({ style: Style.Light })
}

// ── Splash Screen ───────────────────────────────────────────────────────────

export async function hideSplash() {
  if (!isNative) return
  const { SplashScreen } = await import('@capacitor/splash-screen')
  await SplashScreen.hide({ fadeOutDuration: 300 })
}

// ── Push Notifications ──────────────────────────────────────────────────────

export async function isAndroidPushConfigured(): Promise<boolean> {
  if (!isNative || !isAndroid) return true
  try {
    const config = await PocketEngConfig.getNativeConfig()
    return config.fcmConfigured === true
  } catch (err) {
    console.warn('[push] native config unavailable, skipping Android push registration', err)
    return false
  }
}

export async function registerPush(): Promise<string | null> {
  if (!isNative) return null
  if (isAndroid && !(await isAndroidPushConfigured())) {
    console.warn('[push] FCM is not configured for this Android build, skipping registration')
    return null
  }
  const { PushNotifications } = await import('@capacitor/push-notifications')

  const permission = await PushNotifications.requestPermissions()
  console.log('[push] permission:', permission.receive)
  if (permission.receive !== 'granted') return null

  // Capacitor's native event bus doesn't queue events emitted before a
  // listener is attached. `register()` kicks off the APNs/FCM round trip
  // asynchronously; if we awaited it before attaching listeners we could
  // miss the `registration` event on a fast network. Attach first, then
  // fire register().
  return new Promise<string | null>((resolve) => {
    let resolved = false
    const finish = (value: string | null, why: string) => {
      if (resolved) return
      resolved = true
      console.log('[push] resolved:', why, value ? `...${value.slice(-8)}` : 'null')
      resolve(value)
    }
    PushNotifications.addListener('registration', (t) => finish(t.value, 'registration'))
    PushNotifications.addListener('registrationError', (e) => {
      console.warn('[push] registrationError:', e)
      finish(null, 'error')
    })
    setTimeout(() => finish(null, 'timeout'), 10000)
    PushNotifications.register().catch((err) => {
      console.warn('[push] register() threw:', err)
      finish(null, 'threw')
    })
  })
}

export async function addPushListeners(handlers: {
  onNotification?: (data: Record<string, unknown>) => void
  onAction?: (data: Record<string, unknown>) => void
}) {
  if (!isNative) return
  const { PushNotifications } = await import('@capacitor/push-notifications')

  if (handlers.onNotification) {
    PushNotifications.addListener('pushNotificationReceived', (notification) => {
      handlers.onNotification?.(notification.data ?? {})
    })
  }

  if (handlers.onAction) {
    PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      handlers.onAction?.(action.notification?.data ?? {})
    })
  }
}

// ── App Lifecycle ──────────────────────────────────────────────────────────

/**
 * Fire a handler each time the native app returns to the foreground.
 * No-op in a regular browser — caller should also listen for visibilitychange.
 * Returns an unsubscribe function.
 */
export async function onAppResume(handler: () => void): Promise<() => void> {
  if (!isNative) return () => {}
  try {
    const { App } = await import('@capacitor/app')
    const h = await App.addListener('appStateChange', ({ isActive }: { isActive: boolean }) => {
      if (isActive) handler()
    })
    return () => { h.remove?.() }
  } catch {
    return () => {}
  }
}

// ── Deep Links ─────────────────────────────────────────────────────────────

export async function listenForDeepLinks(handler: (url: string) => void) {
  // Capacitor (iOS/Android) path
  if (isNative) {
    try {
      const { App } = await import('@capacitor/app')
      App.addListener('appUrlOpen', ({ url }) => handler(url))
    } catch { /* @capacitor/app not available */ }
    return
  }
  // Electron desktop path — pocketeng-desktop:// delivered via the preload
  // contextBridge.
  if (isDesktop) {
    window.pocketengDesktop?.onDeepLink(handler)
  }
}

// ── Voice input (record → upload → transcribe) ─────────────────────────────
//
// Implementation history:
//   1. Originally used @capacitor-community/speech-recognition. That plugin
//      isn't SPM-compatible; `cap sync ios` silently skipped it, so the JS
//      call always rejected and the try/catch swallowed it. Mic did nothing.
//   2. Switched to `webkitSpeechRecognition` (Web Speech API). Works in
//      desktop Chrome/Safari and iOS WKWebView, but *not in Electron* —
//      Electron's Chromium ships without Google's speech API keys, so
//      audio hits Google's server and comes back 403.
//   3. Current approach: record via MediaRecorder, send to our backend
//      which forwards to OpenAI Whisper. Works everywhere MediaRecorder
//      works (Chromium, Safari 14.1+, iOS WKWebView, Firefox, Electron).
//      Batch only — the user taps mic to start, taps again to stop, and
//      ~1-2s later the transcribed text lands in the composer.

import { transcribeAudio } from './api'

let mediaRecorder: MediaRecorder | null = null
let currentStream: MediaStream | null = null
let recordedChunks: Blob[] = []
let onTranscript: ((text: string) => void) | null = null

/** True if the browser can record audio. Call from a `useEffect` —
 * reads `window` / `navigator`, so value only settles post-hydration. */
export function hasSpeechRecognition(): boolean {
  if (typeof window === 'undefined') return false
  // TS lib.dom types `navigator.mediaDevices` as always defined — but it's
  // actually absent in insecure-origin contexts (old browsers / http://) at
  // runtime. Cast to bypass the "always truthy" check while still being
  // defensive at runtime.
  const md = (navigator as unknown as { mediaDevices?: MediaDevices }).mediaDevices
  return !!(md && typeof md.getUserMedia === 'function' && 'MediaRecorder' in window)
}

/**
 * Pre-flight permission check. We don't strictly need to call this — the
 * first `getUserMedia` in `startListening` will also trigger the prompt —
 * but asking early lets the UI react to a "denied" state without going
 * through the full tap-mic-open-recorder dance.
 */
export async function requestSpeechPermission(): Promise<boolean> {
  if (!hasSpeechRecognition()) return false
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    stream.getTracks().forEach(t => t.stop())
    return true
  } catch { return false }
}

/** Start capturing audio. Returns immediately; transcript delivery happens
 * later when `stopListening` resolves.
 *
 * The `onResult` callback fires exactly once, after `stopListening` completes
 * and the backend returns a transcript. (Unlike the old Web Speech API version
 * which streamed partials — batch Whisper has no interim results.) */
export async function startListening(onResult: (text: string) => void): Promise<void> {
  if (!hasSpeechRecognition()) { console.warn('[mic] MediaRecorder not available'); return }
  // If a prior recording is still going, close it out silently before starting fresh.
  try { mediaRecorder?.stop() } catch { /* ignore */ }
  try { currentStream?.getTracks().forEach(t => t.stop()) } catch { /* ignore */ }

  onTranscript = onResult
  recordedChunks = []

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    currentStream = stream
    // Let the browser pick its preferred codec — Chromium/Electron default to
    // audio/webm;codecs=opus, Safari/iOS to audio/mp4. Whisper accepts both.
    const rec = new MediaRecorder(stream)
    rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) recordedChunks.push(e.data) }
    rec.start()
    mediaRecorder = rec
  } catch (err) {
    console.warn('[mic] getUserMedia / MediaRecorder start failed', err)
    currentStream = null
    onTranscript = null
  }
}

/**
 * Stop capturing, upload to the backend for transcription, and deliver the
 * transcript via the callback passed to `startListening`. Resolves when the
 * round-trip finishes so the UI can await it and keep a "transcribing…"
 * indicator on screen until then.
 */
export async function stopListening(): Promise<void> {
  const rec = mediaRecorder
  const stream = currentStream
  const cb = onTranscript
  mediaRecorder = null
  currentStream = null
  onTranscript = null

  if (!rec) return

  // Wait for MediaRecorder to flush its final chunk, then assemble the Blob.
  const blob: Blob = await new Promise((resolve) => {
    rec.onstop = () => {
      const mimeType = rec.mimeType || 'audio/webm'
      resolve(new Blob(recordedChunks, { type: mimeType }))
      recordedChunks = []
    }
    try { rec.stop() } catch {
      // If stop throws (rare — e.g. already stopped), resolve with whatever
      // we've got so the promise chain doesn't hang.
      const mimeType = rec.mimeType || 'audio/webm'
      resolve(new Blob(recordedChunks, { type: mimeType }))
      recordedChunks = []
    }
  })
  try { stream?.getTracks().forEach(t => t.stop()) } catch { /* ignore */ }

  if (!cb) return
  if (blob.size === 0) return

  try {
    const base64 = await blobToBase64(blob)
    const { text } = await transcribeAudio(base64, blob.type)
    if (text) cb(text)
  } catch (err) {
    console.warn('[mic] transcribe failed', err)
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      // readAsDataURL returns "data:<mime>;base64,<data>" — strip the prefix.
      const result = typeof reader.result === 'string' ? reader.result : ''
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : '')
    }
    reader.onerror = () => reject(reader.error ?? new Error('FileReader error'))
    reader.readAsDataURL(blob)
  })
}
