#!/usr/bin/env python3
"""
Update an EXISTING Retell LLM + agent in place — system prompt, tool
schema, begin message — without creating duplicate resources.

Companion to setup_retell.py. Run setup once (creates LLM/agent/number)
then this script forever after (updates them).

Why a separate script: setup_retell.py issues POST /create-retell-llm
and POST /create-agent, which always mint fresh IDs. After the initial
provision we want PATCH semantics so the existing phone number keeps
routing to the same agent and we don't accumulate orphaned LLMs in the
Retell dashboard.

Usage:
  export RETELL_API_KEY=your_key
  export PE_API_BASE=https://<api-id>.execute-api.<region>.amazonaws.com/prod
  export RETELL_WEBHOOK_SECRET=...                     # matches samconfig
  export RETELL_LLM_ID=llm_xxx                         # from setup_retell.py output
  # optional: only needed if you also want to tweak voice, language, etc.
  export RETELL_AGENT_ID=agent_xxx

  python backend/tools/update_retell.py

Shares the SYSTEM_PROMPT and tool schema with setup_retell.py — single
source of truth.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

# Reuse the exact config setup_retell.py uses so the two stay in sync.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from setup_retell import SYSTEM_PROMPT, _tools  # noqa: E402


RETELL_API = "https://api.retellai.com"


def _request(method: str, path: str, api_key: str, body: dict | None = None) -> dict:
    url = RETELL_API + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode(errors="replace")
        raise RuntimeError(f"Retell {method} {path} → {exc.code}: {body_text}") from exc


def main() -> int:
    api_key = os.environ.get("RETELL_API_KEY", "").strip()
    base = os.environ.get("PE_API_BASE", "").strip().rstrip("/")
    secret = os.environ.get("RETELL_WEBHOOK_SECRET", "").strip()
    llm_id = os.environ.get("RETELL_LLM_ID", "").strip()

    missing = [k for k, v in (
        ("RETELL_API_KEY", api_key),
        ("PE_API_BASE", base),
        ("RETELL_WEBHOOK_SECRET", secret),
        ("RETELL_LLM_ID", llm_id),
    ) if not v]
    if missing:
        print(f"Missing env vars: {', '.join(missing)}", file=sys.stderr)
        print("\nRun backend/tools/setup_retell.py first if you haven't — it", file=sys.stderr)
        print("prints the llm_id and agent_id you need here.", file=sys.stderr)
        return 1

    webhook_url = f"{base}/voice/retell?secret={secret}"
    print(f"Webhook URL: {webhook_url}")
    print(f"Updating LLM: {llm_id}")

    # PATCH the existing LLM with fresh prompt + tool schema. Retell's
    # /update-retell-llm takes the same body shape as /create-retell-llm
    # but applied to an existing resource.
    _request("PATCH", f"/update-retell-llm/{llm_id}", api_key, {
        "general_prompt": SYSTEM_PROMPT,
        "general_tools": _tools(webhook_url),
    })
    print(f"  ✓ LLM prompt + {len(_tools(webhook_url))} tools updated")

    # The agent itself (voice, language, phone binding) isn't touched
    # here — only the LLM's prompt + tool schema are. Retell publishes
    # LLM changes live to all agents bound to that llm_id on the next
    # call, so no agent PATCH is needed.

    print("\nDone. Next call hitting your Retell number will use the new prompt + tools.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
