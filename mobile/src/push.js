// ─────────────────────────────────────────────────────────────────────────────
// Push notifications (§40) — register this device's Expo push token with the
// server so approval requests and decisions reach the user instantly.
//
// ⚠ expo-notifications THROWS AT IMPORT TIME in Expo Go on Android (removed
// in SDK 53). It must therefore NEVER be a static import: notificationsModule()
// lazy-loads it inside a guard. In Expo Go / emulators the app runs normally
// and push is simply disabled — in-app notifications (Alerts tab + sync)
// always work regardless. Real push requires a development or production
// build (EAS), which is where the native module actually functions.
// ─────────────────────────────────────────────────────────────────────────────
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { deviceId } from './db';
import { api } from './api';

let notifModule; // undefined = not tried yet, false = unavailable, object = ok
function notificationsModule() {
  if (notifModule !== undefined) return notifModule;
  try {
    notifModule = require('expo-notifications');
  } catch {
    notifModule = false; // Expo Go (SDK 53+) / unsupported runtime
    console.info('[push] remote push unavailable in this runtime — in-app notifications still work. Use a development build for push.');
  }
  return notifModule;
}

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
  return process.env.EXPO_PUBLIC_EAS_PROJECT_ID
    || Constants.expoConfig?.extra?.eas?.projectId
    || null;
}

/**
 * Ask OS permission, fetch the Expo push token, register it server-side
 * (idempotent per user+device — see /api/devices). Safe to call on every
 * sign-in and app start; silently does nothing where push can't work.
 */
export async function registerPushToken() {
  try {
    const N = notificationsModule();
    if (!N) return;
    if (!Device.isDevice) return; // emulators can't receive remote push
    const projectId = await easProjectId();
    if (!projectId) return; // not configured yet — skip silently
    const cur = await N.getPermissionsAsync();
    let status = cur?.status;
    if (status !== 'granted') {
      const req = await N.requestPermissionsAsync();
      status = req?.status;
    }
    if (status !== 'granted') return; // user declined — respect it
    const { data: token } = await N.getExpoPushTokenAsync({ projectId });
    if (!token) return;
    await api.registerDevice({
      device_id: await deviceId(),
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
      push_token: token,
      app_version: Constants.expoConfig?.version || '1.0.0',
    });
    if (Platform.OS === 'android') {
      await N.setNotificationChannelAsync('default', {
        name: 'General',
        importance: N.AndroidImportance.HIGH,
        lightColor: '#FF6B35',
      });
    }
  } catch {
    // Expo Go / no Play services / offline — push is optional, never fatal.
  }
}
