import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { DEEP_LINK_SCHEME } from './config'
import { extractDeepLinkFromArgv } from './deep-link-url'

type DeepLinkHandler = (url: string) => void

let handler: DeepLinkHandler | null = null
let pending: string[] = []

/**
 * Register the custom URL scheme and wire up platform-specific deep-link
 * delivery so links land on the provided handler.
 * Must be called before `app.whenReady()` resolves for cold-start links.
 */
export function registerDeepLinkProtocol(): void {
  if (process.platform === 'win32' && process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [
      path.resolve(process.argv[1]),
    ])
  } else {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME)
  }

  if (process.platform === 'darwin') {
    // macOS cold start: handler not wired yet — buffer the URL.
    app.on('open-url', (event, url) => {
      event.preventDefault()
      dispatch(url)
    })
  } else {
    // Windows delivers cold-start protocol URLs through argv.
    const initialUrl = extractDeepLinkFromArgv(process.argv, DEEP_LINK_SCHEME)
    if (initialUrl) dispatch(initialUrl)
  }

  // Windows delivers already-running protocol URLs here. macOS can also emit
  // this in unusual second-instance paths, so keep it cross-platform.
  app.on('second-instance', (_event, argv) => {
    const url = extractDeepLinkFromArgv(argv, DEEP_LINK_SCHEME)
    if (url) dispatch(url)

    // Focus the first open window.
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
}

/**
 * Called once the main window and its renderer are ready to receive IPC.
 * Flushes any buffered URLs that arrived before the renderer was listening.
 */
export function setDeepLinkHandler(h: DeepLinkHandler): void {
  handler = h
  if (pending.length > 0) {
    for (const url of pending) h(url)
    pending = []
  }
}

function dispatch(url: string) {
  if (handler) handler(url)
  else pending.push(url)
}
