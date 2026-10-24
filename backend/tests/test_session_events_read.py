"""Unit tests for GET /sessions/{id}/events read endpoint."""
import json
import os
from unittest.mock import patch

os.environ.setdefault("SUPABASE_URL", "https://test.supabase.co")
os.environ.setdefault("SUPABASE_JWT_SECRET", "test-secret")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")

FAKE_CLAIMS = {"sub": "user-123"}


def _make_event(session_id="sess-1", after=None):
    return {
        "headers": {"authorization": "Bearer fake-token"},
        "pathParameters": {"sessionId": session_id},
        "queryStringParameters": {"after": str(after)} if after is not None else None,
    }


def _fake_session(user_id="user-123", status="running", last_event_at="2026-04-17T00:01:00Z"):
    return {
        "sessionId": "sess-1",
        "userId": user_id,
        "status": status,
        "lastEventAt": last_event_at,
    }


def _items(*seqs):
    return [
        {
            "sessionId": "sess-1",
            "seq": seq,
            "kind": "assistant.message",
            "payload": {"text": f"msg {seq}"},
            "createdAt": f"2026-04-17T00:00:{seq:02d}Z",
            "turnId": "t-1",
        }
        for seq in seqs
    ]


class TestAuth:
    def test_rejects_invalid_token(self):
        with patch("src.session_events_read.verify_token", side_effect=Exception("bad")):
            from src.session_events_read import handler
            result = handler(_make_event(), {})
            assert result["statusCode"] == 401

    def test_rejects_other_users_session(self):
        with patch("src.session_events_read.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.session_events_read.get_session",
                   return_value=_fake_session(user_id="someone-else")):
            from src.session_events_read import handler
            result = handler(_make_event(), {})
            assert result["statusCode"] == 403

    def test_returns_404_for_missing_session(self):
        with patch("src.session_events_read.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.session_events_read.get_session", return_value=None):
            from src.session_events_read import handler
            result = handler(_make_event(), {})
            assert result["statusCode"] == 404


class TestReadShape:
    def test_returns_events_and_cursor(self):
        with patch("src.session_events_read.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.session_events_read.get_session", return_value=_fake_session()), \
             patch("src.session_events_read.query_session_events", return_value=_items(3, 4, 5)):
            from src.session_events_read import handler
            result = handler(_make_event(after=2), {})

            assert result["statusCode"] == 200
            body = json.loads(result["body"])
            assert len(body["events"]) == 3
            assert body["events"][0]["seq"] == 3
            assert body["nextCursor"] == 5
            assert body["sessionStatus"] == "running"
            assert body["lastEventAt"] == "2026-04-17T00:01:00Z"
            assert "serverClock" in body

    def test_empty_result_preserves_cursor(self):
        """When no new events, nextCursor stays at the last known position
        so the next poll asks for the same thing."""
        with patch("src.session_events_read.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.session_events_read.get_session", return_value=_fake_session()), \
             patch("src.session_events_read.query_session_events", return_value=[]):
            from src.session_events_read import handler
            result = handler(_make_event(after=42), {})

            assert result["statusCode"] == 200
            body = json.loads(result["body"])
            assert body["events"] == []
            assert body["nextCursor"] == 42

    def test_empty_result_first_poll_returns_zero(self):
        with patch("src.session_events_read.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.session_events_read.get_session", return_value=_fake_session()), \
             patch("src.session_events_read.query_session_events", return_value=[]):
            from src.session_events_read import handler
            result = handler(_make_event(), {})
            assert json.loads(result["body"])["nextCursor"] == 0

    def test_invalid_after_returns_400(self):
        with patch("src.session_events_read.verify_token", return_value=FAKE_CLAIMS):
            from src.session_events_read import handler
            result = handler(_make_event(after="not-a-number"), {})
            assert result["statusCode"] == 400

    def test_done_session_status_passed_through(self):
        with patch("src.session_events_read.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.session_events_read.get_session",
                   return_value=_fake_session(status="done")), \
             patch("src.session_events_read.query_session_events", return_value=_items(1)):
            from src.session_events_read import handler
            result = handler(_make_event(), {})
            assert json.loads(result["body"])["sessionStatus"] == "done"

    def test_cursor_passed_correctly_to_query(self):
        with patch("src.session_events_read.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.session_events_read.get_session", return_value=_fake_session()), \
             patch("src.session_events_read.query_session_events", return_value=[]) as mock_q:
            from src.session_events_read import handler
            handler(_make_event(after=100), {})
            mock_q.assert_called_once()
            assert mock_q.call_args.kwargs["after_seq"] == 100


def _team_session(status="running"):
    return {
        "sessionId": "sess-team",
        "userId": "user-other",
        "ownerType": "team",
        "teamId": "team-1",
        "createdByUserId": "user-other",
        "status": status,
        "lastEventAt": "2026-04-17T00:01:00Z",
    }


class TestTeamSessionEventAccess:
    def test_team_member_can_read_teammates_session_events(self):
        with patch("src.session_events_read.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.session_events_read.get_session", return_value=_team_session()), \
             patch("src.session_events_read.query_session_events", return_value=_items(1)), \
             patch("src.lib.team_auth.get_team_membership", return_value={"status": "active", "role": "member"}):
            from src.session_events_read import handler
            result = handler(_make_event(session_id="sess-team"), {})

            assert result["statusCode"] == 200

    def test_non_member_blocked_from_team_session_events(self):
        with patch("src.session_events_read.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.session_events_read.get_session", return_value=_team_session()), \
             patch("src.lib.team_auth.get_team_membership", return_value=None):
            from src.session_events_read import handler
            result = handler(_make_event(session_id="sess-team"), {})

            assert result["statusCode"] == 403
