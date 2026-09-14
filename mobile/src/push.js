// ─────────────────────────────────────────────────────────────────────────────
// Push notifications (§40) — register this device's Expo push token with the
// server so approval requests and decisions reach the user instantly.
//
// Everything here is BEST EFFORT: Expo Go, emulators without Play services,
// or a missing EAS project id simply skip registration — never an error
// surface to the user. Real delivery requires a dev/production build
// (EAS), which is where these native modules actually work.
// ─────────────────────────────────────────────────────────────────────────────
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { deviceId } from './db';
import { api } from './api';

// How notifications behave while the app is OPEN (foreground).
export function configurePushHandling(onOpenEntity) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    }),
  });
  // Tapping a push (app foreground/background) → navigate to the entity.
  return Notifications.addNotificationResponseReceivedListener((response) => {
    try {
      const d = response?.notification?.request?.content?.data || {};
      if (onOpenEntity) onOpenEntity(d);
    } catch { /* never crash on a malformed payload */ }
  });
}

async function easProjectId() {
  return process.env.EXPO_PUBLIC_EAS_PROJECT_ID
    || Constants.expoConfig?.extra?.eas?.projectId
    || null;
}

/**
 * Ask OS permission, fetch the Expo push token, register it server-side
 * (idempotent per user+device — see /api/devices). Safe to call on every
 * sign-in and app start.
 */
export async function registerPushToken() {
  try {
    if (!Device.isDevice) return; // emulators can't receive remote push
    const projectId = await easProjectId();
    if (!projectId) return; // not configured yet — skip silently
    const cur = await Notifications.getPermissionsAsync();
    let status = cur?.status;
    if (status !== 'granted') {
      const req = await Notifications.requestPermissionsAsync();
      status = req?.status;
    }
    if (status !== 'granted') return; // user declined — respect it
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    if (!token) return;
    await api.registerDevice({
      device_id: await deviceId(),
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
      push_token: token,
      app_version: Constants.expoConfig?.version || '1.0.0',
    });
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'General',
        importance: Notifications.AndroidImportance.HIGH,
        lightColor: '#FF6B35',
      });
    }
  } catch {
    // Expo Go / no Play services / offline — push is optional, never fatal.
  }
}
