# CLI Commands

Reference for the `pocketeng` CLI (v3+).

## Getting Started

| Command | Description |
|---|---|
| `pocketeng login` | Sign in via browser and sync workspaces from the web dashboard |
| `pocketeng setup` | Connect to a server manually (interactive prompts) |
| `pocketeng setup --host <ip> --key <path>` | Non-interactive setup |
| `pocketeng setup --host <ip> --key <path> --user <user> --dir <dir> --name <name>` | Full non-interactive setup with all options |

## Remote Sessions (agent runs on EC2 via tmux)

| Command | Description |
|---|---|
| `pocketeng` | Start an interactive session (SSH + tmux). Installs agent if missing. |
| `pocketeng attach` | Reattach to a running tmux session; starts a new one if none found |
| `pocketeng handoff [dir]` | One-shot transfer of local Claude Code session + code to EC2 |

## Local Sync (recommended — agent runs locally, state mirrors to cloud)

Run `pocketeng sync` from inside a project directory to pair it with your active workspace and start a background watcher. Edits mirror to the cloud every ~3 seconds so you can close your laptop and continue on your phone or web dashboard.

| Command | Description |
|---|---|
| `pocketeng sync` | Pull latest cloud state, then start background mirror of current dir → cloud |
| `pocketeng sync start` | Same as `pocketeng sync` |
| `pocketeng sync stop` | Stop the background watcher for the current directory |
| `pocketeng sync status` | Show all paired directories and their watcher state |
| `pocketeng sync pull` | One-shot pull of cloud state into current dir (no watcher started) |
| `pocketeng sync unpair` | Stop watcher and remove current dir from the pair list |

### How Sync Works

1. `cd` into your project directory.
2. Run `pocketeng sync` — pulls latest cloud state first, then starts a background daemon.
3. Run Claude Code (or any editor) normally. File changes mirror to the cloud in ~3 s.
4. Close your laptop. Open the phone app or web dashboard to continue.
5. Back at your laptop: run `pocketeng sync` (or `pocketeng sync pull`) to grab changes made on the phone/web before the daemon picks them up.

**Merge policy**: `--update` (newer mtime wins per file). Local-only files are never deleted.

## Workspaces

| Command | Description |
|---|---|
| `pocketeng servers` | List all configured workspaces |
| `pocketeng switch <name>` | Switch the active workspace |
| `pocketeng --server <name> <cmd>` | Run any command against a specific workspace without switching |

## Other

| Command | Description |
|---|---|
| `pocketeng help` | Show help |
| `pocketeng version` | Show installed version |

## Global Flag

| Flag | Description |
|---|---|
| `--server <name>` | Target a specific workspace for the duration of the command |

## Setup Options

`pocketeng setup` accepts the following flags for non-interactive use:

| Flag | Description |
|---|---|
| `--name <name>` | Profile name (default: `default`) |
| `--host <ip>` | Server IP or hostname |
| `--user <user>` | SSH user (default: `ec2-user`) |
| `--key <path>` | Path to SSH private key (default: `~/.ssh/pocketeng.pem`) |
| `--dir <path>` | Remote working directory (default: `~/projects`) |

## Config Files

| Path | Description |
|---|---|
| `~/.pocketeng/config` | Active workspace config (symlinked from the active profile) |
| `~/.pocketeng/servers/<name>.conf` | Per-workspace config files |
| `~/.pocketeng/active` | Name of the currently active workspace |
| `~/.pocketeng/token` | Auth token written by `pocketeng login` |
| `~/.pocketeng/pairs.json` | Map of local dirs to paired cloud workspaces |
| `~/.pocketeng/watchers/<hash>.log` | Sync daemon log for a paired directory |
