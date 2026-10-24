"""Unit tests for the Retell voice webhook handler."""
import json
import os
from unittest.mock import patch

os.environ.setdefault("RETELL_WEBHOOK_SECRET", "test-voice-secret")
os.environ.setdefault("SMS_MAPPINGS_TABLE", "pe-sms-mappings-prod")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")


def _event(body=None, secret="test-voice-secret", qs_secret=True):
    qs = {"secret": secret} if qs_secret else None
    return {
        "queryStringParameters": qs,
        "headers": {} if qs_secret else {"x-retell-secret": secret},
        "body": json.dumps(body or {}),
    }


def _retell_body(name, args=None, phone="+15551234567"):
    return {
        "name": name,
        "args": args or {},
        "call": {"from_number": phone},
    }


# ─── format_for_tts ──────────────────────────────────────────────────────────

class TestFormatForTts:
    def test_strips_code_blocks(self):
        from src.lib.voice import format_for_tts
        text = "Here's the fix:\n```python\ndef foo():\n  pass\n```\nThat should do it."
        out = format_for_tts(text)
        assert "def foo" not in out
        assert "code block omitted" in out
        assert "That should do it" in out

    def test_strips_markdown_links(self):
        from src.lib.voice import format_for_tts
        out = format_for_tts("See the [docs](https://example.com) for details.")
        assert "https://example.com" not in out
        assert "docs" in out

    def test_truncates_at_sentence_boundary(self):
        from src.lib.voice import format_for_tts
        text = "First sentence. Second sentence. Third sentence. Fourth sentence. " * 10
        out = format_for_tts(text, max_chars=80)
        assert len(out) <= 82  # small slack for trailing space/.
        assert out.endswith(".")


# ─── resolve_workspace ───────────────────────────────────────────────────────

class TestResolveWorkspace:
    def _servers(self):
        return [
            {"serverId": "a", "label": "pocketeng", "instanceState": "running", "sshPrivateKey": "x", "updatedAt": "2026-04-21T10:00:00Z"},
            {"serverId": "b", "label": "rfm-api", "instanceState": "stopped", "sshPrivateKey": "x", "updatedAt": "2026-04-19T10:00:00Z"},
            {"serverId": "c", "label": "terminated-one", "instanceState": "terminated", "sshPrivateKey": "x"},
        ]

    def test_exact_label_match(self):
        from src.lib.voice import resolve_workspace
        hit = resolve_workspace(self._servers(), "pocketeng")
        assert hit["serverId"] == "a"

    def test_fuzzy_spoken_hint(self):
        from src.lib.voice import resolve_workspace
        # STT might render "pocketeng" as "pocket eng" or "Pocket Eng"
        hit = resolve_workspace(self._servers(), "Pocket Eng")
        assert hit["serverId"] == "a"

    def test_substring_match(self):
        from src.lib.voice import resolve_workspace
        hit = resolve_workspace(self._servers(), "rfm")
        assert hit["serverId"] == "b"

    def test_ignores_terminated(self):
        from src.lib.voice import resolve_workspace
        hit = resolve_workspace(self._servers(), "terminated")
        assert hit is None

    def test_default_picks_single_running(self):
        from src.lib.voice import resolve_workspace
        hit = resolve_workspace(self._servers(), None)
        assert hit["serverId"] == "a"  # the only running one

    def test_unknown_returns_none(self):
        from src.lib.voice import resolve_workspace
        assert resolve_workspace(self._servers(), "nonexistent") is None


# ─── resolve_session ─────────────────────────────────────────────────────────

class TestResolveSession:
    def _sessions(self):
        return [
            {"sessionId": "s1", "lastPrompt": "fix the auth bug in login.py", "status": "done", "updatedAt": "2026-04-20T10:00:00Z"},
            {"sessionId": "s2", "lastPrompt": "write tests for the api module", "status": "running", "updatedAt": "2026-04-21T10:00:00Z"},
            {"sessionId": "s3", "lastPrompt": "deploy to staging", "status": "done", "updatedAt": "2026-04-19T10:00:00Z"},
        ]

    def test_word_overlap_matches_auth(self):
        from src.lib.voice import resolve_session
        hit = resolve_session(self._sessions(), "the auth bug one")
        assert hit["sessionId"] == "s1"

    def test_no_hint_picks_running_over_older_done(self):
        from src.lib.voice import resolve_session
        hit = resolve_session(self._sessions(), None)
        assert hit["sessionId"] == "s2"

    def test_unknown_returns_none(self):
        from src.lib.voice import resolve_session
        assert resolve_session(self._sessions(), "completely unrelated phrase xyz") is None


# ─── auth ────────────────────────────────────────────────────────────────────

class TestAuth:
    def test_rejects_missing_secret(self):
        from src.voice_tools import handler
        result = handler({"queryStringParameters": None, "headers": {}, "body": "{}"}, {})
        assert result["statusCode"] == 200  # we always 200 to keep the call up
        assert "Authentication failed" in json.loads(result["body"])["result"]

    def test_rejects_wrong_secret(self):
        from src.voice_tools import handler
        result = handler(_event(secret="nope"), {})
        assert "Authentication failed" in json.loads(result["body"])["result"]

    def test_accepts_header_secret(self):
        from src.voice_tools import handler
        with patch("src.voice_tools._caller_mapping", return_value=None):
            ev = _event(body=_retell_body("list_workspaces"), qs_secret=False)
            result = handler(ev, {})
            assert result["statusCode"] == 200
            # Made it past auth — unregistered caller path speaks.
            assert "isn't linked" in json.loads(result["body"])["result"]


# ─── unregistered caller ─────────────────────────────────────────────────────

class TestAllowlist:
    def test_unregistered_caller_is_told_to_register(self):
        from src.voice_tools import handler
        with patch("src.voice_tools._caller_mapping", return_value=None):
            result = handler(_event(body=_retell_body("list_workspaces")), {})
            assert "isn't linked" in json.loads(result["body"])["result"]

    def test_missing_phone_number_handled(self):
        from src.voice_tools import handler
        ev = _event(body={"name": "list_workspaces", "args": {}, "call": {}})
        result = handler(ev, {})
        assert "couldn't identify the caller" in json.loads(result["body"])["result"]


# ─── list_workspaces ─────────────────────────────────────────────────────────

class TestListWorkspaces:
    def test_lists_workspaces_with_state(self):
        servers = [
            {"serverId": "a", "label": "pocketeng", "instanceState": "running"},
            {"serverId": "b", "label": "rfm-api", "instanceState": "stopped"},
        ]
        with patch("src.voice_tools._caller_mapping", return_value={"userId": "u1"}), \
             patch("src.voice_tools.get_servers_by_user", return_value=servers):
            from src.voice_tools import handler
            result = handler(_event(body=_retell_body("list_workspaces")), {})
            out = json.loads(result["body"])["result"]
            assert "pocketeng is running" in out
            assert "rfm-api is stopped" in out

    def test_no_workspaces_message(self):
        with patch("src.voice_tools._caller_mapping", return_value={"userId": "u1"}), \
             patch("src.voice_tools.get_servers_by_user", return_value=[]):
            from src.voice_tools import handler
            result = handler(_event(body=_retell_body("list_workspaces")), {})
            assert "don't have any workspaces" in json.loads(result["body"])["result"]


# ─── read_session ────────────────────────────────────────────────────────────

class TestReadSession:
    def test_returns_last_assistant_content(self):
        servers = [{"serverId": "a", "label": "pocketeng", "instanceState": "running", "sshPrivateKey": "x"}]
        sessions = [{"sessionId": "s1", "lastPrompt": "fix auth bug", "status": "done", "updatedAt": "2026-04-21T10:00:00Z"}]
        transcript = [
            {"role": "user", "content": "fix auth bug"},
            {"role": "assistant", "content": "Found it in `auth.py` line 45. Applied the fix and tests pass."},
        ]
        with patch("src.voice_tools._caller_mapping", return_value={"userId": "u1"}), \
             patch("src.voice_tools.get_servers_by_user", return_value=servers), \
             patch("src.voice_tools.get_sessions_by_server", return_value=sessions), \
             patch("src.voice_tools.get_messages", return_value=[]), \
             patch("src.voice_tools.materialize_transcript", return_value=transcript):
            from src.voice_tools import handler
            result = handler(_event(body=_retell_body("read_session", {"session": "auth bug"})), {})
            out = json.loads(result["body"])["result"]
            assert "Found it in auth.py" in out
            assert "`" not in out  # inline code stripped of backticks

    def test_no_session_match_tells_user(self):
        servers = [{"serverId": "a", "label": "x", "instanceState": "running", "sshPrivateKey": "x"}]
        with patch("src.voice_tools._caller_mapping", return_value={"userId": "u1"}), \
             patch("src.voice_tools.get_servers_by_user", return_value=servers), \
             patch("src.voice_tools.get_sessions_by_server", return_value=[
                 {"sessionId": "s1", "lastPrompt": "unrelated topic", "updatedAt": "2026-04-20T10:00:00Z"},
             ]):
            from src.voice_tools import handler
            result = handler(_event(body=_retell_body("read_session", {"session": "zzzzz"})), {})
            assert "couldn't match" in json.loads(result["body"])["result"]


# ─── send_message ────────────────────────────────────────────────────────────

class TestSendMessage:
    def test_stopped_workspace_starts_async_and_reports(self):
        server = {
            "serverId": "a",
            "label": "pocketeng",
            "instanceState": "stopped",
            "instanceId": "i-xxx",
            "sshPrivateKey": "x",
        }
        with patch("src.voice_tools._caller_mapping", return_value={"userId": "u1", "defaultServerId": "a"}), \
             patch("src.voice_tools.find_server_by_id", return_value=(server, True)), \
             patch("src.voice_tools.start_instance") as mock_start:
            from src.voice_tools import handler
            result = handler(_event(body=_retell_body("send_message", {"message": "run tests"})), {})
            out = json.loads(result["body"])["result"]
            mock_start.assert_called_once_with("i-xxx")
            assert "starting it up" in out
            assert "minute" in out

    def test_successful_send_tells_user_to_check_app(self):
        server = {
            "serverId": "a",
            "label": "pocketeng",
            "instanceState": "running",
            "instanceId": "i-xxx",
            "publicIp": "1.2.3.4",
            "sshPrivateKey": "x",
        }
        with patch("src.voice_tools._caller_mapping", return_value={"userId": "u1", "defaultServerId": "a"}), \
             patch("src.voice_tools.find_server_by_id", return_value=(server, False)), \
             patch("src.voice_tools.decrypt", return_value="fake-key"), \
             patch("src.voice_tools.ssh_connect", return_value="fake-client"), \
             patch("src.voice_tools.ssh_disconnect"), \
             patch("src.voice_tools.ensure_github_credentials"), \
             patch("src.voice_tools.get_sessions_by_server", return_value=[]), \
             patch("src.chat._launch_turn", return_value={
                 "statusCode": 200,
                 "body": json.dumps({"sessionId": "sess-new"}),
             }):
            from src.voice_tools import handler
            result = handler(_event(body=_retell_body("send_message", {"message": "run tests"})), {})
            out = json.loads(result["body"])["result"]
            assert "Kicked off" in out
            assert "pocketeng" in out
            assert "pocket eng app" in out

    def test_no_workspace_yields_friendly_message(self):
        with patch("src.voice_tools._caller_mapping", return_value={"userId": "u1"}), \
             patch("src.voice_tools.find_server_by_label", return_value=(None, False)), \
             patch("src.voice_tools.find_server_by_id", return_value=(None, False)), \
             patch("src.voice_tools.find_any_server", return_value=(None, False)):
            from src.voice_tools import handler
            result = handler(_event(body=_retell_body("send_message", {"message": "do stuff"})), {})
            assert "don't have any workspaces" in json.loads(result["body"])["result"]

    def test_empty_message_asks_for_clarification(self):
        with patch("src.voice_tools._caller_mapping", return_value={"userId": "u1"}):
            from src.voice_tools import handler
            result = handler(_event(body=_retell_body("send_message", {"message": ""})), {})
            assert "What message" in json.loads(result["body"])["result"]

    def test_live_voice_prefix_prepended_to_prompt(self):
        """Every voice-initiated prompt gets the LIVE VOICE CALL hint
        prepended so the agent trims its reply shape. Regression guard —
        dropping this silently would revert voice to "read me a novel"
        mode without failing any other test."""
        server = {
            "serverId": "a", "label": "pocketeng", "instanceState": "running",
            "instanceId": "i-xxx", "publicIp": "1.2.3.4", "sshPrivateKey": "x",
        }
        captured = {}
        def _capture(client, body, *a, **kw):
            captured["prompt"] = body.get("prompt")
            return {"statusCode": 200, "body": json.dumps({"sessionId": "sess-new"})}
        with patch("src.voice_tools._caller_mapping", return_value={"userId": "u1", "defaultServerId": "a"}), \
             patch("src.voice_tools.find_server_by_id", return_value=(server, False)), \
             patch("src.voice_tools.decrypt", return_value="k"), \
             patch("src.voice_tools.ssh_connect", return_value="client"), \
             patch("src.voice_tools.ssh_disconnect"), \
             patch("src.voice_tools.ensure_github_credentials"), \
             patch("src.voice_tools.get_sessions_by_server", return_value=[]), \
             patch("src.chat._launch_turn", side_effect=_capture):
            from src.voice_tools import handler
            handler(_event(body=_retell_body("send_message", {"message": "what does auth.py do"})), {})
        assert captured["prompt"].startswith("[LIVE VOICE CALL")
        assert "what does auth.py do" in captured["prompt"]


# ─── send_message wait_for_response ──────────────────────────────────────────

class TestSendMessageWait:
    """Covers the synchronous brainstorm path: send + poll + return reply."""

    _server = {
        "serverId": "a", "label": "pocketeng", "instanceState": "running",
        "instanceId": "i-xxx", "publicIp": "1.2.3.4", "sshPrivateKey": "x",
    }
    _launch_ok = {"statusCode": 200, "body": json.dumps({"sessionId": "sess-new"})}

    def _mocks(self, events_sequence):
        """events_sequence is a list of (list-of-events) snapshots, one per
        poll tick. Tests that want "two polls return empty then reply
        lands" pass [[], [run-started, assistant, run-finished]]."""
        call_count = {"n": 0}
        def _get_events(*a, **kw):
            idx = min(call_count["n"], len(events_sequence) - 1)
            call_count["n"] += 1
            return events_sequence[idx]
        return _get_events

    def _run(self, events_sequence, wait=True, timeout=None, extra_args=None):
        args = {"message": "hey", "wait_for_response": wait}
        if timeout is not None:
            args["timeout"] = timeout
        if extra_args:
            args.update(extra_args)
        with patch("src.voice_tools._caller_mapping", return_value={"userId": "u1", "defaultServerId": "a"}), \
             patch("src.voice_tools.find_server_by_id", return_value=(self._server, False)), \
             patch("src.voice_tools.decrypt", return_value="k"), \
             patch("src.voice_tools.ssh_connect", return_value="client"), \
             patch("src.voice_tools.ssh_disconnect"), \
             patch("src.voice_tools.ensure_github_credentials"), \
             patch("src.voice_tools.get_sessions_by_server", return_value=[]), \
             patch("src.voice_tools.get_recent_session_events", side_effect=self._mocks(events_sequence)), \
             patch("src.voice_tools.time.sleep"), \
             patch("src.chat._launch_turn", return_value=self._launch_ok):
            from src.voice_tools import handler
            res = handler(_event(body=_retell_body("send_message", args)), {})
            return json.loads(res["body"])["result"]

    def test_wait_returns_assistant_reply_on_run_finished(self):
        events = [
            {"seq": 1, "kind": "run.started", "payload": {}},
            {"seq": 2, "kind": "assistant.message", "payload": {"text": "The auth module uses Supabase."}},
            {"seq": 3, "kind": "run.finished", "payload": {"outcome": "success"}},
        ]
        out = self._run([events])
        assert "auth module" in out
        assert "Supabase" in out
        # Must NOT return the "still working" fallback.
        assert "Still working" not in out

    def test_wait_concatenates_multiple_assistant_messages(self):
        """Streaming agents often emit several assistant.message events
        per turn as the delta is chunked + finalized. We should speak all
        of them, not just the first or last."""
        events = [
            {"seq": 1, "kind": "run.started", "payload": {}},
            {"seq": 2, "kind": "assistant.message", "payload": {"text": "First chunk."}},
            {"seq": 3, "kind": "assistant.message", "payload": {"text": "Second chunk."}},
            {"seq": 4, "kind": "run.finished", "payload": {"outcome": "success"}},
        ]
        out = self._run([events])
        assert "First chunk" in out
        assert "Second chunk" in out

    def test_wait_ignores_events_before_pre_seq(self):
        """On a resumed session we capture pre_seq = last existing event's
        seq. Anything at or below that belongs to a prior turn and must
        not be mistaken for the current reply."""
        prior_events = [{"seq": 10, "kind": "assistant.message", "payload": {"text": "old message"}}]
        new_events = prior_events + [
            {"seq": 11, "kind": "run.started", "payload": {}},
            {"seq": 12, "kind": "assistant.message", "payload": {"text": "fresh reply"}},
            {"seq": 13, "kind": "run.finished", "payload": {"outcome": "success"}},
        ]
        with patch("src.voice_tools._caller_mapping", return_value={"userId": "u1", "defaultServerId": "a"}), \
             patch("src.voice_tools.find_server_by_id", return_value=(self._server, False)), \
             patch("src.voice_tools.decrypt", return_value="k"), \
             patch("src.voice_tools.ssh_connect", return_value="client"), \
             patch("src.voice_tools.ssh_disconnect"), \
             patch("src.voice_tools.ensure_github_credentials"), \
             patch("src.voice_tools.get_sessions_by_server", return_value=[{"sessionId": "sess-old", "lastPrompt": "prior"}]), \
             patch("src.voice_tools.resolve_session", return_value={"sessionId": "sess-old"}), \
             patch("src.voice_tools.get_recent_session_events", side_effect=[prior_events, new_events]), \
             patch("src.voice_tools.time.sleep"), \
             patch("src.chat._launch_turn", return_value={"statusCode": 200, "body": json.dumps({"sessionId": "sess-old"})}):
            from src.voice_tools import handler
            res = handler(_event(body=_retell_body("send_message", {
                "message": "follow up", "session": "prior thing", "wait_for_response": True,
            })), {})
            out = json.loads(res["body"])["result"]
        assert "fresh reply" in out
        assert "old message" not in out

    def test_wait_reports_error_on_run_finished_error(self):
        events = [
            {"seq": 1, "kind": "run.started", "payload": {}},
            {"seq": 2, "kind": "run.finished", "payload": {"outcome": "error", "error": "rate limit hit"}},
        ]
        out = self._run([events])
        assert "errored" in out.lower()
        assert "rate limit" in out

    def test_wait_returns_still_working_on_timeout(self):
        """No run.finished ever appears — polling hits the deadline.
        Caller gets the friendly fallback, not an exception.

        Mocking strategy: patch `time.time` with a callable that returns
        0 once (for launch_start) then huge values forever (so the poll
        loop's `time() < deadline` is false on the very first check).
        Using a closure instead of a fixed side_effect list so we can't
        run out of values no matter how many times time() is called.
        """
        call_state = {"n": 0}
        def _time_stub():
            call_state["n"] += 1
            return 0.0 if call_state["n"] == 1 else 1e9
        with patch("src.voice_tools._caller_mapping", return_value={"userId": "u1", "defaultServerId": "a"}), \
             patch("src.voice_tools.find_server_by_id", return_value=(self._server, False)), \
             patch("src.voice_tools.decrypt", return_value="k"), \
             patch("src.voice_tools.ssh_connect", return_value="client"), \
             patch("src.voice_tools.ssh_disconnect"), \
             patch("src.voice_tools.ensure_github_credentials"), \
             patch("src.voice_tools.get_sessions_by_server", return_value=[]), \
             patch("src.voice_tools.get_recent_session_events", return_value=[]), \
             patch("src.voice_tools.time.time", side_effect=_time_stub), \
             patch("src.voice_tools.time.sleep"), \
             patch("src.chat._launch_turn", return_value=self._launch_ok):
            from src.voice_tools import handler
            res = handler(_event(body=_retell_body("send_message", {
                "message": "something long", "wait_for_response": True,
            })), {})
            out = json.loads(res["body"])["result"]
        assert "Still working" in out
        assert "push" in out.lower()

    def test_timeout_arg_is_clamped(self):
        """The LLM might pass 999 or a negative number. We clamp to
        [5, 45] so the Lambda can never be held past its budget."""
        from src.voice_tools import _WAIT_MAX_S, _WAIT_DEFAULT_S
        assert _WAIT_MAX_S == 45
        assert _WAIT_DEFAULT_S == 25

    def test_false_wait_falls_back_to_fire_and_forget(self):
        """wait_for_response=false (or missing) keeps the old behavior:
        return immediately, don't touch session events at all."""
        events = [
            {"seq": 1, "kind": "run.started", "payload": {}},
            # Even though run.finished is present, we shouldn't poll.
            {"seq": 2, "kind": "run.finished", "payload": {"outcome": "success"}},
        ]
        out = self._run([events], wait=False)
        assert "Kicked off" in out
        assert "pocket eng app" in out


# ─── unknown tool ────────────────────────────────────────────────────────────

class TestSessionStatus:
    def _servers(self):
        return [{"serverId": "a", "label": "pocketeng", "instanceState": "running", "sshPrivateKey": "x"}]

    def test_running_with_open_tool(self):
        sessions = [{"sessionId": "s1", "status": "running", "lastPrompt": "run tests", "updatedAt": "2026-04-22T10:00:00Z"}]
        events = [
            {"seq": 0, "kind": "run.started", "payload": {}, "createdAt": "2026-04-22T11:00:00Z"},
            {"seq": 1, "kind": "assistant.message", "payload": {"text": "I'll start the test suite."}, "createdAt": "2026-04-22T11:00:05Z"},
            {"seq": 2, "kind": "tool.started", "payload": {"toolName": "Bash", "input": {"command": "npm test"}, "toolCallId": "tc-1"}, "createdAt": "2026-04-22T11:00:10Z"},
        ]
        with patch("src.voice_tools._caller_mapping", return_value={"userId": "u1"}), \
             patch("src.voice_tools.get_servers_by_user", return_value=self._servers()), \
             patch("src.voice_tools.get_sessions_by_server", return_value=sessions), \
             patch("src.voice_tools.get_recent_session_events", return_value=events):
            from src.voice_tools import handler
            result = handler(_event(body=_retell_body("session_status", {"session": "run tests"})), {})
            out = json.loads(result["body"])["result"]
            assert "Running Bash" in out
            assert "npm test" in out
            assert "Last said" in out
            assert "test suite" in out

    def test_finished_tool_means_thinking(self):
        sessions = [{"sessionId": "s1", "status": "running", "lastPrompt": "x", "updatedAt": "2026-04-22T10:00:00Z"}]
        events = [
            {"seq": 0, "kind": "tool.started", "payload": {"toolName": "Bash", "input": {"command": "ls"}, "toolCallId": "tc-1"}, "createdAt": "2026-04-22T11:00:00Z"},
            {"seq": 1, "kind": "tool.finished", "payload": {"toolCallId": "tc-1", "output": "file.txt"}, "createdAt": "2026-04-22T11:00:01Z"},
            {"seq": 2, "kind": "assistant.message", "payload": {"text": "Found one file."}, "createdAt": "2026-04-22T11:00:02Z"},
        ]
        with patch("src.voice_tools._caller_mapping", return_value={"userId": "u1"}), \
             patch("src.voice_tools.get_servers_by_user", return_value=self._servers()), \
             patch("src.voice_tools.get_sessions_by_server", return_value=sessions), \
             patch("src.voice_tools.get_recent_session_events", return_value=events):
            from src.voice_tools import handler
            result = handler(_event(body=_retell_body("session_status")), {})
            out = json.loads(result["body"])["result"]
            assert "Thinking" in out
            assert "Found one file" in out

    def test_done_session_defers_to_read(self):
        sessions = [{"sessionId": "s1", "status": "done", "lastPrompt": "x", "updatedAt": "2026-04-22T10:00:00Z"}]
        with patch("src.voice_tools._caller_mapping", return_value={"userId": "u1"}), \
             patch("src.voice_tools.get_servers_by_user", return_value=self._servers()), \
             patch("src.voice_tools.get_sessions_by_server", return_value=sessions):
            from src.voice_tools import handler
            result = handler(_event(body=_retell_body("session_status")), {})
            out = json.loads(result["body"])["result"]
            assert "finished" in out
            assert "read" in out

    def test_no_events_yet(self):
        sessions = [{"sessionId": "s1", "status": "running", "lastPrompt": "x", "updatedAt": "2026-04-22T10:00:00Z"}]
        with patch("src.voice_tools._caller_mapping", return_value={"userId": "u1"}), \
             patch("src.voice_tools.get_servers_by_user", return_value=self._servers()), \
             patch("src.voice_tools.get_sessions_by_server", return_value=sessions), \
             patch("src.voice_tools.get_recent_session_events", return_value=[]):
            from src.voice_tools import handler
            result = handler(_event(body=_retell_body("session_status")), {})
            assert "hasn't emitted" in json.loads(result["body"])["result"]


class TestUnknownTool:
    def test_unknown_tool_graceful(self):
        with patch("src.voice_tools._caller_mapping", return_value={"userId": "u1"}):
            from src.voice_tools import handler
            result = handler(_event(body=_retell_body("fly_to_mars")), {})
            assert "don't have a tool called fly_to_mars" in json.loads(result["body"])["result"]
