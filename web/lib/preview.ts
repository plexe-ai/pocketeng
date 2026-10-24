import { supabase } from '@/lib/supabase'

/**
 * Managed workspaces (`envType: "general"`) expose dev servers
 * through a single stable, public URL shape:
 *
 *   https://{WORKER_URL}/{serverId}-{port}/...
 *
 * What happens under the hood (for reference — the frontend doesn't
 * care, it just builds the URL):
 *
 *   1. A global Cloudflare Worker (`pe-preview-proxy`) owns the
 *      `{WORKER_URL}/*` route. It parses `{serverId}-{port}` out of
 *      the path, checks KV for workspace liveness (branded 404 if
 *      the workspace was terminated), and fetches the per-workspace
 *      public hostname `w-<serverId>.<preview-domain>` with an
 *      `X-Preview-Port: <port>` header.
 *   2. That hostname is a CNAME created at provision time pointing
 *      at the workspace's Cloudflare Tunnel. One ingress rule on the
 *      tunnel sends all traffic to a small Node.js dispatcher on
 *      `127.0.0.1:8844` inside the EC2 box.
 *   3. The dispatcher reads `X-Preview-Port`, strips it, and proxies
 *      to `http://127.0.0.1:<port>` (incl. WebSocket upgrades).
 *
 * So: new ports open instantly, no DNS writes on the hot path, one
 * CNAME per workspace forever. See the scar at
 * `.harness/learnings/2026-04-cloudflare-tunnel-preview-dispatcher.md`
 * for the full architecture + why earlier designs didn't work.
 *
 * BYOS workspaces still go through the authenticated proxy route at
 * `/api/preview/.../`; their dev-server ports aren't exposed on the
 * public internet and we don't control their SG / firewall, so
 * routing through the backend's SSH-tunnel fallback is the only way
 * to get them to load in the browser.
 *
 * The helpers below are the single source of truth for "which URL
 * should the UI navigate to for this workspace+port". Keep these
 * aligned with `backend/src/lib/cloudflare.py::preview_url_for_port`.
 */

export type PreviewEnvType = 'general' | 'byos'

/**
 * Base URL of the deployed preview Worker (e.g. `https://preview.pocketeng.co`).
 * When empty we fall back to the legacy proxy for every workspace —
 * useful for local dev before the Worker has been stood up, and as
 * an emergency rollback switch.
 */
const CLOUDFLARE_PREVIEW_WORKER_URL = (
  process.env.NEXT_PUBLIC_CLOUDFLARE_PREVIEW_WORKER_URL ?? ''
).trim().replace(/\/+$/, '')

/** `true` if this environment should route through the Cloudflare
 *  Worker. Keep in one place so we can flip it off in one edit if
 *  the Worker goes bad and we need an emergency rollback to the
 *  legacy proxy. */
export function isCloudflareManaged(envType?: PreviewEnvType | string | null): boolean {
  return envType === 'general' && Boolean(CLOUDFLARE_PREVIEW_WORKER_URL)
}

/** Build the Worker-fronted URL for a `(serverId, port)` pair. */
export function cloudflarePreviewUrl(serverId: string, port: number, path = ''): string {
  const tail = path.startsWith('/') ? path : (path ? `/${path}` : '')
  return `${CLOUDFLARE_PREVIEW_WORKER_URL}/${serverId}-${port}${tail || '/'}`
}

/** Pick the browser-navigable preview URL for a (workspace, port). */
export function buildPreviewUrl(
  serverId: string,
  port: number,
  path = '',
  envType?: PreviewEnvType | string | null,
): string {
  if (isCloudflareManaged(envType)) {
    return cloudflarePreviewUrl(serverId, port, path)
  }
  // Legacy proxy path — BYOS and fallbacks.
  const p = path.startsWith('/') ? path.slice(1) : path
  return `/api/preview/${serverId}/${port}/${p}`
}

/** Write the Supabase access token into a scoped cookie the proxy
 *  route reads. Only needed for BYOS workspaces that traverse
 *  `/api/preview/.../`. Called from Cloudflare-backed previews is a
 *  no-op waste; the helpers above gate this. */
export async function ensurePreviewCookie(): Promise<boolean> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) return false
  document.cookie = `pe-preview-token=${session.access_token}; path=/api/preview; samesite=strict; secure`
  return true
}
