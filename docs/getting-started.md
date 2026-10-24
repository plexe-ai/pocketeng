# Getting Started

Set up Pocket Eng in under 5 minutes.

## What you need

- A Mac or Linux terminal
- An [Anthropic API key](https://console.anthropic.com) (or OpenAI key for Codex)

## Option A: Web Dashboard

1. Sign up at [console.pocketeng.ai](https://console.pocketeng.ai)
2. Pick your agent, select GitHub repos, launch a workspace
3. Chat with your agent directly in the browser

## Option B: CLI

Install (macOS / Linux):

```bash
curl -fsSL https://pocketeng.ai/install | sh
```

Sign in:

```bash
pocketeng login
```

This syncs your workspaces from the web dashboard. Then start a session:

```bash
pocketeng
```

The CLI connects via SSH and runs your agent in a tmux session. Close the terminal anytime -- the session keeps running.

Come back with:

```bash
pocketeng attach
```

## Transfer a local session to EC2

Working locally and want to continue on EC2 (or your phone)?

```bash
pocketeng handoff
```

This syncs your project code and transfers your Claude Code session file to the remote server. Then open the web dashboard or phone app to pick up where you left off.

## Connect your own server

Already have an EC2, VPS, or Mac?

```bash
pocketeng setup --host 1.2.3.4 --key ~/.ssh/mykey.pem
```

## Phone access

Sign into the **Pocket Eng** iOS app with the same account to access your workspaces from your phone.
