"""
POST /slack/events — Receives Slack Events API payloads.
Handles url_verification challenge and app_mention events.
"""
import base64
import json
import os
import re

import boto3

from src.lib.slack import verify_slack_signature, add_reaction

_lambda = boto3.client("lambda")

# Matches <@U12345> bot mention prefix
_MENTION_RE = re.compile(r'<@[A-Z0-9]+>\s*')


def respond(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body) if isinstance(body, dict) else body,
    }


def handler(event, context):
    try:
        body_raw = event.get("body", "")
        if event.get("isBase64Encoded"):
            body_raw = base64.b64decode(body_raw).decode()

        payload = json.loads(body_raw)

        # 1. Handle Slack URL verification challenge (one-time setup)
        if payload.get("type") == "url_verification":
            return respond(200, {"challenge": payload["challenge"]})

        # 2. Verify signature
        headers = event.get("headers", {})
        timestamp = headers.get("x-slack-request-timestamp", "")
        signature = headers.get("x-slack-signature", "")

        try:
            verify_slack_signature(body_raw, timestamp, signature)
        except Exception as e:
            print(f"Slack signature verification failed: {e}")
            return respond(401, {"error": "Invalid signature"})

        # 3. Handle events
        slack_event = payload.get("event", {})
        event_type = slack_event.get("type")

        if event_type == "app_mention":
            return _handle_mention(payload, slack_event)

        if event_type == "message":
            return _handle_thread_reply(payload, slack_event)

        # ACK unknown events
        return respond(200, {"ok": True})

    except Exception as e:
        print(f"Slack events error: {e}")
        return respond(200, {"ok": True})


def _handle_thread_reply(payload, slack_event):
    """Handle plain messages in threads — respond if the bot is already in the thread."""
    # Only handle thread replies (not top-level channel messages)
    thread_ts = slack_event.get("thread_ts")
    if not thread_ts:
        return respond(200, {"ok": True})

    # Skip bot messages and message subtypes (edits, joins, etc.) to avoid loops
    if slack_event.get("bot_id") or slack_event.get("subtype"):
        return respond(200, {"ok": True})

    # Skip if this message contains an @mention — _handle_mention will handle it
    text = slack_event.get("text", "").strip()
    if _MENTION_RE.search(text):
        return respond(200, {"ok": True})

    if not text:
        return respond(200, {"ok": True})

    # Strip any @mention prefix in case user still tags the bot
    text = _MENTION_RE.sub("", text).strip()
    if not text:
        return respond(200, {"ok": True})

    team_id = payload.get("team_id", "")
    channel = slack_event.get("channel", "")
    user = slack_event.get("user", "")

    # Look up bot token
    slack_table = os.environ.get("SLACK_MAPPINGS_TABLE", "")
    bot_token = ""
    if slack_table and team_id:
        try:
            ddb = boto3.resource("dynamodb")
            item = ddb.Table(slack_table).get_item(Key={"slackTeamId": team_id}).get("Item", {})
            bot_token = item.get("botToken", "")
        except Exception:
            pass

    if not bot_token:
        return respond(200, {"ok": True})

    # Check if the bot has already replied in this thread using conversations.replies
    try:
        import urllib.request
        import urllib.parse
        params = urllib.parse.urlencode({"channel": channel, "ts": thread_ts, "limit": 20})
        req = urllib.request.Request(
            f"https://slack.com/api/conversations.replies?{params}",
            headers={"Authorization": f"Bearer {bot_token}"},
        )
        resp = urllib.request.urlopen(req, timeout=5)
        data = json.loads(resp.read())
        messages = data.get("messages", [])
        bot_in_thread = any(m.get("bot_id") for m in messages)
    except Exception as e:
        print(f"Thread check failed: {e}")
        return respond(200, {"ok": True})

    if not bot_in_thread:
        return respond(200, {"ok": True})

    # ACK with eyes emoji
    msg_ts = slack_event.get("ts", "")
    if msg_ts:
        add_reaction(bot_token, channel, msg_ts)

    # Bot is in this thread — invoke worker
    worker_name = os.environ.get("WORKER_FUNCTION_NAME", "")
    _lambda.invoke(
        FunctionName=worker_name,
        InvocationType="Event",
        Payload=json.dumps({
            "source": "mention",
            "text": text,
            "team_id": team_id,
            "channel": channel,
            "slack_user_id": user,
            "thread_ts": thread_ts,
            "bot_token": bot_token,
        }),
    )

    return respond(200, {"ok": True})


def _handle_mention(payload, slack_event):
    """Handle @Pocket Eng mentions — strip the mention, invoke worker."""
    raw_text = slack_event.get("text", "")
    # Strip the <@BOT_ID> prefix to get just the user's prompt
    text = _MENTION_RE.sub("", raw_text).strip()

    if not text:
        return respond(200, {"ok": True})

    team_id = payload.get("team_id", "")
    channel = slack_event.get("channel", "")
    user = slack_event.get("user", "")
    thread_ts = slack_event.get("thread_ts") or slack_event.get("ts", "")

    # Deduplicate retries — Slack may resend if we're slow
    event_id = payload.get("event_id", "")

    # Look up bot token from mapping table so the worker can reply
    slack_table = os.environ.get("SLACK_MAPPINGS_TABLE", "")
    bot_token = ""
    if slack_table and team_id:
        try:
            ddb = boto3.resource("dynamodb")
            item = ddb.Table(slack_table).get_item(Key={"slackTeamId": team_id}).get("Item", {})
            bot_token = item.get("botToken", "")
        except Exception:
            pass

    # ACK with eyes emoji
    msg_ts = slack_event.get("ts", "")
    if msg_ts and bot_token:
        add_reaction(bot_token, channel, msg_ts)

    worker_name = os.environ.get("WORKER_FUNCTION_NAME", "")
    _lambda.invoke(
        FunctionName=worker_name,
        InvocationType="Event",
        Payload=json.dumps({
            "source": "mention",
            "text": text,
            "team_id": team_id,
            "channel": channel,
            "slack_user_id": user,
            "thread_ts": thread_ts,
            "event_id": event_id,
            "bot_token": bot_token,
        }),
    )

    return respond(200, {"ok": True})
