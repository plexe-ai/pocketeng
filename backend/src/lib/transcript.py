import json
import re


_ANSI_RE = re.compile(r"\x1B\[[0-9;]*[A-Za-z]|\x1B\].*?\x07|\x1B\([A-Za-z]")


def materialize_transcript(messages, session_status="done"):
    sorted_messages = sorted(messages, key=lambda item: int(item.get("seq", 0)))
    transcript = []
    assistant = _AssistantAccumulator()

    for item in sorted_messages:
        role = item.get("role")
        timestamp = item.get("createdAt")
        session_id = item.get("sessionId")

        # Validator feedback is internal harness output — the agent sees it
        # via Claude's own --resume session memory, but the user-facing chat
        # UI never renders it.
        if role == "validator":
            continue

        if role == "user":
            finalized = assistant.finalize(
                session_id=session_id,
                is_final_message=False,
                session_status=session_status,
            )
            if finalized:
                finalized["seq"] = len(transcript)
                transcript.append(finalized)
            assistant = _AssistantAccumulator()

            transcript.append({
                "sessionId": session_id,
                "seq": len(transcript),
                "role": "user",
                "content": item.get("content", ""),
                "createdAt": timestamp,
                "state": "complete",
                "tools": [],
            })
            continue

        assistant.consume(str(item.get("content", "")), timestamp)

    final_message = assistant.finalize(
        session_id=sorted_messages[-1].get("sessionId") if sorted_messages else None,
        is_final_message=True,
        session_status=session_status,
    )
    if final_message:
        final_message["seq"] = len(transcript)
        transcript.append(final_message)

    return transcript


class _AssistantAccumulator:
    def __init__(self):
        self.timestamp = None
        self.text_segments = []
        self.tools = []
        self.last_event_was_tool = False
        self.had_error = False

    def consume(self, raw_line, timestamp):
        if self.timestamp is None:
            self.timestamp = timestamp

        event = _parse_event(raw_line)
        if event is not None:
            kind = event["kind"]
            if kind == "assistant_text":
                self._append_delta(event["text"])
            elif kind == "assistant_snapshot":
                self._merge_snapshot(event["text"])
            elif kind == "tool_use":
                self.tools.append({
                    "toolName": event["toolName"],
                    "input": event["input"],
                    "inputDataJSON": event["inputDataJSON"],
                    "output": None,
                    "isError": False,
                    "createdAt": timestamp,
                })
                self.last_event_was_tool = True
            elif kind == "tool_use_with_result":
                self.tools.append({
                    "toolName": event["toolName"],
                    "input": event["input"],
                    "inputDataJSON": event["inputDataJSON"],
                    "output": event.get("output"),
                    "isError": event.get("isError", False),
                    "createdAt": timestamp,
                })
                self.last_event_was_tool = True
            elif kind == "tool_result":
                if self.tools:
                    self.tools[-1] = {
                        **self.tools[-1],
                        "output": event["output"],
                        "isError": event["isError"],
                    }
            elif kind == "completed":
                if event["resultText"]:
                    self._merge_snapshot(event["resultText"])
                if event["status"] != "success":
                    self.had_error = True
            elif kind == "error":
                self.had_error = True
                if not self.combined_text:
                    self.text_segments = [event["message"]]
            return

    def finalize(self, session_id, is_final_message, session_status):
        if not self.combined_text and not self.tools:
            return None

        if self.had_error:
            state = "error"
        elif is_final_message and session_status == "running":
            state = "interrupted"
        else:
            state = "complete"

        return {
            "sessionId": session_id,
            "role": "assistant",
            "content": self.combined_text,
            "createdAt": self.timestamp,
            "state": state,
            "tools": list(self.tools),
        }

    @property
    def combined_text(self):
        return "\n\n".join(segment for segment in self.text_segments if segment)

    def _append_delta(self, text):
        if not text:
            return

        if not self.text_segments or self.last_event_was_tool:
            self.text_segments.append(text)
        else:
            self.text_segments[-1] += text

        self.last_event_was_tool = False

    def _merge_snapshot(self, text):
        if not text:
            return

        if not self.text_segments:
            self.text_segments = [text]
            self.last_event_was_tool = False
            return

        last_segment = self.text_segments[-1]
        transcript = self.combined_text

        if (
            text == last_segment
            or text == transcript
            or transcript.endswith(text)
            or last_segment.endswith(text)
        ):
            self.last_event_was_tool = False
            return

        if text.startswith(last_segment):
            self.text_segments[-1] = text
            self.last_event_was_tool = False
            return

        if last_segment.startswith(text) or transcript.startswith(text):
            self.last_event_was_tool = False
            return

        if text.startswith(transcript):
            self.text_segments = [text]
            self.last_event_was_tool = False
            return

        self.text_segments.append(text)
        self.last_event_was_tool = False


def _parse_event(raw_line):
    parsed = _structured_json(raw_line)
    if not parsed:
        return None

    event_type = parsed.get("type")

    # ── Claude Code events ──
    if event_type == "system":
        if parsed.get("subtype") == "init" and _get_string(parsed.get("session_id")):
            return {"kind": "initialized", "sessionId": parsed.get("session_id")}
        return None
    if event_type in ("assistant", "message"):
        return _parse_assistant_event(parsed)
    if event_type == "tool_use":
        return _parse_tool_use_event(parsed)
    if event_type == "tool_result":
        return _parse_tool_result_event(parsed)
    if event_type == "user":
        return _parse_nested_tool_result_event(parsed)
    if event_type == "result":
        return _parse_result_event(parsed)
    if event_type == "content_block_delta":
        delta = parsed.get("delta")
        if isinstance(delta, dict) and delta.get("type") == "text_delta":
            text = _get_string(delta.get("text"))
            if text:
                return {"kind": "assistant_text", "text": text}
        return None
    if event_type == "text":
        text = _get_string(parsed.get("content"))
        if text:
            return {"kind": "assistant_text", "text": text}

    # ── Cursor CLI events ──
    if event_type == "tool_call":
        return _parse_cursor_tool_call(parsed)

    # ── Codex CLI stdout events ──
    if event_type == "thread.started":
        thread_id = _get_string(parsed.get("thread_id"))
        if thread_id:
            return {"kind": "initialized", "sessionId": thread_id}
        return None
    if event_type == "item.started":
        return _parse_codex_item_started(parsed.get("item"))
    if event_type == "item.completed":
        return _parse_codex_item_completed(parsed.get("item"))
    if event_type == "turn.completed":
        return {"kind": "completed", "status": "success", "resultText": None}

    # ── Codex session file events ({timestamp, type, payload} wrapper) ──
    payload = parsed.get("payload") if "timestamp" in parsed else None
    if isinstance(payload, dict):
        if event_type == "response_item":
            return _parse_codex_session_response_item(payload)
        if event_type == "event_msg":
            return _parse_codex_session_event_msg(payload)

    return None


CURSOR_TOOL_CALL_KEYS = {
    "readToolCall": "Read",
    "writeToolCall": "Write",
    "editToolCall": "Edit",
    "shellToolCall": "Bash",
    "searchToolCall": "Search",
    "grepToolCall": "Grep",
    "globToolCall": "Glob",
    "fetchToolCall": "WebFetch",
}


def _parse_cursor_tool_call(parsed):
    """Handle Cursor CLI tool_call events (subtype started/completed)."""
    subtype = parsed.get("subtype")
    tc = parsed.get("tool_call")
    if not isinstance(tc, dict):
        return None

    tool_name, tool_data = _extract_cursor_tool(tc)

    if subtype == "started":
        args = tool_data.get("args") if isinstance(tool_data, dict) else None
        return {
            "kind": "tool_use",
            "toolName": tool_name,
            "input": _extract_tool_input(args),
            "inputDataJSON": _serialize_json(args),
        }

    if subtype == "completed":
        args = tool_data.get("args") if isinstance(tool_data, dict) else None
        result = tool_data.get("result") if isinstance(tool_data, dict) else None
        output = ""
        is_error = False
        if isinstance(result, dict):
            success = result.get("success")
            error = result.get("error")
            if isinstance(success, dict):
                output = (
                    _get_string(success.get("content"))
                    or _get_string(success.get("path"))
                    or json.dumps(success, separators=(",", ":"))[:3000]
                )
            elif isinstance(error, dict):
                output = _get_string(error.get("message")) or json.dumps(error)[:3000]
                is_error = True
            elif isinstance(error, str):
                output = error[:3000]
                is_error = True
        return {
            "kind": "tool_use_with_result",
            "toolName": tool_name,
            "input": _extract_tool_input(args),
            "inputDataJSON": _serialize_json(args),
            "output": output,
            "isError": is_error,
        }

    return None


def _extract_cursor_tool(tc):
    """Extract (tool_name, tool_data) from a Cursor tool_call dict."""
    for key, name in CURSOR_TOOL_CALL_KEYS.items():
        if key in tc:
            return name, tc[key]
    fn = tc.get("function")
    if isinstance(fn, dict):
        return _get_string(fn.get("name")) or "unknown", fn
    return "unknown", tc


def _parse_codex_item_started(item):
    """Handle Codex item.started — emits a tool_use so the UI shows the command immediately."""
    if not isinstance(item, dict):
        return None
    if item.get("type") != "command_execution":
        return None
    command = _get_string(item.get("command")) or ""
    return {
        "kind": "tool_use",
        "toolName": "Bash",
        "input": command,
        "inputDataJSON": _serialize_json({"command": command}),
    }


def _parse_codex_item_completed(item):
    if not isinstance(item, dict):
        return None
    item_type = item.get("type")
    if item_type == "agent_message":
        text = _get_string(item.get("text"))
        if text:
            return {"kind": "assistant_text", "text": text}
        return None
    if item_type == "command_execution":
        output = _get_string(item.get("aggregated_output")) or ""
        exit_code = item.get("exit_code")
        is_error = exit_code is not None and exit_code != 0
        return {
            "kind": "tool_result",
            "output": output[:3000],
            "isError": is_error,
        }
    return None


def _parse_codex_session_response_item(payload):
    """Handle a Codex session-file response_item payload."""
    ptype = payload.get("type")
    role = payload.get("role")

    if ptype == "reasoning":
        return None

    if role == "assistant" and ptype == "message":
        content = payload.get("content")
        if isinstance(content, list):
            parts = []
            for block in content:
                if isinstance(block, dict) and block.get("type") == "output_text":
                    text = _get_string(block.get("text"))
                    if text:
                        parts.append(text)
            if parts:
                return {"kind": "assistant_snapshot", "text": "".join(parts)}
        return None

    if ptype == "function_call":
        name = _get_string(payload.get("name")) or "unknown"
        args_str = _get_string(payload.get("arguments"))
        args_dict = None
        if args_str:
            try:
                args_dict = json.loads(args_str)
            except (json.JSONDecodeError, TypeError):
                pass
        command = ""
        if isinstance(args_dict, dict):
            command = _get_string(args_dict.get("cmd")) or _get_string(args_dict.get("command")) or ""
        return {
            "kind": "tool_use",
            "toolName": name,
            "input": command or args_str or "",
            "inputDataJSON": _serialize_json(args_dict) or args_str,
        }

    if ptype == "function_call_output":
        output = _get_string(payload.get("output")) or ""
        return {
            "kind": "tool_result",
            "output": output[:3000],
            "isError": False,
        }

    return None


def _parse_codex_session_event_msg(payload):
    """Handle a Codex session-file event_msg payload.

    agent_message events duplicate the text from response_item assistant
    messages, so we skip them to avoid double-counting.
    """
    return None


def _parse_assistant_event(parsed):
    message = parsed.get("message")
    if isinstance(message, dict):
        content = message.get("content")
        if isinstance(content, list):
            event = _parse_assistant_blocks(content)
            if event:
                return event
    content = parsed.get("content")
    if isinstance(content, list):
        event = _parse_assistant_blocks(content)
        if event:
            return event
    text = _get_string(parsed.get("message"))
    if text:
        return {"kind": "assistant_snapshot", "text": text}
    return None


def _parse_assistant_blocks(blocks):
    text_parts = []
    tool_event = None
    for block in blocks:
        if not isinstance(block, dict):
            continue
        block_type = block.get("type")
        if block_type == "text":
            text = _get_string(block.get("text"))
            if text:
                text_parts.append(text)
        elif block_type == "tool_use" and tool_event is None:
            tool_event = _tool_use_from_block(block)

    full_text = "".join(text_parts)
    if full_text:
        return {"kind": "assistant_snapshot", "text": full_text}
    return tool_event


def _parse_tool_use_event(parsed):
    tool = parsed.get("tool")
    if isinstance(tool, dict):
        return _tool_use_from_block({
            "name": tool.get("name"),
            "input": tool.get("input"),
        })
    return _tool_use_from_block(parsed)


def _tool_use_from_block(block):
    name = (
        _get_string(block.get("name"))
        or _get_string(block.get("tool_name"))
        or "unknown"
    )
    input_dict = block.get("input") if isinstance(block.get("input"), dict) else None
    return {
        "kind": "tool_use",
        "toolName": name,
        "input": _extract_tool_input(input_dict),
        "inputDataJSON": _serialize_json(input_dict),
    }


def _parse_tool_result_event(parsed):
    return {
        "kind": "tool_result",
        "output": _extract_tool_output(parsed),
        "isError": bool(parsed.get("is_error", False)),
    }


def _parse_nested_tool_result_event(parsed):
    message = parsed.get("message")
    if isinstance(message, dict):
        content = message.get("content")
        if isinstance(content, list):
            output_parts = []
            is_error = False
            for block in content:
                if not isinstance(block, dict) or block.get("type") != "tool_result":
                    continue
                text = _extract_tool_result_block_output(block)
                if text:
                    output_parts.append(text)
                is_error = is_error or bool(block.get("is_error", False))
            if output_parts or is_error:
                return {
                    "kind": "tool_result",
                    "output": "\n".join(part for part in output_parts if part)[:3000],
                    "isError": is_error,
                }

    tool_use_result = parsed.get("tool_use_result")
    if isinstance(tool_use_result, str):
        return {
            "kind": "tool_result",
            "output": tool_use_result[:3000],
            "isError": tool_use_result.lower().startswith("error:"),
        }
    if isinstance(tool_use_result, dict):
        output = (
            _get_string(tool_use_result.get("stdout"))
            or _get_string(tool_use_result.get("stderr"))
            or json.dumps(tool_use_result)[:3000]
        )
        return {
            "kind": "tool_result",
            "output": output,
            "isError": bool(tool_use_result.get("is_error", False)),
        }
    return None


def _parse_result_event(parsed):
    if parsed.get("is_error"):
        message = (
            _get_string(parsed.get("result"))
            or _get_string(parsed.get("error"))
            or _get_string(parsed.get("message"))
        )
        subtype = _get_string(parsed.get("subtype"))
        if not message and subtype:
            friendly = {
                "error_during_execution": "The agent hit an error while executing. Check the tool outputs above for details — often this is a missing API key, failed shell command, or expired session.",
                "error_max_turns": "The agent reached its maximum number of turns without finishing. Try sending a more specific prompt or breaking the task into smaller steps.",
            }
            message = friendly.get(subtype, f"Agent exited with error ({subtype}).")
        return {
            "kind": "error",
            "message": message or "The agent exited with an error but did not report a reason.",
        }

    result_text = _get_string(parsed.get("result"))
    return {
        "kind": "completed",
        "status": _get_string(parsed.get("subtype")) or "unknown",
        "resultText": result_text.strip() if result_text else None,
    }


def _extract_tool_input(input_dict):
    if not isinstance(input_dict, dict):
        return ""
    for key in ("command", "file_path", "pattern"):
        value = _get_string(input_dict.get(key))
        if value:
            return value
    prompt = _get_string(input_dict.get("prompt"))
    if prompt:
        return prompt[:100]
    old_string = _get_string(input_dict.get("old_string"))
    if old_string:
        return f"edit: {old_string[:80]}"
    content = _get_string(input_dict.get("content"))
    if content:
        return content[:80]
    return (_serialize_json(input_dict) or "")[:200]


def _extract_tool_output(parsed):
    content = parsed.get("content")
    if isinstance(content, str):
        return content[:3000]
    output = _get_string(parsed.get("output"))
    if output:
        return output[:3000]
    if isinstance(content, list):
        return (_extract_text_blocks(content) or "")[:3000]
    return ""


def _extract_tool_result_block_output(block):
    content = block.get("content")
    if isinstance(content, str):
        return content[:3000]
    if isinstance(content, list):
        return (_extract_text_blocks(content) or "")[:3000]
    return ""


def _extract_text_blocks(blocks):
    parts = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        text = _get_string(block.get("text"))
        if text:
            parts.append(text)
    joined = "\n".join(parts).strip()
    return joined or None


def _serialize_json(value):
    if value is None:
        return None
    try:
        return json.dumps(value, separators=(",", ":"))
    except Exception:
        return None


def _structured_json(line):
    stripped = _strip_ansi(line).strip()
    if not stripped:
        return None
    try:
        parsed = json.loads(stripped)
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None


def _is_structured_line(line):
    parsed = _structured_json(line)
    return isinstance(parsed, dict) and isinstance(parsed.get("type"), str)



def _strip_ansi(value):
    return _ANSI_RE.sub("", value or "")


def _get_string(value):
    return value if isinstance(value, str) and value else None
