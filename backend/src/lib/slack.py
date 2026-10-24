"""Slack request verification and helpers."""
import hashlib
import hmac
import json
import os
import time
import urllib.request


def verify_slack_signature(body: str, timestamp: str, signature: str):
    """Verify Slack request signature (HMAC-SHA256)."""
    signing_secret = os.environ.get("SLACK_SIGNING_SECRET", "")
    if not signing_secret:
        raise Exception("SLACK_SIGNING_SECRET not configured")

    if abs(time.time() - int(timestamp)) > 300:
        raise Exception("Slack request too old")

    sig_basestring = f"v0:{timestamp}:{body}"
    expected = "v0=" + hmac.new(
        signing_secret.encode(), sig_basestring.encode(), hashlib.sha256
    ).hexdigest()

    if not hmac.compare_digest(expected, signature):
        raise Exception("Invalid Slack signature")


def post_to_slack(response_url: str, text: str, in_channel: bool = True, blocks: list = None):
    """Post a message back to Slack via response_url (for slash commands)."""
    body = {
        "response_type": "in_channel" if in_channel else "ephemeral",
        "text": text,
    }
    if blocks:
        body["blocks"] = blocks

    payload = json.dumps(body).encode()
    req = urllib.request.Request(
        response_url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.status


def chat_post_message(bot_token: str, channel: str, text: str, thread_ts: str = None, blocks: list = None):
    """Post a message to a Slack channel using the bot token (for @mentions)."""
    body = {
        "channel": channel,
        "text": text,  # fallback for notifications
    }
    if thread_ts:
        body["thread_ts"] = thread_ts
    if blocks:
        body["blocks"] = blocks

    payload = json.dumps(body).encode()
    req = urllib.request.Request(
        "https://slack.com/api/chat.postMessage",
        data=payload,
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "Authorization": f"Bearer {bot_token}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read())
        if not data.get("ok"):
            print(f"Slack chat.postMessage error: {data.get('error')}")
        return data


def add_reaction(bot_token: str, channel: str, timestamp: str, emoji: str = "eyes"):
    """Add an emoji reaction to a message."""
    body = {"channel": channel, "timestamp": timestamp, "name": emoji}
    payload = json.dumps(body).encode()
    req = urllib.request.Request(
        "https://slack.com/api/reactions.add",
        data=payload,
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "Authorization": f"Bearer {bot_token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
            if not data.get("ok") and data.get("error") != "already_reacted":
                print(f"Slack reactions.add error: {data.get('error')}")
    except Exception as e:
        print(f"Reaction failed: {e}")
