import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { AppState, Text, View, ActivityIndicator } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '../src/auth';
import { startAutoSync } from '../src/sync';
import { configurePushHandling } from '../src/push';
import { api } from '../src/api';
import { C } from '../theme';

const PROBE_THROTTLE_MS = 5 * 60 * 1000; // don't probe more than once per 5 min

function Bootstrap() {
  const { ready, user } = useAuth();
  const router = useRouter();
  const lastProbe = useRef(Date.now());

  useEffect(() => {
    // Auto-sync on connectivity restore / interval — only while signed in.
    if (user) startAutoSync();
  }, [user]);

  // Navigation reset on auth changes: replace() leaves nothing on the stack,
  // so the Android back button can never return to protected screens (§33).
  useEffect(() => {
    if (!ready) return;
    router.replace(user ? '/(tabs)' : '/login');
  }, [ready, user, router]);

  // Resume session check (spec §8): when the app returns from background,
  // quietly validate the token (throttled). A 401 anywhere → the central
  // handler signs the user out. Brief backgrounding never triggers anything.
  useEffect(() => {
    if (!user) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      if (Date.now() - lastProbe.current < PROBE_THROTTLE_MS) return;
      lastProbe.current = Date.now();
      api.me().catch(() => {}); // network errors are fine offline; 401 handles logout
    });
    return () => sub.remove();
  }, [user]);

  // §40 — push taps deep-link into the entity (approvals → Approvals screen).
  useEffect(() => {
    const sub = configurePushHandling((d) => {
      if (d?.entity_type === 'approval') router.push('/approvals');
      else if (d?.entity_type === 'fuel_request' && d?.entity_id) router.push(`/request/${d.entity_id}`);
    });
    return () => sub?.remove?.();
  }, [router]);

  // Startup splash (spec §7): never render protected screens before the
  // stored session has been evaluated.
  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
        <ActivityIndicator color={C.accent2} />
        <Text style={{ color: C.muted, fontSize: 13 }}>Checking session…</Text>
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#0b1220' } }}>
      {user ? <Stack.Screen name="(tabs)" /> : <Stack.Screen name="login" />}
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AuthProvider>
          <StatusBar style="light" />
          <Bootstrap />
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
