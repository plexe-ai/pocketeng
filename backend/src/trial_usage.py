"""
GET /account/trial-usage — return how many sessions the caller has run
on trial-mode workspaces (the ones provisioned with PE_TRIAL_ANTHROPIC_KEY
auto-injected). UI surfaces this as a "X trial sessions used" sidebar
hint so users can see they're consuming the shared pool and decide
whether to connect their own subscription.

Why session count, not token count:
  Tracking real Anthropic token usage would mean instrumenting the
  bridge to emit a `usage.delta` event from each SDK message's
  `usage.input_tokens` / `usage.output_tokens`, plus a per-user counter
  table. Real work — worth doing later. For v1 the session count is a
  good-enough proxy: each session is a turn, each turn is some tokens,
  most users do <30 sessions in their first week.

Why not enforce a hard cap:
  Once a hard cap exists you have to handle the "user just hit the cap
  mid-session" UX (interrupt? complete the turn? start charging?),
  payment integration if you want them to upgrade, support requests
  when the cap is wrong. None of that exists yet. The number alone
  drives the same behavior change (user sees they're using a shared
  pool, connects their own creds) without owning the harder problem.
"""
from __future__ import annotations  # `tuple[...]` generic under Python <3.10
import json

from boto3.dynamodb.conditions import Key

from src.lib.auth import extract_auth_header, verify_token
from src.lib.db import _sessions, get_servers_by_user  # type: ignore


def respond(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def _count_sessions_on_server(server_id: str) -> int:
    """Use DDB's Select='COUNT' so we don't pay for item bytes when we
    only need the count. Paginates explicitly because Query caps each
    page at 1MB regardless of Select mode (a heavy user could span
    pages even at COUNT-only)."""
    table = _sessions()
    total = 0
    last_key = None
    while True:
        kwargs = {
            "IndexName": "serverId-updatedAt-index",
            "KeyConditionExpression": Key("serverId").eq(server_id),
            "Select": "COUNT",
        }
        if last_key:
            kwargs["ExclusiveStartKey"] = last_key
        resp = table.query(**kwargs)
        total += resp.get("Count", 0)
        last_key = resp.get("LastEvaluatedKey")
        if not last_key:
            return total


def handler(event, context):
    try:
        try:
            claims = verify_token(extract_auth_header(event.get("headers", {})))
        except Exception as e:
            return respond(401, {"error": str(e)})
        user_id = claims["sub"]

        servers = get_servers_by_user(user_id)
        # Only servers explicitly marked `trial: true` count toward the
        # shared-pool counter. BYOS workspaces and self-key workspaces
        # are billed against the user's own account, irrelevant here.
        trial_servers = [s for s in servers if bool(s.get("trial"))]
        if not trial_servers:
            # Caller has no trial workspace at all — nothing to surface.
            # UI hides the widget when used=0 AND hasTrialWorkspace=False.
            return respond(200, {
                "trialSessionsUsed": 0,
                "hasTrialWorkspace": False,
            })

        # Sum session count across all trial workspaces. Most users
        # will have exactly one (the one provisioned during onboarding),
        # so this is usually a single COUNT query.
        used = 0
        for srv in trial_servers:
            used += _count_sessions_on_server(srv["serverId"])

        return respond(200, {
            "trialSessionsUsed": used,
            "hasTrialWorkspace": True,
        })
    except Exception as exc:
        # Soft-fail: UI treats absence of data as "hide widget", so a
        # 200 with neutral payload is friendlier than a 500.
        print(f"trial_usage: unhandled error: {exc}")
        return respond(200, {
            "trialSessionsUsed": 0,
            "hasTrialWorkspace": False,
        })
