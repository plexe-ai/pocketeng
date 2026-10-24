"""Centralized agent configuration.

Single source of truth for all agent-specific metadata. Every component
that needs agent info should import from here instead of maintaining its
own dict.
"""

AGENTS = {
    "claude": {
        # Bridge invokes the Claude Agent SDK directly; no subprocess.
        "command": "node ~/.pocketeng/bridge/bridge.mjs --agent claude",
        # Install both the CLI (users still want `claude` on PATH for
        # interactive use) and the SDK (what the bridge imports).
        "install_command": "npm install -g @anthropic-ai/claude-code @anthropic-ai/claude-agent-sdk",
        "package": "@anthropic-ai/claude-code",
        "label": "Claude Code",
        "api_key_env": "ANTHROPIC_API_KEY",
        "api_key_file": "~/.pocketeng/anthropic_key",
        "supports_model_flag": True,
        "needs_bridge": True,
    },
    "codex": {
        # Bridge invokes @openai/codex-sdk with approvalPolicy='never' +
        # sandboxMode='danger-full-access' to match the CLI's
        # --dangerously-bypass-approvals-and-sandbox behavior. Verified by
        # tests/agents/test_integration.py::TestCodexViaBridge*.
        "command": "node ~/.pocketeng/bridge/bridge.mjs --agent codex",
        "install_command": "npm install -g @openai/codex @openai/codex-sdk",
        "package": "@openai/codex",
        "label": "Codex",
        "api_key_env": "OPENAI_API_KEY",
        "api_key_file": "~/.pocketeng/openai_key",
        "supports_model_flag": True,
        "needs_bridge": True,
    },
    "cursor": {
        # Bridge spawns `agent` as a subprocess (Cursor has no SDK). Its
        # stream-json output is Claude-compatible so we reuse the Claude
        # event mapper.
        "command": "node ~/.pocketeng/bridge/bridge.mjs --agent cursor",
        "install_command": "curl -fsSL https://cursor.com/install | bash",
        "package": None,
        "label": "Cursor",
        "api_key_env": "CURSOR_API_KEY",
        "api_key_file": "~/.pocketeng/cursor_key",
        "supports_model_flag": True,
        "needs_bridge": True,
    },
    "opencode": {
        # Bridge invokes the OpenCode SDK directly. Auth comes from the
        # workspace environment (v1: ANTHROPIC_API_KEY / OPENAI_API_KEY in
        # env vars), not from a single provider-specific key file.
        "command": "node ~/.pocketeng/bridge/bridge.mjs --agent opencode",
        "install_command": "npm install -g opencode-ai @opencode-ai/sdk",
        "package": "opencode-ai",
        "label": "OpenCode",
        "api_key_env": None,
        "api_key_file": None,
        # OpenCode models are provider-scoped objects, not the simple
        # `--model <string>` pattern the other agents share. Keep this off
        # until we add explicit provider/model mapping.
        "supports_model_flag": False,
        "needs_bridge": True,
    },
}

DEFAULT_AGENT = "claude"

VALID_AGENT_IDS = frozenset(AGENTS.keys())


def get_agent_config(agent_id):
    """Return the config dict for *agent_id*, falling back to the default agent."""
    return AGENTS.get(agent_id, AGENTS[DEFAULT_AGENT])


def get_agent_command(agent_id):
    return get_agent_config(agent_id)["command"]


def get_agent_install_command(agent_id):
    return get_agent_config(agent_id)["install_command"]


def get_agent_package(agent_id):
    """Return the npm package for *agent_id*, or None if unknown."""
    cfg = AGENTS.get(agent_id)
    return cfg["package"] if cfg else None


def get_agent_label(agent_id):
    return get_agent_config(agent_id)["label"]


def needs_bridge(agents):
    """Return True if any agent in the list requires the backend-shipped bridge
    at ~/.pocketeng/bridge/. Drives both userdata SDK installs and the
    session-launch SFTP deploy."""
    return any(AGENTS.get(a, {}).get("needs_bridge", False) for a in agents)
