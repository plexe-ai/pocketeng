# Voice (phone call) setup

Callers dial a Retell AI phone number → voice agent runs on Retell's infra → it
calls webhook tools on our API Gateway → Lambda talks to the same EC2 workspaces
as everything else.

Two shapes of interaction:

1. **Brainstorm / Q&A mode** (`send_message` with `wait_for_response: true`).
   Lambda holds the call briefly (~25s, capped at 45s), polls session events,
   returns the agent's reply so Retell can speak it. Supports real
   back-and-forth — keep passing the same `session` hint on follow-ups.
2. **Fire-and-forget task mode** (`send_message` with `wait_for_response: false`,
   the default). Lambda kicks off the turn and returns "on it". The Pocket
   Eng app push-notifies when the agent finishes.

Architecture:

```
phone
  │
  ▼
Retell AI  (STT + Claude Sonnet voice LLM + TTS)
  │  POST /voice/retell?secret=…
  ▼
VoiceToolsFunction (Lambda)
  ├─ list_workspaces   — describe_instances on user's servers
  ├─ list_sessions     — query pe-sessions-prod by serverId
  ├─ read_session      — get_messages + transcript materializer
  ├─ session_status    — query pe-session-events-prod for current tool/elapsed
  └─ send_message      — SSH → _launch_turn, prepends LIVE-VOICE-CALL hint
                          (wait_for_response) poll session events until
                          run.finished; speak assistant text back to caller
                          (fire-and-forget) return immediately; push-notify
                          on completion via the iOS/Android app
```

## One-time provider setup

1. **Create a Retell AI account** at <https://app.retellai.com>. Add billing.
2. **Generate API key** in Settings → API Keys.
3. **Pick a shared secret** for webhook auth — any random string, 32+ chars:

   ```bash
   openssl rand -hex 32
   ```

4. **Add the secret to SAM config.** Edit `backend/samconfig.toml` and append
   `RetellWebhookSecret=<that value>` to `parameter_overrides`, then redeploy:

   ```bash
   cd backend && sam deploy
   ```

5. **Provision the Retell agent + phone number** using the included script:

   ```bash
   export RETELL_API_KEY=...                    # from step 2
   export PE_API_BASE=https://<api-id>.execute-api.<region>.amazonaws.com/prod
   export RETELL_WEBHOOK_SECRET=...             # same value as step 3
   python backend/tools/setup_retell.py --buy-number --area-code 415
   ```

   This creates an LLM config (Claude Sonnet), an agent bound to it with the
   voice `11labs-Cimo`, and optionally purchases a number and binds it. Output
   includes the `agent_id` and `phone_number`. Without `--buy-number` you can
   bind an existing number in the Retell dashboard.

## Per-user setup

Each user who wants voice must register their personal phone in the existing
SMS allowlist (voice reuses it — no separate table):

```bash
curl -X POST "$PE_API_BASE/sms/register" \
  -H "Authorization: Bearer <user supabase jwt>" \
  -d '{"phoneNumber": "+14155551234", "defaultServerId": "<server-uuid>"}'
```

The `defaultServerId` is what `send_message` falls back to when the caller
doesn't name a workspace. The Settings page exposes the same flow — point
users there if they'd rather not curl.

## Testing

Unit tests cover the webhook path end-to-end with mocks:

```bash
cd backend && python3 -m pytest tests/test_voice_tools.py -v
```

Live smoke test with curl (replace secret + any registered number):

```bash
curl -sS -X POST "$PE_API_BASE/voice/retell?secret=$RETELL_WEBHOOK_SECRET" \
  -H 'content-type: application/json' \
  -d '{
    "name": "list_workspaces",
    "args": {},
    "call": {"from_number": "+14155551234"}
  }'
# → {"result": "pocketeng is running; rfm-api is stopped."}
```

## Supported tools

| Name | Args | Returns |
|---|---|---|
| `list_workspaces` | — | `"pocketeng is running; rfm-api is stopped."` |
| `list_sessions` | `workspace?` | last few sessions with status |
| `read_session` | `workspace?`, `session` | last assistant reply, TTS-shaped |
| `session_status` | `workspace?`, `session?` | "Running Bash — `npm test` — for 22s. Last said: …" |
| `send_message` | `message`, `workspace?`, `session?`, `wait_for_response?`, `timeout?` | see below |

All tools pick the caller's default workspace if the `workspace` hint is
missing.

**`send_message` behaviors:**
- `wait_for_response: true` → Lambda polls `pe-session-events-prod` for up
  to `timeout` seconds (default 25, max 45), concatenates `assistant.message`
  events from the new turn, returns the reply on `run.finished`. If the turn
  doesn't finish in time, returns "still working". This is the brainstorm
  path — the caller hears the agent's actual response spoken back.
- `wait_for_response: false` (default) → Fire-and-forget. Returns "kicked
  off, check the app" immediately. Push notification on completion.

Every `send_message` prompt is wrapped with a `[LIVE VOICE CALL — respond
quickly...]` prefix before it reaches the agent. This shortens the reply
shape without needing a system-prompt change on the agent side.

## Gotchas

- **Stopped workspaces.** `send_message` does not block on an EC2 start —
  the call would drop. Instead it kicks off `start_instance` asynchronously
  and tells the caller "try again in a minute." Subsequent calls with the
  workspace running go through normally.
- **Session resolution by voice.** Session UUIDs are not human-speakable.
  Callers describe the session ("the auth bug one") and we fuzzy-match
  against the session's `lastPrompt`. Tune the scoring in
  `src/lib/voice.py::resolve_session` if mismatches become common.
- **TTS shaping.** Long code blocks are replaced with
  `"(code block omitted)"` — Retell will read them verbatim otherwise.
  Tune `format_for_tts` in the same file.
- **Completion SMS.** Requires `LINQ_API_KEY` + `LINQ_FROM_NUMBER` env vars
  on `CompletionHookFunction` and `SessionEventsIngestFunction` (already
  wired in `template.yaml`). Without them, the voice kick-off works but the
  caller never gets the follow-up text.
