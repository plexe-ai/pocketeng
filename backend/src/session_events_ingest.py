"""
POST /internal/sessions/{sessionId}/events — event stream ingest.

Called by the agent-bridge uploader running on the EC2 workspace. Auth is a
shared secret header (reused from the completion hook — same VM→backend
trust boundary).

Events arrive in batches. The agent is the authoritative seq assigner, so
we dedup by (sessionId, seq) via ConditionExpression in DynamoDB. Duplicate
retries are a no-op.

If a batch contains a `run.finished` event, we fire the existing completion
side effects (validation harness + push notifications). That call is
idempotent via `claim_session_notification`, so triple-fire from this path
+ the VM `completion_hook` + the watchdog is safe.
"""
import hmac
import json
import os
from datetime import datetime, timezone

from src.lib.db import (
    advance_session_event_cursor,
    get_session,
    put_message,
    put_session_events_batch,
    reserve_message_seqs,
    update_session,
)


ALLOWED_KINDS = {
    "run.started",
    "assistant.message",
    # Token-level streaming: when the Claude bridge is run with
    # `includePartialMessages: true`, it emits `assistant.text_delta`
    # events containing small chunks of text as the model produces them.
    # The UI appends these to the in-progress text block so the reply
    # streams in visibly instead of arriving as one blob.
    "assistant.text_delta",
    "tool.started",
    "tool.finished",
    "status",
    "run.finished",
    "heartbeat",
    # Emitted by the bridge when an agent reveals its real internal
    # session id after startup. Codex is the motivating case: its SDK
    # owns the rollout UUID and ignores any id we try to pass in, so the
    # bridge forwards `thread.started.thread_id` here. Without this, the
    # DDB session row's `remoteSessionId` stays a ghost UUID and the
    # sync daemon round-trips the rollout file, registering it as a
    # brand-new session (a duplicate).
    "session.remote",
}

MAX_BATCH_SIZE = 200
MAX_PAYLOAD_BYTES = 32_768
_TOOL_PAYLOAD_STRING_LIMITS = (16_000, 8_000, 4_000, 2_000, 1_000, 500, 200)

# Event kinds that carry transcript-visible content. Everything else
# (run.started, status, heartbeat, assistant.text_delta) either has no
# transcript footprint or is subsumed by the final assistant.message
# snapshot, so we skip them in the messages-table mirror.
MIRRORED_KINDS = {
    "assistant.message",
    "tool.started",
    "tool.finished",
    "run.finished",
}


def _event_to_native_line(event, session_id):
    """Convert a bridge event to the Claude-native NDJSON line that
    materialize_transcript consumes. Returns None for kinds we don't mirror
    or payloads that don't carry renderable content."""
    kind = event.get("kind")
    payload = event.get("payload") or {}

    if kind == "assistant.message":
        text = payload.get("text")
        if not isinstance(text, str) or not text:
            return None
        return json.dumps({
            "type": "assistant",
            "message": {"content": [{"type": "text", "text": text}]},
            "session_id": session_id,
        }, separators=(",", ":"))

    if kind == "tool.started":
        name = payload.get("toolName") or "unknown"
        tool_input = payload.get("input")
        return json.dumps({
            "type": "tool_use",
            "tool": {"name": name, "input": tool_input},
            "session_id": session_id,
        }, separators=(",", ":"))

    if kind == "tool.finished":
        return json.dumps({
            "type": "tool_result",
            "content": payload.get("output", ""),
            "is_error": bool(payload.get("isError", False)),
            "session_id": session_id,
        }, separators=(",", ":"))

    if kind == "run.finished":
        outcome = payload.get("outcome") or "success"
        line = {
            "type": "result",
            "subtype": outcome,
            "session_id": session_id,
        }
        if outcome != "success":
            line["is_error"] = True
            err = payload.get("error")
            if err:
                line["result"] = err
        duration = payload.get("durationMs")
        if duration is not None:
            line["duration_ms"] = duration
        return json.dumps(line, separators=(",", ":"))

    return None


def _payload_size(payload):
    # Enforce the actual UTF-8 payload size we send/store. The older
    # json.dumps(...) character count could over-count escaped non-ASCII
    # text and under-model the real 32 KiB limit this endpoint protects.
    dumped = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    return len(dumped.encode("utf-8"))


def _truncate_string(value, max_chars):
    if not isinstance(value, str) or len(value) <= max_chars:
        return value

    omitted = len(value) - max_chars
    while True:
        suffix = f"\n...[truncated {omitted} chars]"
        head_len = max(0, max_chars - len(suffix))
        new_omitted = len(value) - head_len
        if new_omitted == omitted:
            return value[:head_len] + suffix
        omitted = new_omitted


def _truncate_strings(value, max_chars):
    if isinstance(value, str):
        return _truncate_string(value, max_chars)
    if isinstance(value, list):
        return [_truncate_strings(v, max_chars) for v in value]
    if isinstance(value, dict):
        return {k: _truncate_strings(v, max_chars) for k, v in value.items()}
    return value


def _compact_tool_started_payload(payload):
    """Trim huge tool-start inputs so one large Write/Edit/Bash call
    cannot poison the uploader buffer and block every later event."""
    if not isinstance(payload, dict):
        return payload
    if _payload_size(payload) <= MAX_PAYLOAD_BYTES:
        return payload

    base = {k: v for k, v in payload.items() if k != "input"}
    raw_input = payload.get("input")

    for max_chars in _TOOL_PAYLOAD_STRING_LIMITS:
        candidate = {
            **base,
            "input": _truncate_strings(raw_input, max_chars),
        }
        if _payload_size(candidate) <= MAX_PAYLOAD_BYTES:
            return candidate

    summarized_input = None
    if isinstance(raw_input, dict):
        summarized_input = {}
        for key in ("file_path", "command", "description", "old_string", "new_string", "content"):
            if key not in raw_input:
                continue
            val = raw_input[key]
            if key == "content" and isinstance(val, str):
                summarized_input["contentLength"] = len(val)
            summarized_input[key] = _truncate_strings(val, 200)
        if not summarized_input:
            summarized_input = _truncate_strings(raw_input, 200)
    elif raw_input is not None:
        summarized_input = _truncate_strings(raw_input, 200)

    fallback = {
        "toolName": payload.get("toolName") or "unknown",
        "toolCallId": payload.get("toolCallId"),
        "truncated": True,
    }
    if summarized_input is not None:
        fallback["input"] = summarized_input
    return fallback


def _normalize_payload(kind, payload):
    # Most event payloads are already small. The main pathological case is
    # tool.started for a large Write/Edit call, where the full file body is
    # embedded in payload.input and can exceed our ingest limit by itself.
    if kind == "tool.started":
        return _compact_tool_started_payload(payload)
    return payload


def _mirror_events_to_messages(session_id, prepared_events):
    """Write transcript-visible events to pe-messages-prod so reload via
    GET /sessions/{id}/messages shows the agent reply even when the EC2
    completion callback hasn't fired yet (or never fires).

    Seq allocation is atomic via reserve_message_seqs so two concurrent
    ingests can't overwrite each other's rows. We first collect the set
    of native lines to write, then reserve that many seqs in one shot."""
    native_lines = []
    for event in prepared_events:
        if event.get("kind") not in MIRRORED_KINDS:
            continue
        line = _event_to_native_line(event, session_id)
        if line:
            native_lines.append(line)

    if not native_lines:
        return

    start_seq = reserve_message_seqs(session_id, len(native_lines))
    if start_seq is None:
        # Session row missing nextSeq — shouldn't happen for sessions that
        # went through chat.py, but skip rather than corrupt the message
        # stream.
        return

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    for offset, native_line in enumerate(native_lines):
        try:
            put_message(session_id, start_seq + offset, "agent", native_line, now)
        except Exception as exc:
            print(f"mirror: put_message failed for {session_id} seq={start_seq + offset}: {exc}")


def respond(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def _extract_ingest_secret(headers):
    headers = headers or {}
    return (
        headers.get("x-pocketengineer-ingest-secret")
        or headers.get("X-PocketEngineer-Ingest-Secret")
        or headers.get("x-pocketengineer-completion-secret")
        or headers.get("X-PocketEngineer-Completion-Secret")
        or ""
    )


def _validate_event(event):
    if not isinstance(event, dict):
        return "event must be an object"
    kind = event.get("kind")
    if kind not in ALLOWED_KINDS:
        return f"unknown kind: {kind!r}"
    try:
        seq = int(event["seq"])
    except (KeyError, TypeError, ValueError):
        return "seq must be an integer"
    if seq < 0:
        return "seq must be non-negative"
    if not event.get("createdAt"):
        return "createdAt required"
    payload = event.get("payload", {})
    if not isinstance(payload, dict):
        return "payload must be an object"
    if _payload_size(payload) > MAX_PAYLOAD_BYTES:
        return f"payload exceeds {MAX_PAYLOAD_BYTES} bytes"
    return None


def handler(event, context):
    try:
        expected_secret = os.environ.get("COMPLETION_CALLBACK_SECRET", "").strip()
        provided_secret = _extract_ingest_secret(event.get("headers"))
        if not expected_secret or not hmac.compare_digest(provided_secret, expected_secret):
            return respond(401, {"error": "Invalid ingest secret"})

        session_id = (event.get("pathParameters") or {}).get("sessionId")
        if not session_id:
            return respond(400, {"error": "sessionId required"})

        body = json.loads(event.get("body") or "{}")
        raw_events = body.get("events")
        if not isinstance(raw_events, list) or not raw_events:
            return respond(400, {"error": "events[] required"})
        if len(raw_events) > MAX_BATCH_SIZE:
            return respond(400, {"error": f"batch exceeds {MAX_BATCH_SIZE} events"})

        session = get_session(session_id)
        if not session:
            return respond(404, {"error": "Session not found"})

        prepared = []
        for idx, raw in enumerate(raw_events):
            normalized = {
                **raw,
                "payload": _normalize_payload(raw.get("kind"), raw.get("payload", {})),
            }
            err = _validate_event(normalized)
            if err:
                return respond(400, {"error": f"event[{idx}]: {err}"})
            if normalized["payload"] != raw.get("payload", {}):
                print(
                    "ingest: compacted oversize payload "
                    f"session={session_id} seq={raw.get('seq')} kind={raw.get('kind')}"
                )
            prepared.append({
                "sessionId": session_id,
                "seq": int(normalized["seq"]),
                "kind": normalized["kind"],
                "payload": normalized.get("payload", {}),
                "createdAt": normalized["createdAt"],
                "turnId": normalized.get("turnId"),
            })

        inserted, skipped, highest_seq = put_session_events_batch(prepared)

        if highest_seq is not None:
            last_event_at = max(e["createdAt"] for e in prepared)
            advance_session_event_cursor(session_id, highest_seq, last_event_at)

        # Mirror transcript-visible events to pe-messages-prod so a reload
        # mid-turn (or after a missed completion_hook) still sees the agent
        # reply. Only mirror events we actually inserted this call — dupes
        # from uploader retries would otherwise reserve and consume fresh
        # seqs for content that's already in the messages table.
        #
        # Never let a mirror failure fail the 200 — the events are already
        # durable in pe-session-events-prod and the uploader would re-send
        # the whole batch on non-2xx, producing spurious duplicate events.
        if inserted:
            try:
                # Within a single uploader batch, seqs are strictly
                # monotonic (bridge allocates consecutively, uploader
                # flushes in order). So the `inserted` newest events are
                # exactly the suffix (highest_seq - inserted, highest_seq].
                if skipped == 0:
                    inserted_events = prepared
                else:
                    threshold = highest_seq - inserted
                    inserted_events = [e for e in prepared if int(e["seq"]) > threshold]
                _mirror_events_to_messages(session_id, inserted_events)
            except Exception as exc:
                import traceback
                print(f"ingest: messages mirror failed for {session_id}: {exc}\n{traceback.format_exc()}")
        # Reconcile `remoteSessionId` with the agent-assigned id, if the
        # batch contained a session.remote event. Done after the batch
        # insert so replay is stable (the event row is persisted first).
        for e in prepared:
            if e["kind"] != "session.remote":
                continue
            rsid = (e.get("payload") or {}).get("remoteSessionId")
            if rsid and rsid != session.get("remoteSessionId"):
                try:
                    update_session(session_id, {"remoteSessionId": rsid})
                except Exception as exc:
                    import traceback
                    print(f"ingest: failed to update remoteSessionId for {session_id}: {exc}\n{traceback.format_exc()}")
                break

        has_run_finished = any(e["kind"] == "run.finished" for e in prepared)
        if has_run_finished:
            try:
                from src.chat import _complete_session_and_notify
                _complete_session_and_notify(session_id)
            except Exception as exc:
                import traceback
                print(f"ingest: _complete_session_and_notify failed for {session_id}: {exc}\n{traceback.format_exc()}")

        return respond(200, {
            "inserted": inserted,
            "skipped": skipped,
            "acceptedThroughSeq": highest_seq,
        })

    except json.JSONDecodeError:
        return respond(400, {"error": "Invalid JSON body"})
    except Exception as exc:
        import traceback
        print(f"Session events ingest error: {exc}\n{traceback.format_exc()}")
        return respond(500, {"error": str(exc)})
