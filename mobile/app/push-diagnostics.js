import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Platform } from 'react-native';
import { Screen, ScreenHeader, Card, Btn, Icon, useTabBarPad } from '../src/components';
import { api } from '../src/api';
import { useAuth } from '../src/auth';
import { deviceId } from '../src/db';
import { C, spacing as SP } from '../theme';
import { fmtDateTime } from '../src/fmt';
import { notificationsModule } from '../src/push';

// §43 — authorized push diagnostics: real pipeline status (OS permission,
// device id, backend registration) + a REAL test push through Expo's
// servers. Tokens are masked by the API; nothing sensitive is rendered.
export default function PushDiagnostics() {
  const { user } = useAuth();
  const [rows, setRows] = useState(null);
  const [perm, setPerm] = useState('unknown');
  const [dev, setDev] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const bottomPad = useTabBarPad();

  const load = useCallback(async () => {
    try {
      const { myDevices, } = api;
      const d = await myDevices();
      setRows(d.devices || []);
    } catch { setRows([]); }
    setDev(await deviceId());
    try {
      const N = notificationsModule();
      if (N) {
        const p = await N.getPermissionsAsync();
        setPerm(p?.granted ? 'GRANTED' : p?.status || 'DENIED');
      } else setPerm('UNAVAILABLE (Expo Go / emulator) — use a development build');
    } catch { setPerm('unknown'); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (user?.role !== 'admin' && user?.role !== 'manager') {
    return (
      <Screen>
        <ScreenHeader title="Push diagnostics" subtitle="Administrator required" />
      </Screen>
    );
  }

  const primary = rows?.[0];

  return (
    <Screen scroll>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingBottom: 12 }}>
        <Text style={{ color: C.text, fontSize: 17, fontWeight: '800', flex: 1 }}>Push Notifications</Text>
      </View>

      <Card>
        <KV2 k="Permission" v={perm} good={perm === 'GRANTED'} />
        <KV2 k="Platform" v={Platform.OS} />
        <KV2 k="Device ID" v={dev ? `${dev.slice(0, 8)}…${dev.slice(-4)}` : '—'} />
        <KV2 k="Backend registration" v={primary ? (primary.active ? 'SUCCESS' : 'INACTIVE') : 'NOT REGISTERED'} good={!!primary?.active} />
        {primary && <KV2 k="Token" v={primary.push_token_masked || '—'} />}
        {primary && <KV2 k="Last token update" v={fmtDateTime(primary.last_seen_at)} />}
        {primary && <KV2 k="App version" v={primary.app_version || '—'} />}
      </Card>

      {!primary && (
        <Card style={{ marginBottom: SP.md }}>
          <Text style={{ color: '#fcd34d', fontSize: 12 }}>
            No device registered yet. Real push requires a development or production build — never Expo Go — plus notification permission and EXPO_PUBLIC_EAS_PROJECT_ID at build time. In-app notifications always work regardless.
          </Text>
        </Card>
      )}

      {!!msg && (
        <Card style={{ marginBottom: SP.md }}>
          <Text style={{ color: C.green, fontSize: 12.5 }}>{msg}</Text>
        </Card>
      )}

      <Btn
        label={busy ? 'Sending…' : 'SEND TEST NOTIFICATION'}
        busy={busy}
        disabled={!primary}
        onPress={async () => {
          setBusy(true); setMsg('');
          try {
            const r = await api.testPush();
            setMsg(r.devices_reachable > 0
              ? `Test push sent to ${r.devices_reachable} device(s). If the app is backgrounded you should see it on the lock screen within seconds.`
              : 'No reachable device — register a token from a real build first.');
            await load();
          } catch (e) { setMsg(`Failed: ${e.message}`); }
          finally { setBusy(false); }
        }}
        style={{ marginBottom: SP.md }}
      />
      <Text style={{ color: C.muted, fontSize: 11.5, paddingBottom: bottomPad }}>
        The test uses the full production pipeline — server, Expo push, FCM/APNs, then this device. It does not test in-app notification rendering; use the Alerts tab for that.
      </Text>
    </Screen>
  );
}

function KV2({ k, v, good }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.border, gap: 12 }}>
      <Text style={{ color: C.muted, fontSize: 12.5 }}>{k}</Text>
      <Text style={{ color: good === true ? C.green : good === false ? C.amber : C.text, fontSize: 12.5, fontWeight: '600', flexShrink: 1, textAlign: 'right' }} numberOfLines={2}>{v}</Text>
    </View>
  );
}
