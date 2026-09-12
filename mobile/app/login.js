import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform, Alert,
} from 'react-native';
import { useAuth } from '../src/auth';
import { API_URL } from '../src/api';

const C = {
  bg: '#0b1220', panel: '#14203a', border: '#24344f', text: '#e6ecf5',
  muted: '#8fa0b8', accent: '#3b82f6', danger: '#ef4444',
};

export default function LoginScreen() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    if (!email || !password) return;
    setBusy(true);
    setError('');
    try {
      await login(email.trim(), password);
    } catch (e) {
      setError(e.message);
      Alert.alert('Sign-in failed', e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.wrap} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.card}>
        <Text style={styles.title}>Fleet Fuel</Text>
        <Text style={styles.sub}>Offline-capable fuel management</Text>
        {!!error && <Text style={styles.error}>{error}</Text>}
        <Text style={styles.label}>Email</Text>
        <TextInput
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
          placeholder="you@company.com"
          placeholderTextColor={C.muted}
        />
        <Text style={styles.label}>Password</Text>
        <TextInput
          style={styles.input}
          secureTextEntry
          value={password}
          onChangeText={setPassword}
          placeholder="••••••••"
          placeholderTextColor={C.muted}
        />
        <TouchableOpacity style={[styles.button, busy && { opacity: 0.5 }]} onPress={submit} disabled={busy}>
          <Text style={styles.buttonText}>{busy ? 'Signing in…' : 'Sign in'}</Text>
        </TouchableOpacity>
        {!API_URL && (
          <Text style={styles.error}>
            EXPO_PUBLIC_API_URL is not set — create mobile/.env from .env.example.
          </Text>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 420, backgroundColor: C.panel, borderColor: C.border, borderWidth: 1, borderRadius: 14, padding: 24 },
  title: { color: C.text, fontSize: 24, fontWeight: '700' },
  sub: { color: C.muted, fontSize: 13, marginTop: 4, marginBottom: 20 },
  label: { color: C.muted, fontSize: 12, marginBottom: 6, marginTop: 12 },
  input: { backgroundColor: C.bg, borderColor: C.border, borderWidth: 1, borderRadius: 8, color: C.text, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  button: { backgroundColor: C.accent, borderRadius: 8, paddingVertical: 12, alignItems: 'center', marginTop: 18 },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  error: { color: C.danger, fontSize: 12.5, marginTop: 10 },
});
