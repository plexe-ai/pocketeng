"""Tests for the pure utility functions in chat.py."""
import json

import pytest

from src.chat import (
    _extract_remote_session_id,
    _normalize_session_id,
    _parse_output_lines,
    _session_paths,
    respond,
)


class TestNormalizeSessionId:
    def test_returns_session_id_when_provided(self):
        assert _normalize_session_id("my-session") == "my-session"

    def test_returns_output_file_id_when_no_session_id(self):
        assert _normalize_session_id(None, "file-id-123") == "file-id-123"

    def test_prefers_session_id_over_output_file_id(self):
        assert _normalize_session_id("sess", "file") == "sess"

    def test_generates_uuid_when_both_none(self):
        result = _normalize_session_id(None, None)
        assert len(result) == 32  # uuid4 hex


class TestSessionPaths:
    def test_returns_out_and_pid_paths(self):
        out, pid = _session_paths("abc123")
        assert out == "/tmp/pe-out-abc123.jsonl"
        assert pid == "/tmp/pe-pid-abc123"

    def test_quotes_special_characters(self):
        out, pid = _session_paths("test;rm -rf /")
        assert ";" not in out.split("pe-out-")[1].split(".jsonl")[0] or "'" in out


class TestExtractRemoteSessionId:
    def test_extracts_from_init_event(self):
        line = json.dumps({"type": "system", "subtype": "init", "session_id": "remote-abc"})
        assert _extract_remote_session_id(line) == "remote-abc"

    def test_returns_none_for_non_init(self):
        line = json.dumps({"type": "assistant", "message": "hello"})
        assert _extract_remote_session_id(line) is None

    def test_returns_none_for_invalid_json(self):
        assert _extract_remote_session_id("not json at all") is None

    def test_returns_none_for_empty_string(self):
        assert _extract_remote_session_id("") is None

    def test_returns_none_for_system_non_init(self):
        line = json.dumps({"type": "system", "subtype": "other"})
        assert _extract_remote_session_id(line) is None

    def test_extracts_from_thread_started_event(self):
        line = json.dumps({"type": "thread.started", "thread_id": "019dafab-000"})
        assert _extract_remote_session_id(line) == "019dafab-000"


class TestPersistAgentOutputRsidPreference:
    """`_persist_agent_output` must prefer `thread.started` over
    `system/init` when extracting the remote session id.

    The bridge's `emitInit` echoes PE_SESSION_ID (our internal chat id)
    on the init line for event routing — NOT the agent's real thread
    id. If `_persist_agent_output` grabs that as the rsid, it clobbers
    the correct value written earlier by the `session.remote` ingest
    path and breaks the sync daemon's ability to match pulled .jsonl
    files back to the session. This was the Codex duplicate-session
    regression."""

    def test_prefers_thread_started_over_system_init(self):
        from unittest.mock import MagicMock, patch
        raw_lines = [
            json.dumps({"type": "system", "subtype": "init", "session_id": "synced019dafcf98577331af5b3a2c8c"}),
            json.dumps({"type": "thread.started", "thread_id": "019dafd1-e4e8-7662-a7f4-209a8f0f8b2c"}),
            json.dumps({"type": "result", "subtype": "success"}),
        ]
        mock_advance = MagicMock()
        with patch("src.chat.advance_session_run", side_effect=mock_advance), \
             patch("src.chat.put_message"), \
             patch("src.chat._should_skip_persist", return_value=(False, None)):
            from src.chat import _persist_agent_output
            _persist_agent_output(
                session_id="synced019dafcf98577331af5b3a2c8c",
                session={"currentRunSeqBase": 1},
                raw_lines=raw_lines,
                offset=0,
            )

        mock_advance.assert_called_once()
        updates = mock_advance.call_args[0][3]
        assert updates["remoteSessionId"] == "019dafd1-e4e8-7662-a7f4-209a8f0f8b2c"

    def test_falls_back_to_system_init_when_no_thread_started(self):
        """Back-compat: Claude's and Cursor's rsid still flows from the
        init line when the bridge doesn't emit `thread.started`."""
        from unittest.mock import MagicMock, patch
        raw_lines = [
            json.dumps({"type": "system", "subtype": "init", "session_id": "claude-real-rsid"}),
            json.dumps({"type": "result", "subtype": "success"}),
        ]
        mock_advance = MagicMock()
        with patch("src.chat.advance_session_run", side_effect=mock_advance), \
             patch("src.chat.put_message"), \
             patch("src.chat._should_skip_persist", return_value=(False, None)):
            from src.chat import _persist_agent_output
            _persist_agent_output(
                session_id="sess-1",
                session={"currentRunSeqBase": 1},
                raw_lines=raw_lines,
                offset=0,
            )

        mock_advance.assert_called_once()
        updates = mock_advance.call_args[0][3]
        assert updates["remoteSessionId"] == "claude-real-rsid"


class TestParseOutputLines:
    def test_parses_valid_json_lines(self):
        raw = '{"type": "assistant", "message": "hello"}\n{"type": "tool_use", "name": "Bash"}\n'
        raw_lines, lines = _parse_output_lines(raw)
        assert len(raw_lines) == 2
        assert len(lines) == 2
        assert lines[0]["type"] == "assistant"
        assert lines[1]["type"] == "tool_use"

    def test_wraps_non_json_as_text(self):
        raw = "plain text line\n"
        raw_lines, lines = _parse_output_lines(raw)
        assert len(lines) == 1
        assert lines[0]["type"] == "text"
        assert lines[0]["content"] == "plain text line"

    def test_handles_empty_input(self):
        raw_lines, lines = _parse_output_lines("")
        assert raw_lines == []
        assert lines == []

    def test_handles_whitespace_only(self):
        raw_lines, lines = _parse_output_lines("   \n\n  \n")
        assert raw_lines == []
        assert lines == []

    def test_strips_whitespace_from_lines(self):
        raw = '  {"type": "text"}  \n'
        raw_lines, lines = _parse_output_lines(raw)
        assert raw_lines[0] == '{"type": "text"}'

    def test_mixed_json_and_plain(self):
        raw = '{"type": "assistant"}\nSome plain text\n{"type": "result"}\n'
        raw_lines, lines = _parse_output_lines(raw)
        assert len(lines) == 3
        assert lines[0]["type"] == "assistant"
        assert lines[1]["type"] == "text"
        assert lines[2]["type"] == "result"


class TestRespond:
    def test_returns_correct_structure(self):
        result = respond(200, {"status": "ok"})
        assert result["statusCode"] == 200
        assert result["headers"]["Content-Type"] == "application/json"
        assert json.loads(result["body"]) == {"status": "ok"}

    def test_error_response(self):
        result = respond(400, {"error": "bad request"})
        assert result["statusCode"] == 400
        assert json.loads(result["body"])["error"] == "bad request"
