"""Unit tests for src/trial_usage.py.

Mocks the auth + DDB layers so we exercise the filtering logic
(only servers with trial=true count) and the soft-fail behavior."""
import json
import os
from unittest.mock import patch

os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")


def _event(jwt="ok"):
    return {"headers": {"Authorization": f"Bearer {jwt}"}}


class TestTrialUsage:
    def test_no_trial_workspace_returns_zero(self):
        # User has servers but none are trial=true → has=False, used=0.
        # UI uses has=False to hide the widget entirely.
        from src.trial_usage import handler
        with patch("src.trial_usage.verify_token", return_value={"sub": "u1"}), \
             patch("src.trial_usage.get_servers_by_user", return_value=[
                 {"serverId": "s1", "trial": False},
                 {"serverId": "s2"},  # missing field treated as not-trial
             ]):
            result = handler(_event(), {})
            body = json.loads(result["body"])
        assert result["statusCode"] == 200
        assert body == {"trialSessionsUsed": 0, "hasTrialWorkspace": False}

    def test_only_trial_servers_count(self):
        # Mixed trial + non-trial. Sessions on non-trial servers must
        # NOT be summed (otherwise BYOS users would see a meaningless
        # counter that includes their own-key sessions).
        from src.trial_usage import handler
        servers = [
            {"serverId": "trial-one", "trial": True},
            {"serverId": "byos-one", "trial": False},
            {"serverId": "trial-two", "trial": True},
        ]
        # Stub the count query: trial-one has 5, trial-two has 3,
        # byos-one would have 999 if we'd asked (we shouldn't).
        def fake_count(server_id):
            return {"trial-one": 5, "byos-one": 999, "trial-two": 3}[server_id]
        with patch("src.trial_usage.verify_token", return_value={"sub": "u1"}), \
             patch("src.trial_usage.get_servers_by_user", return_value=servers), \
             patch("src.trial_usage._count_sessions_on_server", side_effect=fake_count):
            result = handler(_event(), {})
            body = json.loads(result["body"])
        # 5 + 3 = 8. byos-one's 999 is excluded.
        assert body == {"trialSessionsUsed": 8, "hasTrialWorkspace": True}

    def test_unauthenticated_returns_401(self):
        from src.trial_usage import handler
        with patch("src.trial_usage.verify_token", side_effect=Exception("bad token")):
            result = handler(_event(), {})
        assert result["statusCode"] == 401

    def test_unhandled_exception_soft_fails_to_zero(self):
        # Any backend error should NOT bubble a 500 to the UI; the widget
        # treats absence of data as "hide quietly".
        from src.trial_usage import handler
        with patch("src.trial_usage.verify_token", return_value={"sub": "u1"}), \
             patch("src.trial_usage.get_servers_by_user", side_effect=RuntimeError("ddb down")):
            result = handler(_event(), {})
            body = json.loads(result["body"])
        assert result["statusCode"] == 200
        assert body == {"trialSessionsUsed": 0, "hasTrialWorkspace": False}
