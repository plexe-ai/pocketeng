"""Convert raw .jsonl session files from any coding agent into the standard
intermediate message format used by the pocketeng messages table.

Supported agents
----------------
- **Claude Code** — ``~/.claude/projects/<hash>/<uuid>.jsonl``
  Top-level ``type`` field (user, assistant, queue-operation, …).
- **Cursor** — ``~/.cursor/projects/<hash>/agent-transcripts/<uuid>/<uuid>.jsonl``
  Top-level ``role`` field (user, assistant).  Text-only, no tool events.
- **Codex** — ``~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl``
  Every line: ``{timestamp, type, payload}``.  Types: session_meta,
  event_msg, response_item, turn_context.  User prompts are
  ``response_item`` with ``payload.role == "user"`` that are not
  system-injected context (developer messages, environment tags).

Standard intermediate format (per message)
------------------------------------------
::

    {
        "seq":       int,                  # sequential position
        "role":      "user" | "agent",     # user = human, agent = everything else
        "content":   str,                  # plain text (user) or raw NDJSON line (agent)
        "createdAt": str,                  # ISO-8601 timestamp or ""
        "sessionId": str,                  # session identifier
    }

This is exactly what ``put_message()`` writes to DynamoDB and what
``materialize_transcript()`` consumes to produce the frontend-facing
``ChatTranscriptMessage`` objects.
"""

from __future__ import annotations

import json
import re
from typing import Literal


# Cursor v2026.04 on-disk quirks (absent from --output-format stream-json stdout):
#   - User prompts are wrapped in  <user_query>\n ... \n</user_query>
#   - Assistant text ends with     \n\n[REDACTED]
# Both leak to the PocketEng UI through the local-to-UI sync path unless
# stripped during parsing.  Patterns kept defensive — apply only when the
# wrapper/trailer matches exactly.
_CURSOR_USER_QUERY_RE = re.compile(
    r"\A<user_query>\s*(?P<body>.*?)\s*</user_query>\Z",
    re.DOTALL,
)
_CURSOR_ASSISTANT_REDACTED_TRAILER = "\n\n[REDACTED]"


# ── Agent detection ──────────────────────────────────────────────────────────

AGENT_CLAUDE = "claude"
AGENT_CURSOR = "cursor"
AGENT_CODEX = "codex"

# Event types that only appear in Claude Code session files.
_CLAUDE_ONLY_TYPES = frozenset({
    "queue-operation", "file-history-snapshot", "progress", "last-prompt",
})

# Event types from the stdout NDJSON stream that Claude Code also writes to
# session files (they carry a top-level "type" field).
_CLAUDE_STREAM_TYPES = frozenset({
    "system", "user", "assistant", "message", "tool_use", "tool_result",
    "result", "content_block_delta", "text",
})


_CODEX_TYPES = frozenset({
    "session_meta", "event_msg", "response_item", "turn_context",
})


def detect_agent(lines: list[str]) -> str:
    """Determine which agent produced the session file by inspecting lines.

    Returns ``"claude"``, ``"cursor"``, or ``"codex"``.  Falls back to
    ``"claude"`` when ambiguous (the Claude parser is a safe superset).
    """
    for line in lines[:20]:
        try:
            obj = json.loads(line)
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(obj, dict):
            continue

        # Codex: every line has {timestamp, type, payload} with type in a fixed set
        if (obj.get("type") in _CODEX_TYPES
                and "payload" in obj
                and "timestamp" in obj):
            return AGENT_CODEX

        if obj.get("type") in _CLAUDE_ONLY_TYPES | _CLAUDE_STREAM_TYPES:
            return AGENT_CLAUDE

        if "role" in obj and "type" not in obj:
            return AGENT_CURSOR

    return AGENT_CLAUDE


# ── Public API ───────────────────────────────────────────────────────────────

def parse_session_file(
    lines: list[str],
    session_id: str,
    agent: str | None = None,
) -> list[dict]:
    """Convert raw .jsonl lines into the intermediate message list.

    Parameters
    ----------
    lines : list[str]
        Non-empty, stripped lines from the session .jsonl file.
    session_id : str
        Session identifier to attach to every message.
    agent : str, optional
        ``"claude"`` or ``"cursor"``.  Auto-detected when omitted.

    Returns
    -------
    list[dict]
        Messages in the standard intermediate format, ready for
        ``put_message()`` or ``materialize_transcript()``.
    """
    if agent is None:
        agent = detect_agent(lines)

    if agent == AGENT_CODEX:
        return _parse_codex_session(lines, session_id)
    if agent == AGENT_CURSOR:
        return _parse_cursor_session(lines, session_id)
    return _parse_claude_session(lines, session_id)


def extract_user_messages(lines: list[str], agent: str | None = None) -> list[str]:
    """Return plain-text content of every human user message in the file.

    Useful for extracting first/last prompt without building the full
    message list.  Skips tool-result feedback events.
    """
    if agent is None:
        agent = detect_agent(lines)

    if agent == AGENT_CODEX:
        return _extract_codex_user_messages(lines)
    if agent == AGENT_CURSOR:
        return _extract_cursor_user_messages(lines)
    return _extract_claude_user_messages(lines)


# ── Claude Code parser ───────────────────────────────────────────────────────

# Types that are session-file bookkeeping, not conversation content.
_CLAUDE_SKIP_TYPES = frozenset({
    "queue-operation", "file-history-snapshot", "progress", "last-prompt",
})


def _parse_claude_session(lines: list[str], session_id: str) -> list[dict]:
    messages: list[dict] = []
    seq = 0

    for line in lines:
        parsed = _safe_json(line)
        if parsed is None:
            continue

        event_type = parsed.get("type")
        if event_type in _CLAUDE_SKIP_TYPES:
            continue

        role: Literal["user", "agent"] = "agent"
        content: str = line
        timestamp: str = parsed.get("timestamp", "")

        if event_type == "user":
            user_text = _extract_claude_user_text(parsed)
            if user_text:
                role = "user"
                content = user_text

        messages.append({
            "seq": seq,
            "role": role,
            "content": content,
            "createdAt": timestamp,
            "sessionId": session_id,
        })
        seq += 1

    return messages


def _extract_claude_user_text(parsed: dict) -> str | None:
    """Extract plain human text from a Claude Code user event.

    Returns None when the event is tool-result feedback (not a human prompt).
    """
    msg = parsed.get("message")
    if not isinstance(msg, dict):
        return None

    c = msg.get("content")
    if isinstance(c, str) and c.strip():
        return c.strip()

    if isinstance(c, list):
        has_tool_result = any(
            isinstance(b, dict) and b.get("type") == "tool_result"
            for b in c
        )
        if has_tool_result:
            return None
        parts = [
            b.get("text", "")
            for b in c
            if isinstance(b, dict) and b.get("type") == "text"
        ]
        joined = "".join(parts).strip()
        return joined or None

    return None


def _extract_claude_user_messages(lines: list[str]) -> list[str]:
    results: list[str] = []
    for line in lines:
        parsed = _safe_json(line)
        if parsed is None or parsed.get("type") != "user":
            continue
        text = _extract_claude_user_text(parsed)
        if text:
            results.append(text)
    return results


# ── Cursor parser ────────────────────────────────────────────────────────────

def _parse_cursor_session(lines: list[str], session_id: str) -> list[dict]:
    messages: list[dict] = []
    seq = 0

    for line in lines:
        parsed = _safe_json(line)
        if parsed is None:
            continue

        top_role = parsed.get("role")
        if top_role not in ("user", "assistant"):
            continue

        timestamp = parsed.get("timestamp", "")

        if top_role == "user":
            user_text = _extract_cursor_user_text(parsed)
            if user_text:
                messages.append({
                    "seq": seq,
                    "role": "user",
                    "content": user_text,
                    "createdAt": timestamp,
                    "sessionId": session_id,
                })
                seq += 1
                continue

        # Cursor session files use {role: "assistant"} while
        # materialize_transcript's _parse_event expects {type: "assistant"}.
        # Normalize by injecting a "type" field so the downstream parser works.
        normalized = _normalize_cursor_agent_line(parsed)
        messages.append({
            "seq": seq,
            "role": "agent",
            "content": normalized,
            "createdAt": timestamp,
            "sessionId": session_id,
        })
        seq += 1

    return messages


def _normalize_cursor_agent_line(parsed: dict) -> str:
    """Add a ``type`` field derived from ``role`` so that
    ``_parse_event()`` in transcript.py can handle the line.

    Cursor session files: ``{role: "assistant", message: {content: [...]}}``
    Expected by parser:   ``{type: "assistant", message: {content: [...]}}``

    Also strips Cursor's on-disk ``\\n\\n[REDACTED]`` trailer from every
    text block so the UI doesn't render it verbatim.
    """
    working = {**parsed}
    if "type" not in working and "role" in working:
        working["type"] = working["role"]

    msg = working.get("message")
    if isinstance(msg, dict):
        content = msg.get("content")
        if isinstance(content, list):
            new_content = []
            for block in content:
                if (
                    isinstance(block, dict)
                    and block.get("type") == "text"
                    and isinstance(block.get("text"), str)
                ):
                    block = {**block, "text": _strip_cursor_assistant_trailer(block["text"])}
                new_content.append(block)
            working["message"] = {**msg, "content": new_content}

    return json.dumps(working, separators=(",", ":"))


def _strip_cursor_assistant_trailer(text: str) -> str:
    """Remove Cursor's ``\\n\\n[REDACTED]`` trailer, if present.

    Conservative: only strips the exact literal trailer.  Leaves any
    legitimate ``[REDACTED]`` tokens that appear mid-text untouched.
    """
    if text.endswith(_CURSOR_ASSISTANT_REDACTED_TRAILER):
        return text[: -len(_CURSOR_ASSISTANT_REDACTED_TRAILER)]
    return text


def _extract_cursor_user_text(parsed: dict) -> str | None:
    """Extract plain human text from a Cursor user event.

    Strips the Cursor ``<user_query>...</user_query>`` wrapper when the
    entire text block is wrapped (Cursor v2026.04 convention).
    """
    msg = parsed.get("message")
    if not isinstance(msg, dict):
        return None

    c = msg.get("content")
    if isinstance(c, str) and c.strip():
        return _unwrap_cursor_user_query(c.strip())

    if isinstance(c, list):
        has_tool_result = any(
            isinstance(b, dict) and b.get("type") == "tool_result"
            for b in c
        )
        if has_tool_result:
            return None
        parts = [
            b.get("text", "")
            for b in c
            if isinstance(b, dict) and b.get("type") == "text"
        ]
        joined = "".join(parts).strip()
        if not joined:
            return None
        return _unwrap_cursor_user_query(joined)

    return None


def _unwrap_cursor_user_query(text: str) -> str:
    """Strip Cursor's ``<user_query>\\n...\\n</user_query>`` wrapper.

    Only strips when the whole text is wrapped.  Plain prompts pass
    through unchanged, so this stays safe if Cursor changes the
    convention in a future release.
    """
    match = _CURSOR_USER_QUERY_RE.match(text)
    if match:
        return match.group("body")
    return text


def _extract_cursor_user_messages(lines: list[str]) -> list[str]:
    results: list[str] = []
    for line in lines:
        parsed = _safe_json(line)
        if parsed is None or parsed.get("role") != "user":
            continue
        text = _extract_cursor_user_text(parsed)
        if text:
            results.append(text)
    return results


# ── Codex parser ─────────────────────────────────────────────────────────────

# Codex event types that carry no conversational content.
_CODEX_SKIP_TYPES = frozenset({"session_meta", "turn_context"})

# event_msg sub-types that are not conversation content.
_CODEX_SKIP_EVENT_SUBTYPES = frozenset({
    "task_started", "task_complete", "token_count",
})


def _parse_codex_session(lines: list[str], session_id: str) -> list[dict]:
    messages: list[dict] = []
    seq = 0

    for line in lines:
        parsed = _safe_json(line)
        if parsed is None:
            continue

        event_type = parsed.get("type")
        if event_type in _CODEX_SKIP_TYPES:
            continue

        payload = parsed.get("payload")
        if not isinstance(payload, dict):
            continue

        timestamp = parsed.get("timestamp", "")

        if event_type == "event_msg":
            subtype = payload.get("type", "")
            if subtype in _CODEX_SKIP_EVENT_SUBTYPES:
                continue
            # user_message / agent_message markers — emit as agent metadata
            messages.append({
                "seq": seq,
                "role": "agent",
                "content": line,
                "createdAt": timestamp,
                "sessionId": session_id,
            })
            seq += 1
            continue

        if event_type != "response_item":
            continue

        role_val = payload.get("role", "")

        if role_val == "developer":
            continue

        if role_val == "user":
            user_text = _extract_codex_user_text(payload)
            if user_text is None:
                continue
            messages.append({
                "seq": seq,
                "role": "user",
                "content": user_text,
                "createdAt": timestamp,
                "sessionId": session_id,
            })
            seq += 1
            continue

        # assistant messages and tool call/output response_items
        messages.append({
            "seq": seq,
            "role": "agent",
            "content": line,
            "createdAt": timestamp,
            "sessionId": session_id,
        })
        seq += 1

    return messages


def _extract_codex_user_text(payload: dict) -> str | None:
    """Extract the human prompt text from a Codex response_item payload.

    Returns None for system-injected context (environment tags, AGENTS.md, etc.)
    and for non-text content.
    """
    content = payload.get("content")
    if not isinstance(content, list):
        return None

    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") != "input_text":
            continue
        text = block.get("text", "").strip()
        if not text:
            continue
        # System-injected context from Codex uses XML-style tags
        if text.startswith("<") or text.startswith("# AGENTS.md"):
            return None
        return text

    return None


def _extract_codex_user_messages(lines: list[str]) -> list[str]:
    results: list[str] = []
    for line in lines:
        parsed = _safe_json(line)
        if parsed is None:
            continue
        if parsed.get("type") != "response_item":
            continue
        payload = parsed.get("payload")
        if not isinstance(payload, dict) or payload.get("role") != "user":
            continue
        text = _extract_codex_user_text(payload)
        if text:
            results.append(text)
    return results


# ── Shared utilities ─────────────────────────────────────────────────────────

def _safe_json(line: str) -> dict | None:
    try:
        obj = json.loads(line)
    except (json.JSONDecodeError, TypeError):
        return None
    return obj if isinstance(obj, dict) else None
