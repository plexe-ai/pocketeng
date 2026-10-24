"""Regression tests for chat.py's _install_agent action.

The bug these tests guard against: on BYOS Ubuntu servers, `which agent`
runs in a non-interactive SSH shell that doesn't have ~/.local/bin on
PATH, so the post-install verify step reported NOT_FOUND even though
the Cursor installer had successfully placed the binary there. The fix
prepends ~/.local/bin to PATH inline before the `which` call and also
persists the export to ~/.bashrc for future sessions, matching what
lib/userdata.py already does for managed instances.
"""
import json
import os
from contextlib import ExitStack
from unittest.mock import MagicMock, patch

os.environ.setdefault("SUPABASE_URL", "https://test.supabase.co")
os.environ.setdefault("SUPABASE_JWT_SECRET", "test-secret")
os.environ.setdefault("SERVERS_TABLE", "pe-servers-test")
os.environ.setdefault("SESSIONS_TABLE", "pe-sessions-test")
os.environ.setdefault("MESSAGES_TABLE", "pe-messages-test")
os.environ.setdefault("KMS_KEY_ID", "test-key-id")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")

FAKE_CLAIMS = {"sub": "user-123"}
FAKE_BYOS_SERVER = {
    "serverId": "srv-byos",
    "userId": "user-123",
    "instanceState": "running",
    "publicIp": "1.2.3.4",
    "sshPrivateKey": "encrypted-key",
    "envType": "byos",
    "sshUser": "ubuntu",
    "agents": ["claude"],
}


def _make_event(body):
    return {
        "headers": {"authorization": "Bearer fake-token"},
        "pathParameters": {"serverId": "srv-byos"},
        "body": json.dumps(body),
    }


def _run_install(agent, ssh_responses):
    """Invoke the chat handler for install-agent, capturing every ssh_exec call.

    `ssh_responses` is a callable: given a command string, returns
    `(stdout, stderr, exit_code)`. The default mock used here records the
    command order so tests can assert the verify command's shape.
    """
    calls = []

    def fake_ssh_exec(client, cmd, timeout=None):
        calls.append(cmd)
        return ssh_responses(cmd)

    patches = [
        ("src.chat.verify_token", {"return_value": FAKE_CLAIMS}),
        ("src.chat.get_server", {"return_value": FAKE_BYOS_SERVER}),
        ("src.chat.decrypt", {"return_value": "fake-key"}),
        ("src.chat.ssh_connect", {"return_value": MagicMock()}),
        ("src.chat.ssh_disconnect", {}),
        ("src.chat.ssh_exec", {"side_effect": fake_ssh_exec}),
        ("src.chat.update_server", {}),
    ]
    with ExitStack() as stack:
        for target, kwargs in patches:
            stack.enter_context(patch(target, **kwargs))
        from src.chat import handler
        result = handler(_make_event({"action": "install-agent", "agent": agent}), {})
    return result, calls


# ─── verify command shape ─────────────────────────────────────────────────────


class TestVerifyCommandHasLocalBinOnPath:
    """The post-install verify must include ~/.local/bin on PATH so it
    finds binaries dropped by curl-pipe installers (Cursor)."""

    def _responder(self, verify_finds_binary):
        def respond(cmd):
            if cmd.startswith("command -v npm"):
                return ("OK\n", "", 0)
            if "which " in cmd and "NOT_FOUND" in cmd:
                # Verify step. Whether or not we find the binary depends on
                # what the test asked for.
                if verify_finds_binary:
                    return ("/home/ubuntu/.local/bin/agent\n", "", 0)
                return ("NOT_FOUND\n", "", 0)
            return ("", "", 0)
        return respond

    def test_cursor_verify_prepends_local_bin_to_path(self):
        _, calls = _run_install("cursor", self._responder(verify_finds_binary=True))
        verify_calls = [c for c in calls if "which agent" in c]
        assert len(verify_calls) == 1, f"expected exactly one verify, got: {verify_calls}"
        assert 'export PATH="$HOME/.local/bin:$PATH"' in verify_calls[0], (
            f"verify command must put ~/.local/bin on PATH so it can find "
            f"binaries Cursor's installer dropped there. Got: {verify_calls[0]!r}"
        )

    def test_claude_verify_also_prepends_local_bin_to_path(self):
        # Claude installs via npm into nvm's bin, but the verify command is
        # shared. Cheap insurance: the export shouldn't break the npm path.
        _, calls = _run_install("claude", self._responder(verify_finds_binary=True))
        verify_calls = [c for c in calls if "which claude" in c]
        assert len(verify_calls) == 1
        assert 'export PATH="$HOME/.local/bin:$PATH"' in verify_calls[0]

    def test_returns_500_when_binary_genuinely_missing(self):
        # Negative case: if the install genuinely failed, we still return a 500.
        # Guard against a future regression where someone over-suppresses the
        # NOT_FOUND branch and silently reports success.
        result, _ = _run_install("cursor", self._responder(verify_finds_binary=False))
        assert result["statusCode"] == 500
        assert "Installation failed" in result["body"]

    def test_returns_200_when_binary_found_under_local_bin(self):
        # Positive case: this is the exact scenario that used to falsely
        # report failure on Ubuntu BYOS — installer wrote ~/.local/bin/agent,
        # verify with the export now finds it, install reports success.
        result, _ = _run_install("cursor", self._responder(verify_finds_binary=True))
        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert body["status"] == "installed"
        assert body["agent"] == "cursor"
        assert "cursor" in body["agents"]


# ─── persisted ~/.bashrc PATH export ──────────────────────────────────────────


class TestPersistsLocalBinPathToBashrc:
    """After a successful install we should persist ~/.local/bin on PATH in
    ~/.bashrc, matching what userdata.py does for managed instances. Without
    this, future interactive SSH sessions on a fresh BYOS box can't find
    the cursor binary."""

    def _responder(self):
        def respond(cmd):
            if cmd.startswith("command -v npm"):
                return ("OK\n", "", 0)
            if "which " in cmd and "NOT_FOUND" in cmd:
                return ("/home/ubuntu/.local/bin/agent\n", "", 0)
            return ("", "", 0)
        return respond

    def test_persists_export_to_bashrc_idempotently(self):
        _, calls = _run_install("cursor", self._responder())
        bashrc_calls = [
            c for c in calls
            if "~/.bashrc" in c and "/.local/bin" in c and "grep" in c
        ]
        assert len(bashrc_calls) == 1, (
            f"expected exactly one ~/.bashrc persistence step, got: {bashrc_calls}"
        )
        cmd = bashrc_calls[0]
        # Idempotent: don't append if the line is already there.
        assert "grep -q" in cmd
        assert ">> ~/.bashrc" in cmd
        assert 'export PATH="$HOME/.local/bin:$PATH"' in cmd

    def test_does_not_persist_when_install_failed(self):
        # If the verify step concluded the install failed, we abort with 500
        # and never touch ~/.bashrc — no point teaching a broken state.
        def fail_responder(cmd):
            if cmd.startswith("command -v npm"):
                return ("OK\n", "", 0)
            if "which agent" in cmd and "NOT_FOUND" in cmd:
                return ("NOT_FOUND\n", "", 0)
            return ("", "", 0)

        result, calls = _run_install("cursor", fail_responder)
        assert result["statusCode"] == 500
        bashrc_calls = [c for c in calls if "~/.bashrc" in c]
        assert bashrc_calls == [], (
            f"must not edit ~/.bashrc when install reported failure; got: {bashrc_calls}"
        )


# ─── BYOS server with agents=None must not crash post-install ─────────────────


class TestHandlesAgentsNoneOnBYOS:
    """provision.py stores `agents: None` when no agents were auto-detected
    on a BYOS server. After our verify-PATH fix, install-agent now reaches
    the post-install update code where `list(None)` would have crashed.
    Real-world repro: a fresh BYOS box with only Claude in ~/.local/bin
    (which non-interactive `which` doesn't find) registered with agents=None,
    then user adds Cursor — pre-fix the install reported 500 even on success."""

    def _server_with_agents_none(self):
        s = dict(FAKE_BYOS_SERVER)
        s["agents"] = None
        return s

    def _ok_responder(self):
        def respond(cmd):
            if cmd.startswith("command -v npm"):
                return ("OK\n", "", 0)
            if "which " in cmd and "NOT_FOUND" in cmd:
                return ("/home/ubuntu/.local/bin/agent\n", "", 0)
            return ("", "", 0)
        return respond

    def test_install_succeeds_when_existing_agents_is_none(self):
        calls = []

        def fake_ssh_exec(client, cmd, timeout=None):
            calls.append(cmd)
            return self._ok_responder()(cmd)

        patches = [
            ("src.chat.verify_token", {"return_value": FAKE_CLAIMS}),
            ("src.chat.get_server", {"return_value": self._server_with_agents_none()}),
            ("src.chat.decrypt", {"return_value": "fake-key"}),
            ("src.chat.ssh_connect", {"return_value": MagicMock()}),
            ("src.chat.ssh_disconnect", {}),
            ("src.chat.ssh_exec", {"side_effect": fake_ssh_exec}),
            ("src.chat.update_server", {}),
        ]
        with ExitStack() as stack:
            for target, kwargs in patches:
                stack.enter_context(patch(target, **kwargs))
            from src.chat import handler
            result = handler(_make_event({"action": "install-agent", "agent": "cursor"}), {})

        assert result["statusCode"] == 200, f"got {result['statusCode']}: {result['body']}"
        body = json.loads(result["body"])
        assert body["agents"] == ["cursor"]
