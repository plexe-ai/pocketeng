/**
 * PocketEngineer preview proxy — Cloudflare Worker.
 *
 * Public entry point for every managed-workspace dev-server preview.
 * One stable hostname (set via `wrangler.toml` route, typically
 * `preview.pocketeng.co/*`) fronts every `(workspace, port)` pair.
 *
 * Request shape
 * -------------
 *   https://preview.pocketeng.co/<workspaceId>-<port>/<rest-of-path>?q=...
 *
 *   - `workspaceId` is a UUIDv4 (32 hex + 4 dashes).
 *   - `port` is the dev-server port inside the workspace (3000-9000
 *     range enforced server-side; we accept any 2-5 digit port here
 *     because rejecting 80/443 etc. is a backend concern).
 *
 * Routing architecture
 * --------------------
 * Each managed workspace has exactly one public CNAME, created at
 * provision time by the backend:
 *   `w-<workspaceId>.<preview-domain>`  CNAME → `<tunnelId>.cfargotunnel.com`
 *
 * That hostname is the Worker's fetch target. Cloudflare's edge routes
 * the fetch through the per-workspace tunnel, which has a SINGLE
 * ingress rule pointing `w-<workspaceId>.<preview-domain>` at the
 * local preview dispatcher on `http://127.0.0.1:8844`. The dispatcher
 * reads the `X-Preview-Port` header (set by this Worker) and proxies
 * to the right dev-server port.
 *
 * Why not fetch `<tunnelId>.cfargotunnel.com` directly?
 * -----------------------------------------------------
 * Tried it. Returns 522 after ~20s. CF docs spell it out:
 *   "The cfargotunnel.com subdomain only proxies traffic for DNS
 *    records in the same Cloudflare account."
 * Workers aren't DNS records — the edge has no way to route them. We
 * need a real CNAME in the zone, hence the per-workspace hostname.
 *
 * What the KV lookup is for
 * -------------------------
 * Pure liveness. If the workspace was terminated, its CNAME was
 * removed and its KV entry deleted. Checking KV here lets us show a
 * branded "workspace not found" page instead of the default CF 1016
 * (origin DNS error) which confuses users. Routing itself doesn't
 * need KV — it's all driven by the public CNAME.
 *
 * What we do with a request
 * -------------------------
 *   1. Parse + validate the first path segment (`<wsId>-<port>`).
 *   2. Check KV for liveness; render branded 404 if absent.
 *   3. Derive preview domain from env.
 *   4. fetch(`https://w-<wsId>.<preview-domain>/<rest>`) with
 *      `X-Preview-Port: <port>`.
 *   5. Stream the response body back. Preserves status + headers +
 *      WebSocket upgrades (HMR, socket.io, etc.).
 *
 * Binding / config
 * ----------------
 *   env.TUNNEL_MAP         — KV namespace (workspaceId → tunnelId).
 *                            Written by backend on provision; deleted
 *                            on terminate. Used here for liveness only.
 *   env.PREVIEW_DOMAIN     — e.g. "pocketeng.co". Defaults to the
 *                            Worker's own URL's root domain if unset
 *                            (see resolveDomain below).
 *   wrangler.toml routes   — pattern `preview.pocketeng.co/*` → this
 *                            worker.
 *
 * Failure modes
 * -------------
 *   - Bad path         → 400 with a short explanation.
 *   - Unknown wsid     → branded 404 HTML (user likely bookmarked a
 *                        terminated workspace).
 *   - Tunnel down      → the fetch to `w-<wsId>.<preview-domain>`
 *                        surfaces Cloudflare's normal 1016/1033.
 *                        Acceptable for a first cut.
 */

const ROOT_SEGMENT_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(\d{2,5})$/i;
const WORKSPACE_HOST_PREFIX = "w-";

// Business-range for dev-server preview ports. Matches the historical
// security-group range and the dispatcher's own bounds (see
// backend/src/lib/preview-dispatcher.cjs::ALLOWED_PORT_MIN/MAX). The
// Worker stops out-of-range ports at the CF edge before they traverse
// the tunnel; the dispatcher double-checks on the box. Any change to
// these numbers MUST land in both files together.
//
// DISPATCHER_PORT is the loopback port the dispatcher itself binds to.
// Routing traffic to it would create a self-loop (which the dispatcher
// already 400s, but we'd rather not pay the round-trip).
const ALLOWED_PORT_MIN = 3000;
const ALLOWED_PORT_MAX = 9000;
const DISPATCHER_PORT = 8844;

export default {
  async fetch(request, env, _ctx) {
    try {
      return await handle(request, env);
    } catch (err) {
      // Catch-all — a thrown exception inside a Worker would otherwise
      // surface to the user as a 1101 Cloudflare error page with no
      // guidance. Return something that says "this is us, not your
      // dev server". Leave the error on stderr so `wrangler tail`
      // picks it up.
      console.error("preview-proxy: unhandled error", err && err.stack || err);
      return new Response("preview proxy internal error", {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
  },
};

async function handle(request, env) {
  const url = new URL(request.url);

  // Split off the leading `/<workspace>-<port>` segment. Everything
  // after that (including the slash) is forwarded to the dev server.
  const firstSlashAfterRoot = url.pathname.indexOf("/", 1);
  const firstSegment = firstSlashAfterRoot === -1
    ? url.pathname.slice(1)
    : url.pathname.slice(1, firstSlashAfterRoot);
  const rest = firstSlashAfterRoot === -1 ? "/" : url.pathname.slice(firstSlashAfterRoot);

  if (!firstSegment) {
    // Root of preview.pocketeng.co — probably a user navigating
    // directly. Give them a hint instead of a 404.
    return htmlResponse(
      200,
      `<!doctype html><meta charset="utf-8"><title>PocketEngineer preview</title>
       <body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.5">
         <h1>PocketEngineer preview proxy</h1>
         <p>This endpoint serves dev-server previews. Open a workspace in
         your dashboard and click the Preview icon next to a running port
         instead of visiting this URL directly.</p>
       </body>`,
    );
  }

  const match = firstSegment.match(ROOT_SEGMENT_RE);
  if (!match) {
    return textResponse(
      400,
      `preview-proxy: malformed path segment "${firstSegment}" ` +
        "(expected \"<workspaceId>-<port>\" where workspaceId is a uuid)",
    );
  }
  const workspaceId = match[1].toLowerCase();
  const portStr = match[2];
  const port = Number.parseInt(portStr, 10);
  if (!Number.isFinite(port)) {
    return textResponse(400, `preview-proxy: invalid port ${portStr}`);
  }
  // Port-range gate: an unauthenticated URL (UUID-as-token) must not
  // be able to reach arbitrary loopback services on the workspace
  // (Redis on 6379, Postgres on 5432, metrics / debug endpoints, the
  // dispatcher's own port, etc). Restrict to the dev-server range,
  // and specifically block the dispatcher port so we never set up a
  // self-loop. The dispatcher enforces the same bounds.
  if (port < ALLOWED_PORT_MIN || port > ALLOWED_PORT_MAX || port === DISPATCHER_PORT) {
    return textResponse(
      400,
      `preview-proxy: port ${portStr} is not in the allowed dev-server ` +
        `range (${ALLOWED_PORT_MIN}-${ALLOWED_PORT_MAX}, excluding ${DISPATCHER_PORT})`,
    );
  }

  if (!env.TUNNEL_MAP) {
    // Misconfiguration — the wrangler.toml binding isn't wired up.
    // Unhelpful to surface to the user; make it obvious in logs.
    console.error("preview-proxy: TUNNEL_MAP KV binding is missing");
    return textResponse(500, "preview-proxy: not configured");
  }

  // Liveness check. We don't use the tunnel id value for routing
  // anymore — the per-workspace CNAME does that — but KV presence
  // tells us the workspace is still alive.
  const tunnelId = await env.TUNNEL_MAP.get(workspaceId);
  if (!tunnelId) {
    return htmlResponse(
      404,
      `<!doctype html><meta charset="utf-8"><title>Workspace not found</title>
       <body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.5">
         <h1>Workspace not found</h1>
         <p>We don't have a preview tunnel for workspace
           <code>${escapeHtml(workspaceId)}</code>. The workspace may
           have been terminated or the preview may not have been set
           up yet.</p>
         <p>Open the dashboard and click Preview from within your
           workspace to re-initialise the tunnel.</p>
       </body>`,
    );
  }

  // Build the per-workspace public hostname. `w-<wsId>.<preview-domain>`
  // is CNAMEd to the tunnel at provision time. Worker fetch through
  // this hostname routes through CF edge → tunnel → local dispatcher.
  const previewDomain = resolveDomain(url, env);
  const workspaceHost = `${WORKSPACE_HOST_PREFIX}${workspaceId}.${previewDomain}`;
  const targetUrl = new URL(`https://${workspaceHost}${rest || "/"}`);
  targetUrl.search = url.search;

  const outgoingHeaders = new Headers(request.headers);

  // The dispatcher on the box reads this header and uses it to pick
  // which local dev-server port to proxy to. Stripped before the
  // request hits the dev server itself.
  outgoingHeaders.set("x-preview-port", String(port));

  // Strip CF edge-injected headers on the outgoing side. CF adds them
  // again automatically on egress fetch; leaving the client's
  // (possibly forged) versions in place would be wrong.
  outgoingHeaders.delete("cf-connecting-ip");
  outgoingHeaders.delete("cf-ray");
  outgoingHeaders.delete("cf-visitor");

  // NOTE: we do NOT rewrite Host. The tunnel's ingress rule matches
  // on Host: `w-<wsId>.<preview-domain>`, and Worker fetch's default
  // Host is the target URL's hostname — which is exactly that. Any
  // attempt to override via Headers.set("host", ...) is silently
  // ignored by the Workers runtime, so we don't try.

  const upstreamReq = new Request(targetUrl.toString(), {
    method: request.method,
    headers: outgoingHeaders,
    // Passing the original body through preserves WebSocket upgrades
    // (HMR, socket.io) — Workers' fetch handles the 101 response
    // automatically when the Upgrade header is set.
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    redirect: "manual",
  });

  return fetch(upstreamReq);
}

function resolveDomain(url, env) {
  // Explicit var wins (set via wrangler secret / [vars]). Otherwise
  // derive from the Worker's own hostname — `preview.pocketeng.co`
  // → `pocketeng.co`. This lets the same Worker code run in multiple
  // environments without code changes.
  if (env && typeof env.PREVIEW_DOMAIN === "string" && env.PREVIEW_DOMAIN.trim()) {
    return env.PREVIEW_DOMAIN.trim().replace(/^\.+|\.+$/g, "");
  }
  const parts = url.hostname.split(".");
  if (parts.length >= 2) {
    return parts.slice(-2).join(".");
  }
  return url.hostname;
}

function textResponse(status, body) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function htmlResponse(status, body) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}
