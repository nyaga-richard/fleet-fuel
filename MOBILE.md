# Mobile App Deployment Guide

Complete walkthrough for building and distributing the **Fleet Fuel** mobile app
(Expo / React Native) — from a test device in your office to production builds
for your managers and pump attendants.

> The mobile app talks to the same backend as the web console:
> **`https://api.trustedsystems.co.ke`** (your production API through Cloudflare
> Tunnel). It works **offline** — requests and issues are queued in on-device
> SQLite and synced idempotently when connectivity returns.

---

## 0. Prerequisites

| # | Thing | Notes |
|---|-------|-------|
| 1 | Node 20 on your dev machine | same as backend/web |
| 2 | Expo account (free) | sign up at [expo.dev](https://expo.dev) — needed for EAS builds & updates |
| 3 | Your production API URL | `https://api.trustedsystems.co.ke` |
| 4 | (Android store) Google Play Developer account | $25 once — only if publishing to the Play Store |
| 5 | (iOS store) Apple Developer account | $99/yr — only for the App Store / TestFlight |

---

## 1. Configure the API URL

```bash
cd mobile
cp .env.example .env
```

Set the URL for the build type:

```env
# Production (what this guide builds):
EXPO_PUBLIC_API_URL=https://api.trustedsystems.co.ke

# Development on Wi-Fi with the backend running on your machine:
# EXPO_PUBLIC_API_URL=http://192.168.1.50:4000
```

> **Rules:** never `localhost` / `127.0.0.1` in a build that leaves your desk;
> the value is **baked in at build time** — changing it later means a new build.

---

## 2. Quick test on a real device (no store, 5 minutes)

Best for validating before doing any packaging:

```bash
cd mobile
npm install
npx expo start
```

- **Android:** install **Expo Go** from the Play Store → scan the QR code.
- **iPhone:** Camera app → scan the QR code (opens in Expo Go).

Sign in with a real user (create attendants in the web console: Users → Add user).
Then run the offline test:

1. Turn on **airplane mode**
2. Create a fuel request → it appears locally, marked queued
3. Create an issue against an approved request
4. Turn airplane mode **off** → open the **Sync** tab → both ops flush
5. Check the web console: each appears **exactly once** (idempotent sync)

---

## 3. Production Android build (APK for direct distribution)

The simplest production path — a self-contained APK you can share with staff
(WhatsApp/USB/email) and install directly. No store required.

```bash
cd mobile
npm install -g eas-cli          # once
eas login                       # your Expo account

eas build -p android --profile preview
```

The first build runs in Expo's cloud (~10–15 min, free tier available). When it
finishes you get a **download URL for `app-release.apk`**.

### ⚠️ EAS builds do NOT see your local `.env` — configure the API URL for EAS

`EXPO_PUBLIC_API_URL` is **inlined into the JS bundle at build time, on the
machine that builds**. For `eas build` that is Expo's cloud — your local
`mobile/.env` is not uploaded (it stays git-ignored, as it should). An APK
built without it starts with *"EXPO_PUBLIC_API_URL is not set"*. Configure it
ONCE with either method, then **rebuild** — editing `.env` never changes an
already-built APK:

**Method A (recommended — keeps the URL out of the repo entirely):**
1. Go to <https://expo.dev/projects> → your project → **Environment variables**
2. Add `EXPO_PUBLIC_API_URL` = `https://api.trustedsystems.co.ke`
   - Visibility: **Plain text** (it's a public URL, but plain text makes it
     visible to the build)
   - Create it for BOTH the **preview** and **production** environments.

**Method B (quick, in `mobile/eas.json` — the URL is public, not a secret):**

```json
{
  "build": {
    "preview":     { "android": { "buildType": "apk" },
                     "env": { "EXPO_PUBLIC_API_URL": "https://api.trustedsystems.co.ke" } },
    "production":  { "env": { "EXPO_PUBLIC_API_URL": "https://api.trustedsystems.co.ke" } }
  }
}
```
(merge into the profiles EAS generated — keep any existing keys)

Then rebuild and verify:

```bash
eas build -p android --profile preview
# install over the existing app (same package + keystore) → login screen
# must reach the server; Home → Sync tab shows the API URL it is using
```

Local dev with `npx expo start` keeps using `mobile/.env` exactly as before.

Distribute it:
- Send the APK to devices → open → allow "install from this source" → done.
- Each device gets its own `device_id`; sync logs in the server keep per-device
  records (`/api/sync/log`).

> **Keep the APK versioned** — name files like
> `fleet-fuel-1.0.0.apk` and bump `"version"` in `mobile/app.json` for every
> release you distribute.

### Play Store option (optional)

```bash
eas build -p android --profile production   # produces an .aab
eas submit -p android --latest              # after configuring credentials
```

---

## 4. Production iOS build

iOS always goes through Apple's tooling (no direct APK-style installs outside
TestFlight/Enterprise):

```bash
eas build -p ios --profile production
eas submit -p ios --latest     # sends to App Store Connect
```

- TestFlight (recommended for a small fleet team): upload, add your managers/
  attendants as testers, they install from the TestFlight app.
- Requires an Apple Developer account ($99/yr) and one-time certificate setup
  (`eas credentials` guides you through it).

---

## 5. Over-the-air updates (fix JS bugs without new store builds)

Expo Updates lets you push JavaScript-only fixes instantly to installed apps:

```bash
# publish a JS update (metadata in app.json: "runtimeVersion" policy applies)
eas update --branch production -m "Fix stock display rounding"
```

Users get the fix at next app start — no reinstall. Native-level changes
(new permissions, SDK upgrades) still require a fresh build.

Add to `mobile/app.json` to enable:

```json
"plugins": ["expo-router", "expo-updates"],
"extra": { "eas": { "projectId": "<from eas init>" } }
```

(`eas init` sets this up automatically.)

---

## 6. What users see / how it behaves

| Capability | Behaviour |
|---|---|
| Sign-in | JWT stored in on-device SQLite; survives app/device restarts |
| Reference data | Vehicles, fuel types, tanks, pumps cached at sync; reads are instant/offline |
| Create request / issue fuel | Works offline → queued in SQLite outbox |
| Sync triggers | after login, when connectivity returns, every 5 min, manual (Sync tab) |
| Idempotency | every op has an `op_id`; server applies it **exactly once** — replays are dropped |
| Failed ops | stay in the queue with the error visible in the Sync tab (retry capped at 8) |
| Server data | approvals always happen on the web console (PostgreSQL is the authority) |

## 7. Operations & troubleshooting

```bash
# Who is syncing, any failures? (on the server)
sudo docker compose -p fleet-fuel --env-file /opt/fleet-fuel/.env \
  -f docker-compose.yml -f docker-compose.prod.yml \
  exec postgres psql -U fleetfuel -d fleetfuel -c \
  "SELECT device_id, op_type, status, count(*) FROM sync_log
   WHERE created_at > now() - interval '7 days'
   GROUP BY 1,2,3 ORDER BY 1;"

# App can't connect
#   1. API reachable?  curl -s https://api.trustedsystems.co.ke/api/health
#   2. Was the app built with the PRODUCTION url? (mobile/.env at build time)
#   3. Device time correct? (JWT auth fails with big clock skew)

# "Authentication required" in the app
#   → the server JWT secret changed or token expired → sign out & back in
#     (the app keeps queued ops; they sync after re-login)
```

## 8. Release checklist

```text
[ ] mobile/.env → EXPO_PUBLIC_API_URL=https://api.trustedsystems.co.ke
[ ] bump version in mobile/app.json
[ ] offline test passed on a real device (airplane-mode round-trip, no duplicates)
[ ] login works with a real (non-admin) account
[ ] eas build -p android --profile preview → APK archived + shared
[ ] (iOS) TestFlight build distributed to testers
[ ] tag the release: git tag -a mobile-v1.0.0 && git push --tags
```
