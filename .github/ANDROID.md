# Android Builds

This project ships Android as a Capacitor web shell from `web/android/`. The
native project loads the hosted dashboard at `https://console.pocketeng.ai`, so
the native build sanity check focuses on proving the shell, Capacitor plugins,
manifest, Gradle wrapper, and Android SDK configuration compile together.

## Local Prerequisites

Install the minimal command-line toolchain:

```bash
brew install openjdk@21 android-commandlinetools
```

For the current shell, export:

```bash
export JAVA_HOME="/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"
export ANDROID_HOME="/opt/homebrew/share/android-commandlinetools"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="/opt/homebrew/opt/openjdk@21/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
```

Install the SDK packages used by `web/android/variables.gradle`:

```bash
yes | sdkmanager --licenses
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"
```

## Native Build Sanity

Run this sequence from a clean checkout:

```bash
cd web
npm ci
NEXT_PUBLIC_SUPABASE_URL=https://test.supabase.co \
  NEXT_PUBLIC_SUPABASE_ANON_KEY=test-anon-key \
  NEXT_PUBLIC_API_BASE_URL=https://example.com \
  npm run build
npm run cap:sync:android

cd android
./gradlew assembleDebug
./gradlew testDebugUnitTest
```

Passing `assembleDebug` proves the Android shell compiles without Play Store
signing or Firebase secrets. Passing `testDebugUnitTest` verifies the checked-in
Android unit-test target still runs.

## Release CI

The `Android Release` GitHub Actions workflow builds a signed Play-ready AAB
and uploads it as a workflow artifact. It does not upload to Play Console yet.
The Android shell loads the hosted dashboard via Capacitor `server.url`, so the
workflow syncs native config/plugins and does not build static Next.js assets
into the AAB.

The workflow follows the same CI versioning shape as TestFlight:

- Parse the checked-in iOS `MARKETING_VERSION` major/minor from
  `web/ios/App/App.xcodeproj/project.pbxproj`.
- Set Android `versionName` to `<ios_major>.<ios_minor>.<github.run_number>`.
- Set Android `versionCode` to `github.run_number`.
- Leave checked-in Android `versionName` / `versionCode` unchanged for local
  manual builds.

Required GitHub Actions secrets:

| Secret | Purpose |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | Base64-encoded release keystore |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | Release key alias |
| `ANDROID_KEY_PASSWORD` | Release key password |
| `ANDROID_GOOGLE_SERVICES_JSON` | Contents of `web/android/app/google-services.json` |

Manual trigger:

```bash
gh workflow run android-release.yml
```

## Known Notes

- `google-services.json` is not committed. Without it, the Google Services
  Gradle plugin is skipped and production FCM behavior is not exercised.
- Play Store upload is separate from the release artifact workflow.
- In restricted sandboxes, Gradle may fail before build execution with network
  or wildcard-IP errors. Run Gradle with normal host networking for local native
  validation.
