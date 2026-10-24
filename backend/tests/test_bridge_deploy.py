"""Unit tests for the bridge SFTP deployer.

We don't want to stand up a real SSH server in tests, so we mock the
paramiko client surface (ssh_exec + transport.open_sftp_client) and assert
on the calls we make through it.
"""
import os
from unittest.mock import MagicMock, patch


class _FakeSftpFile:
    def __init__(self, owner, path):
        self._owner = owner
        self._path = path
        self._buf = bytearray()

    def write(self, data):
        self._buf.extend(data)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self._owner._writes[self._path] = bytes(self._buf)
        return False


class _FakeSftp:
    def __init__(self):
        self._writes = {}
        self._closed = False

    def file(self, path, mode):
        return _FakeSftpFile(self, path)

    def close(self):
        self._closed = True


def _fake_client():
    client = MagicMock()
    transport = MagicMock()
    sftp = _FakeSftp()
    transport.open_sftp_client.return_value = sftp
    client.get_transport.return_value = transport
    return client, sftp


class TestBridgeFileDiscovery:
    def test_discovers_all_current_modules(self):
        from src.lib.bridge_deploy import BRIDGE_FILES
        # All three live in the repo today; if we add a new .mjs module the
        # discovery should pick it up automatically.
        for expected in ("bridge.mjs", "uploader.mjs", "claude_events.mjs"):
            assert expected in BRIDGE_FILES, f"{expected} missing from BRIDGE_FILES"

    def test_skips_test_files(self):
        from src.lib.bridge_deploy import BRIDGE_FILES
        assert all(not f.endswith(".test.mjs") for f in BRIDGE_FILES)


class TestVersionHash:
    def test_is_stable(self):
        from src.lib.bridge_deploy import _bridge_version
        assert _bridge_version() == _bridge_version()

    def test_changes_when_file_changes(self, tmp_path, monkeypatch):
        import src.lib.bridge_deploy as bd
        # Pin BRIDGE_SRC_DIR + BRIDGE_FILES to a controlled tempdir so the
        # hash is a pure function of what we write here.
        (tmp_path / "bridge.mjs").write_bytes(b"// one\n")
        (tmp_path / "uploader.mjs").write_bytes(b"// two\n")
        monkeypatch.setattr(bd, "BRIDGE_SRC_DIR", str(tmp_path))
        monkeypatch.setattr(bd, "BRIDGE_FILES", ("bridge.mjs", "uploader.mjs"))
        v1 = bd._bridge_version()
        (tmp_path / "bridge.mjs").write_bytes(b"// one-changed\n")
        v2 = bd._bridge_version()
        assert v1 != v2


class TestEnsureBridgeDeployed:
    def test_skips_upload_when_remote_version_matches(self):
        from src.lib.bridge_deploy import ensure_bridge_deployed, _bridge_version
        local = _bridge_version()
        client, sftp = _fake_client()
        with patch("src.lib.bridge_deploy.ssh_exec", return_value=(local, "", 0)) as mock_ssh:
            result = ensure_bridge_deployed(client)
        assert result == local
        # SDK-deps + symlink ssh_exec runs on every call; version read too.
        # No SFTP writes because the hash matched.
        assert mock_ssh.call_count == 2
        assert sftp._writes == {}

    def test_uploads_when_remote_version_missing(self):
        from src.lib.bridge_deploy import ensure_bridge_deployed, _bridge_version
        client, sftp = _fake_client()
        with patch("src.lib.bridge_deploy.ssh_exec") as mock_ssh:
            # version read → empty, then mkdir+symlink, then one `echo $HOME`
            # per file write (bridge files + .version)
            mock_ssh.side_effect = (
                [("", "", 0), ("", "", 0)]
                + [("/home/ec2-user", "", 0)] * 10
            )
            result = ensure_bridge_deployed(client)
        assert result == _bridge_version()
        # One SFTP write per discovered bridge file, plus .version.
        paths = set(sftp._writes.keys())
        assert any(p.endswith("/bridge.mjs") for p in paths)
        assert any(p.endswith("/uploader.mjs") for p in paths)
        assert any(p.endswith("/claude_events.mjs") for p in paths)
        assert any(p.endswith("/.version") for p in paths)

    def test_uploads_when_remote_version_mismatch(self):
        from src.lib.bridge_deploy import ensure_bridge_deployed, _bridge_version
        client, sftp = _fake_client()
        with patch("src.lib.bridge_deploy.ssh_exec") as mock_ssh:
            mock_ssh.side_effect = (
                [("stale-hash", "", 0), ("", "", 0)]
                + [("/home/ec2-user", "", 0)] * 10
            )
            ensure_bridge_deployed(client)
        # One write per bridge file + one for .version
        assert len(sftp._writes) >= 3

    def test_writes_current_version_string(self):
        from src.lib.bridge_deploy import ensure_bridge_deployed, _bridge_version
        client, sftp = _fake_client()
        with patch("src.lib.bridge_deploy.ssh_exec") as mock_ssh:
            mock_ssh.side_effect = (
                [("", "", 0), ("", "", 0)]
                + [("/home/ec2-user", "", 0)] * 10
            )
            ensure_bridge_deployed(client)
        version_files = [p for p in sftp._writes if p.endswith("/.version")]
        assert version_files
        assert sftp._writes[version_files[0]].decode() == _bridge_version()

    def test_directory_setup_runs_mkdir_symlink_and_sdk_install(self):
        from src.lib.bridge_deploy import ensure_bridge_deployed
        client, _sftp = _fake_client()
        with patch("src.lib.bridge_deploy.ssh_exec") as mock_ssh:
            mock_ssh.side_effect = (
                [("", "", 0), ("", "", 0)]
                + [("/home/ec2-user", "", 0)] * 10
            )
            ensure_bridge_deployed(client)
        # First ssh_exec is the SDK-deps + symlink command.
        setup_cmd = mock_ssh.call_args_list[0].args[1]
        assert "mkdir -p" in setup_cmd
        assert "npm root -g" in setup_cmd
        assert "ln -sfn" in setup_cmd
        assert "@anthropic-ai/claude-agent-sdk" in setup_cmd
        assert "sudo -n npm install" in setup_cmd

    def test_uploaded_bridge_mjs_matches_local_source(self):
        from src.lib.bridge_deploy import ensure_bridge_deployed, BRIDGE_SRC_DIR
        client, sftp = _fake_client()
        with patch("src.lib.bridge_deploy.ssh_exec") as mock_ssh:
            mock_ssh.side_effect = [("", "", 0), ("", "", 0)] + [("/home/ec2-user", "", 0)] * 10
            ensure_bridge_deployed(client)
        remote_bridge = next(v for k, v in sftp._writes.items() if k.endswith("/bridge.mjs"))
        with open(os.path.join(BRIDGE_SRC_DIR, "bridge.mjs"), "rb") as f:
            local_bridge = f.read()
        assert remote_bridge == local_bridge
