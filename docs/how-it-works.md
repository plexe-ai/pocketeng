# How It Works

No magic. Just SSH, tmux, and your coding agent.

## The setup

Provision a workspace from the web dashboard at [console.pocketeng.ai](https://console.pocketeng.ai), or sign in via the CLI:

```
pocketeng login
```

The web dashboard launches an EC2 and installs your chosen agent, Node.js, Python, Git, tmux, and whatever tools you picked.

You get an SSH key and a security group. That's the entire infrastructure.

## The connection

```
 Your laptop                        Your EC2
┌────────────┐                   ┌────────────────┐
│ terminal   │ ──── SSH ────────►│ tmux session   │
│            │                   │  └─ claude      │
└────────────┘                   └────────────────┘
```

When you run `pocketeng`, it:

1. Opens an SSH connection to your EC2
2. Creates a **tmux** session named `pocketeng`
3. Runs your coding agent inside that tmux session

That's it. You're now talking to your agent on the server.

## Why tmux matters

tmux is a terminal multiplexer -- it keeps processes running even when you disconnect.

- Close your laptop lid -- tmux keeps the agent running
- Wi-Fi drops -- tmux keeps the agent running
- Reattach anytime with `pocketeng attach`

## The handoff

```
 Your laptop                        Your EC2
┌────────────┐     rsync         ┌────────────────┐
│ ~/my-app/  │ ─────────────────►│ ~/projects/    │
│            │                   │   my-app/      │
│ session.jsonl ────── scp ─────►│   session.jsonl│
└────────────┘                   └────────────────┘
```

`pocketeng handoff` transfers your local Claude Code session and project code to EC2. It rsyncs the project files, then copies the session file so you can resume the exact conversation from the web dashboard or phone app.

## The phone/web connection

```
 Your phone                         Your EC2
┌────────────┐                   ┌────────────────┐
│ Pocket Eng │ ── HTTPS ───────► │  Backend API   │
│ iOS app    │◄── JSON ──────────│  (Lambda)      │
│ (WKWebView)│                   │    │ SSH        │
└────────────┘                   │    ▼            │
                                 │  Coding Agent  │
                                 └────────────────┘
```

The phone app and web dashboard go through the backend API, which SSHes into your EC2 to start agents and relay output. They don't connect to EC2 directly.

## What you own

- **The EC2** -- it's in your AWS account, your region, your VPC
- **The SSH key** -- stored locally at `~/.pocketeng/`
- **The code** -- lives on your EC2
- **The sessions** -- Claude Code session files at `~/.claude/` on your EC2

From your laptop, it's direct SSH -- no relay. From your phone, the backend API acts as a bridge.
