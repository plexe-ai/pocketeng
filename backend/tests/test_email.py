"""Unit tests for the Resend email wrapper + onboarding templates.

We monkey-patch urllib.request.urlopen rather than actually hit the
network. Resend has no test/sandbox mode for `/emails`, and we don't
want CI's IP submitting fake mail to their abuse triggers.
"""
import io
import json
import os
import urllib.error
from unittest.mock import MagicMock, patch


# Both modules read env at call time, so test-side isolation works fine
# without import-time env shenanigans.
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")


# ─── email.send_email ───────────────────────────────────────────────────────

class TestSendEmail:
    def setup_method(self):
        # Clear Resend env between tests so behavior is deterministic.
        for k in ("RESEND_API_KEY", "RESEND_FROM"):
            os.environ.pop(k, None)

    def test_no_op_when_api_key_missing(self):
        from src.lib.email import send_email
        # No API key, no send. No exception either — best-effort.
        result = send_email("u@example.com", "subj", "<p>hi</p>")
        assert result is False

    def test_no_op_when_from_missing(self):
        from src.lib.email import send_email
        os.environ["RESEND_API_KEY"] = "re_test"
        result = send_email("u@example.com", "subj", "<p>hi</p>")
        assert result is False

    def test_happy_path_posts_correct_payload(self):
        from src.lib.email import send_email
        os.environ["RESEND_API_KEY"] = "re_test"
        os.environ["RESEND_FROM"] = "Pocket Eng <hello@pocketeng.ai>"

        captured = {}
        class _Resp:
            def read(self): return b'{"id": "msg_123"}'
            def __enter__(self): return self
            def __exit__(self, *a): return False
        def fake_urlopen(req, *args, **kwargs):
            captured["url"] = req.full_url
            captured["method"] = req.get_method()
            captured["auth"] = req.headers.get("Authorization")
            captured["body"] = json.loads(req.data.decode())
            return _Resp()
        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            ok = send_email("u@example.com", "subj", "<p>hi</p>", text="hi")
        assert ok is True
        assert captured["url"] == "https://api.resend.com/emails"
        assert captured["method"] == "POST"
        assert captured["auth"] == "Bearer re_test"
        assert captured["body"]["from"] == "Pocket Eng <hello@pocketeng.ai>"
        assert captured["body"]["to"] == ["u@example.com"]
        assert captured["body"]["subject"] == "subj"
        assert captured["body"]["html"] == "<p>hi</p>"
        assert captured["body"]["text"] == "hi"

    def test_swallows_http_error(self):
        from src.lib.email import send_email
        os.environ["RESEND_API_KEY"] = "re_test"
        os.environ["RESEND_FROM"] = "x@y.com"

        # Simulate Resend rejecting unverified domain (422). Caller
        # MUST get a clean False, not an exception.
        err = urllib.error.HTTPError(
            url="https://api.resend.com/emails",
            code=422,
            msg="Unprocessable Entity",
            hdrs=None,
            fp=io.BytesIO(b'{"name":"validation_error","message":"Invalid `from`"}'),
        )
        with patch("urllib.request.urlopen", side_effect=err):
            ok = send_email("u@example.com", "subj", "<p>hi</p>")
        assert ok is False

    def test_swallows_network_error(self):
        from src.lib.email import send_email
        os.environ["RESEND_API_KEY"] = "re_test"
        os.environ["RESEND_FROM"] = "x@y.com"

        with patch("urllib.request.urlopen", side_effect=ConnectionError("DNS fail")):
            ok = send_email("u@example.com", "subj", "<p>hi</p>")
        assert ok is False

    def test_sets_user_agent_to_avoid_cloudflare_block(self):
        # Scar tissue. Resend's API sits behind Cloudflare, which 403s
        # the default `Python-urllib/3.x` User-Agent with body
        # "error code: 1010". Without this header, EVERY transactional
        # email shipped broken for 60+ days. Lock the header so a
        # future "tidy up" PR doesn't quietly remove it.
        from src.lib.email import send_email
        os.environ["RESEND_API_KEY"] = "re_test"
        os.environ["RESEND_FROM"] = "x@y.com"

        captured = {}
        class _Resp:
            def read(self): return b'{"id":"x"}'
            def __enter__(self): return self
            def __exit__(self, *a): return False
        def fake_urlopen(req, *args, **kwargs):
            captured["ua"] = req.headers.get("User-agent")
            return _Resp()
        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            send_email("u@example.com", "s", "<p>h</p>")
        # Specifically NOT the urllib default; any non-default UA gets
        # past Cloudflare's bot rule. We assert presence + non-emptiness
        # rather than the exact string, so a copy edit doesn't break us.
        assert captured["ua"], "User-Agent header missing — Cloudflare will 1010"
        assert "Python-urllib" not in captured["ua"]

    def test_reply_to_passed_through_as_list(self):
        from src.lib.email import send_email
        os.environ["RESEND_API_KEY"] = "re_test"
        os.environ["RESEND_FROM"] = "x@y.com"

        captured = {}
        class _Resp:
            def read(self): return b'{}'
            def __enter__(self): return self
            def __exit__(self, *a): return False
        def fake_urlopen(req, *args, **kwargs):
            captured["body"] = json.loads(req.data.decode())
            return _Resp()
        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            send_email("u@example.com", "s", "<p>h</p>", reply_to="reply@example.com")
        assert captured["body"]["reply_to"] == ["reply@example.com"]


# ─── email_templates.workspace_ready ────────────────────────────────────────

class TestWorkspaceReadyTemplate:
    def test_returns_subject_html_text(self):
        from src.lib.email_templates import workspace_ready
        subject, html, text = workspace_ready()
        # Subject is short and personal-feeling. Locked because the
        # subject line is the one piece of the email almost everyone
        # actually sees in their inbox preview.
        assert subject == "Your workspace is ready"
        # Story-free transactional copy — confirms what just happened
        # and points at the dashboard. No name interpolation here
        # because the sender field already carries personalization.
        assert "Your workspace is up" in text
        assert "agent is installed" in html
        assert "Vaibhav" in text  # sign-off
        assert "Pocket Eng" in text

    def test_includes_dashboard_url(self):
        from src.lib.email_templates import workspace_ready
        url = "https://example.com/dashboard/abc-123"
        _, html, text = workspace_ready(dashboard_url=url)
        assert url in html
        assert url in text

    def test_html_escapes_dashboard_url(self):
        # Defensive: dashboard_url is built from server_id which is
        # backend-controlled today, but better to guard now than
        # discover an XSS later.
        from src.lib.email_templates import workspace_ready
        _, html, _ = workspace_ready(dashboard_url="<script>alert(1)</script>")
        assert "<script>alert" not in html
        assert "&lt;script&gt;" in html

    def test_no_em_dashes_in_body(self):
        # Author preference: zero em dashes (U+2014) anywhere in the
        # rendered output. Catches editor smart-quote auto-replacements.
        from src.lib.email_templates import workspace_ready
        _, html, text = workspace_ready()
        assert "\u2014" not in html
        assert "\u2014" not in text

    def test_mentions_ios_only_no_android(self):
        # Per author direction: don't promote the Android app yet
        # (it lags iOS in features). Lock so a future templating pass
        # doesn't quietly add it back.
        from src.lib.email_templates import workspace_ready
        _, html, text = workspace_ready()
        assert "iOS" in html
        assert "Android" not in html
        assert "Android" not in text


# ─── email_templates.welcome (this PR) ───────────────────────────────────────

class TestWelcomeTemplate:
    def test_returns_subject_html_text(self):
        from src.lib.email_templates import welcome
        subject, html, text = welcome(name="Sam")
        assert subject == "Your agent is up"
        # The story hook is the heart of the email — if it gets
        # accidentally edited away, the email becomes a generic
        # template ping. Guard the key beats.
        assert "developer conference" in html
        assert "developer conference" in text
        assert "500 error" in text
        assert "merged it from his hotel" in text

    def test_includes_dashboard_url(self):
        from src.lib.email_templates import welcome
        url = "https://example.com/dashboard"
        _, html, text = welcome(dashboard_url=url)
        assert url in html
        assert url in text

    def test_no_em_dashes_in_body(self):
        from src.lib.email_templates import welcome
        _, html, text = welcome(name="Sam")
        assert "\u2014" not in html
        assert "\u2014" not in text

    def test_html_escapes_dashboard_url(self):
        # Defensive: dashboard_url could in theory be attacker-shaped
        # if an upstream caller passes user input. Make sure < and >
        # are escaped if someone tries to inject an HTML fragment.
        from src.lib.email_templates import welcome
        _, html, _ = welcome(dashboard_url="<script>alert(1)</script>")
        assert "<script>alert" not in html
        assert "&lt;script&gt;" in html


# ─── email_templates.activity_nudge (this PR) ────────────────────────────────

class TestActivityNudgeTemplate:
    def test_returns_subject_html_text(self):
        from src.lib.email_templates import activity_nudge
        subject, html, text = activity_nudge(
            unsubscribe_url="https://api/u?token=t",
        )
        assert subject == "Your workspace is sitting there"
        # Story-key beats, lock so a future copy edit can't accidentally
        # gut the narrative voice.
        assert "Saturday" in text
        assert "iced coffee" in text
        assert "two or three PRs" in text

    def test_unsubscribe_link_appears_in_html_and_text(self):
        from src.lib.email_templates import activity_nudge
        url = "https://api.example.com/email/unsubscribe?token=abc.def"
        _, html, text = activity_nudge(unsubscribe_url=url)
        assert url in html
        assert url in text
        # Footer wording matches what users will recognize as
        # standard-issue unsub language.
        assert "Unsubscribe" in html
        assert "Unsubscribe" in text

    def test_trial_credits_line_only_when_no_own_creds(self):
        from src.lib.email_templates import activity_nudge
        # Default: no own creds → trial-credits line present.
        _, html_no, text_no = activity_nudge(
            unsubscribe_url="https://x/u?t=1",
            has_own_credentials=False,
        )
        assert "trial credits" in html_no
        assert "trial credits" in text_no
        # Connected own creds → trial-credits line suppressed.
        _, html_yes, text_yes = activity_nudge(
            unsubscribe_url="https://x/u?t=1",
            has_own_credentials=True,
        )
        assert "trial credits" not in html_yes
        assert "trial credits" not in text_yes

    def test_no_em_dashes_in_body(self):
        from src.lib.email_templates import activity_nudge
        _, html, text = activity_nudge(unsubscribe_url="https://x/u?t=1")
        assert "\u2014" not in html
        assert "\u2014" not in text

    def test_unsubscribe_url_is_required(self):
        # Author intent: this template MUST carry an unsubscribe link
        # because it's marketing-adjacent. Refusing the call without
        # one prevents accidentally shipping a CAN-SPAM violation
        # if a future caller forgets.
        from src.lib.email_templates import activity_nudge
        try:
            activity_nudge()  # type: ignore[call-arg]
            assert False, "expected TypeError for missing unsubscribe_url"
        except TypeError:
            pass


# ─── email_templates.team_invite (this PR) ──────────────────────────────────

class TestTeamInviteTemplate:
    def test_returns_subject_html_text(self):
        from src.lib.email_templates import team_invite
        subject, html, text = team_invite(
            team_name="Acme",
            inviter_email="alice@acme.com",
        )
        # Subject lock: "X invited you to the Y team on Pocket Eng".
        # The literal word "team" matters — team names like "Engineering"
        # or "Backend" don't self-describe, and the previous draft
        # ("invited you to Acme") read ambiguously.
        assert subject == "alice@acme.com invited you to the Acme team on Pocket Eng"
        assert "alice@acme.com invited you" in text
        assert "Acme</strong> team" in html
        assert "Acme team" in text

    def test_falls_back_to_someone_when_inviter_email_missing(self):
        # JWT email claim is normally present but optional. Don't ship
        # an empty-string sender ("  invited you to..." reads broken).
        from src.lib.email_templates import team_invite
        subject, html, text = team_invite(team_name="Acme")
        assert subject == "Someone invited you to the Acme team on Pocket Eng"
        assert "Someone invited you" in text
        assert "Someone invited you" in html

    def test_includes_accept_url(self):
        from src.lib.email_templates import team_invite
        url = "https://example.com/dashboard/settings?from=invite"
        _, html, text = team_invite(
            team_name="Acme", inviter_email="a@x.com", accept_url=url,
        )
        assert url in html
        assert url in text

    def test_html_escapes_team_name_and_inviter(self):
        # team_name is admin-controlled and inviter_email comes from
        # the JWT (also user-controlled at signup). Both get rendered
        # into HTML — escape both, defensively, even though neither is
        # an obvious XSS vector today.
        from src.lib.email_templates import team_invite
        _, html, _ = team_invite(
            team_name="<script>alert(1)</script>",
            inviter_email="<img src=x>@evil.com",
        )
        assert "<script>alert" not in html
        assert "<img src=x>" not in html
        assert "&lt;script&gt;" in html

    def test_no_em_dashes_in_body(self):
        from src.lib.email_templates import team_invite
        _, html, text = team_invite(team_name="Acme", inviter_email="a@x.com")
        assert "—" not in html
        assert "—" not in text

    def test_mentions_signup_fallback_for_recipients_without_an_account(self):
        # Locks the "you'll be prompted to sign up" copy. The whole
        # design hinges on this telling new users what to do — losing
        # this paragraph would silently break the recipient-without-an-
        # account flow (technically it still works because email-match
        # picks up the invite, but they'd have no idea why they should
        # sign up).
        from src.lib.email_templates import team_invite
        _, html, text = team_invite(team_name="Acme", inviter_email="a@x.com")
        assert "sign up" in html
        assert "sign up" in text
        assert "same email address" in text


# ─── email_unsubscribe.token round-trip (this PR) ────────────────────────────

class TestUnsubscribeToken:
    def test_round_trip(self):
        from src.email_unsubscribe import make_unsubscribe_token, _verify_token
        token = make_unsubscribe_token("user-123", "secret-xyz")
        assert _verify_token(token, "secret-xyz") == "user-123"

    def test_wrong_secret_rejected(self):
        from src.email_unsubscribe import make_unsubscribe_token, _verify_token
        token = make_unsubscribe_token("user-123", "secret-A")
        # Verifying with the wrong secret returns None, not a mismatched
        # user id. Guard against any accidental bypass that would let
        # a stolen token unsubscribe arbitrary accounts.
        assert _verify_token(token, "secret-B") is None

    def test_tampered_signature_rejected(self):
        from src.email_unsubscribe import make_unsubscribe_token, _verify_token
        token = make_unsubscribe_token("user-123", "secret")
        user_part, sig_part = token.split(".", 1)
        # Flip one char in the signature — verification must fail.
        bad = user_part + "." + ("A" if sig_part[0] != "A" else "B") + sig_part[1:]
        assert _verify_token(bad, "secret") is None

    def test_empty_token_rejected(self):
        from src.email_unsubscribe import _verify_token
        assert _verify_token("", "secret") is None
        assert _verify_token("nope", "secret") is None

    def test_empty_secret_refuses_to_mint(self):
        # Defensive: we'd rather fail loudly than mint a token that
        # won't verify (orphan unsubscribe links in real users' emails).
        from src.email_unsubscribe import make_unsubscribe_token
        try:
            make_unsubscribe_token("user-123", "")
            assert False, "expected RuntimeError on empty secret"
        except RuntimeError:
            pass


# ─── supabase_admin.get_user_info ───────────────────────────────────────────

class TestSupabaseAdmin:
    def setup_method(self):
        for k in ("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_URL"):
            os.environ.pop(k, None)

    def test_no_op_without_config(self):
        from src.lib.supabase_admin import get_user_info
        # No env vars → (None, None), no exception
        assert get_user_info("user-id") == (None, None)

    def test_no_op_without_user_id(self):
        from src.lib.supabase_admin import get_user_info
        os.environ["SUPABASE_SERVICE_ROLE_KEY"] = "k"
        os.environ["SUPABASE_URL"] = "https://x.supabase.co"
        assert get_user_info("") == (None, None)
        assert get_user_info(None) == (None, None)

    def test_picks_display_name_from_metadata(self):
        from src.lib.supabase_admin import get_user_info
        os.environ["SUPABASE_SERVICE_ROLE_KEY"] = "k"
        os.environ["SUPABASE_URL"] = "https://x.supabase.co"

        class _Resp:
            def read(self): return json.dumps({
                "email": "sam@example.com",
                "user_metadata": {"display_name": "Sam C"},
            }).encode()
            def __enter__(self): return self
            def __exit__(self, *a): return False
        with patch("urllib.request.urlopen", return_value=_Resp()):
            email, name = get_user_info("user-id")
        assert email == "sam@example.com"
        assert name == "Sam C"

    def test_falls_back_through_name_keys(self):
        # When display_name is missing, walk full_name → name → email-prefix.
        from src.lib.supabase_admin import get_user_info
        os.environ["SUPABASE_SERVICE_ROLE_KEY"] = "k"
        os.environ["SUPABASE_URL"] = "https://x.supabase.co"

        class _Resp:
            def read(self): return json.dumps({
                "email": "founder@example.com",
                "user_metadata": {"full_name": "Vaibhav Dubey"},
            }).encode()
            def __enter__(self): return self
            def __exit__(self, *a): return False
        with patch("urllib.request.urlopen", return_value=_Resp()):
            email, name = get_user_info("user-id")
        assert name == "Vaibhav Dubey"

    def test_email_prefix_when_metadata_empty(self):
        from src.lib.supabase_admin import get_user_info
        os.environ["SUPABASE_SERVICE_ROLE_KEY"] = "k"
        os.environ["SUPABASE_URL"] = "https://x.supabase.co"

        class _Resp:
            def read(self): return json.dumps({
                "email": "founder@example.com",
                "user_metadata": {},
            }).encode()
            def __enter__(self): return self
            def __exit__(self, *a): return False
        with patch("urllib.request.urlopen", return_value=_Resp()):
            email, name = get_user_info("user-id")
        assert name == "founder"

    def test_swallows_http_error(self):
        from src.lib.supabase_admin import get_user_info
        os.environ["SUPABASE_SERVICE_ROLE_KEY"] = "k"
        os.environ["SUPABASE_URL"] = "https://x.supabase.co"
        err = urllib.error.HTTPError(
            "https://x.supabase.co/auth/v1/admin/users/u",
            404, "Not Found", None, io.BytesIO(b"{}"),
        )
        with patch("urllib.request.urlopen", side_effect=err):
            assert get_user_info("user-id") == (None, None)
