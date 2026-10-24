"""
Async Linear worker — invoked by LinearWebhookFunction.
Fetches full issue details, finds user's workspace, launches Claude autopilot,
and stores reply coordinates so the completion hook can update the issue.
"""
import json
import os

from src.lib.db import update_session
from src.lib.linear import fetch_issue, format_issue_prompt, get_app_token
from src.lib.agent_runner import (
    find_any_server, find_server_by_id, auto_start_server,
    ensure_github_credentials,
)
from src.lib.kms import decrypt
from src.lib.ssh import ssh_connect, ssh_disconnect
from src.chat import _launch_turn

_LINEAR_TABLE = os.environ.get("LINEAR_MAPPINGS_TABLE", "pe-linear-mappings-prod")

import boto3
_ddb = boto3.resource("dynamodb")


def handler(event, context):
    issue_id = event.get("issueId")
    team_id = event.get("teamId")
    user_id = event.get("userId")
    encrypted_token = event.get("accessToken")
    title = event.get("title", "")

    if not issue_id or not user_id or not encrypted_token:
        print(f"Linear worker: missing required fields")
        return

    try:
        # Use app token — user tokens expire after 30 days
        access_token = get_app_token()

        # 1. Fetch full issue details from Linear
        issue = fetch_issue(access_token, issue_id)
        if not issue:
            print(f"Linear worker: could not fetch issue {issue_id}")
            return

        prompt = format_issue_prompt(issue)
        identifier = issue.get("identifier", title)

        # 2. Find a server for this user
        # Check for default in mapping
        table = _ddb.Table(_LINEAR_TABLE)
        mapping = table.get_item(Key={"linearTeamId": team_id}).get("Item", {})
        default_server_id = mapping.get("defaultServerId")

        server = None
        needs_start = False

        if default_server_id:
            server, needs_start = find_server_by_id(default_server_id)

        if not server:
            server, needs_start = find_any_server(user_id)

        if not server:
            print(f"Linear worker: no workspace found for user {user_id}")
            # Could post a comment on the issue saying no workspace available
            from src.lib.linear import post_comment
            post_comment(
                access_token, issue_id,
                f"No workspace available to work on this issue. "
                f"Create one at [pocketeng.ai](https://pocketeng.ai/dashboard)."
            )
            return

        server_id = server["serverId"]

        # 3. Auto-start if stopped
        if needs_start:
            server = auto_start_server(server, lambda msg: print(f"Linear worker: {msg}"))
            if not server:
                print(f"Linear worker: failed to start server {server_id}")
                return

        # 4. Launch autopilot
        private_key_pem = decrypt(server["sshPrivateKey"])
        ssh_user = server.get("sshUser", "ec2-user")
        client = ssh_connect(server["publicIp"], private_key_pem, ssh_user)

        try:
            # Ensure GitHub credentials are on the server for PR creation
            ensure_github_credentials(client, user_id)

            body = {
                "prompt": prompt,
                "agent": "claude",
                "autopilot": True,
                "workdir": "~/projects",
            }

            result = _launch_turn(client, body, server_id, user_id, event=None)
            result_body = json.loads(result.get("body", "{}"))

            if result.get("statusCode") != 200:
                print(f"Linear worker: launch failed: {result_body.get('error')}")
                return

            session_id = result_body.get("sessionId")
            if session_id:
                # Store Linear reply coordinates so completion hook can update the issue
                update_session(session_id, {
                    "linearReply": {
                        "issueId": issue_id,
                        "identifier": identifier,
                        "teamId": team_id,
                        "accessToken": encrypted_token,  # keep encrypted
                    },
                })

            print(f"Linear worker: launched session {session_id} for issue {identifier}")

        finally:
            ssh_disconnect(client)

    except Exception as e:
        print(f"Linear worker error: {e}")
        import traceback
        traceback.print_exc()
