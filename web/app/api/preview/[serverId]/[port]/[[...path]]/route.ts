import { NextRequest, NextResponse } from 'next/server'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL

/* ── IP cache (60s TTL) ─────────────────────────────────────────────
   Keyed by (serverId, token) so a cached entry can't be reused by a
   different caller presenting a bogus token. Each token must be
   validated against the backend at least once before it can hit cache. */
const ipCache = new Map<string, { ip: string; exp: number }>()

async function getServerIp(serverId: string, token: string): Promise<string | null> {
  const key = `${serverId}:${token}`
  const cached = ipCache.get(key)
  if (cached && cached.exp > Date.now()) return cached.ip

  const res = await fetch(`${API_BASE}/servers/${serverId}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  })
  if (!res.ok) return null

  const server = await res.json()
  if (!server.publicIp) return null

  ipCache.set(key, { ip: server.publicIp, exp: Date.now() + 60_000 })
  return server.publicIp
}

/* ── Shared proxy handler ── */
async function handleProxy(
  req: NextRequest,
  { params }: { params: Promise<{ serverId: string; port: string; path?: string[] }> },
) {
  const { serverId, port: portStr, path: pathSegments } = await params

  const token =
    req.cookies.get('pe-preview-token')?.value ||
    req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const port = parseInt(portStr, 10)
  if (isNaN(port) || port < 3000 || port > 9000) {
    return NextResponse.json({ error: 'Port must be between 3000 and 9000' }, { status: 400 })
  }

  const ip = await getServerIp(serverId, token)
  if (!ip) {
    return NextResponse.json({ error: 'Server not found or not running' }, { status: 403 })
  }

  const targetPath = pathSegments?.join('/') ?? ''
  const search = req.nextUrl.search
  const targetUrl = `http://${ip}:${port}/${targetPath}${search}`
  const pathPrefix = `/api/preview/${serverId}/${port}`  // no trailing slash

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  const bodyBuf = hasBody ? Buffer.from(await req.arrayBuffer()) : undefined

  // Fast path: direct HTTP to the workspace
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    const upstreamRes = await fetch(targetUrl, {
      method: req.method,
      headers: filterRequestHeaders(req.headers),
      body: bodyBuf,
      redirect: 'manual',
      signal: controller.signal,
    })
    clearTimeout(timeout)

    return await buildProxyResponse(upstreamRes, pathPrefix)
  } catch {
    // Fall back to SSH tunnel
  }

  // SSH tunnel fallback via backend Lambda
  try {
    const backendRes = await fetch(`${API_BASE}/servers/${serverId}/chat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'preview-proxy',
        port,
        path: `/${targetPath}${search}`,
        method: req.method,
        headers: collectForwardableHeaders(req.headers),
        bodyB64: bodyBuf ? bodyBuf.toString('base64') : undefined,
      }),
    })

    if (!backendRes.ok) {
      const err = await backendRes.json().catch(() => ({ error: 'SSH tunnel failed' }))
      return NextResponse.json(err, { status: backendRes.status })
    }

    return await buildProxyResponse(backendRes, pathPrefix)
  } catch {
    return NextResponse.json({ error: 'Could not reach dev server' }, { status: 502 })
  }
}

/* ── Response builder ─────────────────────────────────────────────────
   Rewrites paths so root-relative URLs (/foo.css) route back through the
   proxy. Applies to HTML bodies, CSS bodies, and 3xx Location headers.
   Also injects a tiny runtime shim that rewrites leading-slash URLs for
   fetch/XHR/Request inside the rendered app. */
async function buildProxyResponse(upstream: Response, pathPrefix: string): Promise<Response> {
  const contentType = (upstream.headers.get('content-type') ?? '').toLowerCase()
  const headers = buildResponseHeaders(upstream.headers, pathPrefix)

  if (contentType.includes('text/html')) {
    const html = await upstream.text()
    const patched = rewriteHtml(html, pathPrefix)
    headers.delete('content-length')
    return new Response(patched, { status: upstream.status, headers })
  }

  if (contentType.includes('text/css')) {
    const css = await upstream.text()
    const patched = rewriteCss(css, pathPrefix)
    headers.delete('content-length')
    return new Response(patched, { status: upstream.status, headers })
  }

  if (isJsContentType(contentType)) {
    const js = await upstream.text()
    const patched = rewriteJs(js, pathPrefix)
    headers.delete('content-length')
    return new Response(patched, { status: upstream.status, headers })
  }

  // Binary / JSON / everything else: pass through
  const body = await upstream.arrayBuffer()
  return new Response(body, { status: upstream.status, headers })
}

function isJsContentType(ct: string): boolean {
  return (
    ct.includes('javascript') ||
    ct.includes('ecmascript') ||
    ct.includes('application/x-typescript') ||
    ct.includes('text/typescript')
  )
}

/* ── URL rewriting ── */
function prefixAbs(prefix: string, u: string): string {
  if (!u) return u
  if (u.charCodeAt(0) !== 47 /* '/' */) return u       // not path-absolute
  if (u.charCodeAt(1) === 47) return u                 // protocol-relative "//"
  return prefix + u
}

function rewriteHtml(html: string, pathPrefix: string): string {
  // Rewrite href/src/action/formaction/poster attrs with leading-slash values.
  // Matches: attr="/..."  or  attr='/...'  (ignores anchors, mailto:, protocol-relative).
  const ATTR_RE = /\b(href|src|action|formaction|poster|data)\s*=\s*(["'])(\/(?!\/)[^"']*)\2/gi
  html = html.replace(ATTR_RE, (_m, attr, q, val) => `${attr}=${q}${pathPrefix}${val}${q}`)

  // srcset: attr="/a.png 1x, /b.png 2x" — split, rewrite each URL
  const SRCSET_RE = /\b(srcset|imagesrcset)\s*=\s*(["'])([^"']+)\2/gi
  html = html.replace(SRCSET_RE, (_m, attr, q, val) => {
    const rewritten = val
      .split(',')
      .map((part: string) => {
        const trimmed = part.trim()
        const [url, ...rest] = trimmed.split(/\s+/)
        return [prefixAbs(pathPrefix, url), ...rest].join(' ')
      })
      .join(', ')
    return `${attr}=${q}${rewritten}${q}`
  })

  // <meta http-equiv="refresh" content="0; url=/foo">
  const META_RE = /(<meta[^>]*http-equiv=["']refresh["'][^>]*content=["'][^"']*url=)(\/(?!\/)[^"' ]*)/gi
  html = html.replace(META_RE, (_m, pre, url) => `${pre}${pathPrefix}${url}`)

  // url(...) inside inline <style> and style="" attributes.
  // Rewriting globally is close enough — url() syntax is the same everywhere.
  html = html.replace(URL_FN_RE, (m, q, u) => `url(${q}${pathPrefix}${u}${q})`)

  // Inject <base> for relative URLs + runtime script for fetch/XHR/Request.
  const headInjection =
    `<base href="${pathPrefix}/">` +
    `<script>${runtimeShim(pathPrefix)}</script>`

  if (/<head(\s[^>]*)?>/i.test(html)) {
    return html.replace(/<head(\s[^>]*)?>/i, m => `${m}${headInjection}`)
  }
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${headInjection}</head>`)
  }
  return headInjection + html
}

// url( "/..." ) | url( '/...' ) | url(/...)  — only when the path is leading-slash, not //
const URL_FN_RE = /url\(\s*(["']?)(\/(?!\/)[^"')]+)\1\s*\)/g

function rewriteCss(css: string, pathPrefix: string): string {
  return css.replace(URL_FN_RE, (_m, q, u) => `url(${q}${pathPrefix}${u}${q})`)
}

/* Rewrite ES module specifiers that start with "/" so they go through the proxy.
   Covers: `from "/x"`, `import "/x"`, `import("/x")`, `export ... from "/x"`.
   We require the specifier immediately follows the keyword (optional whitespace,
   optional "(" for dynamic import) and is a path-absolute quoted string — matching
   the bytes a JS bundler would emit, not arbitrary strings in user code. */
function rewriteJs(js: string, pathPrefix: string): string {
  // `from "/..."`  (covers `import … from …` and `export … from …`)
  js = js.replace(/\bfrom\s*(["'])(\/(?!\/)[^"']+)\1/g, (_m, q, u) => `from ${q}${pathPrefix}${u}${q}`)
  // `import "/..."`  (side-effect import)
  js = js.replace(/\bimport\s*(["'])(\/(?!\/)[^"']+)\1/g, (_m, q, u) => `import ${q}${pathPrefix}${u}${q}`)
  // `import("/...")`  (dynamic)
  js = js.replace(/\bimport\s*\(\s*(["'])(\/(?!\/)[^"']+)\1\s*\)/g, (_m, q, u) => `import(${q}${pathPrefix}${u}${q})`)
  // `new URL("/...", import.meta.url)` — worker/asset URLs pattern
  js = js.replace(/\bnew\s+URL\s*\(\s*(["'])(\/(?!\/)[^"']+)\1/g, (_m, q, u) => `new URL(${q}${pathPrefix}${u}${q}`)
  return js
}

/* Runtime shim injected into every proxied HTML page.
   Rewrites string URLs passed to fetch, XMLHttpRequest.open, and the Request
   constructor so any `/foo` the app makes ends up at `/api/preview/.../foo`. */
function runtimeShim(pathPrefix: string): string {
  return `(function(){
var P=${JSON.stringify(pathPrefix)};
function rw(u){if(typeof u!=='string'||!u)return u;if(u.charCodeAt(0)!==47)return u;if(u.charCodeAt(1)===47)return u;return P+u;}
if(window.fetch){var of=window.fetch.bind(window);window.fetch=function(i,init){if(typeof i==='string')i=rw(i);return of(i,init);};}
if(window.XMLHttpRequest){var xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(){if(arguments.length>=2)arguments[1]=rw(arguments[1]);return xo.apply(this,arguments);};}
if(window.Request){var OR=window.Request;var PR=function(i,init){if(typeof i==='string')i=rw(i);return Reflect.construct(OR,[i,init],PR);};PR.prototype=OR.prototype;Object.setPrototypeOf(PR,OR);window.Request=PR;}
if(window.EventSource){var OE=window.EventSource;var PE=function(u,init){return Reflect.construct(OE,[rw(u),init],PE);};PE.prototype=OE.prototype;Object.setPrototypeOf(PE,OE);window.EventSource=PE;}
})();`
}

/* ── Header helpers ── */
function filterRequestHeaders(headers: Headers): Headers {
  const filtered = new Headers()
  headers.forEach((value, key) => {
    const k = key.toLowerCase()
    if (k === 'host' || k === 'cookie' || k === 'authorization') return
    filtered.set(key, value)
  })
  return filtered
}

function collectForwardableHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    const k = key.toLowerCase()
    if (k === 'host' || k === 'cookie' || k === 'authorization') return
    if (k === 'content-length' || k === 'connection' || k === 'transfer-encoding') return
    out[key] = value
  })
  return out
}

function buildResponseHeaders(headers: Headers, pathPrefix: string): Headers {
  const out = new Headers()
  headers.forEach((value, key) => {
    const k = key.toLowerCase()
    if (k === 'transfer-encoding' || k === 'connection' || k === 'x-frame-options') return
    if (k === 'content-security-policy' || k === 'content-security-policy-report-only') return
    if (k === 'location') return  // rewritten below
    out.set(key, value)
  })

  // 3xx Location: rewrite so `/login` becomes `/api/preview/.../login`
  const loc = headers.get('location')
  if (loc) out.set('location', prefixAbs(pathPrefix, loc))

  out.set('Cache-Control', 'no-store')
  out.set('X-Frame-Options', 'SAMEORIGIN')
  return out
}

/* ── Export all HTTP methods ── */
export const GET = handleProxy
export const POST = handleProxy
export const PUT = handleProxy
export const PATCH = handleProxy
export const DELETE = handleProxy
