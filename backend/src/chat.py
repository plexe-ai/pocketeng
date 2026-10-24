"""
POST /servers/{serverId}/chat — Chat with coding agents via SSH.
Actions: start-session, send-message, status-check, cancel, install-agent,
discover-services, preview-proxy, register-synced-session, run-command.

Live output is delivered via the session-events stream
(`src/session_events_ingest.py` + `src/session_events_read.py`), not by
polling this handler.
"""
import json
import os
import re
import shlex
import uuid
import base64
from datetime import datetime, timezone

from src.lib.auth import extract_auth_header, verify_token
from src.lib import cloudflare
from src.lib.db import (
    advance_session_run,
    claim_session_notification,
    get_all_sessions_by_server,
    get_server,
    get_messages,
    get_session,
    put_message,
    put_session,
    update_server,
    update_session,
)
from src.lib.kms import decrypt
from src.lib.push import send_session_notification
from src.lib.ssh import ssh_connect, ssh_exec, ssh_exec_bytes, ssh_disconnect
from src.lib.session_file_parser import extract_user_messages, parse_session_file
from src.lib.transcript import materialize_transcript, CURSOR_TOOL_CALL_KEYS
from src.lib.validation import find_validation_script, run_validation_script
from src.lib.worktree import find_repo_dir, create_worktree
from src.lib.agents import VALID_AGENT_IDS, get_agent_install_command, needs_bridge
from src.lib.bridge_deploy import ensure_bridge_deployed
from src.lib.team_auth import can_access_owned_resource, can_manage_owned_resource, owner_fields_for_request
from src.lib.script_builder import (
    build_agent_command,
    build_callback_exports,
    build_callback_tail,
    build_direct_cli_command,
    build_ingest_exports,
    build_launch_cmd,
)


MAX_VALIDATION_ATTEMPTS = 3


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _normalize_session_id(session_id=None, output_file_id=None):
    if session_id:
        return session_id
    if output_file_id:
        return output_file_id
    return uuid.uuid4().hex


def _session_paths(session_id):
    safe_session_id = shlex.quote(session_id)
    return (
        f"/tmp/pe-out-{safe_session_id}.jsonl",
        f"/tmp/pe-pid-{safe_session_id}",
    )


def _extract_remote_session_id(raw_line):
    try:
        parsed = json.loads(raw_line)
    except Exception:
        return None

    if parsed.get("type") == "system" and parsed.get("subtype") == "init":
        return parsed.get("session_id")
    if parsed.get("type") == "thread.started":
        return parsed.get("thread_id")
    return None


_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)


def _cursor_prealloc_chat_id(client):
    """Call `agent create-chat` over SSH to reserve a cursor chat id we can
    pass to `agent --resume` on the first turn. Returns the UUID string on
    success, None on any failure (callers fall back to a plain uuid4, which
    degrades to the old "preamble injection" path but doesn't break).

    We need this because cursor's `agent` CLI — unlike claude/codex — has
    no `--session-id` flag. Without pre-allocation, cursor invents its own
    id internally, our stored rsid never matches the on-disk rollout, and
    follow-up --resume always misses.
    """
    cmd = (
        # PATH setup mirrors build_launch_cmd: NVM for node-installed cursor,
        # /opt/homebrew/bin for mac-homebrew installs, ~/.local/bin for the
        # installer script's default target. Non-interactive SSH doesn't
        # source ~/.bashrc past the PS1 guard, so we do it manually.
        'export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"; '
        'export NVM_DIR="$HOME/.nvm"; '
        '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; '
        # CURSOR_API_KEY is what `agent create-chat` reads for auth.
        '[ -f ~/.pocketeng/cursor_key ] && '
        'export CURSOR_API_KEY="$(cat ~/.pocketeng/cursor_key)"; '
        'agent create-chat 2>/dev/null'
    )
    try:
        stdout, _, exit_code = ssh_exec(client, cmd, timeout=15)
    except Exception:
        return None
    if exit_code != 0:
        return None
    # Output is `<uuid>\n` plus sometimes a trailing "Shell cwd was reset"
    # debug line. Take the first non-empty line and validate it's a uuid.
    for line in stdout.splitlines():
        line = line.strip()
        if line and _UUID_RE.match(line.lower()):
            return line.lower()
    return None


def _completion_callback_secret():
    return os.environ.get("COMPLETION_CALLBACK_SECRET", "").strip()


def _public_api_base_url(event):
    configured = os.environ.get("PUBLIC_API_BASE_URL", "").strip()
    if configured:
        return configured.rstrip("/")

    if not event:
        return None

    headers = event.get("headers") or {}
    host = headers.get("x-forwarded-host") or headers.get("host")
    if not host:
        return None

    proto = headers.get("x-forwarded-proto") or "https"
    stage = (event.get("requestContext") or {}).get("stage")
    base = f"{proto}://{host}".rstrip("/")
    if stage:
        return f"{base}/{stage}"
    return base


def _completion_callback_url(event, session_id):
    base_url = _public_api_base_url(event)
    secret = _completion_callback_secret()
    if not base_url or not secret:
        return None
    return f"{base_url}/internal/sessions/{session_id}/complete"


def _ingest_url(event, session_id):
    base_url = _public_api_base_url(event)
    secret = _completion_callback_secret()
    if not base_url or not secret:
        return None
    return f"{base_url}/internal/sessions/{session_id}/events"


def _parse_output_lines(raw_output):
    lines = []
    raw_lines = [
        line.strip()
        for line in (raw_output.strip().split("\n") if raw_output.strip() else [])
        if line.strip()
    ]
    for line in raw_lines:
        try:
            parsed = json.loads(line)
            if isinstance(parsed, dict):
                lines.append(parsed)
                continue
        except json.JSONDecodeError:
            pass
        lines.append({"type": "text", "content": line})
    return raw_lines, _filter_hidden_tools(lines)


def _filter_hidden_tools(lines):
    """Remove hidden tool events from the list sent to the frontend."""
    filtered = []
    skip_next_result = False
    for line in lines:
        if not isinstance(line, dict):
            filtered.append(line)
            continue
        event_type = line.get("type")
        if event_type in ("assistant", "message"):
            msg = line.get("message")
            blocks = (
                (msg.get("content") if isinstance(msg, dict) else None)
                or line.get("content")
                or []
            )
            if isinstance(blocks, list):
                tool_names = [b.get("name") for b in blocks if isinstance(b, dict) and b.get("type") == "tool_use"]
                has_text = any(isinstance(b, dict) and b.get("type") == "text" for b in blocks)
                if tool_names and all(n in _SKIP_TOOL_RESULTS for n in tool_names) and not has_text:
                    skip_next_result = True
                    continue
                skip_next_result = False
            filtered.append(line)
        elif event_type == "tool_use":
            tool = line.get("tool")
            name = (
                (tool.get("name") if isinstance(tool, dict) else None)
                or line.get("name")
                or line.get("tool_name")
            )
            if name and name in _SKIP_TOOL_RESULTS:
                skip_next_result = True
                continue
            skip_next_result = False
            filtered.append(line)
        elif event_type in ("user", "tool_result"):
            if skip_next_result:
                skip_next_result = False
                continue
            filtered.append(line)
        elif event_type == "tool_call":
            name = _cursor_tool_call_name(line)
            if name and name in _SKIP_TOOL_RESULTS:
                continue
            filtered.append(line)
        else:
            filtered.append(line)
    return filtered


_SKIP_TOOL_RESULTS = frozenset({"Read", "Glob", "Grep", "ToolSearch"})

def _cursor_tool_call_name(parsed):
    """Extract the canonical tool name from a Cursor tool_call event."""
    tc = parsed.get("tool_call")
    if not isinstance(tc, dict):
        return None
    for key, name in CURSOR_TOOL_CALL_KEYS.items():
        if key in tc:
            return name
    fn = tc.get("function")
    if isinstance(fn, dict):
        return fn.get("name")
    return None


def _should_skip_persist(raw, last_tool_name):
    """Return (skip, tool_name) — skip=True means don't persist this line."""
    try:
        parsed = json.loads(raw)
    except Exception:
        return False, last_tool_name

    if not isinstance(parsed, dict):
        return False, last_tool_name

    event_type = parsed.get("type")

    if event_type in ("assistant", "message"):
        msg = parsed.get("message")
        blocks = (
            (msg.get("content") if isinstance(msg, dict) else None)
            or parsed.get("content")
            or []
        )
        if not isinstance(blocks, list):
            return False, None
        tool_names = []
        has_text = False
        for b in blocks:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "tool_use":
                tool_names.append(b.get("name"))
            elif b.get("type") == "text":
                has_text = True
        if tool_names and all(n in _SKIP_TOOL_RESULTS for n in tool_names) and not has_text:
            return True, tool_names[-1]
        last_name = tool_names[-1] if tool_names else None
        return False, last_name

    if event_type == "tool_use":
        tool = parsed.get("tool")
        name = (
            (tool.get("name") if isinstance(tool, dict) else None)
            or parsed.get("name")
            or parsed.get("tool_name")
        )
        if name and name in _SKIP_TOOL_RESULTS:
            return True, name
        return False, name

    if event_type in ("user", "tool_result"):
        if last_tool_name and last_tool_name in _SKIP_TOOL_RESULTS:
            return True, None
        return False, None

    if event_type == "tool_call":
        name = _cursor_tool_call_name(parsed)
        if name and name in _SKIP_TOOL_RESULTS:
            return True, name
        return False, name

    return False, last_tool_name


def _persist_agent_output(session_id, session, raw_lines, offset):
    if not raw_lines or not session_id:
        return

    now = _now_iso()
    seq_base = int((session or {}).get("currentRunSeqBase", 1))

    last_tool_name = None
    for index, raw in enumerate(raw_lines):
        try:
            json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            continue
        skip, last_tool_name = _should_skip_persist(raw, last_tool_name)
        if not skip:
            put_message(session_id, seq_base + offset + index, "agent", raw, now)

    session_updates = {"updatedAt": now}
    # Prefer `thread.started` (agent-assigned thread id, e.g. Codex's
    # rollout UUID) over `system/init` (bridge-assigned PE session id).
    # The bridge's `emitInit` echoes the PE_SESSION_ID as `session_id` on
    # the init line for event routing, so treating that as the agent's
    # remote session id overwrites a correct rsid with our own internal
    # id — the exact regression that caused the Codex duplicate-session
    # bug where the sync daemon couldn't match pulled .jsonl files back
    # to the live session record.
    remote_session_id = None
    for raw in raw_lines:
        try:
            parsed = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            continue
        if isinstance(parsed, dict) and parsed.get("type") == "thread.started":
            candidate = parsed.get("thread_id")
            if candidate:
                remote_session_id = candidate
                break
    if remote_session_id is None:
        remote_session_id = next(
            (found for found in (_extract_remote_session_id(raw) for raw in raw_lines) if found),
            None,
        )
    if remote_session_id:
        session_updates["remoteSessionId"] = remote_session_id

    advance_session_run(
        session_id,
        offset + len(raw_lines),
        seq_base + offset + len(raw_lines),
        session_updates,
    )


_PR_URL_RE = re.compile(r'https://github\.com/[^\s)"\'\]]+/pull/\d+')


def _extract_pr_url(transcript):
    """Scan transcript (reversed) for the last GitHub PR URL."""
    for msg in reversed(transcript):
        if msg.get("role") != "assistant":
            continue
        match = _PR_URL_RE.search(msg.get("content", ""))
        if match:
            return match.group(0)
        for tool in (msg.get("tools") or []):
            match = _PR_URL_RE.search(tool.get("output", "") or "")
            if match:
                return match.group(0)
    return None


def _complete_session_and_notify(session_id):
    now = _now_iso()

    # Load the session BEFORE marking it done — the validation harness needs
    # to know whether autopilot is enabled and how many attempts have already
    # happened, and on a fail it needs to spawn a follow-up turn (which would
    # then re-fire this hook on the next completion).
    session = get_session(session_id)
    if not session:
        return

    if session.get("autopilot") and session.get("status") != "validation_failed":
        # Returns True if a follow-up agent turn was spawned. In that case we
        # bail out — the next completion callback will end up back here once
        # the agent finishes the retry.
        if _try_validation_harness(session):
            return

    try:
        update_session(session_id, {"status": "done", "updatedAt": now})
    except Exception:
        pass
    # Re-read in case the harness updated worktreePath / lastValidationOutput.
    session = get_session(session_id) or session

    run_seq_base = int(session.get("currentRunSeqBase", 0) or 0)
    latest_seq = int(session.get("nextSeq", run_seq_base) or run_seq_base)
    notification_key = f"done:{run_seq_base}:{latest_seq}"

    try:
        claimed = claim_session_notification(
            session_id,
            notification_key,
            {"lastNotifiedAt": now},
        )
    except Exception as exc:
        print(f"Failed to claim notification for {session_id}: {exc}")
        return

    if not claimed:
        return

    try:
        messages = get_messages(session_id)
        transcript = materialize_transcript(messages, session_status="done")

        if session.get("autopilot"):
            pr_url = _extract_pr_url(transcript)
            if pr_url:
                try:
                    update_session(session_id, {"prUrl": pr_url})
                    session["prUrl"] = pr_url
                except Exception:
                    pass

        # Guard against a premature / cross-turn completion fire. Two triggers
        # land here per run (the HTTP completion hook AND the ingest
        # `run.finished` event), and one can arrive before this turn's answer
        # is materialized. The agent's FIRST ingested event each turn is a
        # system `init`/`status` line (not assistant text), so a seq-count check
        # isn't enough — the transcript can still be missing this run's reply.
        # In that state the transcript tail is the user's prompt (or a
        # content-less assistant), and `_notify_slack` reaches back to re-post
        # the PREVIOUS turn's answer as a stale duplicate (the "earlier message
        # sent again" bug). Only notify once the tail is a real assistant
        # message for this run; the authoritative later fire carries it.
        tail = transcript[-1] if transcript else None
        tail_ready = bool(
            tail
            and tail.get("role") == "assistant"
            and (tail.get("content", "").strip() or tail.get("tools"))
        )
        if tail_ready:
            send_session_notification(session, transcript)

            # Post back to Slack if session was initiated from Slack
            _notify_slack(session, transcript)

            # Update Linear issue if session was triggered from Linear
            _notify_linear(session, transcript)
    except Exception as exc:
        print(f"Failed to send push for session {session_id}: {exc}")


def _try_validation_harness(session):
    """
    Run the user's validation script on the EC2 (if one exists). On failure,
    spawn a follow-up turn fed by the agent's existing Claude session memory
    so the agent can self-heal.

    Returns:
      True  — a follow-up turn was spawned. Caller must NOT proceed with
              done/notify; the next completion callback will re-enter here.
      False — validation passed, was skipped (no script), or terminally failed
              (max attempts hit). Caller should proceed with done/notify.
    """
    session_id = session.get("sessionId")
    server_id = session.get("serverId")
    user_id = session.get("userId")
    worktree_path = session.get("worktreePath")
    if not session_id or not server_id:
        return False

    server = get_server(server_id)
    if not server or not server.get("publicIp") or not server.get("sshPrivateKey"):
        return False

    try:
        private_key_pem = decrypt(server["sshPrivateKey"])
    except Exception as exc:
        print(f"Validation harness: failed to decrypt SSH key for {session_id}: {exc}")
        return False

    username = server.get("sshUser", "ec2-user")
    try:
        client = ssh_connect(server["publicIp"], private_key_pem, username)
    except Exception as exc:
        print(f"Validation harness: SSH connect failed for {session_id}: {exc}")
        return False

    try:
        script_path = find_validation_script(client, worktree_path)
        if not script_path:
            # No script configured anywhere — skip cleanly. No claim consumed.
            return False

        # Idempotency: claim_session_notification gives us a free distributed
        # lock keyed on the current run. Two concurrent triggers (curl callback
        # AND a client poll) would otherwise both spawn duplicate follow-up
        # turns. We claim AFTER confirming a script exists so the no-script
        # path doesn't burn the claim and break notification dedup.
        run_seq_base = int(session.get("currentRunSeqBase", 0) or 0)
        next_seq = int(session.get("nextSeq", run_seq_base) or run_seq_base)
        validation_claim_key = f"validation:{run_seq_base}:{next_seq}"
        try:
            claimed = claim_session_notification(
                session_id,
                validation_claim_key,
                {"updatedAt": _now_iso()},
            )
        except Exception as exc:
            print(f"Validation harness: claim failed for {session_id}: {exc}")
            return False
        if not claimed:
            # Another invocation already ran (or is running) validation for
            # this run. Return True so the caller bails — the other
            # invocation owns the lifecycle and will notify on completion.
            return True

        attempt = int(session.get("validationAttempt", 0) or 0) + 1
        try:
            update_session(session_id, {
                "validationAttempt": attempt,
                "updatedAt": _now_iso(),
            })
        except Exception:
            pass

        # Discover branch for env vars (best-effort).
        branch = ""
        try:
            cd = shlex.quote(worktree_path or "$HOME")
            branch_stdout, _, _ = ssh_exec(
                client,
                f"cd {cd} 2>/dev/null && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo ''",
                timeout=5,
            )
            branch = (branch_stdout or "").strip()
        except Exception:
            pass

        passed, output, exit_code = run_validation_script(
            client,
            script_path=script_path,
            worktree_path=worktree_path or "",
            base_ref="origin/main",
            branch=branch,
            session_id=session_id,
        )

        print(
            f"Validation harness session={session_id} attempt={attempt} "
            f"script={script_path} passed={passed} exit={exit_code}"
        )

        if passed:
            # Reset the counter so a future autopilot turn on this session
            # gets a fresh budget.
            try:
                update_session(session_id, {
                    "validationAttempt": 0,
                    "lastValidationOutput": None,
                    "updatedAt": _now_iso(),
                })
            except Exception:
                pass
            return False

        if attempt >= MAX_VALIDATION_ATTEMPTS:
            # Give up. Caller will mark done and notify with the failure
            # context attached so the user knows what went wrong.
            try:
                update_session(session_id, {
                    "status": "validation_failed",
                    "lastValidationOutput": (output or "")[:4000],
                    "updatedAt": _now_iso(),
                })
            except Exception:
                pass
            return False

        # Persist the validator output as an audit row (filtered out of the
        # user-facing transcript by materialize_transcript).
        try:
            seq = int(session.get("nextSeq", 0) or 0)
            put_message(session_id, seq, "validator", output, _now_iso())
        except Exception as exc:
            print(f"Validation harness: failed to persist validator row: {exc}")

        # Build the feedback prompt fed back to the agent.
        feedback = (
            "Your changes failed validation. Read the output below, fix the "
            "issues, commit, and push again. Do NOT open a new PR — push to "
            "the same branch.\n\n"
            f"=== Validation output (attempt {attempt}/{MAX_VALIDATION_ATTEMPTS}) ===\n"
            f"{output}"
        )

        body = {
            "prompt": feedback,
            "sessionId": session_id,
            "agent": session.get("agent", "claude"),
            "autopilot": True,
            "fromValidator": True,
        }
        if session.get("model"):
            body["model"] = session["model"]

        try:
            _launch_turn(client, body, server_id, user_id, event=None)
            return True
        except Exception as exc:
            print(f"Validation harness: failed to spawn follow-up turn: {exc}")
            try:
                update_session(session_id, {
                    "status": "validation_failed",
                    "lastValidationOutput": (output or "")[:4000],
                    "updatedAt": _now_iso(),
                })
            except Exception:
                pass
            return False

    finally:
        try:
            ssh_disconnect(client)
        except Exception:
            pass


def _notify_slack(session, transcript):
    """Post the result back to Slack if this session has Slack reply coordinates."""
    slack_reply = session.get("slackReply")
    if not slack_reply:
        return

    from src.lib.slack import post_to_slack, chat_post_message

    pr_url = session.get("prUrl")
    status = session.get("status", "done")

    # Build the Slack message
    if pr_url:
        pr_match = re.search(r'github\.com/([^/]+/[^/]+)/pull/(\d+)', pr_url)
        if pr_match:
            text = f"*PR created:* <{pr_url}|{pr_match.group(1)}#{pr_match.group(2)}>"
        else:
            text = f"*PR created:* <{pr_url}>"
    elif status == "error" or (transcript and transcript[-1].get("state") == "error"):
        last_text = (transcript[-1].get("content", "") if transcript else "")[:500]
        text = f"*Task failed.*\n{last_text}" if last_text else "*Task failed.*"
    else:
        # Extract last assistant message as summary
        last_text = ""
        for msg in reversed(transcript or []):
            if msg.get("role") == "assistant" and msg.get("content", "").strip():
                last_text = msg["content"].strip()[:2000]
                break
        text = last_text if last_text else "Done."

    try:
        source = slack_reply.get("source", "command")
        if source == "mention" and slack_reply.get("botToken") and slack_reply.get("channel"):
            chat_post_message(
                slack_reply["botToken"],
                slack_reply["channel"],
                text,
                slack_reply.get("threadTs"),
            )
        elif slack_reply.get("responseUrl"):
            post_to_slack(slack_reply["responseUrl"], text)
    except Exception as exc:
        print(f"Failed to reply to Slack: {exc}")


def _notify_linear(session, transcript):
    """Update Linear issue with PR link and move to review if session was triggered from Linear."""
    linear_reply = session.get("linearReply")
    if not linear_reply:
        return

    from src.lib.linear import post_comment, find_review_state, update_issue_state, get_app_token

    issue_id = linear_reply.get("issueId")
    identifier = linear_reply.get("identifier", "")
    team_id = linear_reply.get("teamId")

    if not issue_id:
        return

    try:
        # Use app token so comments show as "Pocket Eng" not the user
        access_token = get_app_token()
        pr_url = session.get("prUrl")
        status = session.get("status", "done")

        # Build comment
        if pr_url:
            pr_match = re.search(r'github\.com/([^/]+/[^/]+)/pull/(\d+)', pr_url)
            if pr_match:
                comment = f"PR created: [{pr_match.group(1)}#{pr_match.group(2)}]({pr_url})"
            else:
                comment = f"PR created: {pr_url}"
        elif status == "error" or (transcript and transcript[-1].get("state") == "error"):
            last_text = (transcript[-1].get("content", "") if transcript else "")[:500]
            comment = f"Task failed.\n\n{last_text}" if last_text else "Task failed."
        else:
            last_text = ""
            for msg in reversed(transcript or []):
                if msg.get("role") == "assistant" and msg.get("content", "").strip():
                    last_text = msg["content"].strip()[:1000]
                    break
            comment = last_text if last_text else "Done."

        post_comment(access_token, issue_id, comment)

        # Move to review state if PR was created
        if pr_url and team_id:
            review_state = find_review_state(access_token, team_id)
            if review_state:
                update_issue_state(access_token, issue_id, review_state)

    except Exception as exc:
        print(f"Failed to update Linear issue {issue_id}: {exc}")


def sync_session_output(client, session_id, offset, pid="", server_id=None, notify_on_done=False):
    session = get_session(session_id)
    if session and server_id and session.get("serverId") != server_id:
        raise ValueError("Session belongs to a different server")

    out_file, _ = _session_paths(session_id)
    fallback_file = f"/tmp/pe-{shlex.quote(session_id)}.jsonl"

    if not pid:
        pid_lookup = f"PID=$(cat /tmp/pe-pid-{shlex.quote(session_id)} 2>/dev/null || echo ''); "
    else:
        pid_lookup = f"PID={shlex.quote(str(pid))}; "

    cmd = (
        f"{pid_lookup}"
        f"FILE={out_file}; [ ! -f $FILE ] && FILE={fallback_file}; "
        f"tail -n +{offset + 1} $FILE 2>/dev/null; "
        f"echo '---PE_SEP---'; "
        f"[ -n \"$PID\" ] && kill -0 $PID 2>/dev/null && echo RUNNING || echo DONE"
    )

    stdout, _, _ = ssh_exec(client, cmd)

    parts = stdout.split("---PE_SEP---")
    raw_output = parts[0] if parts else ""
    status = parts[1].strip() if len(parts) > 1 else "DONE"
    raw_lines, lines = _parse_output_lines(raw_output)

    if raw_lines and session_id:
        _persist_agent_output(session_id, session, raw_lines, offset)

    new_offset = offset + len(raw_lines)

    is_done = status == "DONE"
    if not is_done and session and session.get("status") == "done":
        is_done = True
    if not is_done:
        for line in lines:
            if isinstance(line, dict) and line.get("type") == "result":
                is_done = True
                if pid:
                    try:
                        ssh_exec(client, f"kill {shlex.quote(str(pid))} 2>/dev/null || true", timeout=5)
                    except Exception:
                        pass
                break

    if is_done and session_id and notify_on_done:
        _complete_session_and_notify(session_id)

    return {
        "lines": lines,
        "offset": new_offset,
        "done": is_done,
    }


def _launch_turn(client, body, server_id, user_id, event=None):
    prompt = body.get("prompt", "").strip()
    if not prompt:
        return respond(400, {"error": "prompt required"})
    raw_user_prompt = prompt
    autopilot = body.get("autopilot", False)
    setup_session = body.get("setupSession", False)
    # fromValidator: this turn is being spawned by the validation harness as
    # a self-heal cycle. Persist the prompt as role="validator" instead of
    # "user", don't update lastPrompt, and don't re-inject the autopilot
    # prompt prefix (the agent already has it from its --resume context).
    from_validator = body.get("fromValidator", False)

    requested_session_id = body.get("sessionId")
    output_file_id = body.get("outputFileId")
    session_id = _normalize_session_id(requested_session_id, output_file_id)
    completion_callback_url = _completion_callback_url(event, session_id)
    completion_callback_secret = _completion_callback_secret()

    existing_session = get_session(session_id) if (requested_session_id or output_file_id) else None
    # Sending a message appends a turn — that's a mutation, so we require
    # manage-level access (creator OR team admin) rather than just the
    # broader read-access rule. A member viewing a teammate's session can
    # read it; only the creator or an admin can continue the conversation.
    if existing_session and not can_manage_owned_resource(user_id, existing_session):
        return respond(403, {"error": "Only the session creator or a team admin can continue this session"})
    if existing_session and existing_session.get("serverId") != server_id:
        return respond(400, {"error": "Session belongs to a different server"})

    agent = (
        body.get("agent")
        or (existing_session or {}).get("agent")
        or "claude"
    )
    model = body.get("model") or (existing_session or {}).get("model")
    workdir = body.get("workdir", "~/projects")

    # Remote session id is a proper dashed UUID that claude --session-id expects.
    # On first turn we generate it and pass --session-id; on follow-up turns we
    # pass --resume with the same id. Claude persists the session to disk
    # between runs so this gives us native multi-turn memory.
    existing_rsid = (existing_session or {}).get("remoteSessionId")
    remote_session_id = existing_rsid or str(uuid.uuid4())

    # Verify claude has an actual persisted session file for the rsid before
    # trying --resume. Legacy sessions (from pre-fix code that extracted the id
    # from the init event) have rsids pointing at sessions that were never
    # written to disk, and --resume on them fails with "No conversation found".
    # In that case we start fresh with --session-id on a new uuid so the
    # session self-heals on the next turn.
    can_resume = False
    if agent == "claude" and existing_rsid:
        find_cmd = (
            f"find ~/.claude/projects -name {shlex.quote(existing_rsid + '.jsonl')} "
            f"-type f 2>/dev/null | head -1"
        )
        find_stdout, _, _ = ssh_exec(client, find_cmd)
        if find_stdout.strip():
            can_resume = True

    if agent == "cursor" and existing_rsid:
        find_cmd = (
            f"find ~/.cursor/projects -name {shlex.quote(existing_rsid + '.jsonl')} "
            f"-type f 2>/dev/null | head -1"
        )
        find_stdout, _, _ = ssh_exec(client, find_cmd)
        if find_stdout.strip():
            can_resume = True

    # Codex stores rollouts under ~/.codex/sessions/YYYY/MM/DD/ with a
    # filename pattern of `rollout-<ts>-<thread_id>.jsonl`. The SDK's
    # resumeThread(id) will append new turns to THAT file if and only
    # if it exists. Probe for the file before flipping can_resume so we
    # don't hand the SDK a ghost id and end up with "thread not found".
    # The glob-shaped suffix match is safe: rollout filenames contain a
    # leading timestamp we don't know, but the thread id is a
    # guaranteed-unique UUID suffix. Keeping this as a `find -name` call
    # matches the Claude/Cursor probes above for consistency.
    if agent == "codex" and existing_rsid:
        find_cmd = (
            f"find ~/.codex/sessions -name {shlex.quote('*' + existing_rsid + '.jsonl')} "
            f"-type f 2>/dev/null | head -1"
        )
        find_stdout, _, _ = ssh_exec(client, find_cmd)
        if find_stdout.strip():
            can_resume = True

    if agent == "opencode" and existing_rsid:
        # OpenCode sessions are SDK-owned. We don't currently parse its on-disk
        # session store, so let the bridge attempt a native reopen via
        # session.get(id) and fall back to session.create(...) if the id is no
        # longer valid.
        can_resume = True

    if not can_resume:
        # Rotate to a fresh rsid so --session-id doesn't collide with a stale one.
        remote_session_id = str(uuid.uuid4())

    # Cursor's `agent` CLI has no --session-id flag — it generates its own
    # chat id internally, which means a naively-generated uuid we stored in
    # DynamoDB would NEVER match the on-disk .jsonl name, and every
    # follow-up turn would fail the `find ... -name <rsid>.jsonl` check
    # above, fall through to can_resume=False, rotate to yet another uuid,
    # and inject the "You are continuing an ongoing conversation" preamble
    # (losing native --resume context memory).
    #
    # Workaround: `agent create-chat` pre-allocates an empty chat and
    # returns its UUID. Passing that UUID to `agent --resume <id>` on the
    # FIRST turn makes cursor persist the rollout under our chosen id, so
    # subsequent turns find it via the check above and can_resume=True.
    # Tested: create-chat + --resume on an empty chat is supported by the
    # current cursor agent CLI (v2026.04.17-787b533+).
    if agent == "cursor" and not can_resume:
        prealloc = _cursor_prealloc_chat_id(client)
        if prealloc:
            remote_session_id = prealloc
            # Force the --resume path for turn 1 so cursor writes the rollout
            # under our id. The rollout doesn't exist yet (create-chat is
            # a no-op on disk), but --resume against an empty chat is a
            # legal cursor invocation and produces the session files.
            can_resume = True

    # BYOS servers may not have Node.js installed (they're user-provided),
    # so we historically skipped the bridge entirely and fell back to the
    # agent's native CLI. That works for basic completion but loses token-
    # level streaming — the bridge is what emits `assistant.text_delta`
    # events to the ingest endpoint. Probe for Node instead of unconditionally
    # excluding BYOS so workspaces that DO have Node (common — most BYOS
    # users set them up for their own dev flow) get streaming. If the probe
    # fails we fall back to direct CLI, same UX as before (the client's
    # stale-done reload still surfaces the final transcript).
    server_record = get_server(server_id)
    is_byos = bool(server_record and server_record.get("envType") == "byos")
    use_bridge = needs_bridge([agent])
    if use_bridge and is_byos:
        # Non-interactive SSH doesn't load nvm by default, so a plain
        # `command -v node` misses nvm-managed Node installs (the most
        # common setup on Ubuntu dev boxes). Source nvm.sh first, then
        # probe. Fall back to the ubiquitous system paths just in case.
        probe_stdout, _, probe_exit = ssh_exec(
            client,
            "(source ~/.nvm/nvm.sh 2>/dev/null; "
            "command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1) "
            "|| [ -x /usr/bin/node ] || [ -x /usr/local/bin/node ] "
            "&& echo ok",
            timeout=5,
        )
        if probe_exit != 0 or probe_stdout.strip() != "ok":
            use_bridge = False

    if agent == "opencode" and not use_bridge:
        return respond(400, {
            "error": (
                "OpenCode requires the PocketEngineer bridge runtime. "
                "Install Node.js/npm on this server or use a managed workspace."
            ),
        })

    if use_bridge:
        agent_cmd = build_agent_command(agent, model=model, can_resume=can_resume, remote_session_id=remote_session_id)
    else:
        agent_cmd = build_direct_cli_command(agent, model=model, can_resume=can_resume, remote_session_id=remote_session_id)
    out_file, pid_file = _session_paths(session_id)

    # If this agent runs inside our bridge, make sure the VM has the current
    # bridge code at ~/.pocketeng/bridge/. Idempotent and skipped when the
    # version file already matches.
    if use_bridge:
        try:
            ensure_bridge_deployed(client)
        except Exception as exc:
            print(f"ensure_bridge_deployed failed for session {session_id}: {exc}")

    # Sync any locally-imported agent credentials (Claude OAuth bundle,
    # Codex auth, Cursor API key) onto the EC2 host so the agent runs as the user
    # under their own subscription. Idempotent: writes the same file every
    # turn, with refreshed contents if the user re-imported them. Best-effort:
    # if there are no stored credentials we silently fall back to whatever
    # API key was provisioned with the workspace.
    try:
        from src.lib.agent_credentials_sync import push_credentials_for_user
        sync_results = push_credentials_for_user(client, user_id, agents=[agent])
        if sync_results:
            print(f"agent-creds sync session={session_id} {sync_results}")
    except Exception as exc:
        print(f"agent-creds sync failed for session {session_id}: {exc}")

    # Worktree: every new task session with a repo runs in its own worktree.
    # - Setup sessions (pe install, dep setup) stay in shared ~/projects.
    # - Sessions with no repo in the workdir (e.g. scratch/shell) stay in ~/projects.
    # - Existing sessions reuse their pinned worktree.
    # - Anything else: create a fresh worktree. A failure here fails the turn;
    #   we do NOT silently degrade to shared workdir because that invalidates the
    #   per-session isolation the rest of the stack now depends on.
    worktree_path = (existing_session or {}).get("worktreePath")
    repo_dir = (existing_session or {}).get("repoDir")
    branch_name = (existing_session or {}).get("branchName")

    if not worktree_path and not existing_session and not setup_session:
        found_repo = find_repo_dir(client, workdir)
        if found_repo:
            wt_path, branch = create_worktree(client, found_repo, session_id)
            if not wt_path:
                return respond(500, {
                    "error": (
                        "Failed to create git worktree for this session. Check that the "
                        "repo is in a clean state and that git is installed on the server."
                    ),
                })
            worktree_path = wt_path
            repo_dir = found_repo
            branch_name = branch
            workdir = wt_path

    # Pin existing sessions to their dedicated worktree even if the client sends
    # a generic workdir on a follow-up turn.
    if worktree_path:
        workdir = worktree_path

    # Tell the agent where it is. Without this, a literal instruction like
    # "go to the repo" makes it cd to ~/projects/<repo> (the main checkout),
    # escaping its worktree. The prompt is prepended on the first turn only
    # (existing_session = None); follow-up turns keep the context via
    # Claude's --resume session memory.
    if worktree_path and not existing_session:
        worktree_note = (
            "[Session context — not from the user]\n"
            "You are running in a dedicated git worktree for this session.\n"
            f"- Working directory (your cwd): {workdir}\n"
            f"- Branch: {branch_name or 'unknown'} (branched from origin's default)\n"
            "This worktree IS the repo for this session. You do NOT need to cd\n"
            "anywhere — you are already in the correct directory. Do not create\n"
            "another worktree; you are already isolated. Commit and push from\n"
            "here, and a PR from this branch is the expected artifact.\n"
            "[End session context]\n\n"
        )
        prompt = worktree_note + prompt

    if autopilot and not existing_session:
        from src.lib.userdata import BUILT_IN_SKILLS
        pr_skill = BUILT_IN_SKILLS.get("pr-workflow", "")
        prompt = (
            "You are in AUTOPILOT mode. Complete this task fully and autonomously.\n"
            "Do NOT ask the user clarifying questions — make reasonable decisions and proceed.\n"
            "\n"
            "CRITICAL pre-flight rules — read these before anything else:\n"
            "1. Run `git status` first. If the workspace has uncommitted changes you didn't make, "
            "STOP and reply with what you see — do not proceed with a dirty workspace.\n"
            "2. Before calling any function from existing code, grep for its definition AND "
            "another usage to confirm the real name and signature. Do not guess.\n"
            "3. Stage files individually with `git add path/to/file`. NEVER use `git add .`.\n"
            "4. After staging, run `git diff --cached` and read it end-to-end. If it contains "
            "any .pyc, .log, tsconfig.tsbuildinfo, IMPLEMENTATION_*.md, demo-*.html, or files "
            "outside the scope of your task, unstage them.\n"
            "5. Never create summary docs, demo HTML, or screenshots committed to the repo. "
            "The PR body is the explanation. (Screenshots written to /tmp/ for your own "
            "visual verification are fine and expected — they just never get committed.)\n"
            "6. MANDATORY web-UI visual verification. If your diff touches ANY file under "
            "`web/` (components, styles, layouts, pages, globals.css), you MUST start the "
            "dev server, screenshot each affected page at BOTH 1280×800 (desktop) AND "
            "390×844 (mobile), and Read the PNGs with the Read tool to actually look at "
            "them. Type-checking and `bun run build` are not substitutes — a CSS/layout "
            "regression compiles clean and only shows visually. See the UI step in the "
            "pr-workflow skill below for the exact chromium commands. Do not open the PR "
            "until the screenshots match intent at both widths.\n"
            "\n"
            f"{pr_skill}\n\n"
            "---\n\nTask:\n"
            f"{prompt}"
        )

    # If this is a follow-up turn on an existing session but we can't resume
    # (legacy rsid or persisted session went missing), rebuild the prior
    # conversation into the prompt so context isn't lost.
    if existing_session and not can_resume:
        try:
            prior = get_messages(session_id)
            transcript = materialize_transcript(
                prior,
                session_status=existing_session.get("status", "done"),
            )
            history_lines = []
            for msg in transcript:
                role = msg.get("role")
                content = (msg.get("content") or "").strip()
                if not content:
                    continue
                if role == "user":
                    history_lines.append(f"User: {content}")
                elif role == "assistant":
                    if len(content) > 4000:
                        content = content[:4000] + "…[truncated]"
                    history_lines.append(f"Assistant: {content}")
            if history_lines:
                history_block = "\n\n".join(history_lines)
                prompt = (
                    "You are continuing an ongoing conversation. "
                    "Below is the prior transcript for context, followed by the user's new message. "
                    "Respond to the new message directly — do not repeat earlier answers.\n\n"
                    "=== Prior conversation ===\n"
                    f"{history_block}\n\n"
                    "=== New message ===\n"
                    f"{prompt}"
                )
        except Exception as exc:
            print(f"Failed to rebuild history for legacy session {session_id}: {exc}")

    prompt_b64 = base64.b64encode(prompt.encode()).decode()
    turn_id = uuid.uuid4().hex
    prompt_file = f"/tmp/pe-prompt-{turn_id}.txt"
    script_file = f"/tmp/pe-run-{turn_id}.sh"

    # Images manifest: [{path: "/tmp/pe-uploads/...", mediaType: "image/png"}, ...]
    # Uploaded files are already on EC2 via SFTP; we write a JSON manifest so
    # the bridge can read the image bytes and inject them as native content
    # blocks (Claude SDK streaming input, OpenCode parts array, etc.).
    # Only wired when the caller sends the structured images array.
    images = body.get("images") or []
    images_b64 = None
    images_file = None
    if images and use_bridge:
        images_manifest = json.dumps(images)
        images_b64 = base64.b64encode(images_manifest.encode()).decode()
        images_file = f"/tmp/pe-images-{turn_id}.json"

    cb_exports = build_callback_exports(
        completion_callback_url, completion_callback_secret,
        server_id, session_id, pid_file, script_file,
    )
    cb_tail = build_callback_tail(
        completion_callback_url, completion_callback_secret, script_file,
    )
    ingest_exports = build_ingest_exports(
        _ingest_url(event, session_id),
        completion_callback_secret,
        session_id,
        turn_id,
        script_file,
    )

    cmd = build_launch_cmd(
        workdir=workdir,
        prompt_b64=prompt_b64,
        prompt_file=prompt_file,
        script_file=script_file,
        agent_cmd=agent_cmd,
        out_file=out_file,
        pid_file=pid_file,
        callback_exports=cb_exports,
        callback_tail=cb_tail,
        ingest_exports=ingest_exports,
        agent=agent,
        images_b64=images_b64,
        images_file=images_file,
    )

    stdout, _, _ = ssh_exec(
        client,
        f"bash -l -c {shlex.quote('export PATH=/opt/homebrew/bin:$PATH; ' + cmd)}",
    )
    pid = stdout.strip().split("\n")[-1].strip()

    now = _now_iso()
    try:
        update_server(server_id, {"lastActivityAt": now})
    except Exception:
        pass

    user_seq = int((existing_session or {}).get("nextSeq", 0))
    agent_seq_base = user_seq + 1

    try:
        # Validator turns store the prompt as role="validator" so the
        # transcript materializer can hide them from the user-facing chat
        # UI. The agent still sees them via Claude's --resume session memory.
        message_role = "validator" if from_validator else "user"
        put_message(session_id, user_seq, message_role, raw_user_prompt, now)

        if existing_session:
            updates = {
                "updatedAt": now,
                "status": "running",
                "agent": agent,
                "nextSeq": agent_seq_base,
                "currentRunSeqBase": agent_seq_base,
                "currentRunOffset": 0,
                "remoteSessionId": remote_session_id,
            }
            # Don't overwrite lastPrompt with validator feedback — the user
            # cares about THEIR last prompt, not the harness's chatter.
            if not from_validator:
                updates["lastPrompt"] = raw_user_prompt
            if model:
                updates["model"] = model
            update_session(session_id, updates)
        else:
            ownership = owner_fields_for_request(
                user_id=user_id,
                owner_type=server_record.get("ownerType", "personal"),
                team_id=server_record.get("teamId"),
            )
            item = {
                "sessionId": session_id,
                "serverId": server_id,
                "createdAt": now,
                "updatedAt": now,
                "status": "running",
                "prompt": raw_user_prompt,
                "lastPrompt": raw_user_prompt,
                "agent": agent,
                "nextSeq": agent_seq_base,
                "currentRunSeqBase": agent_seq_base,
                "currentRunOffset": 0,
                "remoteSessionId": remote_session_id,
                **ownership,
            }
            if model:
                item["model"] = model
            if autopilot:
                item["autopilot"] = True
            if setup_session:
                item["setupSession"] = True
            if worktree_path:
                item["worktreePath"] = worktree_path
            if repo_dir:
                item["repoDir"] = repo_dir
            if branch_name:
                item["branchName"] = branch_name
            put_session(item)
    except Exception:
        pass

    return respond(200, {"sessionId": session_id, "pid": pid})


def respond(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def _ensure_github_on_server(client, claims):
    """Write GitHub token + git config to the server if the user has connected GitHub."""
    try:
        meta = claims.get("user_metadata") or {}
        gh_token = meta.get("githubToken", "")
        gh_username = meta.get("githubUsername", "")
        if not gh_token:
            return

        # Check if already present (fast path — avoids rewriting every request)
        stdout, _, _ = ssh_exec(client, "[ -f ~/.pocketeng/github_token ] && echo EXISTS || echo MISSING", timeout=5)
        if "EXISTS" in stdout:
            return

        cmd = (
            "mkdir -p ~/.pocketeng && "
            f"echo {shlex.quote(gh_token)} > ~/.pocketeng/github_token && "
            "chmod 600 ~/.pocketeng/github_token && "
            f"git config --global user.name {shlex.quote(gh_username)} && "
            "git config --global credential.helper store && "
            f"echo {shlex.quote(f'https://{gh_username}:{gh_token}@github.com')} > ~/.git-credentials && "
            "chmod 600 ~/.git-credentials"
        )
        ssh_exec(client, cmd, timeout=10)
    except Exception as e:
        print(f"_ensure_github_on_server failed (non-fatal): {e}")


_RUN_COMMANDS = {
    "doctor": (
        "echo '=== Node ===' && (source ~/.nvm/nvm.sh 2>/dev/null; node -v 2>/dev/null || echo 'not installed') && "
        "echo '=== Python ===' && (python3 --version 2>/dev/null || echo 'not installed') && "
        "echo '=== Git ===' && (git --version 2>/dev/null || echo 'not installed') && "
        "echo '=== Disk ===' && df -h / | tail -1 && "
        "echo '=== Agents ===' && (source ~/.nvm/nvm.sh 2>/dev/null; "
        "for a in claude codex agent; do which $a 2>/dev/null && echo \"  $a: $(which $a)\" || echo \"  $a: not installed\"; done)"
    ),
    "env": (
        "echo '=== Custom Environment Variables ===' && "
        "sed -n '/# >>> PE_CUSTOM_ENV/,/# <<< PE_CUSTOM_ENV/p' ~/.bashrc ~/.zprofile 2>/dev/null || echo 'No custom env vars set'"
    ),
    "init": "cat ~/projects/CLAUDE.md 2>/dev/null || echo 'No CLAUDE.md found. Create one with project instructions.'",
    "memory": "cat ~/projects/CLAUDE.md 2>/dev/null || echo 'No CLAUDE.md found.'",
    "tasks": (
        "ps aux | grep -E 'claude|codex|agent|pe-bridge' | grep -v grep || echo 'No agent processes running'"
    ),
}


def _run_command(client, body):
    command = (body.get("command") or "").strip().lower()
    if command not in _RUN_COMMANDS:
        return respond(400, {"error": f"Unknown command: {command}. Available: {', '.join(sorted(_RUN_COMMANDS))}"})

    cmd = _RUN_COMMANDS[command]
    stdout, stderr, exit_code = ssh_exec(client, cmd, timeout=15)
    output = stdout.strip()
    if not output and stderr.strip():
        output = stderr.strip()
    return respond(200, {"command": command, "output": output or "(no output)"})


# Docs tab on the workspace overview — surfaces the per-workspace
# README / ARCHITECTURE / docs/*.md so the customer can read the
# project's own documentation from the dashboard. Backed by SSH find
# + cat; no DB state.
#
# Hard-coded path: ~/projects. Every managed and BYOS workspace clones
# repos under that directory (see userdata.py + provision.py). We don't
# accept a user-supplied root because we don't want this to become a
# "read any file on the server" API by accident.
_DOCS_ROOT = "~/projects"
_DOCS_MAX_BYTES = 100 * 1024  # 100KB — large markdown files are usually
                              # autogenerated dumps; truncating is safer
                              # than streaming megabytes to the dashboard.
_DOCS_MAX_FILES = 200         # Cap for the listing — anything beyond is
                              # noise (node_modules, build artifacts, etc.)


def _list_docs(client):
    """Enumerate markdown files under ~/projects on the workspace.

    Excludes node_modules / .git / build dirs to keep the list focused on
    the actual project docs. Returns relative paths so the client can
    pass them straight back to read-doc."""
    # `find -maxdepth 6` covers typical repo layouts (repo/docs/topic/*.md)
    # without exploding into vendored deps. `-prune` is cheaper than `-not
    # -path` because the subtree is skipped instead of walked-then-filtered.
    cmd = (
        f"cd {_DOCS_ROOT} 2>/dev/null && "
        f"find . -maxdepth 6 \\( "
        f"  -name node_modules -o -name .git -o -name dist -o "
        f"  -name build -o -name .next -o -name target -o "
        f"  -name __pycache__ -o -name .venv -o -name venv -o "
        f"  -name .pocketeng-worktrees -o -name '*-worktrees' "
        f"\\) -prune -o "
        f"\\( -name '*.md' -o -name '*.MD' -o -name '*.markdown' \\) "
        f"-type f -print 2>/dev/null | sort | head -{_DOCS_MAX_FILES}"
    )
    stdout, _, exit_code = ssh_exec(client, cmd, timeout=15)
    if exit_code != 0 and not stdout.strip():
        # find non-zero with no output means ~/projects doesn't exist —
        # treat as "no docs", not an error, so a fresh BYOS connect
        # without a clone yet doesn't show a scary failure state.
        return respond(200, {"docs": []})

    docs = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line.startswith("./"):
            continue
        rel = line[2:]  # strip './' prefix
        if not rel:
            continue
        docs.append({
            "path": rel,
            "name": rel.split("/")[-1],
        })
    return respond(200, {"docs": docs})


# Architecture auto-detect — fast, free, agent-free heuristic scan over
# the workspace. Surfaces suggested components the user can accept,
# tweak, or reject in the Arch tab. Designed to make the dashboard
# "just know" what's in the workspace without making the user type.
#
# v1 is heuristic only:
#   - listening TCP ports + their process names (from `ss -tnlp`)
#   - docker-compose service blocks (service name + first published port)
#   - language stack signals (package.json deps, requirements.txt deps,
#     pyproject.toml deps) → infer model/vector-db/embedder/api components
#
# v2 (future) can layer an agent task on top — slower, costs $$, but
# would understand novel architectures. Same return shape so the
# frontend doesn't have to change when we upgrade.

# Common ML / data-pipeline signals. Order matters — the first match
# wins. Each entry is (regex against requirements line, suggested name,
# role label).
_PY_DEP_SIGNALS = [
    (re.compile(r'^(qdrant-client|qdrant)\b', re.I),     "Vector DB", "qdrant"),
    (re.compile(r'^pinecone(-client)?\b', re.I),         "Vector DB", "pinecone"),
    (re.compile(r'^weaviate-client\b', re.I),            "Vector DB", "weaviate"),
    (re.compile(r'^chromadb\b', re.I),                    "Vector DB", "chroma"),
    (re.compile(r'^pgvector\b', re.I),                    "Vector DB", "pgvector"),
    (re.compile(r'^(openai|tiktoken)\b', re.I),          "LLM client", "openai"),
    (re.compile(r'^anthropic\b', re.I),                   "LLM client", "anthropic"),
    (re.compile(r'^cohere\b', re.I),                      "LLM client", "cohere"),
    (re.compile(r'^sentence-transformers\b', re.I),       "Embedder", "sentence-transformers"),
    (re.compile(r'^transformers\b', re.I),                "Model", "transformers"),
    (re.compile(r'^torch\b', re.I),                       "Model", "pytorch"),
    (re.compile(r'^tensorflow\b', re.I),                  "Model", "tensorflow"),
    (re.compile(r'^langchain\b', re.I),                   "Orchestration", "langchain"),
    (re.compile(r'^llama[-_]?index\b', re.I),             "Orchestration", "llamaindex"),
    (re.compile(r'^fastapi\b', re.I),                     "API", "fastapi"),
    (re.compile(r'^flask\b', re.I),                       "API", "flask"),
    (re.compile(r'^django\b', re.I),                      "API", "django"),
    (re.compile(r'^celery\b', re.I),                      "Worker queue", "celery"),
    (re.compile(r'^redis\b', re.I),                       "Cache / queue", "redis"),
    (re.compile(r'^psycopg2?\b', re.I),                   "Database", "postgres"),
    (re.compile(r'^pymongo\b', re.I),                     "Database", "mongodb"),
    (re.compile(r'^boto3\b', re.I),                       "AWS SDK", "aws"),
]

# Same idea for Node — limited to ML/data-pipeline indicators we expect
# to see in real workspaces. Less common than Python in this domain.
_JS_DEP_SIGNALS = [
    (re.compile(r'^@qdrant/'),         "Vector DB", "qdrant"),
    (re.compile(r'^@pinecone-database/'), "Vector DB", "pinecone"),
    (re.compile(r'^openai$'),          "LLM client", "openai"),
    (re.compile(r'^@anthropic-ai/'),   "LLM client", "anthropic"),
    (re.compile(r'^langchain'),        "Orchestration", "langchain"),
    (re.compile(r'^express$'),         "API", "express"),
    (re.compile(r'^fastify$'),         "API", "fastify"),
    (re.compile(r'^next$'),            "Web app", "nextjs"),
]


def _detect_architecture(client):
    """SSH into the workspace and return a list of suggested components.

    Heuristic only — no agent calls. Cheap enough to run on every
    workspace card expand if we want, but the UI gates it behind an
    Auto-detect button to give the user agency over what gets persisted.

    Returns: {"suggestions": [{"name", "role", "port"?}, ...]}
    """
    suggestions = []
    seen = set()  # dedup by (name, role)

    def add(name, role, port=None):
        key = (name.lower(), role.lower() if role else "")
        if key in seen:
            return
        seen.add(key)
        item = {"name": name}
        if role:
            item["role"] = role
        if port:
            item["port"] = int(port)
        suggestions.append(item)

    # ── 1. Listening ports + process names ──
    # Same data source as discover-services but we map to component-shaped
    # output instead of preview URLs. ss is on every Amazon Linux 2023 host.
    try:
        out, _, _ = ssh_exec(
            client,
            "ss -tnlp 2>/dev/null | awk 'NR>1{print $4, $7}'",
            timeout=10,
        )
        for line in out.splitlines():
            parts = line.split(None, 1)
            if not parts:
                continue
            addr = parts[0]
            proc_field = parts[1] if len(parts) > 1 else ""
            if ":" not in addr:
                continue
            try:
                port = int(addr.rsplit(":", 1)[-1])
            except ValueError:
                continue
            if not (1024 <= port <= 65535):
                continue
            # users:(("uvicorn",pid=…)) → "uvicorn"
            m = re.search(r'\(\("([^"]+)"', proc_field)
            proc = m.group(1) if m else "service"
            # Skip system / agent infra ports.
            if proc in ("sshd", "cloudflared", "node"):
                # node is too generic; skip unless we can't otherwise
                # explain the port. We'll rely on package.json signals
                # to surface node-based components.
                continue
            add(f"{proc.title()} (:{port})", proc, port)
    except Exception:
        pass

    # ── 2. docker-compose services ──
    # Parse with awk — keep it dependency-free. We only care about
    # service NAMES and their first published port, not the full spec.
    try:
        out, _, _ = ssh_exec(
            client,
            "find ~/projects -maxdepth 4 \\( -name docker-compose.yml -o -name docker-compose.yaml -o -name compose.yml -o -name compose.yaml \\) -not -path '*/node_modules/*' 2>/dev/null | head -5",
            timeout=8,
        )
        compose_files = [f.strip() for f in out.splitlines() if f.strip()]
        for path in compose_files[:5]:
            try:
                content, _, _ = ssh_exec(client, f"head -c 16384 {shlex.quote(path)}", timeout=8)
                _parse_compose(content, add)
            except Exception:
                continue
    except Exception:
        pass

    # ── 3. Python deps ──
    try:
        out, _, _ = ssh_exec(
            client,
            "find ~/projects -maxdepth 4 \\( -name requirements.txt -o -name pyproject.toml -o -name Pipfile \\) -not -path '*/node_modules/*' -not -path '*/.venv/*' -not -path '*/venv/*' 2>/dev/null | head -5",
            timeout=8,
        )
        for path in [p.strip() for p in out.splitlines() if p.strip()][:5]:
            try:
                content, _, _ = ssh_exec(client, f"head -c 32768 {shlex.quote(path)}", timeout=8)
                for line in content.splitlines():
                    pkg = line.strip().lower()
                    # Strip version spec / quotes / comma so the regex sees the bare name.
                    pkg = re.split(r'[<>=!~,;\[\s]', pkg, maxsplit=1)[0].strip().strip('"').strip("'")
                    if not pkg or pkg.startswith("#"):
                        continue
                    for pattern, name, role in _PY_DEP_SIGNALS:
                        if pattern.match(pkg):
                            add(name, role)
                            break
            except Exception:
                continue
    except Exception:
        pass

    # ── 4. Node deps ──
    try:
        out, _, _ = ssh_exec(
            client,
            "find ~/projects -maxdepth 4 -name package.json -not -path '*/node_modules/*' 2>/dev/null | head -5",
            timeout=8,
        )
        for path in [p.strip() for p in out.splitlines() if p.strip()][:5]:
            try:
                content, _, _ = ssh_exec(client, f"head -c 32768 {shlex.quote(path)}", timeout=8)
                try:
                    parsed = json.loads(content)
                except Exception:
                    continue
                deps = {}
                for key in ("dependencies", "devDependencies", "peerDependencies"):
                    val = parsed.get(key) or {}
                    if isinstance(val, dict):
                        deps.update(val)
                for pkg_name in deps:
                    for pattern, name, role in _JS_DEP_SIGNALS:
                        if pattern.match(pkg_name):
                            add(name, role)
                            break
            except Exception:
                continue
    except Exception:
        pass

    return respond(200, {"suggestions": suggestions})


def _parse_compose(content, add):
    """Minimal docker-compose service extractor — no YAML lib needed.

    A real YAML parser would be overkill: we only need the top-level
    `services:` block's keys + the first published port from each. The
    rest of the spec (volumes, networks, healthchecks, etc.) is noise
    we'd ignore anyway. This walks line-by-line tracking indent depth
    to know when we've entered / left a service block.
    """
    in_services = False
    current_service = None
    current_indent = 0
    service_indent = None
    first_port_by_service = {}

    for raw_line in content.splitlines():
        stripped = raw_line.rstrip()
        if not stripped or stripped.lstrip().startswith("#"):
            continue
        indent = len(stripped) - len(stripped.lstrip(" "))
        text = stripped.lstrip()

        if not in_services:
            if text.rstrip(":").strip() == "services" and stripped.endswith(":"):
                in_services = True
                service_indent = None
            continue

        # A new top-level block ended the services section.
        if indent == 0 and stripped.endswith(":"):
            in_services = False
            continue

        if in_services:
            if service_indent is None:
                service_indent = indent
            if indent == service_indent and stripped.endswith(":"):
                current_service = text.rstrip(":").strip()
                current_indent = indent
                continue
            if current_service and indent > current_indent:
                # Look for "- 8080:80" or "- 8080" inside a `ports:` block.
                # No need to enforce we're inside `ports:` specifically;
                # the pattern is distinctive enough.
                m = re.match(r'-\s*["\']?(\d{2,5})(?::\d+)?["\']?\s*$', text)
                if m and current_service not in first_port_by_service:
                    try:
                        first_port_by_service[current_service] = int(m.group(1))
                    except ValueError:
                        pass

    for service, port in first_port_by_service.items():
        add(service.title(), "docker", port)


def _read_doc(client, body):
    """Read one markdown file under ~/projects on the workspace.

    Validates the relative path locally before SSH so we never let a
    leading slash or '..' segment turn this into an arbitrary-file-read
    primitive. Even with shlex.quote, the path resolves on the remote
    side and a clever symlink could escape — better to reject early."""
    raw = (body.get("path") or "").strip()
    if not raw:
        return respond(400, {"error": "path required"})
    # Reject anything that looks like an escape attempt before it reaches
    # the host. Allowed shape: forward-slash-separated, no segments equal
    # to '..', no leading slash, must end in .md / .markdown.
    if raw.startswith("/") or raw.startswith("~"):
        return respond(400, {"error": "path must be relative to ~/projects"})
    parts = [p for p in raw.split("/") if p]
    if any(p == ".." for p in parts):
        return respond(400, {"error": "path may not contain '..'"})
    lower = raw.lower()
    if not (lower.endswith(".md") or lower.endswith(".markdown")):
        return respond(400, {"error": "only .md / .markdown files are readable here"})

    # `head -c N+1` lets us detect oversize without slurping the whole
    # thing — if we get back more than _DOCS_MAX_BYTES we know the file
    # was truncated and can tell the user.
    cmd = (
        f"cd {_DOCS_ROOT} 2>/dev/null && "
        f"head -c {_DOCS_MAX_BYTES + 1} {shlex.quote(raw)} 2>/dev/null"
    )
    stdout, stderr, exit_code = ssh_exec(client, cmd, timeout=15)
    if exit_code != 0:
        return respond(404, {"error": f"could not read {raw} (exit {exit_code})"})

    truncated = len(stdout) > _DOCS_MAX_BYTES
    content = stdout[:_DOCS_MAX_BYTES]
    return respond(200, {
        "path": raw,
        "content": content,
        "truncated": truncated,
    })


def handler(event, context):
    try:
        # Auth
        try:
            claims = verify_token(extract_auth_header(event.get("headers", {})))
        except Exception as e:
            return respond(401, {"error": str(e)})

        user_id = claims["sub"]
        server_id = event.get("pathParameters", {}).get("serverId")
        if not server_id:
            return respond(400, {"error": "serverId required"})

        server = get_server(server_id)
        if not server:
            return respond(404, {"error": "Server not found"})
        if not can_access_owned_resource(user_id, server):
            return respond(403, {"error": "Not your server"})
        if server.get("instanceState") != "running":
            return respond(400, {"error": "Server is not running"})

        body = json.loads(event.get("body") or "{}")
        action = body.get("action")

        # Decrypt SSH key and connect
        public_ip = server.get("publicIp")
        if not public_ip or not server.get("sshPrivateKey"):
            return respond(400, {"error": "Server not ready (no IP or key)"})

        private_key_pem = decrypt(server["sshPrivateKey"])
        username = server.get("sshUser", "ec2-user")

        client = ssh_connect(public_ip, private_key_pem, username)
        try:
            # Ensure GitHub credentials on every SSH session
            _ensure_github_on_server(client, claims)

            if action == "install-agent":
                return _install_agent(client, body, server_id, user_id, server)
            elif action == "start-session":
                return _start_session(client, body, server_id, user_id, event=event)
            elif action == "send-message":
                return _send_message(client, body, server_id, user_id, event=event)
            elif action == "status-check":
                return _status_check(client, body, server_id)
            elif action == "cancel":
                return _cancel(client, body, server_id)
            elif action == "discover-services":
                return _discover_services(client, server)
            elif action == "preview-proxy":
                return _preview_proxy(client, body)
            elif action == "register-synced-session":
                return _register_synced_session(client, body, server_id, user_id)
            elif action == "run-command":
                return _run_command(client, body)
            elif action == "list-docs":
                return _list_docs(client)
            elif action == "read-doc":
                return _read_doc(client, body)
            elif action == "detect-architecture":
                return _detect_architecture(client)
            else:
                return respond(400, {"error": f"Unknown action: {action}"})
        finally:
            ssh_disconnect(client)

    except Exception as e:
        import traceback
        print(f"Chat error: {e}\n{traceback.format_exc()}")
        return respond(500, {"error": str(e)})


def _install_agent(client, body, server_id=None, user_id=None, server=None):
    agent = body.get("agent", "claude")
    cmd = get_agent_install_command(agent) if agent in VALID_AGENT_IDS else None
    if not cmd:
        return respond(400, {"error": f"Unknown agent: {agent}"})

    # Check if node/npm is available, install via nvm if not
    check = "command -v npm >/dev/null 2>&1 && echo OK || echo MISSING"
    stdout, _, _ = ssh_exec(client, check, timeout=10)
    if "MISSING" in stdout:
        # Install nvm + node
        install_node = (
            'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash && '
            'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && '
            'nvm install --lts'
        )
        ssh_exec(client, install_node, timeout=60)

    # Install the agent
    full_cmd = (
        'export NVM_DIR="$HOME/.nvm"; '
        '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; '
        f'{cmd} 2>&1'
    )
    stdout, stderr, exit_code = ssh_exec(client, full_cmd, timeout=120)

    # Verify the binary is on disk. Cursor's installer drops it at
    # ~/.local/bin/agent, and non-interactive SSH on Ubuntu BYOS doesn't
    # source ~/.bashrc, so ~/.local/bin isn't on PATH by default — `which
    # agent` would miss the file even though the install succeeded. Prepend
    # it inline so the verify mirrors what the install actually wrote.
    binary_name = "agent" if agent == "cursor" else agent
    verify_cmd = (
        'export PATH="$HOME/.local/bin:$PATH"; '
        f'which {binary_name} 2>/dev/null || echo NOT_FOUND'
    )
    verify_stdout, _, _ = ssh_exec(client, verify_cmd, timeout=10)

    if "NOT_FOUND" in verify_stdout:
        return respond(500, {"error": f"Installation failed: {stdout[-500:]}"})

    # Persist ~/.local/bin on PATH for future interactive SSH sessions, the
    # same way managed-instance userdata does (see lib/userdata.py
    # _cursor_install_block). Idempotent: only appends if the line is missing.
    ssh_exec(
        client,
        "grep -q '/.local/bin' ~/.bashrc 2>/dev/null || "
        'echo \'export PATH="$HOME/.local/bin:$PATH"\' >> ~/.bashrc',
        timeout=5,
    )

    # Update the server's agents array in DynamoDB so the UI reflects
    # the newly installed agent immediately. BYOS provision stores `None`
    # when no agents were auto-detected (provision.py), so guard against
    # `list(None)` — use `or []` rather than the dict.get default.
    updated_agents = list((server.get("agents") if server else None) or [])
    if agent not in updated_agents:
        updated_agents.append(agent)
    if server_id:
        try:
            update_server(server_id, {"agents": updated_agents})
        except Exception as exc:
            print(f"install-agent: failed to update server agents list: {exc}")

    # Push credentials for the newly installed agent so it's ready to use.
    cred_status = None
    if user_id:
        try:
            from src.lib.agent_credentials_sync import push_credentials_for_user
            cred_status = push_credentials_for_user(client, user_id, agents=[agent])
            if cred_status:
                print(f"install-agent: creds sync for {agent}: {cred_status}")
        except Exception as exc:
            print(f"install-agent: creds sync failed for {agent}: {exc}")

    return respond(200, {
        "status": "installed",
        "agent": agent,
        "agents": updated_agents,
        "credentialStatus": cred_status,
    })


def _register_synced_session(client, body, server_id, user_id):
    """
    Register or update a coding agent session that was synced from the user's
    laptop via `pocketeng sync`. The session .jsonl is already on the EC2
    (the daemon scp'd it). This action reads the file via SSH, parses it,
    and writes the session + message rows to DynamoDB so it appears in the
    Sessions tab on the iOS / web app and the user can tap to continue.

    Idempotent — safe to call repeatedly as the daemon ships new turns.
    Only inserts message rows for lines that haven't been recorded yet
    (tracked via `currentRunOffset` on the session).

    Body fields:
      remoteSessionId  Session UUID (the .jsonl filename, no extension).
                       Used as the --resume token by _launch_turn later.
      sessionFilePath  Absolute path to the .jsonl on the EC2.
                       Claude: /home/ec2-user/.claude/projects/<hash>/<sid>.jsonl
                       Cursor: /home/ec2-user/.cursor/projects/<hash>/agent-transcripts/<sid>/<sid>.jsonl
      worktreePath     The cloud-side project dir, e.g. ~/projects/foo
                       Used as the cwd when _launch_turn spawns the agent --resume.
      projectName      Optional human label for the workspace card subtitle.
      agent            Optional agent id ("claude", "cursor", etc.). Defaults to "claude".
    """
    remote_session_id = (body.get("remoteSessionId") or "").strip()
    session_file = (body.get("sessionFilePath") or "").strip()
    worktree_path = (body.get("worktreePath") or "").strip()
    project_name = (body.get("projectName") or "").strip()
    synced_agent = (body.get("agent") or "claude").strip()

    if not remote_session_id or not session_file or not worktree_path:
        return respond(400, {
            "error": "remoteSessionId, sessionFilePath, and worktreePath required",
        })

    # Sanity check the rsid is a uuid-shaped value to avoid SSH injection
    # via the path concat below. Same shape claude --session-id expects.
    if not re.fullmatch(r"[0-9a-f-]{20,40}", remote_session_id):
        return respond(400, {"error": "remoteSessionId must be a UUID"})

    # Read just the metadata we need from the .jsonl via SSH. We do NOT
    # bulk-insert every line into DynamoDB — large sessions (10MB+, 5000+
    # lines) would time out the API Gateway 30s limit. Instead we register
    # the session metadata here and let the phone/web app materialize the
    # transcript on demand by SSH-reading the file when the user opens it.
    #
    # SSH-read the line count plus head/tail of the file, then parse locally
    # using session_file_parser (works for both Claude and Cursor formats).
    extract_cmd = (
        f"wc -l < {shlex.quote(session_file)} 2>/dev/null; "
        f"echo '---SEP---'; "
        f"head -200 {shlex.quote(session_file)} 2>/dev/null; "
        f"echo '---SEP---'; "
        f"tail -500 {shlex.quote(session_file)} 2>/dev/null"
    )
    meta_stdout, _, meta_exit = ssh_exec(client, extract_cmd, timeout=10)
    if meta_exit != 0 or not meta_stdout:
        return respond(404, {"error": f"session file not found or unreadable: {session_file}"})

    parts = (meta_stdout or "").split("---SEP---")
    line_count = int((parts[0] or "0").strip() or "0")

    head_lines = [l.strip() for l in (parts[1] if len(parts) > 1 else "").split("\n") if l.strip()]
    tail_lines = [l.strip() for l in (parts[2] if len(parts) > 2 else "").split("\n") if l.strip()]

    first_user_msg = None
    last_user_msg = None
    if head_lines:
        head_user_msgs = extract_user_messages(head_lines)
        if head_user_msgs:
            first_user_msg = head_user_msgs[0][:500]
    if tail_lines:
        tail_user_msgs = extract_user_messages(tail_lines)
        if tail_user_msgs:
            last_user_msg = tail_user_msgs[-1][:500]
    if last_user_msg is None:
        last_user_msg = first_user_msg

    if line_count == 0:
        return respond(404, {"error": f"session file empty: {session_file}"})

    # Resolve the worktree path to an absolute one (in case the CLI passed ~)
    resolve_stdout, _, _ = ssh_exec(
        client,
        f"cd {shlex.quote(worktree_path)} 2>/dev/null && pwd",
        timeout=5,
    )
    resolved_worktree = (resolve_stdout or "").strip() or worktree_path

    # Use a deterministic sessionId so re-syncs are idempotent. 32-char hex
    # to match the existing _normalize_session_id format.
    session_id = "synced" + remote_session_id.replace("-", "")[:26]
    title = first_user_msg or project_name or "Synced session"

    now = _now_iso()
    existing = get_session(session_id)

    # If no "synced..." row exists yet for this rsid, check whether a
    # session on this server is already tracking the same `remoteSessionId`.
    # This closes the Codex duplicate-session bug in two scenarios:
    #
    # 1. Cloud-launched session: `_launch_turn` generates a ghost UUID
    #    and writes it to DDB, but the Codex SDK owns the actual rollout
    #    filename. The bridge's `session.remote` event reconciles
    #    `remoteSessionId` to the true thread id before the sync daemon
    #    pulls the .jsonl back.
    #
    # 2. Previously-synced session touched from the UI: the user clicks
    #    a `synced...` row and sends a follow-up. Codex's SDK generates
    #    a fresh thread id for every `startThread`, producing a new
    #    rollout .jsonl on EC2. The bridge's `session.remote` updates
    #    the row's `remoteSessionId` to that new id; when the sync
    #    daemon pulls the new file, we match against this row and merge
    #    in rather than creating a parallel `synced...` row for the same
    #    logical conversation.
    #
    # `userId` is the trust boundary — never merge across users even on
    # the same server (rsid collisions should be astronomically rare but
    # this keeps us safe).
    if not existing:
        try:
            server_sessions = get_all_sessions_by_server(server_id) or []
        except Exception as exc:
            print(f"register-synced-session: lookup by server failed: {exc}")
            server_sessions = []
        for candidate in server_sessions:
            if (
                candidate.get("remoteSessionId") == remote_session_id
                and candidate.get("userId") == user_id
            ):
                session_id = candidate["sessionId"]
                existing = candidate
                break

    # Two write paths compete for the messages table once a session has
    # been touched from the cloud UI:
    #
    #   • Cloud-launch path (`_launch_turn` + `sync_session_output`) writes
    #     bridge-normalized events at seqs driven by `currentRunSeqBase`
    #     + `currentRunOffset` (a monotonically-advancing counter).
    #
    #   • Sync-daemon re-register (`_insert_tail_messages`) re-parses the
    #     rollout .jsonl and writes messages at `tail_start + parsed_seq`,
    #     where `parsed_seq` is a parsed-message ordinal (0,1,2…) relative
    #     to the file, NOT the file's line index.
    #
    # The two offset spaces only line up by accident (they happen to for
    # Claude because its rollout line-count ≈ parsed-msg-count). For
    # Codex and Cursor the rollout contains many skipped-type lines, so
    # the two tracks diverge: each turn ends up persisted twice at
    # different seqs, and the transcript materializer renders both copies
    # — duplicate bubbles on Codex, doubled assistant text inside a
    # single bubble on Cursor.
    #
    # Avoid the race by making the cloud-launch path authoritative once
    # it has started writing. Detect "this session has been cloud-
    # launched at least once" via `currentRunSeqBase > 0` (first launch
    # sets it to user_seq+1 ≥ 1). For those sessions the sync daemon's
    # job reduces to keeping the rollout file on disk fresh and updating
    # lightweight metadata so later `_launch_turn` calls can find the
    # file; transcript content is owned by the launch path.
    was_cloud_launched = int(existing.get("currentRunSeqBase", 0) or 0) > 0 if existing else False

    if existing:
        updates = {
            "updatedAt": now,
            "lastPrompt": (last_user_msg or existing.get("lastPrompt", title))[:500],
            "sessionFilePath": session_file,
        }
        # Only overwrite `status` when we're updating a row that was
        # originally registered via sync. When the rsid-match falls
        # through and we merge into a cloud-launched session (which
        # already completed its turn and has status="done"), we must
        # not regress it to "from-laptop" — the UI treats status as
        # the agent's run state and rewriting it after completion
        # would make a settled conversation look like it's waiting
        # for laptop-side activity.
        if existing.get("syncedFromLaptop"):
            updates["status"] = "from-laptop"

        # Skip the tail re-parse once the cloud launch has written any
        # turn — its bridge-format rows are already the source of truth
        # for the transcript. Re-parsing the rollout would layer parsed
        # rows at colliding-but-not-identical seqs (the bug described
        # above). `currentRunOffset` / `nextSeq` are ALSO owned by the
        # bridge in that case; leaving them alone.
        #
        # For pure-laptop sessions (never touched from the UI) we still
        # re-hydrate on every sync pull so new local turns keep showing
        # up on the phone/web before the user opens the session.
        # Idempotent on (sessionId, seq) — ~100 writes ≈ 1 s.
        if not was_cloud_launched:
            next_seq_after_inserts = _insert_tail_messages(
                client, session_id, session_file, line_count, now
            )
            # Advance `nextSeq` past both the rollout's raw line_count
            # AND the last-inserted message seq. This closes a Cursor-
            # specific footgun: Cursor's rollouts often don't end with a
            # trailing newline, so `wc -l` reports N-1 while the parser
            # yields N messages. If we used line_count alone, the next
            # UI follow-up would write the user's prompt at seq = N-1 —
            # clobbering the last local assistant reply.
            next_seq = max(line_count, next_seq_after_inserts)
            updates["currentRunOffset"] = next_seq
            updates["nextSeq"] = next_seq

        try:
            update_session(session_id, updates)
        except Exception as exc:
            print(f"register-synced-session: update failed for {session_id}: {exc}")

        return respond(200, {
            "sessionId": session_id,
            "lineCount": line_count,
            "status": "updated",
        })

    # Create path: insert just the session row. No message rows — the chat
    # view will SSH-read the .jsonl when the user taps the session.
    server_for_owner = get_server(server_id) or {}
    item = {
        "sessionId": session_id,
        "serverId": server_id,
        "createdAt": now,
        "updatedAt": now,
        "status": "from-laptop",
        "prompt": title[:500],
        "lastPrompt": (last_user_msg or title)[:500],
        "agent": synced_agent,
        "nextSeq": line_count,
        "currentRunSeqBase": 0,
        "currentRunOffset": line_count,
        "remoteSessionId": remote_session_id,
        "worktreePath": resolved_worktree,
        "syncedFromLaptop": True,
        "sessionFilePath": session_file,
        **owner_fields_for_request(
            user_id=user_id,
            owner_type=server_for_owner.get("ownerType", "personal"),
            team_id=server_for_owner.get("teamId"),
        ),
    }
    if project_name:
        item["syncedProjectName"] = project_name

    try:
        put_session(item)
    except Exception as exc:
        return respond(500, {"error": f"failed to put_session: {exc}"})

    # Insert the LAST 100 lines of the .jsonl so the chat view has content.
    # User-type events get stored as role="user" with plain text content so
    # the transcript materializer renders them as user bubbles. Everything
    # else (assistant, tool_use, tool_result, system, result) stays role="agent"
    # with the raw NDJSON line.
    next_seq_after_inserts = _insert_tail_messages(
        client, session_id, session_file, line_count, now
    )
    # Advance nextSeq past both the rollout's raw line_count AND the
    # last-inserted message seq. See the update branch for the Cursor
    # off-by-one rationale — a rollout with no trailing newline on its
    # final line reports wc -l = N-1 while the parser yields N msgs;
    # leaving nextSeq at N-1 would let the first UI follow-up clobber
    # the last local assistant reply.
    corrected_next_seq = max(line_count, next_seq_after_inserts)
    if corrected_next_seq != line_count:
        try:
            update_session(session_id, {
                "nextSeq": corrected_next_seq,
                "currentRunOffset": corrected_next_seq,
            })
        except Exception as exc:
            print(f"register-synced-session: nextSeq correction failed for {session_id}: {exc}")

    return respond(200, {
        "sessionId": session_id,
        "lineCount": line_count,
        "status": "created",
    })


def _insert_tail_messages(client, session_id, session_file, line_count, now):
    """SSH-read the last 100 lines of a synced .jsonl and insert them into
    the messages table using session_file_parser for correct role detection.
    Handles both Claude Code and Cursor session formats.

    Returns the first seq value that is SAFE for the next writer to use
    (i.e. one past the highest seq inserted). Callers use this to
    advance the session's `nextSeq` so a subsequent UI follow-up does
    NOT clobber the last local assistant row — which is the failure
    mode when `wc -l < msg_count` (Cursor's last rollout line typically
    has no trailing newline, so line_count == msg_count - 1).

    Returns 0 when nothing was inserted; the caller should then fall
    back to `line_count` (an acceptable approximation for large files
    where we only tailed a slice).
    """
    try:
        tail_cmd = f"tail -100 {shlex.quote(session_file)} 2>/dev/null"
        tail_stdout, _, _ = ssh_exec(client, tail_cmd, timeout=10)
        tail_lines = [
            l.strip() for l in (tail_stdout or "").split("\n") if l.strip()
        ]
        if not tail_lines:
            return 0

        messages = parse_session_file(tail_lines, session_id)
        tail_start = max(line_count - len(tail_lines), 0)
        inserted = 0
        max_seq = -1
        for msg in messages:
            try:
                seq = tail_start + msg["seq"]
                put_message(
                    session_id,
                    seq,
                    msg["role"],
                    msg["content"],
                    now,
                )
                if seq > max_seq:
                    max_seq = seq
                inserted += 1
            except Exception:
                pass

        if inserted > 0:
            print(f"register-synced-session: inserted {inserted} messages for {session_id}")
        return max_seq + 1 if max_seq >= 0 else 0
    except Exception as exc:
        print(f"register-synced-session: tail insert failed: {exc}")
        return 0


def _extract_first_user_message(raw_lines):
    """Pull the first human user message text out of a Claude Code .jsonl.
    Skips tool_result events (which are user-role but tool feedback)."""
    for raw in raw_lines:
        try:
            parsed = json.loads(raw)
        except Exception:
            continue
        if not isinstance(parsed, dict) or parsed.get("type") != "user":
            continue
        msg = parsed.get("message")
        if not isinstance(msg, dict):
            continue
        content = msg.get("content")
        if isinstance(content, str) and content.strip():
            return content.strip()
        if isinstance(content, list):
            text_parts = []
            for block in content:
                if not isinstance(block, dict):
                    continue
                # Skip tool results — they're not real user messages
                if block.get("type") == "tool_result":
                    return None  # this is a tool result; the actual first user msg came earlier
                if block.get("type") == "text":
                    txt = block.get("text")
                    if isinstance(txt, str):
                        text_parts.append(txt)
            if text_parts:
                return "".join(text_parts).strip()
    return None


def _extract_last_user_message(raw_lines):
    """Last human user message — used as the lastPrompt label."""
    last = None
    for raw in raw_lines:
        try:
            parsed = json.loads(raw)
        except Exception:
            continue
        if not isinstance(parsed, dict) or parsed.get("type") != "user":
            continue
        msg = parsed.get("message")
        if not isinstance(msg, dict):
            continue
        content = msg.get("content")
        text = None
        if isinstance(content, str) and content.strip():
            text = content.strip()
        elif isinstance(content, list):
            parts = []
            saw_tool_result = False
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_result":
                    saw_tool_result = True
                    break
                if block.get("type") == "text":
                    txt = block.get("text")
                    if isinstance(txt, str):
                        parts.append(txt)
            if not saw_tool_result and parts:
                text = "".join(parts).strip()
        if text:
            last = text
    return last


def _start_session(client, body, server_id, user_id, event=None):
    return _launch_turn(client, body, server_id, user_id, event=event)


def _send_message(client, body, server_id, user_id, event=None):
    return _launch_turn(client, body, server_id, user_id, event=event)


def _status_check(client, body, server_id=None):
    """Check if a remote agent process is still running."""
    pid = body.get("pid", "")
    session_id = body.get("sessionId", "")
    session = get_session(session_id) if session_id else None

    if session and server_id and session.get("serverId") != server_id:
        return respond(400, {"error": "Session belongs to a different server"})

    # If no PID, try reading from the PID file
    if not pid and session_id:
        pid_cmd = f"cat /tmp/pe-pid-{shlex.quote(session_id)} 2>/dev/null || echo ''"
        stdout, _, _ = ssh_exec(client, pid_cmd, timeout=5)
        pid = stdout.strip()

    if not pid:
        if session_id:
            try:
                _complete_session_and_notify(session_id)
            except Exception:
                pass
        return respond(200, {"status": "DONE"})

    cmd = f"kill -0 {shlex.quote(str(pid))} 2>/dev/null && echo RUNNING || echo DONE"
    stdout, _, _ = ssh_exec(client, cmd, timeout=5)
    status = "RUNNING" if "RUNNING" in stdout else "DONE"
    if status == "DONE" and session_id:
        try:
            sync_session_output(
                client,
                session_id,
                offset=int((session or {}).get("currentRunOffset", 0) or 0),
                pid=pid,
                server_id=server_id,
                notify_on_done=True,
            )
        except Exception:
            pass
    return respond(200, {"status": status})


def _cancel(client, body, server_id=None):
    """Cancel a remote agent process."""
    pid = body.get("pid", "")
    session_id = body.get("sessionId", "")
    session = get_session(session_id) if session_id else None

    if session and server_id and session.get("serverId") != server_id:
        return respond(400, {"error": "Session belongs to a different server"})

    if not pid and session_id:
        pid_cmd = f"cat /tmp/pe-pid-{shlex.quote(session_id)} 2>/dev/null || echo ''"
        stdout, _, _ = ssh_exec(client, pid_cmd, timeout=5)
        pid = stdout.strip()

    if not pid:
        if session_id:
            try:
                update_session(session_id, {"status": "done", "updatedAt": _now_iso()})
            except Exception:
                pass
        return respond(200, {"status": "not-found"})

    cleanup = ""
    if session_id:
        cleanup = f"rm -f /tmp/pe-pid-{shlex.quote(session_id)} 2>/dev/null; "

    cmd = (
        f"PID={shlex.quote(str(pid))}; "
        # Kill the child process first (claude), then the wrapper script.
        f"[ -n \"$PID\" ] && pkill -P $PID 2>/dev/null; "
        f"[ -n \"$PID\" ] && kill $PID 2>/dev/null; "
        f"{cleanup}"
        f"echo OK"
    )
    ssh_exec(client, cmd, timeout=10)
    if session_id:
        try:
            update_session(session_id, {"status": "done", "updatedAt": _now_iso()})
        except Exception:
            pass
    return respond(200, {"status": "ok"})


def _discover_services(client, server):
    """Discover listening TCP services on the instance and expose each
    one through the workspace's Cloudflare Tunnel (managed workspaces
    only; BYOS keeps the legacy direct-IP URL + proxy path).

    The return shape is unchanged from the caller's perspective —
    `{port, process, url}` — but for managed workspaces `url` is now a
    Cloudflare hostname (`https://{serverId}-{port}.{domain}`) instead
    of `http://{publicIp}:{port}`. The preview-panel UI consumes this
    field directly.

    Lazy-create: managed workspaces provisioned BEFORE this migration
    don't have a tunnelId yet. The first time the preview panel opens,
    we create a tunnel, install cloudflared on the box via SSH, start
    it, and persist the tunnelId. All best-effort — if any Cloudflare
    step fails we fall back to the legacy IP-port URL so the user
    still gets something they can click.
    """
    # Cross-platform: ss on Linux, lsof on macOS
    cmd = (
        "command -v ss >/dev/null 2>&1 "
        "&& ss -tlnp 2>/dev/null | grep LISTEN "
        "|| lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null | tail -n +2"
    )
    stdout, _, _ = ssh_exec(client, cmd, timeout=10)

    public_ip = server.get("publicIp", "")
    is_byos = server.get("envType") == "byos"
    server_id = server.get("serverId")

    # Pull (and lazy-provision if needed) the tunnel id for managed
    # workspaces. The helper returns None for BYOS or when Cloudflare
    # is not configured; callers treat that as "use legacy fallback".
    tunnel_id = _ensure_tunnel_for_server(client, server) if not is_byos else None

    services = []
    seen_ports = set()

    for line in stdout.strip().split("\n"):
        if not line.strip():
            continue

        port = None
        process = None

        # ss format: LISTEN  0  128  0.0.0.0:3000  0.0.0.0:*  users:(("node",pid=1234,fd=3))
        ss_match = re.search(r":(\d+)\s", line)
        if ss_match:
            port = int(ss_match.group(1))
        # Extract process name from ss users:(("name",...))
        proc_match = re.search(r'users:\(\("([^"]+)"', line)
        if proc_match:
            process = proc_match.group(1)

        # lsof format: node  1234  user  12u  IPv4  ...  TCP *:3000 (LISTEN)
        if not port:
            lsof_match = re.search(r"[*:](\d+)\s+\(LISTEN\)", line)
            if lsof_match:
                port = int(lsof_match.group(1))
            # Process name is first column in lsof
            parts = line.split()
            if parts:
                process = parts[0]

        if not port or port in seen_ports:
            continue
        # Filter to dev server ports only
        if port < 3000 or port > 9000:
            continue
        # Hide the preview dispatcher from the UI. It listens on
        # 127.0.0.1:8844 purely as an internal CF-Tunnel origin, and
        # clicking a "preview" link for it just proxies to itself —
        # not useful, and confusingly shows up as "unknown" process.
        # Kept as a constant so it stays in sync with
        # `lib/cloudflare.DISPATCHER_PORT`.
        if port == cloudflare.DISPATCHER_PORT:
            continue

        seen_ports.add(port)
        url = _preview_url_for_port(server_id, port, tunnel_id, is_byos, public_ip)
        services.append({
            "port": port,
            "process": process or "unknown",
            "url": url,
        })

    # Cache in DynamoDB
    try:
        update_server(server["serverId"], {"services": services})
    except Exception:
        pass

    return respond(200, {"services": services})


def _preview_url_for_port(server_id, port, tunnel_id, is_byos, public_ip):
    """Pick the URL surfaced in the `services` response for one port.

    Priority:
      1. Managed workspace with a Cloudflare tunnel → Worker URL.
         No per-click Cloudflare API calls: the workspace CNAME +
         single tunnel ingress rule are set up once at provision
         (or lazily by `_ensure_tunnel_for_server` for pre-migration
         workspaces). The Worker adds the X-Preview-Port header; the
         local dispatcher on the box routes to the right port.
      2. Managed workspace without a tunnel (CF outage or
         mis-configured env) → fall back to direct IP:port. The web
         proxy route handles those via its SSH tunnel fallback.
      3. BYOS → always direct IP:port (BYOS servers stay on the
         legacy proxy path; their SG + deploy lifecycle isn't owned
         by us).
    """
    legacy = f"http://{public_ip}:{int(port)}" if public_ip else ""
    if is_byos or not tunnel_id:
        return legacy
    try:
        return cloudflare.preview_url_for_port(server_id, int(port))
    except cloudflare.CloudflareError as exc:
        print(f"_discover_services: preview URL build failed for {server_id}:{port}: {exc}")
        return legacy


def _ensure_tunnel_for_server(client, server):
    """Return a tunnel id for a managed workspace, creating one on the
    fly for pre-migration workspaces that don't have one yet AND
    wiring up the CNAME + ingress + KV entry + local dispatcher so
    the Worker can route through it.

    Returns None if:
      - Cloudflare isn't configured (e.g. regional dev stack), OR
      - the tunnel create / cloudflared install failed.

    Caller treats None as "use legacy proxy fallback".

    Cost shape (important for preview-panel latency):
      - If `server["previewHealed"]` is truthy, the function returns
        the tunnel id immediately without touching Cloudflare or SSH.
        This is the overwhelmingly common case — every preview-panel
        refresh after the first successful open.
      - If the flag is missing/false, we run the full heal: kv_put,
        CNAME upsert, ingress upsert, and dispatcher install over
        SSH. All idempotent. If EVERY step succeeds we set the flag,
        so the next call takes the fast path. If any step fails (CF
        5xx, SSH blip), we leave the flag alone and next call re-
        tries the whole thing — self-healing without permanent damage.
      - Fresh (no existing tunnel): we create, wire, install, and set
        the flag on success.

    Before this flag existed, every discover-services call fired ~5
    outbound CF API calls + one SSH round-trip per preview-panel
    open — a multi-second penalty paid by every user, every click,
    for a state that almost never changed. (Greptile P2 on #127.)
    """
    server_id = server.get("serverId")
    existing = server.get("tunnelId")
    if not cloudflare.is_configured():
        return existing or None
    if existing:
        # Fast path. Preview has already been verified end-to-end for
        # this workspace; short-circuit to avoid the API + SSH thrash.
        if server.get("previewHealed"):
            return existing
        # Slow / heal path. Run every step, track success per-step,
        # only flip the flag if ALL four succeed this time. Each step
        # is idempotent so re-running them on a healthy box is cheap
        # but not free — hence the flag.
        all_ok = True
        try:
            cloudflare.kv_put(server_id, existing)
        except cloudflare.CloudflareError as exc:
            all_ok = False
            print(
                f"_discover_services: kv_put retry failed for "
                f"{server_id} → {existing}: {exc}"
            )
        try:
            hostname = cloudflare.workspace_hostname(server_id)
            cloudflare.upsert_dns_cname(hostname, existing)
            cloudflare.ensure_workspace_ingress(existing, server_id)
        except cloudflare.CloudflareError as exc:
            all_ok = False
            print(
                f"_discover_services: CNAME/ingress retry failed for "
                f"{server_id} (tunnel {existing}): {exc}"
            )
        # Dispatcher install returns False on SSH failure / non-zero
        # exit. We keep going either way (never fail the user's
        # preview click on a heal step), but if this step stumbled
        # we don't want to set previewHealed — let the next call
        # retry.
        if not _install_preview_dispatcher_via_ssh(client):
            all_ok = False

        if all_ok:
            try:
                update_server(server_id, {"previewHealed": True})
            except Exception as exc:
                # Non-fatal: heal succeeded, we just didn't get to
                # remember. Next call will redo the 5 idempotent
                # ops — annoying but not broken.
                print(
                    f"_discover_services: failed to persist "
                    f"previewHealed for {server_id}: {exc}"
                )
        return existing

    # Fresh tunnel path — same shape as the heal path, but we also
    # create the tunnel + install cloudflared, and we persist tunnelId
    # regardless of which later step fails (so a partial provision can
    # be resumed without leaking tunnels).
    try:
        tunnel = cloudflare.create_tunnel(f"pe-{server_id}")
        tunnel_id = tunnel.get("id")
        tunnel_token = tunnel.get("token") or cloudflare.get_tunnel_token(tunnel_id)
    except cloudflare.CloudflareError as exc:
        print(f"_discover_services: lazy tunnel create failed for {server_id}: {exc}")
        return None

    all_ok = True

    if not _install_cloudflared_via_ssh(client, tunnel_token):
        all_ok = False
        # Tunnel is created but nothing on the box runs it yet. We
        # still persist the tunnel id — a later retry can reuse the
        # same tunnel instead of leaking another one on each click.
        print(f"_discover_services: cloudflared install failed for {server_id}; tunnel {tunnel_id} will stay idle")

    # Dispatcher install is independent of cloudflared install —
    # keep going even if the above warned, because the dispatcher is
    # what actually serves HTTP once cloudflared comes up.
    if not _install_preview_dispatcher_via_ssh(client):
        all_ok = False

    try:
        hostname = cloudflare.workspace_hostname(server_id)
        cloudflare.upsert_dns_cname(hostname, tunnel_id)
        cloudflare.ensure_workspace_ingress(tunnel_id, server_id)
    except cloudflare.CloudflareError as exc:
        all_ok = False
        # The tunnel exists + runs, but there's no public hostname
        # pointing at it yet. Preview clicks will hit a 1016 from
        # Cloudflare until the next discover-services call retries
        # via the `existing` branch above.
        print(
            f"_discover_services: CNAME/ingress setup failed for "
            f"{server_id} → {tunnel_id}: {exc}"
        )

    try:
        cloudflare.kv_put(server_id, tunnel_id)
    except cloudflare.CloudflareError as exc:
        all_ok = False
        # Tunnel + CNAME are fine, but the Worker's liveness check
        # will fall through to "workspace not found". Next
        # discover-services retries via `existing` branch above.
        print(
            f"_discover_services: kv_put failed for {server_id} → "
            f"{tunnel_id}: {exc}"
        )

    # Persist tunnelId (always) + previewHealed (only if every step
    # went green this call). Split into two writes so a partial
    # success still remembers the tunnel — we don't want to leak a
    # new tunnel on the next call just because e.g. kv_put had a
    # transient 5xx.
    updates = {"tunnelId": tunnel_id}
    if all_ok:
        updates["previewHealed"] = True
    try:
        update_server(server_id, updates)
    except Exception as exc:
        print(f"_discover_services: failed to persist tunnelId for {server_id}: {exc}")
    return tunnel_id


# Embedded once so every lazy-upgrade call ships the same script as
# the userdata path. We read the file at import time (same trick
# userdata.py uses) and heredoc it over SSH so the box ends up with
# the exact same `/opt/pe-preview-dispatcher/preview-dispatcher.cjs`
# as a fresh provision would have placed there.
_DISPATCHER_SCRIPT_PATH = os.path.join(
    os.path.dirname(__file__), "lib", "preview-dispatcher.cjs"
)
with open(_DISPATCHER_SCRIPT_PATH, encoding="utf-8") as _f:
    _DISPATCHER_SCRIPT = _f.read()


def _install_preview_dispatcher_via_ssh(client):
    """Install the preview-port dispatcher + its systemd unit on an
    already-provisioned EC2 host. Lazy-upgrade path for workspaces
    provisioned before the Option-B migration — pre-migration boxes
    don't have it, and hitting the tunnel with no dispatcher returns
    a 522 from cloudflared because nothing's listening on 127.0.0.1:8844.

    Idempotent: overwrites the script + unit each time and restarts
    the service. Safe to run on boxes that already have it up.
    Returns True on success.
    """
    # We pipe the script over SSH through stdin rather than embedding
    # it in the command string — embedding means escaping JS template
    # literals through shell AND SSH, which is a landmine. `tee` on
    # the other side just writes bytes, no quoting concerns.
    unit = (
        "[Unit]\n"
        "Description=PocketEngineer preview-port dispatcher\n"
        "After=network-online.target\n"
        "Wants=network-online.target\n\n"
        "[Service]\n"
        "Type=simple\n"
        "ExecStart=/usr/bin/env node /opt/pe-preview-dispatcher/preview-dispatcher.cjs\n"
        "Restart=on-failure\n"
        "RestartSec=2\n"
        "ProtectSystem=strict\n"
        "ProtectHome=true\n"
        "NoNewPrivileges=true\n"
        "PrivateTmp=true\n\n"
        "[Install]\n"
        "WantedBy=multi-user.target\n"
    )
    payload = (
        "sudo mkdir -p /opt/pe-preview-dispatcher && "
        "sudo tee /opt/pe-preview-dispatcher/preview-dispatcher.cjs > /dev/null <<'PE_PREVIEW_DISPATCHER_EOF'\n"
        f"{_DISPATCHER_SCRIPT}"
        "\nPE_PREVIEW_DISPATCHER_EOF\n"
        "sudo tee /etc/systemd/system/pe-preview-dispatcher.service > /dev/null <<'PE_PREVIEW_DISPATCHER_UNIT_EOF'\n"
        f"{unit}"
        "PE_PREVIEW_DISPATCHER_UNIT_EOF\n"
        "sudo systemctl daemon-reload && "
        "sudo systemctl enable pe-preview-dispatcher.service && "
        "sudo systemctl restart pe-preview-dispatcher.service"
    )
    try:
        _stdout, stderr, exit_code = ssh_exec(client, payload, timeout=60)
    except Exception as exc:
        print(f"_install_preview_dispatcher_via_ssh: ssh error: {exc}")
        return False
    if exit_code != 0:
        print(
            f"_install_preview_dispatcher_via_ssh: exit={exit_code} "
            f"stderr={stderr[:300]}"
        )
        return False
    return True


def _install_cloudflared_via_ssh(client, tunnel_token):
    """Install cloudflared + register the systemd service on an already-
    provisioned EC2 host. Mirrors the rpm-based block we bake into
    userdata.py for new workspaces; kept in sync so a freshly-
    provisioned AND a lazy-upgraded box end up in the same state.
    Returns True on success."""
    if not tunnel_token:
        return False
    safe = shlex.quote(tunnel_token)
    cmd = (
        "set -e; "
        "if ! command -v cloudflared >/dev/null 2>&1; then "
        "  curl -fsSL -o /tmp/cloudflared.rpm "
        "    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-x86_64.rpm; "
        "  sudo rpm -i --force /tmp/cloudflared.rpm || sudo dnf install -y /tmp/cloudflared.rpm; "
        "fi; "
        "sudo systemctl stop cloudflared 2>/dev/null || true; "
        "sudo cloudflared service uninstall 2>/dev/null || true; "
        f"sudo cloudflared service install {safe}; "
        "sudo systemctl enable --now cloudflared"
    )
    try:
        _stdout, stderr, exit_code = ssh_exec(client, cmd, timeout=120)
    except Exception as exc:
        print(f"_install_cloudflared_via_ssh: ssh error: {exc}")
        return False
    if exit_code != 0:
        print(f"_install_cloudflared_via_ssh: exit={exit_code} stderr={stderr[:300]}")
        return False
    return True


_HOP_BY_HOP_HEADERS = {
    "host", "cookie", "authorization",
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade",
    "content-length",  # curl sets this itself
}


def _preview_proxy(client, body):
    """Proxy an HTTP request to a local dev server via SSH tunnel.

    Request body fields:
      port (int)           — dev server port on the workspace (3000–9000)
      path (str)           — request path including query string
      method (str)         — HTTP method (default GET)
      headers (dict)       — request headers to forward (hop-by-hop stripped)
      bodyB64 (str, opt)   — base64-encoded request body
    """
    port = body.get("port")
    path = body.get("path", "/")
    method = body.get("method", "GET").upper()
    fwd_headers = body.get("headers") or {}
    body_b64 = body.get("bodyB64") or ""

    if not port or not isinstance(port, int) or port < 3000 or port > 9000:
        return respond(400, {"error": "Port must be between 3000 and 9000"})

    # Build curl: -s silent, -D - dump headers to stdout, --max-time covers total
    curl_parts = ["curl", "-s", "-D", "-", "-X", method, "--max-time", "25"]

    # Forward safe headers
    for key, value in fwd_headers.items():
        if not isinstance(key, str) or not isinstance(value, str):
            continue
        if key.lower() in _HOP_BY_HOP_HEADERS:
            continue
        curl_parts += ["-H", f"{key}: {value}"]

    # Pipe request body via stdin when present
    stdin_bytes = b""
    if body_b64:
        try:
            stdin_bytes = base64.b64decode(body_b64)
        except Exception:
            return respond(400, {"error": "Invalid bodyB64"})
        curl_parts += ["--data-binary", "@-"]

    url = f"http://localhost:{port}{path}"
    curl_parts.append(url)
    cmd = " ".join(shlex.quote(p) for p in curl_parts)

    stdout, stderr, exit_code = ssh_exec_bytes(client, cmd, stdin_bytes=stdin_bytes, timeout=30)

    if exit_code != 0:
        return respond(502, {"error": f"Could not reach dev server on port {port}"})

    # Parse curl -D - output as bytes: one or more header blocks, then body.
    # Some servers emit 100-continue or redirects, so skip header blocks
    # until we find one with a final status.
    remaining = stdout
    status_code = 200
    resp_headers: dict = {}

    while True:
        sep_idx = remaining.find(b"\r\n\r\n")
        sep_len = 4
        if sep_idx == -1:
            sep_idx = remaining.find(b"\n\n")
            sep_len = 2
        if sep_idx == -1:
            # No headers found at all — treat everything as body
            resp_body = remaining
            break

        header_block = remaining[:sep_idx]
        body_start = sep_idx + sep_len

        first_line_end = header_block.find(b"\n")
        first_line = header_block[:first_line_end if first_line_end != -1 else len(header_block)]
        status_match = re.search(rb"HTTP/\S+\s+(\d+)", first_line)
        status_code = int(status_match.group(1)) if status_match else 200

        # Skip informational/continue blocks; curl writes them before the real headers
        if 100 <= status_code < 200:
            remaining = remaining[body_start:]
            continue

        # Parse headers
        resp_headers = {}
        for line in header_block.split(b"\n")[1:]:
            if b":" not in line:
                continue
            k, v = line.split(b":", 1)
            resp_headers[k.strip().decode(errors="replace").lower()] = v.strip().decode(errors="replace")

        resp_body = remaining[body_start:]
        break

    content_type = resp_headers.get("content-type", "application/octet-stream")

    # Hand back the raw body bytes as base64 — the frontend always decodes it.
    # API Gateway will deliver this to the Next.js proxy route unchanged.
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": content_type,
            "Cache-Control": "no-store",
            "X-Frame-Options": "SAMEORIGIN",
        },
        "body": base64.b64encode(resp_body).decode("ascii"),
        "isBase64Encoded": True,
    }
