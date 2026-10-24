# Agent Bridge (backend-shipped)

Node.js ES modules that normalize output from Codex and OpenCode SDKs into the
session event stream (`pe-session-events-prod`) and the Claude Code NDJSON
format that existing consumers still read from stdout.

## Why it lives here

These files are **shipped to each EC2 workspace on-demand** via SFTP by the
backend (`src/lib/bridge_deploy.py`) at session launch. The bridge version is
therefore locked to the backend deploy — no npm registry, no per-VM version
drift, no coordinated release between two packages. Ship the backend, ship
the bridge atomically.

The SDK dependencies (`@openai/codex-sdk`, `@opencode-ai/sdk`) are installed
globally on the VM via `userdata.py`. The deployed bridge dir gets a symlink
to `$(npm root -g)` so imports resolve.

## Files

- `bridge.mjs` — CLI entry point. `--agent codex|opencode`, `--session-id`,
  reads the prompt from stdin, emits NDJSON to stdout AND (if
  `PE_INGEST_URL` + `PE_INGEST_SECRET` are set) posts structured session
  events to the backend ingest endpoint.
- `uploader.mjs` — `EventUploader` class. Disk-buffered (`events.jsonl`),
  single-flight HTTP POST, exponential-backoff retry, heartbeat every 5s,
  drain-before-exit.
- `uploader.test.mjs` — `node --test` unit tests (13 tests, no network,
  mock HTTP server stood up in-process).

## Environment variables

| Name | Required | Purpose |
|---|---|---|
| `PE_INGEST_URL` | no | full ingest URL; absent → uploader is a no-op |
| `PE_INGEST_SECRET` | no | shared secret; same one the completion hook uses |
| `PE_TURN_ID` | no | groups events for one prompt; auto-generated if absent |
| `PE_STATE_DIR` | no | override for uploader disk state; defaults to `~/.pocketeng/sessions/` |

## Running tests

```bash
cd backend/src/lib/bridge
node --test
```

## Wire contract (must match backend)

Events posted to `POST /internal/sessions/{sessionId}/events`:

```json
{
  "sessionId": "sess-abc",
  "seq": 7,
  "kind": "assistant.message",
  "payload": { "text": "..." },
  "createdAt": "2026-04-17T10:00:03Z",
  "turnId": "turn-xyz"
}
```

Kinds: `run.started`, `assistant.message`, `tool.started`, `tool.finished`,
`status`, `run.finished`, `heartbeat`. Bridge assigns `seq` monotonically
per session; backend dedups on `(sessionId, seq)`.
