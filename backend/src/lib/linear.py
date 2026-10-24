"""Linear API helpers — webhook verification, issue fetching, commenting, state updates."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import urllib.request

# Linear GraphQL endpoint — EU workspaces use the same API endpoint
LINEAR_API = "https://api.linear.app/graphql"
LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token"

_app_token_cache: dict = {"token": None, "expires_at": 0}


def get_app_token() -> str:
    """Get an application-level OAuth token using client_credentials grant.
    Posts as 'Pocket Eng' app instead of the user."""
    import time
    now = time.time()
    if _app_token_cache["token"] and _app_token_cache["expires_at"] > now + 60:
        return _app_token_cache["token"]

    client_id = os.environ.get("LINEAR_CLIENT_ID", "").strip()
    client_secret = os.environ.get("LINEAR_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        raise Exception("LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET not configured")

    import urllib.parse
    payload = urllib.parse.urlencode({
        "grant_type": "client_credentials",
        "client_id": client_id,
        "client_secret": client_secret,
        "scope": "read,write",
    }).encode()
    req = urllib.request.Request(
        LINEAR_TOKEN_URL,
        data=payload,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read())

    token = data["access_token"]
    expires_in = data.get("expires_in", 2591999)
    _app_token_cache["token"] = token
    _app_token_cache["expires_at"] = now + expires_in
    return token


def verify_webhook_signature(body: str, signature: str, secret: str):
    """Verify Linear webhook signature (HMAC-SHA256 of raw body)."""
    if not secret:
        raise Exception("LINEAR_WEBHOOK_SECRET not configured")
    expected = hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise Exception("Invalid Linear webhook signature")


def _graphql(access_token: str, query: str, variables: dict = None) -> dict:
    """Execute a Linear GraphQL query/mutation."""
    payload = json.dumps({"query": query, "variables": variables or {}}).encode()
    req = urllib.request.Request(
        LINEAR_API,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": access_token,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read())
    if data.get("errors"):
        raise Exception(f"Linear GraphQL error: {data['errors'][0].get('message', data['errors'])}")
    return data.get("data", {})


def fetch_issue(access_token: str, issue_id: str) -> dict:
    """Fetch full issue details including comments."""
    query = """
    query($id: String!) {
      issue(id: $id) {
        id
        identifier
        title
        description
        url
        comments {
          nodes {
            body
            user { name }
            createdAt
          }
        }
        team { id key name }
        labels { nodes { name } }
        assignee { id name }
        state { name type }
      }
    }
    """
    data = _graphql(access_token, query, {"id": issue_id})
    return data.get("issue", {})


def post_comment(access_token: str, issue_id: str, body: str):
    """Post a comment on a Linear issue."""
    mutation = """
    mutation($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) {
        comment { id }
      }
    }
    """
    _graphql(access_token, mutation, {"issueId": issue_id, "body": body})


def find_review_state(access_token: str, team_id: str) -> str | None:
    """Find the 'In Review' or similar workflow state for a team."""
    query = """
    query($teamId: String!) {
      workflowStates(filter: { team: { id: { eq: $teamId } } }) {
        nodes { id name type }
      }
    }
    """
    data = _graphql(access_token, query, {"teamId": team_id})
    states = data.get("workflowStates", {}).get("nodes", [])

    # Priority: exact "In Review" > contains "review" > type "started"
    for state in states:
        if state["name"].lower() == "in review":
            return state["id"]
    for state in states:
        if "review" in state["name"].lower():
            return state["id"]
    for state in states:
        if state.get("type") == "started":
            return state["id"]
    return None


def create_webhook(access_token: str, team_id: str, webhook_url: str, secret: str = "") -> str | None:
    """Create a webhook in Linear for issue events. Returns the webhook ID."""
    # First check if a webhook already exists for this URL
    existing = _graphql(access_token, """
        query { webhooks { nodes { id url } } }
    """)
    for wh in existing.get("webhooks", {}).get("nodes", []):
        if wh.get("url") == webhook_url:
            return wh["id"]  # Already exists

    mutation = """
    mutation($teamId: String!, $url: String!, $secret: String, $label: String!) {
      webhookCreate(input: {
        teamId: $teamId,
        url: $url,
        secret: $secret,
        label: $label,
        resourceTypes: ["Issue"]
      }) {
        webhook { id }
      }
    }
    """
    data = _graphql(access_token, mutation, {
        "teamId": team_id,
        "url": webhook_url,
        "secret": secret,
        "label": "Pocket Eng",
    })
    return data.get("webhookCreate", {}).get("webhook", {}).get("id")


def find_or_create_label(access_token: str, team_id: str, name: str = "Pocket Eng", color: str = "#55C6E5") -> str:
    """Find an existing label or create one. Returns the label ID."""
    # Search all labels (simple query — works with both user and app tokens)
    data = _graphql(access_token, "{ issueLabels { nodes { id name } } }")
    for label in data.get("issueLabels", {}).get("nodes", []):
        if label.get("name", "").lower() == name.lower():
            return label["id"]

    # Label not found — try to create it (may fail if token lacks admin)
    try:
        mutation = """
        mutation($teamId: String!, $name: String!, $color: String!) {
          issueLabelCreate(input: { name: $name, color: $color, teamId: $teamId }) {
            issueLabel { id }
          }
        }
        """
        data = _graphql(access_token, mutation, {"teamId": team_id, "name": name, "color": color})
        return data.get("issueLabelCreate", {}).get("issueLabel", {}).get("id", "")
    except Exception as e:
        print(f"Could not create label (need admin): {e}")
        return ""


def remove_label_from_issue(access_token: str, issue_id: str, label_id: str):
    """Remove a label from an issue (so the agent doesn't re-trigger on future updates)."""
    # Fetch current labels
    query = """
    query($id: String!) {
      issue(id: $id) {
        labelIds
      }
    }
    """
    data = _graphql(access_token, query, {"id": issue_id})
    current_ids = data.get("issue", {}).get("labelIds", [])
    new_ids = [lid for lid in current_ids if lid != label_id]
    if len(new_ids) == len(current_ids):
        return  # label not present, nothing to do

    mutation = """
    mutation($issueId: String!, $labelIds: [String!]!) {
      issueUpdate(id: $issueId, input: { labelIds: $labelIds }) {
        issue { id }
      }
    }
    """
    _graphql(access_token, mutation, {"issueId": issue_id, "labelIds": new_ids})


def update_issue_state(access_token: str, issue_id: str, state_id: str):
    """Move an issue to a new workflow state."""
    mutation = """
    mutation($issueId: String!, $stateId: String!) {
      issueUpdate(id: $issueId, input: { stateId: $stateId }) {
        issue { id }
      }
    }
    """
    _graphql(access_token, mutation, {"issueId": issue_id, "stateId": state_id})


def format_issue_prompt(issue: dict) -> str:
    """Format a Linear issue into a prompt for Claude."""
    identifier = issue.get("identifier", "")
    title = issue.get("title", "")
    description = issue.get("description", "") or ""
    url = issue.get("url", "")

    comments = issue.get("comments", {}).get("nodes", [])
    comments_text = ""
    if comments:
        comment_lines = []
        for c in comments:
            author = c.get("user", {}).get("name", "Unknown")
            body = c.get("body", "").strip()
            if body:
                comment_lines.append(f"  {author}: {body}")
        if comment_lines:
            comments_text = "\n\nComments:\n" + "\n".join(comment_lines)

    labels = [l["name"] for l in issue.get("labels", {}).get("nodes", [])]
    labels_text = f"\nLabels: {', '.join(labels)}" if labels else ""

    return (
        f"You are working on Linear issue {identifier}: {title}\n"
        f"URL: {url}\n"
        f"{labels_text}\n\n"
        f"{description}"
        f"{comments_text}\n\n"
        f"Complete this task fully. Push to a feature branch and create a PR.\n"
        f"Include \"{identifier}\" in the PR title so it links back to the Linear issue."
    )
