/**
 * Tests for the EventUploader.
 *
 * Run with: cd backend/src/lib/bridge && node --test
 *
 * These are fast unit tests — no real network, no real agent. We stand
 * up a tiny in-process HTTP server as the mock ingest endpoint.
 */
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventUploader, createUploaderFromEnv } from "./uploader.mjs";

function makeMockServer(handler) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      const result = handler(parsed, req);
      res.writeHead(result.status || 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.body || {}));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function silentLogger() {
  return { error: () => {}, log: () => {}, warn: () => {} };
}

describe("EventUploader", () => {
  let stateDir;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "pe-uploader-test-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("assigns monotonically increasing seq", async () => {
    const { server, url } = await makeMockServer(() => ({ body: { acceptedThroughSeq: 2 } }));
    const u = new EventUploader({
      url, secret: "s", sessionId: "sess-1", turnId: "t-1", stateDir, logger: silentLogger(),
    });
    u.emit("run.started", {});
    u.emit("assistant.message", { text: "hi" });
    u.emit("run.finished", { outcome: "success" });
    assert.equal(u.buffer[0].seq, 0);
    assert.equal(u.buffer[1].seq, 1);
    assert.equal(u.buffer[2].seq, 2);
    u.dispose();
    server.close();
  });

  test("persists events to events.jsonl before network", async () => {
    const { server, url } = await makeMockServer(() => ({ body: {}, status: 500 }));
    const u = new EventUploader({
      url, secret: "s", sessionId: "sess-1", turnId: "t-1", stateDir, logger: silentLogger(),
    });
    u.emit("assistant.message", { text: "hello" });
    const content = readFileSync(join(stateDir, "events.jsonl"), "utf8");
    const parsed = JSON.parse(content.trim());
    assert.equal(parsed.kind, "assistant.message");
    assert.equal(parsed.payload.text, "hello");
    assert.equal(parsed.seq, 0);
    u.dispose();
    server.close();
  });

  test("POSTs batch with correct auth header and schema", async () => {
    let captured = null;
    const { server, url } = await makeMockServer((body, req) => {
      captured = { body, headers: req.headers };
      return { body: { acceptedThroughSeq: body.events[body.events.length - 1].seq } };
    });
    const u = new EventUploader({
      url, secret: "my-secret", sessionId: "sess-42", turnId: "t-99", stateDir, logger: silentLogger(),
    });
    u.emit("run.started", { agent: "codex" });
    u.emit("run.finished", { outcome: "success" });
    await u.drain();

    assert.equal(captured.headers["x-pocketengineer-ingest-secret"], "my-secret");
    assert.equal(captured.body.events.length, 2);
    assert.equal(captured.body.events[0].kind, "run.started");
    assert.equal(captured.body.events[0].sessionId, "sess-42");
    assert.equal(captured.body.events[0].turnId, "t-99");
    assert.equal(captured.body.events[1].kind, "run.finished");
    server.close();
  });

  test("trims buffer by acceptedThroughSeq (partial success)", async () => {
    const { server, url } = await makeMockServer(() => ({ body: { acceptedThroughSeq: 1 } }));
    const u = new EventUploader({
      url, secret: "s", sessionId: "sess-1", turnId: "t-1", stateDir, logger: silentLogger(),
    });
    u.emit("run.started", {});
    u.emit("assistant.message", { text: "a" });
    u.emit("assistant.message", { text: "b" });
    await u._flushIfNeeded();
    assert.equal(u.buffer.length, 1);
    assert.equal(u.buffer[0].seq, 2);
    u.dispose();
    server.close();
  });

  test("keeps buffer on failed POST and does not advance lastAckedSeq", async () => {
    let calls = 0;
    const { server, url } = await makeMockServer(() => {
      calls += 1;
      return { status: 500, body: { error: "boom" } };
    });
    const u = new EventUploader({
      url, secret: "s", sessionId: "sess-1", turnId: "t-1", stateDir, logger: silentLogger(),
    });
    u.emit("run.started", {});
    u.emit("run.finished", { outcome: "success" });
    await u._flushIfNeeded();
    assert.equal(u.buffer.length, 2);
    assert.equal(u.lastAckedSeq, -1);
    assert.ok(calls >= 1);
    u.dispose();
    server.close();
  });

  test("persists lastAckedSeq to disk and a new uploader resumes from it", async () => {
    const { server, url } = await makeMockServer((body) => ({
      body: { acceptedThroughSeq: body.events[body.events.length - 1].seq },
    }));
    const u = new EventUploader({
      url, secret: "s", sessionId: "sess-1", turnId: "t-1", stateDir, logger: silentLogger(),
    });
    u.emit("run.started", {});
    u.emit("assistant.message", { text: "hi" });
    await u.drain();

    const ackedRaw = readFileSync(join(stateDir, "last-acked.txt"), "utf8").trim();
    assert.equal(ackedRaw, "1");

    // New uploader points at the same stateDir → picks up the cursor and has no pending work
    const u2 = new EventUploader({
      url, secret: "s", sessionId: "sess-1", turnId: "t-1", stateDir, logger: silentLogger(),
    });
    assert.equal(u2.lastAckedSeq, 1);
    assert.equal(u2.nextSeq, 2);
    assert.equal(u2.buffer.length, 0);
    u2.dispose();
    server.close();
  });

  test("replays unacked events on restart", async () => {
    let receivedEvents = null;
    const { server, url } = await makeMockServer((body) => {
      receivedEvents = body.events;
      return { body: { acceptedThroughSeq: body.events[body.events.length - 1].seq } };
    });

    // First uploader writes to disk but fails to reach network
    const uFail = new EventUploader({
      url: "http://127.0.0.1:1",
      secret: "s", sessionId: "sess-1", turnId: "t-1", stateDir, logger: silentLogger(),
    });
    uFail.emit("run.started", {});
    uFail.emit("assistant.message", { text: "recover me" });
    uFail.dispose();

    // Second uploader picks up the JSONL and successfully flushes
    const u2 = new EventUploader({
      url, secret: "s", sessionId: "sess-1", turnId: "t-2", stateDir, logger: silentLogger(),
    });
    assert.equal(u2.buffer.length, 2);
    await u2.drain();

    assert.equal(receivedEvents.length, 2);
    assert.equal(receivedEvents[0].kind, "run.started");
    assert.equal(receivedEvents[1].kind, "assistant.message");
    server.close();
  });

  test("single-flight: overlapping flush requests don't stack concurrent POSTs", async () => {
    let inFlightAtPeak = 0;
    let active = 0;
    const { server, url } = await makeMockServer(async () => {
      active += 1;
      if (active > inFlightAtPeak) inFlightAtPeak = active;
      await new Promise((r) => setTimeout(r, 50));
      active -= 1;
      return { body: { acceptedThroughSeq: 0 } };
    });
    const u = new EventUploader({
      url, secret: "s", sessionId: "sess-1", turnId: "t-1", stateDir, logger: silentLogger(),
    });
    u.emit("run.started", {});
    // Fire multiple flush attempts in parallel; only one POST should be in flight
    await Promise.all([u._flushIfNeeded(), u._flushIfNeeded(), u._flushIfNeeded()]);
    assert.equal(inFlightAtPeak, 1);
    u.dispose();
    server.close();
  });

  test("drain waits for buffer to clear", async () => {
    let posts = 0;
    const { server, url } = await makeMockServer((body) => {
      posts += 1;
      return { body: { acceptedThroughSeq: body.events[body.events.length - 1].seq } };
    });
    const u = new EventUploader({
      url, secret: "s", sessionId: "sess-1", turnId: "t-1", stateDir, logger: silentLogger(),
    });
    for (let i = 0; i < 5; i++) u.emit("assistant.message", { text: `msg-${i}` });
    await u.drain();
    assert.equal(u.buffer.length, 0);
    assert.ok(posts >= 1);
    server.close();
  });
});

describe("createUploaderFromEnv", () => {
  let prevEnv;
  before(() => { prevEnv = { ...process.env }; });
  after(() => { process.env = prevEnv; });

  test("returns null when PE_INGEST_URL is missing", () => {
    delete process.env.PE_INGEST_URL;
    process.env.PE_INGEST_SECRET = "x";
    const u = createUploaderFromEnv({ sessionId: "s", turnId: "t" });
    assert.equal(u, null);
  });

  test("returns null when PE_INGEST_SECRET is missing", () => {
    process.env.PE_INGEST_URL = "http://x";
    delete process.env.PE_INGEST_SECRET;
    const u = createUploaderFromEnv({ sessionId: "s", turnId: "t" });
    assert.equal(u, null);
  });

  test("returns null when sessionId missing", () => {
    process.env.PE_INGEST_URL = "http://x";
    process.env.PE_INGEST_SECRET = "x";
    const u = createUploaderFromEnv({ sessionId: null, turnId: "t" });
    assert.equal(u, null);
  });

  test("builds an uploader with PE_STATE_DIR honored", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pe-env-test-"));
    process.env.PE_INGEST_URL = "http://127.0.0.1:1";
    process.env.PE_INGEST_SECRET = "secret";
    process.env.PE_STATE_DIR = tmp;
    const u = createUploaderFromEnv({ sessionId: "s1", turnId: "t1" });
    assert.ok(u);
    assert.ok(existsSync(join(tmp, "s1")));
    u.dispose();
    rmSync(tmp, { recursive: true, force: true });
  });
});
