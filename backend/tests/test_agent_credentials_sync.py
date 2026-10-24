"""Unit tests for src/lib/agent_credentials_sync.py — the shape-detection
that decides whether a stored credential blob gets SFTP'd verbatim
(OAuth bundle) or extracted as a raw key for env-var injection.

Pure tests — no SSH, no DDB, no decrypt. We import the private
helpers directly and exercise the JSON shapes."""
import json
import os

os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")

from src.lib.agent_credentials_sync import (
    _OAUTH_PATH,
    _OPENCODE_AUTH_PATH,
    _detect_shape,
    _extract_api_key,
)


# ─── Claude ──────────────────────────────────────────────────────────────────

class TestClaudeShapes:
    def test_oauth_bundle_recognized(self):
        blob = json.dumps({
            "claudeAiOauth": {
                "accessToken": "eyJ…",
                "refreshToken": "eyJ…",
                "expiresAt": 1_700_000_000_000,
                "scopes": ["user:inference"],
                "subscriptionType": "max",
            }
        })
        shape, data = _detect_shape("claude", blob)
        assert shape == "oauth-json"
        assert data["claudeAiOauth"]["subscriptionType"] == "max"

    def test_bare_api_key_recognized(self):
        blob = json.dumps({"apiKey": "sk-ant-api03-XXXXX"})
        shape, data = _detect_shape("claude", blob)
        assert shape == "bare-key"
        assert data == "sk-ant-api03-XXXXX"


# ─── Codex ───────────────────────────────────────────────────────────────────

class TestCodexShapes:
    def test_oauth_tokens_dict_recognized(self):
        blob = json.dumps({
            "OPENAI_API_KEY": None,
            "tokens": {
                "id_token": "x",
                "access_token": "x",
                "refresh_token": "x",
                "account_id": None,
            },
            "last_refresh": "2026-04-26T00:00:00Z",
        })
        shape, data = _detect_shape("codex", blob)
        assert shape == "oauth-json"

    def test_bare_api_key_recognized(self):
        blob = json.dumps({"OPENAI_API_KEY": "sk-XXXXX"})
        shape, data = _detect_shape("codex", blob)
        assert shape == "bare-key"
        assert data == "sk-XXXXX"


# ─── Cursor (this PR) ────────────────────────────────────────────────────────

class TestCursorShapes:
    """Cursor's OAuth bundle came from cursor-oauth.ts. Real bundle from
    a live `cursor-agent login` had only two top-level fields: accessToken
    and refreshToken, both JWTs. Both must be present to count as OAuth —
    one alone isn't enough to differentiate from a hand-pasted bundle."""

    def test_oauth_bundle_with_both_tokens(self):
        blob = json.dumps({
            "accessToken": "eyJhbGciOiJIUzI1NiIs…",
            "refreshToken": "eyJhbGciOiJIUzI1NiIs…",
        })
        shape, data = _detect_shape("cursor", blob)
        assert shape == "oauth-json"
        assert "accessToken" in data
        assert "refreshToken" in data

    def test_only_accessToken_is_NOT_oauth(self):
        # Defensive: if a hand-pasted blob has accessToken alone, treat it
        # as unknown (or bare-key if it happens to match the key extractor).
        # Critical: must not be detected as OAuth — would write a malformed
        # auth.json and brick cursor-agent on the next session launch.
        blob = json.dumps({"accessToken": "eyJ…"})
        shape, _ = _detect_shape("cursor", blob)
        assert shape != "oauth-json"

    def test_bare_api_key_recognized(self):
        blob = json.dumps({"CURSOR_API_KEY": "crsr_XXXXX"})
        shape, data = _detect_shape("cursor", blob)
        assert shape == "bare-key"
        assert data == "crsr_XXXXX"

    def test_oauth_path_configured(self):
        # The path was discovered empirically by running cursor-agent
        # login on a real EC2 workspace and watching where the file
        # appeared. Lock it in so a future refactor doesn't move it
        # without re-verifying.
        assert _OAUTH_PATH["cursor"] == "~/.config/cursor/auth.json"


# ─── OpenCode (Zen API key) ──────────────────────────────────────────────────

class TestOpencodeShapes:
    """OpenCode is a multi-provider client. We only handle the OpenCode-Zen
    API-key path; OAuth flows for upstream providers (Anthropic, OpenAI)
    go through THOSE agents' own creds, not opencode's."""

    def test_zen_api_key_recognized(self):
        # `_wrap_raw_api_key` in agent_credentials.py produces this shape.
        blob = json.dumps({"OPENCODE_API_KEY": "sk-zen-XXXXX"})
        shape, data = _detect_shape("opencode", blob)
        assert shape == "bare-key"
        assert data == "sk-zen-XXXXX"

    def test_apikey_alias_recognized(self):
        # Defensive: backend's _wrap_raw_api_key uses OPENCODE_API_KEY,
        # but if a user hand-pastes a blob with `apiKey` instead, the
        # extractor's candidate-walk should still find it.
        blob = json.dumps({"apiKey": "sk-zen-YYYYY"})
        shape, data = _detect_shape("opencode", blob)
        assert shape == "bare-key"
        assert data == "sk-zen-YYYYY"

    def test_auth_path_locked(self):
        # The path opencode-ai reads at runtime, verified by running
        # `opencode auth login` on a real machine. If this constant
        # changes, the user's saved key suddenly stops working.
        assert _OPENCODE_AUTH_PATH == "~/.local/share/opencode/auth.json"


# ─── Cross-agent: malformed blobs ────────────────────────────────────────────

class TestMalformed:
    def test_invalid_json_is_unknown(self):
        shape, _ = _detect_shape("claude", "not json")
        assert shape == "unknown"

    def test_array_root_is_unknown(self):
        # JSON parses but isn't a dict — used to crash _extract_api_key
        # before we added the isinstance check.
        shape, _ = _detect_shape("cursor", json.dumps(["a", "b"]))
        assert shape == "unknown"

    def test_unknown_agent_falls_through(self):
        # A blob keyed for some agent we've never heard of: no OAuth
        # marker, no key extractor → unknown.
        blob = json.dumps({"random": "field"})
        shape, _ = _detect_shape("github-copilot", blob)
        assert shape == "unknown"


# ─── _extract_api_key precedence ─────────────────────────────────────────────

class TestExtractApiKey:
    def test_finds_first_matching_field(self):
        # Cursor's candidates list is ["CURSOR_API_KEY", "apiKey"] — first
        # matching field wins.
        parsed = {"apiKey": "first", "CURSOR_API_KEY": "second"}
        assert _extract_api_key("cursor", parsed) == "second"

    def test_returns_none_when_no_candidates_match(self):
        parsed = {"unrelated": "value"}
        assert _extract_api_key("cursor", parsed) is None

    def test_unknown_agent_returns_none(self):
        assert _extract_api_key("opencode", {"any": "thing"}) is None
