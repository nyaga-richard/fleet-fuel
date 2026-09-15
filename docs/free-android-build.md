# Building the Android app for free (no EAS paid plan needed)

EAS's free tier works (30 queue builds/month), but you can build **fully free
and unlimited on your own machine**. The Android tools are free; the build runs
on your computer, not on Expo's servers.

## Option A — local Gradle build (recommended, 100% free, forever)

One-time setup (~10 min):
1. Install **Node.js** (already have it), **JDK 17** (`winget install Microsoft.OpenJDK.17` or `sudo apt install openjdk-17-jdk`), and **Android Studio** (includes the Android SDK; open it once and let it install the default SDK components).
2. Set `ANDROID_HOME` to the SDK path Android Studio shows (e.g. `C:\Users\you\AppData\Local\Android\Sdk`).

Generate the native project and build (from `mobile/`):

```bash
npx expo prebuild -p android          # generates android/ from app.json (idempotent)
cd android
./gradlew assembleRelease             # Windows: gradlew.bat assembleRelease
```

The installable APK lands at
`android/app/build/outputs/apk/release/app-release.apk`.

First release build needs signing — generate a keystore **once** and keep it
safe (lose it = cannot update the installed app):

```bash
keytool -genkeypair -v -keystore fleetfuel.keystore -alias fleetfuel \
  -keyalg RSA -keysize 2048 -validity 10000
```

Then point Gradle at it (or simply run `./gradlew assembleDebug` for a
debug-signed APK you can install immediately for testing — no keystore needed).

### Configure the API URL for local builds
Create `mobile/.env` before `prebuild` (it is baked in at build time):

```
EXPO_PUBLIC_API_URL=https://api.fuel.trustedsystems.co.ke
EXPO_PUBLIC_EAS_PROJECT_ID=
```

Leave `EXPO_PUBLIC_EAS_PROJECT_ID` empty for Expo Go testing; for push in a
local build you still need an Expo project id — `npx eas init` is free and
only registers the project id (you can still build locally afterwards).

### Daily workflow
- JS-only changes while testing: `npx expo start` + the app on the phone
  (works with a locally built app via `npx expo start --dev-client`, or keep
  Expo Go for UI work — everything except remote push works there).
- Native/config changes or a new build to distribute: rerun
  `npx expo prebuild -p android` then `./gradlew assembleRelease`.

## Option B — EAS free tier (no local tooling)

`eas build --profile production --platform android` on the free queue
(30 builds/month). Fine for occasional releases; slower when the queue is busy.

## Option C — GitHub Actions (free minutes)

If the repo is on GitHub, a workflow running `npm ci && npx expo prebuild -p
android && cd android && ./gradlew assembleRelease` on `ubuntu-latest` uses
free runner minutes (2,000 min/month on private repos, unlimited on public).
Ask for this workflow file when you want it set up.

## What about Expo Go?
Expo Go remains perfect for day-to-day UI testing with zero builds — only
remote push is unavailable there (Android removed it in SDK 53). In-app
notifications (Alerts tab, badges, sync) work everywhere.
