"""
POST /debug/log — forward client-side console.log/warn/error to CloudWatch.

Lets us see logs from TestFlight builds (where Safari Web Inspector is
disabled because the app is signed for distribution). Authenticated via
the standard Supabase JWT — same as every other API. Each log line is
tagged with userId so we can grep by user in CloudWatch.

Body shape (POSTed by the JS forwarder in lib/clientLog.ts):
    {
      "level": "info" | "warn" | "error" | "log",
      "message": "...",                # already-formatted string
      "tag": "[push]",                  # optional facet for grep
      "context": { ... },               # optional structured fields
    }

The handler intentionally does almost nothing — Lambda's stdout goes to
CloudWatch automatically, so a bare `print()` is the cheapest possible
log sink. Auth is enforced so this can't be turned into a public log
firehose by random callers.

Failure mode: returns 200 even on bad bodies so the JS forwarder doesn't
spam its own console with retry warnings. The only paths that return non-
200 are auth failures (401) and method-not-allowed (405).
"""
import json
import time

from src.lib.auth import extract_auth_header, verify_token


_ALLOWED_LEVELS = {"log", "info", "warn", "error", "debug"}


def _respond(status, body=None):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body or {}),
    }


def _http_method(event):
    rc = event.get("requestContext") or {}
    http = rc.get("http") or {}
    return (http.get("method") or event.get("httpMethod") or "POST").upper()


def handler(event, context):
    if _http_method(event) != "POST":
        return _respond(405, {"error": "method not allowed"})

    try:
        claims = verify_token(extract_auth_header(event.get("headers", {})))
    except Exception as exc:
        return _respond(401, {"error": str(exc)})

    user_id = claims.get("sub", "?")

    # We swallow JSON errors so a malformed call from the client doesn't
    # produce a 4xx that would make the forwarder retry-spam itself.
    try:
        body = json.loads(event.get("body") or "{}")
    except Exception:
        body = {"_parseError": True, "_rawBody": event.get("body")}

    raw_level = str(body.get("level") or "info").lower()
    level = raw_level if raw_level in _ALLOWED_LEVELS else "info"
    message = str(body.get("message") or "").replace("\n", " | ")[:4000]
    tag = str(body.get("tag") or "")
    ctx = body.get("context") if isinstance(body.get("context"), dict) else None

    # Single-line, grep-friendly format. CloudWatch doesn't strictly need
    # JSON, but a stable shape makes filtering trivial:
    #   aws logs tail ... | grep '"userId":"..."'
    record = {
        "ts": int(time.time() * 1000),
        "userId": user_id,
        "level": level,
        "tag": tag,
        "message": message,
        "context": ctx,
    }
    print(json.dumps(record))

    return _respond(200, {"ok": True})
