"""
POST /internal/sessions/{sessionId}/complete — server-side completion callback.

The remote run script calls this when the agent exits so the backend can pull
the final output tail, materialize the transcript, and send push notifications
without relying on a foreground client poll.
"""
import hmac
import json
import os

from src.chat import sync_session_output, _complete_session_and_notify
from src.lib.db import get_server, get_session
from src.lib.kms import decrypt
from src.lib.ssh import ssh_connect, ssh_disconnect


def respond(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def _extract_callback_secret(headers):
    headers = headers or {}
    return (
        headers.get("x-pocketengineer-completion-secret")
        or headers.get("X-PocketEngineer-Completion-Secret")
        or ""
    )


def handler(event, context):
    try:
        expected_secret = os.environ.get("COMPLETION_CALLBACK_SECRET", "").strip()
        provided_secret = _extract_callback_secret(event.get("headers"))
        if not expected_secret or not hmac.compare_digest(provided_secret, expected_secret):
            return respond(401, {"error": "Invalid completion callback secret"})

        session_id = (event.get("pathParameters") or {}).get("sessionId")
        if not session_id:
            return respond(400, {"error": "sessionId required"})

        body = json.loads(event.get("body") or "{}")
        server_id = body.get("serverId")
        pid = body.get("pid")
        if not server_id:
            return respond(400, {"error": "serverId required"})

        session = get_session(session_id)
        if not session:
            return respond(404, {"error": "Session not found"})
        if session.get("serverId") != server_id:
            return respond(400, {"error": "Session belongs to a different server"})

        server = get_server(server_id)
        if not server:
            return respond(404, {"error": "Server not found"})
        if not server.get("publicIp") or not server.get("sshPrivateKey"):
            return respond(400, {"error": "Server not ready (no IP or key)"})

        private_key_pem = decrypt(server["sshPrivateKey"])
        username = server.get("sshUser", "ec2-user")
        client = ssh_connect(server["publicIp"], private_key_pem, username)

        try:
            # Drain any remaining agent output. We pass notify_on_done=False
            # because the wrapper script's curl runs as the script's last
            # command — the wrapper PID is STILL alive when we get here, so
            # sync_session_output's `kill -0 PID` check would see RUNNING
            # and skip the notify path. The completion callback is itself
            # authoritative ("the agent is done"), so we always run
            # _complete_session_and_notify ourselves below regardless of
            # whether the PID happens to be alive.
            result = sync_session_output(
                client,
                session_id,
                offset=int(session.get("currentRunOffset", 0) or 0),
                pid=pid,
                server_id=server_id,
                notify_on_done=False,
            )

            # Always trigger the completion path. This is what runs the
            # validation harness and (if validation passes) marks the session
            # done + notifies the user.
            try:
                _complete_session_and_notify(session_id)
            except Exception as exc:
                import traceback
                print(f"completion_hook: _complete_session_and_notify failed for {session_id}: {exc}\n{traceback.format_exc()}")

            return respond(200, {
                "ok": True,
                "done": True,
                "offset": result["offset"],
            })
        finally:
            ssh_disconnect(client)

    except Exception as exc:
        import traceback
        print(f"Completion hook error: {exc}\n{traceback.format_exc()}")
        return respond(500, {"error": str(exc)})
