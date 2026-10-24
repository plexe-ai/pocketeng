from __future__ import annotations

from src.lib.db import (
    get_team,
    get_team_membership,
    list_team_members_for_team,
    list_team_memberships_for_user,
)


def get_active_team_membership(user_id: str):
    memberships = list_team_memberships_for_user(user_id) or []
    active = [item for item in memberships if item.get("status", "active") == "active"]
    return active[0] if active else None


def get_team_for_user(user_id: str):
    membership = get_active_team_membership(user_id)
    if not membership:
        return None, None
    team = get_team(membership["teamId"])
    return team, membership


def is_team_admin(user_id: str, team_id: str) -> bool:
    membership = get_team_membership(user_id, team_id)
    if not membership:
        return False
    return membership.get("status", "active") == "active" and membership.get("role") == "admin"


def can_access_team(user_id: str, team_id: str) -> bool:
    membership = get_team_membership(user_id, team_id)
    if not membership:
        return False
    return membership.get("status", "active") == "active"


def can_access_owned_resource(user_id: str, item: dict | None) -> bool:
    if not item:
        return False
    team_id = item.get("teamId")
    if team_id:
        return can_access_team(user_id, team_id)
    owner_user_id = item.get("ownerUserId") or item.get("userId")
    return owner_user_id == user_id


def can_manage_owned_resource(user_id: str, item: dict | None) -> bool:
    if not item:
        return False
    team_id = item.get("teamId")
    if team_id:
        if is_team_admin(user_id, team_id):
            return True
        return item.get("createdByUserId") == user_id
    owner_user_id = item.get("ownerUserId") or item.get("userId")
    return owner_user_id == user_id


def can_delete_owned_resource(user_id: str, item: dict | None) -> bool:
    if not item:
        return False
    team_id = item.get("teamId")
    if team_id:
        return is_team_admin(user_id, team_id)
    owner_user_id = item.get("ownerUserId") or item.get("userId")
    return owner_user_id == user_id


def owner_fields_for_request(*, user_id: str, owner_type: str | None = None, team_id: str | None = None):
    if owner_type == "team" and team_id:
        return {
            "ownerType": "team",
            "userId": user_id,
            "ownerUserId": user_id,
            "teamId": team_id,
            "createdByUserId": user_id,
        }
    return {
        "ownerType": "personal",
        "ownerUserId": user_id,
        "userId": user_id,
        "createdByUserId": user_id,
    }


def list_active_team_members(team_id: str):
    members = list_team_members_for_team(team_id) or []
    return [item for item in members if item.get("status", "active") == "active"]
