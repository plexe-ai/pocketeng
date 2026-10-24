"""
POST /linear/webhook — Receives Linear webhook events.
Filters for label changes (adding "Pocket Eng" label), dispatches to LinearWorkerFunction.
"""
import base64
import json
import os

import boto3

from src.lib.linear import verify_webhook_signature

_lambda = boto3.client("lambda")
_ddb = boto3.resource("dynamodb")

_TABLE = os.environ.get("LINEAR_MAPPINGS_TABLE", "pe-linear-mappings-prod")


def respond(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def handler(event, context):
    try:
        body_raw = event.get("body", "")
        if event.get("isBase64Encoded"):
            body_raw = base64.b64decode(body_raw).decode()

        # Verify webhook signature
        headers = event.get("headers", {})
        signature = headers.get("linear-signature", "") or headers.get("x-linear-signature", "")
        secret = os.environ.get("LINEAR_WEBHOOK_SECRET", "")

        if secret and signature:
            try:
                verify_webhook_signature(body_raw, signature, secret)
            except Exception as e:
                print(f"Linear signature verification failed: {e}")
                return respond(401, {"error": "Invalid signature"})

        payload = json.loads(body_raw)

        # Linear sends different event types
        action = payload.get("action")
        event_type = payload.get("type")

        # Only handle issue updates (label changes)
        if event_type != "Issue":
            return respond(200, {"ok": True, "skipped": "not an issue event"})

        if action not in ("create", "update"):
            return respond(200, {"ok": True, "skipped": f"action={action}"})

        data = payload.get("data", {})
        issue_id = data.get("id")
        team_id = data.get("teamId")
        label_ids = data.get("labelIds") or []
        updated_from = payload.get("updatedFrom") or {}
        prev_label_ids = updated_from.get("labelIds")

        print(f"Linear webhook: type={event_type} action={action} issue={issue_id} team={team_id} labels={label_ids} prev_labels={prev_label_ids}")

        if not issue_id or not team_id:
            return respond(200, {"ok": True, "skipped": "missing issueId or teamId"})

        # For "create" action, treat all labels as newly added
        if action == "create":
            prev_label_ids = []

        # If updatedFrom doesn't include labelIds, this isn't a label change
        if prev_label_ids is None:
            return respond(200, {"ok": True, "skipped": "not a label change"})

        # Look up mapping for this team
        table = _ddb.Table(_TABLE)
        resp = table.get_item(Key={"linearTeamId": team_id})
        mapping = resp.get("Item")

        if not mapping:
            # Try looking up by team key (e.g., "ENG" instead of UUID)
            team_key = data.get("team", {}).get("key", "")
            if team_key:
                resp = table.get_item(Key={"linearTeamId": team_key})
                mapping = resp.get("Item")

        if not mapping:
            print(f"No mapping for Linear team {team_id}")
            return respond(200, {"ok": True, "skipped": "no mapping for team"})

        # Check if the "Pocket Eng" label was just added
        bot_label_id = mapping.get("botLabelId", "")
        if not bot_label_id:
            return respond(200, {"ok": True, "skipped": "no botLabelId configured"})

        label_just_added = bot_label_id in label_ids and bot_label_id not in prev_label_ids
        if not label_just_added:
            return respond(200, {"ok": True, "skipped": "Pocket Eng label not newly added"})

        # Dispatch to worker
        worker_name = os.environ.get("WORKER_FUNCTION_NAME", "")
        if not worker_name:
            return respond(500, {"error": "WORKER_FUNCTION_NAME not configured"})

        worker_payload = {
            "issueId": issue_id,
            "teamId": team_id,
            "linearTeamId": mapping.get("linearTeamId"),
            "userId": mapping.get("userId"),
            "accessToken": mapping.get("accessToken"),  # encrypted
            "title": data.get("title", ""),
            "description": data.get("description", ""),
        }

        _lambda.invoke(
            FunctionName=worker_name,
            InvocationType="Event",
            Payload=json.dumps(worker_payload),
        )

        return respond(200, {"ok": True, "dispatched": issue_id})

    except Exception as e:
        print(f"Linear webhook error: {e}")
        return respond(200, {"ok": True})
