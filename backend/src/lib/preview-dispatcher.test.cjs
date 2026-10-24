#!/usr/bin/env node
/**
 * Unit tests for preview-dispatcher.js.
 *
 * Runs with bare `node --test` (Node ≥20, which is what the managed
 * workspaces and CI install). No test framework, no deps.
 *
 *   node --test backend/src/lib/preview-dispatcher.test.js
 *
 * We cover:
 *   1. Missing X-Preview-Port → 400 (don't accidentally proxy to an
 *      arbitrary port an attacker could pick by omitting the header).
 *   2. Valid X-Preview-Port → proxied to the dev server; the header is
 *      stripped; the Host header is rewritten to `localhost:<port>`.
 *   3. Upstream refuses connection → we return 502 (not a hung socket).
 *
 * WebSocket upgrade isn't asserted here because stdlib http doesn't
 * expose a clean client-side upgrade hook and rolling our own handshake
 * obscures the test. The splice path is simple TCP `pipe()` — if HTTP
 * is green, WS is green.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const path = require("node:path");

const DISPATCHER = path.join(__dirname, "preview-dispatcher.cjs");

// Pick a deterministic-but-not-hardcoded port. Using 0 and reading back
// the assigned port would be cleaner, but preview-dispatcher.js reads
// PE_DISPATCHER_PORT from env — passing 0 means "any port" and we'd
// still have to find out which. 18844 is far enough up that a stray
// listener is unlikely in a dev box.
const DISPATCH_PORT = 18844;

async function startUpstream(handler) {
  const srv = http.createServer(handler);
  await new Promise((res) => srv.listen(0, "127.0.0.1", res));
  return { port: srv.address().port, close: () => new Promise((r) => srv.close(() => r())) };
}

async function startDispatcher(envOverrides = {}) {
  const child = spawn(process.execPath, [DISPATCHER], {
    env: {
      ...process.env,
      PE_DISPATCHER_PORT: String(DISPATCH_PORT),
      ...envOverrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Wait for the listening log line before returning so tests don't
  // race the bind.
  await new Promise((resolve, reject) => {
    const onData = (buf) => {
      if (String(buf).includes("listening")) {
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
    setTimeout(() => reject(new Error("dispatcher didn't start in 3s")), 3000);
  });
  return { child, port: DISPATCH_PORT };
}

async function dispatch(port, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: body ? "POST" : "GET",
        path: "/some/path?x=1",
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// Wide-range dispatcher for the happy-path / proxy-semantics tests.
// Upstream servers in Node pick random ports via `listen(0)` which
// are almost never in 3000-9000; widening the range here lets those
// tests use the normal random-port pattern without fighting the
// range gate. The narrow-range dispatcher below is what enforces
// production defaults and proves the SSRF-mitigation actually fires.
let wideDispatcher;
// Narrow-range dispatcher with production defaults (3000-9000) — used
// only for the range + self-loop rejection tests. The listen port
// MUST be inside the allowed range so the self-loop test can prove
// the n===LISTEN_PORT guard fires (otherwise the range check would
// reject first and the self-loop branch would be dead code as far as
// the test is concerned).
const NARROW_PORT = 8843;
let narrowDispatcher;

test.before(async () => {
  wideDispatcher = await startDispatcher({
    PE_ALLOWED_PORT_MIN: "1",
    PE_ALLOWED_PORT_MAX: "65535",
  });
  // Start a second dispatcher on a different port, with DEFAULT range
  // bounds baked in (no env override → dispatcher uses 3000-9000).
  narrowDispatcher = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DISPATCHER], {
      env: { ...process.env, PE_DISPATCHER_PORT: String(NARROW_PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const onData = (buf) => {
      if (String(buf).includes("listening")) {
        child.stdout.off("data", onData);
        resolve({ child, port: NARROW_PORT });
      }
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
    setTimeout(() => reject(new Error("narrow dispatcher didn't start in 3s")), 3000);
  });
});

test.after(async () => {
  wideDispatcher.child.kill("SIGTERM");
  narrowDispatcher.child.kill("SIGTERM");
  await Promise.all([
    once(wideDispatcher.child, "exit"),
    once(narrowDispatcher.child, "exit"),
  ]);
});

test("400 when X-Preview-Port is missing", async () => {
  const res = await dispatch(DISPATCH_PORT, {});
  assert.equal(res.status, 400);
  assert.match(res.body, /X-Preview-Port/i);
});

test("400 when X-Preview-Port is not a number", async () => {
  const res = await dispatch(DISPATCH_PORT, { "x-preview-port": "not-a-port" });
  assert.equal(res.status, 400);
});

test("proxies to upstream, strips X-Preview-Port, rewrites Host", async () => {
  const received = {};
  const upstream = await startUpstream((req, res) => {
    received.url = req.url;
    received.method = req.method;
    received.headers = req.headers;
    res.writeHead(200, { "content-type": "text/plain", "x-upstream": "yes" });
    res.end("hello from upstream\n");
  });
  try {
    const res = await dispatch(DISPATCH_PORT, {
      "x-preview-port": String(upstream.port),
      "x-trace": "from-test",
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers["x-upstream"], "yes");
    assert.equal(res.body, "hello from upstream\n");
    // Upstream should NOT see x-preview-port.
    assert.equal(received.headers["x-preview-port"], undefined);
    // Upstream should see a localhost-flavoured host header.
    assert.equal(received.headers.host, `localhost:${upstream.port}`);
    // Path is preserved.
    assert.equal(received.url, "/some/path?x=1");
    // Other headers pass through.
    assert.equal(received.headers["x-trace"], "from-test");
  } finally {
    await upstream.close();
  }
});

test("502 when upstream refuses connection (port in range, nothing listening)", async () => {
  // 3001 is inside the 1-65535 range we set for this dispatcher; we
  // expect ECONNREFUSED → 502 (not a range rejection).
  const res = await dispatch(DISPATCH_PORT, { "x-preview-port": "3001" });
  assert.equal(res.status, 502);
  assert.match(res.body, /upstream :3001/);
});

// ── Port-range guard (production defaults) ─────────────────────────
// These run against the narrow-range dispatcher whose bounds are the
// real production values (3000-9000). Prove the SSRF-mitigation
// actually fires for the attacks Greptile flagged.

test("narrow dispatcher: 400 on port below range (2999)", async () => {
  const res = await dispatch(NARROW_PORT, { "x-preview-port": "2999" });
  assert.equal(res.status, 400);
});

test("narrow dispatcher: 400 on port above range (9001)", async () => {
  const res = await dispatch(NARROW_PORT, { "x-preview-port": "9001" });
  assert.equal(res.status, 400);
});

test("narrow dispatcher: 400 on out-of-range ports below the dev-server range (22, 80, 443, 2222, 2999)", async () => {
  // Ports BELOW 3000. These catch the obvious low-port SSRF targets
  // (SSH, HTTP, HTTPS, alt-SSH, random-admin-UIs). Postgres 5432 +
  // MySQL 3306 + Redis 6379 ARE INSIDE the 3000-9000 band and would
  // be reachable if anything HTTP-speaking happened to bind there;
  // that's a known limitation of range-only mitigation. The signed-
  // URL followup (see PR #127 body / the dispatcher learning doc) is
  // what closes that class of leak.
  for (const p of ["22", "80", "443", "2222", "2999"]) {
    const res = await dispatch(NARROW_PORT, { "x-preview-port": p });
    assert.equal(res.status, 400, `port ${p} should be rejected`);
  }
});

test("narrow dispatcher: 400 on out-of-range ports above 9000 (9001, 10000, 65535)", async () => {
  for (const p of ["9001", "10000", "65535"]) {
    const res = await dispatch(NARROW_PORT, { "x-preview-port": p });
    assert.equal(res.status, 400, `port ${p} should be rejected`);
  }
});

test("narrow dispatcher: 400 on self-loop (dispatcher's own port)", async () => {
  // NARROW_PORT is the dispatcher's LISTEN_PORT for this fixture.
  // Sending the dispatcher its own port must be rejected before any
  // upstream connect is attempted — otherwise we'd get either an
  // infinite loop or (given header-stripping) a second round-trip 400.
  const res = await dispatch(NARROW_PORT, { "x-preview-port": String(NARROW_PORT) });
  assert.equal(res.status, 400);
});
