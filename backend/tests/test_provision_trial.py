"""Unit tests for the trial-key substitution logic in provision.py.

Kept narrow on purpose — the full provision handler touches EC2, KMS,
DDB and is integration-test-heavy. The trial logic was extracted into a
pure function (`_resolve_anthropic_key_for_provision`) precisely so this
slice can be exercised directly without mocking AWS.
"""
import os

os.environ.setdefault("SUPABASE_URL", "https://test.supabase.co")
os.environ.setdefault("SUPABASE_JWT_SECRET", "test-secret")
os.environ.setdefault("SERVERS_TABLE", "pe-servers-test")
os.environ.setdefault("KMS_KEY_ID", "test-key-id")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")

from src.provision import _resolve_anthropic_key_for_provision


class TestResolveAnthropicKey:
    """Exercises every branch of the precedence ladder documented on
    the helper: user key → trial key → empty."""

    def test_user_supplied_key_wins_over_trial(self):
        """If the user pasted their own key, the trial env var MUST NOT
        override it — even if `trial=true` is in the body. Respecting
        user intent is the whole point of the flag being opt-in."""
        result = _resolve_anthropic_key_for_provision(
            body={"anthropicApiKey": "sk-ant-user-key", "trial": True},
            env={"PE_TRIAL_ANTHROPIC_KEY": "sk-ant-trial-key"},
        )
        assert result == "sk-ant-user-key"

    def test_user_key_wins_even_when_trial_not_set(self):
        """Baseline: user key flows through regardless of trial flag."""
        result = _resolve_anthropic_key_for_provision(
            body={"anthropicApiKey": "sk-ant-user-key"},
            env={"PE_TRIAL_ANTHROPIC_KEY": "sk-ant-trial-key"},
        )
        assert result == "sk-ant-user-key"

    def test_trial_true_no_user_key_uses_env(self):
        """The core quick-start case: user clicks Start, no key
        supplied, env has the shared trial key → workspace gets the
        shared key."""
        result = _resolve_anthropic_key_for_provision(
            body={"trial": True},
            env={"PE_TRIAL_ANTHROPIC_KEY": "sk-ant-trial-key"},
        )
        assert result == "sk-ant-trial-key"

    def test_trial_true_empty_env_returns_empty(self):
        """Trial requested but env unconfigured — fall through to empty.
        This is the graceful-degradation case: workspace provisions but
        has no pre-seeded credential. User sees connect-agent UI at
        first chat. Not an error."""
        result = _resolve_anthropic_key_for_provision(
            body={"trial": True},
            env={},
        )
        assert result == ""

    def test_trial_true_whitespace_env_returns_empty(self):
        """A whitespace-only env var is equivalent to unset. This catches
        the common misconfiguration where someone set the SAM parameter
        to `" "` or similar and didn't notice."""
        result = _resolve_anthropic_key_for_provision(
            body={"trial": True},
            env={"PE_TRIAL_ANTHROPIC_KEY": "   "},
        )
        assert result == ""

    def test_trial_false_ignores_env(self):
        """If the flag is explicitly false, the trial key is never used —
        even if env has one. Protects against the UI accidentally
        forgetting to set the flag and getting trial credits silently."""
        result = _resolve_anthropic_key_for_provision(
            body={"trial": False},
            env={"PE_TRIAL_ANTHROPIC_KEY": "sk-ant-trial-key"},
        )
        assert result == ""

    def test_trial_missing_treated_as_false(self):
        """Request with no `trial` key at all — existing behavior for
        anyone hitting the provision API directly. No trial substitution."""
        result = _resolve_anthropic_key_for_provision(
            body={},
            env={"PE_TRIAL_ANTHROPIC_KEY": "sk-ant-trial-key"},
        )
        assert result == ""

    def test_whitespace_user_key_is_not_a_key(self):
        """A user sending `"   "` as their key counts as no key. Matters
        for the frontend path where a form state hasn't been cleaned
        before POST — we'd rather fall through to the trial key than
        write whitespace to disk as ANTHROPIC_API_KEY."""
        result = _resolve_anthropic_key_for_provision(
            body={"anthropicApiKey": "   ", "trial": True},
            env={"PE_TRIAL_ANTHROPIC_KEY": "sk-ant-trial-key"},
        )
        assert result == "sk-ant-trial-key"

    def test_no_body_no_env(self):
        """Everything empty → empty. Baseline sanity check."""
        result = _resolve_anthropic_key_for_provision(body={}, env={})
        assert result == ""

    def test_trial_truthy_non_bool_accepted(self):
        """Downstream callers sometimes pass `1` or `"true"` instead of
        `True`. The `bool(...)` coercion in the helper handles both."""
        result_int = _resolve_anthropic_key_for_provision(
            body={"trial": 1},
            env={"PE_TRIAL_ANTHROPIC_KEY": "sk-ant-trial-key"},
        )
        assert result_int == "sk-ant-trial-key"

        result_str = _resolve_anthropic_key_for_provision(
            body={"trial": "true"},
            env={"PE_TRIAL_ANTHROPIC_KEY": "sk-ant-trial-key"},
        )
        # Note: any truthy value counts. "false" (string) is also truthy
        # which is technically wrong, but we trust the frontend to send
        # real booleans — the JSON body parses `true`/`false` correctly
        # and TypeScript's `trial?: boolean` enforces the shape upstream.
        assert result_str == "sk-ant-trial-key"
