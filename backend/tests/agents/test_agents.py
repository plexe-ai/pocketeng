"""Tests for the centralized agent configuration."""
import pytest

from src.lib.agents import (
    AGENTS,
    DEFAULT_AGENT,
    VALID_AGENT_IDS,
    get_agent_config,
    get_agent_command,
    get_agent_install_command,
    get_agent_label,
    get_agent_package,
    needs_bridge,
)

REQUIRED_FIELDS = {
    "command",
    "install_command",
    "package",
    "label",
    "api_key_env",
    "api_key_file",
    "supports_model_flag",
    "needs_bridge",
}


class TestAgentConfigCompleteness:
    """Every agent entry must have all required fields."""

    @pytest.fixture(params=sorted(AGENTS.keys()))
    def agent_id(self, request):
        return request.param

    def test_has_all_required_fields(self, agent_id):
        cfg = AGENTS[agent_id]
        missing = REQUIRED_FIELDS - set(cfg.keys())
        assert not missing, f"Agent '{agent_id}' is missing fields: {missing}"

    def test_command_is_nonempty(self, agent_id):
        assert len(AGENTS[agent_id]["command"]) > 0

    def test_install_command_is_nonempty(self, agent_id):
        assert len(AGENTS[agent_id]["install_command"]) > 0

    def test_package_is_nonempty_or_none_for_non_npm(self, agent_id):
        pkg = AGENTS[agent_id]["package"]
        if pkg is not None:
            assert len(pkg) > 0

    def test_label_is_nonempty(self, agent_id):
        assert len(AGENTS[agent_id]["label"]) > 0

    def test_api_key_env_and_file_consistent(self, agent_id):
        """Either both fields are set (agent uses a dedicated provider key
        file, like Claude/Codex/Cursor) or both are None (agent uses
        workspace env vars directly, like OpenCode). Any other state leaves
        `build_api_key_exports` in `script_builder.py` half-configured."""
        env = AGENTS[agent_id]["api_key_env"]
        kf = AGENTS[agent_id]["api_key_file"]
        assert (env is None) == (kf is None), (
            f"Agent '{agent_id}' has inconsistent api_key_env/api_key_file: "
            f"api_key_env={env!r} api_key_file={kf!r}"
        )
        if env is not None:
            assert len(env) > 0
            assert len(kf) > 0


class TestAgentHelpers:
    def test_default_agent_exists(self):
        assert DEFAULT_AGENT in AGENTS

    def test_valid_agent_ids_matches_keys(self):
        assert VALID_AGENT_IDS == frozenset(AGENTS.keys())

    def test_get_agent_config_known(self):
        cfg = get_agent_config("claude")
        assert cfg["label"] == "Claude Code"

    def test_get_agent_config_unknown_falls_back(self):
        cfg = get_agent_config("nonexistent")
        assert cfg == AGENTS[DEFAULT_AGENT]

    def test_get_agent_command(self):
        cmd = get_agent_command("claude")
        assert "--agent claude" in cmd
        assert "bridge.mjs" in cmd

    def test_get_agent_install_command(self):
        cmd = get_agent_install_command("claude")
        assert "@anthropic-ai/claude-code" in cmd

    def test_get_agent_package(self):
        assert get_agent_package("codex") == "@openai/codex"

    def test_get_agent_label(self):
        assert get_agent_label("codex") == "Codex"


class TestNeedsBridge:
    def test_claude_needs_bridge(self):
        # Claude now runs through the bridge via the Claude Agent SDK so we
        # get structured session events for the phone UX.
        assert needs_bridge(["claude"]) is True

    def test_codex_needs_bridge(self):
        # Codex runs through the bridge via @openai/codex-sdk with
        # approvalPolicy='never' + sandboxMode='danger-full-access'.
        assert needs_bridge(["codex"]) is True

    def test_cursor_needs_bridge(self):
        # Cursor has no SDK but the bridge wraps its CLI as a subprocess and
        # reuses the Claude event mapper (output format is compatible).
        assert needs_bridge(["cursor"]) is True

    def test_mixed_needs_bridge(self):
        assert needs_bridge(["claude", "codex"]) is True

    def test_codex_and_cursor_both_need_bridge(self):
        assert needs_bridge(["codex", "cursor"]) is True

    def test_empty_does_not_need_bridge(self):
        assert needs_bridge([]) is False

    def test_unknown_agent_does_not_need_bridge(self):
        assert needs_bridge(["nonexistent"]) is False


class TestBackwardCompatibility:
    """Verify the new config matches the old hardcoded values exactly."""

    def test_claude_command_invokes_backend_shipped_bridge(self):
        # Claude now runs inside the bridge via @anthropic-ai/claude-agent-sdk,
        # not by spawning the `claude` CLI.
        assert AGENTS["claude"]["command"] == "node ~/.pocketeng/bridge/bridge.mjs --agent claude"

    def test_codex_command_invokes_backend_shipped_bridge(self):
        # Codex now runs inside the bridge via @openai/codex-sdk.
        assert AGENTS["codex"]["command"] == "node ~/.pocketeng/bridge/bridge.mjs --agent codex"

    def test_claude_install_includes_sdk_for_bridge(self):
        # Both CLI (keeps `claude` on PATH for interactive use) and SDK
        # (what the bridge imports) are installed.
        assert AGENTS["claude"]["install_command"] == (
            "npm install -g @anthropic-ai/claude-code @anthropic-ai/claude-agent-sdk"
        )

    def test_codex_install_includes_sdk_for_bridge(self):
        # Both CLI (keeps `codex` on PATH for interactive use) and SDK
        # (what the bridge imports).
        assert AGENTS["codex"]["install_command"] == "npm install -g @openai/codex @openai/codex-sdk"

    def test_claude_package_matches_old_AGENT_PACKAGES(self):
        assert AGENTS["claude"]["package"] == "@anthropic-ai/claude-code"

    def test_codex_package_matches_old_AGENT_PACKAGES(self):
        assert AGENTS["codex"]["package"] == "@openai/codex"

    def test_claude_label_matches_old_AGENT_LABELS(self):
        assert AGENTS["claude"]["label"] == "Claude Code"

    def test_codex_label_matches_old_AGENT_LABELS(self):
        assert AGENTS["codex"]["label"] == "Codex"

    def test_cursor_command_invokes_backend_shipped_bridge(self):
        assert AGENTS["cursor"]["command"] == "node ~/.pocketeng/bridge/bridge.mjs --agent cursor"

    def test_cursor_install_is_curl_based(self):
        assert "curl" in AGENTS["cursor"]["install_command"]
        assert "cursor.com/install" in AGENTS["cursor"]["install_command"]

    def test_cursor_package_is_none(self):
        assert AGENTS["cursor"]["package"] is None

    def test_cursor_api_key_env(self):
        assert AGENTS["cursor"]["api_key_env"] == "CURSOR_API_KEY"

    def test_cursor_api_key_file(self):
        assert AGENTS["cursor"]["api_key_file"] == "~/.pocketeng/cursor_key"

    def test_cursor_label(self):
        assert AGENTS["cursor"]["label"] == "Cursor"

    def test_cursor_supports_model_flag(self):
        assert AGENTS["cursor"]["supports_model_flag"] is True

    def test_cursor_uses_bridge_subprocess_wrap(self):
        assert AGENTS["cursor"]["needs_bridge"] is True

    def test_get_agent_package_returns_none_for_cursor(self):
        assert get_agent_package("cursor") is None
