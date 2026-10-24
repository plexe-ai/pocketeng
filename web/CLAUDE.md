# Web Dashboard

Next.js web app for managing cloud coding workspaces. Also serves as the iOS and Android app via Capacitor.

## Stack

- Next.js 16.2 + React 19 + TypeScript 5.9
- Tailwind CSS 4.2 (via PostCSS)
- Supabase for auth (Apple OAuth, GitHub OAuth, Google OAuth, magic link)
- Capacitor 8.3 for iOS and Android apps (web shell loading `console.pocketeng.ai`)
- Deployed on Vercel

## iOS App (Capacitor)

The iOS app is a Capacitor web shell at `ios/`. It loads the production web dashboard in a WKWebView — no native UI code.

- **Config**: `capacitor.config.ts` — loads `console.pocketeng.ai` in production, `localhost:3000` in dev
- **OAuth**: Google OAuth uses `skipBrowserRedirect: true` + `Browser.open()` to open in SFSafariViewController (Google blocks WKWebView OAuth). The `/auth/native-callback` bridge page converts URL `#` fragments to `?` query params for the custom URL scheme redirect.
- **Keyboard**: `resize: 'native'` prevents keyboard covering input fields
- **Build**: Open `ios/App/App.xcodeproj` in Xcode, archive and upload to App Store Connect for TestFlight
- **Sync**: Run `npx cap sync ios` after npm changes to update native project

## Android App (Capacitor)

The Android app is a Capacitor web shell at `android/`. Same architecture as iOS — loads the web dashboard in a WebView.

- **Config**: Shares `capacitor.config.ts` with iOS. Android-specific settings in `android: {}` block.
- **OAuth**: Uses Chrome Custom Tabs (Capacitor's `Browser.open()`). Same `/auth/native-callback` bridge page as iOS.
- **Deep links**: Intent filter for `com.pocketengineer.coder://` scheme in `AndroidManifest.xml`
- **Push**: FCM via `google-services.json` (not committed — add from Firebase Console)
- **Build**: Open `android/` in Android Studio, or `./gradlew assembleRelease`
- **Sync**: Run `npx cap sync android` after npm changes
- **Sanity check**: See `.github/ANDROID.md` for the local JDK/SDK setup and debug build commands

## Commands

```bash
npm run dev              # Local dev on :3000
npm run build            # Build check before deploy
vercel --prod            # Deploy to production
npm run cap:sync         # Sync Capacitor iOS
npm run cap:sync:android # Sync Capacitor Android
npm run cap:open:android # Open in Android Studio
```

## Design System

All tokens are in `app/globals.css`:
- Colors: `--color-ink`, `--color-l1` through `--color-l4`, `--color-bright`, `--color-secondary`, `--color-tertiary`, `--color-accent` (#22c55e green)
- Surfaces: `.card-surface` for elevated cards, `.glass` for frosted glass
- Buttons: `.btn` base + `.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-danger`, `.btn-accent-outline`, `.btn-sm`
- Inputs: `.input` class
- Animations: `.animate-fade-in`, `.animate-fade-in-up`, `.animate-scale-in`, `.stagger`
- Effects: `.alive-border` (animated green border for running envs), `.glow-green`, `.press-scale`, `.hover-lift`

Reuse these classes. Don't create new CSS unless the design system doesn't cover it.

## Key Patterns

- App Router only (`app/` directory). No Pages Router.
- Default to Server Components. Add `'use client'` only when needed.
- Auth: Supabase JWT. `supabase.auth.getSession()` for token, passed as Bearer header to backend.
- API client: `lib/api.ts` — all backend calls go through this. Add new endpoints here.
- Config: `lib/supabase.ts` reads from env vars, never hardcoded.

## File Structure

```
app/
  page.tsx                  Landing / sign-in
  onboarding/page.tsx       Post-signup onboarding
  auth/callback/            OAuth callback
  auth/github-callback/     GitHub OAuth callback
  auth/native-callback/     Capacitor iOS OAuth bridge (converts # to ? params)
  api/preview/[serverId]/[port]/[[...path]]/
    route.ts                Authenticated reverse proxy for dev server previews
  dashboard/
    page.tsx                Workspace list + provision form
    settings/page.tsx       Account settings
    agents/page.tsx         Coding agent API key management
    skills/page.tsx         Skills library
    integrations/page.tsx   Slack, Linear integrations
    layout.tsx              Dashboard shell (sidebar + top bar)
components/
  Sidebar.tsx               Nav sidebar
  ServerCard.tsx            Workspace card with status, actions, expand
  ProvisionForm.tsx         New workspace form (agent, repos, tools, skills)
  ConnectForm.tsx           BYOS server connection form
  PreviewPanel.tsx          Dev server preview with service discovery + iframe

  UserProfile.tsx           Top-bar user avatar
lib/
  api.ts                    Backend API client (all endpoints)
  supabase.ts               Supabase client init
public/logos/               Agent logos (claude.png, openai.svg, opencode.png)
```

## Server Interface

The `Server` type in `lib/api.ts` defines what the backend returns. Key fields:
- `envType`: `'general' | 'ios' | 'byos'` — determines what actions are available
- `sshPrivateKey`: only populated for running servers (decrypted by backend)
- `agents`: array of installed agent IDs
- `label`: display name (BYOS servers show this instead of "Environment")

## Preview Proxy

Authenticated reverse proxy so users can preview dev servers (Next.js, Flask, etc.) inline in sessions.

- **Route**: `/api/preview/[serverId]/[port]/[[...path]]` — proxies HTTP to the EC2 instance
- **Auth**: `pe-preview-token` cookie (set by PreviewPanel from Supabase session), scoped to `/api/preview`
- **Fast path**: direct HTTP to `EC2_IP:PORT` (works for managed instances with SG ports 3000-9000 open)
- **SSH fallback**: if direct fails, calls backend `preview-proxy` action which SSHes in and curls `localhost:PORT`
- **PreviewPanel**: side panel with service discovery (`discoverServices()`), port pills, iframe, refresh, open-in-new-tab
- **URL detection**: `BashContent` in ChatWindow detects `localhost:PORT` URLs and shows "Preview :PORT" buttons
- **Ports**: restricted to 3000-9000

## Gotchas

- ProvisionForm collects API key "just in time" — not during onboarding
- `connectServer()` SSHs into the server from the backend Lambda to verify connectivity and detect installed agents
- The provision form has env type pills, agent pills (multi-select), repo picker, skill chips, tool toggles — all in one form, not a wizard
