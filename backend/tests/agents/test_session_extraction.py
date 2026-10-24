"""Integration tests for session file extraction from Claude Code and Codex.

Run real agent CLIs, let them create .jsonl session files on disk,
then validate that our extraction logic correctly parses the persisted
session file into proper user/assistant conversation pairs.

This tests the FULL local-to-cloud extraction path:
  Agent session → .jsonl on disk → extraction → transcript

Requires:
  - Claude Code CLI installed (`claude` on PATH) for Claude tests
  - Codex CLI installed (`codex` on PATH) for Codex tests
  - Valid API keys (env vars or login-managed keys)

Run with:  cd backend && python3 -m pytest tests/agents/test_session_extraction.py -v -s
"""
import json
import os
import subprocess
import uuid

import pytest

from src.chat import _extract_first_user_message, _extract_last_user_message
from src.lib.session_file_parser import extract_user_messages, parse_session_file
from src.lib.transcript import _parse_event, materialize_transcript

pytestmark = pytest.mark.integration

CLAUDE_BIN = "claude"


def _cli_available():
    try:
        r = subprocess.run([CLAUDE_BIN, "--version"], capture_output=True, timeout=5)
        return r.returncode == 0
    except FileNotFoundError:
        return False


skip_no_cli = pytest.mark.skipif(not _cli_available(), reason="claude CLI not installed")


# ── Helpers ──────────────────────────────────────────────────────────────────


def _resolve_cwd(path):
    """Return the real absolute path (follows symlinks, e.g. /tmp → /private/tmp on macOS)."""
    return os.path.realpath(path)


def _find_session_file(session_id):
    """Find the .jsonl session file Claude Code created by searching all project dirs.

    Claude Code's project-hash algorithm may vary across versions (it replaces
    / and _ with - as of v2.1.x). Instead of reproducing the hash, we search.
    """
    base = os.path.expanduser("~/.claude/projects")
    target = f"{session_id}.jsonl"
    for entry in os.listdir(base):
        candidate = os.path.join(base, entry, target)
        if os.path.isfile(candidate):
            return candidate
    return None


def _run_claude(prompt, cwd, session_id=None, resume_id=None, timeout=60):
    """Run Claude Code in -p mode, return (session_id, stdout, stderr, rc).

    - session_id: set a specific session ID for a new conversation.
    - resume_id: resume an existing session by ID.
    """
    sid = resume_id or session_id or str(uuid.uuid4())
    cmd = [
        CLAUDE_BIN, "-p",
        "--output-format", "stream-json",
        "--verbose",
    ]
    if resume_id:
        cmd += ["--resume", resume_id]
    else:
        cmd += ["--session-id", sid]
    cmd.append(prompt)

    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
        cwd=cwd,
    )
    return sid, proc.stdout, proc.stderr, proc.returncode


def _read_session_lines(path):
    """Read all non-empty lines from a .jsonl file."""
    with open(path) as f:
        return [line.strip() for line in f if line.strip()]


def _session_lines_to_messages(lines, session_id):
    """Delegate to the production session_file_parser module."""
    return parse_session_file(lines, session_id)


# ── TEST 1: Session file creation ────────────────────────────────────────────


@skip_no_cli
class TestSessionFileCreation:
    """Verify Claude Code -p creates a .jsonl session file on disk."""

    def test_session_file_exists_after_run(self, tmp_path):
        cwd = _resolve_cwd(str(tmp_path))
        session_id, stdout, stderr, rc = _run_claude(
            "respond with exactly: session_created", cwd
        )
        assert rc == 0, f"claude exited {rc}: {stderr}"

        path = _find_session_file(session_id)
        assert path is not None, (
            f"Session file not found for {session_id} under ~/.claude/projects/"
        )
        assert os.path.getsize(path) > 0, "Session file is empty"

    def test_session_file_has_user_and_assistant_events(self, tmp_path):
        cwd = _resolve_cwd(str(tmp_path))
        session_id, _, stderr, rc = _run_claude(
            "respond with exactly: event_check", cwd
        )
        assert rc == 0, f"claude exited {rc}: {stderr}"

        path = _find_session_file(session_id)
        assert path is not None
        lines = _read_session_lines(path)

        types_found = set()
        for line in lines:
            obj = json.loads(line)
            types_found.add(obj.get("type"))

        assert "user" in types_found, f"No 'user' event. Found types: {types_found}"
        assert "assistant" in types_found, f"No 'assistant' event. Found types: {types_found}"

    def test_all_event_types_are_known(self, tmp_path):
        """Flag any event types we haven't accounted for."""
        KNOWN_TYPES = {
            "system", "user", "assistant", "message", "tool_use", "tool_result",
            "result", "content_block_delta", "text", "tool_call",
            "thread.started", "item.started", "item.completed", "turn.completed",
            "queue-operation", "file-history-snapshot", "progress", "last-prompt",
            # "attachment" was added in a recent Claude CLI release — appears
            # on sessions where the user dropped a file into the prompt. The
            # parser treats it as metadata (no transcript extraction needed)
            # so recognising it here is enough to silence this guard test.
            "attachment",
            # "ai-title" appeared in Claude CLI ≥ 2.x — the CLI emits a
            # title suggestion for the session. No transcript content; just
            # metadata. Recognised here so the guard stays quiet.
            "ai-title",
        }
        cwd = _resolve_cwd(str(tmp_path))
        session_id, _, stderr, rc = _run_claude(
            "respond with exactly: type_audit", cwd
        )
        assert rc == 0, f"claude exited {rc}: {stderr}"

        path = _find_session_file(session_id)
        assert path is not None
        lines = _read_session_lines(path)

        unknown = set()
        for line in lines:
            obj = json.loads(line)
            t = obj.get("type")
            if t and t not in KNOWN_TYPES:
                unknown.add(t)

        assert not unknown, (
            f"Unknown event types in session file: {unknown}. "
            "Update KNOWN_TYPES and add extraction handling."
        )


# ── TEST 2: Single-turn extraction ──────────────────────────────────────────


@skip_no_cli
class TestSingleTurnExtraction:
    """Extract user/assistant from a single-turn session file."""

    @pytest.fixture(scope="class")
    def session(self, tmp_path_factory):
        cwd = _resolve_cwd(str(tmp_path_factory.mktemp("single_turn")))
        prompt = "respond with exactly: extraction_single"
        session_id, stdout, stderr, rc = _run_claude(prompt, cwd)
        assert rc == 0, f"claude exited {rc}: {stderr}"

        path = _find_session_file(session_id)
        assert path is not None, "Session file not created"

        return {
            "path": path,
            "lines": _read_session_lines(path),
            "session_id": session_id,
            "prompt": prompt,
            "stdout": stdout,
        }

    def test_extract_first_user_message(self, session):
        first = _extract_first_user_message(session["lines"])
        assert first is not None, "Failed to extract first user message from session file"
        assert "extraction_single" in first

    def test_extract_last_user_message_same_as_first(self, session):
        last = _extract_last_user_message(session["lines"])
        assert last is not None
        assert "extraction_single" in last

    def test_parse_event_handles_session_file_assistant(self, session):
        """_parse_event must return assistant content for session-file assistant events."""
        for line in session["lines"]:
            obj = json.loads(line)
            if obj.get("type") == "assistant":
                event = _parse_event(line)
                assert event is not None, (
                    f"_parse_event returned None for assistant event: {line[:300]}"
                )
                assert event["kind"] in ("assistant_snapshot", "assistant_text"), (
                    f"Unexpected kind: {event['kind']}"
                )
                break
        else:
            pytest.fail("No assistant event found in session file")

    def test_messages_conversion(self, session):
        messages = _session_lines_to_messages(session["lines"], session["session_id"])
        roles = [m["role"] for m in messages]
        assert "user" in roles, f"No user message after conversion. Roles: {roles}"
        assert "agent" in roles, f"No agent message after conversion. Roles: {roles}"

    def test_materialize_transcript(self, session):
        messages = _session_lines_to_messages(session["lines"], session["session_id"])
        transcript = materialize_transcript(messages, session_status="done")

        assert len(transcript) >= 2, (
            f"Expected ≥2 transcript entries (user+assistant), got {len(transcript)}"
        )
        assert transcript[0]["role"] == "user"
        assert "extraction_single" in transcript[0]["content"]

        assistants = [t for t in transcript if t["role"] == "assistant"]
        assert len(assistants) >= 1, "No assistant entry in materialized transcript"
        assert len(assistants[0]["content"]) > 0, "Assistant content is empty"
        assert assistants[0]["state"] == "complete"

    def test_extract_user_messages_module(self, session):
        """The production extract_user_messages() finds the prompt."""
        user_msgs = extract_user_messages(session["lines"])
        assert len(user_msgs) >= 1
        assert any("extraction_single" in m for m in user_msgs)

    def test_stdout_ndjson_matches_session_file(self, session):
        """The assistant response in stdout should match the session file."""
        stdout_lines = [l.strip() for l in session["stdout"].splitlines() if l.strip()]
        stdout_assistant_text = None
        for line in stdout_lines:
            obj = json.loads(line)
            if obj.get("type") == "assistant":
                content = obj.get("message", {}).get("content", [])
                if isinstance(content, list):
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "text":
                            stdout_assistant_text = block["text"]
                            break

        session_assistant_text = None
        for line in session["lines"]:
            obj = json.loads(line)
            if obj.get("type") == "assistant":
                content = obj.get("message", {}).get("content", [])
                if isinstance(content, list):
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "text":
                            session_assistant_text = block["text"]
                            break

        assert stdout_assistant_text is not None, "No assistant text in stdout"
        assert session_assistant_text is not None, "No assistant text in session file"
        assert stdout_assistant_text == session_assistant_text, (
            f"Mismatch: stdout={stdout_assistant_text!r} vs file={session_assistant_text!r}"
        )


# ── TEST 3: Multi-turn extraction ───────────────────────────────────────────


@skip_no_cli
class TestMultiTurnExtraction:
    """Extract conversation from a multi-turn session (two --resume rounds)."""

    @pytest.fixture(scope="class")
    def session(self, tmp_path_factory):
        cwd = _resolve_cwd(str(tmp_path_factory.mktemp("multi_turn")))
        session_id = str(uuid.uuid4())

        # Turn 1
        _, _, stderr1, rc1 = _run_claude(
            "respond with exactly: first_turn", cwd, session_id=session_id
        )
        assert rc1 == 0, f"Turn 1 failed: {stderr1}"

        # Turn 2 (resume)
        _, _, stderr2, rc2 = _run_claude(
            "respond with exactly: second_turn", cwd, resume_id=session_id
        )
        assert rc2 == 0, f"Turn 2 failed: {stderr2}"

        path = _find_session_file(session_id)
        assert path is not None, "Session file not found after 2 turns"

        return {
            "path": path,
            "lines": _read_session_lines(path),
            "session_id": session_id,
        }

    def test_session_file_has_two_user_events(self, session):
        user_events = []
        for line in session["lines"]:
            obj = json.loads(line)
            if obj.get("type") == "user":
                msg = obj.get("message", {})
                c = msg.get("content")
                if isinstance(c, str) and c.strip():
                    user_events.append(c.strip())
        assert len(user_events) >= 2, (
            f"Expected ≥2 user events, got {len(user_events)}: {user_events}"
        )

    def test_first_user_message_is_turn_one(self, session):
        first = _extract_first_user_message(session["lines"])
        assert first is not None
        assert "first_turn" in first

    def test_last_user_message_is_turn_two(self, session):
        last = _extract_last_user_message(session["lines"])
        assert last is not None
        assert "second_turn" in last

    def test_materialized_transcript_has_both_turns(self, session):
        messages = _session_lines_to_messages(session["lines"], session["session_id"])
        transcript = materialize_transcript(messages, session_status="done")

        user_entries = [t for t in transcript if t["role"] == "user"]
        assert len(user_entries) >= 2, (
            f"Expected ≥2 user entries, got {len(user_entries)}"
        )

        assistant_entries = [t for t in transcript if t["role"] == "assistant"]
        assert len(assistant_entries) >= 2, (
            f"Expected ≥2 assistant entries, got {len(assistant_entries)}"
        )

    def test_turn_ordering_is_preserved(self, session):
        messages = _session_lines_to_messages(session["lines"], session["session_id"])
        transcript = materialize_transcript(messages, session_status="done")

        user_contents = [t["content"] for t in transcript if t["role"] == "user"]
        first_idx = next(
            (i for i, c in enumerate(user_contents) if "first_turn" in c), None
        )
        second_idx = next(
            (i for i, c in enumerate(user_contents) if "second_turn" in c), None
        )
        assert first_idx is not None, "first_turn not found in user entries"
        assert second_idx is not None, "second_turn not found in user entries"
        assert first_idx < second_idx, (
            f"Turn ordering broken: first_turn at {first_idx}, second_turn at {second_idx}"
        )


# ── TEST 4: Extraction matches between stdout and session file ──────────────


@skip_no_cli
class TestExtractionConsistency:
    """Compare what we get from stdout (live poll path) vs session file (sync path).

    The sync path reads the .jsonl from disk; the live path reads NDJSON from
    stdout. Both should produce equivalent transcripts.
    """

    @pytest.fixture(scope="class")
    def both_sources(self, tmp_path_factory):
        cwd = _resolve_cwd(str(tmp_path_factory.mktemp("consistency")))
        prompt = "respond with exactly: consistency_check"
        session_id, stdout, stderr, rc = _run_claude(prompt, cwd)
        assert rc == 0, f"claude exited {rc}: {stderr}"

        path = _find_session_file(session_id)
        assert path is not None

        # Stdout path: simulate how chat.py _persist_agent_output stores messages
        stdout_lines = [l.strip() for l in stdout.splitlines() if l.strip()]
        stdout_messages = [
            {"seq": 0, "role": "user", "content": prompt,
             "createdAt": "", "sessionId": session_id},
        ]
        for i, line in enumerate(stdout_lines):
            stdout_messages.append({
                "seq": i + 1,
                "role": "agent",
                "content": line,
                "createdAt": "",
                "sessionId": session_id,
            })

        # Session-file path: simulate how sync reads the .jsonl
        file_lines = _read_session_lines(path)
        file_messages = _session_lines_to_messages(file_lines, session_id)

        return {
            "stdout_messages": stdout_messages,
            "file_messages": file_messages,
            "prompt": prompt,
        }

    def test_both_paths_have_user_and_assistant(self, both_sources):
        for label, msgs in [
            ("stdout", both_sources["stdout_messages"]),
            ("file", both_sources["file_messages"]),
        ]:
            transcript = materialize_transcript(msgs, session_status="done")
            roles = {t["role"] for t in transcript}
            assert "user" in roles, f"{label} path missing user in transcript"
            assert "assistant" in roles, f"{label} path missing assistant in transcript"

    def test_assistant_text_matches(self, both_sources):
        stdout_transcript = materialize_transcript(
            both_sources["stdout_messages"], session_status="done"
        )
        file_transcript = materialize_transcript(
            both_sources["file_messages"], session_status="done"
        )

        stdout_assistant = next(
            t["content"] for t in stdout_transcript if t["role"] == "assistant"
        )
        file_assistant = next(
            t["content"] for t in file_transcript if t["role"] == "assistant"
        )
        assert stdout_assistant == file_assistant, (
            f"Assistant text mismatch:\n  stdout: {stdout_assistant!r}\n  file:   {file_assistant!r}"
        )

    def test_user_prompt_matches(self, both_sources):
        stdout_transcript = materialize_transcript(
            both_sources["stdout_messages"], session_status="done"
        )
        file_transcript = materialize_transcript(
            both_sources["file_messages"], session_status="done"
        )

        stdout_user = next(
            t["content"] for t in stdout_transcript if t["role"] == "user"
        )
        file_user = next(
            t["content"] for t in file_transcript if t["role"] == "user"
        )
        assert both_sources["prompt"] in stdout_user
        assert both_sources["prompt"] in file_user


# ═══════════════════════════════════════════════════════════════════════════════
# Codex CLI integration tests
# ═══════════════════════════════════════════════════════════════════════════════

CODEX_BIN = "codex"


def _codex_available():
    try:
        r = subprocess.run([CODEX_BIN, "--version"], capture_output=True, timeout=5)
        return r.returncode == 0
    except FileNotFoundError:
        return False


skip_no_codex = pytest.mark.skipif(
    not _codex_available(), reason="codex CLI not installed"
)


def _run_codex(prompt, cwd, timeout=90):
    """Run Codex in exec mode with --json, return (session_id, stdout, stderr, rc).

    The session_id is extracted from the thread.started event in stdout.
    """
    proc = subprocess.run(
        [CODEX_BIN, "exec", "--json"],
        input=prompt,
        capture_output=True,
        text=True,
        timeout=timeout,
        cwd=cwd,
    )

    session_id = None
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if obj.get("type") == "thread.started":
            session_id = obj.get("thread_id")
            break

    return session_id, proc.stdout, proc.stderr, proc.returncode


def _find_codex_session_file(session_id):
    """Find a Codex .jsonl session file by UUID anywhere under ~/.codex/sessions/."""
    base = os.path.expanduser("~/.codex/sessions")
    if not os.path.isdir(base):
        return None
    for root, _dirs, files in os.walk(base):
        for fname in files:
            if session_id in fname and fname.endswith(".jsonl"):
                return os.path.join(root, fname)
    return None


# ── TEST 5: Codex session file creation ─────────────────────────────────────


@skip_no_codex
class TestCodexSessionFileCreation:
    """Verify Codex exec creates a .jsonl session file on disk."""

    def test_session_file_exists_after_run(self):
        cwd = _resolve_cwd(os.getcwd())
        session_id, stdout, stderr, rc = _run_codex(
            "respond with exactly: codex_session_created", cwd
        )
        assert rc == 0, f"codex exited {rc}: {stderr}"
        assert session_id is not None, "No thread.started event in stdout"

        path = _find_codex_session_file(session_id)
        assert path is not None, (
            f"Session file not found for {session_id} under ~/.codex/sessions/"
        )
        assert os.path.getsize(path) > 0, "Session file is empty"

    def test_session_file_has_codex_event_types(self):
        cwd = _resolve_cwd(os.getcwd())
        session_id, _, stderr, rc = _run_codex(
            "respond with exactly: event_type_audit", cwd
        )
        assert rc == 0, f"codex exited {rc}: {stderr}"

        path = _find_codex_session_file(session_id)
        assert path is not None
        lines = _read_session_lines(path)

        types_found = set()
        for line in lines:
            obj = json.loads(line)
            types_found.add(obj.get("type"))

        assert "session_meta" in types_found, f"Missing session_meta. Found: {types_found}"
        assert "response_item" in types_found, f"Missing response_item. Found: {types_found}"
        assert "event_msg" in types_found, f"Missing event_msg. Found: {types_found}"


# ── TEST 6: Codex single-turn extraction ────────────────────────────────────


@skip_no_codex
class TestCodexSingleTurnExtraction:
    """Extract user/assistant from a single-turn Codex session file."""

    @pytest.fixture(scope="class")
    def session(self):
        cwd = _resolve_cwd(os.getcwd())
        prompt = "respond with exactly: codex_extraction_single"
        session_id, stdout, stderr, rc = _run_codex(prompt, cwd)
        assert rc == 0, f"codex exited {rc}: {stderr}"
        assert session_id is not None

        path = _find_codex_session_file(session_id)
        assert path is not None, "Codex session file not created"

        return {
            "path": path,
            "lines": _read_session_lines(path),
            "session_id": session_id,
            "prompt": prompt,
            "stdout": stdout,
        }

    def test_detect_agent_is_codex(self, session):
        from src.lib.session_file_parser import detect_agent
        assert detect_agent(session["lines"]) == "codex"

    def test_extract_user_messages(self, session):
        user_msgs = extract_user_messages(session["lines"])
        assert len(user_msgs) >= 1
        assert any("codex_extraction_single" in m for m in user_msgs)

    def test_parse_has_user_and_agent(self, session):
        messages = parse_session_file(session["lines"], session["session_id"])
        roles = {m["role"] for m in messages}
        assert "user" in roles, f"No user message. Roles: {roles}"
        assert "agent" in roles, f"No agent message. Roles: {roles}"

    def test_user_content_is_plain_text(self, session):
        messages = parse_session_file(session["lines"], session["session_id"])
        user_msgs = [m for m in messages if m["role"] == "user"]
        assert len(user_msgs) >= 1
        assert "codex_extraction_single" in user_msgs[0]["content"]
        # Should be plain text, not JSON
        assert not user_msgs[0]["content"].startswith("{")

    def test_agent_content_is_raw_jsonl(self, session):
        messages = parse_session_file(session["lines"], session["session_id"])
        agent_msgs = [m for m in messages if m["role"] == "agent"]
        assert len(agent_msgs) >= 1
        # Agent content should be the raw JSONL line
        obj = json.loads(agent_msgs[0]["content"])
        assert "type" in obj
        assert "timestamp" in obj

    def test_session_id_attached(self, session):
        messages = parse_session_file(session["lines"], session["session_id"])
        for m in messages:
            assert m["sessionId"] == session["session_id"]

    def test_seq_is_monotonic(self, session):
        messages = parse_session_file(session["lines"], session["session_id"])
        seqs = [m["seq"] for m in messages]
        assert seqs == list(range(len(seqs)))

    def test_materialize_transcript(self, session):
        messages = parse_session_file(session["lines"], session["session_id"])
        transcript = materialize_transcript(messages, session_status="done")

        assert len(transcript) >= 2, (
            f"Expected ≥2 transcript entries, got {len(transcript)}"
        )
        assert transcript[0]["role"] == "user"
        assert "codex_extraction_single" in transcript[0]["content"]

        assistants = [t for t in transcript if t["role"] == "assistant"]
        assert len(assistants) >= 1, "No assistant in materialized transcript"
        assert len(assistants[0]["content"]) > 0

    def test_stdout_json_has_agent_message(self, session):
        """Verify the --json stdout also reports the agent message."""
        found_agent_msg = False
        for line in session["stdout"].splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("type") == "item.completed":
                item = obj.get("item", {})
                if item.get("type") == "agent_message":
                    found_agent_msg = True
                    break
        assert found_agent_msg, "No item.completed/agent_message in codex --json stdout"


# ── TEST 7: Codex tool-use extraction ───────────────────────────────────────


@skip_no_codex
class TestCodexToolUseExtraction:
    """Codex session with tool calls (exec_command) should parse correctly."""

    @pytest.fixture(scope="class")
    def session(self):
        cwd = _resolve_cwd(os.getcwd())
        prompt = "Run the command 'echo codex_tool_test_42' and tell me the output"
        session_id, stdout, stderr, rc = _run_codex(prompt, cwd, timeout=120)
        assert rc == 0, f"codex exited {rc}: {stderr}"
        assert session_id is not None

        path = _find_codex_session_file(session_id)
        assert path is not None, "Codex session file not created"

        return {
            "path": path,
            "lines": _read_session_lines(path),
            "session_id": session_id,
            "prompt": prompt,
        }

    def test_has_function_call(self, session):
        messages = parse_session_file(session["lines"], session["session_id"])
        agent_msgs = [m for m in messages if m["role"] == "agent"]
        has_func_call = False
        for m in agent_msgs:
            try:
                obj = json.loads(m["content"])
                if (obj.get("type") == "response_item"
                        and isinstance(obj.get("payload"), dict)
                        and obj["payload"].get("type") == "function_call"):
                    has_func_call = True
                    break
            except (json.JSONDecodeError, TypeError):
                pass
        assert has_func_call, "No function_call found in agent messages"

    def test_has_function_call_output(self, session):
        messages = parse_session_file(session["lines"], session["session_id"])
        agent_msgs = [m for m in messages if m["role"] == "agent"]
        has_output = False
        for m in agent_msgs:
            try:
                obj = json.loads(m["content"])
                if (obj.get("type") == "response_item"
                        and isinstance(obj.get("payload"), dict)
                        and obj["payload"].get("type") == "function_call_output"):
                    has_output = True
                    break
            except (json.JSONDecodeError, TypeError):
                pass
        assert has_output, "No function_call_output found in agent messages"

    def test_user_prompt_correct(self, session):
        user_msgs = extract_user_messages(session["lines"])
        assert len(user_msgs) >= 1
        assert any("codex_tool_test_42" in m for m in user_msgs)

    def test_materialize_produces_valid_transcript(self, session):
        messages = parse_session_file(session["lines"], session["session_id"])
        transcript = materialize_transcript(messages, session_status="done")
        assert len(transcript) >= 2
        assert transcript[0]["role"] == "user"
