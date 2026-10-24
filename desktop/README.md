# Pocket Eng — Desktop

Electron shell around the Pocket Eng cloud dashboard. Runs any coding agent on the cloud by default — same model as the web and iOS apps.

## Install

Download the latest macOS DMG or Windows installer from [Releases](https://github.com/vaibs-d/pocketengineer/releases).

macOS first launch: right-click → Open if testing an unsigned local build.
Windows unsigned local builds will show Windows trust warnings until production code signing is configured.

## Develop

```bash
cd desktop
bun install
# In another terminal:
cd ../web && bun dev
# Back here:
bun run dev
```

The app loads `http://localhost:3000` when `PE_DESKTOP_DEV=1` is set.

## Build

```bash
bun run build            # signed + ready to publish (requires Apple signing env)
bun run build:unsigned   # local smoke test
bun run build:win:unsigned       # unsigned Windows x64 + arm64 installers
bun run build:win:x64:unsigned   # unsigned Windows x64 installer
bun run build:win:arm64:unsigned # unsigned Windows arm64 installer
```

Output: `dist/release/`.

## What it is

A thin Electron window that loads `https://console.pocketeng.ai`, plus:

- Native app menu (Reload, DevTools in dev, Check for Updates)
- `pocketeng-desktop://` deep-link handler for Supabase OAuth
- All external links route to the system browser
- Native badge/notifications via a small preload bridge
- Auto-update from GitHub Releases via `electron-updater`

## What it is not

- A local agent runner — sessions live on EC2, same as the web/iOS apps.
- A multi-window pane editor — that's v1.1 territory.
- A Windows local credential importer — Windows v1 uses subscription OAuth or API keys.

See `CLAUDE.md` for architecture details.
