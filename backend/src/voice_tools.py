"""
POST /voice/retell — webhook receiver for Retell AI voice agent tool calls.

Retell runs the voice agent (STT + Sonnet + TTS) on their infra. When the
caller says something the LLM interprets as a tool call, Retell POSTs here
with `{name, args, call: {from_number, ...}}`. We run the tool and return
`{result: "<short TTS-friendly string>"}`.

Auth model:
  - The webhook URL carries a secret query param (`?secret=...`) — Retell
    doesn't sign tool-call webhooks at the protocol level, so this is the
    primary gate.
  - The caller's phone number must be registered in pe-sms-mappings-prod
    (we reuse the SMS allowlist — no separate voice mapping table).

Response shape (what Retell expects):
  {"result": "spoken response"}

Long-running actions (send_message) kick off a Claude run and return
immediately — we don't hold the call open. The completion hook SMSes the
caller back when the agent finishes.
"""
import hmac
import json
import os
import time
from typing import Optional

import boto3

from src.lib.db import (
    get_messages,
    get_recent_session_events,
    get_server,
    get_servers_by_user,
    get_session,
    get_sessions_by_server,
)
from src.lib.transcript import materialize_transcript
from src.lib.voice import format_for_tts, resolve_session, resolve_workspace
from src.lib.agent_runner import (
    find_server_by_id,
    find_server_by_label,
    find_any_server,
    ensure_github_credentials,
)
from src.lib.ec2 import start_instance
from src.lib.kms import decrypt
from src.lib.ssh import ssh_connect, ssh_disconnect


_ddb = boto3.resource("dynamodb")
_SMS_TABLE = os.environ.get("SMS_MAPPINGS_TABLE", "pe-sms-mappings-prod")


def respond(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def _ok(result: str):
    """Retell tool-call response shape. Always 200 — non-2xx makes Retell
    abort the tool and the caller hears 'I'm having trouble', which is
    worse UX than speaking the error."""
    return respond(200, {"result": result})


# ── Auth ─────────────────────────────────────────────────────────────────────

def _auth_ok(event) -> bool:
    """Constant-time compare the webhook secret. Retell includes it in the
    URL query string when the agent is configured via setup_retell.py."""
    expected = os.environ.get("RETELL_WEBHOOK_SECRET", "").strip()
    if not expected:
        return False
    qs = event.get("queryStringParameters") or {}
    provided = (
        qs.get("secret")
        or (event.get("headers") or {}).get("x-retell-secret")
        or (event.get("headers") or {}).get("X-Retell-Secret")
        or ""
    )
    return hmac.compare_digest(provided, expected)


def _normalize_phone(phone: str) -> str:
    phone = (phone or "").strip()
    if not phone:
        return ""
    if not phone.startswith("+"):
        phone = "+" + phone
    return phone


def _caller_mapping(phone: str) -> Optional[dict]:
    """Look up the caller in the existing SMS mapping table. Returns the
    mapping dict (with userId, defaultServerId) or None if not registered."""
    if not phone:
        return None
    table = _ddb.Table(_SMS_TABLE)
    resp = table.get_item(Key={"phoneNumber": phone})
    return resp.get("Item")


# ── Tool implementations ─────────────────────────────────────────────────────

def _tool_list_workspaces(mapping: dict, args: dict) -> str:
    user_id = mapping["userId"]
    servers = get_servers_by_user(user_id)
    active = [s for s in servers if s.get("instanceState") != "terminated"]
    if not active:
        return "You don't have any workspaces yet. Set one up on pocket eng dot ai first."

    # "rfm-api is running; pocketeng is stopped; 1 more."
    parts = []
    for s in active[:5]:
        label = s.get("label") or s["serverId"][:8]
        state = s.get("instanceState", "unknown")
        parts.append(f"{label} is {state}")
    overflow = len(active) - 5
    out = "; ".join(parts)
    if overflow > 0:
        out += f"; and {overflow} more"
    return out + "."


def _tool_list_sessions(mapping: dict, args: dict) -> str:
    user_id = mapping["userId"]
    workspace_hint = args.get("workspace")

    servers = get_servers_by_user(user_id)
    active = [s for s in servers if s.get("instanceState") != "terminated"]
    if not active:
        return "You don't have any workspaces yet."

    if workspace_hint:
        target = resolve_workspace(active, workspace_hint)
        if not target:
            return f"I couldn't find a workspace matching {workspace_hint}."
        targets = [target]
    else:
        targets = active

    lines = []
    for s in targets:
        sessions = get_sessions_by_server(s["serverId"], limit=5)
        label = s.get("label") or s["serverId"][:8]
        if not sessions:
            if workspace_hint:
                lines.append(f"No sessions yet on {label}.")
            continue
        for sess in sessions[:3]:
            prompt = (sess.get("lastPrompt") or sess.get("prompt") or "").strip()
            prompt_snippet = prompt[:60]
            status = sess.get("status", "unknown")
            lines.append(f"On {label}: {prompt_snippet!r} — {status}")

    if not lines:
        return "No sessions found."
    return format_for_tts(". ".join(lines), max_chars=500)


def _tool_read_session(mapping: dict, args: dict) -> str:
    user_id = mapping["userId"]
    workspace_hint = args.get("workspace")
    session_hint = args.get("session")

    servers = get_servers_by_user(user_id)
    active = [s for s in servers if s.get("instanceState") != "terminated"]
    if not active:
        return "You don't have any workspaces yet."

    # Resolve workspace first if hint given; otherwise search across all.
    search_servers = active
    if workspace_hint:
        target = resolve_workspace(active, workspace_hint)
        if target:
            search_servers = [target]

    # Collect recent sessions across the search set.
    candidate_sessions = []
    for s in search_servers:
        candidate_sessions.extend(get_sessions_by_server(s["serverId"], limit=10))

    if not candidate_sessions:
        return "I don't see any recent sessions."

    session = resolve_session(candidate_sessions, session_hint)
    if not session:
        return (
            "I couldn't match that to a session. Try describing what the "
            "session is about, like 'the auth bug one'."
        )

    session_id = session["sessionId"]
    messages = get_messages(session_id)
    transcript = materialize_transcript(messages, session_status=session.get("status", "done"))
    # Walk backwards for the last assistant message with content.
    for item in reversed(transcript):
        if item.get("role") == "assistant" and item.get("content"):
            status = session.get("status", "done")
            suffix = f" The session is {status}." if status in ("running", "error") else ""
            return format_for_tts(item["content"], max_chars=380) + suffix

    return "The agent hasn't replied yet in that session."


def _tool_session_status(mapping: dict, args: dict) -> str:
    """Describe what a session is doing right now — the currently-running
    tool call (if any), how long it's been running, and the tail of the
    last thing the agent said. Lets the caller ask "what's it up to" and
    "keep me posted" without reloading the whole transcript.

    Uses pe-session-events-prod directly (not pe-messages-prod) because
    events update every 250ms as the bridge emits them — messages are a
    coarser snapshot."""
    user_id = mapping["userId"]
    workspace_hint = args.get("workspace")
    session_hint = args.get("session")

    servers = get_servers_by_user(user_id)
    active = [s for s in servers if s.get("instanceState") != "terminated"]
    if not active:
        return "You don't have any workspaces yet."

    search_servers = active
    if workspace_hint:
        target = resolve_workspace(active, workspace_hint)
        if target:
            search_servers = [target]

    candidates = []
    for s in search_servers:
        candidates.extend(get_sessions_by_server(s["serverId"], limit=10))
    if not candidates:
        return "I don't see any recent sessions."

    session = resolve_session(candidates, session_hint)
    if not session:
        return (
            "I couldn't match that to a session. Try describing what it's "
            "about."
        )

    session_id = session["sessionId"]
    status = session.get("status", "unknown")
    if status in ("done", "cancelled", "error"):
        # Not running — defer to read_session's summary instead.
        return (
            f"That session has finished (status: {status}). "
            f"Ask me to read it if you want the result."
        )

    events = get_recent_session_events(session_id, limit=50)
    if not events:
        return "The session is running but hasn't emitted anything yet."

    # Pair tool.started → tool.finished to find what's currently in-flight.
    open_tool = None
    last_text = ""
    for ev in events:
        kind = ev.get("kind")
        payload = ev.get("payload") or {}
        if kind == "tool.started":
            open_tool = {
                "name": payload.get("toolName", "a tool"),
                "input": payload.get("input"),
                "call_id": payload.get("toolCallId"),
                "started_at": ev.get("createdAt"),
            }
        elif kind == "tool.finished":
            if open_tool and open_tool.get("call_id") == payload.get("toolCallId"):
                open_tool = None
        elif kind == "assistant.message":
            text = payload.get("text")
            if isinstance(text, str) and text:
                last_text = text

    parts = []
    if open_tool:
        name = open_tool["name"]
        cmd_hint = ""
        tool_input = open_tool.get("input")
        if isinstance(tool_input, dict):
            snippet = (
                tool_input.get("command")
                or tool_input.get("file_path")
                or tool_input.get("pattern")
                or ""
            )
            if snippet:
                cmd_hint = f" — {str(snippet)[:60]}"
        elapsed = _seconds_since(open_tool.get("started_at"))
        if elapsed:
            parts.append(f"Running {name}{cmd_hint} for {elapsed}")
        else:
            parts.append(f"Running {name}{cmd_hint}")
    else:
        parts.append("Thinking")

    if last_text:
        parts.append("Last said: " + format_for_tts(last_text, max_chars=200))

    return format_for_tts(". ".join(parts), max_chars=380)


def _seconds_since(iso_ts) -> str:
    """Human-friendly elapsed string from an ISO8601 timestamp. Returns ''
    if the input is unusable — caller treats that as "skip the elapsed bit"."""
    if not iso_ts or not isinstance(iso_ts, str):
        return ""
    from datetime import datetime, timezone
    try:
        # Support both "…Z" and "+00:00" suffixes.
        cleaned = iso_ts.replace("Z", "+00:00")
        started = datetime.fromisoformat(cleaned)
        delta = (datetime.now(timezone.utc) - started).total_seconds()
    except Exception:
        return ""
    if delta < 5:
        return "a few seconds"
    if delta < 90:
        return f"{int(delta)} seconds"
    mins = int(delta / 60)
    if mins < 90:
        return f"{mins} minute{'s' if mins != 1 else ''}"
    hours = int(delta / 3600)
    return f"{hours} hour{'s' if hours != 1 else ''}"


# Prefix prepended to every voice-initiated prompt. Tells the workspace
# agent that its reply will be spoken aloud through TTS, so it should keep
# the response short, skip tool-call narration, and state conclusions
# instead of process. Credit to callclaude (incidentfox/callclaude) — this
# single-line hack turns out to be enough; no system-prompt threading or
# special agent mode required.
_VOICE_PROMPT_PREFIX = (
    "[LIVE VOICE CALL — respond quickly and concisely, someone is on the "
    "phone waiting. Skip tool-call narration, no code blocks, state "
    "conclusions not process, keep it to 2-3 sentences.]"
)


# Bounds for the synchronous wait-for-reply path. Upper bound is
# constrained by:
#   - Lambda timeout (60s) minus ~10s for SSH + _launch_turn + response
#     serialization ≈ 45s wall-clock budget for polling.
#   - Phone-call UX: ~30s of dead air feels broken; speak_during_execution
#     on the Retell side fills it with "let me check", but 45s is the
#     polite ceiling even with fillers.
_WAIT_DEFAULT_S = 25
_WAIT_MAX_S = 45

# Fallback Lambda-timeout guard: leave this many seconds of headroom so
# we can serialize and return a reply before API Gateway cuts us off.
_LAMBDA_BUDGET_RESERVE_S = 8


def _wait_for_turn_reply(
    session_id: str,
    pre_seq: int,
    deadline: float,
    poll_interval: float = 1.5,
) -> Optional[str]:
    """Poll pe-session-events-prod until the turn we just launched emits
    `run.finished`, then return the concatenated assistant-message text
    from that turn. Returns None if the turn didn't finish before the
    deadline — caller falls back to "still working, I'll notify you."

    Args:
      session_id: the session we launched into.
      pre_seq: the highest seq that already existed BEFORE our launch. Any
        event with seq > pre_seq belongs to our new turn (or a turn that
        landed while we were still SSH'ing — either way, we surface it).
      deadline: wall-clock `time.time()` cutoff; we stop polling past it.
      poll_interval: seconds between DDB reads. Claude emits events at
        ~250ms intervals via the bridge; 1.5s strikes a balance between
        responsiveness and DDB read cost per call.

    Why not use run.started as the anchor instead of pre_seq?
      run.started comes seconds after _launch_turn returns (bridge has to
      spawn, SDK has to warm up). By then we might already have polled
      once or twice and seen nothing. Tracking pre_seq locally is simpler
      and handles the edge case where two turns overlap (shouldn't happen
      in the voice path, but be defensive).
    """
    while time.time() < deadline:
        try:
            events = get_recent_session_events(session_id, limit=100)
        except Exception as exc:  # transient DDB issue — keep polling
            print(f"voice: get_recent_session_events failed: {exc}")
            time.sleep(poll_interval)
            continue

        assistant_texts: list[str] = []
        run_finished_payload: Optional[dict] = None

        for ev in events:
            if int(ev.get("seq", 0)) <= pre_seq:
                continue
            kind = ev.get("kind")
            payload = ev.get("payload") or {}
            if kind == "assistant.message":
                text = payload.get("text")
                if isinstance(text, str) and text.strip():
                    assistant_texts.append(text.strip())
            elif kind == "run.finished":
                run_finished_payload = payload

        if run_finished_payload is not None:
            # Turn is done — hand back the reply (or the error).
            outcome = run_finished_payload.get("outcome")
            if outcome != "success":
                err = run_finished_payload.get("error") or "unknown error"
                return (
                    "The agent errored: "
                    + format_for_tts(str(err), max_chars=200)
                )
            if assistant_texts:
                # Agents often emit multiple assistant.message events per
                # turn (streaming chunks merged into deltas + a final).
                # Join with a space; format_for_tts handles length.
                joined = " ".join(assistant_texts)
                return format_for_tts(joined, max_chars=500)
            # Unusual: run completed cleanly with zero assistant text.
            # Most common cause: a tool-only turn that finishes without
            # speaking. Say something rather than returning empty.
            return "Done — the agent didn't speak a reply for that turn."

        time.sleep(poll_interval)

    return None


def _tool_send_message(mapping: dict, args: dict) -> str:
    """Kick off a new turn on an existing session (or start a new one).

    Two behaviors, controlled by `wait_for_response`:
      - False (default): fire-and-forget. Returns immediately with a "check
        the app" line. Push notifications deliver the completion.
      - True: block on the call, poll session events, return the agent's
        reply when the run finishes (or "still working" on timeout). This
        is the back-and-forth brainstorming path — same flow as
        callclaude's `-w -t` wait mode.
    """
    user_id = mapping["userId"]
    message = (args.get("message") or "").strip()
    if not message:
        return "What message would you like to send?"

    workspace_hint = args.get("workspace")
    session_hint = args.get("session")
    wait_for_response = bool(args.get("wait_for_response"))
    # Clamp the requested wait into the allowed range. Retell's LLM can
    # pass anything the tool schema accepts (int or float); be tolerant.
    try:
        requested_timeout = int(args.get("timeout") or _WAIT_DEFAULT_S)
    except (TypeError, ValueError):
        requested_timeout = _WAIT_DEFAULT_S
    wait_timeout_s = max(5, min(requested_timeout, _WAIT_MAX_S))

    # Resolve workspace.
    server, needs_start = None, False
    if workspace_hint:
        hit = find_server_by_label(user_id, workspace_hint)
        if hit[0]:
            server, needs_start = hit
    if not server and mapping.get("defaultServerId"):
        hit = find_server_by_id(mapping["defaultServerId"])
        if hit[0]:
            server, needs_start = hit
    if not server:
        server, needs_start = find_any_server(user_id)
    if not server:
        return "You don't have any workspaces to run this on."

    # If the workspace is stopped, don't block the call on the ~1 min EC2
    # start. Kick it off and tell the caller to try again in a minute.
    if needs_start:
        try:
            start_instance(server["instanceId"])
        except Exception as exc:
            print(f"voice: start_instance failed for {server['serverId']}: {exc}")
        label = server.get("label") or server["serverId"][:8]
        return (
            f"Your {label} workspace was stopped — I'm starting it up. "
            f"Call me back in about a minute and try again."
        )

    # Try to resume an existing session matching the hint.
    resume_session_id = None
    if session_hint:
        sessions = get_sessions_by_server(server["serverId"], limit=10)
        hit = resolve_session(sessions, session_hint)
        if hit:
            resume_session_id = hit["sessionId"]

    # For the wait-and-return path we need a seq cutoff so we only count
    # events from the turn we're about to launch, not any prior history.
    # Capture BEFORE _launch_turn because SSH + spawn adds latency and
    # events can start arriving before the function returns.
    pre_seq = 0
    if wait_for_response and resume_session_id:
        try:
            prior = get_recent_session_events(resume_session_id, limit=1)
            if prior:
                pre_seq = int(prior[-1].get("seq", 0))
        except Exception as exc:
            print(f"voice: pre-seq lookup failed: {exc}")

    # Prepend the voice directive so the agent trims its reply shape.
    # Cheap to apply (it's just text); powerful in effect.
    prompt = f"{_VOICE_PROMPT_PREFIX} {message}"

    # Launch via the same path chat.py uses for web requests.
    from src.chat import _launch_turn  # lazy import — chat imports a lot

    private_key_pem = decrypt(server["sshPrivateKey"])
    ssh_user = server.get("sshUser", "ec2-user")
    client = ssh_connect(server["publicIp"], private_key_pem, ssh_user)

    launch_start = time.time()
    try:
        ensure_github_credentials(client, user_id)
        body = {"prompt": prompt, "agent": "claude", "workdir": "~/projects"}
        if resume_session_id:
            body["resumeSessionId"] = resume_session_id

        result = _launch_turn(client, body, server["serverId"], user_id, event=None)
    finally:
        ssh_disconnect(client)

    result_body = {}
    try:
        result_body = json.loads(result.get("body", "{}"))
    except Exception:
        pass

    if result.get("statusCode") != 200:
        return "I hit an error starting that. " + format_for_tts(
            result_body.get("error", ""), max_chars=120
        )

    label = server.get("label") or server["serverId"][:8]
    session_id = result_body.get("sessionId")

    if wait_for_response and session_id:
        # Compute the wall-clock deadline accounting for (a) what the user
        # asked for, and (b) Lambda's remaining budget. Prefer the smaller
        # of the two so we never get killed mid-response.
        elapsed = time.time() - launch_start
        lambda_budget = max(0, 60 - elapsed - _LAMBDA_BUDGET_RESERVE_S)
        deadline = time.time() + min(wait_timeout_s, lambda_budget)

        reply = _wait_for_turn_reply(session_id, pre_seq, deadline)
        if reply is not None:
            return reply
        # Timed out. Tell the caller we're still working; push notification
        # will still fire when the agent actually finishes.
        return (
            f"Still working on it on {label}. "
            f"I'll push-notify when it's done, or ask me again in a bit."
        )

    return (
        f"Kicked off on {label}. Check the pocket eng app to see when it's done."
    )


_TOOLS = {
    "list_workspaces": _tool_list_workspaces,
    "list_sessions": _tool_list_sessions,
    "read_session": _tool_read_session,
    "session_status": _tool_session_status,
}


# ── Handler ──────────────────────────────────────────────────────────────────

def _extract_call(body: dict) -> tuple[str, str, dict]:
    """Pull (tool_name, from_number, args) out of a Retell webhook payload.

    Retell's custom-tool webhooks send:
      {
        "name": "tool_name",
        "args": {...},
        "call": {"from_number": "+1...", ...},
        "call_id": "..."
      }
    """
    name = body.get("name") or body.get("tool_name") or ""
    args = body.get("args") or body.get("arguments") or {}
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except Exception:
            args = {}
    call = body.get("call") or {}
    from_number = (
        call.get("from_number")
        or call.get("from")
        or body.get("from_number")
        or ""
    )
    return name, _normalize_phone(from_number), args if isinstance(args, dict) else {}


def handler(event, context):
    try:
        if not _auth_ok(event):
            return _ok("Authentication failed.")

        body_raw = event.get("body") or "{}"
        if event.get("isBase64Encoded"):
            import base64
            body_raw = base64.b64decode(body_raw).decode()
        try:
            body = json.loads(body_raw)
        except Exception:
            return _ok("I couldn't parse that request.")

        name, from_number, args = _extract_call(body)
        print(f"voice tool call: {name} from={from_number} args={json.dumps(args)[:200]}")

        if not name:
            return _ok("No tool was specified.")
        if not from_number:
            return _ok("I couldn't identify the caller's number.")

        mapping = _caller_mapping(from_number)
        if not mapping:
            return _ok(
                "This number isn't linked to a pocket eng account. "
                "Register it on pocket eng dot ai slash settings first."
            )

        # Dispatch.
        try:
            if name == "send_message":
                result = _tool_send_message(mapping, args)
            elif name in _TOOLS:
                result = _TOOLS[name](mapping, args)
            else:
                result = f"I don't have a tool called {name}."
        except Exception as exc:
            import traceback
            print(f"voice tool {name} failed: {exc}\n{traceback.format_exc()}")
            result = "Something went wrong running that — try again?"

        return _ok(result)

    except Exception as exc:
        import traceback
        print(f"voice handler crashed: {exc}\n{traceback.format_exc()}")
        return _ok("I hit an unexpected error. Try again?")
