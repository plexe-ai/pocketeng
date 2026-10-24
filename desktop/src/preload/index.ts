import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { AgentId, PocketengDesktopBridge } from '../shared/types'

// Version comes from main via webPreferences.additionalArguments — works
// under sandbox (require of arbitrary paths does not).
const versionArg = process.argv.find((a) => a.startsWith('--pe-version='))
const version = versionArg ? versionArg.slice('--pe-version='.length) : '0.0.0'

function getDesktopPlatform(): PocketengDesktopBridge['platform'] {
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'win32') return 'windows'
  return null
}

const bridge: PocketengDesktopBridge = {
  version,
  platform: getDesktopPlatform(),
  onDeepLink: (handler) => {
    const listener = (_event: IpcRendererEvent, url: string) => {
      try {
        handler(url)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[pocketengDesktop.onDeepLink] handler threw:', err)
      }
    }
    ipcRenderer.on('pe:deep-link', listener)
    return () => {
      ipcRenderer.removeListener('pe:deep-link', listener)
    }
  },
  openExternal: (url) => {
    if (typeof url !== 'string') return
    ipcRenderer.send('pe:open-external', url)
  },
  setBadgeCount: (n) => {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return
    ipcRenderer.send('pe:set-badge', Math.floor(n))
  },
  focusWindow: () => {
    // Called by the renderer when the user clicks a native notification —
    // main restores + focuses + moveTop so the app pops to the front.
    ipcRenderer.send('pe:focus-window')
  },
  detectAgents: () => ipcRenderer.invoke('pe:detect-agents'),
  readAgentCredentials: (agent: AgentId) =>
    ipcRenderer.invoke('pe:read-agent-credentials', agent),
  detectAws: () => ipcRenderer.invoke('pe:detect-aws'),
  readAwsProfile: (name: string) =>
    ipcRenderer.invoke('pe:read-aws-profile', name),
  // Anthropic subscription OAuth — runs entirely in main so the token
  // exchange POST originates from the user's residential IP (dodges
  // Cloudflare's Lambda-IP 1010 block).
  startAnthropicOAuth: () => ipcRenderer.invoke('pe:anthropic-oauth-start'),
  completeAnthropicOAuth: (sessionId: string, code: string) =>
    ipcRenderer.invoke('pe:anthropic-oauth-complete', sessionId, code),
  cancelAnthropicOAuth: (sessionId: string) =>
    ipcRenderer.invoke('pe:anthropic-oauth-cancel', sessionId),

  // OpenAI (Codex / ChatGPT) subscription OAuth — same-shaped wrapper, but
  // the flow is localhost-callback (no manual paste). Main spins up an
  // HTTP server on 127.0.0.1:1455, renderer opens the URL, callback lands
  // back on main, `awaitOpenAIOAuth` resolves with the token bundle.
  startOpenAIOAuth: () => ipcRenderer.invoke('pe:openai-oauth-start'),
  awaitOpenAIOAuth: (sessionId: string) =>
    ipcRenderer.invoke('pe:openai-oauth-await', sessionId),
  cancelOpenAIOAuth: (sessionId: string) =>
    ipcRenderer.invoke('pe:openai-oauth-cancel', sessionId),

  // Cursor subscription OAuth — same shape, but the flow is server-poll
  // (no localhost callback, no manual paste). Renderer opens the URL,
  // main polls api2.cursor.sh/auth/poll until the user finishes the
  // browser dance, `awaitCursorOAuth` resolves with the {accessToken,
  // refreshToken} bundle. Replicates `cursor-agent login` exactly —
  // verified by tracing the official CLI's network calls.
  startCursorOAuth: () => ipcRenderer.invoke('pe:cursor-oauth-start'),
  awaitCursorOAuth: (sessionId: string) =>
    ipcRenderer.invoke('pe:cursor-oauth-await', sessionId),
  cancelCursorOAuth: (sessionId: string) =>
    ipcRenderer.invoke('pe:cursor-oauth-cancel', sessionId),
}

contextBridge.exposeInMainWorld('pocketengDesktop', bridge)
