---
type: learning
status: canonical
last_reviewed: 2026-04-28
related: []
tags: [android, capacitor, sync, push-notifications]
---

# Android Capacitor Sync Requires Committed Assets Directory

**When to read:** before validating or changing the Android Capacitor shell.
**When to update:** append links only; this records the 2026-04 Android validation incident.

## Summary

- `npm run cap:sync:android` failed because `web/android/app/src/main/assets/` did not exist.
- The generated config files inside that directory are gitignored, so the directory needs a tracked placeholder.
- Sync also exposed stale `@capacitor-community/speech-recognition` entries in generated Gradle files after the package had been removed.
- Android push registration was wired in JS/backend, but Android 13+ also needs `POST_NOTIFICATIONS` declared in the manifest.

## Incident

During an Android capability pass, `npm run cap:sync:android` failed with:

```text
Error: ENOENT: no such file or directory, open '.../web/android/app/src/main/assets/capacitor.config.json'
Error: ENOENT: no such file or directory, open '.../web/android/app/src/main/assets/capacitor.plugins.json'
```

Capacitor treats the missing web asset directory as acceptable when `server.url` is set, but it still writes `capacitor.config.json` and `capacitor.plugins.json` under `android/app/src/main/assets`. Because those generated files are ignored, the parent directory was absent in a fresh checkout.

After adding a tracked `.gitkeep`, sync succeeded and regenerated the Android plugin Gradle files. That removed stale `@capacitor-community/speech-recognition` references, matching the current `package.json` dependencies.

## Guardrail

For Android validation, run:

```bash
cd web
npm run cap:sync:android
```

If this fails on missing `android/app/src/main/assets`, do not work around it by hand-writing generated JSON. Keep the directory tracked and let Capacitor regenerate the files.

For push notification changes, check both layers:

- JS/backend registration path (`registerPushDevice`, FCM platform ARN).
- Android manifest permissions, especially `android.permission.POST_NOTIFICATIONS` for target SDK 33+.

## See also

- `../../.github/ANDROID.md` — local Android JDK/SDK setup and native build sanity commands.
- `learnings/2026-04-android-push-crash-without-firebase.md` — runtime crash when push registers without Firebase config.

## Referenced by

- None yet.
