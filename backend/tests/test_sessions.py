"""Unit tests for sessions.py — history list and message retrieval endpoints."""
import json
import os
from decimal import Decimal
from unittest.mock import patch, MagicMock

import pytest

os.environ.setdefault("SUPABASE_URL", "https://test.supabase.co")
os.environ.setdefault("SUPABASE_JWT_SECRET", "test-secret")
os.environ.setdefault("SERVERS_TABLE", "pe-servers-test")
os.environ.setdefault("SESSIONS_TABLE", "pe-sessions-test")
os.environ.setdefault("MESSAGES_TABLE", "pe-messages-test")

FAKE_CLAIMS = {"sub": "user-123"}
FAKE_SERVER = {"serverId": "srv-1", "userId": "user-123", "instanceState": "running"}
FAKE_SESSION = {"sessionId": "sess-1", "serverId": "srv-1", "userId": "user-123", "status": "done"}
FAKE_MESSAGES = [
    {"sessionId": "sess-1", "seq": 0, "role": "user", "content": "hello"},
    {"sessionId": "sess-1", "seq": 1, "role": "agent", "content": '{"type":"text","content":"hi"}'},
]
FAKE_SESSIONS = [
    {"sessionId": "sess-1", "serverId": "srv-1", "prompt": "Build a landing page", "status": "done"},
    {"sessionId": "sess-2", "serverId": "srv-1", "prompt": "Fix the bug", "status": "done"},
]


def _make_event(path_params=None, query_params=None):
    return {
        "headers": {"authorization": "Bearer fake-token"},
        "pathParameters": path_params or {},
        "queryStringParameters": query_params,
        "rawPath": "",
    }


# ─── Auth ─────────────────────────────────────────────────────────────────────

class TestAuth:
    def test_returns_401_when_no_auth(self):
        from src.sessions import handler
        event = {"headers": {}, "pathParameters": {"serverId": "srv-1"}, "queryStringParameters": None}
        result = handler(event, {})
        assert result["statusCode"] == 401

    def test_returns_401_when_verify_token_raises(self):
        with patch("src.sessions.verify_token", side_effect=Exception("bad token")):
            from src.sessions import handler
            event = _make_event({"serverId": "srv-1"})
            result = handler(event, {})
            assert result["statusCode"] == 401

    def test_accepts_capitalized_authorization_header(self):
        with patch("src.sessions.verify_token", return_value=FAKE_CLAIMS) as mock_verify, \
             patch("src.sessions.get_server", return_value=FAKE_SERVER), \
             patch("src.sessions.get_sessions_by_server", return_value=[]):
            from src.sessions import handler
            event = _make_event({"serverId": "srv-1"})
            event["headers"] = {"Authorization": "Bearer fake-token"}
            result = handler(event, {})
            assert result["statusCode"] == 200
            mock_verify.assert_called_once_with("Bearer fake-token")


# ─── GET /servers/{serverId}/sessions ─────────────────────────────────────────

class TestListSessions:
    def _call(self, server=FAKE_SERVER, sessions=None, limit=None):
        with patch("src.sessions.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.sessions.get_server", return_value=server), \
             patch("src.sessions.get_sessions_by_server", return_value=sessions or FAKE_SESSIONS):
            from src.sessions import handler
            query = {"limit": str(limit)} if limit else None
            event = _make_event({"serverId": "srv-1"}, query)
            return handler(event, {})

    def test_returns_200_with_sessions(self):
        result = self._call()
        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert "sessions" in body
        assert len(body["sessions"]) == 2

    def test_serializes_decimal_session_fields(self):
        sessions = [{
            "sessionId": "sess-1",
            "serverId": "srv-1",
            "prompt": "Build a landing page",
            "status": "running",
            "currentRunOffset": Decimal("2"),
            "nextSeq": Decimal("5"),
        }]
        result = self._call(sessions=sessions)
        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert body["sessions"][0]["currentRunOffset"] == 2
        assert body["sessions"][0]["nextSeq"] == 5

    def test_returns_404_when_server_not_found(self):
        with patch("src.sessions.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.sessions.get_server", return_value=None):
            from src.sessions import handler
            result = handler(_make_event({"serverId": "missing"}), {})
            assert result["statusCode"] == 404

    def test_returns_403_when_wrong_user(self):
        other_server = {**FAKE_SERVER, "userId": "other-user"}
        result = self._call(server=other_server)
        assert result["statusCode"] == 403

    def test_respects_limit_param(self):
        with patch("src.sessions.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.sessions.get_server", return_value=FAKE_SERVER) as _, \
             patch("src.sessions.get_sessions_by_server", return_value=FAKE_SESSIONS) as mock_get:
            from src.sessions import handler
            event = _make_event({"serverId": "srv-1"}, {"limit": "5"})
            handler(event, {})
            mock_get.assert_called_once_with("srv-1", limit=5)

    def test_caps_limit_at_50(self):
        with patch("src.sessions.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.sessions.get_server", return_value=FAKE_SERVER), \
             patch("src.sessions.get_sessions_by_server", return_value=[]) as mock_get:
            from src.sessions import handler
            event = _make_event({"serverId": "srv-1"}, {"limit": "999"})
            handler(event, {})
            mock_get.assert_called_once_with("srv-1", limit=50)


# ─── GET /sessions/{sessionId}/messages ───────────────────────────────────────

class TestGetMessages:
    def _call(self, session=FAKE_SESSION, messages=None, query_params=None, last_user=None):
        # Simulate DDB Query semantics so the new initial-load path
        # (which uses scan_forward=False + limit + to_seq) sees the
        # same shape it would in prod. The previous tests used a flat
        # `return_value=` which let the old O(N) full-scan code work
        # but breaks the descending-page approach now that we no
        # longer fetch the whole table per call.
        source = list(FAKE_MESSAGES if messages is None else messages)
        source_sorted = sorted(source, key=lambda m: int(m.get("seq", 0)))

        def fake_get_messages(_session_id, *, after_seq=None, from_seq=None,
                              to_seq=None, scan_forward=True, limit=None):
            filtered = source_sorted
            if after_seq is not None:
                filtered = [m for m in filtered if int(m.get("seq", 0)) > after_seq]
            if from_seq is not None:
                filtered = [m for m in filtered if int(m.get("seq", 0)) >= from_seq]
            if to_seq is not None:
                filtered = [m for m in filtered if int(m.get("seq", 0)) <= to_seq]
            if not scan_forward:
                filtered = list(reversed(filtered))
            if limit is not None:
                filtered = filtered[:limit]
            return filtered

        with patch("src.sessions.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.sessions.get_session", return_value=session), \
             patch("src.sessions.get_messages", side_effect=fake_get_messages), \
             patch("src.sessions.find_last_message", return_value=last_user):
            from src.sessions import handler
            event = _make_event({"sessionId": "sess-1"}, query_params)
            return handler(event, {})

    def test_returns_200_with_transcript(self):
        # `messages` is now intentionally empty on the initial-load
        # response — the raw rows for a long session can blow past API
        # Gateway's 6 MB body cap and the client uses transcript
        # anyway. See _load_initial_window in src/sessions.py.
        result = self._call()
        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert body["messages"] == []
        assert "transcript" in body
        assert [m["role"] for m in body["transcript"]] == ["user", "assistant"]

    def test_serializes_decimal_seq_in_transcript(self):
        # Same shape as above but with Decimal seq fields from DDB. We
        # used to assert on body["messages"][i]["seq"]; that path is
        # gone. Seq is exposed via latestSeq + transcript.seq instead.
        messages = [
            {"sessionId": "sess-1", "seq": Decimal("0"), "role": "user", "content": "hello"},
            {"sessionId": "sess-1", "seq": Decimal("1"), "role": "agent",
             "content": '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}'},
        ]
        result = self._call(messages=messages)
        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert body["latestSeq"] == 1
        assert body["messages"] == []

    def test_initial_load_never_does_full_unbounded_scan(self):
        # Regression for the "session won't load — Lambda timeout"
        # bug: the initial-load path used to call
        # get_messages(session_id) with no limit, which scanned the
        # entire DDB partition for sessions with thousands of rows.
        # Every call from the initial-load path must carry either
        # `limit=` or a bounded `to_seq=` (the _has_more_before
        # probe).
        recorded_calls = []

        def recording_get_messages(_session_id, **kwargs):
            recorded_calls.append(kwargs)
            return []

        with patch("src.sessions.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.sessions.get_session", return_value=FAKE_SESSION), \
             patch("src.sessions.get_messages", side_effect=recording_get_messages), \
             patch("src.sessions.find_last_message", return_value=None):
            from src.sessions import handler
            handler(_make_event({"sessionId": "sess-1"}), {})

        assert recorded_calls, "initial load did not query messages at all"
        for kw in recorded_calls:
            has_limit = kw.get("limit") is not None
            has_to_seq = kw.get("to_seq") is not None
            assert has_limit or has_to_seq, (
                f"initial-load path made an unbounded get_messages call: {kw}"
            )

    def test_small_session_skips_has_more_before_probe(self):
        # Greptile P2 on PR #114: when the descending fetch returns the
        # whole session in one page, there's nothing older — skip the
        # `_has_more_before` Query entirely so common-case loads pay
        # for one DDB call, not two.
        small_session = [
            {"sessionId": "sess-1", "seq": 0, "role": "user", "content": "hi"},
            {"sessionId": "sess-1", "seq": 1, "role": "agent",
             "content": '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}'},
        ]
        recorded_calls = []

        def fake_get_messages(_session_id, **kwargs):
            recorded_calls.append(kwargs)
            # Behave like real DDB: descending + limit returns reversed slice.
            scan_forward = kwargs.get("scan_forward", True)
            limit = kwargs.get("limit")
            data = list(small_session)
            if not scan_forward:
                data = list(reversed(data))
            if limit is not None:
                data = data[:limit]
            return data

        with patch("src.sessions.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.sessions.get_session", return_value=FAKE_SESSION), \
             patch("src.sessions.get_messages", side_effect=fake_get_messages), \
             patch("src.sessions.find_last_message", return_value=None):
            from src.sessions import handler
            result = handler(_make_event({"sessionId": "sess-1"}), {})

        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert body["hasMoreBefore"] is False
        # Exactly one DDB call: the initial descending fetch. No
        # follow-up _has_more_before probe.
        assert len(recorded_calls) == 1, (
            f"small session should make 1 DDB call, made {len(recorded_calls)}: {recorded_calls}"
        )

    def test_initial_load_advertises_raw_messages_omitted(self):
        # Greptile P2 on PR #114: the empty `messages` array on the
        # initial-load response is a deliberate omission for
        # response-size reasons, not "this session is empty." A
        # `rawMessagesOmitted: True` flag is returned alongside so
        # non-web callers can distinguish the two cases.
        result = self._call()
        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert body["messages"] == []
        assert body["rawMessagesOmitted"] is True

    def test_returns_404_when_session_not_found(self):
        with patch("src.sessions.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.sessions.get_session", return_value=None):
            from src.sessions import handler
            result = handler(_make_event({"sessionId": "missing"}), {})
            assert result["statusCode"] == 404

    def test_returns_403_when_wrong_user(self):
        other_session = {**FAKE_SESSION, "userId": "other-user"}
        result = self._call(session=other_session)
        assert result["statusCode"] == 403

    def test_returns_empty_messages(self):
        result = self._call(messages=[])
        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert body["messages"] == []

    def test_long_initial_load_keeps_recent_transcript_contiguous(self):
        messages = [
            {
                "sessionId": "sess-1",
                "seq": 0,
                "role": "user",
                "content": "First prompt",
                "createdAt": "2026-04-02T13:00:00Z",
            },
            {
                "sessionId": "sess-1",
                "seq": 1,
                "role": "agent",
                "content": '{"type":"assistant","message":{"content":[{"type":"text","text":"First answer"}]}}',
                "createdAt": "2026-04-02T13:00:01Z",
            },
        ]
        for seq in range(2, 201):
            messages.append({
                "sessionId": "sess-1",
                "seq": seq,
                "role": "agent",
                "content": '{"type":"system","subtype":"status","status":"running"}',
                "createdAt": f"2026-04-02T13:00:{seq % 60:02d}Z",
            })
        messages.append({
            "sessionId": "sess-1",
            "seq": 201,
            "role": "user",
            "content": "Second prompt",
            "createdAt": "2026-04-02T13:05:00Z",
        })
        for seq in range(202, 301):
            messages.append({
                "sessionId": "sess-1",
                "seq": seq,
                "role": "agent",
                "content": '{"type":"system","subtype":"status","status":"running"}',
                "createdAt": f"2026-04-02T13:05:{seq % 60:02d}Z",
            })
        messages.append({
            "sessionId": "sess-1",
            "seq": 301,
            "role": "agent",
            "content": '{"type":"assistant","message":{"content":[{"type":"text","text":"Second answer"}]}}',
            "createdAt": "2026-04-02T13:05:59Z",
        })
        for seq in range(302, 801):
            messages.append({
                "sessionId": "sess-1",
                "seq": seq,
                "role": "agent",
                "content": '{"type":"system","subtype":"status","status":"running"}',
                "createdAt": f"2026-04-02T13:06:{seq % 60:02d}Z",
            })

        result = self._call(messages=messages)

        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert body["truncated"] is True
        # `totalMessages` was dropped — the cheap path now returns
        # only the window, so reporting the full count would require
        # a separate COUNT query the client doesn't use.
        assert "totalMessages" not in body
        assert body["latestSeq"] == 800
        assert body["oldestRawSeq"] == 201
        assert body["hasMoreBefore"] is True
        # `messages` is empty on initial load — see _load_initial_window
        # for why. The transcript carries the user-visible content and
        # `oldestRawSeq` is the cursor for older-page fetches.
        assert body["messages"] == []
        assert [item["role"] for item in body["transcript"]] == ["user", "assistant"]
        assert body["transcript"][0]["content"] == "Second prompt"
        assert body["transcript"][1]["content"] == "Second answer"

    def test_before_seq_returns_older_window_and_metadata(self):
        all_messages = [
            {
                "sessionId": "sess-1",
                "seq": 0,
                "role": "user",
                "content": "First prompt",
                "createdAt": "2026-04-02T13:00:00Z",
            },
            {
                "sessionId": "sess-1",
                "seq": 1,
                "role": "agent",
                "content": '{"type":"assistant","message":{"content":[{"type":"text","text":"First answer"}]}}',
                "createdAt": "2026-04-02T13:00:01Z",
            },
            {
                "sessionId": "sess-1",
                "seq": 2,
                "role": "user",
                "content": "Second prompt",
                "createdAt": "2026-04-02T13:05:00Z",
            },
            {
                "sessionId": "sess-1",
                "seq": 3,
                "role": "agent",
                "content": '{"type":"assistant","message":{"content":[{"type":"text","text":"Second answer"}]}}',
                "createdAt": "2026-04-02T13:05:01Z",
            },
            {
                "sessionId": "sess-1",
                "seq": 4,
                "role": "user",
                "content": "Third prompt",
                "createdAt": "2026-04-02T13:10:00Z",
            },
            {
                "sessionId": "sess-1",
                "seq": 5,
                "role": "agent",
                "content": '{"type":"assistant","message":{"content":[{"type":"text","text":"Third answer"}]}}',
                "createdAt": "2026-04-02T13:10:01Z",
            },
        ]

        def get_messages_side_effect(session_id, **kwargs):
            assert session_id == "sess-1"
            filtered = all_messages
            after_seq = kwargs.get("after_seq")
            from_seq = kwargs.get("from_seq")
            to_seq = kwargs.get("to_seq")
            scan_forward = kwargs.get("scan_forward", True)
            limit = kwargs.get("limit")

            if after_seq is not None:
                filtered = [item for item in filtered if item["seq"] > after_seq]
            if from_seq is not None:
                filtered = [item for item in filtered if item["seq"] >= from_seq]
            if to_seq is not None:
                filtered = [item for item in filtered if item["seq"] <= to_seq]
            if not scan_forward:
                filtered = list(reversed(filtered))
            if limit is not None:
                filtered = filtered[:limit]
            return filtered

        with patch("src.sessions.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.sessions.get_session", return_value=FAKE_SESSION), \
             patch("src.sessions.get_messages", side_effect=get_messages_side_effect), \
             patch("src.sessions.find_last_message", return_value=None):
            from src.sessions import handler

            result = handler(_make_event({"sessionId": "sess-1"}, {"beforeSeq": "4"}), {})

        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert [message["seq"] for message in body["messages"]] == [0, 1, 2, 3]
        assert body["oldestRawSeq"] == 0
        assert body["hasMoreBefore"] is False
        assert [message["content"] for message in body["transcript"]] == [
            "First prompt",
            "First answer",
            "Second prompt",
            "Second answer",
        ]

    def test_before_seq_window_marks_tail_complete_when_session_running(self):
        all_messages = [
            {
                "sessionId": "sess-1",
                "seq": 0,
                "role": "user",
                "content": "Earlier prompt",
                "createdAt": "2026-04-02T13:00:00Z",
            },
            {
                "sessionId": "sess-1",
                "seq": 1,
                "role": "agent",
                "content": '{"type":"assistant","message":{"content":[{"type":"text","text":"Earlier answer"}]}}',
                "createdAt": "2026-04-02T13:00:01Z",
            },
            {
                "sessionId": "sess-1",
                "seq": 2,
                "role": "user",
                "content": "Current prompt",
                "createdAt": "2026-04-02T13:05:00Z",
            },
            {
                "sessionId": "sess-1",
                "seq": 3,
                "role": "agent",
                "content": '{"type":"assistant","message":{"content":[{"type":"text","text":"Still working"}]}}',
                "createdAt": "2026-04-02T13:05:01Z",
            },
        ]

        def get_messages_side_effect(session_id, **kwargs):
            filtered = all_messages
            to_seq = kwargs.get("to_seq")
            scan_forward = kwargs.get("scan_forward", True)
            limit = kwargs.get("limit")
            if to_seq is not None:
                filtered = [item for item in filtered if item["seq"] <= to_seq]
            if not scan_forward:
                filtered = list(reversed(filtered))
            if limit is not None:
                filtered = filtered[:limit]
            return filtered

        with patch("src.sessions.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.sessions.get_session", return_value={**FAKE_SESSION, "status": "running"}), \
             patch("src.sessions.get_messages", side_effect=get_messages_side_effect), \
             patch("src.sessions.find_last_message", return_value=None):
            from src.sessions import handler

            result = handler(_make_event({"sessionId": "sess-1"}, {"beforeSeq": "2"}), {})

        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert body["transcript"][1]["role"] == "assistant"
        assert body["transcript"][1]["state"] == "complete"

    def test_returns_materialized_transcript_without_duplicate_snapshots(self):
        messages = [
            {
                "sessionId": "sess-1",
                "seq": 0,
                "role": "user",
                "content": "Investigate the bug",
                "createdAt": "2026-04-02T13:00:00Z",
            },
            {
                "sessionId": "sess-1",
                "seq": 1,
                "role": "agent",
                "content": '{"type":"assistant","message":{"content":[{"type":"text","text":"Planning changes."}]}}',
                "createdAt": "2026-04-02T13:00:01Z",
            },
            {
                "sessionId": "sess-1",
                "seq": 2,
                "role": "agent",
                "content": '{"type":"tool_use","name":"Read","input":{"file_path":"/app.py"}}',
                "createdAt": "2026-04-02T13:00:02Z",
            },
            {
                "sessionId": "sess-1",
                "seq": 3,
                "role": "agent",
                "content": '{"type":"assistant","message":{"content":[{"type":"text","text":"Planning changes.\\n\\nApplied the fix."}]}}',
                "createdAt": "2026-04-02T13:00:03Z",
            },
            {
                "sessionId": "sess-1",
                "seq": 4,
                "role": "agent",
                "content": '{"type":"result","subtype":"success","result":"Planning changes.\\n\\nApplied the fix."}',
                "createdAt": "2026-04-02T13:00:04Z",
            },
        ]
        result = self._call(messages=messages)
        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert len(body["transcript"]) == 2
        assert body["transcript"][0]["role"] == "user"
        assert body["transcript"][1]["role"] == "assistant"
        assert body["transcript"][1]["content"] == "Planning changes.\n\nApplied the fix."
        assert len(body["transcript"][1]["tools"]) == 1
        assert body["transcript"][1]["tools"][0]["toolName"] == "Read"
        assert body["transcript"][1]["tools"][0]["input"] == "/app.py"

    def test_materialized_transcript_parses_nested_tool_results(self):
        messages = [
            {
                "sessionId": "sess-1",
                "seq": 0,
                "role": "user",
                "content": "smoke sync from web",
                "createdAt": "2026-04-02T13:38:00Z",
            },
            {
                "sessionId": "sess-1",
                "seq": 1,
                "role": "agent",
                "content": '{"type":"tool_use","name":"Bash","input":{"command":"ls"}}',
                "createdAt": "2026-04-02T13:38:01Z",
            },
            {
                "sessionId": "sess-1",
                "seq": 2,
                "role": "agent",
                "content": '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"PocketEngineer\\nbackend","is_error":false}]},"tool_use_result":{"stdout":"PocketEngineer\\nbackend","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false}}',
                "createdAt": "2026-04-02T13:38:02Z",
            },
            {
                "sessionId": "sess-1",
                "seq": 3,
                "role": "agent",
                "content": '{"type":"assistant","message":{"content":[{"type":"text","text":"Could you clarify what you mean by \\"smoke sync from web\\"?"}]}}',
                "createdAt": "2026-04-02T13:38:03Z",
            },
        ]
        result = self._call(messages=messages)
        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assistant = body["transcript"][1]
        assert assistant["tools"][0]["toolName"] == "Bash"
        assert assistant["tools"][0]["output"] == "PocketEngineer\nbackend"
        assert assistant["content"] == 'Could you clarify what you mean by "smoke sync from web"?'

    def test_running_session_marks_partial_assistant_as_interrupted(self):
        messages = [
            {
                "sessionId": "sess-1",
                "seq": 0,
                "role": "user",
                "content": "keep going",
                "createdAt": "2026-04-02T13:50:00Z",
            },
            {
                "sessionId": "sess-1",
                "seq": 1,
                "role": "agent",
                "content": '{"type":"assistant","message":{"content":[{"type":"text","text":"Still working"}]}}',
                "createdAt": "2026-04-02T13:50:01Z",
            },
        ]
        session = {**FAKE_SESSION, "status": "running"}
        result = self._call(session=session, messages=messages)
        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert body["transcript"][1]["role"] == "assistant"
        assert body["transcript"][1]["state"] == "interrupted"

    def test_incremental_fetch_returns_tail_replacement_index(self):
        all_messages = [
            {
                "sessionId": "sess-1",
                "seq": 0,
                "role": "user",
                "content": "First prompt",
                "createdAt": "2026-04-02T13:00:00Z",
            },
            {
                "sessionId": "sess-1",
                "seq": 1,
                "role": "agent",
                "content": '{"type":"assistant","message":{"content":[{"type":"text","text":"First answer"}]}}',
                "createdAt": "2026-04-02T13:00:01Z",
            },
            {
                "sessionId": "sess-1",
                "seq": 2,
                "role": "user",
                "content": "Second prompt",
                "createdAt": "2026-04-02T13:05:00Z",
            },
            {
                "sessionId": "sess-1",
                "seq": 3,
                "role": "agent",
                "content": '{"type":"assistant","message":{"content":[{"type":"text","text":"Second answer"}]}}',
                "createdAt": "2026-04-02T13:05:01Z",
            },
        ]

        def get_messages_side_effect(session_id, **kwargs):
            assert session_id == "sess-1"
            filtered = all_messages
            after_seq = kwargs.get("after_seq")
            from_seq = kwargs.get("from_seq")
            to_seq = kwargs.get("to_seq")

            if after_seq is not None:
                filtered = [item for item in filtered if item["seq"] > after_seq]
            if from_seq is not None:
                filtered = [item for item in filtered if item["seq"] >= from_seq]
            if to_seq is not None:
                filtered = [item for item in filtered if item["seq"] <= to_seq]
            return filtered

        with patch("src.sessions.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.sessions.get_session", return_value=FAKE_SESSION), \
             patch("src.sessions.get_messages", side_effect=get_messages_side_effect), \
             patch("src.sessions.find_last_message", return_value=None):
            from src.sessions import handler

            result = handler(_make_event({"sessionId": "sess-1"}, {"afterSeq": "1"}), {})

        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert [message["seq"] for message in body["messages"]] == [2, 3]
        assert body["replaceFromTranscriptSeq"] == 2
        assert body["latestSeq"] == 3
        assert [message["role"] for message in body["transcript"]] == ["user", "assistant"]
        assert body["transcript"][0]["content"] == "Second prompt"

    def test_incremental_fetch_rebuilds_from_prior_user_when_agent_tail_changes(self):
        all_messages = [
            {
                "sessionId": "sess-1",
                "seq": 0,
                "role": "user",
                "content": "First prompt",
                "createdAt": "2026-04-02T13:00:00Z",
            },
            {
                "sessionId": "sess-1",
                "seq": 1,
                "role": "agent",
                "content": '{"type":"assistant","message":{"content":[{"type":"text","text":"First answer"}]}}',
                "createdAt": "2026-04-02T13:00:01Z",
            },
            {
                "sessionId": "sess-1",
                "seq": 2,
                "role": "user",
                "content": "Second prompt",
                "createdAt": "2026-04-02T13:05:00Z",
            },
            {
                "sessionId": "sess-1",
                "seq": 3,
                "role": "agent",
                "content": '{"type":"assistant","message":{"content":[{"type":"text","text":"Thinking"}]}}',
                "createdAt": "2026-04-02T13:05:01Z",
            },
            {
                "sessionId": "sess-1",
                "seq": 4,
                "role": "agent",
                "content": '{"type":"result","subtype":"success","result":"Thinking\\n\\nDone"}',
                "createdAt": "2026-04-02T13:05:02Z",
            },
        ]

        def get_messages_side_effect(session_id, **kwargs):
            filtered = all_messages
            after_seq = kwargs.get("after_seq")
            from_seq = kwargs.get("from_seq")
            to_seq = kwargs.get("to_seq")

            if after_seq is not None:
                filtered = [item for item in filtered if item["seq"] > after_seq]
            if from_seq is not None:
                filtered = [item for item in filtered if item["seq"] >= from_seq]
            if to_seq is not None:
                filtered = [item for item in filtered if item["seq"] <= to_seq]
            return filtered

        with patch("src.sessions.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.sessions.get_session", return_value={**FAKE_SESSION, "status": "running"}), \
             patch("src.sessions.get_messages", side_effect=get_messages_side_effect), \
             patch("src.sessions.find_last_message", return_value=all_messages[2]):
            from src.sessions import handler

            result = handler(_make_event({"sessionId": "sess-1"}, {"afterSeq": "3"}), {})

        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert [message["seq"] for message in body["messages"]] == [4]
        assert body["replaceFromTranscriptSeq"] == 2
        assert body["latestSeq"] == 4
        assert body["transcript"][0]["role"] == "user"
        assert body["transcript"][1]["role"] == "assistant"
        assert body["transcript"][1]["content"] == "Thinking\n\nDone"

    def test_incremental_fetch_returns_no_replacement_when_only_structured_metadata_changes(self):
        messages = [
            {
                "sessionId": "sess-1",
                "seq": 2,
                "role": "agent",
                "content": '{"type":"system","subtype":"init","session_id":"remote-1"}',
                "createdAt": "2026-04-02T13:05:00Z",
            },
        ]

        result = self._call(
            session={**FAKE_SESSION, "status": "running"},
            messages=messages,
            query_params={"afterSeq": "1"},
            last_user={"sessionId": "sess-1", "seq": 0, "role": "user"},
        )

        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert body["messages"][0]["seq"] == 2
        assert body["transcript"] == []
        assert body["replaceFromTranscriptSeq"] is None
        assert body["latestSeq"] == 2

    def test_returns_400_for_invalid_after_seq(self):
        result = self._call(query_params={"afterSeq": "abc"})

        assert result["statusCode"] == 400

    def test_returns_400_for_conflicting_after_and_before_seq(self):
        result = self._call(query_params={"afterSeq": "1", "beforeSeq": "2"})

        assert result["statusCode"] == 400


# ─── PATCH /sessions/{sessionId} ──────────────────────────────────────────────

def _patch_event(session_id, body):
    event = _make_event({"sessionId": session_id})
    event["requestContext"] = {"http": {"method": "PATCH"}}
    event["body"] = json.dumps(body) if body is not None else None
    return event


class TestRenameSession:
    def _call(self, body, session=FAKE_SESSION, update_mock=None):
        update_mock = update_mock or MagicMock()
        with patch("src.sessions.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.sessions.get_session", return_value=session), \
             patch("src.sessions.update_session", update_mock):
            from src.sessions import handler
            result = handler(_patch_event("sess-1", body), {})
        return result, update_mock

    def test_renames_session_and_returns_updated_record(self):
        result, update_mock = self._call({"title": "New title"})
        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert body["sessionId"] == "sess-1"
        assert body["title"] == "New title"
        assert "updatedAt" in body
        update_mock.assert_called_once()
        (session_id, updates), _ = update_mock.call_args
        assert session_id == "sess-1"
        assert updates["title"] == "New title"
        assert "updatedAt" in updates

    def test_trims_whitespace_around_title(self):
        result, update_mock = self._call({"title": "  trimmed  "})
        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert body["title"] == "trimmed"
        (_, updates), _ = update_mock.call_args
        assert updates["title"] == "trimmed"

    def test_returns_404_when_session_not_found(self):
        with patch("src.sessions.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.sessions.get_session", return_value=None), \
             patch("src.sessions.update_session") as update_mock:
            from src.sessions import handler
            result = handler(_patch_event("missing", {"title": "x"}), {})
        assert result["statusCode"] == 404
        update_mock.assert_not_called()

    def test_returns_403_when_wrong_user(self):
        other_session = {**FAKE_SESSION, "userId": "other-user"}
        update_mock = MagicMock()
        result, _ = self._call({"title": "x"}, session=other_session, update_mock=update_mock)
        assert result["statusCode"] == 403
        update_mock.assert_not_called()

    def test_returns_400_for_empty_title(self):
        result, update_mock = self._call({"title": ""})
        assert result["statusCode"] == 400
        update_mock.assert_not_called()

    def test_returns_400_for_whitespace_only_title(self):
        result, update_mock = self._call({"title": "   \t  "})
        assert result["statusCode"] == 400
        update_mock.assert_not_called()

    def test_returns_400_for_title_over_limit(self):
        result, update_mock = self._call({"title": "a" * 101})
        assert result["statusCode"] == 400
        update_mock.assert_not_called()

    def test_accepts_title_at_limit(self):
        result, update_mock = self._call({"title": "a" * 100})
        assert result["statusCode"] == 200
        update_mock.assert_called_once()

    def test_returns_400_for_non_string_title(self):
        result, update_mock = self._call({"title": 123})
        assert result["statusCode"] == 400
        update_mock.assert_not_called()

    def test_returns_400_for_missing_title_field(self):
        result, update_mock = self._call({})
        assert result["statusCode"] == 400
        update_mock.assert_not_called()

    def test_returns_400_for_invalid_json_body(self):
        event = _make_event({"sessionId": "sess-1"})
        event["requestContext"] = {"http": {"method": "PATCH"}}
        event["body"] = "{not json"
        with patch("src.sessions.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.sessions.get_session", return_value=FAKE_SESSION), \
             patch("src.sessions.update_session") as update_mock:
            from src.sessions import handler
            result = handler(event, {})
        assert result["statusCode"] == 400
        update_mock.assert_not_called()


# ─── Team-resource access/manage/delete ───────────────────────────────────────
#
# These pin the per-route auth checks the team-foundations branch added to
# every PATCH/DELETE on a session. Together with test_team_auth.py these are
# the unit-level proof that team boundary enforcement actually fires in this
# handler — not just that the helper returns the right thing.

def _delete_event(session_id):
    event = _make_event({"sessionId": session_id})
    event["requestContext"] = {"http": {"method": "DELETE"}}
    return event


_TEAM_SESSION = {
    "sessionId": "sess-team",
    "serverId": "srv-team",
    "ownerType": "team",
    "teamId": "team-1",
    "createdByUserId": "user-creator",
    "userId": "user-creator",
    "status": "done",
}


class TestTeamSessionAccess:
    def test_team_member_can_view_teammates_session(self):
        with patch("src.sessions.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.sessions.get_session", return_value=_TEAM_SESSION), \
             patch("src.sessions.get_messages", return_value=[]), \
             patch("src.sessions.find_last_message", return_value=None), \
             patch("src.lib.team_auth.get_team_membership", return_value={"status": "active", "role": "member"}):
            from src.sessions import handler
            result = handler(_make_event({"sessionId": "sess-team"}), {})

        assert result["statusCode"] == 200

    def test_non_member_cannot_view_team_session(self):
        with patch("src.sessions.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.sessions.get_session", return_value=_TEAM_SESSION), \
             patch("src.lib.team_auth.get_team_membership", return_value=None):
            from src.sessions import handler
            result = handler(_make_event({"sessionId": "sess-team"}), {})

        assert result["statusCode"] == 403


class TestTeamSessionRename:
    def test_creator_can_rename_team_session_even_as_non_admin(self):
        # FAKE_CLAIMS user is the creator of the team session
        creator_session = {**_TEAM_SESSION, "createdByUserId": "user-123"}
        with patch("src.sessions.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.sessions.get_session", return_value=creator_session), \
             patch("src.sessions.update_session") as update_mock, \
             patch("src.lib.team_auth.get_team_membership", return_value={"status": "active", "role": "member"}):
            from src.sessions import handler
            result = handler(_patch_event("sess-team", {"title": "Renamed"}), {})

        assert result["statusCode"] == 200
        update_mock.assert_called_once()

    def test_admin_can_rename_teammates_session(self):
        with patch("src.sessions.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.sessions.get_session", return_value=_TEAM_SESSION), \
             patch("src.sessions.update_session") as update_mock, \
             patch("src.lib.team_auth.get_team_membership", return_value={"status": "active", "role": "admin"}):
            from src.sessions import handler
            result = handler(_patch_event("sess-team", {"title": "Renamed"}), {})

        assert result["statusCode"] == 200
        update_mock.assert_called_once()

    def test_non_creator_member_cannot_rename_teammates_session(self):
        with patch("src.sessions.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.sessions.get_session", return_value=_TEAM_SESSION), \
             patch("src.sessions.update_session") as update_mock, \
             patch("src.lib.team_auth.get_team_membership", return_value={"status": "active", "role": "member"}):
            from src.sessions import handler
            result = handler(_patch_event("sess-team", {"title": "Renamed"}), {})

        assert result["statusCode"] == 403
        update_mock.assert_not_called()


class TestTeamSessionDelete:
    def test_admin_can_delete_team_session(self):
        with patch("src.sessions.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.sessions.get_session", return_value=_TEAM_SESSION), \
             patch("src.sessions._cleanup_session_worktree"), \
             patch("src.sessions.delete_messages_for_session"), \
             patch("src.sessions.delete_session_events_for_session"), \
             patch("src.sessions.delete_session") as delete_mock, \
             patch("src.lib.team_auth.get_team_membership", return_value={"status": "active", "role": "admin"}):
            from src.sessions import handler
            result = handler(_delete_event("sess-team"), {})

        assert result["statusCode"] == 200
        delete_mock.assert_called_once_with("sess-team")

    def test_creator_member_cannot_delete_team_session(self):
        """Delete is admin-only; creator-without-admin can't bypass it."""
        creator_session = {**_TEAM_SESSION, "createdByUserId": "user-123"}
        with patch("src.sessions.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.sessions.get_session", return_value=creator_session), \
             patch("src.sessions.delete_session") as delete_mock, \
             patch("src.lib.team_auth.get_team_membership", return_value={"status": "active", "role": "member"}):
            from src.sessions import handler
            result = handler(_delete_event("sess-team"), {})

        assert result["statusCode"] == 403
        delete_mock.assert_not_called()
