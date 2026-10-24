#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execSync, spawn } from "child_process";
import { readFileSync, existsSync, readdirSync, copyFileSync, mkdirSync, writeFileSync, renameSync, statSync, watch as fsWatch } from "fs";
import { homedir, platform } from "os";
import { join, basename, relative } from "path";

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG_DIR = join(homedir(), ".pocketeng");
const LEGACY_DIR = join(homedir(), ".pocket-engineer");
const SERVERS_DIR = join(CONFIG_DIR, "servers");
const ACTIVE_FILE = join(CONFIG_DIR, "active");
const LEGACY_CONFIG = join(CONFIG_DIR, "config");

/** Migrate old ~/.pocket-engineer dir to ~/.pocketeng */
function migrateDir() {
  if (existsSync(LEGACY_DIR) && !existsSync(CONFIG_DIR)) {
    renameSync(LEGACY_DIR, CONFIG_DIR);
  }
}

/** Migrate old single-server config to multi-server layout */
function migrateConfig() {
  try { migrateDir(); } catch {}
  if (existsSync(LEGACY_CONFIG) && !existsSync(SERVERS_DIR)) {
    mkdirSync(SERVERS_DIR, { recursive: true });
    copyFileSync(LEGACY_CONFIG, join(SERVERS_DIR, "default.conf"));
    writeFileSync(ACTIVE_FILE, "default");
  }
}

/** Get the active profile name */
function activeProfile() {
  if (existsSync(ACTIVE_FILE)) {
    return readFileSync(ACTIVE_FILE, "utf-8").trim();
  }
  return "default";
}

/** Parse a .conf file into a config object */
function parseConfFile(filePath) {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, "utf-8");
  const vars = {};
  for (const line of content.split("\n")) {
    const match = line.match(/^(\w+)="(.+)"$/);
    if (match) vars[match[1]] = match[2];
  }
  return {
    host: vars.PE_HOST,
    user: vars.PE_USER || "ec2-user",
    key: vars.PE_KEY,
    dir: vars.PE_DIR || "~/projects",
  };
}

/**
 * Load config for a specific profile, or the active profile.
 * Falls back to legacy ~/.pocket-engineer/config for backward compat.
 */
function loadConfig(profileName) {
  migrateConfig();
  const profile = profileName || activeProfile();
  const profileFile = join(SERVERS_DIR, `${profile}.conf`);

  // Try profile-specific config first
  if (existsSync(profileFile)) {
    return parseConfFile(profileFile);
  }
  // If an explicit profile was requested but not found, don't fall back
  if (profileName) {
    return null;
  }
  // Fall back to legacy config only for default/auto resolution
  if (existsSync(LEGACY_CONFIG)) {
    return parseConfFile(LEGACY_CONFIG);
  }
  return null;
}

/** List all server profiles with their hosts */
function listProfiles() {
  migrateConfig();
  const profiles = [];
  if (!existsSync(SERVERS_DIR)) return profiles;

  const files = readdirSync(SERVERS_DIR).filter((f) => f.endsWith(".conf"));
  const current = activeProfile();

  for (const file of files) {
    const name = file.replace(/\.conf$/, "");
    const config = parseConfFile(join(SERVERS_DIR, file));
    profiles.push({
      name,
      host: config?.host || "unknown",
      active: name === current,
    });
  }
  return profiles;
}

function sshArgs(config) {
  return [
    "-i", config.key,
    "-o", "StrictHostKeyChecking=no",
    "-o", "ConnectTimeout=10",
    "-o", "BatchMode=yes",
  ];
}

function runSSH(config, command, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const args = [...sshArgs(config), `${config.user}@${config.host}`, command];
    const proc = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("SSH command timed out"));
    }, timeoutMs);

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function runLocal(command, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const proc = spawn("bash", ["-c", command], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("Command timed out"));
    }, timeoutMs);

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ─── Shared Excludes ─────────────────────────────────────────────────────────

const SYNC_EXCLUDES = [
  ".git", "node_modules", ".build", "DerivedData", "*.xcodeproj",
  ".DS_Store", "Pods", "build", "dist", ".next", "__pycache__",
  "*.pyc", "venv", ".venv", "env", ".env", "*.egg-info", ".tox",
  ".pytest_cache", "target", ".gradle", "*.o", "*.so", "*.dylib", ".claude",
];

function buildExcludeArgs() {
  return SYNC_EXCLUDES.map((e) => `--exclude '${e}'`).join(" ");
}

function shouldExclude(filePath) {
  const parts = filePath.split("/");
  for (const pattern of SYNC_EXCLUDES) {
    if (pattern.startsWith("*.")) {
      const ext = pattern.slice(1); // e.g. ".pyc"
      if (filePath.endsWith(ext)) return true;
    } else {
      if (parts.includes(pattern)) return true;
    }
  }
  return false;
}

// ─── Auto-Sync Daemon ────────────────────────────────────────────────────────

const syncState = {
  watcher: null,
  fsWatchFallback: null,  // for Linux inotifywait/fswatch process
  debounceTimer: null,
  pendingFiles: new Set(),
  lastSyncTime: null,
  syncInProgress: false,
  syncCount: 0,
  errorCount: 0,
  lastError: null,
  projectDir: null,
  remoteProject: null,
  config: null,
  active: false,
  startedAt: null,
};

function log(msg) {
  process.stderr.write(`[pe-sync] ${msg}\n`);
}

function startAutoSync(projectDir, config) {
  if (syncState.active) return;

  const projectName = basename(projectDir);
  const remoteProject = `${config.dir}/${projectName}`;

  syncState.projectDir = projectDir;
  syncState.remoteProject = remoteProject;
  syncState.config = config;
  syncState.active = true;
  syncState.startedAt = new Date();
  syncState.syncCount = 0;
  syncState.errorCount = 0;
  syncState.lastError = null;

  log(`Watching ${projectDir} for changes`);
  log(`Remote: ${config.host}:${remoteProject}`);

  // Initial full sync (non-blocking — don't await)
  fullRsync().then(() => {
    log(`Initial sync complete`);
  }).catch((err) => {
    log(`Initial sync failed: ${err.message}`);
  });

  // Start file watcher
  if (platform() === "darwin") {
    // macOS: fs.watch with recursive works great (FSEvents-backed)
    try {
      syncState.watcher = fsWatch(projectDir, { recursive: true }, (eventType, filename) => {
        if (!filename || shouldExclude(filename)) return;
        syncState.pendingFiles.add(filename);
        debouncedSync();
      });
      syncState.watcher.on("error", (err) => {
        log(`Watcher error: ${err.message}`);
      });
    } catch (err) {
      log(`Failed to start watcher: ${err.message}`);
    }
  } else {
    // Linux: try inotifywait, then fswatch, then poll
    startLinuxWatcher(projectDir);
  }
}

function startLinuxWatcher(projectDir) {
  // Try inotifywait first (most Linux systems)
  try {
    const excludeRegex = `(${SYNC_EXCLUDES.filter(e => !e.includes("*")).join("|")})`;
    const proc = spawn("inotifywait", [
      "-r", "-m", "-q",
      "-e", "modify,create,delete,move",
      "--exclude", excludeRegex,
      "--format", "%w%f",
      projectDir,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    proc.stdout.on("data", (data) => {
      const files = data.toString().trim().split("\n");
      for (const f of files) {
        const rel = relative(projectDir, f);
        if (rel && !shouldExclude(rel)) {
          syncState.pendingFiles.add(rel);
        }
      }
      debouncedSync();
    });

    proc.on("error", () => {
      // inotifywait not available, try fswatch
      startFsWatchFallback(projectDir);
    });

    proc.on("close", (code) => {
      if (code !== 0 && syncState.active) {
        startFsWatchFallback(projectDir);
      }
    });

    syncState.fsWatchFallback = proc;
    return;
  } catch {
    // fall through
  }
  startFsWatchFallback(projectDir);
}

function startFsWatchFallback(projectDir) {
  try {
    const proc = spawn("fswatch", [
      "-o", "--exclude", "\\.git", "--exclude", "node_modules",
      projectDir,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    proc.stdout.on("data", () => {
      // fswatch -o just outputs event counts, do a full sync
      syncState.pendingFiles.add("*");
      debouncedSync();
    });

    proc.on("error", () => {
      log("No file watcher available (install inotifywait or fswatch). Auto-sync disabled.");
      syncState.active = false;
    });

    syncState.fsWatchFallback = proc;
  } catch {
    log("No file watcher available. Auto-sync disabled.");
    syncState.active = false;
  }
}

function stopAutoSync() {
  if (!syncState.active) return;

  syncState.active = false;

  if (syncState.watcher) {
    syncState.watcher.close();
    syncState.watcher = null;
  }
  if (syncState.fsWatchFallback) {
    syncState.fsWatchFallback.kill();
    syncState.fsWatchFallback = null;
  }
  if (syncState.debounceTimer) {
    clearTimeout(syncState.debounceTimer);
    syncState.debounceTimer = null;
  }

  syncState.pendingFiles.clear();
  log("Auto-sync stopped");
}

function debouncedSync() {
  if (syncState.debounceTimer) {
    clearTimeout(syncState.debounceTimer);
  }
  syncState.debounceTimer = setTimeout(() => {
    syncState.debounceTimer = null;
    triggerSync();
  }, 1500);
}

async function triggerSync() {
  if (syncState.syncInProgress || !syncState.active) return;

  const files = [...syncState.pendingFiles];
  syncState.pendingFiles.clear();

  if (files.length === 0) return;

  syncState.syncInProgress = true;
  const start = Date.now();

  try {
    // If wildcard or >10 files, do full rsync. Otherwise targeted push.
    if (files.includes("*") || files.length > 10) {
      await fullRsync();
    } else {
      await pushFiles(files);
    }
    syncState.syncCount++;
    syncState.lastSyncTime = new Date();
    const elapsed = Date.now() - start;
    log(`Synced ${files.length > 10 ? "all" : files.length + " file(s)"} in ${elapsed}ms`);
  } catch (err) {
    syncState.errorCount++;
    syncState.lastError = err.message;
    log(`Sync error: ${err.message}`);
  } finally {
    syncState.syncInProgress = false;

    // If more files queued during sync, trigger another
    if (syncState.pendingFiles.size > 0) {
      debouncedSync();
    }
  }
}

async function pushFiles(files) {
  const { config, projectDir, remoteProject } = syncState;
  if (!config) return;

  const safeKey = config.key.replace(/'/g, "'\\''");
  const safeProjectDir = projectDir.replace(/'/g, "'\\''");
  const safeRemoteProject = remoteProject.replace(/'/g, "'\\''");

  // Escape filenames for shell
  const fileList = files.map(f => f.replace(/'/g, "'\\''")).join("' '");

  // tar pipe: single SSH connection, sub-second for a few files
  const cmd = `cd '${safeProjectDir}' && tar cf - '${fileList}' 2>/dev/null | ssh -i '${safeKey}' -o StrictHostKeyChecking=no -o ConnectTimeout=5 ${config.user}@${config.host} "cd '${safeRemoteProject}' && tar xf - 2>/dev/null"`;

  const result = await runLocal(cmd, 30000);
  if (result.code !== 0) {
    // If tar pipe fails (e.g., file deleted between detect and sync), fall back to rsync
    await fullRsync();
  }
}

async function fullRsync() {
  const { config, projectDir, remoteProject } = syncState;
  if (!config) return;

  const safeProjectDir = projectDir.replace(/'/g, "'\\''");
  const safeKey = config.key.replace(/'/g, "'\\''");
  const safeRemoteProject = remoteProject.replace(/'/g, "'\\''");
  const excludeArgs = buildExcludeArgs();

  // Ensure remote dir exists
  await runSSH(config, `mkdir -p '${safeRemoteProject}'`).catch(() => {});

  const rsyncCmd = `rsync -azq --delete ${excludeArgs} --max-size='50m' -e "ssh -i '${safeKey}' -o StrictHostKeyChecking=no -o ConnectTimeout=5" '${safeProjectDir}/' '${config.user}@${config.host}:${safeRemoteProject}/'`;

  const result = await runLocal(rsyncCmd, 120000);
  if (result.code !== 0 && result.code !== 23 && result.code !== 24) {
    throw new Error(`rsync failed (exit ${result.code}): ${result.stderr || "unknown error"}`);
  }
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new Server(
  { name: "pocketeng", version: "1.3.0" },
  { capabilities: { tools: {} } }
);

const SERVER_PARAM = {
  type: "string",
  description:
    "Server profile name (e.g. 'work', 'personal'). Defaults to the active profile. Use pe_servers to list available profiles.",
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "pe_sync",
      description:
        "Sync the current project directory to the EC2 server via rsync. This pushes your local code to the remote server so it can be accessed from the Pocket Eng phone app. Optionally generates a handoff document from the current Claude session.",
      inputSchema: {
        type: "object",
        properties: {
          project_dir: {
            type: "string",
            description:
              "Absolute path to the project directory to sync. Defaults to current working directory.",
          },
          notes: {
            type: "string",
            description:
              "Optional handoff notes to include in .handoff.md on the remote server. Describe current state, pending tasks, and key context for the phone session.",
          },
          server: SERVER_PARAM,
        },
      },
    },
    {
      name: "pe_list_sessions",
      description:
        "List Claude Code sessions running on the EC2 server. Shows session IDs, project names, and timestamps.",
      inputSchema: {
        type: "object",
        properties: {
          server: SERVER_PARAM,
        },
      },
    },
    {
      name: "pe_status",
      description:
        "Check if a tmux session with Claude Code is currently running on the EC2 server, and verify SSH connectivity.",
      inputSchema: {
        type: "object",
        properties: {
          server: SERVER_PARAM,
        },
      },
    },
    {
      name: "pe_run_remote",
      description:
        "Run a shell command on the EC2 server via SSH. Useful for checking files, installing packages, or inspecting the remote environment.",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute on the remote server.",
          },
          server: SERVER_PARAM,
        },
        required: ["command"],
      },
    },
    {
      name: "pe_servers",
      description:
        "List all configured server profiles and which one is currently active. Use this to see available servers before syncing or running commands.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "pe_sync_status",
      description:
        "Check the status of the background auto-sync daemon. Shows whether auto-sync is active, how many syncs have completed, last sync time, and any errors.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "pe_handoff",
      description:
        "Hand off the current Claude Code session to a remote workspace so you can continue it from your phone. Syncs your code AND the session history — the phone app can resume exactly where you left off. Always use this when the user says 'hand off', 'continue on phone', 'send to phone', or similar.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: {
            type: "string",
            description:
              "The Claude Code session ID (UUID) to hand off. If not provided, uses the most recent session for the current project.",
          },
          project_dir: {
            type: "string",
            description:
              "Absolute path to the project directory. Defaults to current working directory.",
          },
          notes: {
            type: "string",
            description:
              "Handoff notes — what you were working on, what's left to do, any context the phone session needs.",
          },
          server: SERVER_PARAM,
          sync_code: {
            type: "boolean",
            description:
              "Whether to also sync the project code via rsync (default: true).",
          },
        },
      },
    },
    {
      name: "pe_pull",
      description:
        "Pull changes from the EC2 server back to your local machine (reverse sync). Use this after a phone session has made changes on the server that you want locally. Uses rsync with --update (newer wins) for safety — does NOT delete local files.",
      inputSchema: {
        type: "object",
        properties: {
          project_dir: {
            type: "string",
            description:
              "Absolute path to the local project directory. Defaults to current working directory.",
          },
          dry_run: {
            type: "boolean",
            description:
              "If true, shows what would be synced without actually transferring files.",
          },
          server: SERVER_PARAM,
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // These tools don't need a server config
  if (name === "pe_servers") {
    return handleServers();
  }
  if (name === "pe_sync_status") {
    return handleSyncStatus();
  }

  // All other tools: load config (optionally from a specific profile)
  const config = loadConfig(args?.server);

  if (!config || !config.host) {
    const profileMsg = args?.server
      ? `Server profile '${args.server}' not found or not configured.`
      : "Pocket Eng not configured. Run `pocketeng init` or `pocketeng setup` first.";
    return {
      content: [{ type: "text", text: profileMsg }],
      isError: true,
    };
  }

  try {
    switch (name) {
      case "pe_sync":
        return await handleSync(config, args);
      case "pe_list_sessions":
        return await handleListSessions(config);
      case "pe_status":
        return await handleStatus(config);
      case "pe_run_remote":
        return await handleRunRemote(config, args);
      case "pe_handoff":
        return await handleHandoff(config, args);
      case "pe_pull":
        return await handlePull(config, args);
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

// ─── Tool Handlers ───────────────────────────────────────────────────────────

function handleServers() {
  const profiles = listProfiles();
  if (profiles.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: "No servers configured. Run `pocketeng init` or `pocketeng setup` first.",
        },
      ],
    };
  }

  const lines = [`${profiles.length} server(s) configured:`, ""];
  for (const p of profiles) {
    const marker = p.active ? "●" : " ";
    const tag = p.active ? " (active)" : "";
    lines.push(`  ${marker} ${p.name.padEnd(16)} ${p.host}${tag}`);
  }
  lines.push("");
  lines.push(
    'Use the "server" parameter on pe_sync, pe_status, etc. to target a specific server.'
  );

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

async function handleSync(config, args) {
  const projectDir = args?.project_dir || process.cwd();
  const projectName = basename(projectDir);
  const remoteProject = `${config.dir}/${projectName}`;

  const lines = [];
  lines.push(`Syncing ${projectDir} -> ${config.host}:${remoteProject}`);

  // Create remote dir (escape single quotes in path)
  const safeRemoteProject = remoteProject.replace(/'/g, "'\\''");
  await runSSH(config, `mkdir -p '${safeRemoteProject}'`);

  // Write handoff notes if provided
  if (args?.notes) {
    const { writeFileSync } = await import("fs");
    const handoffPath = join(projectDir, ".handoff.md");
    writeFileSync(handoffPath, args.notes);
    lines.push("Wrote .handoff.md with handoff notes");
  }

  // Rsync
  const excludeArgs = buildExcludeArgs();
  // Shell-escape paths to handle spaces and special characters
  const safeProjectDir = projectDir.replace(/'/g, "'\\''");
  const safeKey = config.key.replace(/'/g, "'\\''");
  const rsyncCmd = `rsync -azq --delete ${excludeArgs} --max-size='50m' -e "ssh -i '${safeKey}' -o StrictHostKeyChecking=no" '${safeProjectDir}/' '${config.user}@${config.host}:${safeRemoteProject}/'`;

  const result = await runLocal(rsyncCmd, 120000);
  if (result.code !== 0) {
    lines.push(`rsync warning (exit ${result.code}): ${result.stderr || "some files may have been skipped"}`);
  }

  lines.push("Sync complete!");

  // Activate auto-sync watcher if not already running
  if (!syncState.active) {
    startAutoSync(projectDir, config);
    lines.push("Auto-sync watcher started — future file changes will sync automatically.");
  } else {
    lines.push("Auto-sync is active — file changes sync automatically.");
  }

  lines.push("");
  lines.push(`Remote path: ${remoteProject}`);
  lines.push("Open Pocket Eng app on phone to start a session on this project.");

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

async function handleListSessions(config) {
  const cmd = `find ~/.claude/projects -name '*.jsonl' ! -name 'agent-*' -printf '%T@ %p\\n' 2>/dev/null; exit 0`;
  const result = await runSSH(config, cmd);

  if (!result.stdout) {
    return {
      content: [{ type: "text", text: "No sessions found on the server." }],
    };
  }

  const lines = result.stdout.split("\n").filter(Boolean);
  const sessions = lines
    .map((line) => {
      const spaceIdx = line.indexOf(" ");
      const epochStr = line.substring(0, spaceIdx);
      const filePath = line.substring(spaceIdx + 1);
      const sid = basename(filePath, ".jsonl");
      const projectDir = basename(filePath.replace(`/${basename(filePath)}`, ""));

      // Make project name readable
      const parts = projectDir.split("-projects");
      let displayName;
      if (parts.length > 1) {
        const suffix = (parts[parts.length - 1] || "").replace(/^-/, "").replace(/-/g, " ");
        displayName = suffix || "Default";
      } else {
        displayName = projectDir;
      }

      const epoch = parseFloat(epochStr);
      const date = new Date(epoch * 1000);
      const ago = timeAgo(date);

      return { sid, displayName, date, ago };
    })
    .sort((a, b) => b.date - a.date);

  const output = [`Found ${sessions.length} session(s) on ${config.host}:`, ""];
  for (const s of sessions) {
    output.push(`  ${s.sid.substring(0, 8)}...  ${s.displayName.padEnd(20)}  ${s.ago}`);
  }

  return { content: [{ type: "text", text: output.join("\n") }] };
}

async function handleStatus(config) {
  const lines = [];

  // Test SSH
  const sshResult = await runSSH(config, "echo ok");
  if (sshResult.stdout !== "ok") {
    return {
      content: [
        {
          type: "text",
          text: `Cannot connect to ${config.host}. SSH connection failed.\n${sshResult.stderr}`,
        },
      ],
      isError: true,
    };
  }
  lines.push(`Connected to ${config.host}`);

  // Check tmux (CLI sessions)
  const tmuxResult = await runSSH(
    config,
    "tmux has-session -t pocketeng 2>/dev/null && echo RUNNING || echo STOPPED"
  );
  if (tmuxResult.stdout === "RUNNING") {
    lines.push("CLI session: RUNNING (tmux)");
  } else {
    lines.push("CLI session: not running");
  }

  // Check nohup processes (phone app sessions)
  const bgResult = await runSSH(
    config,
    "ls /tmp/pe-pid-*.* 2>/dev/null | while read f; do PID=$(cat \"$f\" 2>/dev/null); [ -n \"$PID\" ] && kill -0 $PID 2>/dev/null && echo ALIVE; done | wc -l; exit 0"
  );
  const bgCount = parseInt(bgResult.stdout.trim()) || 0;
  if (bgCount > 0) {
    lines.push(`Phone app tasks: ${bgCount} running`);
  }

  // Check disk
  const diskResult = await runSSH(config, "df -h / | tail -1 | awk '{print $4}'");
  if (diskResult.stdout) {
    lines.push(`Disk free: ${diskResult.stdout}`);
  }

  // Count sessions
  const countResult = await runSSH(
    config,
    "find ~/.claude/projects -name '*.jsonl' ! -name 'agent-*' 2>/dev/null | wc -l; exit 0"
  );
  lines.push(`Sessions on server: ${countResult.stdout.trim() || "0"}`);

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

async function handleRunRemote(config, args) {
  if (!args?.command) {
    return {
      content: [{ type: "text", text: "No command provided." }],
      isError: true,
    };
  }

  const result = await runSSH(config, args.command, 60000);
  const output = [];
  if (result.stdout) output.push(result.stdout);
  if (result.stderr) output.push(`stderr: ${result.stderr}`);
  if (!result.stdout && !result.stderr)
    output.push(`(no output, exit code ${result.code})`);

  return { content: [{ type: "text", text: output.join("\n") }] };
}

function handleSyncStatus() {
  const lines = [];

  if (!syncState.active) {
    lines.push("Auto-sync: INACTIVE");
    lines.push("");
    lines.push("Auto-sync starts automatically when you use pe_sync, or when a Claude Code session begins with a configured server.");
    if (syncState.syncCount > 0) {
      lines.push("");
      lines.push(`Previous session stats:`);
      lines.push(`  Syncs completed: ${syncState.syncCount}`);
      if (syncState.lastSyncTime) {
        lines.push(`  Last sync: ${timeAgo(syncState.lastSyncTime)}`);
      }
    }
  } else {
    lines.push("Auto-sync: ACTIVE ✓");
    lines.push("");
    lines.push(`Watching: ${syncState.projectDir}`);
    lines.push(`Remote: ${syncState.config?.host}:${syncState.remoteProject}`);
    lines.push(`Started: ${timeAgo(syncState.startedAt)}`);
    lines.push(`Syncs completed: ${syncState.syncCount}`);
    if (syncState.lastSyncTime) {
      lines.push(`Last sync: ${timeAgo(syncState.lastSyncTime)}`);
    }
    lines.push(`Pending changes: ${syncState.pendingFiles.size}`);
    lines.push(`Sync in progress: ${syncState.syncInProgress ? "yes" : "no"}`);
    if (syncState.errorCount > 0) {
      lines.push("");
      lines.push(`Errors: ${syncState.errorCount}`);
      if (syncState.lastError) {
        lines.push(`Last error: ${syncState.lastError}`);
      }
    }
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

async function handleHandoff(config, args) {
  const projectDir = args?.project_dir || process.cwd();
  const projectName = basename(projectDir);
  const syncCode = args?.sync_code !== false; // default true
  const lines = [];

  // 1. Find the session to hand off
  const claudeProjectsDir = join(homedir(), ".claude", "projects");

  let sessionId = args?.session_id;
  let sessionFile;

  if (sessionId) {
    // Specific session requested — search all project dirs
    const allDirs = existsSync(claudeProjectsDir)
      ? readdirSync(claudeProjectsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
      : [];
    for (const dir of allDirs) {
      const candidate = join(claudeProjectsDir, dir, `${sessionId}.jsonl`);
      if (existsSync(candidate)) {
        sessionFile = candidate;
        break;
      }
    }
    if (!sessionFile) {
      return {
        content: [{ type: "text", text: `Session ${sessionId} not found locally. Check the UUID and try again.` }],
        isError: true,
      };
    }
  } else {
    // Find most recent session — search project-specific dir first, then all dirs
    const localProjectHash = projectDir.replace(/\//g, "-");
    const localSessionDir = join(claudeProjectsDir, localProjectHash);

    let jsonlFiles = [];
    if (existsSync(localSessionDir)) {
      jsonlFiles = readdirSync(localSessionDir)
        .filter(f => f.endsWith(".jsonl") && !f.startsWith("agent-"))
        .map(f => ({
          name: f,
          path: join(localSessionDir, f),
          mtime: statSync(join(localSessionDir, f)).mtimeMs,
        }));
    }

    // If no sessions in project dir, search all dirs for the most recent
    if (jsonlFiles.length === 0) {
      const allDirs = existsSync(claudeProjectsDir)
        ? readdirSync(claudeProjectsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
        : [];
      for (const dir of allDirs) {
        const dirPath = join(claudeProjectsDir, dir);
        const files = readdirSync(dirPath)
          .filter(f => f.endsWith(".jsonl") && !f.startsWith("agent-"))
          .map(f => ({
            name: f,
            path: join(dirPath, f),
            mtime: statSync(join(dirPath, f)).mtimeMs,
          }));
        jsonlFiles.push(...files);
      }
    }

    jsonlFiles.sort((a, b) => b.mtime - a.mtime);

    if (jsonlFiles.length === 0) {
      return {
        content: [{ type: "text", text: "No Claude sessions found locally." }],
        isError: true,
      };
    }

    sessionFile = jsonlFiles[0].path;
    sessionId = jsonlFiles[0].name.replace(".jsonl", "");
  }

  const sessionSizeMB = (statSync(sessionFile).size / (1024 * 1024)).toFixed(1);
  lines.push(`Handing off session: ${sessionId}`);
  lines.push(`Workspace: ${config.host} (${sessionSizeMB}MB)`);

  // 2. Sync code first (if enabled)
  const remoteProject = `${config.dir}/${projectName}`;
  if (syncCode) {
    lines.push("");
    lines.push("Syncing code...");
    const safeProjectDir = projectDir.replace(/'/g, "'\\''");
    const safeKey = config.key.replace(/'/g, "'\\''");
    const safeRemoteProject = remoteProject.replace(/'/g, "'\\''");
    const excludeArgs = buildExcludeArgs();

    await runSSH(config, `mkdir -p ${remoteProject}`).catch(() => {});
    const rsyncCmd = `rsync -azq --delete ${excludeArgs} --max-size='50m' -e "ssh -i '${safeKey}' -o StrictHostKeyChecking=no" '${safeProjectDir}/' '${config.user}@${config.host}:${safeRemoteProject}/'`;
    const rsyncResult = await runLocal(rsyncCmd, 120000);
    if (rsyncResult.code !== 0 && rsyncResult.code !== 23 && rsyncResult.code !== 24) {
      lines.push(`Code sync warning (exit ${rsyncResult.code})`);
    } else {
      lines.push("Code synced.");
    }
  }

  // 3. Determine remote session directory
  // Claude Code indexes sessions by the working directory's absolute path turned into a hash.
  // We need to place the session file where Claude will find it when --resume is called
  // from the remote working directory.
  lines.push("");
  lines.push("Transferring session history...");

  // Resolve the actual absolute path of the remote project dir
  // Note: don't single-quote paths with ~ — the shell won't expand it
  await runSSH(config, `mkdir -p ${remoteProject}`).catch(() => {});
  const resolveResult = await runSSH(config, `cd ${remoteProject} && pwd`);
  const resolvedRemotePath = resolveResult.stdout.trim();

  // Claude Code uses the absolute path with / replaced by - as the directory name
  // e.g. /home/ec2-user/projects -> -home-ec2-user-projects
  const remoteProjectHash = resolvedRemotePath.replace(/\//g, "-");
  const remoteSessionDir = `~/.claude/projects/${remoteProjectHash}`;

  await runSSH(config, `mkdir -p '${remoteSessionDir}'`);

  // SCP the session file (longer timeout for large sessions)
  const safeKey = config.key.replace(/'/g, "'\\''");
  const scpTimeout = Math.max(60000, parseFloat(sessionSizeMB) * 10000); // ~10s per MB, min 60s
  const scpCmd = `scp -i '${safeKey}' -o StrictHostKeyChecking=no -o ConnectTimeout=10 '${sessionFile}' '${config.user}@${config.host}:${remoteSessionDir}/${sessionId}.jsonl'`;
  const scpResult = await runLocal(scpCmd, scpTimeout);

  if (scpResult.code !== 0) {
    return {
      content: [{ type: "text", text: `Failed to transfer session: ${scpResult.stderr || 'SCP failed'}` }],
      isError: true,
    };
  }

  // 4. Verify the session is findable on the remote
  const verifyResult = await runSSH(config,
    `cd '${resolvedRemotePath}' && test -f ~/.claude/projects/${remoteProjectHash}/${sessionId}.jsonl && echo FOUND || echo MISSING`
  );

  if (verifyResult.stdout.trim() !== "FOUND") {
    // Fallback: also try placing in the parent dir hash (~/projects instead of ~/projects/foo)
    const parentDir = resolvedRemotePath.replace(/\/[^/]+$/, "");
    const parentHash = parentDir.replace(/\//g, "-");
    const fallbackDir = `~/.claude/projects/${parentHash}`;
    await runSSH(config, `mkdir -p '${fallbackDir}'`);
    await runLocal(
      `scp -i '${safeKey}' -o StrictHostKeyChecking=no '${sessionFile}' '${config.user}@${config.host}:${fallbackDir}/${sessionId}.jsonl'`,
      scpTimeout
    );
    lines.push(`Session placed in fallback dir (${parentHash})`);
  } else {
    lines.push("Session transferred and verified.");
  }

  // 5. Write handoff notes if provided
  if (args?.notes) {
    // Use base64 encoding to safely pass notes with special characters
    const notesContent = `# Handoff Notes\n\n**Session:** ${sessionId}\n**From:** ${projectDir}\n**Time:** ${new Date().toISOString()}\n\n${args.notes}`;
    const notesB64 = Buffer.from(notesContent).toString("base64");
    await runSSH(config, `echo '${notesB64}' | base64 -d > ${remoteProject}/.handoff.md`);
    lines.push("Handoff notes written to .handoff.md");
  }

  // 6. Start auto-sync if not already running
  if (!syncState.active && syncCode) {
    startAutoSync(projectDir, config);
    lines.push("");
    lines.push("Auto-sync started — changes will keep syncing.");
  }

  lines.push("");
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push("Handoff complete! Open PocketEng on your phone.");
  lines.push(`Resume with: --resume ${sessionId}`);
  lines.push(`Remote dir: ${resolvedRemotePath}`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

async function handlePull(config, args) {
  const projectDir = args?.project_dir || process.cwd();
  const projectName = basename(projectDir);
  const remoteProject = `${config.dir}/${projectName}`;

  const safeProjectDir = projectDir.replace(/'/g, "'\\''");
  const safeKey = config.key.replace(/'/g, "'\\''");
  const safeRemoteProject = remoteProject.replace(/'/g, "'\\''");
  const excludeArgs = buildExcludeArgs();
  const dryRunFlag = args?.dry_run ? "--dry-run" : "";

  const lines = [];
  lines.push(`Pulling ${config.host}:${remoteProject} -> ${projectDir}`);

  // Reverse rsync: EC2 -> laptop, --update (newer wins), NO --delete for safety
  const rsyncCmd = `rsync -azv --update ${dryRunFlag} ${excludeArgs} --max-size='50m' -e "ssh -i '${safeKey}' -o StrictHostKeyChecking=no" '${config.user}@${config.host}:${safeRemoteProject}/' '${safeProjectDir}/'`;

  const result = await runLocal(rsyncCmd, 120000);

  if (result.code !== 0 && result.code !== 23 && result.code !== 24) {
    return {
      content: [{ type: "text", text: `Pull failed (exit ${result.code}): ${result.stderr || "unknown error"}` }],
      isError: true,
    };
  }

  if (args?.dry_run) {
    lines.push("");
    lines.push("DRY RUN — files that would be updated:");
    if (result.stdout) {
      // Filter rsync verbose output to just file names
      const files = result.stdout.split("\n").filter(l => l && !l.startsWith("sending") && !l.startsWith("sent") && !l.startsWith("total") && !l.endsWith("/"));
      if (files.length > 0) {
        for (const f of files.slice(0, 50)) {
          lines.push(`  ${f}`);
        }
        if (files.length > 50) {
          lines.push(`  ... and ${files.length - 50} more`);
        }
      } else {
        lines.push("  (no changes to pull)");
      }
    } else {
      lines.push("  (no changes to pull)");
    }
  } else {
    lines.push("Pull complete!");
    if (result.stdout) {
      const files = result.stdout.split("\n").filter(l => l && !l.startsWith("sending") && !l.startsWith("sent") && !l.startsWith("total") && !l.endsWith("/"));
      if (files.length > 0) {
        lines.push(`Updated ${files.length} file(s)`);
      } else {
        lines.push("No changes to pull — local files are up to date.");
      }
    }
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function timeAgo(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// ─── Start ───────────────────────────────────────────────────────────────────

(async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Auto-start sync watcher after MCP handshake — only if cwd is a real project
  try {
    const config = loadConfig();
    const cwd = process.cwd();
    // Don't sync from root, home, or other non-project dirs
    if (config?.host && cwd !== "/" && cwd !== homedir() && existsSync(join(cwd, ".git"))) {
      startAutoSync(cwd, config);
    } else {
      log(`Auto-sync deferred — will start on first pe_sync or pe_handoff call`);
    }
  } catch (err) {
    log(`Auto-sync deferred: ${err.message}`);
  }

  // Cleanup on exit
  function cleanup() {
    stopAutoSync();
  }

  server.onclose = cleanup;
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  process.on("exit", cleanup);
})();
