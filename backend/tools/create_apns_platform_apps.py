#!/usr/bin/env python3
import argparse
import os
import re
import sys
from pathlib import Path

import boto3


DEFAULT_ENV_FILE = "backend/.env.push.local"
DEFAULT_SAMCONFIG = "backend/samconfig.toml"


def parse_args():
    parser = argparse.ArgumentParser(
        description="Create or update SNS APNS platform applications from a local env file."
    )
    parser.add_argument(
        "--env-file",
        default=DEFAULT_ENV_FILE,
        help=f"Path to env file with APNS settings (default: {DEFAULT_ENV_FILE})",
    )
    parser.add_argument(
        "--samconfig",
        default=DEFAULT_SAMCONFIG,
        help=f"Path to local samconfig.toml to patch with ARNs (default: {DEFAULT_SAMCONFIG})",
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


def iter_platform_applications(client):
    paginator = client.get_paginator("list_platform_applications")
    for page in paginator.paginate():
        for app in page.get("PlatformApplications", []):
            yield app["PlatformApplicationArn"]


def find_platform_application_arn(client, platform, name):
    suffix = f":app/{platform}/{name}"
    for arn in iter_platform_applications(client):
        if arn.endswith(suffix):
            return arn
    return None


def ensure_platform_application(client, *, name, platform, key_id, key_text, team_id, bundle_id):
    attributes = {
        "PlatformPrincipal": key_id,
        "PlatformCredential": key_text,
        "ApplePlatformTeamID": team_id,
        "ApplePlatformBundleID": bundle_id,
    }

    existing = find_platform_application_arn(client, platform, name)
    if existing:
        client.set_platform_application_attributes(
            PlatformApplicationArn=existing,
            Attributes=attributes,
        )
        return existing, False

    created = client.create_platform_application(
        Name=name,
        Platform=platform,
        Attributes=attributes,
    )
    return created["PlatformApplicationArn"], True


def update_parameter_overrides(raw, prod_arn, sandbox_arn):
    match = re.search(r'parameter_overrides\s*=\s*"([^"]*)"', raw)
    if not match:
        raise ValueError("Could not find parameter_overrides in samconfig.toml")

    overrides = match.group(1)
    replacements = {
        "ApnsPlatformApplicationArn": prod_arn,
        "ApnsSandboxPlatformApplicationArn": sandbox_arn,
    }

    for key, value in replacements.items():
        pattern = rf"(?:^| ){re.escape(key)}=[^ ]*"
        if re.search(pattern, overrides):
            overrides = re.sub(pattern, f" {key}={value}", overrides, count=1).lstrip()
        else:
            overrides = f"{overrides} {key}={value}".strip()

    return raw[: match.start(1)] + overrides + raw[match.end(1) :]


def patch_samconfig(path, prod_arn, sandbox_arn):
    samconfig_path = Path(path)
    if not samconfig_path.exists():
        raise FileNotFoundError(f"samconfig.toml not found: {samconfig_path}")

    raw = samconfig_path.read_text()
    updated = update_parameter_overrides(raw, prod_arn, sandbox_arn)
    if updated != raw:
        samconfig_path.write_text(updated)


def main():
    args = parse_args()
    load_env_file(args.env_file)

    key_path = Path(require_env("APNS_P8_PATH")).expanduser()
    if not key_path.exists():
        raise FileNotFoundError(f"APNS key file not found: {key_path}")

    client = sns_client()
    key_text = key_path.read_text().strip()
    key_id = require_env("APNS_KEY_ID")
    team_id = require_env("APPLE_TEAM_ID")
    bundle_id = require_env("APPLE_BUNDLE_ID")
    prod_name = os.environ.get("APNS_PROD_NAME", "pocketeng-prod").strip() or "pocketeng-prod"
    sandbox_name = os.environ.get("APNS_SANDBOX_NAME", "pocketeng-dev").strip() or "pocketeng-dev"

    prod_arn, prod_created = ensure_platform_application(
        client,
        name=prod_name,
        platform="APNS",
        key_id=key_id,
        key_text=key_text,
        team_id=team_id,
        bundle_id=bundle_id,
    )
    sandbox_arn, sandbox_created = ensure_platform_application(
        client,
        name=sandbox_name,
        platform="APNS_SANDBOX",
        key_id=key_id,
        key_text=key_text,
        team_id=team_id,
        bundle_id=bundle_id,
    )

    if not args.no_update_samconfig:
        patch_samconfig(args.samconfig, prod_arn, sandbox_arn)

    print(f"production_arn={prod_arn}")
    print(f"sandbox_arn={sandbox_arn}")
    print(f"production_status={'created' if prod_created else 'updated'}")
    print(f"sandbox_status={'created' if sandbox_created else 'updated'}")
    if not args.no_update_samconfig:
        print(f"samconfig_updated={Path(args.samconfig)}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
