/**
 * Map a single Claude Agent SDK message to zero-or-more session events.
 *
 * Pure function (aside from mutating the provided `toolIdMap` for tool_use
 * → tool_result pairing, and `streamState` for partial-message dedupe).
 * Returns an array of `{ kind, payload }`.
 *
 * The caller is responsible for:
 *  - stdout tee (NDJSON passthrough for the SSH-poll path),
 *  - assigning a fresh toolCallId per tool_use,
 *  - actually emitting events via an uploader.
 *
 * Partial-message streaming: when the SDK is configured with
 * `includePartialMessages: true`, we get `SDKPartialAssistantMessage`
 * (type='stream_event') with raw Anthropic SSE events. Text deltas are
 * emitted as `assistant.text_delta` so the UI can append them to the
 * in-progress text block live. The full `SDKAssistantMessage` still fires
 * at the end of each message — we dedupe by tracking which anthropic
 * message IDs had their text deltas streamed, then skipping text blocks
 * on the final assistant message (tool_use blocks still fire — they only
 * surface at message-completion time, not via the stream).
 */

export function mapClaudeMessage(msg, toolIdMap, { sessionId, newToolCallId, agent = "claude", streamState } = {}) {
  const events = [];
  const mintCallId = newToolCallId || (() => null);
  // streamState is a plain object the caller passes in and we mutate.
  // { currentMsgId: string|null, streamedTextMsgIds: Set<string> }
  // If the caller doesn't track partial streaming they pass undefined,
  // in which case we fall back to the old message-granularity behavior.
  const partialsEnabled = !!streamState;

  switch (msg.type) {
    case "system":
      if (msg.subtype === "init") {
        events.push({
          kind: "run.started",
          payload: {
            agent,
            sessionId: sessionId ?? msg.session_id,
            model: msg.model,
            cwd: msg.cwd,
          },
        });
      }
      break;

    case "stream_event": {
      // Raw Anthropic SSE events carried by SDKPartialAssistantMessage.
      // Only surface text deltas — tool_use blocks and metadata stay
      // on the final `assistant` message path (cleaner, fewer events).
      const ev = msg.event;
      if (!ev || !partialsEnabled) break;
      if (ev.type === "message_start" && ev.message?.id) {
        streamState.currentMsgId = ev.message.id;
      } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        const text = ev.delta.text;
        if (text) {
          if (streamState.currentMsgId) {
            streamState.streamedTextMsgIds.add(streamState.currentMsgId);
          }
          events.push({
            kind: "assistant.text_delta",
            payload: { text },
          });
        }
      }
      break;
    }

    case "assistant":
      for (const block of msg.message?.content ?? []) {
        if (block.type === "text" && block.text) {
          // Skip the complete text block if we've already streamed its
          // deltas — otherwise the final message arrives and duplicates
          // the body the user's already seen chunk-by-chunk.
          const alreadyStreamed = partialsEnabled
            && msg.message?.id
            && streamState.streamedTextMsgIds.has(msg.message.id);
          if (!alreadyStreamed) {
            events.push({
              kind: "assistant.message",
              payload: { text: block.text },
            });
          }
        } else if (block.type === "tool_use") {
          const callId = mintCallId();
          toolIdMap.set(block.id, callId);
          events.push({
            kind: "tool.started",
            payload: { toolName: block.name, input: block.input, toolCallId: callId },
          });
        }
      }
      break;

    case "user":
      for (const block of msg.message?.content ?? []) {
        if (block.type !== "tool_result") continue;
        const callId = toolIdMap.get(block.tool_use_id) ?? null;
        toolIdMap.delete(block.tool_use_id);
        events.push({
          kind: "tool.finished",
          payload: {
            toolCallId: callId,
            output: _stringifyToolResultContent(block.content),
            isError: !!block.is_error,
          },
        });
      }
      break;

    case "result":
      events.push({
        kind: "run.finished",
        payload: {
          outcome: msg.subtype === "success" ? "success" : "error",
          durationMs: msg.duration_ms,
          error: msg.subtype !== "success" ? (msg.result || "error") : undefined,
        },
      });
      break;

    default:
      // partial_assistant, status, hook_*, api_retry, etc. — not surfaced
      // as session events. The raw NDJSON still passes through stdout.
      break;
  }

  return events;
}

function _stringifyToolResultContent(raw) {
  let out;
  if (typeof raw === "string") {
    out = raw;
  } else if (Array.isArray(raw)) {
    out = raw.map((b) => (typeof b === "string" ? b : b?.text ?? JSON.stringify(b))).join("\n");
  } else {
    out = JSON.stringify(raw ?? "");
  }
  return out.slice(0, 3000);
}
