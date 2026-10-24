import { app, BrowserWindow, shell, ipcMain, Notification } from 'electron'
import path from 'node:path'
import { LOAD_URL, isDev, DEEP_LINK_SCHEME } from './config'
import { registerDeepLinkProtocol, setDeepLinkHandler } from './deep-link'
import { buildAppMenu } from './menu'
import { setupAutoUpdate } from './updater'
import {
  detectAllAgents,
  readAgentCredentials,
} from './agent-detection'
import { detectAwsProfiles, readAwsProfile } from './aws-detection'
import { registerAnthropicOAuthHandlers } from './anthropic-oauth'
import { registerOpenAIOAuthHandlers } from './openai-oauth'
import { registerCursorOAuthHandlers } from './cursor-oauth'

const APP_ID = 'com.pocketengineer.coder.desktop'

// Single-instance lock so deep links always go to the primary window.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
  process.exit(0)
}

registerDeepLinkProtocol()
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_ID)
}

let mainWindow: BrowserWindow | null = null

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 880,
    minHeight: 600,
    backgroundColor: '#0a0a0f',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      additionalArguments: [`--pe-version=${app.getVersion()}`],
      // Don't let Chromium throttle setInterval / setTimeout / requestAnimationFrame
      // when the window is backgrounded or hidden. Our chat uses a 200ms
      // polling loop for the live event stream; with the default throttle
      // (1-hertz timers in background), a session running while the user
      // task-switches would stop receiving messages until the window is
      // refocused. macOS App Nap still applies at the OS level, but
      // disabling the Chromium layer is the larger of the two effects and
      // the one under our control.
      backgroundThrottling: false,
    },
  })

  // Open all target=_blank / external links in the system browser.
  // Also routes OAuth URLs externally — they'll redirect back via the
  // pocketeng-desktop:// scheme and land on the deep-link handler.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`${DEEP_LINK_SCHEME}://`)) {
      // Deep links are never opened in a new window; the protocol handler catches them.
      return { action: 'deny' }
    }
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Prevent in-place navigation to off-site URLs (keep window on our domain).
  win.webContents.on('will-navigate', (event, url) => {
    try {
      const target = new URL(url)
      const current = new URL(win.webContents.getURL() || LOAD_URL)
      if (target.origin !== current.origin) {
        event.preventDefault()
        void shell.openExternal(url)
      }
    } catch {
      /* ignore invalid URLs */
    }
  })

  win.once('ready-to-show', () => win.show())

  void win.loadURL(LOAD_URL)

  // DevTools: auto-open in dev, or if PE_DEV_TOOLS=1 is set in the env for
  // the current launch. Useful when running the prod URL locally and
  // needing to debug the renderer without switching to `bun run dev`.
  if (
    process.env.PE_DESKTOP_SKIP_DEVTOOLS !== '1' &&
    (isDev || process.env.PE_DEV_TOOLS === '1')
  ) {
    win.webContents.openDevTools({ mode: 'detach' })
  }

  return win
}

app.whenReady().then(() => {
  mainWindow = createWindow()
  buildAppMenu(mainWindow)
  setupAutoUpdate(mainWindow)

  // Forward deep links (buffered if they arrived before ready) to the renderer.
  setDeepLinkHandler((url) => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    mainWindow.webContents.send('pe:deep-link', url)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
      buildAppMenu(mainWindow)
    }
  })
})

// macOS convention: keep running until Cmd-Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ── IPC handlers exposed through preload ───────────────────────────────────

ipcMain.on('pe:open-external', (_event, url: unknown) => {
  if (typeof url !== 'string') return
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'mailto:') return
    void shell.openExternal(url)
  } catch {
    /* ignore */
  }
})

ipcMain.on('pe:set-badge', (_event, count: unknown) => {
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return
  app.setBadgeCount(Math.floor(count))
})

ipcMain.on('pe:notify', (_event, payload: unknown) => {
  // TODO(desktop): Revisit whether this IPC path is still reachable from the
  // renderer. The preload bridge does not currently expose a notification API,
  // so this may be dead code or an incomplete integration.
  if (!Notification.isSupported()) return
  if (typeof payload !== 'object' || payload === null) return
  const { title, body } = payload as { title?: unknown; body?: unknown }
  if (typeof title !== 'string') return
  new Notification({
    title,
    body: typeof body === 'string' ? body : undefined,
  }).show()
})

// Bring the window to the foreground. Called by the renderer when the user
// clicks a native notification. We also pop it above other apps via
// `moveTop()` where Electron exposes it.
ipcMain.on('pe:focus-window', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  if (typeof (mainWindow as unknown as { moveTop?: () => void }).moveTop === 'function') {
    (mainWindow as unknown as { moveTop: () => void }).moveTop()
  }
})

// Register the browser-flow OAuth handlers (subscription login driven
// from this Electron main, not from our backend — residential IP is
// required because Lambda IPs hit some providers' WAF blocks).
//
// All three follow the same renderer-facing shape:
//   start  → { sessionId, url }  (renderer opens url via openExternal)
//   await  → bundle              (resolves when login completes)
//   cancel → void                (aborts an in-flight session)
// Auth specifics differ:
//   Anthropic — paste-code flow (PKCE + manual code paste)
//   OpenAI    — localhost callback (PKCE + 127.0.0.1:1455 redirect)
//   Cursor    — server polling (PKCE + GET api2.cursor.sh/auth/poll)
registerAnthropicOAuthHandlers()
registerOpenAIOAuthHandlers()
registerCursorOAuthHandlers()

// Detect locally-installed coding agents (Claude, Codex, Cursor). Returns
// metadata only — no credential material. Safe to call freely from onboarding.
// Local credential import is macOS-only in v1; Windows supports subscription
// OAuth and API-key paths without probing local agent installs.
ipcMain.handle('pe:detect-agents', async () => {
  if (process.platform !== 'darwin') {
    // TODO(desktop): Review the Windows/non-macOS UX here. Returning
    // "not installed" for every agent may blur the distinction between
    // "unsupported import path" and "agent genuinely absent".
    return {
      ok: true,
      agents: {
        claude: { installed: false, hasCredentials: false, extractable: false },
        codex: { installed: false, hasCredentials: false, extractable: false },
        cursor: { installed: false, hasCredentials: false, extractable: false },
      },
    }
  }
  try {
    return { ok: true, agents: await detectAllAgents() }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
})

// Read the full credential JSON for one agent. Should be called only after the
// user explicitly confirms the import in the UI.
ipcMain.handle('pe:read-agent-credentials', async (_event, agent: unknown) => {
  if (process.platform !== 'darwin') {
    return { ok: false, error: 'Local credential import is only supported on macOS.' }
  }
  if (typeof agent !== 'string') {
    return { ok: false, error: 'agent must be a string' }
  }
  return readAgentCredentials(agent)
})

// List AWS profiles the user has configured in ~/.aws/credentials +
// ~/.aws/config. Returns profile names + access key IDs + regions. Does
// NOT return secret access keys (safe to call from render paths).
ipcMain.handle('pe:detect-aws', async () => {
  try {
    return { ok: true, profiles: await detectAwsProfiles() }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
})

// Read one AWS profile's full credentials (secret included). Caller must
// show a UI confirmation first — the returned secret is meant to be handed
// straight to the backend for KMS-encrypted storage and never logged.
ipcMain.handle('pe:read-aws-profile', async (_event, name: unknown) => {
  if (typeof name !== 'string' || !name) {
    return { ok: false, error: 'profile name required' }
  }
  const creds = await readAwsProfile(name)
  if (!creds) return { ok: false, error: 'Profile not found or missing key/secret' }
  return { ok: true, ...creds }
})
