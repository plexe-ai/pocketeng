---
type: learning
status: canonical
last_reviewed: 2026-04-28
related:
  - learnings/2026-04-android-capacitor-sync-assets.md
tags: [android, capacitor, firebase, push-notifications]
---

# Android Push Registration Crashes Without Firebase Config

**When to read:** before changing Android push registration or testing Android builds without `google-services.json`.
**When to update:** append links only; this records the 2026-04 Android emulator crash.

## Summary

- Android debug builds can compile without `web/android/app/google-services.json`.
- The deployed web app still calls Capacitor `PushNotifications.register()` after sign-in.
- Without a default Firebase app, that native call crashes the Android process instead of returning a JS error.
- Debug/smoke builds need a non-crashing Firebase fallback, while production builds still use real FCM config.

## Incident

During the Android parity smoke pass, accepting notification permission caused repeated app crashes. Logcat showed:

```text
FATAL EXCEPTION: CapacitorPlugins
java.lang.IllegalStateException: Default FirebaseApp is not initialized in this process com.pocketengineer.coder.
  at com.google.firebase.FirebaseApp.getInstance(FirebaseApp.java:179)
  at com.google.firebase.messaging.FirebaseMessaging.getInstance(FirebaseMessaging.java:120)
  at com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin.register(PushNotificationsPlugin.java:102)
```

The build script intentionally skips `com.google.gms.google-services` when `google-services.json` is absent, but the native app still includes the push plugin. The app therefore reached runtime with no default Firebase app.

## Guardrail

When testing Android without Firebase secrets:

- Build and install the debug APK.
- Trigger the native app after sign-in or any path that registers push.
- Check logcat for `AndroidRuntime` crashes from `PushNotificationsPlugin.register`.

Expected behavior is a graceful "push unavailable" path, not process death.

## See also

- `learnings/2026-04-android-capacitor-sync-assets.md` — earlier Android sync/push setup issue.

## Referenced by

- `learnings/2026-04-android-capacitor-sync-assets.md`
