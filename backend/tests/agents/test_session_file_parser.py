"""Unit tests for session_file_parser — pure functions, no mocks, no API calls."""
import json

import pytest

from src.lib.session_file_parser import (
    AGENT_CLAUDE,
    AGENT_CODEX,
    AGENT_CURSOR,
    detect_agent,
    extract_user_messages,
    parse_session_file,
)
from src.lib.transcript import materialize_transcript


# ── Helpers to build realistic session file lines ────────────────────────────

def _claude_queue_op(session_id, op="enqueue", content="hi"):
    return json.dumps({
        "type": "queue-operation", "operation": op,
        "timestamp": "2026-04-17T00:00:00Z", "sessionId": session_id,
        "content": content,
    })


def _claude_user(content, session_id="s1", uuid="u1", parent=None):
    return json.dumps({
        "type": "user",
        "message": {"role": "user", "content": content},
        "uuid": uuid, "parentUuid": parent,
        "timestamp": "2026-04-17T00:00:01Z",
        "sessionId": session_id,
    })


def _claude_user_tool_result(tool_use_id="t1", output="done", session_id="s1"):
    return json.dumps({
        "type": "user",
        "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": tool_use_id, "content": output},
        ]},
        "uuid": "u-tr", "parentUuid": "u-tu",
        "timestamp": "2026-04-17T00:00:02Z",
        "sessionId": session_id,
    })


def _claude_assistant(text, session_id="s1", uuid="a1", parent="u1"):
    return json.dumps({
        "type": "assistant",
        "message": {
            "model": "claude-sonnet-4-6", "type": "message",
            "role": "assistant",
            "content": [{"type": "text", "text": text}],
            "stop_reason": "end_turn",
        },
        "uuid": uuid, "parentUuid": parent,
        "timestamp": "2026-04-17T00:00:02Z",
        "sessionId": session_id,
    })


def _claude_assistant_tool_use(name, input_dict, session_id="s1"):
    return json.dumps({
        "type": "assistant",
        "message": {
            "model": "claude-sonnet-4-6", "type": "message",
            "role": "assistant",
            "content": [{"type": "tool_use", "id": "tu1", "name": name, "input": input_dict}],
            "stop_reason": "tool_use",
        },
        "uuid": "a-tu", "parentUuid": "u1",
        "timestamp": "2026-04-17T00:00:02Z",
        "sessionId": session_id,
    })


def _claude_last_prompt(prompt, session_id="s1"):
    return json.dumps({
        "type": "last-prompt", "lastPrompt": prompt, "sessionId": session_id,
    })


def _claude_file_snapshot(session_id="s1"):
    return json.dumps({
        "type": "file-history-snapshot", "messageId": "m1",
        "snapshot": {"trackedFileBackups": {}, "timestamp": "2026-04-17T00:00:00Z"},
    })


def _cursor_user(text):
    return json.dumps({
        "role": "user",
        "message": {"content": [{"type": "text", "text": text}]},
    })


def _cursor_assistant(text):
    return json.dumps({
        "role": "assistant",
        "message": {"content": [{"type": "text", "text": text}]},
    })


def _cursor_user_tool_result(output="done"):
    return json.dumps({
        "role": "user",
        "message": {"content": [
            {"type": "tool_result", "content": output, "tool_use_id": "t1"},
        ]},
    })


# ── detect_agent ─────────────────────────────────────────────────────────────

class TestDetectAgent:
    def test_detects_claude_from_type_field(self):
        lines = [_claude_queue_op("s1"), _claude_user("hi")]
        assert detect_agent(lines) == AGENT_CLAUDE

    def test_detects_claude_from_user_type(self):
        lines = [_claude_user("hi")]
        assert detect_agent(lines) == AGENT_CLAUDE

    def test_detects_cursor_from_role_field(self):
        lines = [_cursor_user("hi"), _cursor_assistant("hello")]
        assert detect_agent(lines) == AGENT_CURSOR

    def test_defaults_to_claude_on_empty(self):
        assert detect_agent([]) == AGENT_CLAUDE

    def test_defaults_to_claude_on_garbage(self):
        assert detect_agent(["not json", "{}"]) == AGENT_CLAUDE


# ── Claude Code: parse_session_file ──────────────────────────────────────────

class TestClaudeParseSessionFile:
    def test_single_turn(self):
        lines = [
            _claude_queue_op("s1", "enqueue"),
            _claude_queue_op("s1", "dequeue"),
            _claude_user("Fix the bug"),
            _claude_assistant("Done, fixed the null check."),
            _claude_last_prompt("Fix the bug"),
        ]
        msgs = parse_session_file(lines, "s1")

        assert len(msgs) == 2
        assert msgs[0]["role"] == "user"
        assert msgs[0]["content"] == "Fix the bug"
        assert msgs[1]["role"] == "agent"

    def test_multi_turn(self):
        lines = [
            _claude_queue_op("s1"), _claude_queue_op("s1", "dequeue"),
            _claude_user("Turn one"),
            _claude_assistant("Reply one."),
            _claude_last_prompt("Turn one"),
            _claude_queue_op("s1"), _claude_queue_op("s1", "dequeue"),
            _claude_user("Turn two"),
            _claude_assistant("Reply two."),
            _claude_last_prompt("Turn two"),
        ]
        msgs = parse_session_file(lines, "s1")

        users = [m for m in msgs if m["role"] == "user"]
        agents = [m for m in msgs if m["role"] == "agent"]
        assert len(users) == 2
        assert len(agents) == 2
        assert users[0]["content"] == "Turn one"
        assert users[1]["content"] == "Turn two"

    def test_skips_bookkeeping_events(self):
        lines = [
            _claude_queue_op("s1"),
            _claude_file_snapshot(),
            _claude_user("hi"),
            _claude_assistant("hey"),
            _claude_last_prompt("hi"),
        ]
        msgs = parse_session_file(lines, "s1")
        assert len(msgs) == 2

    def test_tool_result_user_event_stored_as_agent(self):
        lines = [
            _claude_user("Run tests"),
            _claude_assistant_tool_use("Bash", {"command": "pytest"}),
            _claude_user_tool_result("t1", "5 passed"),
            _claude_assistant("All tests pass."),
        ]
        msgs = parse_session_file(lines, "s1")

        user_msgs = [m for m in msgs if m["role"] == "user"]
        assert len(user_msgs) == 1
        assert user_msgs[0]["content"] == "Run tests"

        agent_msgs = [m for m in msgs if m["role"] == "agent"]
        assert len(agent_msgs) == 3

    def test_seq_is_sequential(self):
        lines = [
            _claude_queue_op("s1"),
            _claude_user("a"),
            _claude_assistant("b"),
        ]
        msgs = parse_session_file(lines, "s1")
        seqs = [m["seq"] for m in msgs]
        assert seqs == [0, 1]

    def test_session_id_attached(self):
        lines = [_claude_user("hi"), _claude_assistant("hey")]
        msgs = parse_session_file(lines, "custom-id")
        for m in msgs:
            assert m["sessionId"] == "custom-id"

    def test_timestamp_preserved(self):
        lines = [_claude_user("hi")]
        msgs = parse_session_file(lines, "s1")
        assert msgs[0]["createdAt"] == "2026-04-17T00:00:01Z"

    def test_user_content_as_block_array(self):
        line = json.dumps({
            "type": "user",
            "message": {"role": "user", "content": [
                {"type": "text", "text": "Hello "},
                {"type": "text", "text": "world"},
            ]},
            "timestamp": "2026-04-17T00:00:00Z",
        })
        msgs = parse_session_file([line], "s1")
        assert msgs[0]["role"] == "user"
        assert msgs[0]["content"] == "Hello world"


# ── Claude Code: extract_user_messages ───────────────────────────────────────

class TestClaudeExtractUserMessages:
    def test_extracts_all_user_prompts(self):
        lines = [
            _claude_queue_op("s1"),
            _claude_user("First question"),
            _claude_assistant("Answer one"),
            _claude_user("Second question"),
            _claude_assistant("Answer two"),
        ]
        results = extract_user_messages(lines)
        assert results == ["First question", "Second question"]

    def test_skips_tool_result_events(self):
        lines = [
            _claude_user("Do something"),
            _claude_user_tool_result("t1", "result output"),
            _claude_user("Follow up"),
        ]
        results = extract_user_messages(lines)
        assert results == ["Do something", "Follow up"]

    def test_empty_returns_empty(self):
        assert extract_user_messages([]) == []


# ── Cursor: parse_session_file ───────────────────────────────────────────────

class TestCursorParseSessionFile:
    def test_single_turn(self):
        lines = [
            _cursor_user("Fix the bug"),
            _cursor_assistant("Done, fixed it."),
        ]
        msgs = parse_session_file(lines, "s1", agent="cursor")

        assert len(msgs) == 2
        assert msgs[0]["role"] == "user"
        assert msgs[0]["content"] == "Fix the bug"
        assert msgs[1]["role"] == "agent"

    def test_multi_turn(self):
        lines = [
            _cursor_user("Turn one"),
            _cursor_assistant("Reply one."),
            _cursor_user("Turn two"),
            _cursor_assistant("Reply two."),
        ]
        msgs = parse_session_file(lines, "s1", agent="cursor")

        users = [m for m in msgs if m["role"] == "user"]
        assert len(users) == 2
        assert users[0]["content"] == "Turn one"
        assert users[1]["content"] == "Turn two"

    def test_tool_result_stored_as_agent(self):
        lines = [
            _cursor_user("Run it"),
            _cursor_assistant("Running..."),
            _cursor_user_tool_result("output"),
            _cursor_assistant("Done."),
        ]
        msgs = parse_session_file(lines, "s1", agent="cursor")

        user_msgs = [m for m in msgs if m["role"] == "user"]
        assert len(user_msgs) == 1
        assert user_msgs[0]["content"] == "Run it"

    def test_auto_detects_cursor(self):
        lines = [_cursor_user("hi"), _cursor_assistant("hey")]
        msgs = parse_session_file(lines, "s1")
        assert len(msgs) == 2
        assert msgs[0]["role"] == "user"


# ── Cursor: extract_user_messages ────────────────────────────────────────────

class TestCursorExtractUserMessages:
    def test_extracts_user_prompts(self):
        lines = [
            _cursor_user("Question one"),
            _cursor_assistant("Answer one"),
            _cursor_user("Question two"),
        ]
        results = extract_user_messages(lines, agent="cursor")
        assert results == ["Question one", "Question two"]

    def test_skips_tool_results(self):
        lines = [
            _cursor_user("Do it"),
            _cursor_user_tool_result("done"),
        ]
        results = extract_user_messages(lines, agent="cursor")
        assert results == ["Do it"]


# ── Codex helpers (structures taken from real Codex CLI .jsonl output) ────────

def _codex_session_meta(session_id="cx1", cwd="/tmp/test"):
    return json.dumps({
        "timestamp": "2026-04-20T13:48:55.545Z",
        "type": "session_meta",
        "payload": {
            "id": session_id,
            "timestamp": "2026-04-20T13:48:54.140Z",
            "cwd": cwd,
            "originator": "codex_exec",
            "cli_version": "0.118.0",
            "source": "exec",
            "model_provider": "openai",
        },
    })


def _codex_event_msg(subtype, ts="2026-04-20T13:48:55.546Z", **extra):
    payload = {"type": subtype, **extra}
    return json.dumps({"timestamp": ts, "type": "event_msg", "payload": payload})


def _codex_developer(text, ts="2026-04-20T13:48:55.546Z"):
    return json.dumps({
        "timestamp": ts,
        "type": "response_item",
        "payload": {
            "type": "message", "role": "developer",
            "content": [{"type": "input_text", "text": text}],
        },
    })


def _codex_user_system(text, ts="2026-04-20T13:48:55.546Z"):
    """System-injected user context (AGENTS.md, environment_context, etc.)."""
    return json.dumps({
        "timestamp": ts,
        "type": "response_item",
        "payload": {
            "type": "message", "role": "user",
            "content": [{"type": "input_text", "text": text}],
        },
    })


def _codex_user(text, ts="2026-04-20T13:48:55.548Z"):
    """Real human user prompt."""
    return json.dumps({
        "timestamp": ts,
        "type": "response_item",
        "payload": {
            "type": "message", "role": "user",
            "content": [{"type": "input_text", "text": text}],
        },
    })


def _codex_turn_context(ts="2026-04-20T13:48:55.546Z"):
    return json.dumps({
        "timestamp": ts,
        "type": "turn_context",
        "payload": {"turn_id": "t1", "cwd": "/tmp/test"},
    })


def _codex_reasoning(ts="2026-04-20T13:48:57.191Z"):
    return json.dumps({
        "timestamp": ts,
        "type": "response_item",
        "payload": {
            "type": "reasoning", "summary": [], "content": None,
            "encrypted_content": "encrypted...",
        },
    })


def _codex_assistant(text, ts="2026-04-20T13:48:57.302Z"):
    return json.dumps({
        "timestamp": ts,
        "type": "response_item",
        "payload": {
            "type": "message", "role": "assistant",
            "content": [{"type": "output_text", "text": text}],
            "phase": "final_answer",
        },
    })


def _codex_function_call(name, arguments, call_id="call_1", ts="2026-04-20T12:14:18.673Z"):
    return json.dumps({
        "timestamp": ts,
        "type": "response_item",
        "payload": {
            "type": "function_call", "name": name,
            "arguments": json.dumps(arguments),
            "call_id": call_id,
        },
    })


def _codex_function_output(call_id="call_1", output="done", ts="2026-04-20T12:14:18.729Z"):
    return json.dumps({
        "timestamp": ts,
        "type": "response_item",
        "payload": {
            "type": "function_call_output",
            "call_id": call_id, "output": output,
        },
    })


# ── detect_agent (Codex) ────────────────────────────────────────────────────

class TestDetectAgentCodex:
    def test_detects_codex_from_session_meta(self):
        lines = [_codex_session_meta(), _codex_event_msg("task_started")]
        assert detect_agent(lines) == AGENT_CODEX

    def test_detects_codex_from_response_item(self):
        lines = [_codex_user("hello")]
        assert detect_agent(lines) == AGENT_CODEX

    def test_codex_takes_priority_over_claude_fallback(self):
        lines = [_codex_session_meta()]
        assert detect_agent(lines) == AGENT_CODEX


# ── Codex: parse_session_file ───────────────────────────────────────────────

class TestCodexParseSessionFile:
    def test_single_turn_simple(self):
        """Minimal Codex session: one user prompt, one assistant reply."""
        lines = [
            _codex_session_meta(),
            _codex_event_msg("task_started"),
            _codex_developer("<permissions instructions>..."),
            _codex_user_system("# AGENTS.md instructions..."),
            _codex_turn_context(),
            _codex_user("say hello"),
            _codex_event_msg("user_message", message="say hello"),
            _codex_reasoning(),
            _codex_event_msg("agent_message", message="hello"),
            _codex_assistant("hello"),
            _codex_event_msg("token_count"),
            _codex_event_msg("task_complete"),
        ]
        msgs = parse_session_file(lines, "cx1")

        user_msgs = [m for m in msgs if m["role"] == "user"]
        agent_msgs = [m for m in msgs if m["role"] == "agent"]

        assert len(user_msgs) == 1
        assert user_msgs[0]["content"] == "say hello"
        assert len(agent_msgs) >= 1
        # agent_message and assistant response should be present
        agent_content = " ".join(m["content"] for m in agent_msgs)
        assert "hello" in agent_content

    def test_skips_developer_messages(self):
        lines = [
            _codex_session_meta(),
            _codex_developer("<permissions>sandbox_mode=full</permissions>"),
            _codex_user("real question"),
            _codex_assistant("answer"),
        ]
        msgs = parse_session_file(lines, "cx1")
        user_msgs = [m for m in msgs if m["role"] == "user"]
        assert len(user_msgs) == 1
        assert user_msgs[0]["content"] == "real question"

    def test_skips_system_injected_user_context(self):
        """Codex injects AGENTS.md and environment_context as user messages.
        These should NOT appear as user prompts."""
        lines = [
            _codex_session_meta(),
            _codex_user_system("# AGENTS.md instructions\nStuff..."),
            _codex_user_system("<environment_context><cwd>/tmp</cwd></environment_context>"),
            _codex_user("what files are here?"),
            _codex_assistant("Let me check."),
        ]
        msgs = parse_session_file(lines, "cx1")
        user_msgs = [m for m in msgs if m["role"] == "user"]
        assert len(user_msgs) == 1
        assert user_msgs[0]["content"] == "what files are here?"

    def test_tool_use_session(self):
        """Session with function_call and function_call_output."""
        lines = [
            _codex_session_meta(),
            _codex_event_msg("task_started"),
            _codex_developer("<permissions>..."),
            _codex_turn_context(),
            _codex_user("run echo hello"),
            _codex_event_msg("user_message", message="run echo hello"),
            _codex_reasoning(),
            _codex_event_msg("agent_message", message="Running..."),
            _codex_assistant("Running the command now."),
            _codex_function_call("exec_command", {"cmd": "echo hello"}),
            _codex_function_output("call_1", "hello\n"),
            _codex_event_msg("agent_message", message="Done."),
            _codex_assistant("Done. The command printed hello."),
            _codex_event_msg("task_complete"),
        ]
        msgs = parse_session_file(lines, "cx1")

        user_msgs = [m for m in msgs if m["role"] == "user"]
        agent_msgs = [m for m in msgs if m["role"] == "agent"]
        assert len(user_msgs) == 1
        assert user_msgs[0]["content"] == "run echo hello"

        # Should have assistant messages, function_call, function_call_output as agent
        agent_lines_json = []
        for m in agent_msgs:
            try:
                agent_lines_json.append(json.loads(m["content"]))
            except (json.JSONDecodeError, TypeError):
                pass
        func_calls = [
            d for d in agent_lines_json
            if d.get("type") == "response_item"
            and isinstance(d.get("payload"), dict)
            and d["payload"].get("type") == "function_call"
        ]
        func_outputs = [
            d for d in agent_lines_json
            if d.get("type") == "response_item"
            and isinstance(d.get("payload"), dict)
            and d["payload"].get("type") == "function_call_output"
        ]
        assert len(func_calls) == 1
        assert func_calls[0]["payload"]["name"] == "exec_command"
        assert len(func_outputs) == 1

    def test_multi_turn(self):
        lines = [
            _codex_session_meta(),
            _codex_event_msg("task_started"),
            _codex_turn_context(),
            _codex_user("Turn one"),
            _codex_event_msg("user_message", message="Turn one"),
            _codex_assistant("Reply one"),
            _codex_turn_context(),
            _codex_user("Turn two"),
            _codex_event_msg("user_message", message="Turn two"),
            _codex_assistant("Reply two"),
            _codex_event_msg("task_complete"),
        ]
        msgs = parse_session_file(lines, "cx1")
        user_msgs = [m for m in msgs if m["role"] == "user"]
        assert len(user_msgs) == 2
        assert user_msgs[0]["content"] == "Turn one"
        assert user_msgs[1]["content"] == "Turn two"

    def test_skips_session_meta_and_turn_context(self):
        lines = [
            _codex_session_meta(),
            _codex_turn_context(),
            _codex_user("hi"),
            _codex_assistant("hey"),
        ]
        msgs = parse_session_file(lines, "cx1")
        # session_meta and turn_context should not produce messages
        assert len(msgs) == 2

    def test_skips_token_count_and_task_events(self):
        lines = [
            _codex_event_msg("task_started"),
            _codex_user("hi"),
            _codex_assistant("hey"),
            _codex_event_msg("token_count"),
            _codex_event_msg("task_complete"),
        ]
        msgs = parse_session_file(lines, "cx1")
        assert len(msgs) == 2

    def test_seq_is_sequential(self):
        lines = [
            _codex_session_meta(),
            _codex_user("a"),
            _codex_assistant("b"),
        ]
        msgs = parse_session_file(lines, "cx1")
        seqs = [m["seq"] for m in msgs]
        assert seqs == list(range(len(msgs)))

    def test_session_id_attached(self):
        lines = [_codex_user("hi"), _codex_assistant("hey")]
        msgs = parse_session_file(lines, "my-codex-session")
        for m in msgs:
            assert m["sessionId"] == "my-codex-session"

    def test_timestamp_preserved(self):
        lines = [_codex_user("hi", ts="2026-04-20T12:00:00.000Z")]
        msgs = parse_session_file(lines, "cx1")
        assert msgs[0]["createdAt"] == "2026-04-20T12:00:00.000Z"

    def test_auto_detects_codex(self):
        lines = [
            _codex_session_meta(),
            _codex_user("hi"),
            _codex_assistant("hey"),
        ]
        msgs = parse_session_file(lines, "cx1")
        assert len(msgs) == 2
        assert msgs[0]["role"] == "user"


# ── Codex: extract_user_messages ────────────────────────────────────────────

class TestCodexExtractUserMessages:
    def test_extracts_real_user_prompt(self):
        lines = [
            _codex_session_meta(),
            _codex_developer("<permissions>..."),
            _codex_user_system("# AGENTS.md instructions..."),
            _codex_user("fix the bug"),
            _codex_assistant("Done."),
        ]
        results = extract_user_messages(lines)
        assert results == ["fix the bug"]

    def test_skips_all_system_context(self):
        lines = [
            _codex_user_system("# AGENTS.md stuff"),
            _codex_user_system("<environment_context><cwd>/tmp</cwd></environment_context>"),
            _codex_user("real prompt"),
        ]
        results = extract_user_messages(lines, agent="codex")
        assert results == ["real prompt"]

    def test_multiple_turns(self):
        lines = [
            _codex_user("first question"),
            _codex_assistant("answer one"),
            _codex_user("second question"),
            _codex_assistant("answer two"),
        ]
        results = extract_user_messages(lines, agent="codex")
        assert results == ["first question", "second question"]

    def test_empty_returns_empty(self):
        assert extract_user_messages([], agent="codex") == []

    def test_session_with_only_system_context(self):
        lines = [
            _codex_session_meta(),
            _codex_developer("<permissions>..."),
            _codex_user_system("# AGENTS.md instructions..."),
        ]
        results = extract_user_messages(lines)
        assert results == []


# ── Codex: parse with real session files from disk ──────────────────────────

class TestCodexRealSessionFiles:
    """Parse actual Codex .jsonl files from ~/.codex/sessions/ — no mocking."""

    @pytest.fixture()
    def simple_session_lines(self):
        import os
        path = os.path.expanduser(
            "~/.codex/sessions/2026/04/20/"
            "rollout-2026-04-20T14-48-54-019dab26-b5fa-7c50-8f15-bb8339517be2.jsonl"
        )
        if not os.path.exists(path):
            pytest.skip(f"Codex session file not found: {path}")
        with open(path) as f:
            return [line.strip() for line in f if line.strip()]

    @pytest.fixture()
    def tool_use_session_lines(self):
        import os
        path = os.path.expanduser(
            "~/.codex/sessions/2026/04/20/"
            "rollout-2026-04-20T13-14-14-019daad0-0d3d-71f2-a099-d7acc288f465.jsonl"
        )
        if not os.path.exists(path):
            pytest.skip(f"Codex session file not found: {path}")
        with open(path) as f:
            return [line.strip() for line in f if line.strip()]

    def test_detects_codex_from_real_file(self, simple_session_lines):
        assert detect_agent(simple_session_lines) == AGENT_CODEX

    def test_parse_simple_session(self, simple_session_lines):
        msgs = parse_session_file(simple_session_lines, "real-simple")
        user_msgs = [m for m in msgs if m["role"] == "user"]
        assert len(user_msgs) == 1
        assert "pocketeng_codex_test" in user_msgs[0]["content"]

    def test_extract_user_messages_simple(self, simple_session_lines):
        results = extract_user_messages(simple_session_lines)
        assert len(results) == 1
        assert "pocketeng_codex_test" in results[0]

    def test_parse_tool_use_session(self, tool_use_session_lines):
        msgs = parse_session_file(tool_use_session_lines, "real-tools")
        user_msgs = [m for m in msgs if m["role"] == "user"]
        agent_msgs = [m for m in msgs if m["role"] == "agent"]
        assert len(user_msgs) == 1
        assert "echo hello" in user_msgs[0]["content"]
        # Should have function_call and function_call_output among agent messages
        agent_raw = [m["content"] for m in agent_msgs]
        assert any("function_call" in r for r in agent_raw)

    def test_extract_user_messages_tool_use(self, tool_use_session_lines):
        results = extract_user_messages(tool_use_session_lines)
        assert len(results) == 1
        assert "echo hello" in results[0]


# ── End-to-end: parse → materialize ─────────────────────────────────────────

class TestParseToMaterialize:
    """Verify the full pipeline: session file → parse → materialize_transcript."""

    def test_claude_single_turn_materializes(self):
        lines = [
            _claude_queue_op("s1"), _claude_queue_op("s1", "dequeue"),
            _claude_user("What is 2+2?"),
            _claude_assistant("2+2 = 4."),
            _claude_last_prompt("What is 2+2?"),
        ]
        msgs = parse_session_file(lines, "s1")
        transcript = materialize_transcript(msgs, session_status="done")

        assert len(transcript) == 2
        assert transcript[0]["role"] == "user"
        assert transcript[0]["content"] == "What is 2+2?"
        assert transcript[1]["role"] == "assistant"
        assert "4" in transcript[1]["content"]
        assert transcript[1]["state"] == "complete"

    def test_claude_multi_turn_materializes(self):
        lines = [
            _claude_user("First"), _claude_assistant("Reply one."),
            _claude_user("Second"), _claude_assistant("Reply two."),
        ]
        msgs = parse_session_file(lines, "s1")
        transcript = materialize_transcript(msgs, session_status="done")

        users = [t for t in transcript if t["role"] == "user"]
        assistants = [t for t in transcript if t["role"] == "assistant"]
        assert len(users) == 2
        assert len(assistants) == 2
        assert users[0]["content"] == "First"
        assert users[1]["content"] == "Second"

    def test_claude_tool_use_materializes(self):
        lines = [
            _claude_user("List files"),
            _claude_assistant_tool_use("Bash", {"command": "ls"}),
            _claude_user_tool_result("t1", "file.txt\nREADME.md"),
            _claude_assistant("Here are the files."),
        ]
        msgs = parse_session_file(lines, "s1")
        transcript = materialize_transcript(msgs, session_status="done")

        assert transcript[0]["role"] == "user"
        assistants = [t for t in transcript if t["role"] == "assistant"]
        assert len(assistants) >= 1
        all_tools = []
        for a in assistants:
            all_tools.extend(a.get("tools", []))
        assert any(t["toolName"] == "Bash" for t in all_tools)

    def test_cursor_single_turn_materializes(self):
        lines = [
            _cursor_user("What is 2+2?"),
            _cursor_assistant("2+2 = 4."),
        ]
        msgs = parse_session_file(lines, "s1", agent="cursor")
        transcript = materialize_transcript(msgs, session_status="done")

        assert len(transcript) == 2
        assert transcript[0]["role"] == "user"
        assert transcript[0]["content"] == "What is 2+2?"
        assert transcript[1]["role"] == "assistant"
        assert "4" in transcript[1]["content"]

    def test_cursor_multi_assistant_lines_merge(self):
        """Cursor session files emit multiple assistant lines per turn.
        materialize_transcript should merge consecutive agent messages."""
        lines = [
            _cursor_user("Explain"),
            _cursor_assistant("First paragraph."),
            _cursor_assistant("Second paragraph."),
            _cursor_user("Thanks"),
        ]
        msgs = parse_session_file(lines, "s1", agent="cursor")
        transcript = materialize_transcript(msgs, session_status="done")

        users = [t for t in transcript if t["role"] == "user"]
        assistants = [t for t in transcript if t["role"] == "assistant"]
        assert len(users) == 2
        assert len(assistants) == 1
        assert "First paragraph" in assistants[0]["content"]
        assert "Second paragraph" in assistants[0]["content"]
    def test_codex_single_turn_materializes(self):
        lines = [
            _codex_session_meta(),
            _codex_event_msg("task_started"),
            _codex_user("What is 2+2?"),
            _codex_event_msg("user_message", message="What is 2+2?"),
            _codex_reasoning(),
            _codex_event_msg("agent_message", message="2+2 = 4."),
            _codex_assistant("2+2 = 4."),
            _codex_event_msg("task_complete"),
        ]
        msgs = parse_session_file(lines, "cx1")
        transcript = materialize_transcript(msgs, session_status="done")

        assert len(transcript) >= 2
        assert transcript[0]["role"] == "user"
        assert transcript[0]["content"] == "What is 2+2?"
        assistants = [t for t in transcript if t["role"] == "assistant"]
        assert len(assistants) >= 1
        assert "4" in assistants[0]["content"]
        assert assistants[0]["state"] == "complete"

    def test_codex_multi_turn_materializes(self):
        lines = [
            _codex_session_meta(),
            _codex_user("First"),
            _codex_assistant("Reply one."),
            _codex_user("Second"),
            _codex_assistant("Reply two."),
        ]
        msgs = parse_session_file(lines, "cx1")
        transcript = materialize_transcript(msgs, session_status="done")

        users = [t for t in transcript if t["role"] == "user"]
        assistants = [t for t in transcript if t["role"] == "assistant"]
        assert len(users) == 2
        assert len(assistants) == 2
        assert users[0]["content"] == "First"
        assert users[1]["content"] == "Second"

    def test_codex_tool_use_materializes(self):
        lines = [
            _codex_session_meta(),
            _codex_user("Run echo hello"),
            _codex_assistant("Running it now."),
            _codex_function_call("exec_command", {"cmd": "echo hello"}),
            _codex_function_output("call_1", "hello\n"),
            _codex_assistant("Done. Output was hello."),
        ]
        msgs = parse_session_file(lines, "cx1")
        transcript = materialize_transcript(msgs, session_status="done")

        assert transcript[0]["role"] == "user"
        assistants = [t for t in transcript if t["role"] == "assistant"]
        assert len(assistants) >= 1
        all_tools = []
        for a in assistants:
            all_tools.extend(a.get("tools", []))
        assert any(t["toolName"] == "exec_command" for t in all_tools)
        assert any(t.get("output") is not None for t in all_tools)


# ── Cursor real on-disk rollout (v2026.04) ──────────────────────────────────
#
# Captured from a live run of `agent -p --force --output-format stream-json
# --sandbox disabled <prompt>` on Cursor CLI 2026.04.17-787b533 against
# /tmp/cursor-test.  These are the exact bytes Cursor wrote to
# ~/.cursor/projects/<sanitized-cwd>/agent-transcripts/<sid>/<sid>.jsonl.
#
# Two quirks observed on-disk that the stream-json stdout does NOT emit:
#   1. User prompts are wrapped in  <user_query>\n ... \n</user_query>
#   2. Assistant text lines end with  \n\n[REDACTED]
#
# Both are visible in the synced-from-laptop flow (S4 in the browser
# harness) and would leak to the PocketEng UI verbatim if the parser
# doesn't strip them.  These tests pin the contract.

_CURSOR_REAL_ROLLOUT_V2026 = [
    '{"role":"user","message":{"content":[{"type":"text","text":"<user_query>\\nwhat is 17 * 23?\\n</user_query>"}]}}',
    '{"role":"assistant","message":{"content":[{"type":"text","text":"**17 \\u00d7 23 = 391**\\n\\n[REDACTED]"}]}}',
    '{"role":"user","message":{"content":[{"type":"text","text":"<user_query>\\nnow multiply that by 2\\n</user_query>"}]}}',
    '{"role":"assistant","message":{"content":[{"type":"text","text":"**391 \\u00d7 2 = 782**\\n\\n[REDACTED]"}]}}',
    '{"role":"user","message":{"content":[{"type":"text","text":"<user_query>\\nsubtract 100\\n</user_query>"}]}}',
    '{"role":"assistant","message":{"content":[{"type":"text","text":"**782 \\u2212 100 = 682**\\n\\n[REDACTED]"}]}}',
]


class TestCursorRealRolloutV2026:
    """Fixture-based tests against a real Cursor v2026.04 rollout.

    These guard the local-to-UI flow: the sync daemon pushes the on-disk
    .jsonl to EC2, `_register_synced_session()` reads it back via SSH and
    feeds it to `parse_session_file`, and `materialize_transcript`
    produces what the UI renders.
    """

    def test_auto_detects_cursor(self):
        assert detect_agent(_CURSOR_REAL_ROLLOUT_V2026) == AGENT_CURSOR

    def test_user_prompts_strip_user_query_wrapper(self):
        """`<user_query>\\n...\\n</user_query>` is a Cursor on-disk artifact.
        The UI must render the inner prompt, not the raw XML-like wrapper."""
        results = extract_user_messages(_CURSOR_REAL_ROLLOUT_V2026, agent="cursor")
        assert results == [
            "what is 17 * 23?",
            "now multiply that by 2",
            "subtract 100",
        ]

    def test_parse_user_content_is_unwrapped(self):
        msgs = parse_session_file(_CURSOR_REAL_ROLLOUT_V2026, "s1", agent="cursor")
        user_contents = [m["content"] for m in msgs if m["role"] == "user"]
        assert user_contents == [
            "what is 17 * 23?",
            "now multiply that by 2",
            "subtract 100",
        ]
        for c in user_contents:
            assert "<user_query>" not in c
            assert "</user_query>" not in c

    def test_assistant_text_strips_redacted_trailer(self):
        """Cursor appends `\\n\\n[REDACTED]` to assistant text on-disk.
        The UI must render just the answer, not the trailing marker."""
        msgs = parse_session_file(_CURSOR_REAL_ROLLOUT_V2026, "s1", agent="cursor")
        transcript = materialize_transcript(msgs, session_status="done")

        assistants = [t for t in transcript if t["role"] == "assistant"]
        assert len(assistants) == 3
        assert assistants[0]["content"] == "**17 × 23 = 391**"
        assert assistants[1]["content"] == "**391 × 2 = 782**"
        assert assistants[2]["content"] == "**782 − 100 = 682**"
        for a in assistants:
            assert "[REDACTED]" not in a["content"]

    def test_full_transcript_round_trip(self):
        msgs = parse_session_file(_CURSOR_REAL_ROLLOUT_V2026, "s1", agent="cursor")
        transcript = materialize_transcript(msgs, session_status="done")

        roles = [t["role"] for t in transcript]
        assert roles == ["user", "assistant", "user", "assistant", "user", "assistant"]
        # Math chain intact: 17*23=391 → 782 → 682
        assert "391" in transcript[1]["content"]
        assert "782" in transcript[3]["content"]
        assert "682" in transcript[5]["content"]
