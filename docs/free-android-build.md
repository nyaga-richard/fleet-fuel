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

### Push notifications — getting `google-services.json` (free, ~15 min)

Two DIFFERENT files are involved — confusing them is the #1 cause of "token
works but nothing arrives":

| File | Where it lives | What it does |
|---|---|---|
| `google-services.json` | Inside the app (`android/app/`) | Lets the app register with FCM and fetch a push token |
| FCM v1 service-account key JSON | Expo's servers (EAS credentials) | Lets the **Expo push service** deliver notifications to FCM |

One-time setup:

1. **Create an Expo project id** (free, required by the push token):
   ```bash
   npm i -g eas-cli && eas login
   cd mobile && npx eas init      # writes extra.eas.projectId into app.json
   ```
   …then put the same id in `mobile/.env`:
   `EXPO_PUBLIC_EAS_PROJECT_ID=<id from eas init>`

2. **Firebase Console** (console.firebase.google.com, free):
   - *Create project* (or reuse one).
   - *Project settings → General → Your apps → Add app → Android*.
   - Package name must be exactly **`com.fleetfuel.app`** (matches app.json
     `android.package` — the file is useless with any other package name).
   - *Register app → Download google-services.json*.

3. **Place `google-services.json` in `mobile/`** (next to app.json) and point
   app.json at it so every `prebuild` copies it in automatically:
   ```json
   "android": {
     "package": "com.fleetfuel.app",
     "googleServicesFile": "./google-services.json"
   }
   ```
   (Alternative: manually drop it at `android/app/google-services.json` after
   each `prebuild` — prebuild regenerates `android/`, so the app.json way is
   safer. The Google Services Gradle plugin is applied by the template when
   the file is present.)

4. **Upload the FCM v1 key to Expo** (server side — Firebase console →
   *Project settings → Service accounts → Generate new private key* → JSON):
   ```bash
   npx eas credentials -p android
   # → Push Notifications → Set up a Google Service Account Key for Push
   #   Notifications (FCM V1) → upload the JSON you just generated
   ```
   This is what lets expo-server-sdk (our backend) deliver via FCM v1.
   Keep that JSON private — do NOT commit it.

5. Rebuild:
   ```bash
   npx expo prebuild -p android --clean && cd android && ./gradlew assembleRelease
   ```

6. Install, sign in, accept the notification permission, then check
   **System → Push diagnostics**: Backend registration SUCCESS, EAS project ID
   present, Token attached → *Send test notification*.

iOS additionally needs an APNs auth key (.p8) uploaded via
`eas credentials -p ios` — same screen, Apple side.

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

## Troubleshooting local builds

### `[CXX5304] This version only understands SDK XML versions up to 3 but an SDK XML file of version 4 was encountered`

The CMake configure step (`react-native-screens`, `react-native-worklets`, …) parses the
`package.xml` metadata of your installed SDK packages. Yours were installed/updated by
a NEWER SDK Manager than the reader inside the pinned NDK (27.1.12297006) understands —
an environment mismatch on the build machine, not a project problem (all Java/Kotlin
tasks compile fine; only the NDK/CMake tasks fail).

Fix in order:

1. **Refresh the SDK toolchain (fixes it most of the time):**
   Android Studio → **SDK Manager → SDK Tools** tab → tick *Show Package Details*:
   - update **Android SDK Build-Tools** (keep 36.0.0 installed — expo pins it),
   - update **Android SDK Platform-Tools**,
   - **uninstall, then re-install Android SDK Command-line Tools (latest)** — the
     reinstall rewrites the stale `package.xml` files coherently.
   Then `File → Invalidate Caches` and rebuild (`.\gradlew clean assembleRelease`).

2. **Find the offending package and remove it (if it's an extra you don't need):**
   ```powershell
   Get-ChildItem "$env:LOCALAPPDATA\Android\Sdk" -Recurse -Filter package.xml |
     Select-String -Pattern 'version="4"'
   ```
   If it points at a second platform/build-tools revision you don't use, uninstall that
   one revision in SDK Manager and rebuild.

3. **Upgrade the NDK (the reader itself):**
   SDK Manager → SDK Tools → *NDK (Side by side)* → Show Package Details → install the
   newest available (28.x/29.x). Then point the project at it: in
   `mobile/android/build.gradle` the root `ext { … }` block has
   `ndkVersion = "27.1.12297006"` — change it to the version you installed, save,
   then `./gradlew clean assembleRelease`.

4. **Escape hatch:** `eas build --profile preview -p android` (free tier, 30/month)
   builds on Expo's machines where the SDK is always internally consistent, while you
   fix the local toolchain.

Also worth doing while you're there — the build log warns the Gradle daemon runs out of
metaspace (it restarts mid-build, which is slow). In `mobile/android/gradle.properties`:

```
org.gradle.jvmargs=-Xmx4g -XX:MaxMetaspaceSize=1g -XX:+UseParallelGC
```

Benign log noise you can ignore: the `NODE_ENV is required` note from
`:expo-constants:createExpoConfig` (it still loads `.env` correctly), and the
deprecation warnings from netinfo / safe-area-context (third-party libraries).
