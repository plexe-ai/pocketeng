"""
GET /harness — return the user's full harness snapshot
POST /harness — promote / dismiss / move-back a single suggestion

Why this handler exists at all:
  The HarnessFunction Lambda + its three DDB tables (HarnessSuggestions,
  HarnessVersions, HarnessRunSummaries) were provisioned in template.yaml
  before any of the harness UX work. Until this file landed, every call
  to /harness 500'd, and the frontend HarnessPanel fell back to the
  curated SAMPLE_SNAPSHOT in HarnessPanel.tsx.

  This is the v1 implementation: pure read/write against the existing
  tables, no automatic suggestion-generation pipeline yet. New items get
  written to DDB by some upstream producer (the agent's post-session
  reflection step, a CI-driven scar harvester, or a manual seeding
  script) — this handler just exposes them and gates promotion behind
  user approval.

Empty-state behavior:
  If a user has never accumulated any harness data we return an empty
  but well-shaped snapshot. The frontend treats that as "show the sample
  preview pill" — same UX as a 5xx, just without the error noise. That
  way a fresh signup doesn't see a scary error on first open.

Auth:
  Standard Supabase JWT path (extract_auth_header → verify_token →
  claims['sub']). Per-user data is keyed by `userId == claims['sub']`,
  so a malformed or missing token can't read anyone else's harness.
"""
from __future__ import annotations  # `dict[str, ...]` generic under Python <3.10
import json
import os
import time

import boto3
from boto3.dynamodb.conditions import Key

from src.lib.auth import extract_auth_header, verify_token


_ddb = boto3.resource("dynamodb")


def _suggestions_table():
    return _ddb.Table(os.environ["HARNESS_SUGGESTIONS_TABLE"])


def _versions_table():
    return _ddb.Table(os.environ["HARNESS_VERSIONS_TABLE"])


def _runs_table():
    return _ddb.Table(os.environ["HARNESS_RUN_SUMMARIES_TABLE"])


def _respond(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body, default=_json_default),
    }


def _json_default(obj):
    """DynamoDB Decimal → int/float for json.dumps. We never store
    fractional Decimals in this domain (versionSeq is always an int and
    confidence is materialized client-side from the original float in
    `evidence`), so this just unwraps. If we ever do store fractional
    values, change to `float(obj)` — the dashboard renders them as a
    pip count anyway, no precision concerns."""
    try:
        from decimal import Decimal  # local import — only needed on the rare path
        if isinstance(obj, Decimal):
            return int(obj) if obj == int(obj) else float(obj)
    except Exception:
        pass
    raise TypeError(f"Object of type {obj.__class__.__name__} is not JSON serializable")


def _query_all(table, key_condition, *, scan_forward=True, limit=None):
    """Paginate a Query through LastEvaluatedKey. Most user harnesses
    will fit in one page (<1MB), but a long-running power user with
    hundreds of suggestions could span pages — we don't want to silently
    truncate them in the UI."""
    items = []
    last_key = None
    while True:
        kwargs = {"KeyConditionExpression": key_condition, "ScanIndexForward": scan_forward}
        if last_key:
            kwargs["ExclusiveStartKey"] = last_key
        if limit is not None:
            kwargs["Limit"] = limit
        resp = table.query(**kwargs)
        items.extend(resp.get("Items", []))
        last_key = resp.get("LastEvaluatedKey")
        if not last_key or limit is not None:
            return items


def _load_snapshot(user_id: str) -> dict:
    """Assemble the read-only HarnessSnapshot for one user."""
    items = _query_all(_suggestions_table(), Key("userId").eq(user_id))
    versions = _query_all(_versions_table(), Key("userId").eq(user_id), scan_forward=False)
    # Most-recent runs first, capped at 20 so we never blow the response
    # size budget on a chatty user. The frontend Timeline only renders
    # the first 4 anyway.
    runs = _query_all(_runs_table(), Key("userId").eq(user_id), scan_forward=False, limit=20)

    current_version = None
    last_promoted_at = None
    if versions:
        v = versions[0]
        current_version = {
            "label": v.get("version", f"v{int(v.get('versionSeq', 0))}"),
            "versionSeq": int(v.get("versionSeq", 0)),
            "createdAt": v.get("createdAt", ""),
        }
    promoted_dates = [item.get("promotedAt") for item in items if item.get("promotedAt")]
    if promoted_dates:
        last_promoted_at = max(promoted_dates)

    return {
        "currentVersion": current_version,
        "lastPromotedAt": last_promoted_at,
        "items": items,
        "history": versions,
        "runSummaries": runs,
    }


def _update_item_status(user_id: str, item_id: str, action: str) -> dict:
    """Apply an approval-flow action to a single suggestion.

    Allowed transitions (kept narrow on purpose — random ad-hoc state
    moves are how approval-gated workflows turn into "we promoted that
    by accident"):

      promote   : pending  → live      (user said yes)
      dismiss   : pending  → dismissed (user said no)
      move-back : dismissed→ pending   (user changed their mind)

    Anything else is a 4xx.
    """
    if action not in ("promote", "dismiss", "move-back"):
        raise ValueError(f"unknown action: {action}")

    table = _suggestions_table()
    existing = table.get_item(Key={"userId": user_id, "itemId": item_id}).get("Item")
    if not existing:
        raise LookupError(f"item not found: {item_id}")

    current_status = existing.get("status")
    now = _now_iso()

    if action == "promote":
        if current_status not in ("pending", "dismissed"):
            # Already live — make this idempotent so a double-tap doesn't
            # error in the UI. UpdatedAt bumps so timeline stays useful.
            updates = {":updatedAt": now}
            update_expr = "SET updatedAt = :updatedAt"
        else:
            updates = {":status": "live", ":updatedAt": now, ":promotedAt": now}
            update_expr = "SET #s = :status, updatedAt = :updatedAt, promotedAt = :promotedAt"
    elif action == "dismiss":
        if current_status == "dismissed":
            updates = {":updatedAt": now}
            update_expr = "SET updatedAt = :updatedAt"
        else:
            updates = {":status": "dismissed", ":updatedAt": now}
            update_expr = "SET #s = :status, updatedAt = :updatedAt"
    else:  # move-back
        if current_status != "dismissed":
            raise ValueError("move-back only valid from dismissed")
        updates = {":status": "pending", ":updatedAt": now}
        update_expr = "SET #s = :status, updatedAt = :updatedAt"

    expr_names = {"#s": "status"} if "#s" in update_expr else None
    kwargs = dict(
        Key={"userId": user_id, "itemId": item_id},
        UpdateExpression=update_expr,
        ExpressionAttributeValues=updates,
        ReturnValues="ALL_NEW",
    )
    if expr_names:
        kwargs["ExpressionAttributeNames"] = expr_names
    table.update_item(**kwargs)
    return _load_snapshot(user_id)


def _now_iso() -> str:
    # ISO-8601 in UTC with explicit Z suffix — keeps the wire format
    # consistent with how the rest of the backend stamps createdAt.
    t = time.gmtime()
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", t)


def handler(event, context):
    try:
        try:
            claims = verify_token(extract_auth_header(event.get("headers", {})))
        except Exception as e:
            return _respond(401, {"error": str(e)})
        user_id = claims["sub"]

        method = event.get("requestContext", {}).get("http", {}).get("method") or event.get("httpMethod") or "GET"
        method = method.upper()

        if method == "GET":
            return _respond(200, _load_snapshot(user_id))

        if method == "POST":
            try:
                body = json.loads(event.get("body") or "{}")
            except json.JSONDecodeError:
                return _respond(400, {"error": "invalid JSON body"})
            item_id = body.get("itemId")
            action = body.get("action")
            if not item_id or not action:
                return _respond(400, {"error": "itemId and action are required"})
            try:
                snapshot = _update_item_status(user_id, item_id, action)
            except LookupError as e:
                return _respond(404, {"error": str(e)})
            except ValueError as e:
                return _respond(400, {"error": str(e)})
            return _respond(200, snapshot)

        return _respond(405, {"error": f"method not allowed: {method}"})
    except Exception as exc:
        # Last-resort guard — never let an internal error rendering the
        # snapshot crash the panel. Log it (CloudWatch picks up stdout)
        # and return a neutral empty snapshot so the frontend's sample
        # fallback kicks in. Same shape as a fresh signup.
        print(f"harness: unhandled error: {exc}")
        return _respond(200, {
            "currentVersion": None,
            "lastPromotedAt": None,
            "items": [],
            "history": [],
            "runSummaries": [],
        })
