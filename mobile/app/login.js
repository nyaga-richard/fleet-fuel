import React, { useState } from 'react';
import { Text, Alert } from 'react-native';
import { Screen, Card, Btn, Field, Input } from '../src/components';
import { useAuth } from '../src/auth';
import { API_URL } from '../src/api';
import { C } from '../src/theme';

export default function LoginScreen() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    if (busy || !email || !password) return;
    setBusy(true);
    setError('');
    try {
      await login(email.trim(), password);
    } catch (e) {
      const msg = e?.status === 0
        ? "You're offline — sign-in needs connectivity. Queued work stays saved."
        : e?.status === 401
          ? 'Wrong email or password.'
          : e.message;
      setError(msg);
      Alert.alert('Sign-in failed', msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen keyboard scroll>
      <Card style={{ maxWidth: 430, width: '100%', alignSelf: 'center', marginTop: '20%', padding: 24 }}>
        <Text style={{ color: C.text, fontSize: 26, fontWeight: '800' }}>⛽ Fleet Fuel</Text>
        <Text style={{ color: C.muted, fontSize: 13, marginTop: 4, marginBottom: 18 }}>
          Offline-capable fuel management
        </Text>
        {!!error && <Text style={{ color: C.red, fontSize: 12.5, marginBottom: 10 }}>⚠ {error}</Text>}
        <Field label="Email">
          <Input
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="emailAddress"
            autoComplete="email"
            value={email}
            onChangeText={setEmail}
            placeholder="you@company.com"
            returnKeyType="next"
          />
        </Field>
        <Field label="Password">
          <Input
            secureTextEntry
            textContentType="password"
            autoComplete="password"
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            onSubmitEditing={submit}
            returnKeyType="done"
          />
        </Field>
        <Btn label={busy ? 'Signing in…' : 'Sign in'} busy={busy} onPress={submit} disabled={!email || !password} />
        {!API_URL && (
          <Text style={{ color: C.red, fontSize: 12, marginTop: 12 }}>
            EXPO_PUBLIC_API_URL is not set — create mobile/.env from .env.example and rebuild.
          </Text>
        )}
      </Card>
    </Screen>
  );
}
