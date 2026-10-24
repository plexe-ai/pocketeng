"""
POST /slack/command — Receives Slack slash command, ACKs immediately,
invokes the worker Lambda asynchronously.
"""
import base64
import json
import os
from urllib.parse import parse_qs

import boto3

from src.lib.slack import verify_slack_signature

_lambda = boto3.client("lambda")


def respond(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def handler(event, context):
    try:
        # Decode body
        body_raw = event.get("body", "")
        if event.get("isBase64Encoded"):
            body_raw = base64.b64decode(body_raw).decode()

        # Verify Slack signature
        headers = event.get("headers", {})
        timestamp = headers.get("x-slack-request-timestamp", "")
        signature = headers.get("x-slack-signature", "")

        try:
            verify_slack_signature(body_raw, timestamp, signature)
        except Exception as e:
            print(f"Slack signature verification failed: {e}")
            return respond(401, {"error": "Invalid signature"})

        # Parse form-urlencoded body
        params = parse_qs(body_raw)
        text = (params.get("text") or [""])[0].strip()
        team_id = (params.get("team_id") or [""])[0]
        user_id = (params.get("user_id") or [""])[0]
        user_name = (params.get("user_name") or [""])[0]
        response_url = (params.get("response_url") or [""])[0]
        channel_name = (params.get("channel_name") or [""])[0]
        channel_id = (params.get("channel_id") or [""])[0]

        if not text:
            return respond(200, {
                "response_type": "ephemeral",
                "text": "Usage: `/pe <prompt>` — e.g. `/pe build me a REST API`",
            })

        if not response_url:
            return respond(200, {
                "response_type": "ephemeral",
                "text": "Something went wrong (no response_url).",
            })

        # Invoke worker async
        worker_name = os.environ.get("WORKER_FUNCTION_NAME", "")
        _lambda.invoke(
            FunctionName=worker_name,
            InvocationType="Event",
            Payload=json.dumps({
                "text": text,
                "team_id": team_id,
                "slack_user_id": user_id,
                "slack_user_name": user_name,
                "channel_name": channel_name,
                "channel": channel_id,
                "response_url": response_url,
            }),
        )

        # ACK immediately (Slack needs 200 within 3 seconds)
        return respond(200, {
            "response_type": "in_channel",
            "text": f":hourglass_flowing_sand: *{user_name}*: {text}\n_Working on it..._",
        })

    except Exception as e:
        print(f"Slack command error: {e}")
        return respond(200, {
            "response_type": "ephemeral",
            "text": f"Error: {e}",
        })
