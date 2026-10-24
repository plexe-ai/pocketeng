from unittest.mock import patch


class TestCanAccessTeam:
    def test_returns_false_when_no_membership(self):
        with patch("src.lib.team_auth.get_team_membership", return_value=None):
            from src.lib.team_auth import can_access_team
            assert can_access_team("u1", "t1") is False

    def test_returns_true_for_active_membership(self):
        with patch("src.lib.team_auth.get_team_membership", return_value={"status": "active"}):
            from src.lib.team_auth import can_access_team
            assert can_access_team("u1", "t1") is True

    def test_returns_false_for_inactive_membership(self):
        with patch("src.lib.team_auth.get_team_membership", return_value={"status": "removed"}):
            from src.lib.team_auth import can_access_team
            assert can_access_team("u1", "t1") is False


class TestIsTeamAdmin:
    def test_returns_false_when_no_membership(self):
        with patch("src.lib.team_auth.get_team_membership", return_value=None):
            from src.lib.team_auth import is_team_admin
            assert is_team_admin("u1", "t1") is False

    def test_returns_false_for_active_member_role(self):
        with patch("src.lib.team_auth.get_team_membership", return_value={"status": "active", "role": "member"}):
            from src.lib.team_auth import is_team_admin
            assert is_team_admin("u1", "t1") is False

    def test_returns_true_for_active_admin(self):
        with patch("src.lib.team_auth.get_team_membership", return_value={"status": "active", "role": "admin"}):
            from src.lib.team_auth import is_team_admin
            assert is_team_admin("u1", "t1") is True


class TestCanAccessOwnedResource:
    def test_personal_resource_uses_owner_user_id(self):
        from src.lib.team_auth import can_access_owned_resource

        assert can_access_owned_resource("u1", {"ownerType": "personal", "userId": "u1"}) is True
        assert can_access_owned_resource("u2", {"ownerType": "personal", "userId": "u1"}) is False

    def test_team_resource_checks_membership(self):
        with patch("src.lib.team_auth.can_access_team", return_value=True):
            from src.lib.team_auth import can_access_owned_resource
            assert can_access_owned_resource("u2", {"ownerType": "team", "teamId": "t1"}) is True

    def test_team_resource_denies_non_member(self):
        with patch("src.lib.team_auth.get_team_membership", return_value=None):
            from src.lib.team_auth import can_access_owned_resource
            assert can_access_owned_resource("u2", {"ownerType": "team", "teamId": "t1"}) is False


class TestDeleteOwnedResource:
    def test_team_resource_requires_admin(self):
        with patch("src.lib.team_auth.is_team_admin", return_value=False):
            from src.lib.team_auth import can_delete_owned_resource
            assert can_delete_owned_resource("u1", {"ownerType": "team", "teamId": "t1"}) is False

        with patch("src.lib.team_auth.is_team_admin", return_value=True):
            from src.lib.team_auth import can_delete_owned_resource
            assert can_delete_owned_resource("u1", {"ownerType": "team", "teamId": "t1"}) is True


class TestCanManageOwnedResource:
    """The trickiest helper: admin OR creator can manage; non-creator non-admin cannot."""

    def test_personal_resource_only_owner_can_manage(self):
        from src.lib.team_auth import can_manage_owned_resource

        item = {"ownerType": "personal", "userId": "u1"}
        assert can_manage_owned_resource("u1", item) is True
        assert can_manage_owned_resource("u2", item) is False

    def test_team_resource_admin_can_manage(self):
        with patch("src.lib.team_auth.is_team_admin", return_value=True):
            from src.lib.team_auth import can_manage_owned_resource

            item = {"ownerType": "team", "teamId": "t1", "createdByUserId": "u-creator"}
            assert can_manage_owned_resource("u-other-admin", item) is True

    def test_team_resource_creator_can_manage_even_if_not_admin(self):
        with patch("src.lib.team_auth.is_team_admin", return_value=False):
            from src.lib.team_auth import can_manage_owned_resource

            item = {"ownerType": "team", "teamId": "t1", "createdByUserId": "u-creator"}
            assert can_manage_owned_resource("u-creator", item) is True

    def test_team_resource_non_creator_non_admin_cannot_manage(self):
        with patch("src.lib.team_auth.is_team_admin", return_value=False):
            from src.lib.team_auth import can_manage_owned_resource

            item = {"ownerType": "team", "teamId": "t1", "createdByUserId": "u-creator"}
            assert can_manage_owned_resource("u-bystander", item) is False


class TestCanDeleteOwnedResource:
    """Delete is stricter than manage: ONLY admin can delete a team resource (not creator)."""

    def test_personal_resource_only_owner_can_delete(self):
        from src.lib.team_auth import can_delete_owned_resource

        item = {"ownerType": "personal", "userId": "u1"}
        assert can_delete_owned_resource("u1", item) is True
        assert can_delete_owned_resource("u2", item) is False

    def test_team_resource_creator_cannot_delete_unless_admin(self):
        with patch("src.lib.team_auth.is_team_admin", return_value=False):
            from src.lib.team_auth import can_delete_owned_resource

            item = {"ownerType": "team", "teamId": "t1", "createdByUserId": "u-creator"}
            assert can_delete_owned_resource("u-creator", item) is False


class TestDefensiveGuards:
    """The `if not item: return False` guards across the three resource helpers."""

    def test_can_access_returns_false_for_none(self):
        from src.lib.team_auth import can_access_owned_resource

        assert can_access_owned_resource("u1", None) is False

    def test_can_manage_returns_false_for_none(self):
        from src.lib.team_auth import can_manage_owned_resource

        assert can_manage_owned_resource("u1", None) is False

    def test_can_delete_returns_false_for_none(self):
        from src.lib.team_auth import can_delete_owned_resource

        assert can_delete_owned_resource("u1", None) is False


class TestGetActiveTeamMembership:
    def test_returns_none_when_user_has_no_memberships(self):
        with patch("src.lib.team_auth.list_team_memberships_for_user", return_value=[]):
            from src.lib.team_auth import get_active_team_membership

            assert get_active_team_membership("u1") is None

    def test_returns_none_when_db_returns_none(self):
        with patch("src.lib.team_auth.list_team_memberships_for_user", return_value=None):
            from src.lib.team_auth import get_active_team_membership

            assert get_active_team_membership("u1") is None

    def test_returns_first_active_membership(self):
        memberships = [
            {"teamId": "t-removed", "status": "removed"},
            {"teamId": "t-active", "status": "active"},
        ]
        with patch("src.lib.team_auth.list_team_memberships_for_user", return_value=memberships):
            from src.lib.team_auth import get_active_team_membership

            result = get_active_team_membership("u1")
            assert result["teamId"] == "t-active"

    def test_treats_missing_status_as_active_for_back_compat(self):
        with patch("src.lib.team_auth.list_team_memberships_for_user", return_value=[{"teamId": "t1"}]):
            from src.lib.team_auth import get_active_team_membership

            assert get_active_team_membership("u1")["teamId"] == "t1"


class TestGetTeamForUser:
    def test_returns_none_pair_when_no_membership(self):
        with patch("src.lib.team_auth.list_team_memberships_for_user", return_value=[]):
            from src.lib.team_auth import get_team_for_user

            team, membership = get_team_for_user("u1")
            assert team is None and membership is None

    def test_returns_team_and_membership_when_active(self):
        memberships = [{"teamId": "t-1", "status": "active", "role": "member"}]
        with patch("src.lib.team_auth.list_team_memberships_for_user", return_value=memberships), \
             patch("src.lib.team_auth.get_team", return_value={"teamId": "t-1", "name": "Acme"}):
            from src.lib.team_auth import get_team_for_user

            team, membership = get_team_for_user("u1")
            assert team["name"] == "Acme"
            assert membership["role"] == "member"


class TestListActiveTeamMembers:
    def test_filters_out_non_active_members(self):
        members = [
            {"userId": "u-active", "status": "active"},
            {"userId": "u-removed", "status": "removed"},
            {"userId": "u-implicit"},  # missing status defaults to active
        ]
        with patch("src.lib.team_auth.list_team_members_for_team", return_value=members):
            from src.lib.team_auth import list_active_team_members

            result = list_active_team_members("t-1")
            ids = {m["userId"] for m in result}
            assert ids == {"u-active", "u-implicit"}

    def test_handles_empty_or_none_response(self):
        with patch("src.lib.team_auth.list_team_members_for_team", return_value=None):
            from src.lib.team_auth import list_active_team_members

            assert list_active_team_members("t-1") == []


class TestOwnerFieldsForRequest:
    def test_personal_fields_stay_backwards_compatible(self):
        from src.lib.team_auth import owner_fields_for_request

        fields = owner_fields_for_request(user_id="u1", owner_type="personal", team_id=None)
        assert fields["userId"] == "u1"
        assert fields["ownerType"] == "personal"
        assert fields["createdByUserId"] == "u1"

    def test_team_fields_preserve_creator_user_id(self):
        from src.lib.team_auth import owner_fields_for_request

        fields = owner_fields_for_request(user_id="u1", owner_type="team", team_id="t1")
        assert fields["userId"] == "u1"
        assert fields["ownerType"] == "team"
        assert fields["teamId"] == "t1"
