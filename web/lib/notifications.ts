/**
 * Desktop notifications — thin wrapper over the browser `Notification` API.
 *
 * Fires native desktop banners when the user is away from the Pocket Eng
 * window (e.g. they sent a task, switched to their editor, and the agent
 * finished). Suppresses itself when the window is focused — the user
 * can already see the update in the chat, a banner would be noisy.
 *
 * Works in both environments:
 *   - Electron (desktop app): Chromium's Notification API fires a real
 *     native notification. The app identity shown on the banner comes from
 *     the packaged desktop app metadata.
 *   - Regular browser tab: same API, same UX. Capacitor iOS shell ignores
 *     these — we use Capacitor push + APNs for iOS instead; see
 *     web/components/NativeBootstrap.tsx.
 *
 * Permission model: we NEVER auto-prompt on page load. Chrome + Safari
 * now block permission requests that weren't triggered by a user gesture,
 * and auto-prompts train users to click "Block" reflexively. Instead we
 * request permission the first time something interesting actually
 * happens (e.g. the user kicks off an agent task — `requestBeforeTask()`
 * below). If they deny once, we don't bug them again.
 */

// Guard against SSR — Next.js can import this file on the server.
const inBrowser = (): boolean =>
  typeof window !== 'undefined' && typeof Notification !== 'undefined'

/** Current permission state. Never throws. */
export function notificationsGranted(): boolean {
  if (!inBrowser()) return false
  return Notification.permission === 'granted'
}

/** Has the user ever made a choice (granted or denied)? */
function permissionResolved(): boolean {
  if (!inBrowser()) return true
  return Notification.permission !== 'default'
}

/**
 * Ask once, in response to a user gesture (button click, keydown, send).
 * No-ops on SSR, if permission was already resolved, or if the API is
 * missing. Returns the final permission state so callers can branch.
 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!inBrowser()) return 'default'
  if (permissionResolved()) return Notification.permission
  try {
    return await Notification.requestPermission()
  } catch {
    return Notification.permission
  }
}

export interface NotifyOpts {
  body?: string
  /** Same-origin URL to focus when the user clicks the banner. */
  onClick?: () => void
  /** Collapse multiple notifications with the same tag into one banner,
   *  replacing the previous. Good for per-session updates. */
  tag?: string
}

/**
 * Fire a notification if:
 *   - permission is granted, AND
 *   - the document is hidden / unfocused (don't spam users who are already
 *     looking at the app).
 *
 * Quietly no-ops otherwise. Never throws.
 */
export function notify(title: string, opts: NotifyOpts = {}): void {
  if (!inBrowser()) return
  if (!notificationsGranted()) return
  // Suppress when the app window is focused — the user can see the chat
  // already, a banner would duplicate the signal visually + audibly.
  if (typeof document !== 'undefined' && document.hasFocus()) return

  try {
    const n = new Notification(title, {
      body: opts.body,
      tag: opts.tag,
      // Icon: the app bundle icon is used automatically in the desktop app.
      // Web-tab notifications use the favicon.
    })
    n.onclick = () => {
      // Focus the window so the user lands back on the app. `focus()` on
      // the Notification itself is unreliable across desktop OSes — we grab
      // window focus instead. Inside Electron, we ALSO ping the main-process
      // bridge (if present) so the app rises to the foreground.
      try {
        window.focus()
        window.pocketengDesktop?.focusWindow?.()
      } catch { /* */ }
      try { opts.onClick?.() } catch { /* */ }
      n.close()
    }
  } catch {
    /* swallow — notification construction can throw if permission was
       revoked between the check and the constructor call. */
  }
}

/**
 * Convenience for the "user is about to do something where a notification
 * is useful" moment — e.g. just before they submit a chat message. Quietly
 * requests permission if it hasn't been asked. The request itself is a
 * user-gesture-allowed permission prompt because this function runs
 * inside the submit handler.
 */
export async function primeNotifications(): Promise<void> {
  if (!inBrowser()) return
  if (permissionResolved()) return
  await requestNotificationPermission()
}
