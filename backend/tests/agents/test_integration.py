"""Integration tests that run the real Claude Code CLI.

These tests invoke the actual `claude` binary, send a trivial prompt,
and verify our backend code can handle the real output.  They require:
  - Claude Code CLI installed (`claude` on PATH)
  - A valid API key (env var or /login managed key)

Run with:  pytest tests/agents/test_integration.py -v -s
"""
import base64
import json
import os
import subprocess
import tempfile
import time
import uuid

import pytest

from src.lib.script_builder import build_agent_command, build_launch_cmd
from src.chat import _parse_output_lines, _extract_remote_session_id
from src.lib.transcript import _parse_event, materialize_transcript

CLAUDE_BIN = "claude"
PROMPT = "respond with exactly: pocketeng_ok"

pytestmark = pytest.mark.integration


def _cli_available():
    try:
        r = subprocess.run([CLAUDE_BIN, "--version"], capture_output=True, timeout=5)
        return r.returncode == 0
    except FileNotFoundError:
        return False


skip_no_cli = pytest.mark.skipif(not _cli_available(), reason="claude CLI not installed")


def _run_claude(prompt, extra_flags=None, timeout=30):
    """Pipe a prompt into Claude Code and return (lines, raw_stdout)."""
    cmd = build_agent_command("claude")
    if extra_flags:
        cmd += " " + extra_flags
    proc = subprocess.run(
        cmd,
        input=prompt,
        capture_output=True,
        text=True,
        shell=True,
        timeout=timeout,
    )
    return proc.stdout, proc.stderr, proc.returncode


# ─── TEST 1: Command produces valid NDJSON ─────────────────────────────────

@skip_no_cli
class TestCommandProducesValidNDJSON:
    """CRITICAL — if this fails, the entire chat system is broken."""

    @pytest.fixture(scope="class")
    def claude_output(self):
        stdout, stderr, rc = _run_claude(PROMPT)
        assert rc == 0, f"claude exited {rc}: {stderr}"
        return stdout

    def test_every_line_is_valid_json(self, claude_output):
        lines = [l for l in claude_output.strip().splitlines() if l.strip()]
        assert len(lines) >= 2, "Expected at least init + result lines"
        for i, line in enumerate(lines):
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                pytest.fail(f"Line {i} is not valid JSON: {line[:200]}")
            assert "type" in obj, f"Line {i} missing 'type' field: {line[:200]}"

    def test_has_init_event(self, claude_output):
        lines = [json.loads(l) for l in claude_output.strip().splitlines() if l.strip()]
        init_events = [l for l in lines if l.get("type") == "system" and l.get("subtype") == "init"]
        assert len(init_events) == 1, "Expected exactly one system/init event"

    def test_has_result_event(self, claude_output):
        lines = [json.loads(l) for l in claude_output.strip().splitlines() if l.strip()]
        results = [l for l in lines if l.get("type") == "result"]
        assert len(results) == 1, "Expected exactly one result event"

    def test_init_contains_session_id(self, claude_output):
        lines = [json.loads(l) for l in claude_output.strip().splitlines() if l.strip()]
        init = next(l for l in lines if l.get("type") == "system" and l.get("subtype") == "init")
        assert "session_id" in init and len(init["session_id"]) > 0

    def test_result_is_success(self, claude_output):
        lines = [json.loads(l) for l in claude_output.strip().splitlines() if l.strip()]
        result = next(l for l in lines if l.get("type") == "result")
        assert result.get("subtype") == "success" or result.get("is_error") is False


# ─── TEST 2: Our parser handles real output ─────────────────────────────────

@skip_no_cli
class TestParserHandlesRealOutput:
    """CRITICAL — if this fails, the UI shows nothing to the user."""

    @pytest.fixture(scope="class")
    def claude_output(self):
        stdout, stderr, rc = _run_claude(PROMPT)
        assert rc == 0, f"claude exited {rc}: {stderr}"
        return stdout

    def test_parse_output_lines_returns_valid_data(self, claude_output):
        raw_lines, parsed_lines = _parse_output_lines(claude_output)
        assert len(raw_lines) >= 2
        assert len(parsed_lines) >= 2
        for line in parsed_lines:
            assert "type" in line

    def test_parse_event_produces_initialized(self, claude_output):
        raw_lines, _ = _parse_output_lines(claude_output)
        events = [_parse_event(l) for l in raw_lines]
        events = [e for e in events if e is not None]
        kinds = [e["kind"] for e in events]
        assert "initialized" in kinds, f"No 'initialized' event found. Got kinds: {kinds}"

    def test_parse_event_produces_assistant_content(self, claude_output):
        raw_lines, _ = _parse_output_lines(claude_output)
        events = [_parse_event(l) for l in raw_lines]
        events = [e for e in events if e is not None]
        kinds = [e["kind"] for e in events]
        has_assistant = "assistant_snapshot" in kinds or "assistant_text" in kinds
        assert has_assistant, f"No assistant content event found. Got kinds: {kinds}"

    def test_parse_event_produces_completed(self, claude_output):
        raw_lines, _ = _parse_output_lines(claude_output)
        events = [_parse_event(l) for l in raw_lines]
        events = [e for e in events if e is not None]
        kinds = [e["kind"] for e in events]
        assert "completed" in kinds, f"No 'completed' event found. Got kinds: {kinds}"

    def test_extract_remote_session_id_works(self, claude_output):
        raw_lines, _ = _parse_output_lines(claude_output)
        # Find the init event by type. Local envs with SessionStart hooks
        # emit hook_started lines before the real init, so raw_lines[0]
        # isn't reliable.
        init_line = next(
            l for l in raw_lines
            if '"type":"system"' in l.replace(" ", "") and '"subtype":"init"' in l.replace(" ", "")
        )
        session_id = _extract_remote_session_id(init_line)
        assert session_id is not None and len(session_id) > 0


# ─── TEST 3: Full launch script works locally ──────────────────────────────

def _launch_script_runnable_locally():
    """The launch script prepends /opt/homebrew/bin to PATH (correct for EC2
    macOS targets). A dev machine may have a stale homebrew-installed claude
    that shadows the working one at ~/.npm-global/bin/claude — if so, this
    test can't meaningfully run locally. We skip it rather than pretend it's
    green. The real coverage happens on EC2; this is only a convenience check.
    """
    try:
        r = subprocess.run(
            ["/opt/homebrew/bin/claude", "--version"],
            capture_output=True, text=True, timeout=5,
        )
        return r.returncode == 0 and "(Claude Code)" in r.stdout
    except FileNotFoundError:
        return True  # no homebrew claude at all — PATH will fall through to user's


@skip_no_cli
@pytest.mark.skipif(
    not _launch_script_runnable_locally(),
    reason="/opt/homebrew/bin/claude is present but broken on this machine — can't run launch script locally",
)
class TestLaunchScriptWorks:
    """CRITICAL — proves the bash script we build for EC2 actually runs."""

    def test_script_produces_output_and_pid(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            session_id = "integration-test"
            prompt_b64 = base64.b64encode(PROMPT.encode()).decode()
            prompt_file = os.path.join(tmpdir, "pe-prompt.txt")
            script_file = os.path.join(tmpdir, "pe-run.sh")
            out_file = os.path.join(tmpdir, "pe-out.jsonl")
            pid_file = os.path.join(tmpdir, "pe-pid")
            agent_cmd = build_agent_command("claude")

            cmd = build_launch_cmd(
                workdir=tmpdir,
                prompt_b64=prompt_b64,
                prompt_file=prompt_file,
                script_file=script_file,
                agent_cmd=agent_cmd,
                out_file=out_file,
                pid_file=pid_file,
            )

            result = subprocess.run(
                ["bash", "-c", cmd],
                capture_output=True, text=True, timeout=10,
            )
            pid_str = result.stdout.strip()
            assert pid_str.isdigit(), f"Expected PID, got: {pid_str!r}"

            pid = int(pid_str)
            for _ in range(30):
                try:
                    os.kill(pid, 0)
                    time.sleep(1)
                except OSError:
                    break

            assert os.path.exists(pid_file), "PID file not created"
            assert os.path.exists(out_file), "Output file not created"

            with open(pid_file) as f:
                assert f.read().strip() == pid_str

            with open(out_file) as f:
                output = f.read()

            lines = [l for l in output.strip().splitlines() if l.strip()]
            assert len(lines) >= 2, f"Expected NDJSON lines, got {len(lines)}"
            for line in lines:
                obj = json.loads(line)
                assert "type" in obj

    def test_prompt_file_contains_decoded_prompt(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            prompt_b64 = base64.b64encode(b"test prompt content").decode()
            prompt_file = os.path.join(tmpdir, "pe-prompt.txt")
            script_file = os.path.join(tmpdir, "pe-run.sh")
            out_file = os.path.join(tmpdir, "pe-out.jsonl")
            pid_file = os.path.join(tmpdir, "pe-pid")

            cmd_parts = [
                f"cd {tmpdir};",
                f"echo '{prompt_b64}' | base64 -d > {prompt_file};",
                f"cat {prompt_file}",
            ]
            result = subprocess.run(
                ["bash", "-c", " ".join(cmd_parts)],
                capture_output=True, text=True, timeout=5,
            )
            assert result.stdout.strip() == "test prompt content"


# ─── TEST 4: Session ID propagation ────────────────────────────────────────

@skip_no_cli
class TestSessionIdPropagation:
    """Verify --session-id flag is respected in the init event."""

    def test_custom_session_id_appears_in_init(self):
        custom_id = str(uuid.uuid4())
        cmd_str = build_agent_command("claude", remote_session_id=custom_id)
        proc = subprocess.run(
            cmd_str,
            input=PROMPT,
            capture_output=True, text=True,
            shell=True, timeout=30,
        )
        assert proc.returncode == 0, f"claude exited {proc.returncode}: {proc.stderr}"

        lines = [json.loads(l) for l in proc.stdout.strip().splitlines() if l.strip()]
        init = next(l for l in lines if l.get("type") == "system" and l.get("subtype") == "init")
        assert init["session_id"] == custom_id


# ─── TEST 5: Transcript materialization from real output ────────────────────

@skip_no_cli
class TestTranscriptMaterializationReal:
    """Verify materialize_transcript() works with real Claude Code output."""

    def test_produces_valid_transcript(self):
        stdout, stderr, rc = _run_claude(PROMPT)
        assert rc == 0, f"claude exited {rc}: {stderr}"

        raw_lines = [l for l in stdout.strip().splitlines() if l.strip()]

        messages = [
            {"seq": 0, "role": "user", "content": PROMPT, "createdAt": "2026-04-05T00:00:00Z", "sessionId": "test"},
        ]
        for i, line in enumerate(raw_lines):
            messages.append({
                "seq": i + 1,
                "role": "agent",
                "content": line,
                "createdAt": "2026-04-05T00:00:01Z",
                "sessionId": "test",
            })

        transcript = materialize_transcript(messages, session_status="done")

        assert len(transcript) >= 2, f"Expected user + assistant, got {len(transcript)} entries"
        assert transcript[0]["role"] == "user"
        assert transcript[0]["content"] == PROMPT

        assistant_entries = [t for t in transcript if t["role"] == "assistant"]
        assert len(assistant_entries) >= 1, "No assistant entry in transcript"
        assert len(assistant_entries[0]["content"]) > 0, "Assistant content is empty"


# ─── TEST 6: Model flag works with real models ─────────────────────────────

@skip_no_cli
class TestModelFlag:
    """Verify --model flag works and bad models produce proper error NDJSON."""

    WORKING_MODELS = [
        "claude-sonnet-4-20250514",
        "claude-opus-4-20250514",
    ]

    @pytest.mark.parametrize("model", WORKING_MODELS)
    def test_valid_model_produces_success(self, model):
        cmd_str = build_agent_command("claude", model=model)
        proc = subprocess.run(
            cmd_str, input="say hi", capture_output=True, text=True,
            shell=True, timeout=30,
        )
        assert proc.returncode == 0, f"{model} failed: {proc.stderr}"
        lines = [json.loads(l) for l in proc.stdout.strip().splitlines() if l.strip()]
        result = next(l for l in lines if l.get("type") == "result")
        assert result.get("is_error") is not True, f"{model} returned error: {result.get('result')}"

    def test_invalid_model_still_returns_valid_ndjson(self):
        """Bad model names should fail gracefully — valid NDJSON with is_error=True."""
        cmd_str = build_agent_command("claude", model="nonexistent-model-xyz")
        proc = subprocess.run(
            cmd_str, input="say hi", capture_output=True, text=True,
            shell=True, timeout=15,
        )
        lines = [l for l in proc.stdout.strip().splitlines() if l.strip()]
        assert len(lines) >= 1, "Expected at least one NDJSON line even for bad model"
        for line in lines:
            obj = json.loads(line)
            assert "type" in obj

        result_lines = [json.loads(l) for l in lines if "result" in l]
        if result_lines:
            assert result_lines[-1].get("is_error") is True

    def test_parser_handles_model_error_gracefully(self):
        """Our parser must not crash on model error output."""
        cmd_str = build_agent_command("claude", model="nonexistent-model-xyz")
        proc = subprocess.run(
            cmd_str, input="say hi", capture_output=True, text=True,
            shell=True, timeout=15,
        )
        raw_lines, parsed_lines = _parse_output_lines(proc.stdout)
        for line in raw_lines:
            event = _parse_event(line)
            # Should not raise — every line must parse or return None


# ─── Codex CLI Integration Tests ──────────────────────────────────────────

CODEX_BIN = "codex"
CODEX_PROMPT = "respond with exactly: pocketeng_ok"
CODEX_WORKDIR = "/tmp/pe-codex-test"


@pytest.fixture(autouse=True, scope="module")
def _ensure_codex_workdir():
    os.makedirs(CODEX_WORKDIR, exist_ok=True)
    yield


def _codex_available():
    try:
        r = subprocess.run([CODEX_BIN, "--version"], capture_output=True, timeout=5)
        return r.returncode == 0
    except FileNotFoundError:
        return False


skip_no_codex = pytest.mark.skipif(not _codex_available(), reason="codex CLI not installed")


def _run_codex(prompt, extra_flags="", timeout=60):
    cmd = build_agent_command("codex")
    if extra_flags:
        cmd += " " + extra_flags
    proc = subprocess.run(
        cmd,
        input=prompt,
        capture_output=True,
        text=True,
        shell=True,
        timeout=timeout,
        cwd="/tmp/pe-codex-test",
    )
    return proc.stdout, proc.stderr, proc.returncode


def _ensure_bridge_files():
    """Copy bridge .mjs files from the repo to ~/.pocketeng/bridge/ if missing.
    The bridge source lives in backend/src/lib/bridge/ and is normally SFTP'd
    to EC2 at session launch. For local tests we just copy them."""
    bridge_dir = os.path.expanduser("~/.pocketeng/bridge")
    bridge_path = os.path.join(bridge_dir, "bridge.mjs")
    if os.path.exists(bridge_path):
        return
    src_dir = os.path.join(os.path.dirname(__file__), "..", "..", "src", "lib", "bridge")
    src_dir = os.path.normpath(src_dir)
    if not os.path.isdir(src_dir):
        return
    os.makedirs(bridge_dir, exist_ok=True)
    import shutil
    for f in os.listdir(src_dir):
        if f.endswith(".mjs") and not f.endswith(".test.mjs"):
            shutil.copy2(os.path.join(src_dir, f), os.path.join(bridge_dir, f))


def _bridge_available():
    """The bridge needs ~/.pocketeng/bridge/ populated and SDKs symlinked.
    Auto-copies bridge files from the repo if missing."""
    _ensure_bridge_files()
    bridge_path = os.path.expanduser("~/.pocketeng/bridge/bridge.mjs")
    node_modules = os.path.expanduser("~/.pocketeng/bridge/node_modules")
    if not os.path.exists(bridge_path):
        return False
    # Confirm at least the Codex SDK resolves
    return os.path.isdir(os.path.join(node_modules, "@openai", "codex-sdk"))


skip_no_bridge = pytest.mark.skipif(
    not _bridge_available(),
    reason="Bridge not set up locally. See session notes for ~/.pocketeng/bridge/ setup.",
)


def _run_codex_via_bridge(prompt, timeout=90):
    """Invoke the bridge's runCodex() path end-to-end. This is what will be
    wired up once we flip Codex to bridge=True in agents.py."""
    bridge = os.path.expanduser("~/.pocketeng/bridge/bridge.mjs")
    proc = subprocess.run(
        ["node", bridge, "--agent", "codex", "--workdir", CODEX_WORKDIR],
        input=prompt,
        capture_output=True,
        text=True,
        timeout=timeout,
        cwd=CODEX_WORKDIR,
    )
    return proc.stdout, proc.stderr, proc.returncode


@skip_no_codex
@skip_no_bridge
class TestCodexViaBridgeProducesValidNDJSON:
    """Verify the bridge's runCodex() path — pre-flight before flipping.

    Uses bridge with approvalPolicy='never' + sandboxMode='danger-full-access'
    to match the CLI's --dangerously-bypass-approvals-and-sandbox behavior.
    """

    @pytest.fixture(scope="class")
    def bridge_output(self):
        stdout, stderr, rc = _run_codex_via_bridge(CODEX_PROMPT)
        assert rc == 0, f"bridge exited {rc}: {stderr[:500]}"
        return stdout

    def test_bridge_emits_ndjson(self, bridge_output):
        lines = [l for l in bridge_output.strip().splitlines() if l.strip()]
        assert len(lines) >= 2
        for i, line in enumerate(lines):
            obj = json.loads(line)
            assert "type" in obj, f"Line {i} not JSON or missing type: {line[:200]}"

    def test_bridge_emits_init_event(self, bridge_output):
        lines = [json.loads(l) for l in bridge_output.strip().splitlines() if l.strip()]
        inits = [l for l in lines if l.get("type") == "system" and l.get("subtype") == "init"]
        assert len(inits) == 1
        assert inits[0].get("session_id")

    def test_bridge_emits_assistant_message(self, bridge_output):
        lines = [json.loads(l) for l in bridge_output.strip().splitlines() if l.strip()]
        assistants = [l for l in lines if l.get("type") == "assistant"]
        assert len(assistants) >= 1
        all_text = "".join(
            block.get("text", "")
            for a in assistants
            for block in a.get("message", {}).get("content", [])
            if block.get("type") == "text"
        )
        assert "pocketeng_ok" in all_text

    def test_bridge_emits_result_event(self, bridge_output):
        lines = [json.loads(l) for l in bridge_output.strip().splitlines() if l.strip()]
        results = [l for l in lines if l.get("type") == "result"]
        assert len(results) == 1
        assert results[0].get("subtype") == "success"


@skip_no_codex
@skip_no_bridge
class TestCodexViaBridgeToolCallWorks:
    """Verify that a tool call (Bash command) actually runs without hanging
    on approval prompts. This was THE risk from flipping Codex to bridge —
    without approvalPolicy='never' + sandboxMode='danger-full-access' the
    first tool call would block indefinitely."""

    def test_bash_command_completes(self):
        marker_file = "/tmp/pe-codex-bridge-test-marker"
        try:
            os.remove(marker_file)
        except OSError:
            pass
        prompt = f"Run the bash command 'echo hello > {marker_file}' and then tell me it is done."
        stdout, stderr, rc = _run_codex_via_bridge(prompt, timeout=180)
        assert rc == 0, f"bridge exited {rc}: {stderr[:500]}"
        assert os.path.exists(marker_file), (
            f"Codex did not create the marker file — approval/sandbox likely blocked the tool call. "
            f"stdout tail: {stdout[-500:]!r}"
        )
        with open(marker_file) as f:
            assert "hello" in f.read()
        os.remove(marker_file)


# Note: TestCodexProducesValidNDJSON and TestCodexParserHandlesRealOutput
# were removed when Codex flipped from direct CLI to running through the
# bridge. They asserted on Codex's native event types (thread.started,
# item.completed/agent_message, turn.completed) which the bridge normalizes
# into Claude Code's NDJSON format (system/init, assistant, result).
#
# The bridge path is covered end-to-end by:
#   - TestCodexViaBridgeProducesValidNDJSON (valid normalized NDJSON + init + assistant + result)
#   - TestCodexViaBridgeToolCallWorks (approvalPolicy='never' actually bypasses)
#   - TestCodexTranscriptMaterializationReal (transcript materializer handles bridge output)
# Normalized-format parser coverage lives in the Claude tests (same format).


@skip_no_codex
@skip_no_bridge
class TestCodexTranscriptMaterializationReal:
    """End-to-end: real Codex output → materialized transcript."""

    def test_produces_valid_transcript(self):
        stdout, stderr, rc = _run_codex(CODEX_PROMPT)
        assert rc == 0, f"codex exited {rc}: {stderr}"
        raw_lines = [l.strip() for l in stdout.strip().splitlines() if l.strip()]

        messages = [
            {"seq": 0, "role": "user", "content": CODEX_PROMPT,
             "createdAt": "2026-04-05T00:00:00Z", "sessionId": "test"},
        ]
        for i, line in enumerate(raw_lines):
            messages.append({
                "seq": i + 1,
                "role": "agent",
                "content": line,
                "createdAt": "2026-04-05T00:00:01Z",
                "sessionId": "test",
            })

        transcript = materialize_transcript(messages, session_status="done")
        assert len(transcript) >= 2
        assert transcript[0]["role"] == "user"
        assistant_entries = [t for t in transcript if t["role"] == "assistant"]
        assert len(assistant_entries) >= 1
        assert "pocketeng_ok" in assistant_entries[0]["content"]


@skip_no_codex
@skip_no_bridge
class TestCodexWithToolUse:
    """Verify Codex command_execution events surface as tool_use in bridge output.

    Codex's SDK emits `item.completed` for command_execution without always
    including the output on the same event, so bridge emits a `tool_use`
    block but may not emit a paired `tool_result`. The UI tolerates this
    (tool shows without output) and can be improved later by listening to
    item.updated events too. This test just verifies the tool_use emission.
    """

    def test_bridge_emits_tool_use_for_command_execution(self):
        stdout, stderr, rc = _run_codex("Run the bash command `echo hi` and then reply done.")
        assert rc == 0, f"codex exited {rc}: {stderr[:500]}"
        lines = [json.loads(l) for l in stdout.strip().splitlines() if l.strip()]
        tool_uses = [l for l in lines if l.get("type") == "tool_use"]
        assert any(l.get("tool", {}).get("name") == "Bash" for l in tool_uses), \
            f"Expected a Bash tool_use in bridge output. Got types: {[l.get('type') for l in lines]}"


@skip_no_codex
@skip_no_bridge
class TestCodexModelFlag:
    """Verify --model flag is honored by the bridge (passed to SDK startThread)."""

    def test_model_flag_in_command(self):
        cmd_str = build_agent_command("codex", model="gpt-5")
        assert "--model gpt-5" in cmd_str
        assert "bridge.mjs" in cmd_str


# ─── Cursor CLI Integration Tests ───────────────────────────────────────────

CURSOR_BIN = "agent"
CURSOR_PROMPT = "respond with exactly: pocketeng_ok"


def _cursor_available():
    try:
        r = subprocess.run([CURSOR_BIN, "--version"], capture_output=True, timeout=5)
        return r.returncode == 0
    except FileNotFoundError:
        return False


skip_no_cursor = pytest.mark.skipif(not _cursor_available(), reason="cursor CLI (agent) not installed")


def _run_cursor(prompt, extra_flags="", timeout=60):
    cmd = build_agent_command("cursor")
    if extra_flags:
        cmd += " " + extra_flags
    proc = subprocess.run(
        cmd,
        input=prompt,
        capture_output=True,
        text=True,
        shell=True,
        timeout=timeout,
    )
    return proc.stdout, proc.stderr, proc.returncode


def _cursor_bridge_available():
    """Bridge needs ~/.pocketeng/bridge/ populated. Cursor doesn't have an
    npm-installable SDK — the bridge spawns the `agent` CLI as a subprocess
    and just needs Node to find it on PATH."""
    _ensure_bridge_files()
    bridge_path = os.path.expanduser("~/.pocketeng/bridge/bridge.mjs")
    return os.path.exists(bridge_path)


skip_no_cursor_bridge = pytest.mark.skipif(
    not _cursor_bridge_available(),
    reason="Bridge not set up locally. See session notes for ~/.pocketeng/bridge/ setup.",
)


def _run_cursor_via_bridge(prompt, timeout=90, workdir=None):
    """Invoke the bridge's runCursor() path end-to-end. This is what runs in
    prod after the Cursor flip. Uses --workdir to isolate from the repo."""
    import tempfile
    bridge = os.path.expanduser("~/.pocketeng/bridge/bridge.mjs")
    with tempfile.TemporaryDirectory() as tmp:
        wd = workdir or tmp
        proc = subprocess.run(
            ["node", bridge, "--agent", "cursor", "--workdir", wd],
            input=prompt,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=wd,
        )
        return proc.stdout, proc.stderr, proc.returncode


@skip_no_cursor
@skip_no_cursor_bridge
class TestCursorViaBridgeProducesValidNDJSON:
    """Verify the bridge's runCursor() subprocess wrap emits valid
    Claude-compatible stream-json — pre-flight before flipping."""

    @pytest.fixture(scope="class")
    def bridge_output(self):
        stdout, stderr, rc = _run_cursor_via_bridge(CURSOR_PROMPT)
        assert rc == 0, f"bridge exited {rc}: {stderr[:500]}"
        return stdout

    def test_bridge_emits_ndjson(self, bridge_output):
        lines = [l for l in bridge_output.strip().splitlines() if l.strip()]
        assert len(lines) >= 2
        for i, line in enumerate(lines):
            obj = json.loads(line)
            assert "type" in obj, f"Line {i} not JSON or missing type: {line[:200]}"

    def test_bridge_emits_init_event(self, bridge_output):
        lines = [json.loads(l) for l in bridge_output.strip().splitlines() if l.strip()]
        inits = [l for l in lines if l.get("type") == "system" and l.get("subtype") == "init"]
        assert len(inits) == 1

    def test_bridge_emits_result_event(self, bridge_output):
        lines = [json.loads(l) for l in bridge_output.strip().splitlines() if l.strip()]
        results = [l for l in lines if l.get("type") == "result"]
        assert len(results) == 1


@skip_no_cursor
class TestCursorProducesValidNDJSON:
    """Verify Cursor CLI outputs parseable NDJSON with stream-json format."""

    @pytest.fixture(scope="class")
    def cursor_output(self):
        stdout, stderr, rc = _run_cursor(CURSOR_PROMPT)
        assert rc == 0, f"cursor exited {rc}: {stderr}"
        return stdout

    def test_every_line_is_valid_json(self, cursor_output):
        lines = [l for l in cursor_output.strip().splitlines() if l.strip()]
        assert len(lines) >= 2, "Expected at least init + result lines"
        for i, line in enumerate(lines):
            obj = json.loads(line)
            assert "type" in obj, f"Line {i} missing 'type': {line[:200]}"

    def test_has_system_init(self, cursor_output):
        lines = [json.loads(l) for l in cursor_output.strip().splitlines() if l.strip()]
        init = [l for l in lines if l.get("type") == "system" and l.get("subtype") == "init"]
        assert len(init) == 1, "Expected exactly one system/init event"

    def test_init_contains_session_id(self, cursor_output):
        lines = [json.loads(l) for l in cursor_output.strip().splitlines() if l.strip()]
        init = next(l for l in lines if l.get("type") == "system" and l.get("subtype") == "init")
        assert "session_id" in init and len(init["session_id"]) > 0

    def test_has_result_event(self, cursor_output):
        lines = [json.loads(l) for l in cursor_output.strip().splitlines() if l.strip()]
        results = [l for l in lines if l.get("type") == "result"]
        assert len(results) == 1, "Expected exactly one result event"

    def test_result_is_success(self, cursor_output):
        lines = [json.loads(l) for l in cursor_output.strip().splitlines() if l.strip()]
        result = next(l for l in lines if l.get("type") == "result")
        assert result.get("subtype") == "success" or result.get("is_error") is False


@skip_no_cursor
class TestCursorParserHandlesRealOutput:
    """Our parser correctly processes real Cursor output."""

    @pytest.fixture(scope="class")
    def cursor_lines(self):
        stdout, stderr, rc = _run_cursor(CURSOR_PROMPT)
        assert rc == 0, f"cursor exited {rc}: {stderr}"
        return [l.strip() for l in stdout.strip().splitlines() if l.strip()]

    def test_parse_event_extracts_initialized(self, cursor_lines):
        init_line = next(l for l in cursor_lines if '"system"' in l and '"init"' in l)
        event = _parse_event(init_line)
        assert event["kind"] == "initialized"
        assert event["sessionId"]

    def test_parse_event_extracts_assistant_content(self, cursor_lines):
        events = [_parse_event(l) for l in cursor_lines]
        events = [e for e in events if e is not None]
        kinds = [e["kind"] for e in events]
        has_assistant = "assistant_snapshot" in kinds or "assistant_text" in kinds
        assert has_assistant, f"No assistant content event found. Got kinds: {kinds}"

    def test_parse_event_extracts_completed(self, cursor_lines):
        events = [_parse_event(l) for l in cursor_lines]
        events = [e for e in events if e is not None]
        kinds = [e["kind"] for e in events]
        assert "completed" in kinds, f"No 'completed' event found. Got kinds: {kinds}"

    def test_extract_remote_session_id_works(self, cursor_lines):
        init_line = next(l for l in cursor_lines if '"system"' in l and '"init"' in l)
        session_id = _extract_remote_session_id(init_line)
        assert session_id is not None


@skip_no_cursor
class TestCursorTranscriptMaterializationReal:
    """End-to-end: real Cursor output -> materialized transcript."""

    def test_produces_valid_transcript(self):
        stdout, stderr, rc = _run_cursor(CURSOR_PROMPT)
        assert rc == 0, f"cursor exited {rc}: {stderr}"
        raw_lines = [l.strip() for l in stdout.strip().splitlines() if l.strip()]

        messages = [
            {"seq": 0, "role": "user", "content": CURSOR_PROMPT,
             "createdAt": "2026-04-14T00:00:00Z", "sessionId": "test"},
        ]
        for i, line in enumerate(raw_lines):
            messages.append({
                "seq": i + 1,
                "role": "agent",
                "content": line,
                "createdAt": "2026-04-14T00:00:01Z",
                "sessionId": "test",
            })

        transcript = materialize_transcript(messages, session_status="done")
        assert len(transcript) >= 2
        assert transcript[0]["role"] == "user"
        assistant_entries = [t for t in transcript if t["role"] == "assistant"]
        assert len(assistant_entries) >= 1
        assert len(assistant_entries[0]["content"]) > 0


@skip_no_cursor
class TestCursorModelFlag:
    """Verify --model flag works with Cursor CLI."""

    def test_model_flag_in_command(self):
        cmd_str = build_agent_command("cursor", model="gpt-5")
        assert "--model gpt-5" in cmd_str
