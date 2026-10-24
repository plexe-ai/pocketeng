# MCP Server

Use Pocket Eng tools directly inside Claude Code conversations on your laptop. Sync code, check server status, and run remote commands without leaving your editor.

## Setup

The MCP server is automatically registered when you run `pocketeng login` or `pocketeng setup`. It works with both **Claude Code CLI** and the **Claude Desktop app** -- no manual config needed.

<details>
<summary>Manual setup (if needed)</summary>

```bash
cd /path/to/pocketengineer/mcp-server
npm install
```

Add to `~/.claude/settings.json` (Claude Code) or `~/Library/Application Support/Claude/claude_desktop_config.json` (Claude Desktop):

```json
{
  "mcpServers": {
    "pocket-engineer": {
      "command": "node",
      "args": ["/path/to/mcp-server/index.js"]
    }
  }
}
```

</details>

## Auto-Sync

When a Claude Code session starts, the MCP server automatically:

1. Runs an initial full rsync to EC2 (non-blocking)
2. Watches your project directory for file changes
3. Syncs changes in the background with ~200-400ms latency

You don't need to do anything — it just works. Use `pe_sync_status` to check on it.

**How it syncs fast:** For small changes (1-10 files), it uses a targeted tar-over-SSH push instead of a full rsync scan. Changes are debounced (1.5s) so rapid edits batch into a single sync.

## Tools

### pe_sync

Sync your current project to EC2. Also starts the auto-sync watcher if it isn't already running.

```
"Sync this project to my server with notes about the auth refactor"
```

Claude will rsync your files and write a `.handoff.md` with your notes.

### pe_pull

Pull changes from EC2 back to your laptop (reverse sync). Use this after a phone session to get changes made remotely.

```
"Pull the latest changes from my server"
```

Uses `--update` (newer file wins) and never deletes local files — safe by default. Supports `dry_run` to preview changes first.

### pe_sync_status

Check whether auto-sync is active, how many syncs have completed, and any errors.

```
"Is auto-sync running?"
```

### pe_status

Check server connectivity, running sessions, and disk space.

```
"Check if anything is running on my server"
```

### pe_list_sessions

List Claude Code sessions on the server with timestamps.

### pe_run_remote

Run any command on your EC2 via SSH.

```
"Run 'ls ~/projects' on the server"
```

### pe_servers

List all configured server profiles.

## Targeting a specific server

Every tool accepts an optional `server` parameter:

```
"Sync this project to my work server"
```

Claude will pass `server: "work"` to `pe_sync`. If you don't specify, it uses your active profile.
