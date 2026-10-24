"""Tests for the remote completion callback handler."""
import json
import os
from unittest.mock import MagicMock, patch

os.environ.setdefault("COMPLETION_CALLBACK_SECRET", "test-completion-secret")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")


def _make_event(secret="test-completion-secret"):
    return {
        "headers": {
            "x-pocketengineer-completion-secret": secret,
        },
        "pathParameters": {
            "sessionId": "sess-1",
        },
        "body": json.dumps({
            "serverId": "srv-1",
            "pid": "123",
        }),
    }


class TestCompletionHook:
    def test_rejects_wrong_secret(self):
        from src.completion_hook import handler

        result = handler(_make_event(secret="wrong-secret"), {})

        assert result["statusCode"] == 401

    def test_finalizes_session_output(self):
        with patch("src.completion_hook.get_session", return_value={
            "sessionId": "sess-1",
            "serverId": "srv-1",
            "currentRunOffset": 4,
        }), \
             patch("src.completion_hook.get_server", return_value={
                 "serverId": "srv-1",
                 "publicIp": "1.2.3.4",
                 "sshPrivateKey": "encrypted",
                 "sshUser": "ec2-user",
             }), \
             patch("src.completion_hook.decrypt", return_value="private-key"), \
             patch("src.completion_hook.ssh_connect", return_value=MagicMock()), \
             patch("src.completion_hook.ssh_disconnect"), \
             patch("src.completion_hook._complete_session_and_notify") as mock_complete, \
             patch("src.completion_hook.sync_session_output", return_value={
                 "offset": 8,
                 "done": True,
                 "lines": [],
             }) as mock_sync:
            from src.completion_hook import handler

            result = handler(_make_event(), {})

            assert result["statusCode"] == 200
            mock_sync.assert_called_once()
            args = mock_sync.call_args.args
            kwargs = mock_sync.call_args.kwargs
            assert args[1] == "sess-1"
            assert kwargs["offset"] == 4
            # The completion hook passes notify_on_done=False and is itself
            # authoritative — it always calls _complete_session_and_notify
            # regardless of whether the wrapper PID appears alive.
            assert kwargs["notify_on_done"] is False
            mock_complete.assert_called_once_with("sess-1")
