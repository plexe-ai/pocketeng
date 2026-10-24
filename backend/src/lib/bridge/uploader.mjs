/**
 * EventUploader — posts structured events to the backend ingest endpoint.
 *
 * Durability: every event is written to a local JSONL file before being
 * queued for upload. The last seq acknowledged by the backend is tracked
 * in a small state file. On network failure the agent keeps writing; the
 * uploader retries in the background and eventually catches up.
 *
 * Flush policy: every 250ms, every 32 events, or every 8KB — whichever
 * fires first. Single-flight (never two concurrent POSTs).
 *
 * Heartbeat: if no event has fired for 5s, emit `{kind: "heartbeat"}` so
 * the client can tell "alive but quiet" from "dead connection."
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const FLUSH_INTERVAL_MS = 250;
const FLUSH_MAX_EVENTS = 32;
const FLUSH_MAX_BYTES = 8 * 1024;
const HEARTBEAT_INTERVAL_MS = 5000;
const MAX_RETRY_BACKOFF_MS = 30_000;
const INITIAL_RETRY_BACKOFF_MS = 1_000;

export class EventUploader {
  constructor({ url, secret, sessionId, turnId, stateDir, logger = console }) {
    this.url = url;
    this.secret = secret;
    this.sessionId = sessionId;
    this.turnId = turnId;
    this.stateDir = stateDir;
    this.logger = logger;

    this.buffer = [];
    this.bufferBytes = 0;
    this.nextSeq = 0;
    this.lastAckedSeq = -1;
    this.inFlight = false;
    this.disposed = false;
    this.lastEventAt = 0;
    this.retryBackoffMs = INITIAL_RETRY_BACKOFF_MS;

    mkdirSync(stateDir, { recursive: true });
    this.eventsPath = join(stateDir, "events.jsonl");
    this.ackedPath = join(stateDir, "last-acked.txt");

    if (existsSync(this.ackedPath)) {
      const raw = readFileSync(this.ackedPath, "utf8").trim();
      const parsed = parseInt(raw, 10);
      if (Number.isFinite(parsed)) this.lastAckedSeq = parsed;
    }

    if (existsSync(this.eventsPath)) {
      const lines = readFileSync(this.eventsPath, "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          if (Number.isFinite(ev.seq) && ev.seq >= this.nextSeq) this.nextSeq = ev.seq + 1;
          if (Number.isFinite(ev.seq) && ev.seq > this.lastAckedSeq) {
            this.buffer.push(ev);
            this.bufferBytes += line.length + 1;
          }
        } catch {}
      }
    }

    this.flushTimer = setInterval(() => { void this._flushIfNeeded(); }, FLUSH_INTERVAL_MS);
    this.heartbeatTimer = setInterval(() => { this._maybeHeartbeat(); }, HEARTBEAT_INTERVAL_MS);
  }

  emit(kind, payload = {}) {
    if (this.disposed) return;
    const event = {
      sessionId: this.sessionId,
      seq: this.nextSeq++,
      kind,
      payload,
      createdAt: new Date().toISOString(),
      turnId: this.turnId,
    };
    const line = JSON.stringify(event);
    try {
      appendFileSync(this.eventsPath, line + "\n");
    } catch (err) {
      this.logger.error("uploader: failed to persist event to disk", err);
    }
    this.buffer.push(event);
    this.bufferBytes += line.length + 1;
    this.lastEventAt = Date.now();

    if (this.buffer.length >= FLUSH_MAX_EVENTS || this.bufferBytes >= FLUSH_MAX_BYTES) {
      void this._flushIfNeeded();
    }
  }

  _maybeHeartbeat() {
    if (this.disposed) return;
    if (Date.now() - this.lastEventAt < HEARTBEAT_INTERVAL_MS) return;
    this.emit("heartbeat", {});
  }

  async _flushIfNeeded() {
    if (this.inFlight || this.disposed || this.buffer.length === 0) return;
    this.inFlight = true;
    const batch = this.buffer.slice();
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-PocketEngineer-Ingest-Secret": this.secret,
        },
        body: JSON.stringify({ events: batch }),
      });
      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        throw new Error(`ingest ${response.status}: ${bodyText.slice(0, 200)}`);
      }
      const result = await response.json();
      const accepted = result.acceptedThroughSeq;

      let cutoff;
      if (Number.isFinite(accepted)) {
        cutoff = accepted;
      } else {
        cutoff = batch[batch.length - 1].seq;
      }
      this.buffer = this.buffer.filter((e) => e.seq > cutoff);
      this.bufferBytes = this.buffer.reduce((n, e) => n + JSON.stringify(e).length + 1, 0);
      this.lastAckedSeq = Math.max(this.lastAckedSeq, cutoff);
      try {
        writeFileSync(this.ackedPath, String(this.lastAckedSeq));
      } catch (err) {
        this.logger.error("uploader: failed to persist ack cursor", err);
      }
      this.retryBackoffMs = INITIAL_RETRY_BACKOFF_MS;
    } catch (err) {
      this.logger.error(`uploader: flush failed (buffer=${this.buffer.length}): ${err.message}`);
      await new Promise((r) => setTimeout(r, this.retryBackoffMs));
      this.retryBackoffMs = Math.min(this.retryBackoffMs * 2, MAX_RETRY_BACKOFF_MS);
    } finally {
      this.inFlight = false;
    }
  }

  async drain({ maxWaitMs = 10_000 } = {}) {
    const deadline = Date.now() + maxWaitMs;
    while (this.buffer.length > 0 && Date.now() < deadline) {
      await this._flushIfNeeded();
      if (this.buffer.length > 0) await new Promise((r) => setTimeout(r, 100));
    }
    this.dispose();
  }

  dispose() {
    this.disposed = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.flushTimer = null;
    this.heartbeatTimer = null;
  }
}

export function createUploaderFromEnv({ sessionId, turnId }) {
  const url = process.env.PE_INGEST_URL;
  const secret = process.env.PE_INGEST_SECRET;
  if (!url || !secret || !sessionId) return null;
  const stateDir = process.env.PE_STATE_DIR
    ? join(process.env.PE_STATE_DIR, sessionId)
    : join(process.env.HOME || "/tmp", ".pocketeng", "sessions", sessionId);
  const resolvedTurnId = turnId || process.env.PE_TURN_ID || randomUUID();
  return new EventUploader({ url, secret, sessionId, turnId: resolvedTurnId, stateDir });
}
