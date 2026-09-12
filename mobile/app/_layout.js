import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '../src/auth';
import { startAutoSync } from '../src/sync';

function Bootstrap() {
  const { ready, user } = useAuth();

  useEffect(() => {
    // Auto-sync on connectivity restore / interval — only while signed in.
    if (user) startAutoSync();
  }, [user]);

  if (!ready) return null;

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#0b1220' } }}>
      {user ? <Stack.Screen name="(tabs)" /> : <Stack.Screen name="login" />}
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="light" />
        <Bootstrap />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
