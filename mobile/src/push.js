// ─────────────────────────────────────────────────────────────────────────────
// Push notifications (§40) — device registration + Expo push token.
//
// TWO independent layers:
//  1. DEVICE REGISTRATION — always happens on sign-in, in every build
//     (release APK included): POST /api/devices with device_id, platform,
//     app_version and push_token: null when remote push isn't available.
//     This is what makes "Backend registration: SUCCESS" and keeps the
//     in-app notification pipeline + device audit working everywhere.
//  2. REMOTE PUSH TOKEN — best effort, only where it can actually work:
//     a real (non-Expo-Go) runtime, a physical device, notification
//     permission granted, and an EAS project ID present at build time
//     (EXPO_PUBLIC_EAS_PROJECT_ID in mobile/.env, or app.json
//     extra.eas.projectId, or the project id baked in by EAS CLI).
//     Self-built APKs (gradlew assembleRelease) usually have NO project id
//     unless you set it — every requirement that fails is recorded in
//     pushStatus.lastError and shown on the Push diagnostics screen.
//
// ⚠ expo-notifications THROWS AT IMPORT TIME in Expo Go on Android (removed
// in SDK 53). It must therefore NEVER be a static import: notificationsModule()
// lazy-loads it inside a guard.
// ─────────────────────────────────────────────────────────────────────────────
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { deviceId } from './db';
import { api } from './api';

let notifModule; // undefined = not tried yet, false = unavailable, object = ok
export function notificationsModule() {
  if (notifModule !== undefined) return notifModule;
  try {
    notifModule = require('expo-notifications');
  } catch {
    notifModule = false; // Expo Go (SDK 53+) / unsupported runtime
    console.info('[push] remote push unavailable in this runtime — in-app notifications still work. Use a development build for push.');
  }
  return notifModule;
}

// Live diagnosis consumed by app/push-diagnostics.js — plain data, no secrets.
export const pushStatus = {
  runtime: 'unknown',      // 'ok' | 'unavailable'
  isDevice: null,          // false = emulator
  projectId: null,
  projectIdSource: null,   // which config supplied the project id
  permission: null,        // OS notification permission status
  hasToken: null,          // null = not attempted, true/false = attempt result
  deviceRegistered: null,  // device row exists on the server
  tokenRegistered: null,   // server holds a push token for this device
  lastError: null,         // human-readable reason for the current state
};

// How notifications behave while the app is OPEN (foreground).
export function configurePushHandling(onOpenEntity) {
  const N = notificationsModule();
  if (!N) return { remove: () => {} }; // graceful no-op outside dev/prod builds
  try {
    N.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: true,
      }),
    });
    // Tapping a push (app foreground/background) → navigate to the entity.
    return N.addNotificationResponseReceivedListener((response) => {
      try {
        const d = response?.notification?.request?.content?.data || {};
        if (onOpenEntity) onOpenEntity(d);
      } catch { /* never crash on a malformed payload */ }
    });
  } catch {
    return { remove: () => {} };
  }
}

async function easProjectId() {
  if (process.env.EXPO_PUBLIC_EAS_PROJECT_ID) {
    return { id: process.env.EXPO_PUBLIC_EAS_PROJECT_ID, source: 'EXPO_PUBLIC_EAS_PROJECT_ID (.env at build time)' };
  }
  if (Constants?.expoConfig?.extra?.eas?.projectId) {
    return { id: Constants.expoConfig.extra.eas.projectId, source: 'app.json extra.eas.projectId' };
  }
  if (Constants?.easConfig?.projectId) {
    return { id: Constants.easConfig.projectId, source: 'EAS build metadata' };
  }
  return { id: null, source: null };
}

/**
 * Registers THIS DEVICE with the server (always — token optional), then tries
 * to obtain and attach a remote push token (best effort). Safe to call on
 * every sign-in, app start and manual refresh; never throws.
 */
export async function registerPushToken() {
  const did = await deviceId();
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';
  const appVersion = Constants?.expoConfig?.version || '1.0.0';

  // ── Layer 1: device registration — unconditional (works in EVERY build) ──
  try {
    await api.registerDevice({
      device_id: did,
      platform,
      push_token: null,
      app_version: appVersion,
    });
    pushStatus.deviceRegistered = true;
  } catch (e) {
    pushStatus.deviceRegistered = false;
    pushStatus.lastError = `Device registration failed: ${e?.message || 'network error'}`;
    return; // nothing else can succeed without connectivity
  }

  // ── Layer 2: remote push token — best effort, every gate recorded ──
  try {
    const N = notificationsModule();
    if (!N) {
      pushStatus.runtime = 'unavailable';
      pushStatus.lastError = 'expo-notifications not in this runtime (Expo Go) — in-app notifications only. Use a development/production build for push.';
      return;
    }
    pushStatus.runtime = 'ok';
    pushStatus.isDevice = !!Device.isDevice;
    if (!Device.isDevice) {
      pushStatus.lastError = 'Emulator — remote push needs a physical device (device is still registered for in-app notifications).';
      return;
    }

    const { id: projectId, source } = await easProjectId();
    pushStatus.projectId = projectId;
    pushStatus.projectIdSource = source;
    if (!projectId) {
      pushStatus.lastError = 'No EAS project ID in this build. Add EXPO_PUBLIC_EAS_PROJECT_ID=<id> to mobile/.env (or extra.eas.projectId in app.json) and rebuild — e.g. run "eas init".';
      return;
    }

    const cur = await N.getPermissionsAsync();
    let status = cur?.status;
    if (status !== 'granted') {
      const req = await N.requestPermissionsAsync();
      status = req?.status;
    }
    pushStatus.permission = status || 'unknown';
    if (status !== 'granted') {
      pushStatus.lastError = 'Notification permission not granted — enable notifications for this app in system settings.';
      return;
    }

    let token = null;
    try {
      const t = await N.getExpoPushTokenAsync({ projectId });
      token = t?.data || null;
    } catch (e) {
      pushStatus.lastError = `Push token fetch failed (${e?.message || 'error'}). On self-built APKs this usually means Google Play services / FCM is unavailable — “eas build” configures this automatically.`;
    }
    pushStatus.hasToken = !!token;
    if (!token) return;

    // Upgrade the device row with the token (COALESCE keeps it sticky).
    await api.registerDevice({
      device_id: did,
      platform,
      push_token: token,
      app_version: appVersion,
    });
    pushStatus.tokenRegistered = true;
    pushStatus.lastError = null;

    if (Platform.OS === 'android') {
      await N.setNotificationChannelAsync('default', {
        name: 'General',
        importance: N.AndroidImportance.HIGH,
        lightColor: '#FF6B35',
      });
    }
  } catch (e) {
    pushStatus.lastError = pushStatus.lastError || `Push setup failed: ${e?.message || 'error'}`;
  }
}
