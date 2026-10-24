/**
 * Runtime config for the Electron main process.
 */
export const isDev = process.env.PE_DESKTOP_DEV === '1'

export const LOAD_URL = isDev
  ? process.env.PE_DEV_URL ?? 'http://localhost:3000'
  : 'https://console.pocketeng.ai'

/**
 * Custom URL scheme for desktop OAuth callbacks. It is distinct from the
 * iOS/Android `com.pocketengineer.coder://` scheme so desktop callbacks are
 * never claimed by a mobile simulator or native mobile shell.
 */
export const DEEP_LINK_SCHEME = 'pocketeng-desktop'

/** Update channel for electron-updater. Defaults to stable `latest`. */
export const UPDATE_CHANNEL = process.env.PE_DESKTOP_CHANNEL ?? 'latest'
