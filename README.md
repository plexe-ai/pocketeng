<p align="center">
  <br />
  <img src="docs/logo.png" alt="Pocket Engineer" height="40" />
  <br />
  <br />
  <strong>AI coding agents on your cloud, from anywhere.</strong>
  <br />
  Claude Code, Codex, OpenCode -- sessions survive disconnects. Close your laptop, pick up on your phone.
  <br />
  <br />
  <a href="docs/getting-started.md">Getting Started</a> &nbsp;&bull;&nbsp;
  <a href="docs/how-it-works.md">How It Works</a> &nbsp;&bull;&nbsp;
  <a href="docs/commands.md">Commands</a> &nbsp;&bull;&nbsp;
  <a href="docs/phone-app.md">Phone App</a> &nbsp;&bull;&nbsp;
  <a href="SELF-HOSTING.md">Self-Hosting</a>
  <br />
  <br />
</p>

---

## Quick Start

### Option A: Web Dashboard

1. Sign up at [console.pocketeng.ai](https://console.pocketeng.ai)
2. Pick your agent, select GitHub repos, launch a workspace
3. Chat with your agent directly in the browser

### Option B: CLI

Install (macOS / Linux):

```bash
curl -fsSL https://pocketeng.ai/install | sh
```

Sign in and start:

```bash
pocketeng login
pocketeng
```

This SSHes into your EC2 and runs your coding agent in a tmux session. Close the terminal -- the session keeps running. Come back with:

```bash
pocketeng attach
```

### Option C: Bring Your Own Server

```bash
pocketeng setup --host 1.2.3.4 --key ~/.ssh/mykey.pem
```

### Option D: Desktop (macOS / Windows)

Download the latest DMG or Windows installer from [Releases](https://github.com/vaibs-d/pocketengineer/releases). Same dashboard as the web, packaged as a native window with deep-link OAuth and auto-update. The agent still runs on the cloud -- close your laptop and pick up on your phone.

See [desktop/README.md](desktop/README.md).

---

## How It Works

1. Provision a workspace from the web dashboard -- pick agent(s), repos, skills
2. The CLI connects via SSH and runs the agent in a **tmux** session
3. tmux keeps the process alive -- close your laptop, lose Wi-Fi, the agent keeps working
4. Run `pocketeng handoff` to transfer your local session + code to EC2
5. Open the web dashboard or phone app to continue from anywhere

Sessions from the CLI are direct SSH + tmux. Sessions from the web/phone go through the backend API which SSHes into your instance. Either way, the agent runs on your machine.

## Web Dashboard

The web dashboard at [console.pocketeng.ai](https://console.pocketeng.ai) lets you:

- Provision and manage cloud workspaces
- Chat with your coding agent in real time
- Pick your agent(s) and model (Opus, Sonnet, Haiku for Claude Code)
- Select GitHub repos to clone into the workspace
- Attach skills and configure tools
- Preview running dev servers inline (authenticated proxy with service discovery)
- View file diffs, create commits and PRs from the chat
- Connect existing servers (Bring Your Own Server)

## iOS App

The **Pocket Eng** iOS app gives you the full dashboard on your phone. Built with Capacitor, it loads the web dashboard in a native WKWebView.

- Sign in with Apple, GitHub, or Google -- all your workspaces sync automatically
- Chat with Claude Code in a structured UI, or use terminal view for Codex/OpenCode
- Preview running dev servers inline
- Manage workspaces -- start, stop, rename, delete

## Dev Server Preview

Preview running dev servers (Next.js, Flask, etc.) directly in the dashboard or phone app. An authenticated reverse proxy streams your app inline.

- Automatic service discovery scans for running dev servers (ports 3000-9000)
- Port selector for switching between multiple services
- Works for managed EC2 instances (direct HTTP) and BYOS servers (SSH tunnel fallback)

## Commands

| Command | What it does |
|---|---|
| `pocketeng login` | Sign in and sync workspaces |
| `pocketeng` | Start interactive session (SSH + tmux) |
| `pocketeng attach` | Reattach to running session |
| `pocketeng handoff` | Transfer local session + code to EC2 |
| `pocketeng servers` | List workspaces |
| `pocketeng switch <name>` | Switch active workspace |
| `pocketeng setup` | Connect a server manually |

The `--server <name>` flag works with any command.

## Configuration

| Variable | Description | Default |
|---|---|---|
| `PE_HOST` | Server IP or hostname | *(required)* |
| `PE_USER` | SSH user | `ec2-user` |
| `PE_KEY` | Path to SSH private key | `~/.ssh/pocketeng.pem` |
| `PE_DIR` | Remote working directory | `~/projects` |
| `PE_AGENT` | Coding agent | `claude` |

Config is stored in `~/.pocketeng/servers/<name>.conf`.

## Skills

Attach reusable skill packs to your workspace when provisioning. Skills inject context, conventions, and tools so the agent knows your stack from the start.

Built-in: Next.js, Python API, iOS Swift, Vercel deploy, Supabase, Testing, PR workflow.

See [docs/skills.md](docs/skills.md) for details.

## Self-Hosting

The entire stack is open source. Deploy to your own AWS account, use your own Supabase, run the iOS app with your own backend.

See **[SELF-HOSTING.md](SELF-HOSTING.md)** for the full guide.

## Project Structure

```
pocketeng              CLI (bash) -- SSH + tmux to EC2
web/                   Web dashboard (Next.js) + Capacitor iOS app (web/ios/)
desktop/               Desktop app (Electron shell around the web dashboard)
backend/               Backend API (AWS SAM, Python Lambdas, DynamoDB)
mcp-server/            MCP server for Claude Code (Node.js)
backend/src/lib/bridge/  Agent output normalizer (Codex/OpenCode), SFTP'd to EC2 on session launch
skills/                Built-in agent skills (markdown)
docs/                  Documentation
```

## Requirements

- macOS or Linux terminal (for the CLI)
- AWS account or an existing server
- API key for your chosen agent ([Anthropic](https://console.anthropic.com), [OpenAI](https://platform.openai.com))

## Contributors

This repository was published as a fresh snapshot, so the earlier commit history is not included. Thanks to everyone who built Pocket Engineer before the open-source release:

- [@vaibs-d](https://github.com/vaibs-d)
- [@arshadshk](https://github.com/arshadshk)
- [@marcellodebernardi](https://github.com/marcellodebernardi)
- [@Ayobami-00](https://github.com/Ayobami-00)

## License

Apache License 2.0. See [LICENSE](LICENSE).
