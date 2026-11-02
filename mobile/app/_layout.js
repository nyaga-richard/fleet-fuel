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
import { applyAppearance, watchSystemTheme, resolvedTheme, currentAppearance, onThemeApplied as subscribeTheme } from '../theme/colors';
import { kvGet } from '../src/db';
import { rebuildComponentStyles } from '../src/components';

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

// Root layout (§31–§40): loads the persisted appearance (default SYSTEM),
// re-themes live when the OS scheme changes under SYSTEM, and remounts the
// whole tree when the palette flips so module-scope styles rebuild too.
export default function RootLayout() {
  const [themeTick, setThemeTick] = useState(0);

  useEffect(() => {
    let alive = true;
    // Stored preference wins; default SYSTEM until first change (§32).
    kvGet('appearance')
      .then((p) => { if (alive) applyAppearance(p || 'SYSTEM'); })
      .catch(() => {});
    // Best-effort server mirror — theme must never depend on the network.
    kvGet('appearance')
      .then((p) => p && api('/api/me/theme', { method: 'PUT', body: JSON.stringify({ theme: p }) }).catch(() => {}))
      .catch(() => {});
    const unwatch = watchSystemTheme(() => currentAppearance());
    const off = subscribeTheme(() => {
      rebuildComponentStyles();          // module-scope shared styles re-create
      if (alive) setThemeTick((t) => t + 1); // remount screens → re-read C
    });
    return () => { alive = false; unwatch(); off(); };
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AuthProvider key={themeTick}>
          <StatusBar style={resolvedTheme() === 'DARK' ? 'light' : 'dark'} />
          <Bootstrap />
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}


