# PocketEngineer

> **Engineers and coding agents:** start at [`.harness/README.md`](.harness/README.md). It is the entry point for how we work here — protocols, playbooks, references, and bug scars.
>
> For the theory behind that design — what harness engineering is, where our practice agrees with the field and where it diverges — see [`docs/harness-research.md`](docs/harness-research.md).

AI coding agents running in the cloud, accessible from your phone, laptop, or web dashboard.

## Components

```
pocketeng              CLI (bash) — SSH + tmux to EC2
web/                   Web dashboard (Next.js 16) — manage workspaces
ios/                   iOS app (Capacitor web shell) — wraps web dashboard
desktop/               Desktop app (Electron shell) — wraps web dashboard; deep-link OAuth; auto-update
backend/               Backend API (AWS SAM, Python Lambdas) — provision, status, chat
backend/src/lib/bridge/  Agent bridge (Node.js) — SFTP'd to EC2 at session launch; normalizes Codex/OpenCode output + emits session events
mcp-server/            MCP server (Node.js) — sync tools for Claude Code
skills/                Built-in agent skills (markdown files)
```

Each folder has its own CLAUDE.md with specific guidance. Read the one for the folder you're working in.

## How They Connect

- **Web dashboard** calls **backend API** (Lambda) to provision/manage EC2 instances
- **Backend** stores server records in DynamoDB, SSH keys encrypted via KMS
- **CLI** connects directly to EC2 via SSH + tmux — no backend dependency
- **iOS app** — Capacitor shell that loads `console.pocketeng.ai` in a WKWebView. Uses SFSafariViewController for Google OAuth. No native code — just a web wrapper.
- **Desktop app** — Electron shell that loads `console.pocketeng.ai` in a Chromium window for macOS and Windows. Uses the desktop `pocketeng-desktop://` deep-link scheme for OAuth — OAuth opens in the system browser via `shell.openExternal`, lands back in the app via macOS `open-url` or Windows `second-instance` argv. Exposes `window.pocketengDesktop` to the renderer via contextBridge. Auto-updates from GitHub Releases via `electron-updater`.
- **MCP server** runs locally, exposes sync/remote-exec tools to Claude Code
- **Agent bridge** runs on EC2, wraps Codex/OpenCode SDKs to output Claude Code NDJSON format + post structured events to the backend. Source lives in `backend/src/lib/bridge/` and is SFTP'd to each workspace on session launch (no separate package/registry).

## EC2 conventions

Managed workspaces run Amazon Linux 2023 (`envType: "general"`). The
legacy macOS-on-mac2.metal path (`envType: "ios"`) was dropped in v1 —
expensive (24hr Dedicated Host minimums), slow to provision, and not
needed for the cloud-coding-agent core. SSH commands sent from the
backend Lambda only need to handle one OS now.

If we ever bring iOS-build workspaces back, the macOS-specific things to
re-handle were: `nohup` doesn't detach (use `&` + `</dev/null`),
`tail --pid` doesn't exist (poll `kill -0 $PID`), Homebrew lives at
`/opt/homebrew/bin` and isn't in non-interactive PATH, default shell is
`zsh` so `bash -l` won't source `.zprofile`. Worth knowing in case.

## What Never Gets Committed

- `.env.local`, `.env.*.local` — real API keys
- `backend/samconfig.toml` — has deployment secrets in parameter_overrides
- `.claude/settings.local.json` — may contain OAuth tokens
- `*.pem` — SSH private keys
- `ExportOptions.plist` — has Apple Team ID

## Key Concepts

- **Managed servers** — provisioned by our backend, stored in DynamoDB with `envType: "general"` or `"ios"`. Backend can start/stop/terminate them. Security group opens **only port 22** (SSH); dev-server ports are reachable via Cloudflare Tunnel outbound, not via a public SG rule. Workspaces provisioned before the Cloudflare tunnel migration (commit `926ed4a`) may still have 3000-9000 open — we don't rewrite existing SGs.
- **BYOS servers** — user's own servers, stored with `envType: "byos"`, `instanceId: "byos"`. Backend CANNOT start/stop EC2 for these. Lifecycle Lambda must skip them. Action handler must guard against EC2 calls on them.
- **Skills** — markdown files injected as `AGENTS.md` on the EC2 instance. Built-in skill IDs must match the `BUILT_IN_SKILLS` dict in `backend/src/lib/userdata.py`.
- **Preview proxy** — authenticated reverse proxy at `/api/preview/[serverId]/[port]/` lets users preview dev servers inline. Tries direct HTTP first, falls back to SSH tunnel via backend Lambda for BYOS/firewalled instances.

## Versioning

- CLI: `VERSION="x.y.z"` in `pocketeng` script line 10
- Web: `package.json` version (auto-deployed via Vercel)
- Backend: deployed via `sam deploy` (no version tag, CloudFormation manages state)
- iOS: Capacitor web shell — version in `ios/App/App.xcodeproj/project.pbxproj`
