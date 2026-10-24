# Desktop

Electron shell that wraps the production web dashboard at `https://console.pocketeng.ai` — same conceptual model as the iOS Capacitor app, for desktop.

The agent still runs on EC2. The desktop is a thin device.

## Stack

- Electron 33 + TypeScript 5
- `electron-builder` for packaging (macOS DMG, Windows NSIS)
- `electron-updater` for auto-update against GitHub Releases
- No renderer of our own — we load the deployed Next.js app

## Scripts

```bash
bun install              # install deps
bun run build:ts         # compile TS to dist/
bun run dev              # dev: PE_DESKTOP_DEV=1 + load localhost:3000
bun run build            # signed macOS DMGs in dist/release/
bun run build:unsigned   # unsigned DMG (local smoke test)
bun run build:win:unsigned       # unsigned Windows x64 + arm64 installers
bun run build:win:x64:unsigned   # unsigned Windows x64 installer
bun run build:win:arm64:unsigned # unsigned Windows arm64 installer
bun run test:unit        # pure Node unit tests for platform/deep-link helpers
bun run test:smoke       # launches Electron against a local static page
```

For `bun run dev` to work end-to-end, run `bun dev` inside `../web/` first so `localhost:3000` is up.

## Architecture

```
src/main/          Electron main process
  index.ts         App lifecycle, BrowserWindow, IPC handlers
  deep-link.ts     pocketeng-desktop:// protocol handler
  menu.ts          Native app menu
  updater.ts       electron-updater wiring
  config.ts        Dev vs prod load URL, update channel
src/preload/
  index.ts         contextBridge — exposes window.pocketengDesktop
src/shared/
  types.ts         Bridge API type shared between main and preload
```

## Renderer bridge

Preload exposes a single global on the web page:

```ts
window.pocketengDesktop = {
  version: '0.1.0',
  platform: 'macos' | 'windows',
  onDeepLink: (handler) => unsubscribe,
  openExternal: (url) => void,
  setBadgeCount: (n) => void,
}
```

The web app detects desktop by checking `!!window.pocketengDesktop` (see `web/lib/native.ts`).

## OAuth flow

Uses the desktop-specific `pocketeng-desktop://` scheme end-to-end:

1. Web app calls `supabase.auth.signInWithOAuth({ skipBrowserRedirect: true })`, gets a URL.
2. Web calls `window.open(url)` — Electron intercepts and opens in the system browser.
3. User completes OAuth. Provider redirects to `https://console.pocketeng.ai/auth/native-callback`.
4. That page rewrites the `#` fragment to `?` query params and redirects to `pocketeng-desktop://callback?access_token=...`.
5. The OS routes the URL to Electron: macOS via `open-url`, Windows via `second-instance` argv.
6. Main forwards to renderer via `pe:deep-link` IPC.
7. Renderer's `onDeepLink` handler (installed by `NativeBootstrap.tsx`) calls `supabase.auth.setSession(...)`.

No backend or Supabase changes. Same callback page the iOS app uses.

## External links

`webContents.setWindowOpenHandler` and `will-navigate` both route any off-origin URL to `shell.openExternal`. The Electron window stays on `console.pocketeng.ai` (or `localhost:3000` in dev).

## Auto-update

On app start and every 2h, `electron-updater` checks GitHub Releases (owner/repo configured in `electron-builder.yml`). When a new version downloads, the user is prompted to restart. "Check for Updates…" in the app menu triggers a manual check.

## Packaging

- `appId: com.pocketengineer.coder.desktop` (distinct from iOS bundle id).
- macOS: per-arch DMGs for x64 + arm64.
- Windows: per-arch unsigned NSIS installers for x64 + arm64. Production
  Windows signing is not configured yet; unsigned installers are for internal
  testing and will show Windows trust warnings.
- Hardened runtime + `build/entitlements.mac.plist` (allow-jit, network client, audio input for voice).
- Signing + notarization require `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` env vars when running `bun run build`. For local smoke tests use `bun run build:unsigned`.

## Not in v1

- Linux builds
- Windows local credential import
- Menu-bar tray
- Global hotkey
- Local SSH helper
- Multi-window workspace panes

## Versioning

Source of truth: `package.json` `version`. Independent of CLI (`../pocketeng` line 10) and iOS (`../web/ios/App/App.xcodeproj/project.pbxproj` MARKETING_VERSION).
