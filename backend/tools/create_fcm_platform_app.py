#!/usr/bin/env python3
"""
Create or update an SNS GCM (FCM) platform application for Android push
notifications, then patch the ARN into samconfig.toml.

Usage:
    # 1. Create backend/.env.fcm.local with your Firebase credentials:
    #
    #    FCM_SERVICE_ACCOUNT_JSON_PATH=~/path/to/firebase-service-account.json
    #    FCM_APP_NAME=pocketeng-android
    #
    # 2. Run:
    #    python backend/tools/create_fcm_platform_app.py
    #
    # The script will create/update the SNS platform application and
    # write the ARN into samconfig.toml so the next `sam deploy` picks it up.
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path

import boto3


DEFAULT_ENV_FILE = "backend/.env.fcm.local"
DEFAULT_SAMCONFIG = "backend/samconfig.toml"


def parse_args():
    parser = argparse.ArgumentParser(
        description="Create or update an SNS GCM platform application for FCM push."
    )
    parser.add_argument(
        "--env-file",
        default=DEFAULT_ENV_FILE,
        help=f"Path to env file with FCM settings (default: {DEFAULT_ENV_FILE})",
    )
    parser.add_argument(
        "--samconfig",
        default=DEFAULT_SAMCONFIG,
        help=f"Path to local samconfig.toml to patch (default: {DEFAULT_SAMCONFIG})",
    )
    parser.add_argument(
        "--no-update-samconfig",
        action="store_true",
        help="Do not modify samconfig.toml",
    )
    return parser.parse_args()


def load_env_file(path):
    values = {}
    env_path = Path(path)
    if not env_path.exists():
        raise FileNotFoundError(f"Env file not found: {env_path}")

    for raw_line in env_path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if value.startswith(("\"", "'")) and value.endswith(("\"", "'")) and len(value) >= 2:
            value = value[1:-1]
        values[key] = value
        os.environ.setdefault(key, value)
    return values


def require_env(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise ValueError(f"Missing required environment variable: {name}")
    return value


def sns_client():
    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"
    return boto3.client("sns", region_name=region)


def find_platform_application_arn(client, name):
    suffix = f":app/GCM/{name}"
    paginator = client.get_paginator("list_platform_applications")
    for page in paginator.paginate():
        for app in page.get("PlatformApplications", []):
            if app["PlatformApplicationArn"].endswith(suffix):
                return app["PlatformApplicationArn"]
    return None


def ensure_platform_application(client, *, name, service_account_json):
    """Create or update an SNS GCM platform application using FCM v1 credentials."""
    attributes = {
        "PlatformCredential": service_account_json,
    }

    existing = find_platform_application_arn(client, name)
    if existing:
        client.set_platform_application_attributes(
            PlatformApplicationArn=existing,
            Attributes=attributes,
        )
        return existing, False

    created = client.create_platform_application(
        Name=name,
        Platform="GCM",
        Attributes=attributes,
    )
    return created["PlatformApplicationArn"], True


def update_parameter_overrides(raw, fcm_arn):
    match = re.search(r'parameter_overrides\s*=\s*"([^"]*)"', raw)
    if not match:
        raise ValueError("Could not find parameter_overrides in samconfig.toml")

    overrides = match.group(1)
    key = "FcmPlatformApplicationArn"
    pattern = rf"(?:^| ){re.escape(key)}=[^ ]*"
    if re.search(pattern, overrides):
        overrides = re.sub(pattern, f" {key}={fcm_arn}", overrides, count=1).lstrip()
    else:
        overrides = f"{overrides} {key}={fcm_arn}".strip()

    return raw[: match.start(1)] + overrides + raw[match.end(1) :]


def patch_samconfig(path, fcm_arn):
    samconfig_path = Path(path)
    if not samconfig_path.exists():
        raise FileNotFoundError(f"samconfig.toml not found: {samconfig_path}")

    raw = samconfig_path.read_text()
    updated = update_parameter_overrides(raw, fcm_arn)
    if updated != raw:
        samconfig_path.write_text(updated)


def main():
    args = parse_args()
    load_env_file(args.env_file)

    sa_path = Path(require_env("FCM_SERVICE_ACCOUNT_JSON_PATH")).expanduser()
    if not sa_path.exists():
        raise FileNotFoundError(f"Firebase service account JSON not found: {sa_path}")

    # Validate it's valid JSON
    sa_text = sa_path.read_text().strip()
    sa_data = json.loads(sa_text)
    project_id = sa_data.get("project_id", "unknown")

    app_name = os.environ.get("FCM_APP_NAME", "pocketeng-android").strip() or "pocketeng-android"

    client = sns_client()
    arn, created = ensure_platform_application(
        client,
        name=app_name,
        service_account_json=sa_text,
    )

    if not args.no_update_samconfig:
        patch_samconfig(args.samconfig, arn)

    print(f"firebase_project={project_id}")
    print(f"fcm_arn={arn}")
    print(f"status={'created' if created else 'updated'}")
    if not args.no_update_samconfig:
        print(f"samconfig_updated={Path(args.samconfig)}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
