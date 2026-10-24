/**
 * Tests for the Claude SDK message → session event mapper.
 *
 * These are pure unit tests — no SDK, no network. We hand-craft SDK-shaped
 * messages and assert on the events the mapper produces.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { mapClaudeMessage } from "./claude_events.mjs";

function idFactory() {
  let n = 0;
  return () => `call-${++n}`;
}

describe("mapClaudeMessage", () => {
  test("system/init emits run.started with model + cwd", () => {
    const msg = {
      type: "system",
      subtype: "init",
      session_id: "claude-sess-abc",
      model: "claude-sonnet-4-5",
      cwd: "/home/user/projects/x",
    };
    const events = mapClaudeMessage(msg, new Map(), {
      sessionId: "pe-sess-1",
      newToolCallId: idFactory(),
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "run.started");
    assert.equal(events[0].payload.agent, "claude");
    assert.equal(events[0].payload.sessionId, "pe-sess-1");
    assert.equal(events[0].payload.model, "claude-sonnet-4-5");
    assert.equal(events[0].payload.cwd, "/home/user/projects/x");
  });

  test("system/other subtypes produce no events", () => {
    const msg = { type: "system", subtype: "some_other" };
    const events = mapClaudeMessage(msg, new Map(), { newToolCallId: idFactory() });
    assert.equal(events.length, 0);
  });

  test("assistant text content emits assistant.message", () => {
    const msg = {
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello there." }] },
    };
    const events = mapClaudeMessage(msg, new Map(), { newToolCallId: idFactory() });
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "assistant.message");
    assert.equal(events[0].payload.text, "Hello there.");
  });

  test("assistant tool_use emits tool.started and records tool_use_id mapping", () => {
    const toolMap = new Map();
    const msg = {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "ls" } },
        ],
      },
    };
    const events = mapClaudeMessage(msg, toolMap, { newToolCallId: idFactory() });
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "tool.started");
    assert.equal(events[0].payload.toolName, "Bash");
    assert.deepEqual(events[0].payload.input, { command: "ls" });
    assert.equal(events[0].payload.toolCallId, "call-1");
    assert.equal(toolMap.get("toolu_01"), "call-1");
  });

  test("assistant mixed text + tool_use emits both events in order", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Running the command:" },
          { type: "tool_use", id: "toolu_42", name: "Read", input: { path: "/etc/hosts" } },
        ],
      },
    };
    const events = mapClaudeMessage(msg, new Map(), { newToolCallId: idFactory() });
    assert.equal(events.length, 2);
    assert.equal(events[0].kind, "assistant.message");
    assert.equal(events[1].kind, "tool.started");
    assert.equal(events[1].payload.toolName, "Read");
  });

  test("user tool_result pairs with prior tool_use via tool_use_id", () => {
    const toolMap = new Map([["toolu_01", "call-1"]]);
    const msg = {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "toolu_01", content: "file1\nfile2", is_error: false },
        ],
      },
    };
    const events = mapClaudeMessage(msg, toolMap, { newToolCallId: idFactory() });
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "tool.finished");
    assert.equal(events[0].payload.toolCallId, "call-1");
    assert.equal(events[0].payload.output, "file1\nfile2");
    assert.equal(events[0].payload.isError, false);
    assert.equal(toolMap.has("toolu_01"), false, "mapping should be cleared after pairing");
  });

  test("user tool_result with array content flattens to joined text", () => {
    const msg = {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              { type: "text", text: "first" },
              { type: "text", text: "second" },
              "raw string",
            ],
            is_error: false,
          },
        ],
      },
    };
    const events = mapClaudeMessage(msg, new Map([["toolu_1", "call-1"]]), {
      newToolCallId: idFactory(),
    });
    assert.equal(events[0].payload.output, "first\nsecond\nraw string");
  });

  test("user tool_result with is_error=true sets isError", () => {
    const msg = {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tu", content: "boom", is_error: true },
        ],
      },
    };
    const events = mapClaudeMessage(msg, new Map(), { newToolCallId: idFactory() });
    assert.equal(events[0].payload.isError, true);
  });

  test("user tool_result truncates output to 3000 chars", () => {
    const big = "x".repeat(5000);
    const msg = {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tu", content: big, is_error: false },
        ],
      },
    };
    const events = mapClaudeMessage(msg, new Map(), { newToolCallId: idFactory() });
    assert.equal(events[0].payload.output.length, 3000);
  });

  test("user tool_result with unknown tool_use_id still emits tool.finished (callId null)", () => {
    const msg = {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "unknown", content: "x", is_error: false },
        ],
      },
    };
    const events = mapClaudeMessage(msg, new Map(), { newToolCallId: idFactory() });
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.toolCallId, null);
  });

  test("result success emits run.finished with outcome=success", () => {
    const msg = {
      type: "result",
      subtype: "success",
      duration_ms: 1234,
      result: "done",
    };
    const events = mapClaudeMessage(msg, new Map(), { newToolCallId: idFactory() });
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "run.finished");
    assert.equal(events[0].payload.outcome, "success");
    assert.equal(events[0].payload.durationMs, 1234);
    assert.equal(events[0].payload.error, undefined);
  });

  test("result error emits run.finished with error payload", () => {
    const msg = {
      type: "result",
      subtype: "error_max_turns",
      duration_ms: 500,
      result: "hit max turns",
    };
    const events = mapClaudeMessage(msg, new Map(), { newToolCallId: idFactory() });
    assert.equal(events[0].payload.outcome, "error");
    assert.equal(events[0].payload.error, "hit max turns");
  });

  test("unrecognized message types emit nothing (partial_assistant, hook, etc.)", () => {
    const types = ["partial_assistant", "status", "hook_started", "api_retry", "tool_progress"];
    for (const type of types) {
      const events = mapClaudeMessage({ type }, new Map(), { newToolCallId: idFactory() });
      assert.equal(events.length, 0, `unexpected event for ${type}`);
    }
  });

  test("full conversation flow: init → assistant text+tool → user tool_result → result", () => {
    const toolMap = new Map();
    const newId = idFactory();
    const stream = [
      { type: "system", subtype: "init", session_id: "sess", model: "opus", cwd: "/x" },
      { type: "assistant", message: { content: [
        { type: "text", text: "I'll check the file." },
        { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "README.md" } },
      ]}},
      { type: "user", message: { content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "hello", is_error: false },
      ]}},
      { type: "assistant", message: { content: [{ type: "text", text: "File has 'hello' in it." }] }},
      { type: "result", subtype: "success", duration_ms: 2000, result: "ok" },
    ];
    const allKinds = [];
    for (const msg of stream) {
      for (const ev of mapClaudeMessage(msg, toolMap, { sessionId: "pe-1", newToolCallId: newId })) {
        allKinds.push(ev.kind);
      }
    }
    assert.deepEqual(allKinds, [
      "run.started",
      "assistant.message",
      "tool.started",
      "tool.finished",
      "assistant.message",
      "run.finished",
    ]);
  });
});
