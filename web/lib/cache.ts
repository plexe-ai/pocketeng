/**
 * Tiny TTL-bounded localStorage cache. Used to paint stale-but-plausible
 * data instantly on page mount so returning users never see a skeleton
 * while we re-fetch the real thing in the background.
 *
 * Read is synchronous (pre-hydration-safe — readCache runs in component
 * init, which is fine because useState initializer runs on the client).
 * Write fires and forgets — quota-exceeded / private-mode failures are
 * swallowed, not thrown.
 *
 * Keys are versioned via the CACHE_PREFIX — bump the version segment to
 * invalidate everything cached under the old shape when the data model
 * changes (e.g. if `Server` adds or drops a required field).
 *
 * Design decisions that shaped this:
 *   - No React state machinery here. Pages that want cached-first paint
 *     initialize their own useState from readCache() and then update
 *     normally. Keeps the cache layer framework-agnostic and trivially
 *     testable.
 *   - TTL is enforced on READ (not via a background eviction loop). Stale
 *     entries linger until someone asks for them; they're cheap.
 *   - No LRU eviction. localStorage is ~5-10 MB per origin; we'll cache
 *     small structured data (server lists, session metadata), not blobs.
 *     If we ever hit quota, the write catch handler silently drops.
 */

const CACHE_PREFIX = 'pe:cache:v1:'
const DEFAULT_TTL_MS = 5 * 60 * 1000 // 5 minutes — tuned for the case
                                      // where fresh data is expected soon
                                      // anyway (dashboard mount, session
                                      // list refresh). Beyond 5m, the risk
                                      // of showing a workspace that was
                                      // deleted from another device grows
                                      // uncomfortable.

interface CacheEntry<T> {
  /** Write timestamp in ms epoch. */
  t: number
  /** Payload. */
  v: T
}

/**
 * Read a cached value. Returns `null` if:
 *   - Running server-side (no window)
 *   - Nothing stored under this key
 *   - Stored JSON is malformed (shape change, user manually tampered)
 *   - Entry is older than `maxAgeMs`
 */
export function readCache<T>(key: string, maxAgeMs: number = DEFAULT_TTL_MS): T | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(CACHE_PREFIX + key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as CacheEntry<T>
    if (!parsed || typeof parsed.t !== 'number') return null
    if (Date.now() - parsed.t > maxAgeMs) return null
    return parsed.v
  } catch {
    // Malformed JSON, localStorage disabled (private mode), etc.
    return null
  }
}

/**
 * Write a value to cache. Fire and forget — failures (quota exceeded,
 * private-browsing mode, localStorage disabled) are silently dropped.
 */
export function writeCache<T>(key: string, value: T): void {
  if (typeof window === 'undefined') return
  try {
    const entry: CacheEntry<T> = { t: Date.now(), v: value }
    window.localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(entry))
  } catch {
    /* quota / private mode — fine, next read just returns null */
  }
}

/**
 * Drop a single cached key. Useful after actions the user knows
 * invalidate the cache (e.g. provision, terminate).
 */
export function clearCache(key: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(CACHE_PREFIX + key)
  } catch { /* noop */ }
}

/**
 * Drop every pe:cache:* entry — invoked on sign-out so the next user
 * doesn't see the previous user's dashboard list flash before their own
 * data loads.
 */
export function clearAllCache(): void {
  if (typeof window === 'undefined') return
  try {
    const keys: string[] = []
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i)
      if (k && k.startsWith(CACHE_PREFIX)) keys.push(k)
    }
    for (const k of keys) window.localStorage.removeItem(k)
  } catch { /* noop */ }
}
