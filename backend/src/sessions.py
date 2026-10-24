"""
GET    /servers/{serverId}/sessions   — list recent sessions for a server
GET    /sessions/{sessionId}/messages — get all messages for a session
PATCH  /sessions/{sessionId}          — update a session's title
DELETE /sessions/{sessionId}          — delete a session
"""
import json
from datetime import datetime, timezone
from decimal import Decimal

from src.lib.auth import extract_auth_header, verify_token
from src.lib.db import (
    delete_messages_for_session,
    delete_session,
    delete_session_events_for_session,
    find_last_message,
    get_messages,
    get_server,
    get_session,
    get_sessions_by_server,
    update_session,
)
from src.lib.kms import decrypt
from src.lib.ssh import ssh_connect, ssh_disconnect
from src.lib.team_auth import can_access_owned_resource, can_delete_owned_resource, can_manage_owned_resource
from src.lib.transcript import materialize_transcript
from src.lib.worktree import cleanup_worktree

MAX_TITLE_LEN = 100
MAX_INITIAL_RAW_MESSAGES = 500


def _default(obj):
    if isinstance(obj, Decimal):
        return int(obj) if obj % 1 == 0 else float(obj)
    raise TypeError


def respond(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body, default=_default),
    }


def _latest_seq(messages, fallback=-1):
    if not messages:
        return fallback
    return int(messages[-1].get("seq", fallback))


def _message_seq(message, fallback=-1):
    if not message:
        return fallback
    return int(message.get("seq", fallback))


def _initial_load_window(messages, *, max_raw_messages=MAX_INITIAL_RAW_MESSAGES):
    """Return a coherent raw-message slice for initial transcript loads.

    Kept for the small-session / test path that already has the full
    message list in memory. The Lambda handler uses
    `_load_initial_window` directly so it never has to fetch the entire
    session before trimming.

    The slice must start on a user boundary when possible. Otherwise
    the transcript materializer sees a sparse "all users + tail
    agents" shape and renders orphaned user bubbles with their
    assistant replies missing — exactly the long-session bug the web
    UI was showing.
    """
    if len(messages) <= max_raw_messages:
        return messages, False

    start_idx = len(messages) - max_raw_messages
    if messages[start_idx].get("role") != "user":
        for idx in range(start_idx, -1, -1):
            if messages[idx].get("role") == "user":
                start_idx = idx
                break

    window = messages[start_idx:]
    return window, start_idx > 0


def _load_initial_window(session_id, *, max_raw_messages=MAX_INITIAL_RAW_MESSAGES):
    """Fetch the latest N raw rows directly from DynamoDB instead of
    pulling the whole session into memory and trimming.

    The naive approach — `get_messages(session_id)` then slice the
    last N — was an O(N) DDB scan. For sessions with thousands of raw
    rows that took 15-30 seconds and tripped the Lambda timeout (the
    "session won't load" symptom on session 819e2…). This shape uses
    `ScanIndexForward=False` + `Limit=N` so DDB returns just the last
    page directly, then rewinds via additional descending queries
    only if the start of that page lands mid-assistant.

    Returns `(window, has_more_before)`. `window` is in chronological
    order. `has_more_before` is True if older rows exist beyond the
    returned window.
    """
    tail_desc = get_messages(
        session_id,
        scan_forward=False,
        limit=max_raw_messages,
    )
    if not tail_desc:
        return [], False

    window = list(reversed(tail_desc))
    fetched_full_page = len(tail_desc) >= max_raw_messages

    # Rewind to user boundary only if we have a full page that starts
    # mid-assistant. If the descending fetch returned fewer than
    # max_raw_messages, we already have the entire session — no
    # rewind possible. Capped at MAX_REWIND_CHUNKS so a session with
    # no preceding user row at all (one user turn, thousands of agent
    # rows behind it) doesn't degrade into a full-table scan +
    # multi-MB response. After the cap we accept that the window may
    # start mid-assistant; the materializer will skip the
    # head-mid-assistant content rather than emit an orphan, and the
    # client can still call beforeSeq if the user wants more.
    MAX_REWIND_CHUNKS = 3
    if window[0].get("role") != "user" and fetched_full_page:
        boundary = _message_seq(window[0]) - 1
        rewind_desc = []
        chunks = 0
        while boundary >= 0 and chunks < MAX_REWIND_CHUNKS:
            chunk_desc = get_messages(
                session_id,
                to_seq=boundary,
                scan_forward=False,
                limit=max_raw_messages,
            )
            chunks += 1
            if not chunk_desc:
                break
            rewind_desc.extend(chunk_desc)
            user_idx = next(
                (i for i, item in enumerate(rewind_desc) if item.get("role") == "user"),
                None,
            )
            if user_idx is not None:
                rewind_desc = rewind_desc[:user_idx + 1]
                break
            oldest_seq = _message_seq(chunk_desc[-1])
            if oldest_seq <= 0 or len(chunk_desc) < max_raw_messages:
                break
            boundary = oldest_seq - 1
        if rewind_desc:
            window = list(reversed(rewind_desc)) + window

    # Anything older than the start of our window? Skip the probe
    # entirely when the descending fetch returned fewer rows than
    # max_raw_messages — that means the entire session fit in one
    # page, so there's definitionally nothing older. Saves one DDB
    # Query on every initial load of a small session, which is the
    # common case (Greptile P2 on PR #114).
    if not fetched_full_page:
        return window, False
    oldest_in_window = _message_seq(window[0])
    has_more_before = _has_more_before(session_id, oldest_in_window)
    return window, has_more_before


def _has_more_before(session_id, oldest_raw_seq):
    if oldest_raw_seq is None or oldest_raw_seq <= 0:
        return False
    return bool(get_messages(
        session_id,
        to_seq=oldest_raw_seq - 1,
        scan_forward=False,
        limit=1,
    ))


def _window_before_seq(session_id, before_seq, *, max_raw_messages=MAX_INITIAL_RAW_MESSAGES):
    """Return a coherent history window ending strictly before before_seq.

    We fetch the latest raw rows before the requested boundary, then rewind to
    the nearest preceding user message so transcript materialization starts on a
    conversation boundary instead of in the middle of an assistant turn.
    """
    if before_seq <= 0:
        return []

    tail_desc = get_messages(
        session_id,
        to_seq=before_seq - 1,
        scan_forward=False,
        limit=max_raw_messages,
    )
    if not tail_desc:
        return []

    window = list(reversed(tail_desc))
    if window[0].get("role") == "user":
        return window

    rewind_desc = []
    boundary = _message_seq(window[0]) - 1
    while boundary >= 0:
        chunk_desc = get_messages(
            session_id,
            to_seq=boundary,
            scan_forward=False,
            limit=max_raw_messages,
        )
        if not chunk_desc:
            break

        rewind_desc.extend(chunk_desc)
        user_idx = next((i for i, item in enumerate(rewind_desc) if item.get("role") == "user"), None)
        if user_idx is not None:
            rewind_desc = rewind_desc[:user_idx + 1]
            break

        oldest_seq = _message_seq(chunk_desc[-1])
        if oldest_seq <= 0 or len(chunk_desc) < max_raw_messages:
            break
        boundary = oldest_seq - 1

    if rewind_desc:
        window = list(reversed(rewind_desc)) + window
    return window


def _cleanup_session_worktree(session):
    """Best-effort removal of a session's git worktree on its remote server.

    Silent on every kind of failure: the session is being deleted regardless,
    and the worktree will eventually be garbage-collected when the EC2 host is
    terminated. We just want to avoid pile-up on long-lived managed servers.
    """
    worktree_path = session.get("worktreePath")
    repo_dir = session.get("repoDir")
    server_id = session.get("serverId")
    if not worktree_path or not repo_dir or not server_id:
        return
    try:
        server = get_server(server_id)
        if not server or server.get("instanceState") != "running":
            return
        public_ip = server.get("publicIp")
        encrypted_key = server.get("sshPrivateKey")
        if not public_ip or not encrypted_key:
            return
        client = ssh_connect(
            public_ip,
            decrypt(encrypted_key),
            username=server.get("sshUser", "ec2-user"),
        )
        try:
            cleanup_worktree(client, repo_dir, worktree_path)
        finally:
            ssh_disconnect(client)
    except Exception as exc:
        print(f"[sessions] worktree cleanup failed for {session.get('sessionId')}: {exc}")


def handler(event, context):
    try:
        try:
            claims = verify_token(extract_auth_header(event.get("headers", {})))
        except Exception as e:
            return respond(401, {"error": str(e)})

        user_id = claims["sub"]
        path = event.get("rawPath", event.get("path", ""))

        # GET /sessions/{sessionId}/messages
        session_id = event.get("pathParameters", {}).get("sessionId")
        if session_id:
            session = get_session(session_id)
            if not session:
                return respond(404, {"error": "Session not found"})
            if not can_access_owned_resource(user_id, session):
                return respond(403, {"error": "Not your session"})

            method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
            if method == "DELETE":
                if not can_delete_owned_resource(user_id, session):
                    return respond(403, {"error": "Only team admins can delete team sessions"})
                _cleanup_session_worktree(session)
                delete_messages_for_session(session_id)
                delete_session_events_for_session(session_id)
                delete_session(session_id)
                return respond(200, {"ok": True})

            if method == "PATCH":
                if not can_manage_owned_resource(user_id, session):
                    return respond(403, {"error": "You cannot rename this session"})
                try:
                    body = json.loads(event.get("body") or "{}")
                except json.JSONDecodeError:
                    return respond(400, {"error": "Invalid JSON body"})

                updates = {}
                if "title" in body:
                    title_raw = body.get("title")
                    if not isinstance(title_raw, str):
                        return respond(400, {"error": "title must be a string"})
                    trimmed = title_raw.strip()
                    if not trimmed:
                        return respond(400, {"error": "title must not be empty"})
                    if len(trimmed) > MAX_TITLE_LEN:
                        return respond(400, {"error": f"title must be {MAX_TITLE_LEN} characters or fewer"})
                    updates["title"] = trimmed

                if "pinned" in body:
                    pinned_val = body.get("pinned")
                    if not isinstance(pinned_val, bool):
                        return respond(400, {"error": "pinned must be a boolean"})
                    updates["pinned"] = pinned_val

                if not updates:
                    return respond(400, {"error": "No valid fields to update"})

                now = datetime.now(timezone.utc).isoformat()
                updates["updatedAt"] = now
                update_session(session_id, updates)
                return respond(200, {**session, **updates})

            query = event.get("queryStringParameters") or {}
            raw_after_seq = query.get("afterSeq")
            raw_before_seq = query.get("beforeSeq")
            after_seq = None
            before_seq = None
            if raw_after_seq is not None:
                try:
                    after_seq = int(raw_after_seq)
                except (TypeError, ValueError):
                    return respond(400, {"error": "afterSeq must be an integer"})
            if raw_before_seq is not None:
                try:
                    before_seq = int(raw_before_seq)
                except (TypeError, ValueError):
                    return respond(400, {"error": "beforeSeq must be an integer"})
            if after_seq is not None and before_seq is not None:
                return respond(400, {"error": "afterSeq and beforeSeq are mutually exclusive"})

            if after_seq is None and before_seq is None:
                # Load just the latest window directly from DDB instead
                # of fetching every row in the session. See
                # _load_initial_window — fixes the 30s timeout on long
                # sessions (scar:
                # 2026-04-session-messages-initial-load-full-scan).
                initial_window, has_more_before = _load_initial_window(session_id)
                oldest_raw_seq = _message_seq(initial_window[0], None) if initial_window else None
                transcript = materialize_transcript(
                    initial_window,
                    session_status=session.get("status", "done"),
                )
                latest_seq = _latest_seq(initial_window)
                # `messages` is the raw row dump — for sessions with
                # thousands of tool_use/tool_result rows this can be
                # 5-10 MB. API Gateway HTTP API caps response payloads
                # at 6 MB, so an oversized body silently truncates and
                # the browser sees `Failed to fetch`. The transcript is
                # one entry per visible bubble (much smaller) and is
                # what the client renders anyway —
                # ChatWindow.responseToMsgs prefers transcript over
                # messages. The cache write on the client passes
                # `messages: response.messages ?? []` through, so an
                # empty array here just stores empty raws and the
                # cached transcript still hydrates the UI on next
                # open. Polling and pagination still work because
                # `latestSeq` (for afterSeq) and `oldestRawSeq` (for
                # beforeSeq) are returned independently.
                body = {
                    "messages": [],
                    # Explicit flag for non-web callers (mobile clients,
                    # internal scripts, future integrations): the empty
                    # `messages` array on initial load is a deliberate
                    # omission for response-size reasons, not "this
                    # session is empty." Brand-new sessions can be
                    # detected by `transcript == []`. Greptile P2 on
                    # PR #114.
                    "rawMessagesOmitted": True,
                    "transcript": transcript,
                    "replaceFromTranscriptSeq": 0 if transcript else None,
                    "latestSeq": latest_seq,
                    "oldestRawSeq": oldest_raw_seq,
                    "hasMoreBefore": has_more_before,
                }
                if has_more_before:
                    body["truncated"] = True
                return respond(200, body)

            if before_seq is not None:
                older_window = _window_before_seq(session_id, before_seq)
                oldest_raw_seq = _message_seq(older_window[0], None) if older_window else None
                transcript = materialize_transcript(
                    older_window,
                    # This is an older page, not the session tail. Treat the
                    # page as settled even if the session is currently running,
                    # otherwise the last assistant bubble in the older page can
                    # render as a fake live/interrupted message.
                    session_status="done",
                )
                return respond(200, {
                    "messages": older_window,
                    "transcript": transcript,
                    "replaceFromTranscriptSeq": 0 if transcript else None,
                    "oldestRawSeq": oldest_raw_seq,
                    "hasMoreBefore": _has_more_before(session_id, oldest_raw_seq),
                })

            new_messages = get_messages(session_id, after_seq=after_seq)
            if not new_messages:
                return respond(200, {
                    "messages": [],
                    "transcript": [],
                    "replaceFromTranscriptSeq": None,
                    "latestSeq": after_seq,
                })

            first_changed = new_messages[0]
            rebuild_from_raw_seq = int(first_changed.get("seq", after_seq + 1))
            if first_changed.get("role") != "user" and rebuild_from_raw_seq > 0:
                last_user = find_last_message(
                    session_id,
                    to_seq=rebuild_from_raw_seq - 1,
                    role="user",
                )
                if last_user:
                    rebuild_from_raw_seq = int(last_user.get("seq", rebuild_from_raw_seq))

            tail_messages = get_messages(session_id, from_seq=rebuild_from_raw_seq)
            tail_transcript = materialize_transcript(
                tail_messages,
                session_status=session.get("status", "done"),
            )

            replace_from_transcript_seq = None
            if tail_transcript:
                prefix_messages = (
                    get_messages(session_id, to_seq=rebuild_from_raw_seq - 1)
                    if rebuild_from_raw_seq > 0 else []
                )
                replace_from_transcript_seq = len(materialize_transcript(
                    prefix_messages,
                    session_status="done",
                ))

            return respond(200, {
                "messages": new_messages,
                "transcript": tail_transcript,
                "replaceFromTranscriptSeq": replace_from_transcript_seq,
                "latestSeq": _latest_seq(new_messages, fallback=after_seq),
            })

        # GET /servers/{serverId}/sessions
        server_id = event.get("pathParameters", {}).get("serverId")
        if not server_id:
            return respond(400, {"error": "serverId required"})

        server = get_server(server_id)
        if not server:
            return respond(404, {"error": "Server not found"})
        if not can_access_owned_resource(user_id, server):
            return respond(403, {"error": "Not your server"})

        limit = int((event.get("queryStringParameters") or {}).get("limit", 20))
        sessions = get_sessions_by_server(server_id, limit=min(limit, 50))
        return respond(200, {"sessions": sessions})

    except Exception as e:
        import traceback
        print(f"Sessions error: {e}\n{traceback.format_exc()}")
        return respond(500, {"error": str(e)})
