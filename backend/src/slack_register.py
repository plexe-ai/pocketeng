"""
POST /slack/register — Maps a Slack team to a PE user.
Called after Slack OAuth to enable slash commands.
"""
import json
import os

import boto3

from src.lib.auth import extract_auth_header, verify_token

_ddb = boto3.resource("dynamodb")


def respond(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def handler(event, context):
    try:
        try:
            claims = verify_token(extract_auth_header(event.get("headers", {})))
        except Exception as e:
            return respond(401, {"error": str(e)})

        user_id = claims["sub"]
        body = json.loads(event.get("body") or "{}")
        slack_team_id = body.get("slackTeamId")
        bot_token = body.get("botToken", "")

        if not slack_team_id:
            return respond(400, {"error": "slackTeamId required"})

        table_name = os.environ.get("SLACK_MAPPINGS_TABLE", "pe-slack-mappings-prod")
        table = _ddb.Table(table_name)
        # Use update_item (not put_item) so re-connecting Slack never clobbers
        # other attributes on the row — notably channelMappings (per-channel
        # routing) and sessions (thread continuity). A full put_item here would
        # silently wipe those, which previously broke bot replies.
        names = {"#u": "userId"}
        values = {":u": user_id}
        set_parts = ["#u = :u"]
        if bot_token:
            names["#b"] = "botToken"
            values[":b"] = bot_token
            set_parts.append("#b = :b")
        table.update_item(
            Key={"slackTeamId": slack_team_id},
            UpdateExpression="SET " + ", ".join(set_parts),
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
        )

        return respond(200, {"ok": True})

    except Exception as e:
        print(f"Slack register error: {e}")
        return respond(500, {"error": str(e)})
