"""
POST /linear/register — Store Linear team → PE user mapping.
Called from the frontend after OAuth completes.
"""
import json
import os
from datetime import datetime, timezone

import boto3

from src.lib.auth import extract_auth_header, verify_token
from src.lib.kms import encrypt
from src.lib.linear import create_webhook, find_or_create_label

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
        try:
            claims = verify_token(extract_auth_header(event.get("headers", {})))
        except Exception as e:
            return respond(401, {"error": str(e)})

        user_id = claims["sub"]
        body = json.loads(event.get("body") or "{}")

        linear_team_id = body.get("linearTeamId", "").strip()
        linear_team_uuid = body.get("linearTeamUuid", "").strip()
        access_token = body.get("accessToken", "").strip()

        if not linear_team_id or not access_token:
            return respond(400, {"error": "linearTeamId and accessToken required"})

        table = _ddb.Table(_TABLE)
        now = datetime.now(timezone.utc).isoformat()
        setup_errors = []

        # Use the user's OAuth token (has admin scope if user is a Linear admin)
        # Auto-create the "Pocket Eng" label in Linear so users can trigger the agent
        bot_label_id = None
        if linear_team_uuid:
            try:
                bot_label_id = find_or_create_label(access_token, linear_team_uuid)
            except Exception as e:
                print(f"Failed to create 'Pocket Eng' label (non-fatal): {e}")
                setup_errors.append("Could not create or verify the Pocket Eng label.")
        else:
            setup_errors.append("Missing Linear team UUID, so Pocket Eng could not verify team setup.")

        item = {
            "linearTeamId": linear_team_id,
            "userId": user_id,
            "accessToken": encrypt(access_token),
            "botLabelId": bot_label_id or None,
            "createdAt": now,
            "updatedAt": now,
        }
        if linear_team_uuid:
            item["linearTeamUuid"] = linear_team_uuid

        table.put_item(Item=item)

        # Also store a mapping by UUID so webhooks (which use UUID) can find it
        if linear_team_uuid:
            uuid_item = dict(item)
            uuid_item["linearTeamId"] = linear_team_uuid
            uuid_item["linearTeamKey"] = linear_team_id  # keep the key for reference
            table.put_item(Item=uuid_item)

        # Auto-create webhook in Linear so the user doesn't have to do it manually
        webhook_id = None
        if linear_team_uuid:
            try:
                public_api_base = os.environ.get("PUBLIC_API_BASE_URL", "").strip()
                webhook_secret = os.environ.get("LINEAR_WEBHOOK_SECRET", "").strip()
                if public_api_base:
                    webhook_url = f"{public_api_base}/linear/webhook"
                    webhook_id = create_webhook(access_token, linear_team_uuid, webhook_url, webhook_secret)
                else:
                    setup_errors.append("PUBLIC_API_BASE_URL is not configured, so the Linear webhook could not be created.")
            except Exception as e:
                print(f"Failed to create Linear webhook (non-fatal): {e}")
                setup_errors.append("Could not create or verify the Linear webhook.")

        label_ready = bot_label_id is not None
        webhook_ready = webhook_id is not None

        return respond(200, {
            "ok": True,
            "linearTeamId": linear_team_id,
            "webhookCreated": webhook_ready,
            "labelCreated": label_ready,
            "verified": label_ready and webhook_ready,
            "setupErrors": setup_errors,
        })

    except Exception as e:
        print(f"Linear register error: {e}")
        return respond(500, {"error": str(e)})
