# TestFlight Builds

## Automatic Triggers

Pushes to `main` that change any of these paths trigger a build automatically:
- `PocketEngineer/**`
- `PocketEngineer.xcodeproj/**`
- `.github/workflows/testflight.yml`

## Manual Trigger

```bash
gh workflow run testflight.yml
```

Or go to **Actions → TestFlight → Run workflow** on GitHub.

## Secrets Required

Set these in GitHub repo → Settings → Secrets → Actions:

| Secret | Value |
|--------|-------|
| `APPLE_TEAM_ID` | Apple Developer Team ID |
| `ASC_KEY_ID` | App Store Connect API Key ID |
| `ASC_ISSUER_ID` | App Store Connect Issuer ID |
| `ASC_API_KEY_P8` | Contents of the .p8 API key file (Admin role required) |

## Build Numbers

Build numbers auto-increment using `github.run_number`. No manual bumping needed.

## What It Does

1. Checks out code
2. Resolves Swift packages
3. Archives the app (unsigned)
4. Signs and uploads to TestFlight via App Store Connect API

Builds take ~5 minutes. The app appears in TestFlight after Apple's processing (~5-15 min).
