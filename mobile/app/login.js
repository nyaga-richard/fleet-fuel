import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Screen, Card, Btn, Field, Input } from '../src/components';
import { kvGet, kvRemove } from '../src/db';
import { useAuth } from '../src/auth';
import { API_URL } from '../src/api';
import { C, spacing as SP } from '../theme';

export default function LoginScreen() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    // Set by the central 401 handler when a session expires.
    (async () => {
      const n = await kvGet('session_notice');
      if (n) { setNotice(n); await kvRemove('session_notice'); }
    })();
  }, []);

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
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen keyboard scroll>
      <View style={{ flex: 1, justifyContent: 'center', paddingVertical: SP.xxxl }}>
        <Card style={{ maxWidth: 430, width: '100%', alignSelf: 'center', padding: SP.xxl }}>
          <Text style={{ color: C.text, fontSize: 24, fontWeight: '700', letterSpacing: -0.5 }}>⛽ Fleet Fuel</Text>
          <Text style={{ color: C.muted, fontSize: 14, marginTop: 4, marginBottom: SP.lg }}>
            Offline-capable fuel management
          </Text>
          {!!notice && <Text style={{ color: C.amber, fontSize: 12.5, marginBottom: SP.md, fontWeight: '600' }}>{notice}</Text>}
          {!!error && <Text style={{ color: C.red, fontSize: 12.5, marginBottom: SP.md, fontWeight: '600' }}>⚠ {error}</Text>}
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
            <Text style={{ color: C.red, fontSize: 12, marginTop: SP.md }}>
              EXPO_PUBLIC_API_URL is not set — create mobile/.env from .env.example and rebuild.
            </Text>
          )}
        </Card>
      </View>
    </Screen>
  );
}
