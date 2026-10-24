# Phone App

The Pocket Eng iOS app is a Capacitor web shell that loads the full web dashboard inside a native WKWebView. You get the same experience as the browser, packaged as a native app.

## Connect

### Option A: Sign in

1. Open the Pocket Eng app
2. Sign in with Apple, GitHub, or Google
3. All your workspaces appear automatically

## What you can do

- View and manage all your workspaces
- Start new coding sessions with any agent
- Chat with Claude Code in a structured UI
- Preview running dev servers inline
- Connect BYOS servers
- Manage API keys and integrations

## How it works

The app loads `console.pocketeng.ai` (or your self-hosted dashboard URL) in a WKWebView. Everything runs through the web dashboard -- there is no separate native UI or direct SSH from the phone.

OAuth (Google, GitHub, Apple) works through SFSafariViewController to satisfy provider requirements, then redirects back to the app via a custom URL scheme.

## Tips

- **Handoff from laptop:** Run `pocketeng sync` on your laptop, then open the project on your phone. Claude reads `.handoff.md` and picks up where you left off.
- **Multiple workspaces:** The app shows all workspaces tied to your account. Switch between them from the dashboard.
- **Dev server preview:** Start a dev server in a session, then use the Preview panel to see it running inline.
- **Keyboard:** The app uses native resize mode so the keyboard never covers input fields.
