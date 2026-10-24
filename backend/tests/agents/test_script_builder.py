"""Tests for script_builder — the pure functions extracted from _launch_turn().

Every test here verifies that the extracted functions produce the exact
same output as the old inline code in chat.py.  No mocks needed.
"""
import shlex

import pytest

from src.lib.script_builder import (
    build_agent_command,
    build_api_key_exports,
    build_callback_exports,
    build_callback_tail,
    build_ingest_exports,
    build_launch_cmd,
)


class TestBuildAgentCommand:
    """Verify agent command construction matches old inline logic."""

    def test_claude_base_command(self):
        cmd = build_agent_command("claude")
        assert cmd == "node ~/.pocketeng/bridge/bridge.mjs --agent claude"

    def test_codex_base_command(self):
        cmd = build_agent_command("codex")
        assert cmd == "node ~/.pocketeng/bridge/bridge.mjs --agent codex"

    def test_unknown_agent_falls_back_to_claude(self):
        cmd = build_agent_command("nonexistent")
        assert "--agent claude" in cmd

    def test_opencode_base_command(self):
        cmd = build_agent_command("opencode")
        assert cmd == "node ~/.pocketeng/bridge/bridge.mjs --agent opencode"

    def test_claude_with_model(self):
        cmd = build_agent_command("claude", model="sonnet")
        assert "--model sonnet" in cmd

    def test_codex_with_model_flag(self):
        cmd = build_agent_command("codex", model="gpt-5")
        assert "--model gpt-5" in cmd

    def test_claude_resume(self):
        cmd = build_agent_command("claude", can_resume=True, remote_session_id="abc-123")
        # Claude-specific flags forwarded to the SDK; PE session flags aren't
        # set by build_agent_command (they come from env vars).
        assert "--claude-resume abc-123" in cmd
        assert "--claude-new-session-id" not in cmd

    def test_claude_new_session_id(self):
        cmd = build_agent_command("claude", can_resume=False, remote_session_id="abc-123")
        assert "--claude-new-session-id abc-123" in cmd
        assert "--claude-resume" not in cmd

    def test_claude_no_remote_session(self):
        cmd = build_agent_command("claude", can_resume=False, remote_session_id=None)
        assert "--claude-resume" not in cmd
        assert "--claude-new-session-id" not in cmd

    def test_cursor_base_command(self):
        cmd = build_agent_command("cursor")
        assert cmd == "node ~/.pocketeng/bridge/bridge.mjs --agent cursor"

    def test_cursor_with_model(self):
        cmd = build_agent_command("cursor", model="gpt-5")
        assert "--model gpt-5" in cmd

    def test_cursor_resume(self):
        cmd = build_agent_command("cursor", can_resume=True, remote_session_id="sess-abc")
        # Bridge forwards --cursor-resume to the `agent` CLI as --resume;
        # the prefixed flag keeps it from colliding with PE's own --resume.
        assert "--cursor-resume sess-abc" in cmd

    def test_cursor_no_resume_without_can_resume(self):
        cmd = build_agent_command("cursor", can_resume=False, remote_session_id="sess-abc")
        assert "--resume" not in cmd
        assert "--session-id" not in cmd

    def test_cursor_no_resume_without_session_id(self):
        cmd = build_agent_command("cursor", can_resume=True, remote_session_id=None)
        assert "--resume" not in cmd

    def test_cursor_model_and_resume(self):
        cmd = build_agent_command("cursor", model="opus", can_resume=True, remote_session_id="sess-1")
        assert "--model opus" in cmd
        assert "--cursor-resume sess-1" in cmd

    def test_codex_resume_forwards_codex_resume_flag(self):
        """When the rollout .jsonl exists on EC2 (can_resume=True) the
        bridge receives `--codex-resume <rsid>` which gets fed into
        `codex.resumeThread(id, opts)`. That reopens the existing
        rollout file and appends new turns — key to avoiding the per-turn
        rollout-file proliferation bug that was driving the Codex
        duplicate-session behavior."""
        cmd = build_agent_command("codex", can_resume=True, remote_session_id="019dafab-0000-7000-8000-000000000000")
        assert "--codex-resume 019dafab-0000-7000-8000-000000000000" in cmd
        # PE session plumbing still flows through env vars — build_agent_command
        # must never emit raw --resume / --session-id that would collide with
        # the agent's own CLI options.
        assert " --resume " not in cmd
        assert " --session-id " not in cmd

    def test_codex_no_resume_without_can_resume(self):
        """First turn on a new session, or follow-up where the probe didn't
        find a matching rollout file: DO NOT pass --codex-resume. The bridge
        will fall back to `codex.startThread()` and mint a fresh thread id."""
        cmd = build_agent_command("codex", can_resume=False, remote_session_id="019dafab-0000-7000-8000-000000000000")
        assert "--codex-resume" not in cmd

    def test_codex_no_resume_without_remote_session_id(self):
        cmd = build_agent_command("codex", can_resume=True, remote_session_id=None)
        assert "--codex-resume" not in cmd

    def test_codex_model_and_resume(self):
        cmd = build_agent_command("codex", model="gpt-5", can_resume=True, remote_session_id="sess-1")
        assert "--model gpt-5" in cmd
        assert "--codex-resume sess-1" in cmd

    def test_opencode_resume(self):
        cmd = build_agent_command("opencode", can_resume=True, remote_session_id="sess-1")
        assert "--opencode-resume sess-1" in cmd

    def test_opencode_ignores_model_flag(self):
        cmd = build_agent_command("opencode", model="anthropic/claude-sonnet")
        assert "--model" not in cmd

    def test_claude_model_and_resume(self):
        cmd = build_agent_command("claude", model="opus", can_resume=True, remote_session_id="sess-1")
        assert "--model opus" in cmd
        assert "--claude-resume sess-1" in cmd

    def test_model_with_special_chars_is_quoted(self):
        cmd = build_agent_command("claude", model="model with spaces")
        assert shlex.quote("model with spaces") in cmd


class TestBuildCallbackExports:
    def test_returns_empty_when_no_url(self):
        result = build_callback_exports(None, "secret", "srv-1", "sess-1", "/tmp/pid", "/tmp/script.sh")
        assert result == ""

    def test_returns_empty_when_no_secret(self):
        result = build_callback_exports("https://api.example.com", None, "srv-1", "sess-1", "/tmp/pid", "/tmp/script.sh")
        assert result == ""

    def test_returns_empty_when_both_missing(self):
        result = build_callback_exports(None, None, "srv-1", "sess-1", "/tmp/pid", "/tmp/script.sh")
        assert result == ""

    def test_includes_all_vars(self):
        result = build_callback_exports(
            "https://api.example.com/complete",
            "my-secret",
            "srv-1",
            "sess-1",
            "/tmp/pe-pid-sess-1",
            "/tmp/pe-run-abc.sh",
        )
        assert "PE_CALLBACK_URL" in result
        assert "PE_CALLBACK_SECRET" in result
        assert "PE_SERVER_ID" in result
        assert "PE_SESSION_ID" in result
        assert "PE_PID_FILE" in result
        assert "api.example.com/complete" in result
        assert "my-secret" in result


class TestBuildCallbackTail:
    def test_returns_empty_when_no_url(self):
        assert build_callback_tail(None, "secret", "/tmp/script.sh") == ""

    def test_returns_empty_when_no_secret(self):
        assert build_callback_tail("https://api.example.com", None, "/tmp/script.sh") == ""

    def test_includes_curl(self):
        result = build_callback_tail("https://api.example.com", "secret", "/tmp/script.sh")
        assert "curl -sS -X POST" in result
        assert "EXIT_CODE=$?" in result
        assert "PE_PID" in result


class TestBuildApiKeyExports:
    """Verify agent-specific API key loading."""

    def test_claude_loads_anthropic_key(self):
        result = build_api_key_exports("claude", "/tmp/script.sh")
        assert "ANTHROPIC_API_KEY" in result
        assert "~/.pocketeng/anthropic_key" in result

    def test_codex_loads_openai_key(self):
        result = build_api_key_exports("codex", "/tmp/script.sh")
        assert "OPENAI_API_KEY" in result
        assert "~/.pocketeng/openai_key" in result

    def test_cursor_loads_cursor_key(self):
        result = build_api_key_exports("cursor", "/tmp/script.sh")
        assert "CURSOR_API_KEY" in result
        assert "~/.pocketeng/cursor_key" in result

    def test_opencode_only_loads_github_token(self):
        result = build_api_key_exports("opencode", "/tmp/script.sh")
        assert "GH_TOKEN" in result
        assert "ANTHROPIC_API_KEY" not in result
        assert "OPENAI_API_KEY" not in result

    def test_always_includes_github_token(self):
        for agent in ("claude", "codex", "cursor", "opencode"):
            result = build_api_key_exports(agent, "/tmp/script.sh")
            assert "GH_TOKEN" in result
            assert "~/.pocketeng/github_token" in result


class TestBuildLaunchCmd:
    """Verify the full launch command structure."""

    PARAMS = {
        "workdir": "~/projects/myapp",
        "prompt_b64": "aGVsbG8gd29ybGQ=",
        "prompt_file": "/tmp/pe-prompt-abc123.txt",
        "script_file": "/tmp/pe-run-abc123.sh",
        "agent_cmd": "claude --print --verbose --output-format stream-json --dangerously-skip-permissions",
        "out_file": "/tmp/pe-out-sess1.jsonl",
        "pid_file": "/tmp/pe-pid-sess1",
    }

    def test_claude_includes_anthropic_key(self):
        result = build_launch_cmd(**self.PARAMS, agent="claude")
        assert "ANTHROPIC_API_KEY" in result
        assert "~/.pocketeng/anthropic_key" in result

    def test_codex_includes_openai_key(self):
        result = build_launch_cmd(**self.PARAMS, agent="codex")
        assert "OPENAI_API_KEY" in result
        assert "~/.pocketeng/openai_key" in result

    def test_cursor_includes_cursor_key(self):
        result = build_launch_cmd(**self.PARAMS, agent="cursor")
        assert "CURSOR_API_KEY" in result
        assert "~/.pocketeng/cursor_key" in result

    def test_includes_github_token(self):
        result = build_launch_cmd(**self.PARAMS)
        assert "GH_TOKEN" in result

    def test_with_callback_includes_exports_and_tail(self):
        cb_exports = (
            "echo 'export PE_CALLBACK_URL=https://api.example.com' >> /tmp/pe-run-abc123.sh; "
            "echo 'export PE_CALLBACK_SECRET=secret' >> /tmp/pe-run-abc123.sh; "
        )
        cb_tail = "echo 'EXIT_CODE=$?' >> /tmp/pe-run-abc123.sh; "

        result = build_launch_cmd(**self.PARAMS, callback_exports=cb_exports, callback_tail=cb_tail)
        assert "PE_CALLBACK_URL" in result
        assert "PE_CALLBACK_SECRET" in result
        assert "EXIT_CODE=$?" in result

    def test_workdir_with_spaces(self):
        params = {**self.PARAMS, "workdir": "/home/user/my project"}
        result = build_launch_cmd(**params)
        assert shlex.quote("/home/user/my project") in result

    def test_contains_shebang(self):
        result = build_launch_cmd(**self.PARAMS)
        assert "#!/bin/bash" in result

    def test_contains_path_export(self):
        result = build_launch_cmd(**self.PARAMS)
        assert "/opt/homebrew/bin" in result

    def test_backgrounds_process(self):
        result = build_launch_cmd(**self.PARAMS)
        assert "</dev/null >/dev/null 2>/dev/null &" in result

    def test_captures_pid(self):
        result = build_launch_cmd(**self.PARAMS)
        assert "echo $BGPID" in result
        assert f"echo $BGPID > {self.PARAMS['pid_file']}" in result


class TestBuildLaunchCmdImages:
    """Verify that image manifest plumbing is wired correctly."""

    PARAMS = {
        "workdir": "~/projects/myapp",
        "prompt_b64": "aGVsbG8gd29ybGQ=",
        "prompt_file": "/tmp/pe-prompt-abc.txt",
        "script_file": "/tmp/pe-run-abc.sh",
        "agent_cmd": "node ~/.pocketeng/bridge/bridge.mjs --agent claude",
        "out_file": "/tmp/pe-out-sess1.jsonl",
        "pid_file": "/tmp/pe-pid-sess1",
        "agent": "claude",
    }

    def test_no_images_no_pe_images_file(self):
        """Without images_b64/images_file the manifest setup block is absent."""
        result = build_launch_cmd(**self.PARAMS)
        assert "PE_IMAGES_FILE" not in result
        assert "pe-images-" not in result

    def test_images_writes_manifest_and_exports_env(self):
        """With images_b64 + images_file, the manifest is decoded onto EC2 and
        PE_IMAGES_FILE is exported into the run script."""
        import base64
        import json

        manifest = [{"path": "/tmp/pe-uploads/paste-123.png", "mediaType": "image/png"}]
        images_b64 = base64.b64encode(json.dumps(manifest).encode()).decode()
        images_file = "/tmp/pe-images-turn123.json"

        result = build_launch_cmd(
            **self.PARAMS,
            images_b64=images_b64,
            images_file=images_file,
        )

        assert "PE_IMAGES_FILE" in result
        assert images_file in result
        assert images_b64 in result
        assert "base64 -d" in result

    def test_images_b64_only_is_noop(self):
        """images_b64 without images_file: no manifest setup emitted."""
        result = build_launch_cmd(**self.PARAMS, images_b64="someb64==")
        assert "PE_IMAGES_FILE" not in result

    def test_images_file_only_is_noop(self):
        """images_file without images_b64: no manifest setup emitted."""
        result = build_launch_cmd(**self.PARAMS, images_file="/tmp/pe-images-x.json")
        assert "PE_IMAGES_FILE" not in result

    def test_images_appear_before_agent_command(self):
        """The manifest file must exist on EC2 before the run script is called —
        i.e. the images_setup block must precede the agent command in the script."""
        import base64
        import json

        manifest = [{"path": "/tmp/pe-uploads/shot.png", "mediaType": "image/png"}]
        images_b64 = base64.b64encode(json.dumps(manifest).encode()).decode()
        images_file = "/tmp/pe-images-turnXYZ.json"

        result = build_launch_cmd(
            **self.PARAMS,
            images_b64=images_b64,
            images_file=images_file,
        )

        images_pos = result.index("PE_IMAGES_FILE")
        agent_pos = result.index("bridge.mjs")
        assert images_pos < agent_pos, (
            "PE_IMAGES_FILE export must appear before the agent command in the script"
        )

    def test_images_path_with_special_chars_is_quoted(self):
        """Paths containing spaces or special characters must be shell-quoted."""
        import base64
        import json

        manifest = [{"path": "/tmp/pe-uploads/screen shot.png", "mediaType": "image/png"}]
        images_b64 = base64.b64encode(json.dumps(manifest).encode()).decode()
        images_file = "/tmp/pe-images with spaces/turn.json"

        result = build_launch_cmd(
            **self.PARAMS,
            images_b64=images_b64,
            images_file=images_file,
        )

        assert shlex.quote(images_file) in result

    def test_existing_fields_unaffected_when_images_present(self):
        """Adding images must not break existing callback or ingest exports."""
        import base64
        import json

        manifest = [{"path": "/tmp/pe-uploads/img.png", "mediaType": "image/png"}]
        images_b64 = base64.b64encode(json.dumps(manifest).encode()).decode()
        images_file = "/tmp/pe-images-t.json"

        cb_exports = "echo 'export PE_CALLBACK_URL=https://api.x' >> /tmp/pe-run-abc.sh; "
        ingest = "echo 'export PE_INGEST_URL=https://api.x/events' >> /tmp/pe-run-abc.sh; "

        result = build_launch_cmd(
            **self.PARAMS,
            callback_exports=cb_exports,
            ingest_exports=ingest,
            images_b64=images_b64,
            images_file=images_file,
        )

        assert "PE_CALLBACK_URL" in result
        assert "PE_INGEST_URL" in result
        assert "PE_IMAGES_FILE" in result


class TestBuildIngestExports:
    def test_empty_when_url_missing(self):
        assert build_ingest_exports("", "secret", "sess-1", "turn-1", "/tmp/script.sh") == ""

    def test_empty_when_secret_missing(self):
        assert build_ingest_exports("https://api.x/ingest", "", "sess-1", "turn-1", "/tmp/script.sh") == ""

    def test_exports_all_vars_when_configured(self):
        result = build_ingest_exports(
            "https://api.x/internal/sessions/s1/events",
            "secret-value",
            "sess-1",
            "turn-abc",
            "/tmp/script.sh",
        )
        assert "export PE_INGEST_URL=" in result
        assert "export PE_INGEST_SECRET=" in result
        assert "export PE_SESSION_ID=" in result
        assert "export PE_TURN_ID=" in result
        assert "/tmp/script.sh" in result
        assert "turn-abc" in result
        assert "sess-1" in result
        assert "secret-value" in result

    def test_launch_cmd_includes_ingest_exports(self):
        ingest = build_ingest_exports(
            "https://api/events", "s3cret", "sess-9", "turn-9", "/tmp/run.sh",
        )
        cmd = build_launch_cmd(
            workdir="/tmp/work",
            prompt_b64="cHJvbXB0",
            prompt_file="/tmp/p",
            script_file="/tmp/run.sh",
            agent_cmd="pe-bridge --agent codex",
            out_file="/tmp/out",
            pid_file="/tmp/pid",
            ingest_exports=ingest,
            agent="codex",
        )
        assert "PE_INGEST_URL" in cmd
        assert "turn-9" in cmd
