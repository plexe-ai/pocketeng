#!/usr/bin/env python3
"""
One-shot Retell AI voice-agent provisioner.

What it does:
  1. Creates a Retell LLM config with Claude Sonnet + our tool definitions.
  2. Creates an agent bound to that LLM with voice + language settings.
  3. (Optional) Buys a Retell phone number and points it at the agent.
  4. Prints the agent_id + (optional) phone_number so you can share them.

What it does NOT do:
  - Register end-user phone numbers in pe-sms-mappings-prod. Users do that
    via the existing POST /sms/register endpoint (or the Settings page in
    the web dashboard). The voice-tool handler uses that same allowlist.

Usage:
  export RETELL_API_KEY=your_key
  export PE_API_BASE=https://<api-id>.execute-api.<region>.amazonaws.com/prod
  export RETELL_WEBHOOK_SECRET=$(openssl rand -hex 32)   # same value you put in samconfig
  python backend/scripts/setup_retell.py --buy-number
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request


RETELL_API = "https://api.retellai.com"


SYSTEM_PROMPT = """You are the Pocket Eng voice assistant. Callers talk to you to brainstorm with and control their cloud-based Claude Code sessions.

STYLE (non-negotiable):
  - Max 2 sentences per response. Talk like a human, not a robot.
  - Be direct. "3 sessions running, the main one is on the auth fix" — NOT "I can see that you currently have..."
  - NEVER explain what tools do or narrate your actions. Just do it and report.
  - NEVER ask "are you still there" or "is there anything else" — silence is fine, the caller will speak up.
  - Paraphrase long output. Never read code verbatim.
  - If unsure, say "let me check" and use a tool. Do not guess.

TOOLS:
  - list_workspaces: list the caller's workspaces and their running state.
  - list_sessions: list recent coding sessions.
  - read_session: read the agent's last reply on a session. Use this for "what did X say" after the fact.
  - session_status: describe what a running session is doing RIGHT NOW. Use this for "what's it up to" and "keep me posted" loops.
  - send_message: send a prompt to a session. CRITICAL — see below.

CRITICAL — send_message:
  - If the caller asks a QUESTION or wants to BRAINSTORM (anything that needs the workspace agent's reply spoken back on this call), ALWAYS pass `wait_for_response: true`. The tool will hold briefly, then return the agent's reply for you to speak verbatim (after trimming to 2-3 sentences).
  - If the caller asks you to KICK OFF A LONG TASK ("implement X", "run the test suite", "deploy Y"), use the default `wait_for_response: false`. Confirm it's kicked off and note the app will ping them when done.
  - To continue brainstorming, keep passing the same `session` hint on follow-up send_message calls. That way the agent keeps context.

LIVE UPDATES:
  - On "keep me posted" / "let me know what's happening", call session_status every 15-20 seconds and narrate changes. Stop when the caller says so or the session completes.
"""


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


def _tools(webhook_url: str) -> list[dict]:
    """Retell custom-tool definitions — each points at the same webhook URL.
    Our Lambda dispatches on the tool name."""
    return [
        {
            "type": "custom",
            "name": "list_workspaces",
            "description": "List the caller's cloud workspaces and their current running state.",
            "url": webhook_url,
            "speak_during_execution": True,
            "speak_after_execution": True,
            "parameters": {"type": "object", "properties": {}},
        },
        {
            "type": "custom",
            "name": "list_sessions",
            "description": "List recent coding sessions, optionally narrowed to a specific workspace.",
            "url": webhook_url,
            "speak_during_execution": True,
            "speak_after_execution": True,
            "parameters": {
                "type": "object",
                "properties": {
                    "workspace": {
                        "type": "string",
                        "description": "Optional workspace name hint, e.g. 'pocketeng' or 'the main one'.",
                    },
                },
            },
        },
        {
            "type": "custom",
            "name": "read_session",
            "description": "Read out the most recent assistant reply from a session. Use this when the caller asks 'what did X say' or 'what's the update on Y'.",
            "url": webhook_url,
            "speak_during_execution": True,
            "speak_after_execution": True,
            "parameters": {
                "type": "object",
                "properties": {
                    "workspace": {
                        "type": "string",
                        "description": "Optional workspace hint.",
                    },
                    "session": {
                        "type": "string",
                        "description": "Hint describing the session (not a UUID — something like 'the auth bug one').",
                    },
                },
            },
        },
        {
            "type": "custom",
            "name": "session_status",
            "description": "Describe what a running session is doing right now — the currently-running tool call, how long it's been running, and the last thing the agent said. Use this for 'what's it up to?', 'is it still working?', and 'keep me posted' loops.",
            "url": webhook_url,
            "speak_during_execution": True,
            "speak_after_execution": True,
            "parameters": {
                "type": "object",
                "properties": {
                    "workspace": {"type": "string", "description": "Optional workspace hint."},
                    "session": {"type": "string", "description": "Optional session hint."},
                },
            },
        },
        {
            "type": "custom",
            "name": "send_message",
            "description": (
                "Send a prompt to a coding session. Two modes: "
                "(1) wait_for_response=true — hold briefly and return the "
                "agent's spoken reply; use this for questions, brainstorming, "
                "or anything the caller expects to hear back on this call. "
                "(2) wait_for_response=false (default) — fire-and-forget, "
                "confirm immediately; use this for long tasks ('implement X', "
                "'run the test suite'). The Pocket Eng app push-notifies on "
                "completion either way."
            ),
            "url": webhook_url,
            "speak_during_execution": True,
            "speak_after_execution": True,
            "execution_message_description": "Checking with your workspace…",
            "parameters": {
                "type": "object",
                "properties": {
                    "message": {
                        "type": "string",
                        "description": "The prompt to send to the coding agent.",
                    },
                    "workspace": {
                        "type": "string",
                        "description": "Optional workspace hint.",
                    },
                    "session": {
                        "type": "string",
                        "description": (
                            "Optional session hint — to continue an existing "
                            "session instead of starting a fresh one. Pass the "
                            "same hint on follow-up calls to keep context."
                        ),
                    },
                    "wait_for_response": {
                        "type": "boolean",
                        "description": (
                            "If true, the tool holds on the line for up to "
                            "~25 seconds and returns the agent's reply so you "
                            "can speak it. Use for questions / brainstorming. "
                            "Default false for long tasks."
                        ),
                    },
                    "timeout": {
                        "type": "number",
                        "description": (
                            "Max seconds to wait when wait_for_response is "
                            "true. Default 25, hard cap 45. Ignored when "
                            "wait_for_response is false."
                        ),
                    },
                },
                "required": ["message"],
            },
        },
    ]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--buy-number", action="store_true", help="Also purchase a phone number on Retell and bind it to the agent.")
    parser.add_argument("--area-code", default=None, help="Preferred area code for the purchased number.")
    parser.add_argument("--voice-id", default="11labs-Cimo", help="Retell voice ID (see https://docs.retellai.com/deploy/voice-library).")
    args = parser.parse_args()

    api_key = os.environ.get("RETELL_API_KEY", "").strip()
    base = os.environ.get("PE_API_BASE", "").strip().rstrip("/")
    secret = os.environ.get("RETELL_WEBHOOK_SECRET", "").strip()

    missing = [k for k, v in (
        ("RETELL_API_KEY", api_key),
        ("PE_API_BASE", base),
        ("RETELL_WEBHOOK_SECRET", secret),
    ) if not v]
    if missing:
        print(f"Missing env vars: {', '.join(missing)}", file=sys.stderr)
        return 1

    webhook_url = f"{base}/voice/retell?secret={secret}"
    print(f"Webhook URL: {webhook_url}")

    # 1. Create LLM with tools.
    print("Creating Retell LLM…")
    llm = _request("POST", "/create-retell-llm", api_key, {
        "model": "claude-4.6-sonnet",
        "general_prompt": SYSTEM_PROMPT,
        "general_tools": _tools(webhook_url),
        "begin_message": "Hey, pocket eng here. What's up?",
    })
    llm_id = llm["llm_id"]
    print(f"  llm_id: {llm_id}")

    # 2. Create agent.
    print("Creating Retell agent…")
    agent = _request("POST", "/create-agent", api_key, {
        "response_engine": {"type": "retell-llm", "llm_id": llm_id},
        "agent_name": "PocketEng Voice",
        "voice_id": args.voice_id,
        "language": "en-US",
        "end_call_after_silence_ms": 20000,
    })
    agent_id = agent["agent_id"]
    print(f"  agent_id: {agent_id}")

    # 3. Phone number (optional).
    phone = None
    if args.buy_number:
        print("Buying phone number…")
        payload = {"inbound_agent_id": agent_id}
        if args.area_code:
            payload["area_code"] = int(args.area_code)
        bought = _request("POST", "/buy-phone-number", api_key, payload)
        phone = bought.get("phone_number")
        print(f"  phone_number: {phone}")

    print()
    print("Done. Summary:")
    print(f"  LLM    : {llm_id}")
    print(f"  Agent  : {agent_id}")
    if phone:
        print(f"  Number : {phone}  ← call this to reach the assistant")
    print()
    print("Next steps:")
    print("  1. Register your phone number in the allowlist:")
    print(f"     curl -X POST {base}/sms/register \\")
    print(f"          -H 'Authorization: Bearer <your supabase jwt>' \\")
    print(f"          -d '{{\"phoneNumber\": \"+1...\", \"defaultServerId\": \"...\"}}'")
    print("  2. Call the Retell number. The webhook runs against prod.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
