"""Tests for userdata script generation — pure string functions, no mocks.

These tests call the real build_userdata() and assert on the generated
bash scripts. The macOS (mac2.metal / Dedicated Host) userdata path was
dropped in v1 along with `envType: "ios"`; its tests were removed when
the source was. OpenCode is back in the managed-workspace agent catalog,
so the install/runtime assertions cover it alongside Claude/Codex/Cursor.
See root CLAUDE.md ("EC2 conventions").
"""


class TestBuildUserdata:
    """Linux userdata generation."""

    def _build(self, **kwargs):
        from src.lib.userdata import build_userdata
        defaults = {"anthropic_key": "sk-ant-test-key"}
        defaults.update(kwargs)
        return build_userdata(**defaults)

    def test_default_agent_is_claude(self):
        script = self._build()
        assert "Installing Claude Code" in script
        assert "@anthropic-ai/claude-code" in script

    def test_anthropic_key_in_bashrc(self):
        script = self._build()
        assert "export ANTHROPIC_API_KEY=sk-ant-test-key" in script

    def test_bridge_sdks_always_installed(self):
        # The bridge resolves Claude + Codex + OpenCode SDKs from the global npm root.
        # They're installed unconditionally because any agent can switch
        # mid-workspace after provision (subscription login flow).
        script = self._build(agents=["claude"])
        assert "@anthropic-ai/claude-agent-sdk" in script
        assert "@openai/codex-sdk" in script
        assert "@opencode-ai/sdk" in script

    def test_bridge_sdks_installed_for_codex_only(self):
        script = self._build(agents=["codex"])
        assert "@anthropic-ai/claude-agent-sdk" in script

    def test_mixed_claude_codex_installs_bridge_sdks(self):
        script = self._build(agents=["claude", "codex"])
        assert "@anthropic-ai/claude-agent-sdk" in script
        assert "Installing Claude Code" in script
        assert "Installing Codex" in script

    def test_installs_multiple_agents(self):
        script = self._build(agents=["claude", "codex", "opencode"])
        assert "@anthropic-ai/claude-code" in script
        assert "@openai/codex" in script
        assert "opencode-ai" in script

    def test_installs_opencode(self):
        script = self._build(agents=["opencode"])
        assert "Installing OpenCode" in script
        assert "opencode-ai" in script

    def test_cursor_install_uses_curl(self):
        script = self._build(agents=["cursor"])
        assert "Installing Cursor" in script
        assert "curl" in script
        assert "cursor.com/install" in script

    def test_cursor_not_installed_via_npm(self):
        # The Cursor CLI agent (`cursor-agent`) must come from the curl
        # installer at cursor.com/install, never from npm. The bridge's
        # `@cursor/sdk` npm dep is unrelated — it's the Node SDK used for
        # multimodal input in bridge.mjs — so allow it explicitly.
        import re
        script = self._build(agents=["cursor"])
        for line in re.findall(r"npm install -g[^\n]*", script):
            cleaned = line.replace("@cursor/sdk", "")
            assert "cursor" not in cleaned, f"Cursor CLI installed via npm: {line}"

    def test_cursor_key_in_bashrc(self):
        script = self._build(agents=["cursor"], cursor_key="crsr_test_key")
        assert "export CURSOR_API_KEY=crsr_test_key" in script
        assert "cursor_key" in script

    def test_mixed_with_cursor(self):
        script = self._build(agents=["claude", "cursor"])
        assert "Installing Claude Code" in script
        assert "Installing Cursor" in script
        assert "curl" in script and "cursor.com/install" in script

    def test_verifies_agent_binaries(self):
        script = self._build(agents=["claude", "codex", "opencode"])
        assert 'echo "claude:' in script
        assert 'echo "codex:' in script
        assert 'echo "opencode:' in script

    def test_cursor_binary_verified_as_agent(self):
        script = self._build(agents=["cursor"])
        assert 'echo "cursor:' in script
        assert 'which agent' in script

    def test_setup_complete_marker(self):
        script = self._build()
        assert ".pocketeng-ready" in script

    def test_skills_included(self):
        script = self._build(skills=["testing"])
        assert "AGENTS.md" in script
        assert "Write tests alongside code" in script

    def test_git_config_when_username_provided(self):
        script = self._build(github_username="testuser", github_token="ghp_test")
        assert "testuser" in script
        assert "git config --global user.name" in script

    def test_repos_cloned(self):
        script = self._build(repos=["owner/repo"], github_token="ghp_test", github_username="user")
        assert "git clone https://github.com/owner/repo.git" in script

    def test_claude_md_written(self):
        script = self._build()
        assert "CLAUDE.md" in script
        assert "worktree" in script.lower() or "Workflow" in script

    def test_pe_relay_removed(self):
        # Phase 3 cleanup: the old pe-relay WebSocket path is gone. Events flow
        # via the backend-shipped bridge + /sessions/{id}/events read endpoint.
        script = self._build()
        assert "pe-relay" not in script
        assert "pe-relay.py" not in script

    def test_gh_wrapper_installed(self):
        script = self._build()
        assert "Installing PocketEng gh wrapper" in script
        assert "/usr/local/bin/gh" in script
        assert "Built on my iPhone using [pocketeng](https://pocketeng.ai)" in script

    def test_gh_wrapper_guarded_by_real_binary_existence(self):
        # If `dnf install -y gh` fails the script keeps going (|| echo WARN);
        # without this guard the shim would shadow whatever working gh ends
        # up on PATH, with REAL_GH pointing at a non-existent path. Wrap the
        # install in `if [ -x /usr/bin/gh ]; then ... fi` so a missing real
        # binary skips the shim entirely.
        script = self._build()
        assert "if [ -x /usr/bin/gh ]; then" in script
        assert "Skipping PocketEng gh wrapper (no /usr/bin/gh)" in script


class TestGhWrapperBehavior:
    """End-to-end tests of the shim itself.

    Extracts the bash from `_gh_wrapper_block()`, points it at a fake `gh`
    so we can assert on the args it forwards, and exercises the body-flag
    permutations. This is the contract that PocketEng users actually rely
    on — covers Claude/Codex/OpenCode/Cursor since they all shell out to
    `gh pr create` and the shim is agent-agnostic.
    """

    ATTR = "Built on my iPhone using [pocketeng](https://pocketeng.ai)"

    def _shim(self, tmp_path):
        import os
        from src.lib.userdata import _gh_wrapper_block
        out = _gh_wrapper_block()
        start = out.index("<< 'GHWRAPEOF'") + len("<< 'GHWRAPEOF'")
        end = out.index("GHWRAPEOF", start)
        body = out[start:end].lstrip("\n")
        fake_gh = tmp_path / "fake-gh"
        fake_gh.write_text(
            "#!/bin/bash\n"
            'for a in "$@"; do printf "%s\\0" "$a"; done\n'
        )
        fake_gh.chmod(0o755)
        shim = tmp_path / "shim"
        shim.write_text(body.replace("/usr/bin/gh", str(fake_gh)))
        shim.chmod(0o755)
        return str(shim)

    def _run(self, shim, *args, stdin=None):
        import subprocess
        r = subprocess.run(
            ["bash", shim, *args],
            input=stdin, capture_output=True, text=True, timeout=10,
        )
        assert r.returncode == 0, r.stderr
        # Args are NUL-delimited so we can round-trip newlines safely.
        return [a for a in r.stdout.split("\0") if a]

    def test_appends_attribution_to_body_flag(self, tmp_path):
        shim = self._shim(tmp_path)
        args = self._run(shim, "pr", "create", "--title", "X", "--body", "Summary")
        assert args[-2] == "--body"
        assert args[-1] == f"Summary\n\n{self.ATTR}"

    def test_appends_attribution_to_short_body_flag(self, tmp_path):
        shim = self._shim(tmp_path)
        args = self._run(shim, "pr", "create", "-b", "Summary")
        assert args[-2] == "--body"
        assert args[-1] == f"Summary\n\n{self.ATTR}"

    def test_appends_attribution_to_equals_body_flag(self, tmp_path):
        shim = self._shim(tmp_path)
        args = self._run(shim, "pr", "create", "--body=Summary")
        assert "--body" in args
        assert f"Summary\n\n{self.ATTR}" in args

    def test_reads_body_file_and_appends(self, tmp_path):
        body_file = tmp_path / "body.md"
        body_file.write_text("## Why\nthis change")
        shim = self._shim(tmp_path)
        args = self._run(shim, "pr", "create", "-F", str(body_file))
        assert args == ["pr", "create", "--body", f"## Why\nthis change\n\n{self.ATTR}"]

    def test_idempotent_when_attribution_present(self, tmp_path):
        shim = self._shim(tmp_path)
        body = f"Summary\n\n{self.ATTR}"
        args = self._run(shim, "pr", "create", "--body", body)
        assert args[-1] == body
        assert args[-1].count(self.ATTR) == 1

    def test_pr_ready_passes_through(self, tmp_path):
        shim = self._shim(tmp_path)
        args = self._run(shim, "pr", "ready", "123")
        assert args == ["pr", "ready", "123"]
        assert self.ATTR not in "".join(args)

    def test_auth_login_passes_through(self, tmp_path):
        shim = self._shim(tmp_path)
        args = self._run(shim, "auth", "login")
        assert args == ["auth", "login"]

    def test_pr_create_without_body_flag_passes_through(self, tmp_path):
        # No body flag → don't force one; let gh open its editor or use
        # commit messages. We only attribute when the agent is providing
        # an explicit body.
        shim = self._shim(tmp_path)
        args = self._run(shim, "pr", "create", "--title", "X")
        assert args == ["pr", "create", "--title", "X"]
        assert self.ATTR not in "".join(args)


# TestBuildMacosUserdata removed — the macOS-on-mac2.metal workspace
# type was dropped in v1. See root CLAUDE.md "EC2 conventions" for the
# list of macOS-specific concerns to re-handle if it ever comes back.
