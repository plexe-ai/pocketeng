"""Unit tests for the workspace-overview surface.

Covers:
  - action.py:update-overview validation (description / components shape)
  - chat.py:_list_docs + _read_doc (SSH-mediated)
  - pricing.estimate_monthly_usd
"""
from __future__ import annotations

import json
import os
from unittest.mock import MagicMock, patch

os.environ.setdefault("COMPLETION_CALLBACK_SECRET", "test-completion-secret")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
os.environ.setdefault("SUPABASE_URL", "https://test.supabase.co")
os.environ.setdefault("SUPABASE_JWT_SECRET", "test-jwt-secret")


# ─── update-overview ────────────────────────────────────────────────────

def _action_event(body, server_id="srv-1"):
    return {
        "headers": {"authorization": "Bearer fake"},
        "pathParameters": {"serverId": server_id},
        "body": json.dumps(body),
    }


def _patch_action_basics(server=None):
    """Patches the common gauntlet — auth, server lookup, ownership check —
    so each test can focus on the update-overview branch alone."""
    server = server or {"serverId": "srv-1", "userId": "u-1", "envType": "general"}
    return [
        patch("src.action.verify_token", return_value={"sub": "u-1"}),
        patch("src.action.get_server", return_value=server),
        patch("src.action.can_access_owned_resource", return_value=True),
        patch("src.action.can_manage_owned_resource", return_value=True),
    ]


class TestUpdateOverview:
    def _run(self, body):
        ctx = _patch_action_basics()
        with ctx[0], ctx[1], ctx[2], ctx[3], \
             patch("src.action.update_server") as mock_update:
            from src.action import handler
            result = handler(_action_event({"action": "update-overview", **body}), {})
            return result, mock_update

    def test_accepts_description_and_components(self):
        result, mock_update = self._run({
            "description": "Recommendation pipeline",
            "components": [
                {"name": "Vector DB", "role": "qdrant", "port": 6333},
                {"name": "Embedder", "port": 8000},
            ],
        })
        assert result["statusCode"] == 200
        mock_update.assert_called_once()
        sid, updates = mock_update.call_args.args
        assert sid == "srv-1"
        assert updates["description"] == "Recommendation pipeline"
        assert len(updates["components"]) == 2
        assert updates["components"][0] == {"name": "Vector DB", "role": "qdrant", "port": 6333}
        # Optional fields are dropped when missing (no `role: None` noise).
        assert updates["components"][1] == {"name": "Embedder", "port": 8000}

    def test_description_only(self):
        result, mock_update = self._run({"description": "Just a description"})
        assert result["statusCode"] == 200
        assert mock_update.call_args.args[1] == {"description": "Just a description"}

    def test_components_only(self):
        result, mock_update = self._run({"components": [{"name": "Single"}]})
        assert result["statusCode"] == 200
        assert mock_update.call_args.args[1] == {"components": [{"name": "Single"}]}

    def test_rejects_oversize_description(self):
        result, _ = self._run({"description": "x" * 281})
        assert result["statusCode"] == 400
        assert "280" in json.loads(result["body"])["error"]

    def test_rejects_too_many_components(self):
        result, _ = self._run({
            "components": [{"name": f"c{i}"} for i in range(21)],
        })
        assert result["statusCode"] == 400

    def test_rejects_missing_name(self):
        result, _ = self._run({"components": [{"name": ""}]})
        assert result["statusCode"] == 400

    def test_rejects_bad_port_type(self):
        result, _ = self._run({"components": [{"name": "x", "port": "not-a-port"}]})
        assert result["statusCode"] == 400

    def test_rejects_out_of_range_port(self):
        result, _ = self._run({"components": [{"name": "x", "port": 99999}]})
        assert result["statusCode"] == 400

    def test_rejects_empty_update(self):
        # No description AND no components — there's nothing to update.
        # Better to 400 than silently no-op.
        result, _ = self._run({})
        assert result["statusCode"] == 400

    def test_non_admin_rejected(self):
        ctx_base = _patch_action_basics()
        # Override can_manage to False
        with ctx_base[0], ctx_base[1], ctx_base[2], \
             patch("src.action.can_manage_owned_resource", return_value=False):
            from src.action import handler
            result = handler(_action_event({
                "action": "update-overview",
                "description": "x",
            }), {})
            assert result["statusCode"] == 403


# ─── pricing ────────────────────────────────────────────────────────────

class TestPricing:
    def test_known_instance_with_gp3(self):
        from src.lib.pricing import estimate_monthly_usd, HOURS_PER_MONTH
        cost = estimate_monthly_usd("t3.medium", [{"sizeGB": 30, "type": "gp3"}])
        expected = round(0.0416 * HOURS_PER_MONTH + 0.08 * 30, 2)
        assert cost == expected

    def test_unknown_instance_returns_none(self):
        from src.lib.pricing import estimate_monthly_usd
        assert estimate_monthly_usd("p4d.24xlarge", []) is None

    def test_no_instance_returns_none(self):
        from src.lib.pricing import estimate_monthly_usd
        assert estimate_monthly_usd(None, [{"sizeGB": 100, "type": "gp3"}]) is None

    def test_unknown_volume_type_skipped_not_failed(self):
        from src.lib.pricing import estimate_monthly_usd, HOURS_PER_MONTH
        cost = estimate_monthly_usd("t3.medium", [{"sizeGB": 30, "type": "mystery"}])
        # Compute still priced, storage silently skipped.
        assert cost == round(0.0416 * HOURS_PER_MONTH, 2)


# ─── _list_docs + _read_doc ─────────────────────────────────────────────

class TestListDocs:
    def _exec(self, stdout, exit_code=0):
        mock = MagicMock()
        # ssh_exec returns (stdout, stderr, exit_code).
        mock.return_value = (stdout, "", exit_code)
        return mock

    def test_parses_find_output_into_relative_paths(self):
        from src import chat
        with patch.object(chat, "ssh_exec", self._exec(
            "./README.md\n./docs/setup.md\n./recsys/ARCHITECTURE.md\n"
        )):
            result = chat._list_docs(client=MagicMock())
        body = json.loads(result["body"])
        assert result["statusCode"] == 200
        paths = [d["path"] for d in body["docs"]]
        assert paths == ["README.md", "docs/setup.md", "recsys/ARCHITECTURE.md"]
        assert body["docs"][0]["name"] == "README.md"
        assert body["docs"][1]["name"] == "setup.md"

    def test_missing_projects_dir_returns_empty_not_error(self):
        # find with no output AND non-zero exit code = directory missing.
        # Returning an empty list keeps the UI quiet on fresh workspaces.
        from src import chat
        with patch.object(chat, "ssh_exec", self._exec("", exit_code=1)):
            result = chat._list_docs(client=MagicMock())
        assert result["statusCode"] == 200
        assert json.loads(result["body"]) == {"docs": []}


class TestReadDoc:
    def _exec(self, stdout, exit_code=0):
        mock = MagicMock()
        mock.return_value = (stdout, "", exit_code)
        return mock

    def test_reads_doc(self):
        from src import chat
        with patch.object(chat, "ssh_exec", self._exec("# Hello\n\nContents")):
            result = chat._read_doc(client=MagicMock(), body={"path": "README.md"})
        body = json.loads(result["body"])
        assert result["statusCode"] == 200
        assert body["path"] == "README.md"
        assert body["content"] == "# Hello\n\nContents"
        assert body["truncated"] is False

    def test_truncates_oversize(self):
        from src import chat
        # head -c (MAX+1) returns MAX+1 bytes if file was bigger.
        # We slice to MAX and report truncated=True.
        big = "x" * (chat._DOCS_MAX_BYTES + 1)
        with patch.object(chat, "ssh_exec", self._exec(big)):
            result = chat._read_doc(client=MagicMock(), body={"path": "big.md"})
        body = json.loads(result["body"])
        assert body["truncated"] is True
        assert len(body["content"]) == chat._DOCS_MAX_BYTES

    def test_rejects_absolute_path(self):
        from src import chat
        result = chat._read_doc(client=MagicMock(), body={"path": "/etc/passwd"})
        assert result["statusCode"] == 400

    def test_rejects_tilde_path(self):
        from src import chat
        result = chat._read_doc(client=MagicMock(), body={"path": "~/.ssh/id_rsa"})
        assert result["statusCode"] == 400

    def test_rejects_dotdot_traversal(self):
        from src import chat
        result = chat._read_doc(client=MagicMock(), body={"path": "../../../etc/passwd"})
        assert result["statusCode"] == 400

    def test_rejects_non_markdown_extension(self):
        from src import chat
        result = chat._read_doc(client=MagicMock(), body={"path": "secrets.env"})
        assert result["statusCode"] == 400

    def test_rejects_empty_path(self):
        from src import chat
        result = chat._read_doc(client=MagicMock(), body={"path": ""})
        assert result["statusCode"] == 400

    def test_handles_nonexistent_file(self):
        from src import chat
        with patch.object(chat, "ssh_exec", self._exec("", exit_code=1)):
            result = chat._read_doc(client=MagicMock(), body={"path": "missing.md"})
        assert result["statusCode"] == 404


# ─── detect-architecture ────────────────────────────────────────────────

class TestDetectArchitecture:
    """The detector chains four SSH commands. We mock ssh_exec to return
    a scripted sequence — one tuple per call, in order — so each test
    isolates which signal it's exercising."""

    def _scripted_exec(self, *outputs):
        """Returns a side_effect that yields (stdout, '', 0) for each call."""
        seq = iter(outputs)
        def _next(_client, _cmd, **_kwargs):
            try:
                return (next(seq), "", 0)
            except StopIteration:
                return ("", "", 0)
        return _next

    def test_detects_listening_ports(self):
        from src import chat
        # Call order: ss → find compose → find py deps → find package.json.
        ss_output = (
            "127.0.0.1:8000  users:((\"uvicorn\",pid=123,fd=4))\n"
            "0.0.0.0:6333    users:((\"qdrant\",pid=456,fd=5))\n"
            "127.0.0.1:22    users:((\"sshd\",pid=1,fd=3))\n"  # Should be skipped
        )
        with patch.object(chat, "ssh_exec",
                          side_effect=self._scripted_exec(ss_output, "", "", "")):
            result = chat._detect_architecture(client=MagicMock())
        body = json.loads(result["body"])
        names = [s["name"] for s in body["suggestions"]]
        ports = [s.get("port") for s in body["suggestions"]]
        assert any("Uvicorn" in n for n in names)
        assert any("Qdrant" in n for n in names)
        assert all("sshd" not in n.lower() for n in names), "sshd should be filtered"
        assert 8000 in ports
        assert 6333 in ports

    def test_detects_python_deps(self):
        from src import chat
        # ss empty, no compose, requirements.txt next, no package.json.
        requirements = (
            "fastapi==0.110.0\n"
            "qdrant-client>=1.0\n"
            "openai\n"
            "# comment line\n"
            "\n"
        )
        with patch.object(chat, "ssh_exec",
                          side_effect=self._scripted_exec(
                              "",                     # ss
                              "",                     # find compose
                              "/home/ec2-user/projects/x/requirements.txt\n",  # find py
                              requirements,           # cat requirements
                              "",                     # find package.json
                          )):
            result = chat._detect_architecture(client=MagicMock())
        body = json.loads(result["body"])
        roles = [s.get("role") for s in body["suggestions"]]
        names = [s["name"] for s in body["suggestions"]]
        assert "fastapi" in roles
        assert "qdrant" in roles
        assert "openai" in roles
        # And the roles map to readable component names
        assert "API" in names
        assert "Vector DB" in names
        assert "LLM client" in names

    def test_detects_node_deps(self):
        from src import chat
        package_json = json.dumps({
            "name": "test",
            "dependencies": {
                "next": "^14.0.0",
                "openai": "^4.0.0",
                "@qdrant/js-client-rest": "^1.0.0",
            },
            "devDependencies": {"typescript": "^5.0.0"},
        })
        with patch.object(chat, "ssh_exec",
                          side_effect=self._scripted_exec(
                              "",                     # ss
                              "",                     # find compose
                              "",                     # find py
                              "/home/ec2-user/projects/x/package.json\n",  # find pkg
                              package_json,           # cat pkg
                          )):
            result = chat._detect_architecture(client=MagicMock())
        body = json.loads(result["body"])
        roles = [s.get("role") for s in body["suggestions"]]
        assert "nextjs" in roles
        assert "openai" in roles
        assert "qdrant" in roles

    def test_dedups_duplicate_signals(self):
        from src import chat
        # Same role from two signals (port + requirements) — only one entry.
        ss_output = "0.0.0.0:8000 users:((\"fastapi\",pid=1,fd=4))\n"
        requirements = "fastapi==0.110\n"
        with patch.object(chat, "ssh_exec",
                          side_effect=self._scripted_exec(
                              ss_output,
                              "",
                              "/home/ec2-user/projects/x/requirements.txt\n",
                              requirements,
                              "",
                          )):
            result = chat._detect_architecture(client=MagicMock())
        body = json.loads(result["body"])
        # The port-derived name ("Fastapi (:8000)") and the dep-derived name ("API")
        # are different so both survive — that's intentional (they're different
        # signals worth seeing). But if we add the same dep name twice the
        # dedup catches it.
        names = [s["name"] for s in body["suggestions"]]
        assert len(set(names)) == len(names)

    def test_empty_workspace_returns_empty_suggestions(self):
        from src import chat
        with patch.object(chat, "ssh_exec",
                          side_effect=self._scripted_exec("", "", "", "", "")):
            result = chat._detect_architecture(client=MagicMock())
        body = json.loads(result["body"])
        assert body == {"suggestions": []}


class TestComposeParser:
    """The line-by-line compose parser intentionally avoids a YAML lib.
    Test it covers the cases we actually see in customer workspaces."""

    def _collect(self, content):
        from src.chat import _parse_compose
        found = []
        def add(name, role, port=None):
            found.append({"name": name, "role": role, "port": port})
        _parse_compose(content, add)
        return found

    def test_simple_services(self):
        compose = """
services:
  qdrant:
    image: qdrant/qdrant
    ports:
      - "6333:6333"
  embedder:
    build: ./embedder
    ports:
      - "8000:8000"
"""
        found = self._collect(compose)
        names = {f["name"]: f["port"] for f in found}
        assert names["Qdrant"] == 6333
        assert names["Embedder"] == 8000

    def test_handles_unquoted_ports(self):
        compose = """
services:
  worker:
    ports:
      - 9999
"""
        found = self._collect(compose)
        assert any(f["name"] == "Worker" and f["port"] == 9999 for f in found)

    def test_ignores_non_services_block(self):
        compose = """
volumes:
  data:
networks:
  default:
"""
        assert self._collect(compose) == []
