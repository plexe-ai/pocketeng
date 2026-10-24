# MCP Server

Model Context Protocol server that exposes sync and session tools to Claude Code running on the EC2 instance.

## Stack

- Node.js + `@modelcontextprotocol/sdk`
- Single file: `index.js`
- Runs as stdio-based MCP server (JSON-RPC over stdin/stdout)

## Commands

```bash
npm install        # Install dependencies
node index.js      # Start (usually auto-started by Claude Code)
```

## Tools Exposed

| Tool | Description |
|---|---|
| `pe_sync` | Sync local project to EC2 via rsync. Starts background auto-sync watcher. |
| `pe_pull` | Reverse sync: EC2 → laptop. Uses `--update` (safer, no delete). |
| `pe_sync_status` | Auto-sync daemon status: active, sync count, last sync, errors. |
| `pe_status` | Server connectivity, tmux session, disk usage, session count. |
| `pe_list_sessions` | List Claude Code sessions on the server (reads .jsonl files). |
| `pe_run_remote` | Execute arbitrary shell command on EC2 via SSH. |
| `pe_servers` | List all configured server profiles and active one. |

## Auto-Sync

The sync daemon watches for file changes and syncs automatically:
- macOS: `fs.watch` with `recursive: true` (backed by FSEvents)
- Linux: falls back to `inotifywait` → `fswatch` → polling
- Debounce: 1500ms — collects multiple changes into one sync
- Small changes (<10 files): tar pipe over single SSH (sub-second)
- Large changes (>10 files): full rsync

## Config

Reads server profiles from `~/.pocketeng/servers/<name>.conf`:
```
PE_HOST="1.2.3.4"
PE_USER="ec2-user"
PE_KEY="~/.pocketeng/pe-abc123.pem"
PE_DIR="~/projects"
```

Active profile in `~/.pocketeng/active`.

## Gotchas

- All SSH paths must be shell-escaped (spaces, quotes, special chars)
- Rsync excludes 26+ patterns (node_modules, .git, .build, etc.) — hardcoded in index.js
- Respects `.gitignore` and `.pocketengignore` via rsync filter rules
- rsync exit codes 23 and 24 (partial transfer) are treated as success
- Auto-registered in Claude Code (`~/.claude/settings.json`) and Claude Desktop on `pocketeng login` or `pocketeng setup`
