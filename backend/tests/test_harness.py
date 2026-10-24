"""Unit tests for src/harness.py.

Mocks the auth + DDB layers so we exercise the snapshot assembly,
the approval-flow state transitions, and the empty-state path.

What we are NOT testing here:
  - The DDB integration itself (boto3 mock would just re-test boto3).
  - The frontend's sample-fallback — that's HarnessPanel.test.tsx
    territory once we add Playwright coverage.
"""
import json
import os
from unittest.mock import patch, MagicMock

os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
os.environ.setdefault("HARNESS_SUGGESTIONS_TABLE", "harness-suggestions-test")
os.environ.setdefault("HARNESS_VERSIONS_TABLE", "harness-versions-test")
os.environ.setdefault("HARNESS_RUN_SUMMARIES_TABLE", "harness-runs-test")


def _event(method="GET", body=None):
    return {
        "headers": {"Authorization": "Bearer ok"},
        "requestContext": {"http": {"method": method}},
        "body": json.dumps(body) if body is not None else None,
    }


class TestHarnessHandler:
    def test_get_returns_empty_snapshot_for_new_user(self):
        # Brand-new user — no rows in any table. We return a 200 with
        # neutral defaults so the panel can show its sample preview.
        from src.harness import handler
        with patch("src.harness.verify_token", return_value={"sub": "u1"}), \
             patch("src.harness._query_all", return_value=[]):
            result = handler(_event(), {})
            body = json.loads(result["body"])
        assert result["statusCode"] == 200
        assert body == {
            "currentVersion": None,
            "lastPromotedAt": None,
            "items": [],
            "history": [],
            "runSummaries": [],
        }

    def test_get_returns_full_snapshot_with_current_version(self):
        from src.harness import handler
        items = [
            {"userId": "u1", "itemId": "i1", "status": "live", "promotedAt": "2026-04-20T10:00:00Z"},
            {"userId": "u1", "itemId": "i2", "status": "pending"},
        ]
        versions = [  # ScanIndexForward=False so newest first
            {"userId": "u1", "versionSeq": 3, "version": "v0.3", "createdAt": "2026-04-25T00:00:00Z", "title": "Latest", "items": ["i1"], "note": ""},
            {"userId": "u1", "versionSeq": 2, "version": "v0.2", "createdAt": "2026-04-20T00:00:00Z", "title": "Older",  "items": [], "note": ""},
        ]
        runs = [{"userId": "u1", "createdAt": "2026-04-26T10:00:00Z", "runId": "r1", "title": "demo", "status": "merged", "repo": "x/y", "commands": [], "validations": [], "outcome": ""}]

        def fake_query_all(_table, _key, **kwargs):
            # Order-of-call: items, versions, runs.
            return fake_query_all.queue.pop(0)
        fake_query_all.queue = [items, versions, runs]

        with patch("src.harness.verify_token", return_value={"sub": "u1"}), \
             patch("src.harness._query_all", side_effect=fake_query_all):
            result = handler(_event(), {})
            body = json.loads(result["body"])
        assert result["statusCode"] == 200
        assert body["currentVersion"] == {"label": "v0.3", "versionSeq": 3, "createdAt": "2026-04-25T00:00:00Z"}
        # lastPromotedAt is the max of any item's promotedAt
        assert body["lastPromotedAt"] == "2026-04-20T10:00:00Z"
        assert len(body["items"]) == 2
        assert len(body["history"]) == 2
        assert len(body["runSummaries"]) == 1

    def test_post_promote_pending_to_live(self):
        # The happy path: user clicks Approve on a pending suggestion.
        # We verify the right UpdateExpression shape via a mock table.
        from src.harness import handler
        mock_table = MagicMock()
        mock_table.get_item.return_value = {"Item": {"userId": "u1", "itemId": "i1", "status": "pending"}}
        with patch("src.harness.verify_token", return_value={"sub": "u1"}), \
             patch("src.harness._suggestions_table", return_value=mock_table), \
             patch("src.harness._load_snapshot", return_value={"items": [{"itemId": "i1", "status": "live"}], "currentVersion": None, "lastPromotedAt": None, "history": [], "runSummaries": []}):
            result = handler(_event("POST", {"itemId": "i1", "action": "promote"}), {})
            body = json.loads(result["body"])
        assert result["statusCode"] == 200
        assert body["items"][0]["status"] == "live"
        # Verify the UpdateExpression flipped status + stamped promotedAt
        call = mock_table.update_item.call_args
        assert call.kwargs["Key"] == {"userId": "u1", "itemId": "i1"}
        assert "promotedAt" in call.kwargs["UpdateExpression"]
        assert call.kwargs["ExpressionAttributeValues"][":status"] == "live"

    def test_post_dismiss_pending(self):
        from src.harness import handler
        mock_table = MagicMock()
        mock_table.get_item.return_value = {"Item": {"userId": "u1", "itemId": "i1", "status": "pending"}}
        with patch("src.harness.verify_token", return_value={"sub": "u1"}), \
             patch("src.harness._suggestions_table", return_value=mock_table), \
             patch("src.harness._load_snapshot", return_value={"items": [], "currentVersion": None, "lastPromotedAt": None, "history": [], "runSummaries": []}):
            result = handler(_event("POST", {"itemId": "i1", "action": "dismiss"}), {})
        assert result["statusCode"] == 200
        call = mock_table.update_item.call_args
        # Dismiss must NOT stamp promotedAt — that's reserved for the
        # approval path so the timeline stays meaningful.
        assert "promotedAt" not in call.kwargs["UpdateExpression"]
        assert call.kwargs["ExpressionAttributeValues"][":status"] == "dismissed"

    def test_post_unknown_action_returns_400(self):
        from src.harness import handler
        with patch("src.harness.verify_token", return_value={"sub": "u1"}):
            result = handler(_event("POST", {"itemId": "i1", "action": "frobnicate"}), {})
        assert result["statusCode"] == 400

    def test_post_missing_fields_returns_400(self):
        from src.harness import handler
        with patch("src.harness.verify_token", return_value={"sub": "u1"}):
            result = handler(_event("POST", {"itemId": "i1"}), {})
        assert result["statusCode"] == 400

    def test_post_unknown_item_returns_404(self):
        from src.harness import handler
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}
        with patch("src.harness.verify_token", return_value={"sub": "u1"}), \
             patch("src.harness._suggestions_table", return_value=mock_table):
            result = handler(_event("POST", {"itemId": "missing", "action": "promote"}), {})
        assert result["statusCode"] == 404

    def test_unauthenticated_returns_401(self):
        from src.harness import handler
        with patch("src.harness.verify_token", side_effect=Exception("bad token")):
            result = handler(_event(), {})
        assert result["statusCode"] == 401

    def test_unhandled_exception_soft_fails_to_empty_snapshot(self):
        # A hard error mid-snapshot-assembly should not crash the panel.
        # Drop to neutral defaults so the frontend can show its sample.
        from src.harness import handler
        with patch("src.harness.verify_token", return_value={"sub": "u1"}), \
             patch("src.harness._query_all", side_effect=RuntimeError("ddb down")):
            result = handler(_event(), {})
            body = json.loads(result["body"])
        assert result["statusCode"] == 200
        assert body["items"] == []
        assert body["currentVersion"] is None
