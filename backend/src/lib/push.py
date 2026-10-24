import json
import os
import re
from boto3 import client as boto3_client
from botocore.exceptions import ClientError

from src.lib.db import delete_push_device, get_push_devices_by_user


_sns = boto3_client(
    "sns",
    region_name=(
        os.environ.get("AWS_REGION")
        or os.environ.get("AWS_DEFAULT_REGION")
        or "us-east-1"
    ),
)


class PushConfigurationError(Exception):
    pass


def _platform_application_arn(push_environment, platform="ios"):
    normalized = (push_environment or "").strip().lower()
    if platform == "android":
        arn = os.environ.get("FCM_PLATFORM_APPLICATION_ARN", "").strip()
        if not arn:
            raise PushConfigurationError("FCM push is not configured")
        return arn
    if normalized == "production":
        return os.environ.get("APNS_PLATFORM_APPLICATION_ARN", "").strip()
    if normalized in {"sandbox", "development", "debug"}:
        return os.environ.get("APNS_SANDBOX_PLATFORM_APPLICATION_ARN", "").strip()
    raise PushConfigurationError(f"Unsupported push environment: {push_environment}")


def ensure_push_endpoint(token, push_environment, endpoint_arn=None, custom_user_data=None, platform="ios"):
    platform_application_arn = _platform_application_arn(push_environment, platform=platform)
    if not platform_application_arn:
        raise PushConfigurationError(f"{platform} push is not configured")

    attributes = {
        "Token": token,
        "Enabled": "true",
    }
    if custom_user_data:
        attributes["CustomUserData"] = custom_user_data

    if endpoint_arn:
        _sns.set_endpoint_attributes(
            EndpointArn=endpoint_arn,
            Attributes=attributes,
        )
        return endpoint_arn

    kwargs = {
        "PlatformApplicationArn": platform_application_arn,
        "Token": token,
    }
    if custom_user_data:
        kwargs["CustomUserData"] = custom_user_data

    try:
        response = _sns.create_platform_endpoint(**kwargs)
        return response["EndpointArn"]
    except ClientError as exc:
        message = exc.response.get("Error", {}).get("Message", "")
        marker = "Endpoint "
        suffix = " already exists with the same Token"
        if marker in message and suffix in message:
            start = message.index(marker) + len(marker)
            end = message.index(suffix)
            existing_endpoint_arn = message[start:end]
            _sns.set_endpoint_attributes(
                EndpointArn=existing_endpoint_arn,
                Attributes=attributes,
            )
            return existing_endpoint_arn
        raise


def delete_push_endpoint(endpoint_arn):
    if not endpoint_arn:
        return
    _sns.delete_endpoint(EndpointArn=endpoint_arn)


def build_session_notification(session, transcript):
    session_title = _session_title(session)
    assistant = transcript[-1] if transcript and transcript[-1].get("role") == "assistant" else None
    response_text = (assistant or {}).get("content", "").strip()
    assistant_state = (assistant or {}).get("state")

    # Autopilot sessions get richer notifications
    if session.get("autopilot"):
        pr_url = session.get("prUrl")
        validation_output = session.get("lastValidationOutput")
        validation_attempts = int(session.get("validationAttempt", 0) or 0)
        if validation_output and validation_attempts > 0:
            # Terminal validation failure — agent ran out of retries.
            tail = _truncate(validation_output.strip().splitlines()[-1] if validation_output.strip() else "see logs", 90)
            return {
                "kind": "error",
                "title": "validation failed",
                "body": f"\"{session_title}\" — {tail}",
            }
        if assistant_state == "error":
            return {
                "kind": "error",
                "title": "autopilot failed",
                "body": _truncate(f"\"{session_title}\" errored", 120),
            }
        if pr_url:
            pr_match = re.search(r'github\.com/([^/]+/[^/]+)/pull/(\d+)', pr_url)
            pr_label = f"{pr_match.group(1)}#{pr_match.group(2)}" if pr_match else pr_url
            return {
                "kind": "task-complete",
                "title": "PR created",
                "body": pr_label,
            }
        return {
            "kind": "task-complete",
            "title": "done",
            "body": f"\"{session_title}\" finished (no PR created)",
        }

    if assistant_state == "error":
        error_body = _truncate(response_text or f"{session_title} needs attention", 120)
        return {
            "kind": "error",
            "title": "error",
            "body": f"{session_title}: {error_body}",
        }

    if _response_needs_user_input(response_text):
        return {
            "kind": "task-complete",
            "title": "needs your input",
            "body": f"\"{session_title}\" is waiting",
        }

    return {
        "kind": "task-complete",
        "title": "done",
        "body": f"\"{session_title}\" finished",
    }


def send_session_notification(session, transcript):
    user_id = session.get("userId")
    if not user_id:
        return 0

    devices = get_push_devices_by_user(user_id, limit=20)
    if not devices:
        return 0

    plan = build_session_notification(session, transcript)
    sent = 0

    for device in devices:
        endpoint_arn = device.get("endpointArn")
        installation_id = device.get("installationId")
        if not endpoint_arn or not installation_id:
            continue

        try:
            _publish_to_endpoint(endpoint_arn, session, plan)
            sent += 1
        except ClientError as exc:
            error_code = exc.response.get("Error", {}).get("Code")
            if error_code in {"EndpointDisabled", "NotFound", "InvalidParameter"}:
                try:
                    delete_push_device(installation_id)
                except Exception:
                    pass
                continue
            raise

    return sent


def _publish_to_endpoint(endpoint_arn, session, plan):
    pe_data = {
        "sessionId": session.get("sessionId"),
        "serverId": session.get("serverId"),
        "kind": plan["kind"],
    }

    apns_payload = {
        "aps": {
            "alert": {
                "title": plan["title"],
                "body": plan["body"],
            },
            "sound": "default",
            "thread-id": session.get("serverId", "pocketengineer"),
        },
        "pe": pe_data,
    }

    gcm_payload = {
        "notification": {
            "title": plan["title"],
            "body": plan["body"],
            "tag": session.get("serverId", "pocketengineer"),
        },
        "data": {k: str(v) for k, v in pe_data.items() if v is not None},
    }

    message = json.dumps({
        "default": plan["body"],
        "APNS": json.dumps(apns_payload),
        "APNS_SANDBOX": json.dumps(apns_payload),
        "GCM": json.dumps(gcm_payload),
    })

    _sns.publish(
        TargetArn=endpoint_arn,
        MessageStructure="json",
        Message=message,
    )


def _session_title(session):
    raw = (
        session.get("prompt")
        or session.get("lastPrompt")
        or "Session"
    )
    normalized = " ".join(str(raw).strip().split())
    return _truncate(normalized or "Session", 72)


def _truncate(text, limit):
    if len(text) <= limit:
        return text
    return text[: max(limit - 1, 0)].rstrip() + "…"


def _response_needs_user_input(text):
    trimmed = str(text or "").strip()
    if not trimmed:
        return False

    paragraphs = [
        paragraph.strip()
        for paragraph in trimmed.split("\n\n")
        if paragraph.strip()
    ]
    if not paragraphs:
        return False

    last_paragraph = paragraphs[-1]
    lines = [line.strip() for line in last_paragraph.splitlines() if line.strip()]
    numbered = [
        line for line in lines
        if _is_numbered_option(line)
    ]
    if 2 <= len(numbered) <= 4:
        return True

    return last_paragraph.endswith("?")


def _is_numbered_option(line):
    parts = line.split(".", 1)
    if len(parts) != 2:
        return False
    left, right = parts
    return left.strip().isdigit() and bool(right.strip())
