import json
from unittest.mock import patch


FAKE_CLAIMS = {"sub": "user-123", "email": "sam@example.com"}


def _event(path, method="GET", path_params=None, body=None):
    return {
        "headers": {"authorization": "Bearer fake-token"},
        "pathParameters": path_params or {},
        "body": json.dumps(body) if body is not None else None,
        "requestContext": {"http": {"method": method, "path": path}},
    }


class TestCreateTeam:
    def test_creates_team_and_admin_membership(self):
        with patch("src.team.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team.get_active_team_membership", return_value=None), \
             patch("src.team.put_team") as mock_put_team, \
             patch("src.team.put_team_membership") as mock_put_membership:
            from src.team import handler

            result = handler(_event("/teams", method="POST", body={"name": "Acme"}), {})

            assert result["statusCode"] == 201
            mock_put_team.assert_called_once()
            mock_put_membership.assert_called_once()
            # Email from JWT claims must be persisted on the membership so the
            # settings UI can render it instead of falling back to the userId.
            written = mock_put_membership.call_args.args[0]
            assert written["email"] == "sam@example.com"


_ADMIN_MEMBERSHIP = {"userId": "user-123", "teamId": "team-1", "role": "admin", "status": "active", "email": "sam@example.com"}
_MEMBER_MEMBERSHIP = {"userId": "user-123", "teamId": "team-1", "role": "member", "status": "active", "email": "sam@example.com"}
_OTHER_ADMIN_MEMBERSHIP = {"userId": "user-other-admin", "teamId": "team-1", "role": "admin", "status": "active", "email": "other-admin@example.com"}
_TEAM = {
    "teamId": "team-1",
    "name": "Acme",
    "billingOwnerUserId": "user-billing",
    "createdAt": "2026-01-01T00:00:00+00:00",
}


class TestTeamAuthBoundary:
    def test_returns_401_when_token_invalid(self):
        with patch("src.team.verify_token", side_effect=Exception("bad token")):
            from src.team import handler

            result = handler(_event("/teams", method="POST", body={"name": "X"}), {})
            assert result["statusCode"] == 401

    def test_returns_400_when_team_id_missing(self):
        with patch("src.team.verify_token", return_value=FAKE_CLAIMS):
            from src.team import handler

            result = handler(
                _event("/teams/", method="PATCH", body={"name": "X"}),
                {},
            )
            assert result["statusCode"] == 400

    def test_returns_404_when_team_not_found(self):
        with patch("src.team.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team.get_team", return_value=None):
            from src.team import handler

            result = handler(
                _event("/teams/missing", method="GET", path_params={"teamId": "missing"}),
                {},
            )
            assert result["statusCode"] == 404


class TestGetMyTeam:
    def test_returns_null_team_when_user_has_none(self):
        with patch("src.team.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team.get_team_for_user", return_value=(None, None)), \
             patch("src.team.list_active_team_members", return_value=[]):
            from src.team import handler

            result = handler(_event("/teams/me", method="GET"), {})

            assert result["statusCode"] == 200
            body = json.loads(result["body"])
            assert body["team"] is None
            assert body["members"] == []
            assert body["invites"] == []

    def test_admin_sees_pending_invites(self):
        invites = [{"inviteId": "inv-1", "email": "a@x.com", "status": "pending"}]
        with patch("src.team.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team.get_team_for_user", return_value=(_TEAM, _ADMIN_MEMBERSHIP)), \
             patch("src.team.list_active_team_members", return_value=[_ADMIN_MEMBERSHIP]), \
             patch("src.team.list_team_invites_for_team", return_value=invites):
            from src.team import handler

            result = handler(_event("/teams/me", method="GET"), {})

            assert result["statusCode"] == 200
            body = json.loads(result["body"])
            assert body["team"]["role"] == "admin"
            assert body["invites"] == invites

    def test_backfills_caller_email_when_membership_row_predates_email_persistence(self):
        legacy_membership = {"userId": "user-123", "teamId": "team-1", "role": "admin", "status": "active"}
        members = [legacy_membership, {"userId": "user-other", "teamId": "team-1", "role": "member", "status": "active", "email": "other@x.com"}]
        with patch("src.team.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team.get_team_for_user", return_value=(_TEAM, legacy_membership)), \
             patch("src.team.list_active_team_members", return_value=members), \
             patch("src.team.list_team_invites_for_team", return_value=[]), \
             patch("src.team.update_team_membership") as mock_update:
            from src.team import handler

            result = handler(_event("/teams/me", method="GET"), {})

            assert result["statusCode"] == 200
            mock_update.assert_called_once_with("user-123", "team-1", {"email": "sam@example.com"})
            body = json.loads(result["body"])
            caller = next(m for m in body["members"] if m["userId"] == "user-123")
            assert caller["email"] == "sam@example.com"

    def test_skips_email_backfill_when_already_correct(self):
        membership = {"userId": "user-123", "teamId": "team-1", "role": "admin", "status": "active", "email": "sam@example.com"}
        with patch("src.team.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team.get_team_for_user", return_value=(_TEAM, membership)), \
             patch("src.team.list_active_team_members", return_value=[membership]), \
             patch("src.team.list_team_invites_for_team", return_value=[]), \
             patch("src.team.update_team_membership") as mock_update:
            from src.team import handler

            handler(_event("/teams/me", method="GET"), {})

            mock_update.assert_not_called()

    def test_non_admin_does_not_receive_invites_list(self):
        invites = [{"inviteId": "inv-1", "email": "a@x.com", "status": "pending"}]
        with patch("src.team.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team.get_team_for_user", return_value=(_TEAM, _MEMBER_MEMBERSHIP)), \
             patch("src.team.list_active_team_members", return_value=[_MEMBER_MEMBERSHIP]), \
             patch("src.team.list_team_invites_for_team", return_value=invites):
            from src.team import handler

            result = handler(_event("/teams/me", method="GET"), {})

            body = json.loads(result["body"])
            assert body["team"]["role"] == "member"
            assert body["invites"] == []


class TestCreateTeamRejections:
    def test_rejects_when_user_already_in_team(self):
        with patch("src.team.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team.get_active_team_membership", return_value={"teamId": "other-team"}):
            from src.team import handler

            result = handler(_event("/teams", method="POST", body={"name": "Acme"}), {})

            assert result["statusCode"] == 409

    def test_rejects_blank_name(self):
        with patch("src.team.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team.get_active_team_membership", return_value=None):
            from src.team import handler

            result = handler(_event("/teams", method="POST", body={"name": "   "}), {})

            assert result["statusCode"] == 400


class TestRenameTeam:
    def test_admin_can_rename_team(self):
        with patch("src.team.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team.get_team", return_value=_TEAM), \
             patch("src.team.get_team_membership", return_value=_ADMIN_MEMBERSHIP), \
             patch("src.team.is_team_admin", return_value=True), \
             patch("src.team.update_team") as mock_update_team:
            from src.team import handler

            result = handler(
                _event(
                    "/teams/team-1",
                    method="PATCH",
                    path_params={"teamId": "team-1"},
                    body={"name": "Acme Inc"},
                ),
                {},
            )

            assert result["statusCode"] == 200
            mock_update_team.assert_called_once_with("team-1", {"name": "Acme Inc"})

    def test_rejects_blank_name(self):
        with patch("src.team.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team.get_team", return_value=_TEAM), \
             patch("src.team.get_team_membership", return_value=_ADMIN_MEMBERSHIP), \
             patch("src.team.is_team_admin", return_value=True):
            from src.team import handler

            result = handler(
                _event(
                    "/teams/team-1",
                    method="PATCH",
                    path_params={"teamId": "team-1"},
                    body={"name": ""},
                ),
                {},
            )

            assert result["statusCode"] == 400


class TestCreateInvite:
    def test_admin_creates_invite(self):
        with patch("src.team.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team.get_team", return_value=_TEAM), \
             patch("src.team.get_team_membership", return_value=_ADMIN_MEMBERSHIP), \
             patch("src.team.is_team_admin", return_value=True), \
             patch("src.team.list_team_invites_for_team", return_value=[]), \
             patch("src.team.put_team_invite") as mock_put:
            from src.team import handler

            result = handler(
                _event(
                    "/teams/team-1/invites",
                    method="POST",
                    path_params={"teamId": "team-1"},
                    body={"email": "New@Example.COM", "role": "member"},
                ),
                {},
            )

            assert result["statusCode"] == 201
            saved = mock_put.call_args.args[0]
            assert saved["email"] == "new@example.com"  # normalized
            assert saved["role"] == "member"
            assert saved["status"] == "pending"
            assert saved["invitedByUserId"] == "user-123"

    def test_admin_creates_invite_sends_email_with_inviter_jwt_email(self):
        # The invite row is the source of truth; the email is a
        # best-effort side effect. Verify (a) send_email was called,
        # (b) it was called with the recipient's normalised email,
        # (c) the rendered subject/body carry the inviter's JWT email
        # (NOT a Supabase-fetched display name — we deliberately avoid
        # that lookup here so this Lambda doesn't need the service-
        # role key).
        with patch("src.team.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team.get_team", return_value=_TEAM), \
             patch("src.team.get_team_membership", return_value=_ADMIN_MEMBERSHIP), \
             patch("src.team.is_team_admin", return_value=True), \
             patch("src.team.list_team_invites_for_team", return_value=[]), \
             patch("src.team.put_team_invite"), \
             patch("src.team.send_email") as mock_send:
            from src.team import handler

            result = handler(
                _event(
                    "/teams/team-1/invites",
                    method="POST",
                    path_params={"teamId": "team-1"},
                    body={"email": "Recipient@Example.COM", "role": "member"},
                ),
                {},
            )

            assert result["statusCode"] == 201
            mock_send.assert_called_once()
            args, kwargs = mock_send.call_args
            # Positional: (to, subject, html). text passed as kwarg.
            to, subject, html = args[0], args[1], args[2]
            assert to == "recipient@example.com"  # normalised
            # Inviter is the JWT email claim, verbatim. Display-name
            # personalisation is intentionally NOT done here.
            assert "sam@example.com" in subject
            assert "sam@example.com" in html
            assert _TEAM["name"] in subject
            assert _TEAM["name"] in html

    def test_admin_creates_invite_still_returns_201_when_email_send_raises(self):
        # Email is best-effort. A Resend outage / unexpected exception
        # MUST NOT block the API response — the invite row already
        # exists, and the user can still see / accept it via the UI.
        with patch("src.team.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team.get_team", return_value=_TEAM), \
             patch("src.team.get_team_membership", return_value=_ADMIN_MEMBERSHIP), \
             patch("src.team.is_team_admin", return_value=True), \
             patch("src.team.list_team_invites_for_team", return_value=[]), \
             patch("src.team.put_team_invite"), \
             patch("src.team.send_email", side_effect=RuntimeError("boom")):
            from src.team import handler

            result = handler(
                _event(
                    "/teams/team-1/invites",
                    method="POST",
                    path_params={"teamId": "team-1"},
                    body={"email": "x@y.com", "role": "member"},
                ),
                {},
            )

            assert result["statusCode"] == 201

    def test_revokes_existing_pending_invite_for_same_email(self):
        existing = {"inviteId": "inv-old", "email": "x@y.com", "status": "pending"}
        with patch("src.team.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team.get_team", return_value=_TEAM), \
             patch("src.team.get_team_membership", return_value=_ADMIN_MEMBERSHIP), \
             patch("src.team.is_team_admin", return_value=True), \
             patch("src.team.list_team_invites_for_team", return_value=[existing]), \
             patch("src.team.put_team_invite"), \
             patch("src.team.update_team_invite") as mock_update:
            from src.team import handler

            handler(
                _event(
                    "/teams/team-1/invites",
                    method="POST",
                    path_params={"teamId": "team-1"},
                    body={"email": "x@y.com", "role": "admin"},
                ),
                {},
            )

            # The old pending invite gets revoked before the new one is written.
            mock_update.assert_called_once()
            args, _ = mock_update.call_args
            assert args[0] == "inv-old"
            assert args[1]["status"] == "revoked"

    def test_rejects_invalid_email(self):
        with patch("src.team.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team.get_team", return_value=_TEAM), \
             patch("src.team.get_team_membership", return_value=_ADMIN_MEMBERSHIP), \
             patch("src.team.is_team_admin", return_value=True):
            from src.team import handler

            result = handler(
                _event(
                    "/teams/team-1/invites",
                    method="POST",
                    path_params={"teamId": "team-1"},
                    body={"email": "not-an-email", "role": "member"},
                ),
                {},
            )

            assert result["statusCode"] == 400

    def test_rejects_invalid_role(self):
        with patch("src.team.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team.get_team", return_value=_TEAM), \
             patch("src.team.get_team_membership", return_value=_ADMIN_MEMBERSHIP), \
             patch("src.team.is_team_admin", return_value=True), \
             patch("src.team.list_team_invites_for_team", return_value=[]):
            from src.team import handler

            result = handler(
                _event(
                    "/teams/team-1/invites",
                    method="POST",
                    path_params={"teamId": "team-1"},
                    body={"email": "ok@x.com", "role": "owner"},
                ),
                {},
            )

            assert result["statusCode"] == 400

    def test_lists_invites_for_admin(self):
        invites = [{"inviteId": "inv-1", "email": "a@x.com", "status": "pending"}]
        with patch("src.team.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team.get_team", return_value=_TEAM), \
             patch("src.team.get_team_membership", return_value=_ADMIN_MEMBERSHIP), \
             patch("src.team.is_team_admin", return_value=True), \
             patch("src.team.list_team_invites_for_team", return_value=invites):
            from src.team import handler

            result = handler(
                _event(
                    "/teams/team-1/invites",
                    method="GET",
                    path_params={"teamId": "team-1"},
                ),
                {},
            )

            assert result["statusCode"] == 200
            assert json.loads(result["body"])["invites"] == invites


class TestPatchMemberRole:
    def test_admin_can_change_member_role(self):
        target_membership = {"userId": "user-target", "teamId": "team-1", "role": "member", "status": "active"}
        with patch("src.team.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team.get_team", return_value=_TEAM), \
             patch("src.team.get_team_membership", side_effect=[_ADMIN_MEMBERSHIP, target_membership]), \
             patch("src.team.is_team_admin", return_value=True), \
             patch("src.team.update_team_membership") as mock_update:
            from src.team import handler

            result = handler(
                _event(
                    "/teams/team-1/members/user-target",
                    method="PATCH",
                    path_params={"teamId": "team-1", "userId": "user-target"},
                    body={"role": "admin"},
                ),
                {},
            )

            assert result["statusCode"] == 200
            mock_update.assert_called_once_with("user-target", "team-1", {"role": "admin"})

    def test_billing_owner_cannot_be_demoted(self):
        billing_user = "user-billing"
        billing_membership = {"userId": billing_user, "teamId": "team-1", "role": "admin", "status": "active"}
        with patch("src.team.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team.get_team", return_value=_TEAM), \
             patch("src.team.get_team_membership", side_effect=[_ADMIN_MEMBERSHIP, billing_membership]), \
             patch("src.team.is_team_admin", return_value=True), \
             patch("src.team.update_team_membership") as mock_update:
            from src.team import handler

            result = handler(
                _event(
                    f"/teams/team-1/members/{billing_user}",
                    method="PATCH",
                    path_params={"teamId": "team-1", "userId": billing_user},
                    body={"role": "member"},
                ),
                {},
            )

            assert result["statusCode"] == 400
            mock_update.assert_not_called()

    def test_last_admin_cannot_demote_themselves_to_member(self):
        """Mirrors the DELETE-path guard: the only admin can't escape via PATCH either."""
        sole_admin = {"userId": "user-123", "teamId": "team-1", "role": "admin", "status": "active"}
        non_billing_team = {**_TEAM, "billingOwnerUserId": "user-other"}
        with patch("src.team.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team.get_team", return_value=non_billing_team), \
             patch("src.team.get_team_membership", side_effect=[sole_admin, sole_admin]), \
             patch("src.team.is_team_admin", return_value=True), \
             patch("src.team.list_active_team_members", return_value=[sole_admin]), \
             patch("src.team.update_team_membership") as mock_update:
            from src.team import handler

            result = handler(
                _event(
                    "/teams/team-1/members/user-123",
                    method="PATCH",
                    path_params={"teamId": "team-1", "userId": "user-123"},
                    body={"role": "member"},
                ),
                {},
            )

            assert result["statusCode"] == 400
            mock_update.assert_not_called()

    def test_returns_404_when_target_not_a_member(self):
        with patch("src.team.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team.get_team", return_value=_TEAM), \
             patch("src.team.get_team_membership", side_effect=[_ADMIN_MEMBERSHIP, None]), \
             patch("src.team.is_team_admin", return_value=True):
            from src.team import handler

            result = handler(
                _event(
                    "/teams/team-1/members/user-ghost",
                    method="PATCH",
                    path_params={"teamId": "team-1", "userId": "user-ghost"},
                    body={"role": "member"},
                ),
                {},
            )

            assert result["statusCode"] == 404


class TestDeleteMember:
    def test_admin_removes_other_member(self):
        target = {"userId": "user-target", "teamId": "team-1", "role": "member", "status": "active"}
        with patch("src.team.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team.get_team", return_value=_TEAM), \
             patch("src.team.get_team_membership", side_effect=[_ADMIN_MEMBERSHIP, target]), \
             patch("src.team.is_team_admin", return_value=True), \
             patch("src.team.delete_team_membership") as mock_delete:
            from src.team import handler

            result = handler(
                _event(
                    "/teams/team-1/members/user-target",
                    method="DELETE",
                    path_params={"teamId": "team-1", "userId": "user-target"},
                ),
                {},
            )

            assert result["statusCode"] == 200
            mock_delete.assert_called_once_with("user-target", "team-1")

    def test_self_leave_works_for_non_admin(self):
        self_membership = {"userId": "user-123", "teamId": "team-1", "role": "member", "status": "active"}
        with patch("src.team.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team.get_team", return_value=_TEAM), \
             patch("src.team.get_team_membership", side_effect=[self_membership, self_membership]), \
             patch("src.team.is_team_admin", return_value=False), \
             patch("src.team.delete_team_membership") as mock_delete:
            from src.team import handler

            result = handler(
                _event(
                    "/teams/team-1/members/user-123",
                    method="DELETE",
                    path_params={"teamId": "team-1", "userId": "user-123"},
                ),
                {},
            )

            assert result["statusCode"] == 200
            mock_delete.assert_called_once_with("user-123", "team-1")

    def test_billing_owner_cannot_be_removed(self):
        billing_membership = {"userId": "user-billing", "teamId": "team-1", "role": "admin", "status": "active"}
        with patch("src.team.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team.get_team", return_value=_TEAM), \
             patch("src.team.get_team_membership", side_effect=[_ADMIN_MEMBERSHIP, billing_membership]), \
             patch("src.team.is_team_admin", return_value=True), \
             patch("src.team.delete_team_membership") as mock_delete:
            from src.team import handler

            result = handler(
                _event(
                    "/teams/team-1/members/user-billing",
                    method="DELETE",
                    path_params={"teamId": "team-1", "userId": "user-billing"},
                ),
                {},
            )

            assert result["statusCode"] == 400
            mock_delete.assert_not_called()

    def test_last_admin_cannot_self_leave(self):
        self_admin = {"userId": "user-123", "teamId": "team-1", "role": "admin", "status": "active"}
        non_billing_team = {**_TEAM, "billingOwnerUserId": "user-other"}
        with patch("src.team.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team.get_team", return_value=non_billing_team), \
             patch("src.team.get_team_membership", side_effect=[self_admin, self_admin]), \
             patch("src.team.is_team_admin", return_value=True), \
             patch("src.team.list_active_team_members", return_value=[self_admin]), \
             patch("src.team.delete_team_membership") as mock_delete:
            from src.team import handler

            result = handler(
                _event(
                    "/teams/team-1/members/user-123",
                    method="DELETE",
                    path_params={"teamId": "team-1", "userId": "user-123"},
                ),
                {},
            )

            assert result["statusCode"] == 400
            mock_delete.assert_not_called()

    def test_admin_can_leave_when_other_admin_exists(self):
        self_admin = {"userId": "user-123", "teamId": "team-1", "role": "admin", "status": "active"}
        non_billing_team = {**_TEAM, "billingOwnerUserId": "user-other-admin"}
        with patch("src.team.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team.get_team", return_value=non_billing_team), \
             patch("src.team.get_team_membership", side_effect=[self_admin, self_admin]), \
             patch("src.team.is_team_admin", return_value=True), \
             patch("src.team.list_active_team_members", return_value=[self_admin, _OTHER_ADMIN_MEMBERSHIP]), \
             patch("src.team.delete_team_membership") as mock_delete:
            from src.team import handler

            result = handler(
                _event(
                    "/teams/team-1/members/user-123",
                    method="DELETE",
                    path_params={"teamId": "team-1", "userId": "user-123"},
                ),
                {},
            )

            assert result["statusCode"] == 200
            mock_delete.assert_called_once()


class TestTeamGate:
    """Authorization gate for team-scoped routes (PATCH /teams/{id}, invites, members).

    Locks the operator-precedence fix: non-members must be 403'd even on GET,
    and members must be allowed through GET while still being blocked on
    mutating verbs unless they are admin.
    """

    _TEAM = {"teamId": "team-1", "name": "Acme", "billingOwnerUserId": "u-other"}

    def test_non_member_blocked_on_get_invites(self):
        with patch("src.team.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team.get_team", return_value=self._TEAM), \
             patch("src.team.get_team_membership", return_value=None):
            from src.team import handler

            result = handler(
                _event("/teams/team-1/invites", method="GET", path_params={"teamId": "team-1"}),
                {},
            )
            assert result["statusCode"] == 403

    def test_member_blocked_on_admin_only_mutation(self):
        member = {"userId": "user-123", "teamId": "team-1", "role": "member", "status": "active"}
        with patch("src.team.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team.get_team", return_value=self._TEAM), \
             patch("src.team.get_team_membership", return_value=member), \
             patch("src.team.is_team_admin", return_value=False):
            from src.team import handler

            result = handler(
                _event(
                    "/teams/team-1",
                    method="PATCH",
                    path_params={"teamId": "team-1"},
                    body={"name": "Renamed"},
                ),
                {},
            )
            assert result["statusCode"] == 403


class TestAcceptInvite:
    def test_accepts_matching_invite_for_user_email(self):
        invite = {
            "inviteId": "inv-1",
            "teamId": "team-1",
            "email": "sam@example.com",
            "role": "member",
            "status": "pending",
            "expiresAt": "2099-01-01T00:00:00+00:00",
        }
        with patch("src.team_invites.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team_invites.get_team_invite", return_value=invite), \
             patch("src.team_invites.get_team", return_value={"teamId": "team-1", "name": "Acme"}), \
             patch("src.team_invites.get_active_team_membership", return_value=None), \
             patch("src.team_invites.get_team_membership", return_value=None), \
             patch("src.team_invites.put_team_membership") as mock_put_membership, \
             patch("src.team_invites.update_team_invite") as mock_update_invite:
            from src.team_invites import handler

            result = handler(_event("/team-invites/inv-1/accept", method="POST", path_params={"inviteId": "inv-1"}), {})

            assert result["statusCode"] == 200
            mock_put_membership.assert_called_once()
            mock_update_invite.assert_called_once()
            written = mock_put_membership.call_args.args[0]
            assert written["email"] == "sam@example.com"

    def test_rejects_when_invited_team_no_longer_exists(self):
        invite = {
            "inviteId": "inv-1",
            "teamId": "ghost-team",
            "email": "sam@example.com",
            "role": "member",
            "status": "pending",
            "expiresAt": "2099-01-01T00:00:00+00:00",
        }
        with patch("src.team_invites.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team_invites.get_team_invite", return_value=invite), \
             patch("src.team_invites.get_team", return_value=None), \
             patch("src.team_invites.put_team_membership") as mock_put_membership, \
             patch("src.team_invites.update_team_invite") as mock_update_invite:
            from src.team_invites import handler

            result = handler(_event("/team-invites/inv-1/accept", method="POST", path_params={"inviteId": "inv-1"}), {})

            assert result["statusCode"] == 410
            mock_put_membership.assert_not_called()
            # The orphan invite should be revoked so it stops appearing as pending.
            mock_update_invite.assert_called_once()
            args, _ = mock_update_invite.call_args
            assert args[0] == "inv-1"
            assert args[1]["status"] == "revoked"

    def test_rejects_invite_when_user_already_in_team(self):
        invite = {
            "inviteId": "inv-1",
            "teamId": "team-1",
            "email": "sam@example.com",
            "role": "member",
            "status": "pending",
            "expiresAt": "2099-01-01T00:00:00+00:00",
        }
        with patch("src.team_invites.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team_invites.get_team_invite", return_value=invite), \
             patch("src.team_invites.get_team", return_value={"teamId": "team-1"}), \
             patch("src.team_invites.get_active_team_membership", return_value={"teamId": "other-team"}):
            from src.team_invites import handler

            result = handler(_event("/team-invites/inv-1/accept", method="POST", path_params={"inviteId": "inv-1"}), {})

            assert result["statusCode"] == 409

    def test_returns_404_when_invite_not_found(self):
        with patch("src.team_invites.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team_invites.get_team_invite", return_value=None):
            from src.team_invites import handler

            result = handler(_event("/team-invites/missing/accept", method="POST", path_params={"inviteId": "missing"}), {})

            assert result["statusCode"] == 404

    def test_rejects_non_pending_invite(self):
        invite = {
            "inviteId": "inv-1",
            "teamId": "team-1",
            "email": "sam@example.com",
            "role": "member",
            "status": "accepted",
            "expiresAt": "2099-01-01T00:00:00+00:00",
        }
        with patch("src.team_invites.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team_invites.get_team_invite", return_value=invite):
            from src.team_invites import handler

            result = handler(_event("/team-invites/inv-1/accept", method="POST", path_params={"inviteId": "inv-1"}), {})

            assert result["statusCode"] == 400

    def test_rejects_when_invite_email_does_not_match_signed_in_user(self):
        invite = {
            "inviteId": "inv-1",
            "teamId": "team-1",
            "email": "someone-else@example.com",
            "role": "member",
            "status": "pending",
            "expiresAt": "2099-01-01T00:00:00+00:00",
        }
        with patch("src.team_invites.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team_invites.get_team_invite", return_value=invite):
            from src.team_invites import handler

            result = handler(_event("/team-invites/inv-1/accept", method="POST", path_params={"inviteId": "inv-1"}), {})

            assert result["statusCode"] == 403

    def test_rejects_and_marks_invite_expired_when_past_expiry(self):
        invite = {
            "inviteId": "inv-1",
            "teamId": "team-1",
            "email": "sam@example.com",
            "role": "member",
            "status": "pending",
            "expiresAt": "2020-01-01T00:00:00+00:00",
        }
        with patch("src.team_invites.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team_invites.get_team_invite", return_value=invite), \
             patch("src.team_invites.update_team_invite") as mock_update:
            from src.team_invites import handler

            result = handler(_event("/team-invites/inv-1/accept", method="POST", path_params={"inviteId": "inv-1"}), {})

            assert result["statusCode"] == 400
            mock_update.assert_called_once()
            args, _ = mock_update.call_args
            assert args[0] == "inv-1"
            assert args[1]["status"] == "expired"

    def test_rejects_when_user_already_in_THIS_team(self):
        invite = {
            "inviteId": "inv-1",
            "teamId": "team-1",
            "email": "sam@example.com",
            "role": "member",
            "status": "pending",
            "expiresAt": "2099-01-01T00:00:00+00:00",
        }
        with patch("src.team_invites.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team_invites.get_team_invite", return_value=invite), \
             patch("src.team_invites.get_team", return_value={"teamId": "team-1"}), \
             patch("src.team_invites.get_active_team_membership", return_value=None), \
             patch("src.team_invites.get_team_membership", return_value={"teamId": "team-1"}):
            from src.team_invites import handler

            result = handler(_event("/team-invites/inv-1/accept", method="POST", path_params={"inviteId": "inv-1"}), {})

            assert result["statusCode"] == 409


class TestListPendingInvites:
    def test_returns_only_pending_non_expired_invites_with_team_name(self):
        invites = [
            {"inviteId": "inv-pending", "teamId": "team-1", "email": "sam@example.com", "status": "pending", "expiresAt": "2099-01-01T00:00:00+00:00"},
            {"inviteId": "inv-expired", "teamId": "team-1", "email": "sam@example.com", "status": "pending", "expiresAt": "2020-01-01T00:00:00+00:00"},
            {"inviteId": "inv-accepted", "teamId": "team-1", "email": "sam@example.com", "status": "accepted", "expiresAt": "2099-01-01T00:00:00+00:00"},
            {"inviteId": "inv-revoked", "teamId": "team-2", "email": "sam@example.com", "status": "revoked", "expiresAt": "2099-01-01T00:00:00+00:00"},
        ]
        with patch("src.team_invites.verify_token", return_value=FAKE_CLAIMS), \
             patch("src.team_invites.list_team_invites_for_email", return_value=invites), \
             patch("src.team_invites.get_team", return_value={"teamId": "team-1", "name": "Acme"}):
            from src.team_invites import handler

            result = handler(_event("/team-invites", method="GET"), {})

            assert result["statusCode"] == 200
            body = json.loads(result["body"])
            ids = [i["inviteId"] for i in body["invites"]]
            assert ids == ["inv-pending"]
            assert body["invites"][0]["teamName"] == "Acme"

    def test_returns_empty_when_user_has_no_email_claim(self):
        with patch("src.team_invites.verify_token", return_value={"sub": "user-x"}):
            from src.team_invites import handler

            result = handler(_event("/team-invites", method="GET"), {})

            assert result["statusCode"] == 200
            assert json.loads(result["body"])["invites"] == []
