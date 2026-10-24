"""Unit tests for POST /internal/sessions/{id}/events ingest."""
import json
import os
from unittest.mock import patch

os.environ.setdefault("COMPLETION_CALLBACK_SECRET", "test-completion-secret")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")


def _make_event(session_id="sess-1", secret="test-completion-secret", body=None):
    return {
        "headers": {"x-pocketengineer-ingest-secret": secret},
        "pathParameters": {"sessionId": session_id},
        "body": json.dumps(body or {}),
    }


def _evt(seq, kind="assistant.message", payload=None, turn="t-1"):
    return {
        "seq": seq,
        "kind": kind,
        "payload": payload or {"text": f"msg {seq}"},
        "createdAt": f"2026-04-17T00:00:{seq:02d}Z",
        "turnId": turn,
    }


class TestAuth:
    def test_rejects_wrong_secret(self):
        from src.session_events_ingest import handler

        result = handler(_make_event(secret="wrong"), {})

        assert result["statusCode"] == 401

    def test_rejects_missing_secret(self):
        from src.session_events_ingest import handler

        event = _make_event()
        event["headers"] = {}
        result = handler(event, {})

        assert result["statusCode"] == 401


class TestValidation:
    def test_rejects_missing_events_array(self):
        with patch("src.session_events_ingest.get_session", return_value={"sessionId": "sess-1"}):
            from src.session_events_ingest import handler
            result = handler(_make_event(body={}), {})
            assert result["statusCode"] == 400

    def test_rejects_empty_events_array(self):
        with patch("src.session_events_ingest.get_session", return_value={"sessionId": "sess-1"}):
            from src.session_events_ingest import handler
            result = handler(_make_event(body={"events": []}), {})
            assert result["statusCode"] == 400

    def test_rejects_unknown_kind(self):
        with patch("src.session_events_ingest.get_session", return_value={"sessionId": "sess-1"}):
            from src.session_events_ingest import handler
            bad = _evt(0, kind="bogus.kind")
            result = handler(_make_event(body={"events": [bad]}), {})
            assert result["statusCode"] == 400
            assert "unknown kind" in json.loads(result["body"])["error"]

    def test_rejects_non_integer_seq(self):
        with patch("src.session_events_ingest.get_session", return_value={"sessionId": "sess-1"}):
            from src.session_events_ingest import handler
            bad = _evt(0)
            bad["seq"] = "abc"
            result = handler(_make_event(body={"events": [bad]}), {})
            assert result["statusCode"] == 400

    def test_rejects_missing_created_at(self):
        with patch("src.session_events_ingest.get_session", return_value={"sessionId": "sess-1"}):
            from src.session_events_ingest import handler
            bad = _evt(0)
            del bad["createdAt"]
            result = handler(_make_event(body={"events": [bad]}), {})
            assert result["statusCode"] == 400

    def test_rejects_oversize_payload(self):
        with patch("src.session_events_ingest.get_session", return_value={"sessionId": "sess-1"}):
            from src.session_events_ingest import handler
            big = _evt(0, payload={"text": "x" * 40_000})
            result = handler(_make_event(body={"events": [big]}), {})
            assert result["statusCode"] == 400

    def test_compacts_oversize_tool_started_payload(self):
        big = _evt(
            0,
            kind="tool.started",
            payload={
                "toolName": "Write",
                "input": {
                    "file_path": "/tmp/SPECIFICATION.md",
                    "content": "x" * 40_000,
                },
            },
        )

        with patch("src.session_events_ingest.get_session",
                   return_value={"sessionId": "sess-1"}), \
             patch("src.session_events_ingest.put_session_events_batch",
                   return_value=(1, 0, 0)) as mock_put, \
             patch("src.session_events_ingest.advance_session_event_cursor"), \
             patch("src.session_events_ingest.reserve_message_seqs",
                   return_value=1), \
             patch("src.session_events_ingest.put_message") as mock_put_msg:
            from src.session_events_ingest import handler, MAX_PAYLOAD_BYTES

            result = handler(_make_event(body={"events": [big]}), {})

            assert result["statusCode"] == 200
            prepared = mock_put.call_args.args[0]
            payload = prepared[0]["payload"]
            assert payload["toolName"] == "Write"
            assert payload["input"]["file_path"] == "/tmp/SPECIFICATION.md"
            assert "truncated" in payload["input"]["content"]
            dumped = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
            assert len(dumped.encode("utf-8")) <= MAX_PAYLOAD_BYTES

            native = json.loads(mock_put_msg.call_args.args[3])
            assert native["type"] == "tool_use"
            assert native["tool"]["name"] == "Write"
            assert native["tool"]["input"]["file_path"] == "/tmp/SPECIFICATION.md"
            assert "truncated" in native["tool"]["input"]["content"]

    def test_rejects_oversize_batch(self):
        with patch("src.session_events_ingest.get_session", return_value={"sessionId": "sess-1"}):
            from src.session_events_ingest import handler
            many = [_evt(i) for i in range(250)]
            result = handler(_make_event(body={"events": many}), {})
            assert result["statusCode"] == 400

    def test_rejects_missing_session(self):
        with patch("src.session_events_ingest.get_session", return_value=None):
            from src.session_events_ingest import handler
            result = handler(_make_event(body={"events": [_evt(0)]}), {})
            assert result["statusCode"] == 404


class TestIngest:
    def test_writes_batch_and_advances_cursor(self):
        events = [_evt(0), _evt(1), _evt(2)]

        with patch("src.session_events_ingest.get_session",
                   return_value={"sessionId": "sess-1"}), \
             patch("src.session_events_ingest.put_session_events_batch",
                   return_value=(3, 0, 2)) as mock_put, \
             patch("src.session_events_ingest.advance_session_event_cursor") as mock_advance:
            from src.session_events_ingest import handler

            result = handler(_make_event(body={"events": events}), {})

            assert result["statusCode"] == 200
            body = json.loads(result["body"])
            assert body["inserted"] == 3
            assert body["skipped"] == 0
            assert body["acceptedThroughSeq"] == 2

            mock_put.assert_called_once()
            prepared = mock_put.call_args.args[0]
            assert len(prepared) == 3
            assert all("sessionId" in e for e in prepared)

            mock_advance.assert_called_once()
            # Cursor bumped to highest seq + its createdAt
            args = mock_advance.call_args.args
            assert args[0] == "sess-1"
            assert args[1] == 2

    def test_duplicate_seq_is_skipped_not_error(self):
        with patch("src.session_events_ingest.get_session",
                   return_value={"sessionId": "sess-1"}), \
             patch("src.session_events_ingest.put_session_events_batch",
                   return_value=(1, 2, 0)), \
             patch("src.session_events_ingest.advance_session_event_cursor"):
            from src.session_events_ingest import handler

            result = handler(_make_event(body={"events": [_evt(0), _evt(1), _evt(2)]}), {})
            assert result["statusCode"] == 200
            assert json.loads(result["body"])["skipped"] == 2

    def test_all_duplicates_does_not_advance_cursor(self):
        with patch("src.session_events_ingest.get_session",
                   return_value={"sessionId": "sess-1"}), \
             patch("src.session_events_ingest.put_session_events_batch",
                   return_value=(0, 3, None)), \
             patch("src.session_events_ingest.advance_session_event_cursor") as mock_advance:
            from src.session_events_ingest import handler

            handler(_make_event(body={"events": [_evt(0), _evt(1), _evt(2)]}), {})

            mock_advance.assert_not_called()


class TestRunFinished:
    def test_run_finished_triggers_completion(self):
        events = [
            _evt(0, kind="assistant.message"),
            _evt(1, kind="run.finished", payload={"outcome": "success", "durationMs": 1000}),
        ]

        with patch("src.session_events_ingest.get_session",
                   return_value={"sessionId": "sess-1"}), \
             patch("src.session_events_ingest.put_session_events_batch",
                   return_value=(2, 0, 1)), \
             patch("src.session_events_ingest.advance_session_event_cursor"), \
             patch("src.chat._complete_session_and_notify") as mock_complete:
            from src.session_events_ingest import handler

            result = handler(_make_event(body={"events": events}), {})

            assert result["statusCode"] == 200
            mock_complete.assert_called_once_with("sess-1")

    def test_no_run_finished_does_not_trigger_completion(self):
        events = [_evt(0), _evt(1)]

        with patch("src.session_events_ingest.get_session",
                   return_value={"sessionId": "sess-1"}), \
             patch("src.session_events_ingest.put_session_events_batch",
                   return_value=(2, 0, 1)), \
             patch("src.session_events_ingest.advance_session_event_cursor"), \
             patch("src.chat._complete_session_and_notify") as mock_complete:
            from src.session_events_ingest import handler

            handler(_make_event(body={"events": events}), {})
            mock_complete.assert_not_called()

    def test_completion_failure_does_not_fail_ingest(self):
        """If _complete_session_and_notify throws, we still return 200 —
        the events were written, and the watchdog will eventually complete
        the session. Losing the ingest response would force the uploader
        to retry and emit duplicate events."""
        events = [_evt(0, kind="run.finished", payload={"outcome": "success"})]

        with patch("src.session_events_ingest.get_session",
                   return_value={"sessionId": "sess-1"}), \
             patch("src.session_events_ingest.put_session_events_batch",
                   return_value=(1, 0, 0)), \
             patch("src.session_events_ingest.advance_session_event_cursor"), \
             patch("src.session_events_ingest.reserve_message_seqs",
                   return_value=1), \
             patch("src.session_events_ingest.put_message"), \
             patch("src.chat._complete_session_and_notify",
                   side_effect=RuntimeError("downstream boom")):
            from src.session_events_ingest import handler

            result = handler(_make_event(body={"events": events}), {})
            assert result["statusCode"] == 200


class TestMessagesMirror:
    """The ingest path mirrors transcript-visible events to pe-messages-prod
    so a reload mid-turn (or after a missed completion_hook) still shows the
    agent reply. Covers the bug where agent messages disappeared on reload
    because only completion_hook wrote to the messages table."""

    def test_mirrors_assistant_message_to_messages_table(self):
        events = [
            _evt(0, kind="assistant.message", payload={"text": "hello world"}),
        ]

        with patch("src.session_events_ingest.get_session",
                   return_value={"sessionId": "sess-1", "nextSeq": 10}), \
             patch("src.session_events_ingest.put_session_events_batch",
                   return_value=(1, 0, 0)), \
             patch("src.session_events_ingest.advance_session_event_cursor"), \
             patch("src.session_events_ingest.reserve_message_seqs",
                   return_value=10) as mock_reserve, \
             patch("src.session_events_ingest.put_message") as mock_put_msg:
            from src.session_events_ingest import handler

            result = handler(_make_event(body={"events": events}), {})

            assert result["statusCode"] == 200
            mock_reserve.assert_called_once_with("sess-1", 1)
            mock_put_msg.assert_called_once()
            args = mock_put_msg.call_args.args
            assert args[0] == "sess-1"
            assert args[1] == 10
            assert args[2] == "agent"
            native = json.loads(args[3])
            assert native["type"] == "assistant"
            assert native["message"]["content"][0]["text"] == "hello world"

    def test_mirrors_tool_started_and_finished(self):
        events = [
            _evt(0, kind="tool.started",
                 payload={"toolName": "Bash", "input": {"command": "ls"}}),
            _evt(1, kind="tool.finished",
                 payload={"output": "file.txt\n", "isError": False}),
        ]

        with patch("src.session_events_ingest.get_session",
                   return_value={"sessionId": "sess-1", "nextSeq": 5}), \
             patch("src.session_events_ingest.put_session_events_batch",
                   return_value=(2, 0, 1)), \
             patch("src.session_events_ingest.advance_session_event_cursor"), \
             patch("src.session_events_ingest.reserve_message_seqs",
                   return_value=5), \
             patch("src.session_events_ingest.put_message") as mock_put_msg:
            from src.session_events_ingest import handler

            handler(_make_event(body={"events": events}), {})

            assert mock_put_msg.call_count == 2
            tool_use = json.loads(mock_put_msg.call_args_list[0].args[3])
            assert tool_use["type"] == "tool_use"
            assert tool_use["tool"]["name"] == "Bash"
            tool_result = json.loads(mock_put_msg.call_args_list[1].args[3])
            assert tool_result["type"] == "tool_result"
            assert tool_result["content"] == "file.txt\n"
            assert tool_result["is_error"] is False

    def test_skips_non_transcript_kinds(self):
        """run.started, status, heartbeat, and text_delta don't carry
        content the reload path needs — they shouldn't allocate seqs or
        write rows."""
        events = [
            _evt(0, kind="run.started", payload={"agent": "claude"}),
            _evt(1, kind="assistant.text_delta", payload={"text": "he"}),
            _evt(2, kind="heartbeat", payload={}),
            _evt(3, kind="status", payload={"state": "thinking"}),
        ]

        with patch("src.session_events_ingest.get_session",
                   return_value={"sessionId": "sess-1", "nextSeq": 3}), \
             patch("src.session_events_ingest.put_session_events_batch",
                   return_value=(4, 0, 3)), \
             patch("src.session_events_ingest.advance_session_event_cursor"), \
             patch("src.session_events_ingest.reserve_message_seqs") as mock_reserve, \
             patch("src.session_events_ingest.put_message") as mock_put_msg:
            from src.session_events_ingest import handler

            handler(_make_event(body={"events": events}), {})

            mock_reserve.assert_not_called()
            mock_put_msg.assert_not_called()

    def test_only_mirrors_newly_inserted_events_on_retry(self):
        """Uploader retries can replay events that are already in the
        events table. We must not mirror those again — the suffix filter
        keeps only newly-inserted events, avoiding duplicate agent rows."""
        events = [
            _evt(10, kind="assistant.message", payload={"text": "old-a"}),
            _evt(11, kind="assistant.message", payload={"text": "old-b"}),
            _evt(12, kind="assistant.message", payload={"text": "new-c"}),
        ]

        with patch("src.session_events_ingest.get_session",
                   return_value={"sessionId": "sess-1", "nextSeq": 20}), \
             patch("src.session_events_ingest.put_session_events_batch",
                   return_value=(1, 2, 12)), \
             patch("src.session_events_ingest.advance_session_event_cursor"), \
             patch("src.session_events_ingest.reserve_message_seqs",
                   return_value=20) as mock_reserve, \
             patch("src.session_events_ingest.put_message") as mock_put_msg:
            from src.session_events_ingest import handler

            handler(_make_event(body={"events": events}), {})

            mock_reserve.assert_called_once_with("sess-1", 1)
            assert mock_put_msg.call_count == 1
            written = json.loads(mock_put_msg.call_args.args[3])
            assert written["message"]["content"][0]["text"] == "new-c"

    def test_no_mirror_when_all_events_duplicate(self):
        events = [_evt(0), _evt(1), _evt(2)]

        with patch("src.session_events_ingest.get_session",
                   return_value={"sessionId": "sess-1", "nextSeq": 5}), \
             patch("src.session_events_ingest.put_session_events_batch",
                   return_value=(0, 3, None)), \
             patch("src.session_events_ingest.advance_session_event_cursor"), \
             patch("src.session_events_ingest.reserve_message_seqs") as mock_reserve, \
             patch("src.session_events_ingest.put_message") as mock_put_msg:
            from src.session_events_ingest import handler

            handler(_make_event(body={"events": events}), {})

            mock_reserve.assert_not_called()
            mock_put_msg.assert_not_called()

    def test_missing_next_seq_skips_mirror_silently(self):
        """If reserve_message_seqs returns None (nextSeq missing on session),
        skip the mirror rather than corrupting the seq stream."""
        events = [_evt(0, kind="assistant.message", payload={"text": "hi"})]

        with patch("src.session_events_ingest.get_session",
                   return_value={"sessionId": "sess-1"}), \
             patch("src.session_events_ingest.put_session_events_batch",
                   return_value=(1, 0, 0)), \
             patch("src.session_events_ingest.advance_session_event_cursor"), \
             patch("src.session_events_ingest.reserve_message_seqs",
                   return_value=None), \
             patch("src.session_events_ingest.put_message") as mock_put_msg:
            from src.session_events_ingest import handler

            result = handler(_make_event(body={"events": events}), {})

            assert result["statusCode"] == 200
            mock_put_msg.assert_not_called()


class TestSessionRemote:
    """Tests for the session.remote kind, which reconciles the DDB session's
    `remoteSessionId` with the agent-assigned thread id (e.g. Codex's
    rollout UUID). Without this, the sync daemon pulls the .jsonl named
    by the real id and registers it as a duplicate "synced..." session."""

    def _session_remote_evt(self, seq, rsid, agent="codex"):
        return {
            "seq": seq,
            "kind": "session.remote",
            "payload": {"remoteSessionId": rsid, "agent": agent},
            "createdAt": f"2026-04-17T00:00:{seq:02d}Z",
            "turnId": "t-1",
        }

    def test_session_remote_kind_is_allowed(self):
        events = [self._session_remote_evt(0, "019dafab-0000-7000-8000-000000000000")]

        with patch("src.session_events_ingest.get_session",
                   return_value={"sessionId": "sess-1", "remoteSessionId": "ghost-uuid"}), \
             patch("src.session_events_ingest.put_session_events_batch",
                   return_value=(1, 0, 0)), \
             patch("src.session_events_ingest.advance_session_event_cursor"), \
             patch("src.session_events_ingest.update_session"):
            from src.session_events_ingest import handler

            result = handler(_make_event(body={"events": events}), {})
            assert result["statusCode"] == 200

    def test_session_remote_updates_remote_session_id(self):
        """When a session.remote event arrives with a real rollout UUID,
        the DDB session row is updated so subsequent .jsonl pulls merge
        into this session instead of creating a duplicate."""
        real_rsid = "019dafab-0000-7000-8000-000000000000"
        events = [
            _evt(0, kind="assistant.message"),
            self._session_remote_evt(1, real_rsid),
        ]

        with patch("src.session_events_ingest.get_session",
                   return_value={"sessionId": "sess-1", "remoteSessionId": "ghost-uuid"}), \
             patch("src.session_events_ingest.put_session_events_batch",
                   return_value=(2, 0, 1)), \
             patch("src.session_events_ingest.advance_session_event_cursor"), \
             patch("src.session_events_ingest.update_session") as mock_update:
            from src.session_events_ingest import handler

            result = handler(_make_event(body={"events": events}), {})
            assert result["statusCode"] == 200

            mock_update.assert_called_once_with("sess-1", {"remoteSessionId": real_rsid})

    def test_session_remote_skips_update_when_already_matches(self):
        """Avoid redundant DDB writes when the rsid is already correct
        (e.g. replay of the same event batch)."""
        rsid = "019dafab-0000-7000-8000-000000000000"
        events = [self._session_remote_evt(0, rsid)]

        with patch("src.session_events_ingest.get_session",
                   return_value={"sessionId": "sess-1", "remoteSessionId": rsid}), \
             patch("src.session_events_ingest.put_session_events_batch",
                   return_value=(1, 0, 0)), \
             patch("src.session_events_ingest.advance_session_event_cursor"), \
             patch("src.session_events_ingest.update_session") as mock_update:
            from src.session_events_ingest import handler

            result = handler(_make_event(body={"events": events}), {})
            assert result["statusCode"] == 200
            mock_update.assert_not_called()

    def test_run_finished_success_mirrored_as_result(self):
        events = [
            _evt(0, kind="run.finished",
                 payload={"outcome": "success", "durationMs": 1234}),
        ]

        with patch("src.session_events_ingest.get_session",
                   return_value={"sessionId": "sess-1", "nextSeq": 7}), \
             patch("src.session_events_ingest.put_session_events_batch",
                   return_value=(1, 0, 0)), \
             patch("src.session_events_ingest.advance_session_event_cursor"), \
             patch("src.session_events_ingest.reserve_message_seqs",
                   return_value=7), \
             patch("src.session_events_ingest.put_message") as mock_put_msg, \
             patch("src.chat._complete_session_and_notify"):
            from src.session_events_ingest import handler

            handler(_make_event(body={"events": events}), {})

            mock_put_msg.assert_called_once()
            native = json.loads(mock_put_msg.call_args.args[3])
            assert native["type"] == "result"
            assert native["subtype"] == "success"
            assert native["duration_ms"] == 1234
            assert "is_error" not in native

    def test_run_finished_error_carries_error_field(self):
        events = [
            _evt(0, kind="run.finished",
                 payload={"outcome": "error", "error": "tool timeout"}),
        ]

        with patch("src.session_events_ingest.get_session",
                   return_value={"sessionId": "sess-1", "nextSeq": 3}), \
             patch("src.session_events_ingest.put_session_events_batch",
                   return_value=(1, 0, 0)), \
             patch("src.session_events_ingest.advance_session_event_cursor"), \
             patch("src.session_events_ingest.reserve_message_seqs",
                   return_value=3), \
             patch("src.session_events_ingest.put_message") as mock_put_msg, \
             patch("src.chat._complete_session_and_notify"):
            from src.session_events_ingest import handler

            handler(_make_event(body={"events": events}), {})

            native = json.loads(mock_put_msg.call_args.args[3])
            assert native["subtype"] == "error"
            assert native["is_error"] is True
            assert native["result"] == "tool timeout"

    def test_session_remote_update_failure_does_not_fail_ingest(self):
        """A failed rsid reconcile must not fail the whole batch — the
        events are already persisted, and the watchdog will eventually
        reconcile via the poll path's _extract_remote_session_id."""
        events = [self._session_remote_evt(0, "019dafab-0000-7000-8000-000000000000")]

        with patch("src.session_events_ingest.get_session",
                   return_value={"sessionId": "sess-1", "remoteSessionId": "ghost-uuid"}), \
             patch("src.session_events_ingest.put_session_events_batch",
                   return_value=(1, 0, 0)), \
             patch("src.session_events_ingest.advance_session_event_cursor"), \
             patch("src.session_events_ingest.update_session",
                   side_effect=RuntimeError("ddb boom")):
            from src.session_events_ingest import handler

            result = handler(_make_event(body={"events": events}), {})
            assert result["statusCode"] == 200

    def test_session_remote_ignores_empty_rsid(self):
        """Malformed bridge output (missing remoteSessionId in payload)
        should not cause an update to an empty string."""
        bad = {
            "seq": 0,
            "kind": "session.remote",
            "payload": {"agent": "codex"},
            "createdAt": "2026-04-17T00:00:00Z",
            "turnId": "t-1",
        }

        with patch("src.session_events_ingest.get_session",
                   return_value={"sessionId": "sess-1", "remoteSessionId": "ghost"}), \
             patch("src.session_events_ingest.put_session_events_batch",
                   return_value=(1, 0, 0)), \
             patch("src.session_events_ingest.advance_session_event_cursor"), \
             patch("src.session_events_ingest.update_session") as mock_update:
            from src.session_events_ingest import handler

            result = handler(_make_event(body={"events": [bad]}), {})
            assert result["statusCode"] == 200
            mock_update.assert_not_called()
