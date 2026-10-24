"""
POST /account/agent-credentials — store a credential bundle for one coding agent.
GET  /account/agent-credentials — list which agents the caller has stored bundles for.
DELETE /account/agent-credentials?agent=<id> — remove a stored bundle.

The "credential bundle" is the raw contents of the agent's local credentials
file (e.g. ~/.claude/.credentials.json from `claude login`). We treat it as an
opaque JSON blob so the schema can change underneath us without code changes.

Stored encrypted at rest in DynamoDB. At session-launch time, the chat handler
fetches and writes the decrypted bundle to the matching path on the EC2 host
so the cloud agent runs as the user — same OAuth subscription, same identity.
"""
import json
from datetime import datetime, timezone

from src.lib.auth import extract_auth_header, verify_token
from src.lib.db import (
    delete_agent_credential,
    get_agent_credential,
    list_agent_credentials_for_user,
    put_agent_credential,
)
from src.lib.kms import encrypt

# Mirrors the desktop bridge enum + the runtime path map in chat.py.
_ALLOWED_AGENTS = {"claude", "codex", "cursor", "opencode"}

# Hard cap on credential blob size. The actual files are tiny (1-3 KB);
# anything larger than this is almost certainly the wrong file.
_MAX_BLOB_BYTES = 32 * 1024


def _wrap_raw_api_key(agent: str, raw_key: str) -> str:
    """Turn a bare API key into the JSON shape the agent's CLI expects at rest.

    We store everything as JSON so session-launch's file-write path is uniform.
    The agent reads this file exactly as if the user ran its login flow.
    """
    key = raw_key.strip()
    if agent == "claude":
        # Claude Code accepts {"apiKey": "..."} when ~/.claude/.credentials.json
        # exists in the absence of an OAuth bundle.
        return json.dumps({"apiKey": key})
    if agent == "codex":
        # Codex's ~/.codex/auth.json uses OPENAI_API_KEY as its top-level field.
        return json.dumps({"OPENAI_API_KEY": key})
    if agent == "cursor":
        # Cursor User API key (crsr_…) from cursor.com/dashboard/integrations.
        # Authenticates the CLI as the user's Cursor account and draws from
        # their Pro/Team plan credits — same billing pool as the IDE. The
        # session launcher exports it as CURSOR_API_KEY before running
        # cursor-agent.
        return json.dumps({"CURSOR_API_KEY": key})
    if agent == "opencode":
        # OpenCode Zen API key (sk-…) from opencode.ai/auth. Pay-per-token
        # billing from the user's prepaid Zen balance. Wrapped under
        # OPENCODE_API_KEY so agent_credentials_sync.py's `_extract_api_key`
        # finds it via the same candidate-walk logic used for the other
        # agents — actual file-write target is ~/.local/share/opencode/
        # auth.json with the multi-provider shape opencode-ai expects, not
        # an env var (opencode doesn't read OPENCODE_API_KEY at runtime).
        return json.dumps({"OPENCODE_API_KEY": key})
    # Fallback: wrap under "apiKey" — future-proof for new agents.
    return json.dumps({"apiKey": key})


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def respond(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def _summarize(item):
    """Public-safe view of a stored credential row — never includes the blob."""
    return {
        "agent": item["agent"],
        "createdAt": item.get("createdAt"),
        "updatedAt": item.get("updatedAt"),
        "source": item.get("source"),
        "identifier": item.get("identifier"),
    }


def handler(event, context):
    try:
        try:
            claims = verify_token(extract_auth_header(event.get("headers", {})))
        except Exception as exc:
            return respond(401, {"error": str(exc)})

        user_id = claims["sub"]
        method = (
            event.get("requestContext", {}).get("http", {}).get("method")
            or event.get("httpMethod")
            or "POST"
        ).upper()
        print(f"[agent-creds] {method} user={user_id}")

        if method == "GET":
            items = list_agent_credentials_for_user(user_id)
            return respond(200, {"credentials": [_summarize(it) for it in items]})

        if method == "DELETE":
            qs = event.get("queryStringParameters") or {}
            agent = (qs.get("agent") or "").strip().lower()
            if agent not in _ALLOWED_AGENTS:
                return respond(400, {"error": "agent must be one of: " + ", ".join(sorted(_ALLOWED_AGENTS))})
            delete_agent_credential(user_id, agent)
            return respond(200, {"ok": True, "agent": agent})

        # POST
        body = json.loads(event.get("body") or "{}")
        agent = str(body.get("agent") or "").strip().lower()
        raw_api_key = str(body.get("apiKey") or "").strip()
        contents = body.get("contents") or ""
        source = (body.get("source") or "").strip().lower()
        identifier = body.get("identifier")  # optional human label

        if agent not in _ALLOWED_AGENTS:
            return respond(400, {"error": "agent must be one of: " + ", ".join(sorted(_ALLOWED_AGENTS))})

        # Two accepted shapes:
        #   { agent, contents: <raw JSON> }  — from desktop auto-import
        #   { agent, apiKey: "sk-..." }      — from manual paste
        if raw_api_key:
            contents = _wrap_raw_api_key(agent, raw_api_key)
            if not source:
                source = "api-key"

        if not isinstance(contents, str) or not contents.strip():
            return respond(400, {"error": "contents or apiKey required"})
        if len(contents.encode("utf-8")) > _MAX_BLOB_BYTES:
            return respond(400, {"error": "credential blob too large"})

        # Sanity check: must be valid JSON. We don't enforce a shape (Claude /
        # Codex / Cursor all use different schemas), but it must parse.
        try:
            json.loads(contents)
        except json.JSONDecodeError:
            return respond(400, {"error": "contents must be valid JSON"})

        # 'browser-oauth' is the subscription login path — bundle arrives
        # pre-shaped from the Electron desktop's Anthropic OAuth flow
        # (desktop/src/main/anthropic-oauth.ts). The JSON-shape check below
        # still applies, so only properly-formed bundles get in.
        if source and source not in {"file", "keychain", "api-key", "browser-oauth"}:
            return respond(400, {"error": "source must be 'file', 'keychain', 'api-key', or 'browser-oauth'"})

        now = _now_iso()
        existing = get_agent_credential(user_id, agent)
        item = {
            "userId": user_id,
            "agent": agent,
            "createdAt": existing.get("createdAt") if existing else now,
            "updatedAt": now,
            "encryptedBlob": encrypt(contents),
        }
        if source:
            item["source"] = source
        if isinstance(identifier, str) and identifier:
            item["identifier"] = identifier[:128]

        put_agent_credential(item)
        print(f"[agent-creds] STORED user={user_id} agent={agent} source={source} blob_bytes={len(contents)} identifier={identifier!r}")
        return respond(200, {"ok": True, "agent": agent})

    except Exception as exc:
        import traceback
        print(f"agent_credentials error: {exc}\n{traceback.format_exc()}")
        return respond(500, {"error": str(exc)})
