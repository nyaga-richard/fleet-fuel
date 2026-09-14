import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { Icon, Screen, ScreenHeader, Card, Btn, KV, Confirm, useNetState } from '../src/components';
import { useAuth } from '../src/auth';
import { api } from '../src/api';
import { deviceId, kvGet, outboxCount } from '../src/db';
import { C , ICON } from '../theme';
import { fmtDateTime } from '../src/fmt';

// Profile (spec §1–3): everything shown comes from the authenticated session
// (name/email/role) and the device's own sync state — nothing invented,
// no secrets (no tokens, no password fields).
export default function ProfileScreen() {
  const { user, logout } = useAuth();
  const router = useRouter();
  const net = useNetState();
  const [device, setDevice] = useState('');
  const [lastSync, setLastSync] = useState(null);
  const [pending, setPending] = useState(0);
  const [sessionOk, setSessionOk] = useState(null); // null = checking
  const [confirmOut, setConfirmOut] = useState(false);

  useFocusEffect(useCallback(() => {
    (async () => {
      setDevice(await deviceId());
      setLastSync(await kvGet('last_sync_success'));
      setPending(await outboxCount());
    })();
  }, []));

  // Quiet session verification (only when online) — shows real status.
  useEffect(() => {
    let alive = true;
    if (!net.isConnected) { setSessionOk(null); return () => { alive = false; }; }
    api.me()
      .then(() => { if (alive) setSessionOk(true); })
      .catch((e) => { if (alive) setSessionOk(e?.status === 401 ? false : null); });
    return () => { alive = false; };
  }, [net.isConnected]);

  const initials = String(user?.name || user?.email || '?')
    .split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

  async function doLogout() {
    setConfirmOut(false);
    // Root layout resets navigation on auth change → back button cannot
    // return here. Queued offline operations are deliberately KEPT.
    await logout();
  }

  return (
    <Screen scroll>
      <BackHeader onPress={() => router.back()} title="Profile" />

      {/* Identity — from the authenticated session only */}
      <Card style={{ alignItems: 'center', paddingVertical: 26 }}>
        <View style={s.avatarXL}><Text style={s.avatarXLText}>{initials}</Text></View>
        <Text style={{ color: C.text, fontSize: 19, fontWeight: '800', marginTop: 12 }} numberOfLines={1}>
          {user?.name || '—'}
        </Text>
        <Text style={{ color: C.accent2, fontSize: 12.5, fontWeight: '700', textTransform: 'capitalize', marginTop: 2 }}>
          {user?.role || '—'}
        </Text>
        <Text style={{ color: C.muted, fontSize: 12.5, marginTop: 4 }} numberOfLines={1}>{user?.email || ''}</Text>
      </Card>

      <Card>
        <KV rows={[
          ['Role', (user?.role || '—').replace(/^\w/, (c) => c.toUpperCase())],
          ['Email', user?.email || '—'],
          ['Session', sessionOk === true ? 'Verified just now' : sessionOk === false ? 'INVALID — you will be signed out' : net.isConnected ? 'Checking…' : 'Offline — using cached session'],
        ]} />
      </Card>

      <Card>
        <KV rows={[
          ['Device', device || '—'],
          ['Connection', net.isConnected ? 'Online' : 'Offline'],
          ['Last sync', lastSync ? fmtDateTime(lastSync) : 'never'],
          ['Pending operations', pending > 0 ? `${pending} queued` : 'None'],
        ]} />
        {pending > 0 && (
          <Text style={{ color: C.amber, fontSize: 12, marginTop: 10 }}>
            Pending operations are kept safely on this device — even after logout — and sync when the same account signs back in.
          </Text>
        )}
      </Card>

      <Btn label="Sync status" icon="sync" variant="secondary" onPress={() => router.push('/(tabs)/sync')} />
      <View style={{ height: 12 }} />
      <Btn label="Sign out" icon="logout" variant="danger" onPress={() => setConfirmOut(true)} />

      <Confirm
        visible={confirmOut}
        title="Sign out?"
        message={pending > 0
          ? `You have ${pending} operation(s) waiting to sync. They stay safely on this device and will sync next time this account signs in.`
          : 'You can sign back in any time. Queued offline work is never deleted.'}
        confirmLabel="Logout"
        danger
        onConfirm={doLogout}
        onCancel={() => setConfirmOut(false)}
      />
    </Screen>
  );
}

function BackHeader({ onPress, title }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingBottom: 12 }}>
      <TouchableOpacity onPress={onPress} accessibilityRole="button" accessibilityLabel="Go back" hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
        <Icon name="arrow-left" size={ICON.xl} color={C.accent2} />
      </TouchableOpacity>
      <Text style={{ color: C.text, fontSize: 17, fontWeight: '800' }}>{title}</Text>
    </View>
  );
}

const s = {
  avatarXL: {
    width: 84, height: 84, borderRadius: 42, backgroundColor: C.accent,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarXLText: { color: '#fff', fontSize: 28, fontWeight: '800' },
};
