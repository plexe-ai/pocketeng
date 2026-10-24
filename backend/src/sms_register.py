"""
POST /sms/register — Register phone number + default server for SMS integration.
Authenticated endpoint (Supabase JWT required).
"""
import json
import os
import re

import boto3

from src.lib.auth import extract_auth_header, verify_token
from src.lib.db import get_server

_SMS_TABLE = os.environ.get("SMS_MAPPINGS_TABLE", "pe-sms-mappings-prod")
_ddb = boto3.resource("dynamodb")


def respond(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def handler(event, context):
    try:
        # Auth
        headers = event.get("headers", {})
        claims = verify_token(extract_auth_header(headers))
        user_id = claims["sub"]

        # Parse body
        body = json.loads(event.get("body", "{}"))
        phone = body.get("phoneNumber", "").strip()
        default_server_id = body.get("defaultServerId", "").strip()

        if not phone:
            return respond(400, {"error": "phoneNumber is required"})

        # Normalize to E.164
        phone = _normalize_phone(phone)
        if not _is_valid_e164(phone):
            return respond(400, {"error": "Invalid phone number. Use E.164 format (e.g. +447700900123)"})

        # Verify the server belongs to this user (if provided)
        if default_server_id:
            server = get_server(default_server_id)
            if not server or server.get("userId") != user_id:
                return respond(403, {"error": "Server not found or not yours"})

        # Upsert mapping
        table = _ddb.Table(_SMS_TABLE)
        item = {
            "phoneNumber": phone,
            "userId": user_id,
            "sessions": {},
        }
        if default_server_id:
            item["defaultServerId"] = default_server_id

        # Use update to preserve sessions if re-registering
        update_expr = "SET userId = :uid"
        expr_values = {":uid": user_id}

        if default_server_id:
            update_expr += ", defaultServerId = :sid"
            expr_values[":sid"] = default_server_id

        # Ensure sessions map exists
        update_expr += ", sessions = if_not_exists(sessions, :empty)"
        expr_values[":empty"] = {}

        table.update_item(
            Key={"phoneNumber": phone},
            UpdateExpression=update_expr,
            ExpressionAttributeValues=expr_values,
        )

        return respond(200, {
            "ok": True,
            "phoneNumber": phone,
            "defaultServerId": default_server_id or None,
        })

    except Exception as e:
        print(f"SMS register error: {e}")
        return respond(500, {"error": str(e)})


def _normalize_phone(phone: str) -> str:
    phone = phone.strip()
    # Remove spaces, dashes, parens
    phone = re.sub(r'[\s\-\(\)]', '', phone)
    if not phone.startswith("+"):
        phone = "+" + phone
    return phone


def _is_valid_e164(phone: str) -> bool:
    return bool(re.match(r'^\+[1-9]\d{6,14}$', phone))
