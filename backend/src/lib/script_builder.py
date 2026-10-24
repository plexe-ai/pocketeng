"""Pure functions for building shell commands sent to EC2 via SSH.

Every function here is side-effect-free: strings in, strings out.
This makes them straightforward to test without SSH or DynamoDB.
"""

import shlex

from src.lib.agents import get_agent_config


def build_agent_command(agent, model=None, can_resume=False, remote_session_id=None):
    """Build the CLI invocation string for the given agent.

    Returns the full command string. For bridge-wrapped agents (claude,
    command invokes node on the bridge instead of the agent's
    CLI directly; bridge-specific flags carry the agent's session info.
    """
    cfg = get_agent_config(agent)
    cmd = cfg["command"]

    if model and cfg.get("supports_model_flag"):
        flag = f" --model {shlex.quote(model)}"
        if cmd.endswith(" -"):
            cmd = cmd[:-2] + flag + " -"
        else:
            cmd += flag

    if agent == "claude" and remote_session_id:
        # Bridge forwards these to the SDK's `resume` / `sessionId` options
        # respectively, without shadowing PE's own --session-id.
        if can_resume:
            cmd += f" --claude-resume {shlex.quote(remote_session_id)}"
        else:
            cmd += f" --claude-new-session-id {shlex.quote(remote_session_id)}"

    if agent == "cursor" and remote_session_id and can_resume:
        # Bridge forwards this to the `agent` CLI as --resume. Distinct flag
        # name so it doesn't collide with PE's own --session-id / --resume.
        cmd += f" --cursor-resume {shlex.quote(remote_session_id)}"

    if agent == "codex" and remote_session_id and can_resume:
        # Bridge forwards this to `codex.resumeThread(id, opts)`. The Codex
        # SDK's `startThread` always mints a new thread id (ignoring any id
        # we try to supply), so without --codex-resume every UI-driven turn
        # on an existing session spawns a brand-new rollout .jsonl. With it,
        # turns append to the same file and Codex sees native multi-turn
        # memory instead of our synthetic "You are continuing…" history block.
        cmd += f" --codex-resume {shlex.quote(remote_session_id)}"

    if agent == "opencode" and remote_session_id and can_resume:
        # OpenCode owns its session ids. Reuse the existing remote session
        # when we have one so follow-up turns stay in the same conversation.
        cmd += f" --opencode-resume {shlex.quote(remote_session_id)}"

    return cmd


def build_callback_exports(callback_url, callback_secret, server_id, session_id, pid_file, script_file):
    """Return the shell snippet that writes callback env vars into the run script."""
    if not callback_url or not callback_secret:
        return ""
    return (
        f"echo 'export PE_CALLBACK_URL={shlex.quote(callback_url)}' >> {script_file}; "
        f"echo 'export PE_CALLBACK_SECRET={shlex.quote(callback_secret)}' >> {script_file}; "
        f"echo 'export PE_SERVER_ID={shlex.quote(server_id)}' >> {script_file}; "
        f"echo 'export PE_SESSION_ID={shlex.quote(session_id)}' >> {script_file}; "
        f"echo 'export PE_PID_FILE={shlex.quote(pid_file)}' >> {script_file}; "
    )


def build_callback_tail(callback_url, callback_secret, script_file):
    """Return the shell snippet that curls the completion callback on exit."""
    if not callback_url or not callback_secret:
        return ""
    return (
        f"echo 'EXIT_CODE=$?' >> {script_file}; "
        f"echo 'PE_PID=$(cat \"$PE_PID_FILE\" 2>/dev/null || echo \"\")' >> {script_file}; "
        f"echo 'if [ -n \"$PE_CALLBACK_URL\" ] && [ -n \"$PE_CALLBACK_SECRET\" ]; then "
        f"curl -sS -X POST \"$PE_CALLBACK_URL\" "
        f"-H \"Content-Type: application/json\" "
        f"-H \"X-PocketEngineer-Completion-Secret: $PE_CALLBACK_SECRET\" "
        f"-d \"{{\\\"serverId\\\":\\\"$PE_SERVER_ID\\\",\\\"sessionId\\\":\\\"$PE_SESSION_ID\\\",\\\"pid\\\":\\\"$PE_PID\\\",\\\"exitCode\\\":$EXIT_CODE}}\" "
        f">/dev/null 2>/dev/null || true; fi' >> {script_file}; "
    )


_DIRECT_CLI_COMMANDS = {
    # What each agent's native CLI invocation looks like when we bypass the
    # bridge. Used for BYOS servers that may not have Node.js installed.
    # Claude + Codex otherwise run through the bridge (see build_agent_command).
    "claude": "claude --print --verbose --output-format stream-json --dangerously-skip-permissions",
    "codex": "codex exec --json --dangerously-bypass-approvals-and-sandbox -",
    "cursor": "agent -p --force --output-format stream-json --sandbox disabled",
}


def build_direct_cli_command(agent, model=None, can_resume=False, remote_session_id=None):
    """Build the native CLI invocation for an agent, bypassing the bridge.

    Used for environments where the bridge can't run (BYOS servers without
    Node.js). The client's events-path falls back to a transcript reload
    after ~5s of no events, so the UX still works — just non-streaming.
    """
    from src.lib.agents import get_agent_config

    cfg = get_agent_config(agent)
    cmd = _DIRECT_CLI_COMMANDS.get(agent, _DIRECT_CLI_COMMANDS["claude"])

    if model and cfg.get("supports_model_flag"):
        flag = f" --model {shlex.quote(model)}"
        if cmd.endswith(" -"):
            cmd = cmd[:-2] + flag + " -"
        else:
            cmd += flag

    if agent == "claude" and remote_session_id:
        if can_resume:
            cmd += f" --resume {shlex.quote(remote_session_id)}"
        else:
            cmd += f" --session-id {shlex.quote(remote_session_id)}"

    if agent == "cursor" and remote_session_id and can_resume:
        cmd += f" --resume {shlex.quote(remote_session_id)}"

    # Note: Codex resume is intentionally NOT forwarded on the direct-CLI
    # path. build_direct_cli_command is only exercised by BYOS servers
    # missing Node.js, but Codex itself is distributed as a Node SDK, so
    # a BYOS box that can't run our bridge also can't run Codex — the
    # direct-CLI path is effectively unreachable for Codex today. Adding
    # untested `codex exec resume` plumbing here would only be confusing.
    return cmd


def build_ingest_exports(ingest_url, ingest_secret, session_id, turn_id, script_file):
    """Return shell snippet that exports PE_INGEST_* env vars for the agent-bridge
    uploader. No-op when ingest isn't configured (the bridge treats absent env
    as "don't push events")."""
    if not ingest_url or not ingest_secret:
        return ""
    return (
        f"echo 'export PE_INGEST_URL={shlex.quote(ingest_url)}' >> {script_file}; "
        f"echo 'export PE_INGEST_SECRET={shlex.quote(ingest_secret)}' >> {script_file}; "
        f"echo 'export PE_SESSION_ID={shlex.quote(session_id)}' >> {script_file}; "
        f"echo 'export PE_TURN_ID={shlex.quote(turn_id)}' >> {script_file}; "
    )


def build_api_key_exports(agent, script_file):
    """Return shell snippet(s) that load the agent's API key + GitHub token
    into the run script.

    Subscription-auth coexistence: if an OAuth bundle is present at the CLI's
    canonical cred path (~/.claude/.credentials.json / ~/.codex/auth.json),
    we must NOT export ANTHROPIC_API_KEY / OPENAI_API_KEY — the env var
    takes precedence over OAuth and would silently downgrade a Max user to
    pay-per-token API billing. The guard below only exports the env var if
    the OAuth file is absent."""
    cfg = get_agent_config(agent)
    env_var = cfg.get("api_key_env")
    key_file = cfg.get("api_key_file")
    # Only agents with a potential OAuth bundle on disk go in here. Cursor's
    # API key bills from the user's subscription (no OAuth path on the cloud
    # side at all) so the env-var export is always correct for Cursor — no
    # guard needed. See agent_credentials_sync.py._OAUTH_PATH for the matching
    # write-side list.
    oauth_guard = {
        "claude": "~/.claude/.credentials.json",
        "codex":  "~/.codex/auth.json",
    }.get(agent)
    if not env_var or not key_file:
        lines = (
            f"echo '[ -f ~/.pocketeng/github_token ] && export GH_TOKEN=$(cat ~/.pocketeng/github_token)' >> {script_file}; "
        )
    elif oauth_guard:
        # Only fall back to env var if the subscription/OAuth artifact is
        # missing. Keeps subscription users on their Max plan and API-key
        # users on ANTHROPIC_API_KEY. Tested paths both remain valid.
        lines = (
            f"echo '[ ! -e {oauth_guard} ] && [ -f {key_file} ] && "
            f"export {env_var}=$(cat {key_file})' >> {script_file}; "
            f"echo '[ -f ~/.pocketeng/github_token ] && export GH_TOKEN=$(cat ~/.pocketeng/github_token)' >> {script_file}; "
        )
    else:
        lines = (
            f"echo '[ -f {key_file} ] && export {env_var}=$(cat {key_file})' >> {script_file}; "
            f"echo '[ -f ~/.pocketeng/github_token ] && export GH_TOKEN=$(cat ~/.pocketeng/github_token)' >> {script_file}; "
        )
    if agent == "codex":
        # Same guard here: only synthesize an api-key auth.json if no OAuth
        # auth.json was SFTP'd by our credential sync.
        lines += (
            f"echo 'if [ ! -e ~/.codex/auth.json ] && [ -f {key_file} ]; then "
            f"mkdir -p ~/.codex && printf '\\''{{\"auth_mode\":\"apikey\",\"OPENAI_API_KEY\":\"%s\"}}\\n'\\'' "
            f"\"$(cat {key_file})\" > ~/.codex/auth.json; fi' >> {script_file}; "
        )
    return lines


def build_launch_cmd(
    workdir,
    prompt_b64,
    prompt_file,
    script_file,
    agent_cmd,
    out_file,
    pid_file,
    callback_exports="",
    callback_tail="",
    ingest_exports="",
    agent="claude",
    images_b64=None,
    images_file=None,
):
    """Build the full shell command that _launch_turn() sends over SSH.

    This is the outermost command: it writes the prompt to a temp file,
    assembles a run script, backgrounds it, and echoes the PID.

    When images_b64 and images_file are provided, the manifest JSON is decoded
    onto the EC2 and PE_IMAGES_FILE is exported into the run script so the
    bridge can load image data and pass it as native multimodal content blocks.
    """
    api_key_snippet = build_api_key_exports(agent, script_file)

    # Write the images manifest to EC2 before the run script executes so
    # PE_IMAGES_FILE is available to the bridge at startup.  The manifest is
    # a JSON array of {path, mediaType} objects already written to EC2 via
    # SFTP (the upload endpoint).  We pass it as base64 to avoid shell quoting
    # issues with the raw JSON.
    images_setup = ""
    if images_b64 and images_file:
        images_setup = (
            f"echo {shlex.quote(images_b64)} | base64 -d > {shlex.quote(images_file)}; "
            f"echo 'export PE_IMAGES_FILE={shlex.quote(images_file)}' >> {script_file}; "
        )

    return (
        f"cd {shlex.quote(workdir)} 2>/dev/null || cd ~/projects; "
        f"echo {shlex.quote(prompt_b64)} | base64 -d > {prompt_file}; "
        f"echo '#!/bin/bash' > {script_file}; "
        f"echo 'export PATH=/opt/homebrew/bin:$PATH' >> {script_file}; "
        f"{api_key_snippet}"
        # Source user's custom env vars written by PE to shell profiles (after NVM/PATH setup).
        # Also source nvm directly: non-interactive bash exits ~/.bashrc early
        # (`[ -z "$PS1" ] && return`) so nvm never initializes via that path.
        # On BYOS Ubuntu/Debian boxes nvm is almost always how Node is installed,
        # so without this `node` is "command not found" and the bridge can't start.
        f"echo 'export NVM_DIR=\"$HOME/.nvm\"' >> {script_file}; "
        f"echo '[ -s \"$NVM_DIR/nvm.sh\" ] && \\. \"$NVM_DIR/nvm.sh\"' >> {script_file}; "
        f"echo 'source ~/.bashrc 2>/dev/null || true' >> {script_file}; "
        f"echo 'source ~/.zprofile 2>/dev/null || true' >> {script_file}; "
        f"{callback_exports}"
        f"{ingest_exports}"
        f"{images_setup}"
        f"echo 'cd {shlex.quote(workdir)} 2>/dev/null || cd ~/projects' >> {script_file}; "
        f"echo 'LBUF=\"\"; command -v stdbuf >/dev/null 2>&1 && LBUF=\"stdbuf -oL\"' >> {script_file}; "
        f"echo 'cat {prompt_file} | $LBUF {agent_cmd} > {out_file} 2>{out_file}.err' >> {script_file}; "
        f"{callback_tail}"
        f"chmod +x {script_file}; "
        f": > {out_file}; "
        f"{script_file} </dev/null >/dev/null 2>/dev/null & "
        f"BGPID=$!; "
        f"echo $BGPID > {pid_file}; "
        f"echo $BGPID"
    )
