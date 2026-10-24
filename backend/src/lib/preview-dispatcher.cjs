#!/usr/bin/env node
/**
 * PocketEngineer preview dispatcher — runs on every managed-workspace
 * EC2 box. Binds to 127.0.0.1:8844 and proxies inbound requests to a
 * local dev server selected by the `X-Preview-Port` header.
 *
 * Why this exists
 * ---------------
 * The Cloudflare Worker at `preview.pocketeng.co` fronts every preview.
 * It fetches through the per-workspace tunnel at
 * `https://w-<wsId>.pocketeng.co/<path>`, which cloudflared terminates
 * and forwards to whatever the tunnel's ingress rule points at. We
 * only want ONE ingress rule per tunnel (one CNAME per workspace, set
 * at provision time — never churned per port click) so per-port
 * dispatch has to happen locally.
 *
 * The Worker sets `X-Preview-Port: <N>` on outbound fetches. This
 * dispatcher reads that header, strips it, and proxies to
 * `http://127.0.0.1:<N>`. Both plain HTTP and WebSocket upgrades work
 * — HMR / socket.io / etc. route transparently.
 *
 * Binding choice
 * --------------
 * 127.0.0.1, not 0.0.0.0. This daemon MUST NOT be reachable from the
 * public internet — cloudflared runs on the same box and is the only
 * caller. Binding to the loopback closes off the accidentally-open
 * security-group hole that would otherwise let anyone with the EC2
 * public IP skip the tunnel entirely.
 *
 * IPv4 only. We bind to the literal `127.0.0.1` rather than `localhost`
 * because on Amazon Linux 2023 `localhost` can resolve to `::1` first,
 * and we've been bitten by that before (cloudflared defaulted to IPv6
 * and hit a closed door). Same reason we pass `127.0.0.1` to the
 * upstream fetch below.
 *
 * Zero dependencies
 * -----------------
 * Pure Node stdlib. `node` is already on every managed workspace via
 * userdata (the agent bridge needs it), so there's nothing extra to
 * install. No package.json, no npm, no transitive supply chain. The
 * whole proxy fits in this file.
 */

"use strict";

const http = require("http");
const net = require("net");

const LISTEN_HOST = "127.0.0.1";
const LISTEN_PORT = Number.parseInt(process.env.PE_DISPATCHER_PORT || "8844", 10);
const UPSTREAM_HOST = "127.0.0.1";

// Business-range for dev-server preview ports. Matches the historical
// SG range (3000-9000) so any port the user can already spin up behind
// a dev server is reachable, but nothing else is. The Worker enforces
// the same bounds at the edge (see cloudflare-worker/preview-proxy/
// src/index.js). Both checks exist on purpose — defense in depth:
//   - Worker check stops 99% of abuse at the CF edge (cheap, early).
//   - Dispatcher check is the belt-and-suspenders gate for anything
//     that bypasses the Worker (direct tunnel ingress hits, a future
//     mis-configuration, a compromised Worker deploy).
//
// Any change to these bounds MUST land in both files together. Env
// overrides exist for tests, not for ops — don't set them in prod.
const ALLOWED_PORT_MIN = Number.parseInt(process.env.PE_ALLOWED_PORT_MIN || "3000", 10);
const ALLOWED_PORT_MAX = Number.parseInt(process.env.PE_ALLOWED_PORT_MAX || "9000", 10);

function parsePort(headers) {
  const raw = headers["x-preview-port"];
  if (typeof raw !== "string") return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  if (n < ALLOWED_PORT_MIN || n > ALLOWED_PORT_MAX) return null;
  // Self-loop guard. A request with X-Preview-Port: <LISTEN_PORT>
  // would proxy back to us; the re-entered request is missing the
  // header (we strip it in cleanHeaders) so it 400s, but the round
  // trip still burns sockets + fds. Reject up front.
  if (n === LISTEN_PORT) return null;
  return n;
}

function cleanHeaders(src) {
  // Copy everything EXCEPT x-preview-port. We also drop `host` so the
  // upstream client library picks a sane `localhost:<port>` default —
  // dev servers like Vite will try to validate the Host header against
  // their `server.allowedHosts` config and reject external hostnames.
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    const lk = k.toLowerCase();
    if (lk === "x-preview-port" || lk === "host") continue;
    out[k] = v;
  }
  return out;
}

const server = http.createServer((req, res) => {
  const port = parsePort(req.headers);
  if (!port) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("pe-preview-dispatcher: missing/invalid X-Preview-Port header\n");
    return;
  }

  const headers = cleanHeaders(req.headers);
  headers.host = `localhost:${port}`;

  const proxyReq = http.request(
    {
      hostname: UPSTREAM_HOST,
      port,
      method: req.method,
      path: req.url,
      headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    }
    res.end(`pe-preview-dispatcher: upstream :${port} error: ${err.code || err.message}\n`);
  });

  req.pipe(proxyReq);
});

// WebSocket / HTTP Upgrade handler. HMR, socket.io, Next.js dev — all
// require this. We hand-splice the TCP streams so we don't have to
// parse the upgrade response, and we rewrite the request line to drop
// the X-Preview-Port header before it hits the dev server.
server.on("upgrade", (req, clientSocket, head) => {
  const port = parsePort(req.headers);
  if (!port) {
    clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }

  const upstream = net.connect({ host: UPSTREAM_HOST, port }, () => {
    const headers = cleanHeaders(req.headers);
    headers.host = `localhost:${port}`;
    const reqLine = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    const headerBlock = Object.entries(headers)
      .map(([k, v]) => (Array.isArray(v) ? v.map((vv) => `${k}: ${vv}`).join("\r\n") : `${k}: ${v}`))
      .join("\r\n");
    upstream.write(reqLine + headerBlock + "\r\n\r\n");
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  const cleanup = () => {
    try { upstream.destroy(); } catch {}
    try { clientSocket.destroy(); } catch {}
  };
  upstream.on("error", cleanup);
  clientSocket.on("error", cleanup);
});

server.on("clientError", (_err, socket) => {
  if (socket.writable) {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  }
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`pe-preview-dispatcher listening on ${LISTEN_HOST}:${LISTEN_PORT}`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
