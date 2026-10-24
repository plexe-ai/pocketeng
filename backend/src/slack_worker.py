"""
Async Slack worker — invoked by SlackCommandFunction or SlackEventsFunction.
Finds the user's environment, auto-starts if stopped, detects repos in the prompt,
launches Claude Code via the async _launch_turn path (autopilot), and confirms to Slack.
The completion hook posts the result back when the agent finishes.
"""
import json
import os
import re

from src.lib.db import get_servers_by_user, update_session
from src.lib.slack import post_to_slack, chat_post_message
from src.lib.agent_runner import (
    SessionStore, find_any_server, find_server_by_id, find_server_by_label,
    auto_start_server, detect_repos, clone_repos, RESET_PHRASES,
    ensure_github_credentials,
)
from src.lib.kms import decrypt
from src.lib.ssh import ssh_connect, ssh_disconnect
from src.chat import _launch_turn

_SLACK_TABLE = os.environ.get("SLACK_MAPPINGS_TABLE", "pe-slack-mappings-prod")

import boto3
_ddb = boto3.resource("dynamodb")

# Patterns that indicate the user wants a code task (autopilot), not just a question
_TASK_VERBS = re.compile(
    r'^\s*(?:fix|add|create|build|implement|update|refactor|remove|delete|rename|move|'
    r'write|change|migrate|upgrade|install|deploy|configure|set up|setup|enable|disable|'
    r'make|modify|convert|replace|extract|merge|revert|debug|resolve|optimize|improve)\b',
    re.IGNORECASE,
)


def _is_task(text: str) -> bool:
    """Heuristic: does this look like a coding task (vs a question or conversation)?"""
    stripped = text.strip()
    if _TASK_VERBS.match(stripped):
        return True
    # Messages with repo URLs are tasks (clone + work)
    if re.search(r'github\.com/', stripped):
        return True
    return False


def _get_mapping(team_id: str) -> dict | None:
    table = _ddb.Table(_SLACK_TABLE)
    resp = table.get_item(Key={"slackTeamId": team_id})
    return resp.get("Item")


class _Reply:
    def __init__(self, event):
        self.source = event.get("source", "command")
        self.response_url = event.get("response_url", "")
        self.channel = event.get("channel", "")
        self.thread_ts = event.get("thread_ts", "")
        self.bot_token = event.get("bot_token", "")

    def send(self, text: str, ephemeral: bool = False, blocks: list = None):
        if self.source == "mention" and self.bot_token and self.channel:
            chat_post_message(self.bot_token, self.channel, text, self.thread_ts, blocks)
        elif self.response_url:
            post_to_slack(self.response_url, text, in_channel=not ephemeral, blocks=blocks)

    def reply_info(self) -> dict:
        """Serialize reply coordinates for storage in the session record."""
        info = {"source": self.source}
        if self.response_url:
            info["responseUrl"] = self.response_url
        if self.channel:
            info["channel"] = self.channel
        if self.thread_ts:
            info["threadTs"] = self.thread_ts
        if self.bot_token:
            info["botToken"] = self.bot_token
        return info


def handler(event, context):
    text = event.get("text", "")
    team_id = event.get("team_id", "")
    reply = _Reply(event)

    try:
        # 1. Find PE user from Slack team
        mapping = _get_mapping(team_id)
        if not mapping:
            reply.send(
                "No Pocket Eng account linked to this Slack workspace.\n"
                "Connect Slack at <https://pocketeng.ai/dashboard/integrations|pocketeng.ai>.")
            return

        user_id = mapping.get("userId")
        bot_token = mapping.get("botToken", "")

        if event.get("source") == "mention" and not reply.bot_token:
            reply.bot_token = bot_token

        # 2. Session store (for tracking session IDs per server per Slack team)
        sessions = SessionStore(_SLACK_TABLE, "slackTeamId", team_id)

        # 3. Handle "use <name>" — set default workspace
        stripped = text.strip().lstrip('/')  # strip leading / in case user types "/use"
        use_match = re.match(r'^use\s+(.+)$', stripped, re.IGNORECASE)
        if stripped.lower() == 'use':
            # Show available workspaces
            servers = get_servers_by_user(user_id)
            active = [s for s in servers if s.get("instanceState") != "terminated" and s.get("label")]
            default_id = mapping.get("defaultServerId")
            if not active:
                reply.send("No workspaces found. Create one at <https://pocketeng.ai/dashboard|pocketeng.ai>.")
                return
            lines = []
            for s in active:
                label = s.get("label", s["serverId"][:8])
                state = s.get("instanceState", "?")
                marker = " _(default)_" if s["serverId"] == default_id else ""
                lines.append(f"• *{label}*{marker} — {state}")
            reply.send(f"Available workspaces:\n" + "\n".join(lines) + "\n\nSet default: `use <name>`")
            return
        if use_match:
            label = use_match.group(1).strip()
            target, _ = find_server_by_label(user_id, label)
            if not target:
                reply.send(f"No workspace matching *{label}* found.")
                return
            # Save default in mapping
            table = _ddb.Table(_SLACK_TABLE)
            table.update_item(
                Key={"slackTeamId": team_id},
                UpdateExpression="SET defaultServerId = :sid",
                ExpressionAttributeValues={":sid": target["serverId"]},
            )
            reply.send(f"Default workspace set to *{target.get('label', target['serverId'][:8])}*.")
            return

        # 4. Find a server. Resolution order:
        #    (a) explicit "workspace_name task" prefix in the message
        #    (b) per-channel mapping (channelMappings on the team record)
        #    (c) team-wide saved default (defaultServerId)
        #    (d) any usable server
        text = stripped  # use cleaned text (leading / removed) for the prompt
        server = None
        needs_start = False
        words = stripped.split(None, 1)
        if len(words) >= 2:
            candidate, cand_start = find_server_by_label(user_id, words[0])
            if candidate:
                server, needs_start = candidate, cand_start
                text = words[1]  # strip workspace name from prompt

        if not server:
            # Per-channel routing — a Slack channel can be pinned to a specific
            # workspace (e.g. one channel per customer). Only the @mention path
            # carries a channel id; the slash-command path passes it too now.
            #
            # A channel entry may be either:
            #   - a plain serverId string (workspace owned by the team's PE user), or
            #   - an object {"serverId": ..., "userId": ...} so a channel can point
            #     at a workspace owned by a *different* PE account (the Slack team is
            #     linked to one PE user, but teammates each have their own workspaces).
            channel_id = event.get("channel", "")
            channel_map = mapping.get("channelMappings") or {}
            entry = channel_map.get(channel_id) if channel_id else None
            if entry:
                if isinstance(entry, dict):
                    mapped_server_id = entry.get("serverId")
                    if entry.get("userId"):
                        # Route to the channel-owner's account for the rest of the
                        # turn (GitHub credentials, fallbacks, etc.).
                        user_id = entry["userId"]
                else:
                    mapped_server_id = entry
                if mapped_server_id:
                    server, needs_start = find_server_by_id(mapped_server_id)

        if not server:
            # Try saved default
            default_id = mapping.get("defaultServerId")
            if default_id:
                server, needs_start = find_server_by_id(default_id)

        if not server:
            server, needs_start = find_any_server(user_id)

        if not server:
            reply.send(
                "No workspace found.\n"
                "Create one at <https://pocketeng.ai/dashboard|pocketeng.ai> first.")
            return

        server_id = server["serverId"]

        # Session continuity is scoped to the Slack THREAD, so each thread is
        # its own conversation and replies in a thread resume the same agent
        # session. Slash commands aren't threaded (no thread_ts), so they fall
        # back to the server id for simple per-workspace continuity.
        session_key = reply.thread_ts or server_id

        # 5. Check for session reset
        if text.strip().lower() in RESET_PHRASES:
            sessions.ensure_map()
            sessions.clear(session_key)
            reply.send("Session cleared.")
            return

        # 5. Auto-start if stopped
        if needs_start:
            server = auto_start_server(server, lambda msg: reply.send(msg))
            if not server:
                return

        # 6. Detect and clone repos
        repos = detect_repos(text)
        workdir = "~/projects"
        if repos:
            private_key_pem = decrypt(server["sshPrivateKey"])
            ssh_user = server.get("sshUser", "ec2-user")
            client = ssh_connect(server["publicIp"], private_key_pem, ssh_user)
            try:
                cloned = clone_repos(client, repos)
                if cloned:
                    reply.send(f"Cloned {', '.join(f'`{r}`' for r in cloned)}.")
            finally:
                ssh_disconnect(client)
            repo_name = repos[0].split('/')[-1]
            workdir = f"~/projects/{repo_name}"

        # 7. Determine mode: autopilot (task) vs conversational (question)
        is_autopilot = _is_task(text)

        # 8. Launch via async _launch_turn
        private_key_pem = decrypt(server["sshPrivateKey"])
        ssh_user = server.get("sshUser", "ec2-user")
        client = ssh_connect(server["publicIp"], private_key_pem, ssh_user)

        try:
            # Ensure GitHub credentials for PR creation
            ensure_github_credentials(client, user_id)

            sessions.ensure_map()
            prev_session_id = sessions.get(session_key)

            body = {
                "prompt": text,
                "agent": "claude",
                "workdir": workdir,
            }
            if is_autopilot:
                body["autopilot"] = True
            if prev_session_id:
                # _launch_turn resumes an existing conversation via `sessionId`
                # (it looks up the record and re-uses its remoteSessionId for a
                # native `--resume`). This must be `sessionId`, not
                # `resumeSessionId` — the latter is silently ignored.
                body["sessionId"] = prev_session_id

            result = _launch_turn(client, body, server_id, user_id, event=None)
            result_body = json.loads(result.get("body", "{}"))

            if result.get("statusCode") != 200:
                reply.send(f"Failed to start: {result_body.get('error', 'Unknown error')}")
                return

            session_id = result_body.get("sessionId")
            if session_id:
                sessions.save(session_key, session_id)

                # Store Slack reply coordinates so completion hook can post back
                try:
                    update_session(session_id, {"slackReply": reply.reply_info()})
                except Exception as e:
                    print(f"Failed to save Slack reply info: {e}")

            # No ack message — the completion hook will post the final result.
            # The eyes reaction (added by slack_events.py) is the only acknowledgment.

        finally:
            ssh_disconnect(client)

    except Exception as e:
        print(f"Slack worker error: {e}")
        import traceback
        traceback.print_exc()
        try:
            reply.send(f"Error: {e}")
        except Exception:
            pass
