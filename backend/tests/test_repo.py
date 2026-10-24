"""Unit tests for repo.py — authenticated repo browsing via SSH."""
import json
import os
from unittest.mock import MagicMock, patch

os.environ.setdefault("SUPABASE_URL", "https://test.supabase.co")
os.environ.setdefault("SUPABASE_JWT_SECRET", "test-secret")
os.environ.setdefault("SERVERS_TABLE", "pe-servers-test")
os.environ.setdefault("SESSIONS_TABLE", "pe-sessions-test")
os.environ.setdefault("KMS_KEY_ID", "test-key-id")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")

FAKE_CLAIMS = {"sub": "user-123"}
FAKE_SERVER = {
    "serverId": "srv-1",
    "userId": "user-123",
    "instanceState": "running",
    "publicIp": "1.2.3.4",
    "sshPrivateKey": "encrypted-key",
    "sshUser": "ec2-user",
}
FAKE_SESSION = {
    "sessionId": "sess-1",
    "serverId": "srv-1",
    "userId": "user-123",
    "worktreePath": "/home/ec2-user/projects/app-worktrees/sess-1",
    "repoDir": "/home/ec2-user/projects/app",
}


def _event(query=None):
    return {
        "headers": {"authorization": "Bearer fake-token"},
        "pathParameters": {"serverId": "srv-1"},
        "queryStringParameters": query or {},
    }


def _payload(kind="directory"):
    return {
        "kind": kind,
        "rootPath": "/tmp/app",
        "repoRoot": "/tmp/app",
        "currentPath": "" if kind == "directory" else "README.md",
        "branch": "main",
        "isGitRepo": True,
        "breadcrumbs": [{"name": "workspace", "path": ""}],
        "entries": [] if kind == "directory" else None,
        "name": "app" if kind == "directory" else "README.md",
        "content": "hello" if kind == "file" else None,
        "size": 5 if kind == "file" else None,
        "gitStatus": "modified" if kind == "file" else None,
        "binary": False if kind == "file" else None,
        "truncated": False if kind == "file" else None,
    }


class TestRepoAuth:
    def test_returns_401_when_verify_token_fails(self):
        with patch("src.repo.verify_token", side_effect=Exception("bad token")):
            from src.repo import handler
            result = handler(_event(), {})
            assert result["statusCode"] == 401


class TestRepoBrowsing:
    def _call(self, query=None, session=FAKE_SESSION, ssh_output=None):
        if ssh_output is None:
            ssh_output = (json.dumps(_payload()), "", 0)

        with patch("src.repo.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.repo.get_server", return_value=FAKE_SERVER), \
             patch("src.repo.get_session", return_value=session), \
             patch("src.repo.decrypt", return_value="decrypted-key"), \
             patch("src.repo.ssh_connect", return_value=MagicMock()), \
             patch("src.repo.ssh_exec", return_value=ssh_output) as mock_exec, \
             patch("src.repo.ssh_disconnect"):
            from src.repo import handler
            result = handler(_event(query), {})
            return result, mock_exec

    def test_returns_200_with_directory_payload(self):
        result, _ = self._call({"sessionId": "sess-1"})
        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert body["kind"] == "directory"
        assert body["isGitRepo"] is True

    def test_uses_session_worktree_as_primary_anchor(self):
        _, mock_exec = self._call({"sessionId": "sess-1"})
        command = mock_exec.call_args[0][1]
        assert FAKE_SESSION["worktreePath"] in command
        assert FAKE_SESSION["repoDir"] in command

    def test_falls_back_to_workdir_without_session(self):
        from src.repo import _build_remote_command

        command = _build_remote_command(
            "~/projects/demo app",
            "~/projects/demo app",
            "",
        )
        assert "~/projects/demo app" in command

    def test_returns_404_when_session_missing(self):
        with patch("src.repo.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.repo.get_server", return_value=FAKE_SERVER), \
             patch("src.repo.get_session", return_value=None):
            from src.repo import handler
            result = handler(_event({"sessionId": "missing"}), {})
            assert result["statusCode"] == 404

    def test_returns_403_when_session_belongs_to_other_user(self):
        other_session = {**FAKE_SESSION, "userId": "other-user"}
        result, _ = self._call({"sessionId": "sess-1"}, session=other_session)
        assert result["statusCode"] == 403

    def test_returns_400_when_session_belongs_to_other_server(self):
        other_session = {**FAKE_SESSION, "serverId": "srv-2"}
        result, _ = self._call({"sessionId": "sess-1"}, session=other_session)
        assert result["statusCode"] == 400

    def test_returns_404_for_missing_remote_path(self):
        result, _ = self._call(
            {"sessionId": "sess-1", "path": "missing.txt"},
            ssh_output=(json.dumps({"error": "Requested path does not exist", "errorCode": "not_found"}), "", 1),
        )
        assert result["statusCode"] == 404
        body = json.loads(result["body"])
        assert body["error"] == "Requested path does not exist"

    def test_returns_400_for_path_escape(self):
        result, _ = self._call(
            {"sessionId": "sess-1", "path": "../secret"},
            ssh_output=(json.dumps({"error": "Requested path escapes the repo root", "errorCode": "outside_root"}), "", 1),
        )
        assert result["statusCode"] == 400

    def test_returns_file_payload(self):
        result, _ = self._call(
            {"sessionId": "sess-1", "path": "README.md"},
            ssh_output=(json.dumps(_payload(kind="file")), "", 0),
        )
        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert body["kind"] == "file"
        assert body["content"] == "hello"


# ─── Team-resource access ────────────────────────────────────────────────────

_TEAM_SERVER = {**FAKE_SERVER, "ownerType": "team", "teamId": "team-1", "userId": "user-other"}
_TEAM_SESSION = {
    **FAKE_SESSION,
    "ownerType": "team",
    "teamId": "team-1",
    "userId": "user-other",
    "createdByUserId": "user-other",
}


class TestRepoTeamAccess:
    def test_team_member_can_browse_teammates_session_repo(self):
        client = MagicMock()
        with patch("src.repo.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.repo.get_server", return_value=_TEAM_SERVER), \
             patch("src.repo.get_session", return_value=_TEAM_SESSION), \
             patch("src.repo.decrypt", return_value="decrypted-key"), \
             patch("src.repo.ssh_connect", return_value=client), \
             patch("src.repo.ssh_exec", return_value=(json.dumps(_payload()), "", 0)), \
             patch("src.repo.ssh_disconnect"), \
             patch("src.lib.team_auth.get_team_membership", return_value={"status": "active", "role": "member"}):
            from src.repo import handler
            result = handler(_event({"sessionId": "sess-1"}), {})

        assert result["statusCode"] == 200

    def test_non_member_blocked_from_team_session_repo(self):
        with patch("src.repo.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.repo.get_server", return_value=_TEAM_SERVER), \
             patch("src.repo.get_session", return_value=_TEAM_SESSION), \
             patch("src.lib.team_auth.get_team_membership", return_value=None):
            from src.repo import handler
            result = handler(_event({"sessionId": "sess-1"}), {})

        assert result["statusCode"] == 403
