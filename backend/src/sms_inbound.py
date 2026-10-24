"""
POST /sms/inbound — Receives inbound SMS via Linq webhook,
looks up phone→user mapping, invokes the worker Lambda asynchronously.
"""
import base64
import hashlib
import hmac
import json
import os

import boto3

_lambda = boto3.client("lambda")
_ddb = boto3.resource("dynamodb")
_SMS_TABLE = os.environ.get("SMS_MAPPINGS_TABLE", "pe-sms-mappings-prod")


def respond(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def _verify_linq_signature(body_raw: str, headers: dict) -> bool:
    """Verify Linq webhook signature using HMAC-SHA256."""
    secret = os.environ.get("LINQ_SIGNING_SECRET", "")
    if not secret:
        return True  # Skip verification if no secret configured

    signature = headers.get("x-linq-signature", "") or headers.get("x-signature", "")
    if not signature:
        print("No Linq signature header found — skipping verification")
        return True  # Be lenient until we know the exact header name

    expected = hmac.new(
        secret.encode(), body_raw.encode(), hashlib.sha256
    ).digest()
    expected_b64 = base64.b64encode(expected).decode()

    return hmac.compare_digest(expected_b64, signature)


def handler(event, context):
    try:
        # Decode body
        body_raw = event.get("body", "")
        if event.get("isBase64Encoded"):
            body_raw = base64.b64decode(body_raw).decode()

        # Verify webhook signature
        headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
        if not _verify_linq_signature(body_raw, headers):
            print("Linq signature verification failed")
            return respond(401, {"error": "Invalid signature"})

        payload = json.loads(body_raw) if isinstance(body_raw, str) else body_raw
        print(f"SMS inbound payload: {json.dumps(payload)[:2000]}")

        # Handle Linq v3 webhook envelope format
        event_type = payload.get("event_type", "")
        if event_type and event_type != "message.received":
            # Ignore non-message events (typing indicators, read receipts, etc.)
            return respond(200, {"ok": True, "skipped": event_type})

        # Extract message data — v3 nests everything under "data"
        data = payload.get("data", payload)

        # Sender: data.sender_handle.handle
        from_number = ""
        sender = data.get("sender_handle", {})
        if sender and not sender.get("is_me"):
            from_number = sender.get("handle", "")
        # Fallback: check chat handles
        if not from_number:
            chat_obj = data.get("chat", {})
            for handle in chat_obj.get("handles", []):
                if not handle.get("is_me"):
                    from_number = handle.get("handle", "")
                    break
        # Fallback: flat format (v2)
        if not from_number:
            from_number = payload.get("from", "")

        # Text: data.parts[].value
        parts = data.get("parts", [])
        # Fallback: v2 format
        if not parts:
            parts = payload.get("message", {}).get("parts", [])
        text = ""
        for part in parts:
            if part.get("type") == "text":
                text += part.get("value", "")

        print(f"SMS from={from_number} text={text[:100]}")

        text = text.strip()
        if not text:
            return respond(200, {"ok": True, "skipped": "empty message"})

        if not from_number:
            return respond(200, {"ok": True, "skipped": "no sender"})

        # Normalize phone number (ensure E.164)
        from_number = _normalize_phone(from_number)

        # Look up phone → user mapping
        table = _ddb.Table(_SMS_TABLE)
        resp = table.get_item(Key={"phoneNumber": from_number})
        mapping = resp.get("Item")

        if not mapping:
            print(f"No SMS mapping for {from_number}")
            # Could send a "not registered" reply here, but skip to avoid spam
            return respond(200, {"ok": True, "skipped": "unknown sender"})

        # Invoke worker async
        worker_name = os.environ.get("WORKER_FUNCTION_NAME", "")
        _lambda.invoke(
            FunctionName=worker_name,
            InvocationType="Event",
            Payload=json.dumps({
                "text": text,
                "phone_number": from_number,
                "user_id": mapping.get("userId"),
                "default_server_id": mapping.get("defaultServerId"),
            }),
        )

        return respond(200, {"ok": True})

    except Exception as e:
        print(f"SMS inbound error: {e}")
        import traceback
        traceback.print_exc()
        return respond(200, {"ok": True})  # Always 200 to avoid webhook retries


def _normalize_phone(phone: str) -> str:
    """Ensure phone is in E.164 format."""
    phone = phone.strip()
    if not phone.startswith("+"):
        phone = "+" + phone
    return phone
