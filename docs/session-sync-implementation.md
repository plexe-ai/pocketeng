# Session Sync — Implementation Guide

## Overview

Session sync enables local coding agent conversations (Claude Code, Cursor, Codex, etc.) to be visible in the PocketEng web/mobile UI, and cloud sessions to be pulled back to the local machine. This document covers how the feature was built, tested, and verified — intended as a reference for extending it to additional agents (OpenCode, etc.).

---

## Problem Statement

When a user runs a coding agent locally (e.g. `claude` CLI) and has `pocketeng sync` active, the code files sync to/from the EC2 workspace, but **chat sessions do not**. The user's conversation history is invisible in the PocketEng UI.

We needed:
1. **Local → EC2 → UI**: Local sessions pushed to EC2, registered with the backend, visible in the web dashboard
2. **EC2 → Local**: Cloud sessions pulled back to the user's local machine
3. **Safety**: No data loss — never clobber local-only or cloud-only files

---

## Architecture

```
┌─────────────┐      scp (latest .jsonl)     ┌──────────────┐
│ Local Machine│ ──────────────────────────► │ EC2 Workspace │
│              │ ◄──────────────────────────  │              │
│ ~/.claude/   │   rsync --update (all .jsonl)│ ~/.claude/   │
│  projects/   │                              │  projects/   │
└──────┬───────┘                              └──────┬───────┘
       │                                             │
       │  POST /chat (register-synced-session)       │
       │  ─────────────────────────────────────►     │
       │                                      ┌──────┴───────┐
       │                                      │ Backend API  │
       │                                      │ (Lambda)     │
       │                                      │  • SSH reads │
       │                                      │    .jsonl    │
       │                                      │  • Parses via│
       │                                      │    session_  │
       │                                      │    file_     │
       │                                      │    parser.py │
       │                                      │  • Writes to │
       │                                      │    DynamoDB  │
       │                                      └──────────────┘
                                                     │
                                              ┌──────┴───────┐
                                              │ Web/Mobile UI│
                                              │ (Sessions)   │
                                              └──────────────┘
```

---

## Session File Locations by Agent

| Agent | Local session path | Format |
|-------|--------------------|--------|
| **Claude Code** | `~/.claude/projects/<hash>/<uuid>.jsonl` | NDJSON, top-level `type` field (`user`, `assistant`, `queue-operation`, `file-history-snapshot`, etc.) |
| **Cursor** | `~/.cursor/projects/<hash>/agent-transcripts/<uuid>/<uuid>.jsonl` | NDJSON, top-level `role` field (`user`, `assistant`). No bookkeeping events. |
| **Codex** | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` | NDJSON, every line: `{timestamp, type, payload}`. Types: `session_meta`, `event_msg`, `response_item`, `turn_context`. User prompts in `response_item` with `payload.role == "user"` (system context excluded). Date-based dirs, NOT project-scoped — `session_meta.payload.cwd` identifies the project. |

The `<hash>` is the project directory path with `/` replaced by `-`:
- Local example: `-Users-john-projects-myapp`
- EC2 example: `-home-ec2-user-projects-myapp`

---

## Components Modified/Created

### 1. `backend/src/lib/session_file_parser.py` (NEW)

Central module that standardizes agent-specific `.jsonl` formats into a common intermediate format for DynamoDB storage and UI rendering.

**Key functions:**
- `detect_agent(lines)` → `"claude"` or `"cursor"` — inspects first 20 lines to determine which agent produced the file
- `parse_session_file(lines, session_id, agent=None)` → `list[dict]` — converts raw lines into the standard message format
- `extract_user_messages(lines, agent=None)` → `list[str]` — extracts plain-text human prompts (for session titles/previews)

**Standard intermediate message format:**
```python
{
    "seq":       0,              # sequential position
    "role":      "user"|"agent", # user = human prompt, agent = everything else
    "content":   "...",          # plain text (user) or raw NDJSON line (agent)
    "createdAt": "ISO-8601",     # timestamp
    "sessionId": "uuid",         # session identifier
}
```

**Agent detection logic:**
- If a line has `"type"` matching Claude-specific values → Claude
- If a line has `"role"` but no `"type"` → Cursor
- Default fallback → Claude (safe superset)

**Claude Code specifics:**
- Bookkeeping events (`queue-operation`, `file-history-snapshot`, `progress`, `last-prompt`) are skipped
- User events with `tool_result` content blocks are classified as `agent` role (not human prompts)
- User text can be a plain string or an array of `{type: "text", text: "..."}` blocks

**Cursor specifics:**
- Lines are normalized by injecting a `"type"` field (from `"role"`) so the downstream `materialize_transcript()` parser works
- Tool-result user events are similarly classified as `agent` role

### 2. `backend/src/chat.py` (MODIFIED)

Two functions were refactored to use `session_file_parser` instead of inline Python parsing:

**`_register_synced_session()`**: Receives a POST from the CLI when a session is synced. Previously ran a Python script over SSH to extract first/last user messages. Now:
1. SSH reads raw `head -200` and `tail -500` lines + `wc -l` from the `.jsonl`
2. Calls `extract_user_messages()` locally to get first/last prompts
3. No Python dependency on EC2

**`_insert_tail_messages()`**: Inserts the last ~100 messages from a session into DynamoDB. Previously had inline JSON role detection. Now calls `parse_session_file()` for correct role mapping.

### 3. `pocketeng` CLI (MODIFIED)

**Push (local → EC2):** `_do_sync_once()` (line ~764)
- Finds the most recently modified `.jsonl` in the local session dir
- `scp`s it to the corresponding remote session dir on EC2
- Fires a background `_register_synced_session_api()` call to the backend

**Pull (EC2 → local):** `_do_sync_pull()` (line ~984)
- Uses `rsync -az --update` to copy session `.jsonl` and `.meta.json` files from EC2 to local
- `--update` = only overwrite if source is newer; no `--delete` = never remove local-only files
- Includes both `*.jsonl` and `*.meta.json` (subagent metadata)

**Bidirectional daemon:** `_sync_daemon_loop()` (line ~1133)
- Push runs every ~3s (existing behavior)
- Pull now runs every ~30s (10 iterations × 3s sleep)
- After each pull, `_sync_pull_and_register()` detects newly appeared `.jsonl` files and registers them with the backend

**`_sync_pull_and_register()`** (line ~1045, NEW):
1. Snapshots local `.jsonl` files before pull
2. Runs `_do_sync_pull()`
3. Diffs to find new files
4. For each new session, calls `_register_synced_session_api()` so it appears in the UI

---

## How to Add a New Agent

To add session syncing for a new agent (e.g. OpenCode):

> **Note**: Claude Code, Cursor, and Codex are already implemented. Use those as reference.

### Step 1: Understand the session file format

Run the agent, have a conversation, then find where it stores sessions:
```bash
# Example: find where the agent writes session files
find ~/.codex/ ~/.opencode/ -name "*.jsonl" -type f 2>/dev/null
```

Examine the `.jsonl` structure:
```bash
head -5 /path/to/session.jsonl | python3 -m json.tool
```

Key questions:
- What is the top-level structure? (`type` field? `role` field? something else?)
- How are user messages identified?
- How are assistant responses structured?
- Are there bookkeeping/metadata events to skip?
- Where is the timestamp?
- Where is the session ID?

### Step 2: Add a parser to `session_file_parser.py`

1. Add a new constant: `AGENT_CODEX = "codex"`
2. Update `detect_agent()` to recognize the new format
3. Implement `_parse_codex_session(lines, session_id)` following the pattern of `_parse_claude_session`
4. Implement `_extract_codex_user_messages(lines)` following the pattern of `_extract_claude_user_messages`
5. Update `parse_session_file()` and `extract_user_messages()` dispatch

### Step 3: Add unit tests to `test_session_file_parser.py`

Follow the existing pattern:
```python
class TestCodexParseSessionFile:
    def test_single_turn(self):
        lines = [_codex_user("Fix the bug"), _codex_assistant("Done.")]
        msgs = parse_session_file(lines, "s1", agent="codex")
        assert len(msgs) == 2
        assert msgs[0]["role"] == "user"
        assert msgs[1]["role"] == "agent"
```

Create helper functions (`_codex_user()`, `_codex_assistant()`, etc.) that produce realistic NDJSON lines.

### Step 4: Add integration tests to `test_session_extraction.py` (optional but recommended)

These run the actual agent CLI:
```python
@skip_no_codex_cli
class TestCodexSessionExtraction:
    def test_session_file_exists(self):
        # Run codex CLI with a prompt
        # Find the generated .jsonl
        # Assert it exists and has content
```

### Step 5: Update CLI session dir resolution

In the `pocketeng` script, update `_agent_session_dir()` and `_agent_remote_session_dir()` to handle the new agent's directory structure:
```bash
_agent_session_dir() {
    local hash="$1"
    case "${PE_AGENT:-claude}" in
        cursor) echo "$HOME/.cursor/projects/$(echo "$hash" | sed 's/^-//')/agent-transcripts" ;;
        codex)  echo "$HOME/.codex/sessions/${hash}" ;;  # <-- example
        *)      echo "$HOME/.claude/projects/${hash}" ;;
    esac
}
```

### Step 6: Verify the full pipeline

Run:
```bash
cd backend && python3 -m pytest tests/agents/test_session_file_parser.py -v
```

Then do a manual end-to-end test (see Testing section below).

---

## Testing

### Unit Tests: `test_session_file_parser.py`

**45 tests**, all use synthetic but realistic NDJSON data. No network, no CLI, no mocks.

| Test Class | What it covers |
|-----------|---------------|
| `TestDetectAgent` (5) | Agent auto-detection from `.jsonl` structure |
| `TestClaudeParseSessionFile` (8) | Single/multi turn, bookkeeping skip, tool results, timestamps, content blocks |
| `TestClaudeExtractUserMessages` (3) | User prompt extraction, tool-result filtering |
| `TestCursorParseSessionFile` (4) | Single/multi turn, tool results, auto-detection |
| `TestCursorExtractUserMessages` (2) | User prompt extraction, tool-result filtering |
| `TestParseToMaterialize` (5) | Full pipeline: parse → materialize_transcript → UI-ready format |

Run: `cd backend && python3 -m pytest tests/agents/test_session_file_parser.py -v`

### Integration Tests: `test_session_extraction.py`

**18 tests**, marked `@pytest.mark.integration`. These run the **actual Claude Code CLI** to generate real `.jsonl` files, then validate extraction.

| Test Class | What it covers |
|-----------|---------------|
| `TestSessionFileCreation` (3) | CLI creates `.jsonl`, has user+assistant events, all event types are known |
| `TestSingleTurnExtraction` (7) | First/last user message, parse_event, messages conversion, materialize, ndjson match |
| `TestMultiTurnExtraction` (5) | Two-turn session, ordering, both turns in transcript |
| `TestExtractionConsistency` (3) | Session file vs stdout NDJSON produce same user/assistant content |

**Prerequisites:** Claude Code CLI installed (`claude` on PATH), valid API key.

Run: `cd backend && python3 -m pytest tests/agents/test_session_extraction.py -v -s`

### Codex Bridge Tests: `test_integration.py`

**8 Codex tests** verify the bridge produces valid NDJSON:

| Test Class | What it covers |
|-----------|---------------|
| `TestCodexViaBridgeProducesValidNDJSON` (4) | Bridge emits NDJSON, init event, assistant message, result event |
| `TestCodexViaBridgeToolCallWorks` (1) | Bash command completes without hanging |
| `TestCodexTranscriptMaterializationReal` (1) | Real Codex output materializes correctly |
| `TestCodexWithToolUse` (1) | Bridge emits tool_use for command_execution |
| `TestCodexModelFlag` (1) | --model flag is honored |

**Prerequisites:** Bridge files auto-copied from `backend/src/lib/bridge/` to `~/.pocketeng/bridge/`. Codex SDK must be installed: `cd ~/.pocketeng/bridge && npm install @openai/codex-sdk`.

Run: `cd backend && python3 -m pytest tests/agents/test_integration.py -k "Codex" -v`

### Manual End-to-End Test

**Test 1: Local session → EC2 → UI**
1. `cd` into a project directory
2. Run Claude Code: `claude -p "say pocketeng_test_sync and nothing else"`
3. Or have an interactive session: `claude` → type messages → `/exit`
4. Set test API: `export POCKETENG_API_BASE="https://<test-api-url>/dev"`
5. Start sync: `pocketeng sync start --to <workspace>`
6. Check the sync log: `tail -f ~/.pocketeng/watchers/<hash>.log`
7. Look for `register-session: <uuid>... ok`
8. Open the web UI — session should appear with the first user message as preview

**Test 2: EC2 session → Local**
1. With sync running, SSH into the EC2 workspace
2. Run Claude Code there to create a session
3. Wait ~30s for the pull cycle
4. Check locally: `ls ~/.claude/projects/<local-hash>/` — the EC2 session `.jsonl` should appear
5. Verify it's resumable: `claude --resume <session-id>` (must be in the matching project directory)

**Test 3: Safety verification**
1. Create a local-only session (don't sync)
2. Start sync, let it pull from cloud
3. Verify the local-only session is still intact (rsync `--update` + no `--delete`)

---

## Data Flow in Detail

### Local → EC2 → UI (push path)

1. **CLI `_do_sync_once()`** finds the latest `.jsonl` by mtime in `~/.claude/projects/<local-hash>/`
2. **`scp`** copies it to EC2: `~/.claude/projects/<remote-hash>/<uuid>.jsonl`
3. **CLI `_register_synced_session_api()`** sends POST to backend:
   ```
   POST /servers/<serverId>/chat
   { action: "register-synced-session", sessionId: "<uuid>", ... }
   ```
4. **Backend `_register_synced_session()`** in `chat.py`:
   - SSH reads `head -200`, `tail -500`, `wc -l` from the `.jsonl` on EC2
   - Calls `session_file_parser.extract_user_messages()` to get first/last prompts
   - Writes session record to `pe-sessions-<stage>` DynamoDB table
   - Calls `_insert_tail_messages()` which uses `parse_session_file()` to insert messages to `pe-messages-<stage>`
5. **Web UI** reads from DynamoDB and displays the session

### EC2 → Local (pull path)

1. **CLI `_sync_daemon_loop()`** triggers `_sync_pull_and_register()` every ~30s
2. **`rsync -az --update`** copies `.jsonl` + `.meta.json` from EC2 session dir to local session dir
3. New files detected by diffing before/after file lists
4. Each new session registered via `_register_synced_session_api()`

---

## Key Design Decisions

1. **No Python on EC2**: The backend reads raw lines via SSH (`head`/`tail`/`wc`) and parses locally. This avoids requiring Python or any parser on the EC2 instance.

2. **Agent auto-detection**: `detect_agent()` inspects the `.jsonl` structure rather than relying on filename conventions. This makes it robust to path changes.

3. **Safe sync**: `rsync --update` (newer-mtime wins) + no `--delete` ensures no data loss in either direction. Push uses `scp` for a single file (the latest active session), not the entire history.

4. **Intermediate format**: All agents convert to the same `{seq, role, content, createdAt, sessionId}` format before DynamoDB storage. The downstream `materialize_transcript()` handles rendering for the UI.

5. **Bookkeeping event filtering**: Claude Code's `.jsonl` contains many event types (`queue-operation`, `file-history-snapshot`, `progress`, `last-prompt`) that are internal bookkeeping, not conversation content. These are skipped during parsing.

6. **Tool-result classification**: When Claude Code or Cursor sends a `user` event containing `tool_result` content blocks (the result of a tool call), it's classified as `agent` role, not `user`. Only genuine human-typed prompts are `user`.

---

## Files Reference

| File | Purpose |
|------|---------|
| `backend/src/lib/session_file_parser.py` | Agent detection + format-specific parsers |
| `backend/src/chat.py` | Backend Lambda — session registration + message insertion |
| `pocketeng` (CLI script) | Bidirectional sync daemon, push/pull logic |
| `backend/tests/agents/test_session_file_parser.py` | Unit tests for parser (45 tests) |
| `backend/tests/agents/test_session_extraction.py` | Integration tests with real Claude CLI (18 tests) |
| `backend/tests/agents/test_integration.py` | Codex bridge tests (8 tests) |
| `backend/src/lib/transcript.py` | `materialize_transcript()` — converts intermediate → UI format (existing, not modified) |
