/**
 * Client-side log forwarder for Capacitor native shells.
 *
 * Why: Safari Web Inspector is disabled on distribution-signed iOS builds
 * (TestFlight, App Store), so the `console.log` / `console.warn` lines we
 * sprinkle around the app are invisible once we ship. This module wraps
 * the global `console.*` to *also* fire-and-forget POST each line to
 * `/debug/log`, where the backend `print()`s it to CloudWatch.
 *
 * Result: `aws logs tail /aws/lambda/<DebugLogFunction> --follow` becomes
 * a real-time stream of every console.* call from every TestFlight user.
 *
 * Constraints we respect:
 *   - Never throw out of a wrapped console call. Logging crashing the
 *     app is the worst possible failure mode.
 *   - No-op until Supabase has a session — pre-auth bootstrap logs are
 *     usually noise, and unauthenticated POSTs would just 401 on every
 *     line. Dropping them quietly is the right call.
 *   - Web (browser) is unaffected — that's what Web Inspector is for.
 *   - Electron desktop is unaffected — Chromium DevTools work there.
 *
 * Tagging convention: when the first arg starts with "[bracket-tag]",
 * we lift it into a separate field so CloudWatch greps stay tidy:
 *
 *   console.log('[push]', 'permission:', 'granted')
 *     → { tag: '[push]', message: 'permission: granted' }
 */
import { isNative } from './native'
import { supabase } from './supabase'

interface LogEntry {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug'
  tag: string
  message: string
}

const BASE = process.env.NEXT_PUBLIC_API_BASE_URL
const queue: LogEntry[] = []
let initialized = false
let flushScheduled = false
let flushing = false

function scheduleFlush(): void {
  if (flushScheduled) return
  flushScheduled = true
  // 200ms batches — keeps a tight burst of registration logs in one
  // round-trip without making us pay HTTP overhead per line.
  setTimeout(flush, 200)
}

async function flush(): Promise<void> {
  flushScheduled = false
  if (flushing) return
  flushing = true
  try {
    const batch = queue.splice(0, queue.length)
    if (batch.length === 0) return
    if (!BASE) return

    let token: string | undefined
    try {
      const { data } = await supabase.auth.getSession()
      token = data.session?.access_token
    } catch {
      // Session lookup itself failed — drop the batch.
      return
    }
    if (!token) {
      // Pre-auth or signed out. Drop silently; backend would 401 anyway.
      return
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    }

    // Per-line POST so one failed request can't drop a whole batch. The
    // Lambda handler is bare — `print()` and return — so cost per call is
    // sub-millisecond at the SAM/Lambda layer.
    await Promise.all(
      batch.map((entry) =>
        fetch(`${BASE}/debug/log`, {
          method: 'POST',
          headers,
          body: JSON.stringify(entry),
        }).catch(() => {
          /* never let logging crash the app */
        }),
      ),
    )
  } finally {
    flushing = false
    // If logs piled up while we were posting, kick off another flush.
    if (queue.length > 0) scheduleFlush()
  }
}

function format(args: unknown[]): { tag: string; message: string } {
  let tag = ''
  let rest = args
  const first = args[0]
  if (typeof first === 'string') {
    const close = first.indexOf(']')
    if (first.startsWith('[') && close > 0) {
      tag = first.substring(0, close + 1)
      const tail = first.substring(close + 1).trim()
      rest = tail ? [tail, ...args.slice(1)] : args.slice(1)
    }
  }
  const message = rest
    .map((a) => {
      if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ''}`
      if (typeof a === 'object' && a !== null) {
        try {
          return JSON.stringify(a)
        } catch {
          return String(a)
        }
      }
      return String(a)
    })
    .join(' ')
  return { tag, message }
}

/**
 * Idempotent. Safe to call from any module that runs on app mount.
 * No-ops on web / desktop / SSR.
 */
export function initClientLog(): void {
  if (initialized) return
  if (typeof window === 'undefined') return
  if (!isNative) return
  initialized = true

  const orig = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  }

  const wrap = (level: LogEntry['level']) =>
    function (this: unknown, ...args: unknown[]) {
      // Always preserve the local print first — keeps Console.app
      // (USB-cable debugging) and Xcode console working as-is.
      orig[level](...(args as [unknown, ...unknown[]]))
      try {
        const { tag, message } = format(args)
        queue.push({ level, tag, message })
        scheduleFlush()
      } catch {
        /* swallow; never break console.* */
      }
    }

  console.log = wrap('log')
  console.info = wrap('info')
  console.warn = wrap('warn')
  console.error = wrap('error')
  console.debug = wrap('debug')

  // First entry confirms the wrapper is active in CloudWatch.
  console.log('[clientLog] initialized')
}
