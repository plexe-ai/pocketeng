#!/usr/bin/env python3
"""
Apply Slack channel -> workspace routing from a JSON config.

The Slack bot routes an @mention / slash command to a workspace using the
`channelMappings` map stored on each team's row in the Slack mappings table
(consumed by backend/src/slack_worker.py). This tool lets anyone declare those
mappings in a reviewable JSON file instead of hand-writing DynamoDB updates.

Config shape (copy channel_mappings.example.json to channel_mappings.json):

    {
      "region": "us-east-1",
      "table": "pe-slack-mappings-prod",
      "teams": {
        "<slackTeamId>": {
          "_comment": "optional, ignored",
          "channels": {
            "<slackChannelId>": {
              "serverId": "<pe server id>",
              "userId":   "<pe user id>",   # optional: route to another
                                            # PE account (channel owner)
              "_comment": "optional, ignored"
            }
          }
        }
      }
    }

Any key starting with "_" is treated as a human comment and is NOT written to
DynamoDB. A channel entry may also be a bare "<serverId>" string.

Usage:
  python backend/tools/set_channel_map.py                    # apply default config
  python backend/tools/set_channel_map.py --file other.json  # apply a different file
  python backend/tools/set_channel_map.py --dry-run          # print, change nothing

Requires AWS credentials with write access to the table (e.g. AWS_PROFILE=prod).
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import boto3


DEFAULT_CONFIG = os.path.join(os.path.dirname(__file__), "channel_mappings.json")


def _strip_comments(entry):
    """Return the DynamoDB-bound entry: drop underscore-prefixed comment keys.

    A string entry (bare serverId) is passed through untouched.
    """
    if isinstance(entry, str):
        return entry
    if not isinstance(entry, dict):
        raise ValueError(f"channel entry must be a string or object, got {type(entry).__name__}")
    cleaned = {k: v for k, v in entry.items() if not k.startswith("_")}
    if "serverId" not in cleaned:
        raise ValueError(f"channel entry is missing 'serverId': {entry!r}")
    return cleaned


def apply_config(config: dict, dry_run: bool) -> None:
    region = config.get("region", "us-east-1")
    table_name = config.get("table") or "pe-slack-mappings-prod"
    teams = config.get("teams") or {}
    if not teams:
        print("No teams in config — nothing to do.")
        return

    table = boto3.resource("dynamodb", region_name=region).Table(table_name)
    print(f"Table: {table_name} (region {region}){'  [DRY RUN]' if dry_run else ''}\n")

    for team_id, team_cfg in teams.items():
        channels = (team_cfg or {}).get("channels") or {}
        print(f"Team {team_id}: {len(channels)} channel(s)")

        if not dry_run:
            # Make sure the map attribute exists before we set nested keys.
            table.update_item(
                Key={"slackTeamId": team_id},
                UpdateExpression="SET channelMappings = if_not_exists(channelMappings, :empty)",
                ExpressionAttributeValues={":empty": {}},
            )

        for channel_id, entry in channels.items():
            bound = _strip_comments(entry)
            print(f"  {channel_id} -> {json.dumps(bound)}")
            if not dry_run:
                table.update_item(
                    Key={"slackTeamId": team_id},
                    UpdateExpression="SET channelMappings.#c = :entry",
                    ExpressionAttributeNames={"#c": channel_id},
                    ExpressionAttributeValues={":entry": bound},
                )

        if not dry_run:
            item = table.get_item(Key={"slackTeamId": team_id}).get("Item", {})
            print(f"  now stored: {json.dumps(item.get('channelMappings', {}), default=str)}")
        print()


def main() -> int:
    parser = argparse.ArgumentParser(description="Apply Slack channel->workspace routing from JSON.")
    parser.add_argument("--file", default=DEFAULT_CONFIG, help=f"config path (default: {DEFAULT_CONFIG})")
    parser.add_argument("--dry-run", action="store_true", help="print planned changes without writing")
    args = parser.parse_args()

    try:
        with open(args.file, "r", encoding="utf-8") as fh:
            config = json.load(fh)
    except FileNotFoundError:
        print(f"Config not found: {args.file}", file=sys.stderr)
        return 1
    except json.JSONDecodeError as exc:
        print(f"Invalid JSON in {args.file}: {exc}", file=sys.stderr)
        return 1

    try:
        apply_config(config, dry_run=args.dry_run)
    except ValueError as exc:
        print(f"Config error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
