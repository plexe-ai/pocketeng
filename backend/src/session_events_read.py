"""
GET /sessions/{sessionId}/events — client-facing event stream reader.

Cursor-based polling. The client passes `?after=<seq>` and gets back all
events with seq > after, up to 200 per response. The `sessionStatus`,
`lastEventAt`, and `serverClock` fields let the UI distinguish "alive but
quiet" from "stalled" without depending on a separate health check.

This is the replacement for SSH-tail polling. It's JWT-authed (Supabase
bearer), not shared-secret — the ingest side is shared-secret because the
VM uploader is a different trust boundary.
"""
import json
import os
from datetime import datetime, timezone
from decimal import Decimal

from src.lib.auth import extract_auth_header, verify_token
from src.lib.db import get_session, query_session_events
from src.lib.team_auth import can_access_owned_resource


MAX_EVENTS_PER_RESPONSE = 200


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


def _clean_event(item):
    return {
        "sessionId": item.get("sessionId"),
        "seq": int(item.get("seq", 0)),
        "kind": item.get("kind"),
        "payload": item.get("payload", {}),
        "createdAt": item.get("createdAt"),
        "turnId": item.get("turnId"),
    }


def handler(event, context):
    try:
        try:
            claims = verify_token(extract_auth_header(event.get("headers", {})))
        except Exception as exc:
            return respond(401, {"error": str(exc)})

        user_id = claims["sub"]

        session_id = (event.get("pathParameters") or {}).get("sessionId")
        if not session_id:
            return respond(400, {"error": "sessionId required"})

        query = event.get("queryStringParameters") or {}
        after_seq = None
        raw_after = query.get("after")
        if raw_after is not None:
            try:
                after_seq = int(raw_after)
            except (TypeError, ValueError):
                return respond(400, {"error": "after must be an integer"})

        session = get_session(session_id)
        if not session:
            return respond(404, {"error": "Session not found"})
        if not can_access_owned_resource(user_id, session):
            return respond(403, {"error": "Not your session"})

        items = query_session_events(session_id, after_seq=after_seq, limit=MAX_EVENTS_PER_RESPONSE)
        events = [_clean_event(i) for i in items]

        next_cursor = events[-1]["seq"] if events else (after_seq or 0)

        return respond(200, {
            "events": events,
            "nextCursor": next_cursor,
            "sessionStatus": session.get("status", "running"),
            "lastEventAt": session.get("lastEventAt"),
            "serverClock": datetime.now(timezone.utc).isoformat(),
        })

    except Exception as exc:
        import traceback
        print(f"Session events read error: {exc}\n{traceback.format_exc()}")
        return respond(500, {"error": str(exc)})
