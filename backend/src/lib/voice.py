"""Helpers shared by the voice-call path (Retell) — TTS shaping and
session resolution.

Phone UX has two hard constraints that differ from SMS/Slack:
  1. Responses must sound natural when spoken. Markdown, code blocks,
     and URLs need to be stripped or referred to by name.
  2. Responses need to be short. ~400 chars is the outer bound — past
     that, TTS takes too long and the caller interrupts.

The resolution helpers match "session/workspace by spoken hint" —
the Retell LLM handles the clarification turns; we just need robust
fuzzy matching so "pocket eng", "pocketing", "the pocket one" all
find the `pocketeng` workspace.
"""
import re
from typing import Optional


# ── TTS shaping ──────────────────────────────────────────────────────────────

_CODE_BLOCK = re.compile(r"```[\s\S]*?```")
_INLINE_CODE = re.compile(r"`([^`]+)`")
_MARKDOWN_LINK = re.compile(r"\[([^\]]+)\]\([^)]+\)")
_URL = re.compile(r"https?://\S+")
_MARKDOWN_EMPH = re.compile(r"(\*\*|__|\*|_)")
_WHITESPACE = re.compile(r"\s+")


def format_for_tts(text: str, max_chars: int = 400) -> str:
    """Strip markdown, collapse whitespace, truncate at a sentence boundary
    if possible. Output should be something TTS can read without stumbling
    over punctuation or URLs.

    - Code blocks are replaced by "(code block omitted)" so the caller knows
      something was there but we don't read 60 lines of Python over the phone.
    - Inline code is kept (the token itself is usually readable).
    - Markdown links keep the label, drop the URL.
    - Bare URLs are replaced with "(link)".
    """
    if not text:
        return ""

    cleaned = _CODE_BLOCK.sub(" (code block omitted) ", text)
    cleaned = _INLINE_CODE.sub(r"\1", cleaned)
    cleaned = _MARKDOWN_LINK.sub(r"\1", cleaned)
    cleaned = _URL.sub("(link)", cleaned)
    cleaned = _MARKDOWN_EMPH.sub("", cleaned)
    cleaned = _WHITESPACE.sub(" ", cleaned).strip()

    if len(cleaned) <= max_chars:
        return cleaned

    # Try to cut at the last sentence end within budget.
    snippet = cleaned[:max_chars]
    for sep in (". ", "? ", "! ", "\n"):
        idx = snippet.rfind(sep)
        if idx > max_chars // 2:
            return snippet[:idx + 1].strip()
    # Fallback — cut at the last word boundary.
    idx = snippet.rfind(" ")
    if idx > 0:
        snippet = snippet[:idx]
    return snippet.strip() + "…"


# ── Fuzzy workspace / session resolution ─────────────────────────────────────

_WORD = re.compile(r"[a-z0-9]+")


def _normalize(text: str) -> str:
    """Lowercase, keep alphanumerics, drop everything else. 'pocket-eng' and
    'pocket eng' both become 'pocketeng' — matches the Speech-to-Text output
    which won't preserve dashes/spaces reliably."""
    return "".join(_WORD.findall((text or "").lower()))


def resolve_workspace(servers: list, hint: Optional[str]) -> Optional[dict]:
    """Find the best workspace match given a spoken hint.

    Strategy:
      - If hint is falsy or "default": pick the single running workspace
        when unambiguous; otherwise the most recently active.
      - Exact label match (normalized).
      - Prefix match.
      - Substring match.
      - Fall back to None (caller asks the user to clarify).
    """
    active = [
        s for s in servers
        if s.get("instanceState") not in ("terminated",) and s.get("sshPrivateKey")
    ]
    if not active:
        return None

    if not hint or _normalize(hint) in ("default", "mydefault", "themain", "main"):
        running = [s for s in active if s.get("instanceState") == "running"]
        if len(running) == 1:
            return running[0]
        pool = running or active
        return max(pool, key=lambda s: s.get("lastActivityAt") or s.get("updatedAt") or "")

    target = _normalize(hint)
    if not target:
        return None

    # 1. exact normalized label
    for s in active:
        if _normalize(s.get("label", "")) == target:
            return s
    # 2. prefix
    for s in active:
        if _normalize(s.get("label", "")).startswith(target):
            return s
    # 3. substring (either direction — caller might say a superstring of the label)
    for s in active:
        n = _normalize(s.get("label", ""))
        if target in n or (n and n in target):
            return s
    return None


def resolve_session(sessions: list, hint: Optional[str]) -> Optional[dict]:
    """Find the best session match. Sessions are keyed by sessionId (UUID)
    which nobody is going to say over the phone — so we match against
    `lastPrompt` or `prompt` (first ~60 chars of the initial prompt, which
    usually describes what the session is about).

    Without a hint, returns the most recently updated running session, or
    the most recently updated session overall.
    """
    if not sessions:
        return None

    if not hint:
        running = [s for s in sessions if s.get("status") == "running"]
        pool = running or sessions
        return max(pool, key=lambda s: s.get("updatedAt") or "")

    target = _normalize(hint)
    if not target:
        return None

    # Score each session by how much of the hint appears in its prompt.
    def _score(s: dict) -> int:
        hay = _normalize((s.get("lastPrompt") or s.get("prompt") or "")[:200])
        if not hay:
            return 0
        if target == hay[:len(target)]:
            return 1000
        if target in hay:
            return 500 + len(target)
        # Word-level overlap fallback.
        hint_words = set(re.findall(r"[a-z0-9]+", (hint or "").lower()))
        hay_words = set(re.findall(r"[a-z0-9]+", (s.get("lastPrompt") or s.get("prompt") or "").lower()))
        return len(hint_words & hay_words)

    scored = [(s, _score(s)) for s in sessions]
    # Highest score first; on ties, most recently updated (ISO8601 sorts lexically).
    scored.sort(key=lambda pair: (pair[1], pair[0].get("updatedAt") or ""), reverse=True)
    best, best_score = scored[0]
    if best_score == 0:
        return None
    return best
