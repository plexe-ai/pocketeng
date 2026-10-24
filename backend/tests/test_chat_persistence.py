"""Tests for session/message persistence in chat.py."""
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
FAKE_SERVER = {
    "serverId": "srv-1",
    "userId": "user-123",
    "instanceState": "running",
    "publicIp": "1.2.3.4",
    "sshPrivateKey": "encrypted-key",
    "envType": "general",
    "sshUser": "ec2-user",
}

BASE_PATCHES = [
    ("src.chat.verify_token", {"return_value": FAKE_CLAIMS}),
    ("src.chat.get_server", {"return_value": FAKE_SERVER}),
    ("src.chat.decrypt", {"return_value": "fake-key"}),
    ("src.chat.ssh_connect", {"return_value": MagicMock()}),
    ("src.chat.ssh_exec", {"return_value": ("12345\n", "", 0)}),
    ("src.chat.ssh_disconnect", {}),
    ("src.chat.update_server", {}),
    # Worktree helpers were added to _launch_turn after this test suite was
    # written. They dispatch real SSH commands through `src.lib.ssh.ssh_exec`
    # (a different symbol than `src.chat.ssh_exec`), which our MagicMock
    # client can't satisfy. Patch the chat-module imports directly so the
    # session-launch path sees "no repo discovered" → skips worktree creation
    # and leaves workdir alone. Each test that actually cares about workdir
    # behavior can override these via its own extra_patches.
    ("src.chat.find_repo_dir", {"return_value": None}),
    ("src.chat.create_worktree", {"return_value": (None, None)}),
    # ensure_bridge_deployed SFTPs a real socket; bypass it in unit tests.
    ("src.chat.ensure_bridge_deployed", {"return_value": "fake-version-hash"}),
]


def _stack(extra_patches=None):
    """Return an ExitStack with all base patches + any extras applied."""
    stack = ExitStack()
    mocks = {}
    for target, kwargs in BASE_PATCHES:
        mocks[target] = stack.enter_context(patch(target, **kwargs))
    for target, kwargs in (extra_patches or []):
        mocks[target] = stack.enter_context(patch(target, **kwargs))
    return stack, mocks


def _make_event(body):
    return {
        "headers": {"authorization": "Bearer fake-token"},
        "pathParameters": {"serverId": "srv-1"},
        "body": json.dumps(body),
    }


# ─── start-session persistence ────────────────────────────────────────────────

class TestStartSessionPersistence:
    def test_creates_session_record(self):
        mock_put_session = MagicMock()
        mock_put_message = MagicMock()
        extra = [
            ("src.chat.put_session", {"side_effect": mock_put_session}),
            ("src.chat.put_message", {"side_effect": mock_put_message}),
        ]
        with _stack(extra)[0]:
            from src.chat import handler
            result = handler(_make_event({
                "action": "start-session",
                "prompt": "Build a landing page",
                "agent": "claude",
            }), {})

        assert result["statusCode"] == 200
        mock_put_session.assert_called_once()
        item = mock_put_session.call_args[0][0]
        assert item["serverId"] == "srv-1"
        assert item["userId"] == "user-123"
        assert item["status"] == "running"
        assert item["prompt"] == "Build a landing page"
        assert item["lastPrompt"] == "Build a landing page"
        assert item["agent"] == "claude"
        assert item["nextSeq"] == 1
        assert item["currentRunSeqBase"] == 1
        assert item["currentRunOffset"] == 0
        assert "sessionId" in item
        assert "createdAt" in item
        assert "updatedAt" in item

    def test_saves_user_prompt_as_message_seq_0(self):
        mock_put_session = MagicMock()
        mock_put_message = MagicMock()
        extra = [
            ("src.chat.put_session", {"side_effect": mock_put_session}),
            ("src.chat.put_message", {"side_effect": mock_put_message}),
        ]
        with _stack(extra)[0]:
            from src.chat import handler
            handler(_make_event({
                "action": "start-session",
                "prompt": "Build a landing page",
            }), {})

        mock_put_message.assert_called_once()
        args = mock_put_message.call_args[0]
        seq, role, content = args[1], args[2], args[3]
        assert seq == 0
        assert role == "user"
        assert content == "Build a landing page"

    def test_returns_session_id_and_pid(self):
        extra = [
            ("src.chat.put_session", {}),
            ("src.chat.put_message", {}),
        ]
        with _stack(extra)[0]:
            from src.chat import handler
            result = handler(_make_event({"action": "start-session", "prompt": "hello"}), {})

        body = json.loads(result["body"])
        assert "sessionId" in body
        assert "pid" in body
        assert body["pid"] == "12345"

    def test_defaults_agent_to_claude(self):
        mock_put_session = MagicMock()
        extra = [
            ("src.chat.put_session", {"side_effect": mock_put_session}),
            ("src.chat.put_message", {}),
        ]
        with _stack(extra)[0]:
            from src.chat import handler
            handler(_make_event({"action": "start-session", "prompt": "hi"}), {})

        item = mock_put_session.call_args[0][0]
        assert item["agent"] == "claude"

    def test_returns_400_when_prompt_missing(self):
        mock_put_session = MagicMock()
        mock_put_message = MagicMock()
        extra = [
            ("src.chat.put_session", {"side_effect": mock_put_session}),
            ("src.chat.put_message", {"side_effect": mock_put_message}),
        ]
        with _stack(extra)[0]:
            from src.chat import handler
            result = handler(_make_event({"action": "start-session", "prompt": ""}), {})

        assert result["statusCode"] == 400
        mock_put_session.assert_not_called()
        mock_put_message.assert_not_called()


# ─── send-message persistence ─────────────────────────────────────────────────

class TestSendMessagePersistence:
    def test_updates_existing_session_for_followup(self):
        mock_update_session = MagicMock()
        mock_put_session = MagicMock()
        existing_session = {
            "sessionId": "sess-1",
            "userId": "user-123",
            "serverId": "srv-1",
            "prompt": "Build a landing page",
            "agent": "claude",
            "nextSeq": 3,
            "remoteSessionId": "claude-remote",
        }
        extra = [
            ("src.chat.get_session", {"return_value": existing_session}),
            ("src.chat.put_session", {"side_effect": mock_put_session}),
            ("src.chat.update_session", {"side_effect": mock_update_session}),
            ("src.chat.put_message", {}),
        ]
        with _stack(extra)[0]:
            from src.chat import handler
            handler(_make_event({
                "action": "send-message",
                "sessionId": "sess-1",
                "prompt": "Now add a footer",
            }), {})

        mock_put_session.assert_not_called()
        mock_update_session.assert_called_once()
        updates = mock_update_session.call_args[0][1]
        assert updates["status"] == "running"
        assert updates["agent"] == "claude"
        assert updates["lastPrompt"] == "Now add a footer"
        assert updates["remoteSessionId"] == "claude-remote"
        assert updates["nextSeq"] == 4
        assert updates["currentRunSeqBase"] == 4
        assert updates["currentRunOffset"] == 0

    def test_saves_followup_prompt_at_next_seq(self):
        mock_put_message = MagicMock()
        existing_session = {
            "sessionId": "sess-1",
            "userId": "user-123",
            "serverId": "srv-1",
            "prompt": "Build a landing page",
            "agent": "claude",
            "nextSeq": 5,
        }
        extra = [
            ("src.chat.get_session", {"return_value": existing_session}),
            ("src.chat.put_session", {}),
            ("src.chat.update_session", {}),
            ("src.chat.put_message", {"side_effect": mock_put_message}),
        ]
        with _stack(extra)[0]:
            from src.chat import handler
            handler(_make_event({
                "action": "send-message",
                "sessionId": "sess-1",
                "prompt": "Now add a footer",
            }), {})

        mock_put_message.assert_called_once()
        args = mock_put_message.call_args[0]
        assert args[1] == 5
        assert args[2] == "user"
        assert args[3] == "Now add a footer"

    def test_followup_stays_in_session_worktree_even_when_client_sends_workdir(self):
        existing_session = {
            "sessionId": "sess-1",
            "userId": "user-123",
            "serverId": "srv-1",
            "prompt": "Build a landing page",
            "agent": "claude",
            "nextSeq": 3,
            "worktreePath": "/tmp/repo-worktrees/sess-1",
        }
        extra = [
            ("src.chat.get_session", {"return_value": existing_session}),
            ("src.chat.put_session", {}),
            ("src.chat.update_session", {}),
            ("src.chat.put_message", {}),
        ]
        stack, mocks = _stack(extra)
        with stack:
            from src.chat import handler
            handler(_make_event({
                "action": "send-message",
                "sessionId": "sess-1",
                "prompt": "Now add a footer",
                "workdir": "~/projects",
            }), {})

        launch_cmd = mocks["src.chat.ssh_exec"].call_args[0][1]
        assert "/tmp/repo-worktrees/sess-1" in launch_cmd

    def test_rejects_session_from_different_server(self):
        mock_update_session = MagicMock()
        mock_put_message = MagicMock()
        existing_session = {
            "sessionId": "sess-1",
            "userId": "user-123",
            "serverId": "srv-other",
            "prompt": "Build a landing page",
            "agent": "claude",
            "nextSeq": 2,
        }
        extra = [
            ("src.chat.get_session", {"return_value": existing_session}),
            ("src.chat.update_session", {"side_effect": mock_update_session}),
            ("src.chat.put_message", {"side_effect": mock_put_message}),
        ]
        with _stack(extra)[0]:
            from src.chat import handler
            result = handler(_make_event({
                "action": "send-message",
                "sessionId": "sess-1",
                "prompt": "Now add a footer",
            }), {})

        assert result["statusCode"] == 400
        mock_update_session.assert_not_called()
        mock_put_message.assert_not_called()


# ─── sync_session_output persistence ──────────────────────────────────────────
#
# The `poll-output` action was removed in phase 3 (events stream replaced the
# SSH-tail live path). The underlying `sync_session_output()` helper is still
# used by `completion_hook` when the agent exits and by `_status_check`, so
# the persistence behaviors below still matter.

class TestSyncSessionOutputPersistence:
    def _sync(self, ssh_stdout, offset=0, session=None):
        session = session or {
            "sessionId": "sess-1",
            "userId": "user-123",
            "serverId": "srv-1",
            "currentRunSeqBase": 7,
        }
        mock_put = MagicMock()
        mock_update = MagicMock()
        mock_advance = MagicMock()
        patches = [
            ("src.chat.ssh_exec", {"return_value": (ssh_stdout, "", 0)}),
            ("src.chat.get_session", {"return_value": session}),
            ("src.chat.put_message", {"side_effect": mock_put}),
            ("src.chat.advance_session_run", {"side_effect": mock_advance}),
            ("src.chat.update_session", {"side_effect": mock_update}),
            ("src.chat.claim_session_notification", {"return_value": True}),
            ("src.chat.get_messages", {"return_value": [
                {"sessionId": "sess-1", "seq": 0, "role": "user", "content": "hello", "createdAt": "2026-04-02T12:00:00Z"},
                {"sessionId": "sess-1", "seq": 1, "role": "agent", "content": '{"type":"result","subtype":"success","result":"Done"}', "createdAt": "2026-04-02T12:00:01Z"},
            ]}),
            ("src.chat.send_session_notification", {}),
        ]
        with ExitStack() as stack:
            for target, kwargs in patches:
                stack.enter_context(patch(target, **kwargs))
            from src.chat import sync_session_output
            result = sync_session_output(
                client=MagicMock(),
                session_id="sess-1",
                offset=offset,
                pid="123",
                server_id="srv-1",
                notify_on_done=True,
            )
        return result, mock_put, mock_advance, mock_update

    def test_saves_agent_lines_to_db(self):
        line1 = '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}'
        line2 = '{"type":"tool_use","name":"Bash","input":{"command":"ls"}}'
        stdout = f"{line1}\n{line2}\n---PE_SEP---\nRUNNING\n"
        _, mock_put, _, _ = self._sync(stdout)

        assert mock_put.call_count == 2
        first_args = mock_put.call_args_list[0][0]
        assert first_args[1] == 7
        assert first_args[2] == "agent"
        assert first_args[3] == line1

    def test_seq_increments_from_offset(self):
        line = '{"type":"text","content":"hi"}'
        stdout = f"{line}\n---PE_SEP---\nRUNNING\n"
        _, mock_put, _, _ = self._sync(stdout, offset=5)

        first_args = mock_put.call_args_list[0][0]
        assert first_args[1] == 12

    def test_marks_session_done_when_process_exits(self):
        line = '{"type":"result","result":"Done"}'
        stdout = f"{line}\n---PE_SEP---\nDONE\n"
        _, _, mock_advance, mock_update = self._sync(stdout)

        mock_advance.assert_called_once()
        mock_update.assert_called_once()
        assert mock_update.call_args[0][0] == "sess-1"
        assert mock_update.call_args[0][1]["status"] == "done"
        assert "updatedAt" in mock_update.call_args[0][1]

    def test_does_not_mark_done_when_still_running(self):
        line = '{"type":"text","content":"working"}'
        stdout = f"{line}\n---PE_SEP---\nRUNNING\n"
        _, _, _, mock_update = self._sync(stdout)

        mock_update.assert_not_called()

    def test_no_db_writes_when_no_new_lines(self):
        stdout = "\n---PE_SEP---\nRUNNING\n"
        _, mock_put, mock_advance, mock_update = self._sync(stdout)

        mock_put.assert_not_called()
        mock_advance.assert_not_called()
        mock_update.assert_not_called()

    def test_advance_session_tracks_remote_id_and_offset(self):
        init_line = '{"type":"system","subtype":"init","session_id":"remote-123"}'
        stdout = f"{init_line}\n---PE_SEP---\nRUNNING\n"
        _, _, mock_advance, _ = self._sync(stdout, offset=2)

        mock_advance.assert_called_once()
        args = mock_advance.call_args[0]
        assert args[0] == "sess-1"
        assert args[1] == 3
        assert args[2] == 10
        assert args[3]["remoteSessionId"] == "remote-123"
        assert "updatedAt" in args[3]

    def test_returns_correct_offset_and_done(self):
        line1 = '{"type":"text","content":"a"}'
        line2 = '{"type":"text","content":"b"}'
        stdout = f"{line1}\n{line2}\n---PE_SEP---\nDONE\n"
        result, _, _, _ = self._sync(stdout)

        assert result["offset"] == 2
        assert result["done"] is True


class TestCompletionCallbackLaunch:
    def test_start_session_writes_completion_callback_when_configured(self):
        extra = [
            ("src.chat.put_session", {}),
            ("src.chat.put_message", {}),
        ]
        stack, mocks = _stack(extra)
        with patch.dict(os.environ, {
            "PUBLIC_API_BASE_URL": "https://api.pocketeng.co",
            "COMPLETION_CALLBACK_SECRET": "top-secret",
        }):
            with stack:
                from src.chat import handler
                handler({
                    "headers": {
                        "authorization": "Bearer fake-token",
                        "host": "api.pocketeng.co",
                        "x-forwarded-proto": "https",
                    },
                    "requestContext": {"stage": "prod"},
                    "pathParameters": {"serverId": "srv-1"},
                    "body": json.dumps({
                        "action": "start-session",
                        "prompt": "Ship it",
                    }),
                }, {})

        launch_cmd = mocks["src.chat.ssh_exec"].call_args[0][1]
        assert "/internal/sessions/" in launch_cmd
        assert "X-PocketEngineer-Completion-Secret" in launch_cmd


# ─── register-synced-session merge-by-rsid ────────────────────────────────────

class TestRegisterSyncedSessionMergeByRsid:
    """The sync daemon scp's coding-agent `.jsonl` rollout files back from
    EC2 and POSTs them to register-synced-session. For Codex, the rollout
    UUID is owned by the SDK — it does NOT match the ghost UUID chat.py
    originally wrote to DDB when the turn was launched from the UI. The
    bridge emits `session.remote` post-startup to reconcile the DDB row's
    `remoteSessionId` to the true rollout UUID; then this handler is able
    to find the matching cloud-launched session and merge into it instead
    of creating a duplicate `synced...` row.

    These tests lock down that merge behavior.
    """

    REAL_RSID = "019dafab-0000-7000-8000-000000000000"

    def _event(self, rsid=None):
        return _make_event({
            "action": "register-synced-session",
            "remoteSessionId": rsid or self.REAL_RSID,
            "sessionFilePath": "/home/ec2-user/.codex/sessions/2026/04/17/rollout-2026-04-17T00-00-00-019dafab-0000-7000-8000-000000000000.jsonl",
            "worktreePath": "/home/ec2-user/projects/demo",
            "projectName": "demo",
            "agent": "codex",
        })

    def _ssh_exec_side_effect(self, _client, cmd, *a, **kw):
        """Stub out the SSH calls inside `_register_synced_session`:
        1) `wc -l … head -200 … tail -500 …` — returns the .jsonl metadata
           blob separated by `---SEP---` markers.
        2) `cd <worktree> && pwd` — returns the resolved worktree path.
        3) `tail -100 <file>` — returns the tail used by `_insert_tail_messages`.
        """
        codex_line = (
            '{"type":"response_item","payload":{"type":"message","role":"user",'
            '"content":[{"type":"input_text","text":"hello from laptop"}]}}'
        )
        if "wc -l" in cmd:
            return (f"1\n---SEP---\n{codex_line}\n---SEP---\n{codex_line}\n", "", 0)
        if cmd.startswith("cd "):
            return ("/home/ec2-user/projects/demo", "", 0)
        if "tail -100" in cmd:
            return (f"{codex_line}\n", "", 0)
        return ("", "", 0)

    def _cloud_session(self, rsid=None, session_id="sess-cloud-1"):
        return {
            "sessionId": session_id,
            "serverId": "srv-1",
            "userId": "user-123",
            "agent": "codex",
            "remoteSessionId": rsid or self.REAL_RSID,
            "status": "done",
            "nextSeq": 5,
        }

    def test_merges_into_cloud_session_with_matching_rsid(self):
        """The happy path: bridge already reconciled `remoteSessionId` on
        the cloud-launched row. Sync daemon posts the rollout .jsonl. We
        must NOT create a new `synced...` row — merge into the existing one.

        Also: the cloud-launched row's `status` field (e.g. "done") must
        be preserved — we must not regress a settled conversation to
        "from-laptop", which would make the UI look like it's waiting
        for laptop-side activity on an already-completed cloud turn.
        """
        mock_put_session = MagicMock()
        mock_update_session = MagicMock()
        extra = [
            ("src.chat.ssh_exec", {"side_effect": self._ssh_exec_side_effect}),
            ("src.chat.get_session", {"return_value": None}),
            ("src.chat.get_all_sessions_by_server",
             {"return_value": [self._cloud_session()]}),
            ("src.chat.put_session", {"side_effect": mock_put_session}),
            ("src.chat.update_session", {"side_effect": mock_update_session}),
            ("src.chat.put_message", {}),
        ]
        with _stack(extra)[0]:
            from src.chat import handler
            result = handler(self._event(), {})

        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert body["sessionId"] == "sess-cloud-1"
        assert body["status"] == "updated"
        mock_put_session.assert_not_called()
        mock_update_session.assert_called_once()
        updated_id = mock_update_session.call_args[0][0]
        assert updated_id == "sess-cloud-1"
        passed_updates = mock_update_session.call_args[0][1]
        assert "status" not in passed_updates, \
            f"merge must not overwrite status on cloud-launched row; got {passed_updates}"

    def test_creates_synced_row_when_no_cloud_match(self):
        """No existing session on this server matches the rsid — the
        handler creates the synthetic `synced...` row (old behavior)."""
        mock_put_session = MagicMock()
        mock_update_session = MagicMock()
        extra = [
            ("src.chat.ssh_exec", {"side_effect": self._ssh_exec_side_effect}),
            ("src.chat.get_session", {"return_value": None}),
            ("src.chat.get_all_sessions_by_server", {"return_value": []}),
            ("src.chat.put_session", {"side_effect": mock_put_session}),
            ("src.chat.update_session", {"side_effect": mock_update_session}),
            ("src.chat.put_message", {}),
        ]
        with _stack(extra)[0]:
            from src.chat import handler
            result = handler(self._event(), {})

        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        # Deterministic `synced` + rsid[:26] (dashes stripped)
        assert body["sessionId"] == "synced" + self.REAL_RSID.replace("-", "")[:26]
        assert body["status"] == "created"
        mock_put_session.assert_called_once()

    def test_merges_into_previously_synced_session_by_rsid(self):
        """When a user clicks a `synced...` row and chats from the UI,
        Codex spawns a fresh thread id (its SDK won't accept one) and
        writes a new rollout .jsonl. The bridge's `session.remote`
        event reconciles the row's `remoteSessionId` to that new id.
        When the sync daemon pulls the file, this handler must merge
        into the previously-synced session instead of creating a
        parallel `synced...` row — otherwise every UI turn on a synced
        Codex session doubles as a duplicate in the sidebar."""
        mock_put_session = MagicMock()
        mock_update_session = MagicMock()
        extra = [
            ("src.chat.ssh_exec", {"side_effect": self._ssh_exec_side_effect}),
            # The deterministic get_session lookup misses because the
            # previously-synced row's sessionId was derived from a
            # DIFFERENT (older) rsid — the one Codex wrote to disk for
            # the original laptop turn.
            ("src.chat.get_session", {"return_value": None}),
            ("src.chat.get_all_sessions_by_server",
             {"return_value": [{
                 **self._cloud_session(session_id="originally-synced-row"),
                 "syncedFromLaptop": True,
             }]}),
            ("src.chat.put_session", {"side_effect": mock_put_session}),
            ("src.chat.update_session", {"side_effect": mock_update_session}),
            ("src.chat.put_message", {}),
        ]
        with _stack(extra)[0]:
            from src.chat import handler
            result = handler(self._event(), {})

        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert body["sessionId"] == "originally-synced-row"
        assert body["status"] == "updated"
        mock_put_session.assert_not_called()
        mock_update_session.assert_called_once()
        assert mock_update_session.call_args[0][0] == "originally-synced-row"
        passed_updates = mock_update_session.call_args[0][1]
        assert passed_updates.get("status") == "from-laptop", \
            "a previously-synced row still tracks laptop-side state; keep status=from-laptop"

    def test_does_not_merge_across_users(self):
        """A session on this server but owned by a different user must
        never be matched — different userId is a hard isolation boundary."""
        mock_put_session = MagicMock()
        extra = [
            ("src.chat.ssh_exec", {"side_effect": self._ssh_exec_side_effect}),
            ("src.chat.get_session", {"return_value": None}),
            ("src.chat.get_all_sessions_by_server",
             {"return_value": [{
                 **self._cloud_session(session_id="other-user-session"),
                 "userId": "attacker-999",
             }]}),
            ("src.chat.put_session", {"side_effect": mock_put_session}),
            ("src.chat.update_session", {}),
            ("src.chat.put_message", {}),
        ]
        with _stack(extra)[0]:
            from src.chat import handler
            result = handler(self._event(), {})

        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert body["sessionId"] == "synced" + self.REAL_RSID.replace("-", "")[:26]
        mock_put_session.assert_called_once()

    def test_falls_back_to_create_when_server_scan_fails(self):
        """If the server-wide scan blows up (IAM, throttle, GSI outage),
        we must still register the session as a synthetic row. Losing the
        sync response means the daemon retries indefinitely."""
        mock_put_session = MagicMock()
        extra = [
            ("src.chat.ssh_exec", {"side_effect": self._ssh_exec_side_effect}),
            ("src.chat.get_session", {"return_value": None}),
            ("src.chat.get_all_sessions_by_server",
             {"side_effect": RuntimeError("ddb boom")}),
            ("src.chat.put_session", {"side_effect": mock_put_session}),
            ("src.chat.update_session", {}),
            ("src.chat.put_message", {}),
        ]
        with _stack(extra)[0]:
            from src.chat import handler
            result = handler(self._event(), {})

        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert body["status"] == "created"
        mock_put_session.assert_called_once()


# ─── register-synced-session tail-insert gating ───────────────────────────────

class TestRegisterSyncedSessionTailInsertGate:
    """Once a session has been touched from the cloud UI, the bridge /
    `sync_session_output` path is authoritative for the transcript. The
    sync-daemon re-register must NOT re-parse the rollout .jsonl and
    layer parsed rows on top — those rows land at different seqs from
    the bridge's writes (rollout parsers skip many event types, so
    parsed-msg-ordinal ≠ rollout-line-index) and the transcript
    materializer renders both → duplicate bubbles on Codex, doubled
    assistant text on Cursor. The fix: gate `_insert_tail_messages` on
    `currentRunSeqBase == 0` (pure-laptop sessions only).
    """

    REAL_RSID = "019dafab-0000-7000-8000-000000000000"
    SYNCED_ID = "synced" + REAL_RSID.replace("-", "")[:26]

    def _event(self):
        return _make_event({
            "action": "register-synced-session",
            "remoteSessionId": self.REAL_RSID,
            "sessionFilePath": "/home/ec2-user/.codex/sessions/2026/04/17/rollout-2026-04-17T00-00-00-019dafab-0000-7000-8000-000000000000.jsonl",
            "worktreePath": "/home/ec2-user/projects/demo",
            "projectName": "demo",
            "agent": "codex",
        })

    def _ssh_exec_side_effect(self, _client, cmd, *a, **kw):
        codex_line = (
            '{"type":"response_item","payload":{"type":"message","role":"user",'
            '"content":[{"type":"input_text","text":"hello from laptop"}]}}'
        )
        if "wc -l" in cmd:
            return (f"42\n---SEP---\n{codex_line}\n---SEP---\n{codex_line}\n", "", 0)
        if cmd.startswith("cd "):
            return ("/home/ec2-user/projects/demo", "", 0)
        if "tail -100" in cmd:
            return (f"{codex_line}\n", "", 0)
        return ("", "", 0)

    def _extra_patches(self, mock_put_message, existing_session):
        return [
            ("src.chat.ssh_exec", {"side_effect": self._ssh_exec_side_effect}),
            ("src.chat.get_session", {"return_value": existing_session}),
            ("src.chat.get_all_sessions_by_server", {"return_value": []}),
            ("src.chat.put_session", {}),
            ("src.chat.update_session", {}),
            ("src.chat.put_message", {"side_effect": mock_put_message}),
        ]

    def test_pure_laptop_session_still_hydrates_tail_messages(self):
        """Control: a session that has never been touched from the UI
        (currentRunSeqBase == 0) must still be hydrated on every sync
        pull — this is how new local turns appear on the phone / web
        before the user ever opens the session."""
        mock_put_message = MagicMock()
        existing = {
            "sessionId": self.SYNCED_ID,
            "serverId": "srv-1",
            "userId": "user-123",
            "agent": "codex",
            "remoteSessionId": self.REAL_RSID,
            "syncedFromLaptop": True,
            "status": "from-laptop",
            "currentRunSeqBase": 0,
            "nextSeq": 20,
        }
        with _stack(self._extra_patches(mock_put_message, existing))[0]:
            from src.chat import handler
            result = handler(self._event(), {})

        assert result["statusCode"] == 200
        assert mock_put_message.call_count >= 1, \
            "pure-laptop sessions must still hydrate their transcript from the rollout"

    def test_cloud_launched_session_skips_tail_insert(self):
        """The bug: after a UI turn, every 60s the sync daemon's
        re-register fires and duplicates the turn. Assert the tail path
        is NOT invoked once the cloud launch has started writing."""
        mock_put_message = MagicMock()
        existing = {
            "sessionId": self.SYNCED_ID,
            "serverId": "srv-1",
            "userId": "user-123",
            "agent": "codex",
            "remoteSessionId": self.REAL_RSID,
            "syncedFromLaptop": True,
            "status": "done",
            "currentRunSeqBase": 6,  # bridge has written past seq 5
            "nextSeq": 10,
        }
        with _stack(self._extra_patches(mock_put_message, existing))[0]:
            from src.chat import handler
            result = handler(self._event(), {})

        assert result["statusCode"] == 200
        mock_put_message.assert_not_called()

    def test_cloud_launched_session_preserves_bridge_counters(self):
        """`currentRunOffset` / `nextSeq` are the bridge's next-write
        pointers. Resetting them to the rollout's raw line_count would
        rewind the bridge and stomp already-persisted rows on the next
        turn. For cloud-launched sessions the update must NOT touch
        either field."""
        captured_updates = {}

        def capture_update(session_id, updates):
            captured_updates.update(updates)

        existing = {
            "sessionId": self.SYNCED_ID,
            "serverId": "srv-1",
            "userId": "user-123",
            "agent": "codex",
            "remoteSessionId": self.REAL_RSID,
            "syncedFromLaptop": True,
            "status": "done",
            "currentRunSeqBase": 6,
            "nextSeq": 10,
            "currentRunOffset": 4,
        }
        extra = [
            ("src.chat.ssh_exec", {"side_effect": self._ssh_exec_side_effect}),
            ("src.chat.get_session", {"return_value": existing}),
            ("src.chat.get_all_sessions_by_server", {"return_value": []}),
            ("src.chat.put_session", {}),
            ("src.chat.update_session", {"side_effect": capture_update}),
            ("src.chat.put_message", {}),
        ]
        with _stack(extra)[0]:
            from src.chat import handler
            result = handler(self._event(), {})

        assert result["statusCode"] == 200
        assert "currentRunOffset" not in captured_updates, \
            f"must not rewind bridge's offset pointer; got {captured_updates}"
        assert "nextSeq" not in captured_updates, \
            f"must not rewind bridge's nextSeq pointer; got {captured_updates}"
        # But laptop-tracking metadata is still fine to refresh.
        assert "sessionFilePath" in captured_updates
        assert "lastPrompt" in captured_updates

    def test_cursor_no_trailing_newline_advances_nextseq_past_messages(self):
        """Cursor's rollout files typically don't end with a trailing
        newline, so `wc -l` reports N-1 while the parser yields N
        messages. If we leave `nextSeq` at line_count (= N-1) the first
        UI follow-up's `user_seq = nextSeq = N-1` would clobber the
        last local assistant row. Assert the register path advances
        `nextSeq` past the highest parsed-message seq instead."""
        captured_updates = {}

        def capture_update(session_id, updates):
            captured_updates.update(updates)

        # Stub SSH to simulate a Cursor rollout with 1 reported line
        # (wc -l) but 2 parseable messages (user + assistant).
        cursor_user_line = json.dumps({
            "role": "user",
            "message": {"content": [{"type": "text", "text": "hi"}]},
        })
        cursor_asst_line = json.dumps({
            "role": "assistant",
            "message": {"content": [{"type": "text", "text": "hello"}]},
        })

        def ssh_exec_stub(_client, cmd, *a, **kw):
            if "wc -l" in cmd:
                return (f"1\n---SEP---\n{cursor_user_line}\n---SEP---\n{cursor_user_line}\n", "", 0)
            if cmd.startswith("cd "):
                return ("/home/ec2-user/projects/demo", "", 0)
            if "tail -100" in cmd:
                return (f"{cursor_user_line}\n{cursor_asst_line}\n", "", 0)
            return ("", "", 0)

        existing = {
            "sessionId": self.SYNCED_ID,
            "serverId": "srv-1",
            "userId": "user-123",
            "agent": "cursor",
            "remoteSessionId": self.REAL_RSID,
            "syncedFromLaptop": True,
            "status": "from-laptop",
            "currentRunSeqBase": 0,
            "nextSeq": 1,
        }
        extra = [
            ("src.chat.ssh_exec", {"side_effect": ssh_exec_stub}),
            ("src.chat.get_session", {"return_value": existing}),
            ("src.chat.get_all_sessions_by_server", {"return_value": []}),
            ("src.chat.put_session", {}),
            ("src.chat.update_session", {"side_effect": capture_update}),
            ("src.chat.put_message", {}),
        ]
        # Override the handler's event agent to 'cursor' so the parser
        # dispatches to the cursor branch instead of codex.
        ev = _make_event({
            "action": "register-synced-session",
            "remoteSessionId": self.REAL_RSID,
            "sessionFilePath": "/home/ec2-user/.cursor/projects/demo/agent-transcripts/rid/rid.jsonl",
            "worktreePath": "/home/ec2-user/projects/demo",
            "projectName": "demo",
            "agent": "cursor",
        })
        with _stack(extra)[0]:
            from src.chat import handler
            result = handler(ev, {})

        assert result["statusCode"] == 200
        # wc -l reported 1, but parser emitted 2 messages → nextSeq
        # must be at least 2 so the next UI follow-up writes past them.
        assert captured_updates.get("nextSeq", 0) >= 2, \
            f"must advance nextSeq past parsed-msg-count; got {captured_updates}"
        assert captured_updates.get("currentRunOffset", 0) >= 2, \
            f"currentRunOffset must track nextSeq; got {captured_updates}"

    def test_pure_laptop_session_still_advances_counters(self):
        """Mirror of the previous test: for never-cloud-launched rows
        the sync pull IS the authoritative writer, so it should keep
        `currentRunOffset` / `nextSeq` in step with the rollout."""
        captured_updates = {}

        def capture_update(session_id, updates):
            captured_updates.update(updates)

        existing = {
            "sessionId": self.SYNCED_ID,
            "serverId": "srv-1",
            "userId": "user-123",
            "agent": "codex",
            "remoteSessionId": self.REAL_RSID,
            "syncedFromLaptop": True,
            "status": "from-laptop",
            "currentRunSeqBase": 0,
            "nextSeq": 10,
        }
        extra = [
            ("src.chat.ssh_exec", {"side_effect": self._ssh_exec_side_effect}),
            ("src.chat.get_session", {"return_value": existing}),
            ("src.chat.get_all_sessions_by_server", {"return_value": []}),
            ("src.chat.put_session", {}),
            ("src.chat.update_session", {"side_effect": capture_update}),
            ("src.chat.put_message", {}),
        ]
        with _stack(extra)[0]:
            from src.chat import handler
            result = handler(self._event(), {})

        assert result["statusCode"] == 200
        # wc -l stub returns 42 — both counters should track that line_count.
        assert captured_updates.get("currentRunOffset") == 42
        assert captured_updates.get("nextSeq") == 42
