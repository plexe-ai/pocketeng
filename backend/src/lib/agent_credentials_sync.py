"""
Push stored agent credential bundles to the EC2 host before launching an agent.

Two shapes travel through this module:

  (1) OAuth bundle — JSON the CLI itself writes after a completed subscription
      login. We SFTP the blob VERBATIM to the CLI's canonical credential file;
      the CLI reads it as if the user ran the native login on the EC2 and
      refreshes tokens in place via the embedded refresh_token. Three flavors:

        - Claude (anthropic-oauth.ts): `{"claudeAiOauth": {"accessToken": ...,
          "refreshToken": ..., "expiresAt": ..., "subscriptionType": "max"}}`
          → ~/.claude/.credentials.json

        - Codex  (openai-oauth.ts):    `{"OPENAI_API_KEY": null, "tokens":
          {"id_token": ..., "access_token": ..., "refresh_token": ...,
          "account_id": ...}, "last_refresh": ...}`
          → ~/.codex/auth.json

        - Cursor (cursor-oauth.ts):    `{"accessToken": "...",
          "refreshToken": "..."}` (both JWTs)
          → ~/.config/cursor/auth.json (Linux EC2 path; verified empirically
          by running `cursor-agent login` on a workspace and observing the
          file)

  (2) Bare API key — produced by the onboarding "paste an API key" path in
      agent_credentials.py via _wrap_raw_api_key. Shape is `{"apiKey":
      "sk-ant-..."}` for Claude, `{"OPENAI_API_KEY": "sk-..."}` for Codex,
      `{"CURSOR_API_KEY": "crsr_..."}` for Cursor. We extract the raw key and
      write it to ~/.pocketeng/<agent>_key. script_builder.py exports it as
      the right env var (ANTHROPIC_API_KEY / OPENAI_API_KEY / CURSOR_API_KEY)
      before running the agent. Verified on Claude Code 2.1 + codex-cli 0.121:
      env-var path produces `loggedIn: true`; writing `{"apiKey": ...}` to
      .credentials.json does NOT (the CLI only accepts the OAuth shape in
      that file).
"""
from __future__ import annotations  # `X | None` syntax under Python <3.10 unit tests
import json
from typing import Iterable

from src.lib.db import list_agent_credentials_for_user
from src.lib.kms import decrypt
from src.lib.ssh import ssh_exec

# Canonical on-host paths for each agent's OAuth bundle — the places the CLI
# itself would write them after a native login flow.
#
# Cursor's path is XDG-style on Linux (~/.config/cursor/auth.json) — verified
# empirically by running `cursor-agent login` on a workspace and observing
# where the file appeared. The CLI's source has a darwin branch that uses
# ~/.cursor/auth.json instead, but we only run on Linux EC2, so the XDG
# variant is the only one we need.
_OAUTH_PATH = {
    "claude": "~/.claude/.credentials.json",
    "codex":  "~/.codex/auth.json",
    "cursor": "~/.config/cursor/auth.json",
}

# Where script_builder expects to find a raw-string API key that it then
# exports as an env var before running the agent. Only used for the bare-key
# shape — OAuth bundles do NOT land here (env var would override OAuth).
_ENV_KEY_FILES = {
    "claude":   ("~/.pocketeng/anthropic_key", ["apiKey", "ANTHROPIC_API_KEY"]),
    "codex":    ("~/.pocketeng/openai_key",    ["OPENAI_API_KEY", "apiKey"]),
    "cursor":   ("~/.pocketeng/cursor_key",    ["CURSOR_API_KEY", "apiKey"]),
    # opencode reads from ~/.local/share/opencode/auth.json, NOT an env
    # var. The candidates list lets `_extract_api_key` walk a stored
    # `{"OPENCODE_API_KEY": "..."}` blob (the shape `_wrap_raw_api_key`
    # produces). The path tuple's first element is unused for opencode —
    # see _OPENCODE_AUTH_PATH below for the actual write target.
    "opencode": ("~/.pocketeng/opencode_key",  ["OPENCODE_API_KEY", "apiKey"]),
}

# OpenCode is multi-provider and stores all credentials in a single
# JSON file, keyed by provider name. We only manage the "opencode" slot
# (Zen) here — Anthropic / OpenAI / Cursor connected through opencode
# would clobber each other's keys, but that's not a path we expose.
_OPENCODE_AUTH_PATH = "~/.local/share/opencode/auth.json"


def _detect_shape(agent: str, blob: str) -> tuple[str, object]:
    """Classify the stored blob and return its parsed form.

    Returns one of:
      ("oauth-json", parsed_dict)   — bundle to SFTP verbatim
      ("bare-key",   api_key_str)   — needs env-var path
      ("unknown",    None)          — cannot sync; caller skips
    """
    try:
        parsed = json.loads(blob)
    except Exception:
        return "unknown", None
    if not isinstance(parsed, dict):
        return "unknown", None

    # Agent-specific OAuth markers. If any are present, treat as OAuth.
    if agent == "claude" and "claudeAiOauth" in parsed:
        return "oauth-json", parsed
    if agent == "codex" and isinstance(parsed.get("tokens"), dict):
        return "oauth-json", parsed
    # Cursor's bundle has both top-level accessToken AND refreshToken.
    # We require BOTH because the bare-key path also wraps a Cursor key
    # as `{"CURSOR_API_KEY": "crsr_..."}` — checking only one field
    # could mismatch a hand-pasted bundle that happens to use one of
    # these names. Both-or-nothing keeps the shapes disjoint.
    if (
        agent == "cursor"
        and isinstance(parsed.get("accessToken"), str)
        and isinstance(parsed.get("refreshToken"), str)
    ):
        return "oauth-json", parsed

    # Otherwise try to extract a bare key the env-var path can use.
    key = _extract_api_key(agent, parsed)
    if key:
        return "bare-key", key
    return "unknown", None


def _extract_api_key(agent: str, parsed: dict) -> str | None:
    cfg = _ENV_KEY_FILES.get(agent)
    if not cfg:
        return None
    _, candidates = cfg
    def walk(o, depth=0):
        if depth > 4 or not isinstance(o, dict):
            return None
        for name in candidates:
            v = o.get(name)
            if isinstance(v, str) and v.strip():
                return v.strip()
        for v in o.values():
            if isinstance(v, dict):
                f = walk(v, depth + 1)
                if f:
                    return f
        return None
    return walk(parsed)


def push_credentials_for_user(client, user_id, agents: Iterable[str] | None = None) -> dict:
    """For every agent with a stored credential, write it to the EC2 host in
    whichever shape the CLI expects. Returns a dict mapping agent → status
    string consumed by FinalizeFunction for readiness.agents[...]."""
    items = list_agent_credentials_for_user(user_id)
    if not items:
        return {}

    wanted = set(agents) if agents else None
    results: dict[str, str] = {}
    for item in items:
        agent = item.get("agent")
        if not agent:
            continue
        if wanted and agent not in wanted:
            continue

        encrypted = item.get("encryptedBlob")
        if not encrypted:
            results[agent] = "skipped:no-blob"
            continue
        try:
            blob = decrypt(encrypted)
        except Exception as e:
            results[agent] = f"error:decrypt:{e}"
            continue

        shape, data = _detect_shape(agent, blob)
        try:
            if shape == "oauth-json":
                path = _OAUTH_PATH.get(agent)
                if not path:
                    results[agent] = "skipped:no-oauth-path"
                    continue
                _write_remote_file(client, path, blob, mode="600")
                results[agent] = f"ok-oauth:{len(blob)}"
            elif shape == "bare-key":
                if agent == "opencode":
                    # OpenCode reads a multi-provider JSON file, not an
                    # env var. Wrap the bare key in the slot shape its
                    # CLI writes after `opencode auth login`. Verified
                    # by inspecting `~/.local/share/opencode/auth.json`
                    # on a workspace that ran the native login.
                    wrapped = json.dumps({
                        "opencode": {"type": "api", "key": data},
                    })
                    _write_remote_file(client, _OPENCODE_AUTH_PATH, wrapped, mode="600")
                    results[agent] = f"ok-key:{len(data) if isinstance(data, str) else 0}"
                else:
                    env_path, _ = _ENV_KEY_FILES[agent]
                    _write_remote_file(client, env_path, data, mode="600")  # type: ignore[arg-type]
                    results[agent] = f"ok-key:{len(data) if isinstance(data, str) else 0}"
            else:
                results[agent] = "error:unknown-shape"
        except Exception as e:
            results[agent] = f"error:write:{e}"
    return results


def _expand_tilde(path: str) -> str:
    """Turn '~/foo' into '$HOME/foo' for use in an unquoted remote-shell
    position. shlex.quote would wrap the string in single quotes and
    suppress tilde + variable expansion — historical bug, don't reintroduce."""
    return "$HOME/" + path[2:] if path.startswith("~/") else path


def _write_remote_file(client, remote_path: str, contents: str, mode: str = "600") -> None:
    """Write `contents` to `remote_path` via a heredoc with a randomized
    terminator (so embedded JSON content can never close the doc). The path
    is pasted unquoted because shlex.quote would kill $HOME expansion; our
    paths are compile-time constants so no injection risk."""
    import secrets
    p = _expand_tilde(remote_path)
    eot = "PE_EOT_" + secrets.token_hex(8)
    cmd = (
        f"mkdir -p $(dirname {p}) && "
        f"chmod 700 $(dirname {p}) && "
        f"cat > {p} << '{eot}'\n"
        f"{contents}\n"
        f"{eot}\n"
        f"chmod {mode} {p}"
    )
    _, stderr, rc = ssh_exec(client, cmd, timeout=10)
    if rc != 0:
        raise RuntimeError((stderr or "ssh write failed").strip())
