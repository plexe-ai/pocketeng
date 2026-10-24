"""
POST   /devices/push — register a device (iOS or Android) for push notifications
DELETE /devices/push — unregister the current device on sign-out
"""
import json
from datetime import datetime, timezone

from src.lib.auth import extract_auth_header, verify_token
from src.lib.db import (
    delete_push_device,
    get_push_device,
    put_push_device,
    update_push_device,
)
from src.lib.push import (
    PushConfigurationError,
    delete_push_endpoint,
    ensure_push_endpoint,
)


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def respond(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def _http_method(event):
    request_context = event.get("requestContext") or {}
    http_context = request_context.get("http") or {}
    return (
        http_context.get("method")
        or event.get("httpMethod")
        or "POST"
    ).upper()


def _register(user_id, body):
    installation_id = str(body.get("installationId") or "").strip()
    token = str(body.get("token") or "").strip()
    platform = str(body.get("platform") or "").strip().lower()
    push_environment = str(body.get("pushEnvironment") or "").strip().lower()

    if not installation_id:
        return respond(400, {"error": "installationId required"})
    if not token:
        return respond(400, {"error": "token required"})
    if platform not in {"ios", "android"}:
        return respond(400, {"error": "platform must be ios or android"})
    if platform == "ios" and push_environment not in {"sandbox", "production"}:
        return respond(400, {"error": "pushEnvironment must be sandbox or production"})
    # Android doesn't distinguish sandbox/production — normalize to "production"
    if platform == "android":
        push_environment = "production"

    now = _now_iso()
    existing = get_push_device(installation_id)

    endpoint_arn = (existing or {}).get("endpointArn")
    existing_environment = (existing or {}).get("pushEnvironment")
    existing_platform = (existing or {}).get("platform")
    # Re-create endpoint if environment or platform changed
    if endpoint_arn and (
        (existing_environment and existing_environment != push_environment)
        or (existing_platform and existing_platform != platform)
    ):
        try:
            delete_push_endpoint(endpoint_arn)
        except Exception:
            pass
        endpoint_arn = None

    try:
        endpoint_arn = ensure_push_endpoint(
            token=token,
            push_environment=push_environment,
            endpoint_arn=endpoint_arn,
            custom_user_data=f"{user_id}:{installation_id}",
            platform=platform,
        )
    except PushConfigurationError as exc:
        return respond(503, {"error": str(exc)})

    updates = {
        "userId": user_id,
        "platform": platform,
        "pushEnvironment": push_environment,
        "token": token,
        "endpointArn": endpoint_arn,
        "bundleId": body.get("bundleId"),
        "appVersion": body.get("appVersion"),
        "deviceName": body.get("deviceName"),
        "updatedAt": now,
    }

    if existing:
        update_push_device(installation_id, updates)
    else:
        put_push_device({
            "installationId": installation_id,
            "createdAt": now,
            **updates,
        })

    return respond(200, {"ok": True, "installationId": installation_id})


def _unregister(user_id, body):
    installation_id = str(body.get("installationId") or "").strip()
    if not installation_id:
        return respond(400, {"error": "installationId required"})

    existing = get_push_device(installation_id)
    if not existing:
        return respond(200, {"ok": True})

    if existing.get("userId") not in {None, user_id}:
        return respond(200, {"ok": True})

    try:
        delete_push_endpoint(existing.get("endpointArn"))
    except Exception:
        pass

    delete_push_device(installation_id)
    return respond(200, {"ok": True})


def handler(event, context):
    try:
        try:
            claims = verify_token(extract_auth_header(event.get("headers", {})))
        except Exception as exc:
            return respond(401, {"error": str(exc)})

        user_id = claims["sub"]
        method = _http_method(event)
        body = json.loads(event.get("body") or "{}")

        if method == "POST":
            return _register(user_id, body)
        if method == "DELETE":
            return _unregister(user_id, body)
        return respond(405, {"error": f"Unsupported method: {method}"})

    except Exception as exc:
        import traceback
        print(f"Push devices error: {exc}\n{traceback.format_exc()}")
        return respond(500, {"error": str(exc)})
