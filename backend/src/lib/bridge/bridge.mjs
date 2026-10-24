#!/usr/bin/env node

/**
 * PocketEngineer Agent Bridge
 *
 * Normalizes output from any coding agent (Claude Code, Codex, OpenCode)
 * into the Claude Code NDJSON stream format that the iOS app understands.
 *
 * Usage:
 *   echo "build a REST API" | pe-bridge --agent codex --workdir ~/projects/myapp
 *   echo "fix the tests"    | pe-bridge --agent opencode --workdir ~/projects/myapp
 *
 * Output: NDJSON to stdout, one JSON object per line, matching Claude Code's
 * --output-format stream-json format.
 */

import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createUploaderFromEnv } from "./uploader.mjs";
import { mapClaudeMessage } from "./claude_events.mjs";

// ── Parse CLI args ──
//
// Anything after `--` goes into positionals and is forwarded verbatim to
// the wrapped agent (used by the subprocess path: claude, cursor).

const { values: args } = parseArgs({
  options: {
    agent: { type: "string", default: "codex" },
    workdir: { type: "string", default: process.cwd() },
    resume: { type: "string" },
    "session-id": { type: "string" },
    model: { type: "string" },
    // Claude-specific: its internal session UUID is separate from our PE
    // session id so the two don't collide.
    "claude-resume": { type: "string" },
    "claude-new-session-id": { type: "string" },
    // Cursor-specific resume (passed through as --resume to the agent CLI).
    "cursor-resume": { type: "string" },
    // Codex-specific resume: forwards to `codex.resumeThread(id, opts)` so
    // the SDK re-opens the existing thread and appends new turns to the
    // same `~/.codex/sessions/.../rollout-*-<id>.jsonl` rollout file. Without
    // this the SDK's `startThread` always mints a new thread id and writes
    // a fresh rollout per turn, so multi-turn cloud sessions fragment across
    // N rollout files and we lose native Codex context between turns.
    "codex-resume": { type: "string" },
    // OpenCode-specific resume: re-open an existing OpenCode session id.
    "opencode-resume": { type: "string" },
  },
});

const agent = args.agent;
const workdir = args.workdir;
// PE session id (used for event routing). Prefer the env var set by the
// backend launch script; fall back to legacy --session-id / --resume flags.
const sessionId = process.env.PE_SESSION_ID
  || args["session-id"]
  || args.resume
  || randomUUID().slice(0, 8);
const turnId = process.env.PE_TURN_ID || randomUUID();

const uploader = createUploaderFromEnv({ sessionId, turnId });
const toolCallIds = [];

// ── Read prompt from stdin ──

let prompt = "";
const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}
prompt = Buffer.concat(chunks).toString().trim();

if (!prompt) {
  process.stderr.write("pe-bridge: no prompt provided on stdin\n");
  process.exit(1);
}

// ── Load images from PE_IMAGES_FILE if present ──
//
// The backend writes a JSON manifest [{path, mediaType}, ...] to a temp file
// on EC2 and exports its path in PE_IMAGES_FILE.  Each entry's `path` points
// at an already-uploaded file in /tmp/pe-uploads/.  We read the image bytes
// here so each agent runner can inject them as native content blocks.
//
// `images` is an array of Anthropic-style image content objects:
//   { type: "image", source: { type: "base64", media_type, data }, _path }
// The `_path` field carries the original EC2 path so path-reference fallbacks
// (Cursor, Codex) can use it without re-parsing the manifest.

const images = [];
const imagesFile = process.env.PE_IMAGES_FILE;
if (imagesFile) {
  try {
    const manifest = JSON.parse(await readFile(imagesFile, "utf-8"));
    for (const img of manifest) {
      const imgPath = img.path || img.filePath || "";
      if (!imgPath) continue;
      try {
        const data = await readFile(imgPath);
        images.push({
          type: "image",
          source: {
            type: "base64",
            media_type: img.mediaType || "image/png",
            data: data.toString("base64"),
          },
          _path: imgPath,
        });
      } catch (fileErr) {
        process.stderr.write(`pe-bridge: could not read image ${imgPath}: ${fileErr.message}\n`);
      }
    }
  } catch (manifestErr) {
    process.stderr.write(`pe-bridge: failed to load images manifest: ${manifestErr.message}\n`);
  }
}

// ── NDJSON helpers ──

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function emitInit() {
  emit({ type: "system", subtype: "init", session_id: sessionId });
  uploader?.emit("run.started", { agent, sessionId });
}

function emitText(text) {
  emit({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
    session_id: sessionId,
  });
  uploader?.emit("assistant.message", { text });
}

function emitToolUse(name, input) {
  emit({
    type: "tool_use",
    tool: { name, input },
    session_id: sessionId,
  });
  const toolCallId = randomUUID();
  toolCallIds.push(toolCallId);
  uploader?.emit("tool.started", { toolName: name, input, toolCallId });
}

function emitToolResult(content, isError = false) {
  const truncated = typeof content === "string" ? content.slice(0, 3000) : String(content).slice(0, 3000);
  emit({
    type: "tool_result",
    content: truncated,
    is_error: isError,
    session_id: sessionId,
  });
  const toolCallId = toolCallIds.shift() || null;
  uploader?.emit("tool.finished", { toolCallId, output: truncated, isError });
}

function emitResult(status, durationMs) {
  emit({
    type: "result",
    subtype: status,
    duration_ms: durationMs,
    session_id: sessionId,
  });
  uploader?.emit("run.finished", { outcome: status, durationMs });
}

function emitError(message) {
  emit({
    type: "result",
    subtype: "error",
    is_error: true,
    result: message,
    session_id: sessionId,
  });
  uploader?.emit("run.finished", { outcome: "error", error: message });
}

async function getFreeLocalPort() {
  const { createServer } = await import("node:net");
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((err) => {
        if (err) return reject(err);
        if (!port) return reject(new Error("Failed to reserve a local port for OpenCode"));
        resolve(port);
      });
    });
  });
}

// ── Agent runners ──

async function runClaude() {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const startTime = Date.now();

  // Local tracking: the SDK gives each tool_use a stable id (`tool_use_id`
  // in the tool_result). We reuse that as toolCallId so tool.started and
  // tool.finished events pair up exactly. The existing toolCallIds FIFO
  // stack used for Codex/OpenCode doesn't fit the pattern because Claude
  // can interleave multiple tool uses within a turn.
  const claudeToolIdToCallId = new Map();

  const queryOptions = {
    cwd: workdir,
    // Use the Claude Code preset system prompt rather than the SDK's
    // default (minimal) one. Without this, the parent agent runs without
    // the CLI's tuned guidance about tools, code style, and — most
    // visibly — subagent delegation: it re-runs Grep/Read/Bash to
    // double-check what the Agent tool already returned, doubling the
    // tool-call count visible to the user.
    //
    // The `append:` block extends the preset with our pocketeng-specific
    // rules. Keep these short — the preset already covers the heavy
    // lifting; we only add what's specific to running on EC2 worktrees.
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: [
        "When you call the Agent tool, trust its result and incorporate",
        "it directly into your reply. Do NOT re-run Grep, Read, or Bash",
        "to verify findings the subagent has already returned — that",
        "wastes time and tokens.",
      ].join(" "),
    },
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    // Block Claude Code's built-in worktree tools. Pocketeng already places
    // every session in a dedicated worktree via the backend's `worktree.py`,
    // so letting the agent call EnterWorktree would create a second, parallel
    // worktree (`.claude/worktrees/<slug>`) that our Changes panel, git ops,
    // and cleanup path know nothing about.
    disallowedTools: ["EnterWorktree", "ExitWorktree"],
    // Emit `SDKPartialAssistantMessage` (type='stream_event') carrying raw
    // Anthropic SSE events, so the bridge can surface token-level text
    // deltas as `assistant.text_delta` events. Without this, the SDK only
    // yields complete `SDKAssistantMessage` objects at message-completion
    // time — the user sees a long "Thinking…" and then one big blob of
    // text instead of watching the reply stream in.
    includePartialMessages: true,
    // Pick up MCP servers + settings the user registered on the workspace
    // via `claude mcp add` (→ ~/.claude/*.json, user scope), `.mcp.json`
    // in the project root (project scope), or .claude/settings.local.json
    // (local scope — personal overrides that shouldn't be checked in).
    // Without this, the Agent SDK ignores every filesystem setting — so a
    // user who SSHes in and runs `claude mcp add gmail npx -- <pkg>` sees
    // it work in `claude` CLI but get silently dropped by our session.
    settingSources: ["user", "project", "local"],
    // Subagents the parent can delegate to via the Agent tool (renamed
    // from Task in Claude Code v2.1.63 — both names work). The SDK
    // exposes a built-in `general-purpose` agent automatically when the
    // Agent tool is allowed (it is by default — we only blocklist
    // worktree tools above). These three custom agents add specialized
    // wrappers that Claude can pick up when the description matches.
    //
    // CLI-style behavior: subagents run synchronously within the parent's
    // turn. Their intermediate steps (file reads, greps, bash) stay in
    // the subagent's own context window — only the final summary message
    // is returned to the parent. The parent then incorporates that
    // summary into its reply to the user. This is exactly how Claude
    // Code CLI's Task/Agent tool behaves; we're just giving the SDK the
    // same delegation menu.
    //
    // Why not `background: true`: that's a newer SDK flag for async
    // fire-and-forget agents that return an agentId for later resume.
    // Useful for parallel reviews but requires the parent to know to
    // poll / fetch — adds product surface we don't need yet. Keeping it
    // synchronous matches user expectation (CLI parity) and keeps the
    // event stream simple — every Agent tool call shows up as a single
    // tool.started/tool.finished pair in the chat panel.
    //
    // Why not allowedTools restriction: leaving it unset gives subagents
    // (and the parent) the full default tool set including Read, Write,
    // Edit, Bash, Grep, Glob, WebFetch, etc. The `tools:` field per agent
    // narrows what each subagent can touch.
    agents: {
      explore: {
        description:
          "Read-only code exploration. Use when you need to find files, " +
          "understand structure, or trace usage across the codebase " +
          "WITHOUT modifying anything. Keeps file-reading noise out of " +
          "the parent context — only the final summary comes back.",
        prompt:
          "You are a code exploration specialist. Your job is to navigate " +
          "the codebase and return concise, well-organized findings. " +
          "Use Grep, Glob, and Read to investigate. Do NOT modify files. " +
          "Return a focused summary: file paths, key snippets, and the " +
          "shape of what you found. No fluff, no exploratory narration.",
        tools: ["Read", "Grep", "Glob"],
        // Haiku for parity with Claude Code CLI's built-in Explore agent
        // — fast (~2-4s vs Opus 17s), cheap, plenty for grep + read
        // patterns. Read-only tool set means there's nothing to gain
        // from a smarter model here.
        model: "haiku",
      },
      "test-runner": {
        description:
          "Runs tests and reports results. Use when the user asks to " +
          "verify a change, check the build, or diagnose a failure. " +
          "Faster than the parent doing it inline because intermediate " +
          "test output stays in the subagent context.",
        prompt:
          "You are a test execution specialist. Run the appropriate test " +
          "command for the project (check package.json scripts, " +
          "Makefile, pyproject, or ask the user if unclear), report what " +
          "passed and failed concisely, and quote only the relevant " +
          "failure output — never the full passing test names. If a " +
          "test failed, point at the file:line.",
        tools: ["Bash", "Read", "Grep", "Glob"],
        // Inherit the parent's model — interpreting test failures and
        // figuring out which test command to run benefits from the
        // stronger model. Latency is dominated by the test run itself.
        model: "inherit",
      },
      "code-reviewer": {
        description:
          "Reviews code changes for quality, security, and bugs. Use " +
          "when the user asks 'review this' or before suggesting a PR. " +
          "Read-only — produces a list of findings without modifying.",
        prompt:
          "You are a senior code reviewer. Examine the diff or files " +
          "provided and return a focused list of findings: bugs, " +
          "security issues, performance concerns, and style violations. " +
          "Order by severity. Quote file:line for each finding. Skip " +
          "compliments — flag only what needs attention.",
        tools: ["Read", "Grep", "Glob"],
        // Haiku here is a deliberate tradeoff — code review benefits from
        // smarter models, but at the speed/cost of Opus the parent is
        // tempted to just review inline instead of delegating. Haiku
        // makes delegation feel cheap. For deep reviews the parent can
        // still do the work itself, or the user can `/model opus` and
        // the test-runner-style inherit pattern would cover it.
        model: "haiku",
      },
    },
  };
  if (args.model) queryOptions.model = args.model;
  if (args["claude-resume"]) queryOptions.resume = args["claude-resume"];
  if (args["claude-new-session-id"]) queryOptions.sessionId = args["claude-new-session-id"];

  let runFinishedEmitted = false;
  // Threaded through mapClaudeMessage so it can (a) remember the current
  // anthropic message.id across stream_event → assistant-message boundaries
  // and (b) dedupe the final assistant-message text block against any text
  // deltas we already streamed.
  const streamState = { currentMsgId: null, streamedTextMsgIds: new Set() };

  // When images are present, switch to the SDK's streaming-input mode:
  // `prompt` becomes an AsyncIterable<SDKUserMessage> whose first (and only)
  // item is a user message with an array content block containing the image
  // blobs followed by the text prompt.  This is the only path that delivers
  // images as first-class multimodal content to the Claude agent.
  let promptInput = prompt;
  if (images.length > 0) {
    const imageBlocks = images.map(img => ({
      type: "image",
      source: img.source,
    }));
    async function* imagePromptStream() {
      yield {
        type: "user",
        message: {
          role: "user",
          content: [
            ...imageBlocks,
            { type: "text", text: prompt },
          ],
        },
      };
    }
    promptInput = imagePromptStream();
  }

  try {
    for await (const msg of query({ prompt: promptInput, options: queryOptions })) {
      // Tee every message to stdout as NDJSON — preserves the existing
      // SSH-poll path and the iOS parser that reads from the out_file.
      process.stdout.write(JSON.stringify(msg) + "\n");

      const events = mapClaudeMessage(msg, claudeToolIdToCallId, {
        sessionId,
        newToolCallId: () => randomUUID(),
        streamState,
      });
      for (const ev of events) {
        if (ev.kind === "run.finished") runFinishedEmitted = true;
        uploader?.emit(ev.kind, ev.payload);
      }
    }
  } catch (err) {
    if (!runFinishedEmitted) {
      uploader?.emit("run.finished", {
        outcome: "error",
        error: err?.message || String(err),
      });
      runFinishedEmitted = true;
    }
    throw err;
  }

  if (!runFinishedEmitted) {
    // SDK ended without a result message — synthesize one so the backend
    // completion hook fires.
    uploader?.emit("run.finished", {
      outcome: "success",
      durationMs: Date.now() - startTime,
    });
  }
}

async function runCodex() {
  // Use `codex exec --json` CLI subprocess so we can pass `--image` flags for
  // native vision support.  The JS SDK's `thread.runStreamed()` only accepts a
  // plain string — there is no SDK-level image content API.
  //
  // CLI reference:
  //   codex exec [--image path[,path...]] [--model M] --yolo
  //              --skip-git-repo-check --json [--cd workdir] "PROMPT"
  //   codex exec resume SESSION_ID [--image path] "FOLLOW_UP" --yolo … --json
  const { spawn } = await import("node:child_process");
  const { createInterface } = await import("node:readline");
  const startTime = Date.now();

  emitInit();

  const resumeId = args["codex-resume"];

  // Build the CLI argument list.
  const codexArgs = [
    "exec",
    "--yolo",                   // bypass approvals + sandbox
    "--skip-git-repo-check",
    "--json",
    "--cd", workdir,
  ];

  if (args.model) codexArgs.push("--model", args.model);

  // Native image flags — one -i per image file path.
  if (images.length > 0) {
    for (const img of images) {
      if (img._path) codexArgs.push("-i", img._path);
    }
  }

  // Resume appends after the fixed flags; the follow-up prompt goes last.
  if (resumeId) {
    codexArgs.push("resume", resumeId);
  }

  codexArgs.push(prompt);

  const child = spawn("codex", codexArgs, {
    cwd: workdir,
    stdio: ["ignore", "pipe", "inherit"],
  });

  let runFinishedEmitted = false;

  for await (const line of createInterface({ input: child.stdout })) {
    if (!line.trim()) continue;
    process.stdout.write(line + "\n"); // backwards-compat tee for poll path

    let event;
    try { event = JSON.parse(line); } catch { continue; }

    switch (event.type) {
      case "thread.started": {
        // Capture real thread_id so backend can reconcile DDB remoteSessionId.
        const threadId = event.thread_id;
        if (threadId) {
          emit({ type: "thread.started", thread_id: threadId, session_id: sessionId });
          uploader?.emit("session.remote", { remoteSessionId: threadId, agent });
        }
        break;
      }

      case "item.completed": {
        const item = event.item;
        if (!item) break;
        // CLI may emit item_type (older docs) or type (newer docs); handle both.
        const itemType = item.type || item.item_type;

        switch (itemType) {
          case "agent_message":
          case "assistant_message":
            if (item.text) emitText(item.text);
            break;

          case "command_execution": {
            emitToolUse("Bash", {
              command: item.command || item.args?.join(" ") || "",
            });
            const output = typeof item.aggregated_output === "string"
              ? item.aggregated_output
              : (typeof item.output === "string" ? item.output : "");
            const exitCode = typeof item.exit_code === "number" ? item.exit_code
              : (typeof item.exitCode === "number" ? item.exitCode : 0);
            emitToolResult(output, exitCode !== 0);
            break;
          }

          case "file_change":
          case "file_changes": {
            const changes = item.changes || [];
            for (const ch of changes) {
              const p = ch.path || ch.file || "(unknown)";
              const k = ch.kind || "update";
              emitToolUse("Edit", { file_path: p, change_kind: k, old_string: ch.before || "", new_string: ch.after || "" });
              emitToolResult(`${k} ${p}`, item.status === "failed");
            }
            break;
          }

          case "mcp_tool_call": {
            const toolName = item.tool || item.toolName || "MCP";
            emitToolUse(toolName, item.arguments || item.input || {});
            if (item.result?.content !== undefined) {
              const content = item.result.content;
              emitToolResult(typeof content === "string" ? content : JSON.stringify(content), item.status === "failed");
            } else if (item.error) {
              emitToolResult(item.error.message || "MCP error", true);
            }
            break;
          }

          case "reasoning":
            // Skip reasoning events — they're internal.
            break;

          default:
            if (item.text) emitText(item.text);
        }
        break;
      }

      case "turn.completed":
        break;

      case "turn.failed":
        emitError(event.error?.message || "Turn failed");
        runFinishedEmitted = true;
        break;

      case "error":
        emitError(event.message || "Unknown error");
        runFinishedEmitted = true;
        break;
    }
  }

  const exitCode = await new Promise(res => child.once("exit", res));

  if (!runFinishedEmitted) {
    emitResult(exitCode === 0 ? "success" : "error", Date.now() - startTime);
  }
}

async function runCursor() {
  // When images are present, use @cursor/sdk which supports native multimodal
  // input via agent.send({ text, images: [{ data: base64, mimeType }] }).
  // Fall back to the CLI subprocess (agent -p --output-format stream-json)
  // for text-only turns — preserves the existing reliable text path.
  //
  // @cursor/sdk stream events (SDKMessage):
  //   { type: "assistant", message: { content: [{ type: "text", text }] } }
  //   { type: "tool_call", call_id, name, status, args?, result? }
  //   { type: "status", status: "RUNNING"|"FINISHED"|"ERROR" }
  //   { type: "thinking", text }  — extended thinking, skip
  //   { type: "task", text }      — task summary, skip

  const startTime = Date.now();

  if (images.length > 0) {
    // ── SDK path (native vision) ─────────────────────────────────────────
    let Agent;
    try {
      const cursorSdk = await import("@cursor/sdk");
      Agent = cursorSdk.Agent;
    } catch {
      // SDK not installed — fall through to CLI path with path references.
      process.stderr.write("pe-bridge: @cursor/sdk not found, falling back to CLI path for Cursor images\n");
      return runCursorCli(startTime);
    }

    emitInit();

    const apiKey = process.env.CURSOR_API_KEY;
    if (!apiKey) {
      process.stderr.write("pe-bridge: CURSOR_API_KEY not set, cannot use Cursor SDK\n");
      return runCursorCli(startTime);
    }

    const sdkImages = images.map(img => ({
      data: img.source.data,
      mimeType: img.source.media_type,
    }));

    let cursorAgent;
    const resumeId = args["cursor-resume"];
    if (resumeId) {
      cursorAgent = await Agent.resume(resumeId, {
        apiKey,
        local: { cwd: workdir, settingSources: ["all"] },
      });
    } else {
      cursorAgent = await Agent.create({
        apiKey,
        model: { id: args.model || "composer-2" },
        local: { cwd: workdir, settingSources: ["all"] },
      });
    }

    // Emit the agent ID so backend can store it as remoteSessionId for resume.
    if (cursorAgent.agentId) {
      emit({ type: "cursor.agent", agent_id: cursorAgent.agentId, session_id: sessionId });
      uploader?.emit("session.remote", { remoteSessionId: cursorAgent.agentId, agent });
    }

    const run = await cursorAgent.send(
      { text: prompt, images: sdkImages },
      { model: args.model ? { id: args.model } : undefined },
    );

    // Track tool calls so we can pair started → completed events.
    const pendingTools = new Map(); // call_id → name

    let runFinishedEmitted = false;
    for await (const event of run.stream()) {
      switch (event.type) {
        case "assistant": {
          for (const block of (event.message?.content ?? [])) {
            if (block.type === "text" && block.text) emitText(block.text);
          }
          break;
        }
        case "tool_call": {
          const status = event.status ?? "";
          if (status === "started" || (!status && !pendingTools.has(event.call_id))) {
            pendingTools.set(event.call_id, event.name || "Tool");
            emitToolUse(event.name || "Tool", event.args || {});
          } else if (status === "completed" || status === "failed" || (status === "" && event.result !== undefined)) {
            const isError = status === "failed";
            const content = event.result;
            emitToolResult(typeof content === "string" ? content : JSON.stringify(content ?? ""), isError);
            pendingTools.delete(event.call_id);
          }
          break;
        }
        case "status":
          if (event.status === "ERROR") {
            emitError("Cursor agent error");
            runFinishedEmitted = true;
          }
          break;
        case "thinking":
        case "task":
        case "user":
        case "system":
          // Skip — internal/non-user-visible events.
          break;
      }
    }

    try { await run.wait(); } catch { /* outcome already captured */ }

    if (!runFinishedEmitted) {
      uploader?.emit("run.finished", { outcome: "success", durationMs: Date.now() - startTime });
    }

    try { await cursorAgent[Symbol.asyncDispose]?.(); } catch { /* cleanup */ }
    return;
  }

  // ── CLI path (text-only turns) ────────────────────────────────────────────
  return runCursorCli(startTime);
}

async function runCursorCli(startTime) {
  const { spawn } = await import("node:child_process");
  const { createInterface } = await import("node:readline");

  // For text-only Cursor turns the CLI `agent -p --output-format stream-json`
  // emits Claude-compatible NDJSON; we reuse mapClaudeMessage to normalise it.
  // When images arrive without the SDK, include the file paths in the prompt
  // so the agent can read them via its own tools.
  let cursorPrompt = prompt;
  if (images.length > 0) {
    const paths = images.map(img => img._path).filter(Boolean);
    if (paths.length > 0 && !paths.some(p => prompt.includes(p))) {
      const pathList = paths.map(p => `- ${p}`).join("\n");
      cursorPrompt =
        `${prompt}\n\nAttached image file${paths.length > 1 ? "s" : ""} (use Read tool to view):\n${pathList}`;
    }
  }

  const cursorArgs = ["-p", "--force", "--output-format", "stream-json", "--sandbox", "disabled"];
  if (args.model) cursorArgs.push("--model", args.model);
  if (args["cursor-resume"]) cursorArgs.push("--resume", args["cursor-resume"]);

  const child = spawn("agent", cursorArgs, {
    cwd: workdir,
    stdio: ["pipe", "pipe", "inherit"],
  });
  child.stdin.end(cursorPrompt);

  const toolIdMap = new Map();
  let runFinishedEmitted = false;

  for await (const line of createInterface({ input: child.stdout })) {
    if (!line.trim()) continue;
    process.stdout.write(line + "\n");
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const events = mapClaudeMessage(msg, toolIdMap, {
      sessionId,
      newToolCallId: () => randomUUID(),
      agent: "cursor",
    });
    for (const ev of events) {
      if (ev.kind === "run.finished") runFinishedEmitted = true;
      uploader?.emit(ev.kind, ev.payload);
    }
  }

  const exitCode = await new Promise(res => child.once("exit", res));
  if (!runFinishedEmitted) {
    uploader?.emit("run.finished", {
      outcome: exitCode === 0 ? "success" : "error",
      durationMs: Date.now() - startTime,
      error: exitCode !== 0 ? `cursor exited ${exitCode}` : undefined,
    });
  }
}

async function runOpenCode() {
  const { createOpencode } = await import("@opencode-ai/sdk");
  const startTime = Date.now();

  emitInit();

  process.chdir(workdir);

  // The SDK defaults to port 4096. Reusing that fixed port on long-lived
  // workspaces causes flake: a prior opencode server can still be bound
  // there, making subsequent sessions fail before the first prompt with
  // "Failed to start server on port 4096". Reserve an ephemeral localhost
  // port per run so each bridge invocation gets its own server instance.
  const opencodePort = await getFreeLocalPort();
  const { client } = await createOpencode({
    hostname: "127.0.0.1",
    port: opencodePort,
    timeout: 15000,
  });

  // Create or resume session
  let session;
  if (args["opencode-resume"]) {
    try {
      session = await client.session.get({ path: { id: args["opencode-resume"] } });
    } catch {
      session = await client.session.create({ body: { title: prompt.slice(0, 50) } });
    }
  } else {
    session = await client.session.create({ body: { title: prompt.slice(0, 50) } });
  }

  const sid = session.data?.id || session.id || sessionId;
  if (sid) {
    emit({ type: "opencode.session", id: sid, session_id: sessionId });
    uploader?.emit("session.remote", { remoteSessionId: sid, agent });
  }

  // Subscribe to events before sending the prompt so we don't miss deltas.
  const eventStream = await client.event.subscribe();

  // Track role per opencode messageID so we can ignore the user's own
  // prompt parts when the SDK replays them over SSE. Without this the UI
  // sees two `assistant.message` events per turn: one echoing the user's
  // prompt and one with OpenCode's real reply.
  const messageRoles = new Map();

  // Control flags for the SSE consumer loop.
  let done = false;
  let promptError = null;
  const hardTimeout = setTimeout(() => { done = true; }, 300_000); // 5 min max

  // Send the prompt. Resolves when OpenCode finishes generating the reply.
  // The SDK does NOT reliably emit `message.completed`/`session.completed`
  // over SSE, so this promise is the authoritative "done" signal — we flip
  // `done` to break the SSE loop whether or not the stream emits a
  // terminal event first.
  //
  // When images are present, prepend them as "file" parts before the text
  // part.  The OpenCode SDK (v2) uses the Vercel AI SDK "file" part shape:
  //   { type: "file", data: "data:<mime>;base64,<data>", mediaType: "<mime>" }
  // NOT the Anthropic-style { type: "image", source: { type: "base64", … } }.
  // Using the wrong format causes OpenCode to silently drop the image or
  // trigger a context-window explosion (it stringifies the base64 as text).
  const promptParts = [
    ...images.map(img => ({
      type: "file",
      data: `data:${img.source.media_type};base64,${img.source.data}`,
      mediaType: img.source.media_type,
    })),
    { type: "text", text: prompt },
  ];
  const promptPromise = client.session.prompt({
    path: { id: sid },
    body: {
      parts: promptParts,
    },
  });
  promptPromise
    .then(() => { done = true; })
    .catch((err) => { promptError = err; done = true; });

  try {
    for await (const event of eventStream.stream) {
      if (done) break;

      const props = event.properties || event;
      const eventType = event.type || props.type;

      switch (eventType) {
        case "message.created":
        case "message.updated": {
          // Record role for this message so subsequent part updates can
          // be scoped to the assistant side of the conversation.
          const msg = props.info || props.message || props;
          const id = msg?.id || msg?.info?.id;
          const role = msg?.role || msg?.info?.role;
          if (id && role) messageRoles.set(id, role);
          break;
        }

        case "message.part.updated":
        case "part.updated": {
          const part = props.part || props;
          const partMsgId = part.messageID || part.messageId;
          const role = partMsgId ? messageRoles.get(partMsgId) : undefined;
          // Only forward assistant-scoped parts. When role is unknown we
          // err on the side of skipping; if the assistant parts arrive
          // again with role resolved we'll forward them then.
          if (role !== "assistant") break;
          if (part.type === "text" && part.text) {
            emitText(part.text);
          } else if (part.type === "tool-invocation" || part.type === "tool_use") {
            emitToolUse(part.toolName || part.name || "tool", part.args || part.input || {});
          } else if (part.type === "tool-result" || part.type === "tool_result") {
            const content = part.result || part.output || part.content || "";
            emitToolResult(typeof content === "string" ? content : JSON.stringify(content), part.isError);
          }
          break;
        }

        case "message.completed":
        case "session.completed":
          done = true;
          break;

        case "error":
          promptError = promptError || new Error(props.message || props.error || "Unknown error");
          done = true;
          break;
      }
    }
  } catch (e) {
    if (!done) promptError = promptError || e;
  }

  clearTimeout(hardTimeout);

  // Give the prompt promise one last chance to settle in case it finished
  // just before the SSE loop exited. Ignore errors — they're captured via
  // promptError above.
  try { await promptPromise; } catch { /* captured */ }

  // Always emit run.finished exactly once. Without this the UI stays
  // stuck in a "Writing..." state forever because `message.completed` /
  // `session.completed` aren't reliable in the OpenCode SDK's SSE stream.
  if (promptError) {
    emitError(promptError.message || String(promptError));
  } else {
    emitResult("success", Date.now() - startTime);
  }

  // Cleanup
  try { await client.close?.(); } catch {}
}

// ── Main ──

try {
  if (agent === "claude") {
    await runClaude();
  } else if (agent === "codex") {
    await runCodex();
  } else if (agent === "cursor") {
    await runCursor();
  } else if (agent === "opencode") {
    await runOpenCode();
  } else {
    process.stderr.write(`pe-bridge: unknown agent "${agent}". Use claude, codex, cursor, or opencode.\n`);
    process.exit(1);
  }
  if (uploader) await uploader.drain();
} catch (err) {
  emitError(err.message || String(err));
  if (uploader) await uploader.drain({ maxWaitMs: 3000 });
  process.exit(1);
}
