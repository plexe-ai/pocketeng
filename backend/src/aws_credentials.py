"""
POST   /account/aws-credentials — store the user's AWS access key (for
                                  provisioning EC2 in THEIR account).
GET    /account/aws-credentials — report whether a set is stored (no secrets).
DELETE /account/aws-credentials — remove.

Purpose: users who prefer "bring-your-own-cloud" give us an AWS Access Key ID
+ Secret (and optionally a preferred region). When a workspace is provisioned
in BYO-AWS mode, ProvisionFunction assumes these creds (instead of its own
Lambda execution role) before calling `ec2.RunInstances`, so the EC2 lives in
the user's account, on their bill.

Storage: KMS-encrypted secretAccessKey in DynamoDB. The accessKeyId is kept
plaintext (it's considered public in AWS's threat model; required for the
read-side so we can surface "AKIA...XYZA" to the user without round-tripping
through KMS).

This handler doesn't verify the credentials — validation happens in the
provision path where they're actually used. Onboarding just captures them.
"""
import json
from datetime import datetime, timezone

from src.lib.auth import extract_auth_header, verify_token
from src.lib.db import (
    delete_aws_credentials,
    get_aws_credentials,
    put_aws_credentials,
)
from src.lib.kms import encrypt


def respond(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _summarize(item: dict) -> dict:
    """Public-safe view — never includes the encrypted secret."""
    akid = item.get("accessKeyId", "")
    return {
        "accessKeyId": akid,           # AWS treats this as public
        "maskedAccessKeyId": (akid[:4] + "…" + akid[-4:]) if len(akid) >= 8 else akid,
        "region": item.get("region") or "us-east-1",
        "createdAt": item.get("createdAt"),
        "updatedAt": item.get("updatedAt"),
    }


def handler(event, context):
    try:
        try:
            claims = verify_token(extract_auth_header(event.get("headers", {})))
        except Exception as exc:
            return respond(401, {"error": str(exc)})

        user_id = claims["sub"]
        method = (
            event.get("requestContext", {}).get("http", {}).get("method")
            or event.get("httpMethod")
            or "POST"
        ).upper()

        if method == "GET":
            item = get_aws_credentials(user_id)
            return respond(200, {"credentials": _summarize(item) if item else None})

        if method == "DELETE":
            delete_aws_credentials(user_id)
            return respond(200, {"ok": True})

        # POST
        body = json.loads(event.get("body") or "{}")
        access_key_id = str(body.get("accessKeyId") or "").strip()
        secret_access_key = str(body.get("secretAccessKey") or "").strip()
        region = str(body.get("region") or "").strip() or "us-east-1"

        # Soft-validate shape so typos don't get stored. AWS access keys are
        # 16-128 alphanumerics that typically start with AKIA (IAM user) or
        # ASIA (STS session); we check prefix but not length. Secret key is
        # 40 base64-ish chars but formats have varied — only enforce min length.
        if not access_key_id or not secret_access_key:
            return respond(400, {"error": "accessKeyId and secretAccessKey required"})
        if not access_key_id.startswith(("AKIA", "ASIA")) or len(access_key_id) < 16:
            return respond(400, {
                "error": "accessKeyId doesn't look like an AWS key (expected AKIA… or ASIA… prefix)",
            })
        if len(secret_access_key) < 20:
            return respond(400, {"error": "secretAccessKey is too short"})

        existing = get_aws_credentials(user_id)
        now = _now_iso()
        item = {
            "userId": user_id,
            "accessKeyId": access_key_id,
            "encryptedSecretAccessKey": encrypt(secret_access_key),
            "region": region,
            "createdAt": existing.get("createdAt") if existing else now,
            "updatedAt": now,
        }
        put_aws_credentials(item)
        print(f"[aws-creds] STORED user={user_id} region={region} "
              f"akid={access_key_id[:4]}…{access_key_id[-4:]}")
        return respond(200, {"ok": True, "credentials": _summarize(item)})

    except Exception as exc:
        import traceback
        print(f"aws_credentials error: {exc}\n{traceback.format_exc()}")
        return respond(500, {"error": str(exc)})
