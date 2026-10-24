"""
HTML + text templates for transactional onboarding emails.

Why inline HTML strings (not react-email, not jinja):
  - Single-template payloads, ~50 lines each. Adding a templating
    engine costs more than it saves at this scale.
  - Inline f-strings give us LSP-checked variable references and no
    runtime template-load overhead in Lambda.
  - Migrating to react-email later is straightforward — these
    functions are the only consumer of the rendered output.

Each template returns (subject, html, text) so the caller can pass
them straight into `email.send_email`.
"""
from __future__ import annotations  # `tuple[...]` generic under Python <3.9
from html import escape


# Reusable visual primitives. Match the Pocket Eng dashboard's dark
# scheme but soften for email clients (gmail / apple-mail / outlook
# all render dark backgrounds OK, but we keep contrast generous).
_BASE_STYLE = """
  body { margin: 0; padding: 0; background: #0a0a0f; color: #eaeaef;
         font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI',
         Roboto, sans-serif; }
  .wrap { max-width: 480px; margin: 0 auto; padding: 40px 24px; }
  .card { background: #15151a; border: 1px solid #2a2a32; border-radius: 16px;
          padding: 28px; }
  h1 { font-size: 22px; line-height: 1.25; margin: 0 0 14px;
       color: #ffffff; letter-spacing: -0.01em; font-weight: 600; }
  p  { font-size: 14px; line-height: 1.55; margin: 0 0 14px; color: #c4c4cc; }
  .btn { display: inline-block; padding: 12px 22px; border-radius: 10px;
         background: #ffffff; color: #0a0a0f !important; font-size: 13px;
         font-weight: 600; text-decoration: none; margin-top: 8px; }
  .footer { font-size: 11px; color: #6e6e78; margin-top: 28px;
            text-align: center; }
  .footer a { color: #8e8e9a; text-decoration: none; }
"""


def _layout(title: str, body_html: str, *, unsubscribe_url: str = None) -> str:
    """Wrap body content in the shared shell (style block + card).

    Pass `unsubscribe_url` for non-transactional emails (the activity
    nudge, future lifecycle emails). Transactional emails (welcome,
    workspace ready) leave it None — those are tied to user-initiated
    actions and not subject to CAN-SPAM unsubscribe rules. Including
    an unsub link on transactionals would be confusing UX ("if I
    unsubscribe, will my workspace not provision?").
    """
    unsub_block = ""
    if unsubscribe_url:
        unsub_block = (
            f'<br><a href="{escape(unsubscribe_url)}">'
            'Don\'t want these? Unsubscribe.</a>'
        )
    return f"""<!doctype html>
<html><head>
  <meta charset="utf-8">
  <title>{escape(title)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>{_BASE_STYLE}</style>
</head><body>
  <div class="wrap">
    <div class="card">{body_html}</div>
    <div class="footer">
      Pocket Eng. Cloud coding agents, accessible from anywhere.<br>
      <a href="https://console.pocketeng.ai">console.pocketeng.ai</a>{unsub_block}
    </div>
  </div>
</body></html>"""


def workspace_ready(
    *,
    name: str = None,
    workspace_label: str = None,
    dashboard_url: str = "https://console.pocketeng.ai",
) -> tuple[str, str, str]:
    """Transactional "your workspace is ready" email.

    Triggered from `finalize.py` once the readiness state machine flips
    to "ready". Idempotent at the trigger (gated by the
    `workspaceReadyEmailSent` flag on the server record).

    Returns (subject, html, text). Voice is intentionally plain and
    short, matching the rest of the onboarding series. No em dashes
    anywhere by author preference.
    """
    subject = "Your workspace is ready"
    safe_url = escape(dashboard_url)
    body_html = f"""
      <p style="font-size:14px;color:#c4c4cc;margin:0 0 14px">Hey,</p>
      <p>Your workspace is up. The agent is installed and waiting.</p>
      <p>Open it and ask the agent to do something:</p>
      <p style="margin:8px 0 22px">
        <a href="{safe_url}" style="color:#6b9eff;word-break:break-all">{safe_url}</a>
      </p>
      <p>If you haven't already, install the iOS app. That's how most
      people end up using this once they get past the first session.</p>
      <p style="margin-top:22px;color:#8e8e9a">Vaibhav<br>Pocket Eng</p>
    """
    text = (
        "Hey,\n\n"
        "Your workspace is up. The agent is installed and waiting.\n\n"
        "Open it and ask the agent to do something:\n\n"
        f"{dashboard_url}\n\n"
        "If you haven't already, install the iOS app. That's how most "
        "people end up using this once they get past the first session.\n\n"
        "Vaibhav\n"
        "Pocket Eng"
    )
    return subject, _layout(subject, body_html), text


def activity_nudge(
    *,
    dashboard_url: str = "https://console.pocketeng.ai",
    unsubscribe_url: str,
    has_own_credentials: bool = False,
) -> tuple[str, str, str]:
    """24-hour-since-signup nudge for users whose workspace is ready
    but who haven't kicked off a session yet.

    Marketing-adjacent (not strictly transactional) so we MUST include
    an unsubscribe link. `unsubscribe_url` is required (no default) to
    make that explicit at the call site.

    `has_own_credentials` flips the trial-credits hint on/off. Users
    who already connected Claude Max / ChatGPT Plus don't need to be
    told to "use your own subscription instead of trial credits" —
    they already are.

    Voice: short narrative hook (engineer at a park on Saturday morning,
    shipping PRs from his phone with iced coffee in hand) followed by
    three concrete prompts. No em dashes.
    """
    subject = "Your workspace is sitting there"
    safe_url = escape(dashboard_url)
    trial_line = ""
    if not has_own_credentials:
        trial_line = (
            '<p style="margin-top:18px;color:#8e8e9a;font-size:13px">'
            'If you want to use your own Claude Max or ChatGPT Plus '
            'subscription instead of our trial credits, connect it '
            'in Settings, Coding Agents.'
            '</p>'
        )
    body_html = f"""
      <p style="font-size:14px;color:#c4c4cc;margin:0 0 14px">Hey,</p>
      <p>Quick story. One of our users is an engineer at a Series B
      startup. He told me about his Saturday routine: walks to a park
      near his apartment, sits on a bench with an iced coffee, runs
      his Pocket Eng agent from his phone for 90 minutes.</p>
      <p>By the time the coffee's gone, there are usually two or three
      PRs queued against his backlog.</p>
      <p>He told me he gets more done on a Saturday morning than he
      used to in a full afternoon at his desk on Monday.</p>
      <p>Your workspace is sitting there. If you're not sure what to
      ask it, try one of these:</p>
      <ol style="font-size:14px;color:#c4c4cc;line-height:1.6;padding-left:22px;margin:8px 0 18px">
        <li>"Map this codebase. What does each module do?"</li>
        <li>"Pick a small bug from the TODO list, fix it, open a PR."</li>
        <li>"Audit the auth module for security issues."</li>
      </ol>
      <p>Open it:</p>
      <p style="margin:8px 0 22px">
        <a href="{safe_url}" style="color:#6b9eff;word-break:break-all">{safe_url}</a>
      </p>
      {trial_line}
      <p style="margin-top:22px;color:#8e8e9a">Vaibhav<br>Pocket Eng</p>
    """
    text_trial = (
        "\n\nIf you want to use your own Claude Max or ChatGPT Plus "
        "subscription instead of our trial credits, connect it in "
        "Settings, Coding Agents."
        if not has_own_credentials else ""
    )
    text = (
        "Hey,\n\n"
        "Quick story. One of our users is an engineer at a Series B "
        "startup. He told me about his Saturday routine: walks to a "
        "park near his apartment, sits on a bench with an iced coffee, "
        "runs his Pocket Eng agent from his phone for 90 minutes.\n\n"
        "By the time the coffee's gone, there are usually two or three "
        "PRs queued against his backlog.\n\n"
        "He told me he gets more done on a Saturday morning than he "
        "used to in a full afternoon at his desk on Monday.\n\n"
        "Your workspace is sitting there. If you're not sure what to "
        "ask it, try one of these:\n\n"
        "  1. \"Map this codebase. What does each module do?\"\n"
        "  2. \"Pick a small bug from the TODO list, fix it, open a PR.\"\n"
        "  3. \"Audit the auth module for security issues.\"\n\n"
        f"Open it: {dashboard_url}"
        f"{text_trial}\n\n"
        "Vaibhav\n"
        "Pocket Eng\n\n"
        f"Don't want these? Unsubscribe: {unsubscribe_url}"
    )
    return subject, _layout(subject, body_html, unsubscribe_url=unsubscribe_url), text


def team_invite(
    *,
    team_name: str,
    inviter_email: str = None,
    accept_url: str = "https://console.pocketeng.ai/dashboard/settings",
) -> tuple[str, str, str]:
    """Transactional team-invite email.

    Triggered from team.py's POST /teams/{teamId}/invites after the
    invite row is persisted. Best-effort: a send_email failure does
    not block the API response — the invite still exists in DDB, and
    an admin can re-POST the same email to retry (the endpoint
    revokes the prior pending row first, effectively a resend).

    accept_url points at /dashboard/settings, where pending invites
    already render. Recipients without a Pocket Eng account get
    bounced through the Supabase Auth flow first; the invite is
    matched by email on next sign-in, so as long as they sign up
    with the same address, it picks up automatically.

    inviter_email is what we render as "X invited you to ..." — we
    pass the inviter's email address (taken straight from the JWT)
    rather than a display name. Reads slightly clunky for users
    with a long email, but avoids needing a Supabase admin lookup
    (and therefore the service-role key) in this Lambda. Worth
    revisiting if we later want personalised names; see options in
    the team_invite design discussion. When missing, copy degrades
    to "Someone".
    """
    inviter_label = inviter_email or "Someone"
    safe_inviter = escape(inviter_label)
    safe_team = escape(team_name)
    safe_url = escape(accept_url)
    subject = f"{inviter_label} invited you to the {team_name} team on Pocket Eng"
    body_html = f"""
      <p style="font-size:14px;color:#c4c4cc;margin:0 0 14px">Hey,</p>
      <p>{safe_inviter} invited you to join the <strong>{safe_team}</strong> team on Pocket Eng.</p>
      <p>To accept, head to your settings page:</p>
      <p style="margin:8px 0 22px">
        <a href="{safe_url}" style="color:#6b9eff;word-break:break-all">{safe_url}</a>
      </p>
      <p>If you don't have a Pocket Eng account yet, you'll be prompted
      to sign up. Use this same email address so the invitation matches
      your new account.</p>
      <p style="margin-top:22px;color:#8e8e9a">Pocket Eng</p>
    """
    text = (
        "Hey,\n\n"
        f"{inviter_label} invited you to join the {team_name} team on Pocket Eng.\n\n"
        "To accept, head to your settings page:\n\n"
        f"{accept_url}\n\n"
        "If you don't have a Pocket Eng account yet, you'll be prompted "
        "to sign up. Use this same email address so the invitation "
        "matches your new account.\n\n"
        "Pocket Eng"
    )
    return subject, _layout(subject, body_html), text


def welcome(
    *,
    name: str = None,
    dashboard_url: str = "https://console.pocketeng.ai",
) -> tuple[str, str, str]:
    """Welcome email fired ~once per user from the web /onboarding mount.

    Idempotent at the trigger via Supabase user_metadata.welcomeEmailSent.
    Sent BEFORE workspace provisioning kicks off, so we don't link to a
    specific workspace; just the dashboard root.

    Voice: short narrative hook (founder at a developer conference,
    fixing a prod bug from his phone) so the user gets the product
    pitch in 30 seconds without feeling sold to. No em dashes.
    """
    subject = "Your agent is up"
    safe_url = escape(dashboard_url)
    body_html = f"""
      <p style="font-size:14px;color:#c4c4cc;margin:0 0 14px">Hey,</p>
      <p>A founder we know spent last week at a developer conference.
      His app threw a 500 error in the middle of a keynote. He stepped
      into the hallway, opened Pocket Eng on his phone, told the agent
      "production auth is broken, find it and fix it," and went back
      to listening.</p>
      <p>By the next coffee break, there was a PR waiting. He merged
      it from his hotel that night.</p>
      <p>That's the bet. You shouldn't have to be at your desk to ship.</p>
      <p>Your workspace is provisioned. A few first prompts that work
      well:</p>
      <ol style="font-size:14px;color:#c4c4cc;line-height:1.6;padding-left:22px;margin:8px 0 18px">
        <li>"Map this codebase. What's in each module?"</li>
        <li>"Find every TODO and fix the easy ones."</li>
        <li>"Set up GitHub Actions CI for this repo."</li>
      </ol>
      <p>Open your workspace:</p>
      <p style="margin:8px 0 22px">
        <a href="{safe_url}" style="color:#6b9eff;word-break:break-all">{safe_url}</a>
      </p>
      <p style="margin-top:22px;color:#8e8e9a">Vaibhav<br>Pocket Eng</p>
    """
    text = (
        "Hey,\n\n"
        "A founder we know spent last week at a developer conference. "
        "His app threw a 500 error in the middle of a keynote. He "
        "stepped into the hallway, opened Pocket Eng on his phone, "
        "told the agent \"production auth is broken, find it and fix it,\" "
        "and went back to listening.\n\n"
        "By the next coffee break, there was a PR waiting. He merged "
        "it from his hotel that night.\n\n"
        "That's the bet. You shouldn't have to be at your desk to ship.\n\n"
        "Your workspace is provisioned. A few first prompts that work well:\n\n"
        "  1. \"Map this codebase. What's in each module?\"\n"
        "  2. \"Find every TODO and fix the easy ones.\"\n"
        "  3. \"Set up GitHub Actions CI for this repo.\"\n\n"
        f"Open your workspace: {dashboard_url}\n\n"
        "Vaibhav\n"
        "Pocket Eng"
    )
    return subject, _layout(subject, body_html), text
