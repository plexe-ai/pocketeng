"""
Async SMS worker — invoked by SmsInboundFunction.
Finds the user's default environment, auto-starts if stopped,
runs Claude Code via SSH, replies via Linq SMS API.
"""
import os

from src.lib.linq import send_sms
from src.lib.agent_runner import (
    SessionStore, find_server_by_id, find_any_server,
    auto_start_server, run_claude, RESET_PHRASES,
)

_SMS_TABLE = os.environ.get("SMS_MAPPINGS_TABLE", "pe-sms-mappings-prod")


def _reply(phone: str, text: str):
    try:
        send_sms(to_number=phone, text=text)
    except Exception as e:
        print(f"Failed to send SMS reply: {e}")


def handler(event, context):
    text = event.get("text", "")
    phone = event.get("phone_number", "")
    user_id = event.get("user_id", "")
    default_server_id = event.get("default_server_id", "")

    try:
        # 1. Find the server — prefer default, fallback to any
        server, needs_start = None, False
        if default_server_id:
            server, needs_start = find_server_by_id(default_server_id)
        if not server:
            server, needs_start = find_any_server(user_id)
        if not server:
            _reply(phone, "No workspace found. Set one up at pocketeng.ai first.")
            return

        server_id = server["serverId"]

        # 2. Session store
        sessions = SessionStore(_SMS_TABLE, "phoneNumber", phone)

        # 3. Check for session reset
        if text.strip().lower() in RESET_PHRASES:
            sessions.ensure_map()
            sessions.clear(server_id)
            _reply(phone, "Session cleared. Next message starts fresh.")
            return

        # 4. Auto-start if stopped
        if needs_start:
            server = auto_start_server(server, lambda msg: _reply(phone, msg))
            if not server:
                return

        # 5. Get previous session ID
        sessions.ensure_map()
        prev_session_id = sessions.get(server_id)

        # 6. Run Claude
        raw, new_session_id = run_claude(server, text, prev_session_id)

        if new_session_id:
            sessions.save(server_id, new_session_id)

        # 7. Truncate for SMS and reply
        if len(raw) > 1500:
            raw = raw[:1500] + "\n... (truncated)"

        _reply(phone, raw)

    except Exception as e:
        print(f"SMS worker error: {e}")
        import traceback
        traceback.print_exc()
        try:
            _reply(phone, f"Error: {e}")
        except Exception:
            pass
