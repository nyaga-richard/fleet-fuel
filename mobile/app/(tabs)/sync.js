import React, { useCallback, useState } from 'react';
import { View, Text, FlatList, RefreshControl } from 'react-native';
import { useFocusEffect } from 'expo-router';
import {
  Screen, ScreenHeader, Card, Btn, EmptyState, StatusBadge, useNetState,
} from '../../src/components';
import { pendingOps, outboxCount, deviceId, kvGet } from '../../src/db';
import { fullSync, getSyncState, onSyncChange } from '../../src/sync';
import { API_URL } from '../../src/api';
import { C } from '../../src/theme';
import { fmtDateTime, fmtRel } from '../../src/fmt';

// Sync status (spec §28) — never hides failures, never auto-deletes them.
export default function SyncScreen() {
  const net = useNetState();
  const [ops, setOps] = useState([]);
  const [count, setCount] = useState(0);
  const [failed, setFailed] = useState(0);
  const [device, setDevice] = useState('');
  const [lastSync, setLastSync] = useState(null);
  const [state, setState] = useState(getSyncState());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const all = await pendingOps(100);
    setOps(all);
    setCount(await outboxCount());
    setFailed(all.filter((o) => o.retry_count > 0).length);
    setDevice(await deviceId());
    setLastSync(await kvGet('last_sync_success'));
    setState(getSyncState());
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  useFocusEffect(useCallback(() => onSyncChange(() => load()), [load]));

  async function syncNow() {
    setBusy(true);
    await fullSync();
    await load();
    setBusy(false);
  }

  return (
    <Screen>
      <ScreenHeader
        title="Synchronization"
        subtitle={state.syncing ? 'Syncing now…' : net.isConnected ? 'Online' : 'Offline — changes stay queued'}
      />

      <Card>
        <View style={{ flexDirection: 'row', gap: 10, marginBottom: 12 }}>
          <View style={[s.stat, { flex: 1 }]}>
            <Text style={s.statLabel}>Pending</Text>
            <Text style={[s.statValue, { color: count > 0 ? C.amber : C.green }]}>{count}</Text>
          </View>
          <View style={[s.stat, { flex: 1 }]}>
            <Text style={s.statLabel}>Failed</Text>
            <Text style={[s.statValue, { color: failed > 0 ? C.red : C.green }]}>{failed}</Text>
          </View>
          <View style={[s.stat, { flex: 1.4 }]}>
            <Text style={s.statLabel}>Last sync</Text>
            <Text style={[s.statValue, { color: C.text, fontSize: 13, marginTop: 8 }]}>{fmtRel(lastSync)}</Text>
          </View>
        </View>
        <Text style={{ color: C.muted, fontSize: 12 }}>
          {lastSync ? `Last successful sync: ${fmtDateTime(lastSync)}` : 'Never synced on this device'}
          {' · '}{net.isConnected ? '● online' : '● offline'}
        </Text>
        {state.message && !state.syncing && (
          <Text style={{ color: state.ok ? C.green : C.amber, fontSize: 12, marginTop: 6 }}>{state.message}</Text>
        )}
        <Btn label={busy ? 'Syncing…' : '🔄 SYNC NOW'} onPress={syncNow} busy={busy} style={{ marginTop: 12 }} />
        {!net.isConnected && (
          <Text style={{ color: '#fcd34d', fontSize: 12, marginTop: 8 }}>
            You're offline. Everything you complete stays saved on this device and syncs when connectivity returns.
          </Text>
        )}
      </Card>

      {failed > 0 && (
        <Card style={{ borderColor: C.red, borderWidth: 1 }}>
          <Text style={{ color: C.red, fontSize: 13, fontWeight: '700' }}>{failed} item(s) failed to synchronize</Text>
          <Text style={{ color: C.muted, fontSize: 12, marginVertical: 4 }}>
            They are NEVER deleted automatically. Fix the cause (usually connectivity or a business rule) and retry.
          </Text>
          <Btn label="RETRY FAILED" variant="warn" onPress={syncNow} busy={busy} />
        </Card>
      )}

      <Card>
        <Text style={s.metaLabel}>API URL</Text>
        <Text style={s.mono}>{API_URL || 'NOT CONFIGURED (mobile/.env)'}</Text>
        <Text style={[s.metaLabel, { marginTop: 8 }]}>Device ID</Text>
        <Text style={s.mono}>{device || '—'}</Text>
      </Card>

      <Text style={{ color: C.muted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginVertical: 8 }}>
        Offline queue
      </Text>
      <FlatList
        data={ops}
        keyExtractor={(item) => item.op_id}
        renderItem={({ item }) => (
          <Card>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ color: C.text, fontSize: 13, fontWeight: '700' }}>{String(item.type).replace(/_/g, ' ')}</Text>
              <StatusBadge status={item.retry_count > 0 ? 'rejected' : 'pending'} />
            </View>
            <Text style={[s.mono, { marginTop: 4 }]}>{fmtDateTime(item.created_at)}</Text>
            {!!item.last_error && <Text style={{ color: C.red, fontSize: 12, marginTop: 4 }}>{item.last_error}</Text>}
            {item.retry_count > 0 && <Text style={{ color: C.amber, fontSize: 11.5, marginTop: 2 }}>retry {item.retry_count}/8</Text>}
          </Card>
        )}
        ListEmptyComponent={(
          <EmptyState icon="✓" title="Queue is empty" message="Everything from this device is on the server." />
        )}
        refreshControl={<RefreshControl refreshing={busy} onRefresh={syncNow} tintColor={C.muted} />}
        contentContainerStyle={{ paddingBottom: 30 }}
      />
    </Screen>
  );
}

const s = {
  stat: { backgroundColor: C.bg, borderColor: C.border, borderWidth: 1, borderRadius: 14, padding: 12 },
  statLabel: { color: C.muted, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.5 },
  statValue: { color: C.text, fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'] },
  metaLabel: { color: C.muted, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.5 },
  mono: { color: C.text, fontSize: 12.5, fontFamily: undefined },
};
