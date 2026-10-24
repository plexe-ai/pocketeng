"""Tests for the NDJSON transcript parser — pure functions, no mocks."""
import json

import pytest

from src.lib.transcript import (
    _extract_tool_input,
    _get_string,
    _is_structured_line,
    _parse_event,
    _strip_ansi,
    _structured_json,
    materialize_transcript,
)


class TestStripAnsi:
    def test_strips_color_codes(self):
        assert _strip_ansi("\x1b[31mred\x1b[0m") == "red"

    def test_no_op_on_plain_text(self):
        assert _strip_ansi("hello world") == "hello world"

    def test_handles_none(self):
        assert _strip_ansi(None) == ""

    def test_handles_empty(self):
        assert _strip_ansi("") == ""


class TestGetString:
    def test_returns_string(self):
        assert _get_string("hello") == "hello"

    def test_returns_none_for_empty(self):
        assert _get_string("") is None

    def test_returns_none_for_non_string(self):
        assert _get_string(123) is None
        assert _get_string(None) is None
        assert _get_string([]) is None


class TestStructuredJson:
    def test_parses_valid_json_dict(self):
        result = _structured_json('{"type": "assistant"}')
        assert result == {"type": "assistant"}

    def test_returns_none_for_invalid_json(self):
        assert _structured_json("not json") is None

    def test_returns_none_for_json_array(self):
        assert _structured_json("[1, 2, 3]") is None

    def test_returns_none_for_empty(self):
        assert _structured_json("") is None

    def test_strips_ansi_before_parsing(self):
        result = _structured_json('\x1b[32m{"type": "text"}\x1b[0m')
        assert result == {"type": "text"}


class TestIsStructuredLine:
    def test_true_for_typed_json(self):
        assert _is_structured_line('{"type": "assistant"}') is True

    def test_false_for_untyped_json(self):
        assert _is_structured_line('{"key": "value"}') is False

    def test_false_for_plain_text(self):
        assert _is_structured_line("hello") is False


class TestExtractToolInput:
    def test_extracts_command(self):
        assert _extract_tool_input({"command": "ls -la"}) == "ls -la"

    def test_extracts_file_path(self):
        assert _extract_tool_input({"file_path": "/tmp/foo.py"}) == "/tmp/foo.py"

    def test_extracts_pattern(self):
        assert _extract_tool_input({"pattern": "def hello"}) == "def hello"

    def test_extracts_old_string_as_edit(self):
        result = _extract_tool_input({"old_string": "original code"})
        assert result.startswith("edit:")

    def test_truncates_prompt(self):
        long_prompt = "x" * 200
        result = _extract_tool_input({"prompt": long_prompt})
        assert len(result) <= 100

    def test_returns_empty_for_none(self):
        assert _extract_tool_input(None) == ""

    def test_returns_empty_for_non_dict(self):
        assert _extract_tool_input("string") == ""


class TestParseEvent:
    def test_assistant_text(self):
        line = json.dumps({
            "type": "assistant",
            "message": {"content": [{"type": "text", "text": "Hello!"}]},
        })
        event = _parse_event(line)
        assert event is not None
        assert event["kind"] == "assistant_snapshot"
        assert event["text"] == "Hello!"

    def test_tool_use(self):
        line = json.dumps({
            "type": "tool_use",
            "tool": {"name": "Bash", "input": {"command": "ls -la"}},
        })
        event = _parse_event(line)
        assert event is not None
        assert event["kind"] == "tool_use"
        assert event["toolName"] == "Bash"
        assert "ls -la" in event["input"]

    def test_tool_result(self):
        line = json.dumps({
            "type": "tool_result",
            "content": "file1.txt\nfile2.txt",
            "is_error": False,
        })
        event = _parse_event(line)
        assert event is not None
        assert event["kind"] == "tool_result"
        assert "file1.txt" in event["output"]
        assert event["isError"] is False

    def test_tool_result_error(self):
        line = json.dumps({
            "type": "tool_result",
            "content": "Permission denied",
            "is_error": True,
        })
        event = _parse_event(line)
        assert event["isError"] is True

    def test_system_init(self):
        line = json.dumps({
            "type": "system",
            "subtype": "init",
            "session_id": "sess-abc",
        })
        event = _parse_event(line)
        assert event is not None
        assert event["kind"] == "initialized"
        assert event["sessionId"] == "sess-abc"

    def test_result_success(self):
        line = json.dumps({
            "type": "result",
            "subtype": "success",
            "result": "All done",
        })
        event = _parse_event(line)
        assert event["kind"] == "completed"
        assert event["status"] == "success"

    def test_result_error(self):
        line = json.dumps({
            "type": "result",
            "is_error": True,
            "result": "Something broke",
        })
        event = _parse_event(line)
        assert event["kind"] == "error"
        assert "Something broke" in event["message"]

    def test_content_block_delta(self):
        line = json.dumps({
            "type": "content_block_delta",
            "delta": {"type": "text_delta", "text": "chunk"},
        })
        event = _parse_event(line)
        assert event["kind"] == "assistant_text"
        assert event["text"] == "chunk"

    def test_text_event(self):
        line = json.dumps({"type": "text", "content": "simple text"})
        event = _parse_event(line)
        assert event["kind"] == "assistant_text"
        assert event["text"] == "simple text"

    def test_returns_none_for_plain_text(self):
        assert _parse_event("just a string") is None

    def test_returns_none_for_unknown_type(self):
        line = json.dumps({"type": "unknown_event", "data": "foo"})
        assert _parse_event(line) is None

    def test_nested_tool_result_in_user_event(self):
        line = json.dumps({
            "type": "user",
            "message": {
                "content": [
                    {"type": "tool_result", "content": "output text", "is_error": False},
                ],
            },
        })
        event = _parse_event(line)
        assert event is not None
        assert event["kind"] == "tool_result"
        assert "output text" in event["output"]


class TestMaterializeTranscript:
    def test_empty_messages(self):
        assert materialize_transcript([]) == []

    def test_single_user_message(self):
        messages = [
            {"seq": 0, "role": "user", "content": "hello", "createdAt": "2024-01-01"},
        ]
        transcript = materialize_transcript(messages)
        assert len(transcript) == 1
        assert transcript[0]["role"] == "user"
        assert transcript[0]["content"] == "hello"

    def test_user_then_agent_text(self):
        messages = [
            {"seq": 0, "role": "user", "content": "hi", "createdAt": "2024-01-01", "sessionId": "s1"},
            {"seq": 1, "role": "agent", "content": json.dumps({
                "type": "assistant",
                "message": {"content": [{"type": "text", "text": "Hello!"}]},
            }), "createdAt": "2024-01-01", "sessionId": "s1"},
        ]
        transcript = materialize_transcript(messages)
        assert len(transcript) == 2
        assert transcript[0]["role"] == "user"
        assert transcript[1]["role"] == "assistant"
        assert "Hello!" in transcript[1]["content"]

    def test_agent_with_tool_use(self):
        messages = [
            {"seq": 0, "role": "agent", "content": json.dumps({
                "type": "tool_use",
                "tool": {"name": "Bash", "input": {"command": "ls"}},
            }), "createdAt": "2024-01-01", "sessionId": "s1"},
            {"seq": 1, "role": "agent", "content": json.dumps({
                "type": "tool_result",
                "content": "file1.txt",
                "is_error": False,
            }), "createdAt": "2024-01-01", "sessionId": "s1"},
        ]
        transcript = materialize_transcript(messages)
        assert len(transcript) == 1
        assert transcript[0]["role"] == "assistant"
        assert len(transcript[0]["tools"]) == 1
        assert transcript[0]["tools"][0]["toolName"] == "Bash"
        assert "file1.txt" in transcript[0]["tools"][0]["output"]

    def test_running_session_marks_interrupted(self):
        messages = [
            {"seq": 0, "role": "agent", "content": json.dumps({
                "type": "assistant",
                "message": {"content": [{"type": "text", "text": "Working..."}]},
            }), "createdAt": "2024-01-01", "sessionId": "s1"},
        ]
        transcript = materialize_transcript(messages, session_status="running")
        assert transcript[0]["state"] == "interrupted"

    def test_done_session_marks_complete(self):
        messages = [
            {"seq": 0, "role": "agent", "content": json.dumps({
                "type": "assistant",
                "message": {"content": [{"type": "text", "text": "Done."}]},
            }), "createdAt": "2024-01-01", "sessionId": "s1"},
        ]
        transcript = materialize_transcript(messages, session_status="done")
        assert transcript[0]["state"] == "complete"


class TestCursorEventParsing:
    """Verify Cursor CLI tool_call events are parsed correctly."""

    def test_tool_call_started_read(self):
        line = json.dumps({
            "type": "tool_call",
            "subtype": "started",
            "call_id": "call-1",
            "tool_call": {"readToolCall": {"args": {"path": "README.md"}}},
        })
        event = _parse_event(line)
        assert event is not None
        assert event["kind"] == "tool_use"
        assert event["toolName"] == "Read"
        assert "README.md" in event["input"]

    def test_tool_call_started_write(self):
        line = json.dumps({
            "type": "tool_call",
            "subtype": "started",
            "call_id": "call-2",
            "tool_call": {"writeToolCall": {"args": {"path": "out.txt", "fileText": "hello"}}},
        })
        event = _parse_event(line)
        assert event["kind"] == "tool_use"
        assert event["toolName"] == "Write"

    def test_tool_call_started_function(self):
        line = json.dumps({
            "type": "tool_call",
            "subtype": "started",
            "call_id": "call-3",
            "tool_call": {"function": {"name": "Bash", "arguments": "{\"command\":\"ls -la\"}"}},
        })
        event = _parse_event(line)
        assert event["kind"] == "tool_use"
        assert event["toolName"] == "Bash"

    def test_tool_call_completed_with_success(self):
        line = json.dumps({
            "type": "tool_call",
            "subtype": "completed",
            "call_id": "call-1",
            "tool_call": {
                "readToolCall": {
                    "args": {"path": "README.md"},
                    "result": {"success": {"content": "# Hello\nWorld", "totalLines": 2}},
                },
            },
        })
        event = _parse_event(line)
        assert event["kind"] == "tool_use_with_result"
        assert event["toolName"] == "Read"
        assert "Hello" in event["output"]
        assert event["isError"] is False

    def test_tool_call_completed_with_error(self):
        line = json.dumps({
            "type": "tool_call",
            "subtype": "completed",
            "call_id": "call-5",
            "tool_call": {
                "readToolCall": {
                    "args": {"path": "missing.txt"},
                    "result": {"error": {"message": "File not found"}},
                },
            },
        })
        event = _parse_event(line)
        assert event["kind"] == "tool_use_with_result"
        assert event["isError"] is True
        assert "not found" in event["output"]

    def test_tool_call_completed_write_success(self):
        line = json.dumps({
            "type": "tool_call",
            "subtype": "completed",
            "call_id": "call-6",
            "tool_call": {
                "writeToolCall": {
                    "args": {"path": "out.txt"},
                    "result": {"success": {"path": "/abs/out.txt", "linesCreated": 5, "fileSize": 100}},
                },
            },
        })
        event = _parse_event(line)
        assert event["kind"] == "tool_use_with_result"
        assert event["toolName"] == "Write"
        assert event["isError"] is False

    def test_tool_call_with_no_tool_call_dict_returns_none(self):
        line = json.dumps({"type": "tool_call", "subtype": "started"})
        event = _parse_event(line)
        assert event is None

    def test_cursor_system_init_same_as_claude(self):
        """Cursor emits the same system/init format as Claude Code."""
        line = json.dumps({
            "type": "system",
            "subtype": "init",
            "session_id": "cursor-sess-123",
            "model": "Claude 4 Sonnet",
        })
        event = _parse_event(line)
        assert event["kind"] == "initialized"
        assert event["sessionId"] == "cursor-sess-123"

    def test_cursor_result_same_as_claude(self):
        """Cursor emits the same result format as Claude Code."""
        line = json.dumps({
            "type": "result",
            "subtype": "success",
            "result": "Done",
            "duration_ms": 5000,
        })
        event = _parse_event(line)
        assert event["kind"] == "completed"
        assert event["status"] == "success"


class TestCursorTranscriptMaterialization:
    """End-to-end: Cursor NDJSON lines -> materialized transcript."""

    def test_simple_text_response(self):
        messages = [
            {"seq": 0, "role": "user", "content": "say hello", "createdAt": "t0", "sessionId": "s1"},
            {"seq": 1, "role": "agent", "content": json.dumps(
                {"type": "system", "subtype": "init", "session_id": "c-1"}
            ), "createdAt": "t1", "sessionId": "s1"},
            {"seq": 2, "role": "agent", "content": json.dumps(
                {"type": "assistant", "message": {"role": "assistant",
                 "content": [{"type": "text", "text": "Hello!"}]}}
            ), "createdAt": "t2", "sessionId": "s1"},
            {"seq": 3, "role": "agent", "content": json.dumps(
                {"type": "result", "subtype": "success", "result": "Hello!",
                 "duration_ms": 1000}
            ), "createdAt": "t3", "sessionId": "s1"},
        ]
        transcript = materialize_transcript(messages)
        assert len(transcript) == 2
        assert transcript[0]["role"] == "user"
        assert transcript[1]["role"] == "assistant"
        assert "Hello!" in transcript[1]["content"]
        assert transcript[1]["state"] == "complete"

    def test_tool_call_shows_as_tool(self):
        messages = [
            {"seq": 0, "role": "user", "content": "read file", "createdAt": "t0", "sessionId": "s1"},
            {"seq": 1, "role": "agent", "content": json.dumps({
                "type": "assistant",
                "message": {"role": "assistant",
                            "content": [{"type": "text", "text": "Reading the file."}]},
            }), "createdAt": "t1", "sessionId": "s1"},
            {"seq": 2, "role": "agent", "content": json.dumps({
                "type": "tool_call", "subtype": "completed", "call_id": "c1",
                "tool_call": {
                    "readToolCall": {
                        "args": {"path": "README.md"},
                        "result": {"success": {"content": "file data", "totalLines": 1}},
                    },
                },
            }), "createdAt": "t2", "sessionId": "s1"},
            {"seq": 3, "role": "agent", "content": json.dumps(
                {"type": "result", "subtype": "success", "result": "Done", "duration_ms": 500}
            ), "createdAt": "t3", "sessionId": "s1"},
        ]
        transcript = materialize_transcript(messages)
        assistant_msg = transcript[1]
        assert assistant_msg["role"] == "assistant"
        assert len(assistant_msg["tools"]) == 1
        assert assistant_msg["tools"][0]["toolName"] == "Read"
        assert "file data" in assistant_msg["tools"][0]["output"]
        assert assistant_msg["tools"][0]["isError"] is False


class TestCodexEventParsing:
    """Verify Codex CLI NDJSON events are parsed correctly."""

    def test_thread_started_extracts_session_id(self):
        line = json.dumps({"type": "thread.started", "thread_id": "019d-abcd"})
        event = _parse_event(line)
        assert event == {"kind": "initialized", "sessionId": "019d-abcd"}

    def test_thread_started_without_id_returns_none(self):
        line = json.dumps({"type": "thread.started"})
        event = _parse_event(line)
        assert event is None

    def test_item_completed_agent_message(self):
        line = json.dumps({
            "type": "item.completed",
            "item": {"id": "item_0", "type": "agent_message", "text": "pocketeng_ok"},
        })
        event = _parse_event(line)
        assert event == {"kind": "assistant_text", "text": "pocketeng_ok"}

    def test_item_completed_command_execution(self):
        line = json.dumps({
            "type": "item.completed",
            "item": {
                "id": "item_1",
                "type": "command_execution",
                "command": "ls -la",
                "aggregated_output": "total 8\nfile.txt\n",
                "exit_code": 0,
                "status": "completed",
            },
        })
        event = _parse_event(line)
        assert event["kind"] == "tool_result"
        assert "file.txt" in event["output"]
        assert event["isError"] is False

    def test_item_completed_command_with_nonzero_exit(self):
        line = json.dumps({
            "type": "item.completed",
            "item": {
                "type": "command_execution",
                "command": "false",
                "aggregated_output": "",
                "exit_code": 1,
            },
        })
        event = _parse_event(line)
        assert event["kind"] == "tool_result"
        assert event["isError"] is True

    def test_turn_completed_maps_to_success(self):
        line = json.dumps({
            "type": "turn.completed",
            "usage": {"input_tokens": 100, "output_tokens": 50},
        })
        event = _parse_event(line)
        assert event == {"kind": "completed", "status": "success", "resultText": None}

    def test_turn_started_is_ignored(self):
        line = json.dumps({"type": "turn.started"})
        event = _parse_event(line)
        assert event is None

    def test_item_started_emits_tool_use(self):
        line = json.dumps({
            "type": "item.started",
            "item": {"type": "command_execution", "command": "ls"},
        })
        event = _parse_event(line)
        assert event["kind"] == "tool_use"
        assert event["toolName"] == "Bash"
        assert event["input"] == "ls"

    def test_item_started_agent_message_is_ignored(self):
        line = json.dumps({
            "type": "item.started",
            "item": {"type": "agent_message"},
        })
        event = _parse_event(line)
        assert event is None


class TestCodexTranscriptMaterialization:
    """End-to-end: Codex NDJSON lines → materialized transcript."""

    def test_simple_text_response(self):
        messages = [
            {"seq": 0, "role": "user", "content": "say hello", "createdAt": "t0", "sessionId": "s1"},
            {"seq": 1, "role": "agent", "content": json.dumps(
                {"type": "thread.started", "thread_id": "tid-1"}
            ), "createdAt": "t1", "sessionId": "s1"},
            {"seq": 2, "role": "agent", "content": json.dumps(
                {"type": "item.completed", "item": {"type": "agent_message", "text": "Hello!"}}
            ), "createdAt": "t2", "sessionId": "s1"},
            {"seq": 3, "role": "agent", "content": json.dumps(
                {"type": "turn.completed", "usage": {"input_tokens": 10, "output_tokens": 5}}
            ), "createdAt": "t3", "sessionId": "s1"},
        ]
        transcript = materialize_transcript(messages)
        assert len(transcript) == 2
        assert transcript[0]["role"] == "user"
        assert transcript[1]["role"] == "assistant"
        assert transcript[1]["content"] == "Hello!"
        assert transcript[1]["state"] == "complete"

    def test_command_execution_shows_as_tool(self):
        messages = [
            {"seq": 0, "role": "user", "content": "list files", "createdAt": "t0", "sessionId": "s1"},
            {"seq": 1, "role": "agent", "content": json.dumps(
                {"type": "item.completed", "item": {"type": "agent_message", "text": "Listing files."}}
            ), "createdAt": "t1", "sessionId": "s1"},
            {"seq": 2, "role": "agent", "content": json.dumps({
                "type": "item.started",
                "item": {
                    "type": "command_execution",
                    "command": "ls -la",
                    "aggregated_output": "",
                    "exit_code": None,
                    "status": "in_progress",
                },
            }), "createdAt": "t2", "sessionId": "s1"},
            {"seq": 3, "role": "agent", "content": json.dumps({
                "type": "item.completed",
                "item": {
                    "type": "command_execution",
                    "command": "ls -la",
                    "aggregated_output": "file.txt\n",
                    "exit_code": 0,
                },
            }), "createdAt": "t3", "sessionId": "s1"},
            {"seq": 4, "role": "agent", "content": json.dumps(
                {"type": "turn.completed", "usage": {}}
            ), "createdAt": "t4", "sessionId": "s1"},
        ]
        transcript = materialize_transcript(messages)
        assistant_msg = transcript[1]
        assert assistant_msg["role"] == "assistant"
        assert len(assistant_msg["tools"]) == 1
        assert assistant_msg["tools"][0]["toolName"] == "Bash"
        assert assistant_msg["tools"][0]["input"] == "ls -la"
        assert assistant_msg["tools"][0]["output"] == "file.txt\n"
        assert assistant_msg["tools"][0]["isError"] is False


class TestStreamingUX:
    """Verify that events from ALL agents produce meaningful parsed output
    line-by-line as they arrive — not just in batch.

    This simulates what the frontend receives during live polling: each NDJSON
    line is parsed independently via _parse_event. If any line returns None
    when it should produce a visible UI element, the user sees nothing until
    the session ends (the "everything appears at once" bug).
    """

    # ── Claude Code: streaming events produce output at each step ──

    def test_claude_assistant_text_is_immediately_visible(self):
        line = json.dumps({
            "type": "assistant",
            "message": {"role": "assistant", "content": [{"type": "text", "text": "Thinking..."}]},
        })
        event = _parse_event(line)
        assert event is not None
        assert event["kind"] in ("assistant_text", "assistant_snapshot")
        assert "Thinking" in event["text"]

    def test_claude_tool_use_is_immediately_visible(self):
        line = json.dumps({
            "type": "assistant",
            "message": {"role": "assistant", "content": [
                {"type": "tool_use", "id": "tu_1", "name": "Write",
                 "input": {"file_path": "foo.py", "content": "print('hi')"}},
            ]},
        })
        event = _parse_event(line)
        assert event is not None
        assert event["kind"] == "tool_use"
        assert event["toolName"] == "Write"

    def test_claude_tool_result_is_immediately_visible(self):
        line = json.dumps({
            "type": "user",
            "message": {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "tu_1",
                 "content": [{"type": "text", "text": "File written successfully."}]},
            ]},
        })
        event = _parse_event(line)
        assert event is not None
        assert event["kind"] == "tool_result"
        assert "File written" in event["output"]

    # ── Cursor: streaming events must produce output at each step ──

    def test_cursor_assistant_text_is_immediately_visible(self):
        line = json.dumps({
            "type": "assistant",
            "message": {"role": "assistant", "content": [{"type": "text", "text": "Let me check..."}]},
        })
        event = _parse_event(line)
        assert event is not None
        assert event["kind"] in ("assistant_text", "assistant_snapshot")
        assert "check" in event["text"]

    def test_cursor_tool_call_started_is_immediately_visible(self):
        """The tool_call started event must NOT return None — it's the user's
        live feedback that the agent is doing something."""
        line = json.dumps({
            "type": "tool_call", "subtype": "started", "call_id": "c1",
            "tool_call": {
                "shellToolCall": {"args": {"command": "ls -la"}},
            },
        })
        event = _parse_event(line)
        assert event is not None, "tool_call started must be visible in real-time"
        assert event["kind"] == "tool_use"
        assert event["toolName"] == "Bash"
        assert "ls" in event["input"]

    def test_cursor_tool_call_completed_is_immediately_visible(self):
        """The completed event must produce a tool_result — not be swallowed."""
        line = json.dumps({
            "type": "tool_call", "subtype": "completed", "call_id": "c1",
            "tool_call": {
                "shellToolCall": {
                    "args": {"command": "ls -la"},
                    "result": {"success": {"content": "file.txt\nREADME.md"}},
                },
            },
        })
        event = _parse_event(line)
        assert event is not None, "tool_call completed must be visible in real-time"
        assert event["kind"] == "tool_use_with_result"
        assert event["toolName"] == "Bash"
        assert "file.txt" in event["output"]

    def test_cursor_write_tool_call_is_immediately_visible(self):
        line = json.dumps({
            "type": "tool_call", "subtype": "started", "call_id": "c2",
            "tool_call": {
                "writeToolCall": {"args": {"path": "hello.py", "content": "print('hi')"}},
            },
        })
        event = _parse_event(line)
        assert event is not None, "write tool_call must be visible in real-time"
        assert event["kind"] == "tool_use"
        assert event["toolName"] == "Write"

    def test_cursor_edit_tool_call_is_immediately_visible(self):
        line = json.dumps({
            "type": "tool_call", "subtype": "started", "call_id": "c3",
            "tool_call": {
                "editToolCall": {"args": {"path": "foo.py", "old_string": "a", "new_string": "b"}},
            },
        })
        event = _parse_event(line)
        assert event is not None, "edit tool_call must be visible in real-time"
        assert event["kind"] == "tool_use"
        assert event["toolName"] == "Edit"

    def test_cursor_error_result_is_immediately_visible(self):
        line = json.dumps({
            "type": "tool_call", "subtype": "completed", "call_id": "c4",
            "tool_call": {
                "readToolCall": {
                    "args": {"path": "missing.py"},
                    "result": {"error": {"message": "File not found"}},
                },
            },
        })
        event = _parse_event(line)
        assert event is not None
        assert event["kind"] == "tool_use_with_result"
        assert event["isError"] is True
        assert "not found" in event["output"]

    # ── Codex: streaming events produce output at each step ──

    def test_codex_agent_message_is_immediately_visible(self):
        line = json.dumps({
            "type": "item.completed",
            "item": {"type": "agent_message", "text": "Working on it..."},
        })
        event = _parse_event(line)
        assert event is not None
        assert event["kind"] == "assistant_text"
        assert "Working" in event["text"]

    def test_codex_command_started_is_immediately_visible(self):
        line = json.dumps({
            "type": "item.started",
            "item": {"type": "command_execution", "command": "npm test"},
        })
        event = _parse_event(line)
        assert event is not None
        assert event["kind"] == "tool_use"

    # ── Cross-agent: system/init events should NOT produce visible output ──

    def test_system_init_is_not_visible(self):
        for agent_init in [
            {"type": "system", "subtype": "init", "session_id": "s1"},
            {"type": "thread.started", "thread_id": "t1"},
        ]:
            event = _parse_event(json.dumps(agent_init))
            if event is not None:
                assert event["kind"] in ("initialized",), \
                    f"System/init events should not produce user-visible content: {event}"
