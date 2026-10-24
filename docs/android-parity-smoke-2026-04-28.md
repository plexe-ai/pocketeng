# Android Parity Smoke — 2026-04-28

## Scope

Validated the Android Capacitor shell on an Android 36 Google APIs emulator
using the debug APK from `web/android`. The pass focused on native shell parity,
auth entry, basic signed-in navigation, keyboard behavior, lifecycle resume, and
push registration behavior without production Firebase config. The pass also
created a managed test workspace and started a Claude Code session.

Evidence screenshots and log snapshots live under:

```text
test-results/android-parity-2026-04-28/
```

## Environment

- AVD: `PocketEng_API36`
- System image: `system-images;android-36;google_apis;arm64-v8a`
- App package: `com.pocketengineer.coder`
- Build: debug APK from `./gradlew assembleDebug`
- Firebase: no `web/android/app/google-services.json` present
- Test workspace: `android-smoke-rust`

## Passed

- App launches to the auth screen.
- Email/password auth signs into the dashboard with a throwaway test account.
- Workspaces screen renders the new workspace form.
- Sessions tab renders the empty state.
- Settings tab renders account/settings controls.
- App returns from background to foreground without losing the signed-in route.
- Accepting Android notification permission no longer crashes the app when Firebase config is absent.
- Managed workspace creation succeeds with a throwaway Claude API key.
- Starting a Claude Code session from Android succeeds.
- Claude Code downloaded the `ferris-says` Rust crate into `/tmp/rust-crate-demo/ferris-says-0.3.1.crate`.

## Findings

| ID | Severity | Finding | Evidence | Suggested Ticket |
|---|---|---|---|---|
| AND-001 | Blocker | Android push registration crashed the app when `google-services.json` was absent. Fixed in this branch by initializing a placeholder Firebase app for non-FCM builds and adding a JS guard for future deployed web bundles. | `20-after-notification-allow-fixed.png`, `20-after-notification-allow-logcat.txt` | `fix(android): avoid push crash without Firebase config` |
| AND-002 | Release risk | Status bar background is white/gray over dark auth and dashboard screens. This is visually out of parity with the dark native shell. | `01-launch.png`, `20-after-notification-allow-fixed.png` | `fix(android): match status bar background to app theme` |
| AND-003 | Release risk | Magic-link email opens in Chrome and does not return to the Android app. The tested link used `redirect_to=https://console.pocketeng.ai/auth/callback`, so native auth stayed on the check-inbox screen. | `08-magic-link-opened.png`, `10-chrome-error-after-notifications.png`, `11-return-to-app.png` | `fix(android): route magic-link auth through native callback` |
| AND-004 | Follow-up | Google OAuth handoff was not fully validated because the fresh emulator hit Chrome first-run UX during the earlier pass. Re-test after native auth redirect is fixed or with Chrome pre-warmed. | `08-magic-link-opened.png`, `09-chrome-after-first-run.png` | `test(android): validate Google OAuth handoff on emulator` |
| AND-005 | Follow-up | The Android keyboard/stylus handwriting overlay can obscure the workspace form and made coordinate-based testing brittle. Manual users can dismiss it, but it is a UX risk during setup. | `23-workspace-name-keyboard.png`, `24-resume-after-background.png` | `fix(android): harden form layout around Android IME overlays` |
| AND-006 | Follow-up | Workspace/session flow passed, but preview links were not exercised because the smoke prompt did not start a dev server. | `64-open-workspace-detail.png`, `66-after-session-send.png`, `67-agent-response-30s.png` | `test(android): validate preview panel from a running dev server` |

## Notes

- The earlier crash stack was:

```text
FATAL EXCEPTION: CapacitorPlugins
java.lang.IllegalStateException: Default FirebaseApp is not initialized in this process com.pocketengineer.coder.
  at com.google.firebase.FirebaseApp.getInstance(FirebaseApp.java:179)
  at com.google.firebase.messaging.FirebaseMessaging.getInstance(FirebaseMessaging.java:120)
  at com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin.register(PushNotificationsPlugin.java:102)
```

- After the fix, notification permission returns `granted`, native registration emits `registrationError`, and JS logs `no token — banners will not be delivered`; the process stays alive.
- Production push still requires real Firebase config and `FCM_PLATFORM_APPLICATION_ARN`.
- The session prompt was: "Download a random Rust crate/package in this current session. Pick any harmless crate and download it, then tell me what you downloaded and where it is."
- Evidence that the prompt completed is in `67-agent-response-30s.png`.
