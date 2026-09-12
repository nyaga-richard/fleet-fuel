import React, { useCallback, useState } from 'react';
import { View, Text, FlatList, StyleSheet, TouchableOpacity } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { pendingOps, outboxCount, deviceId, kvGet } from '../../src/db';
import { fullSync, getSyncState, onSyncChange } from '../../src/sync';
import { API_URL } from '../../src/api';

const C = {
  bg: '#0b1220', panel: '#14203a', border: '#24344f', text: '#e6ecf5',
  muted: '#8fa0b8', accent: '#3b82f6', green: '#22c55e', amber: '#f59e0b', red: '#ef4444',
};

export default function SyncScreen() {
  const [ops, setOps] = useState([]);
  const [count, setCount] = useState(0);
  const [device, setDevice] = useState('');
  const [lastSync, setLastSync] = useState(null);
  const [state, setState] = useState(getSyncState());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setOps(await pendingOps(100));
    setCount(await outboxCount());
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
    <View style={styles.wrap}>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>API URL</Text>
        <Text style={styles.mono}>{API_URL || 'NOT CONFIGURED (mobile/.env)'}</Text>
        <Text style={styles.cardTitle}>Device ID</Text>
        <Text style={styles.mono}>{device || '—'}</Text>
        <Text style={styles.cardTitle}>Last successful sync</Text>
        <Text style={styles.mono}>{lastSync ? new Date(lastSync).toLocaleString() : 'never'}</Text>
      </View>

      <TouchableOpacity style={[styles.button, busy && { opacity: 0.5 }]} onPress={syncNow} disabled={busy}>
        <Text style={styles.buttonText}>{busy ? 'Syncing…' : '🔄 Sync now'}</Text>
      </TouchableOpacity>

      <Text style={styles.section}>
        Offline queue — {count} pending operation(s)
      </Text>
      <Text style={[styles.muted, { marginBottom: 10 }]}>
        Queued operations survive app and device restarts. Each is applied to
        the server exactly once (duplicates are discarded automatically).
      </Text>
      <FlatList
        data={ops}
        keyExtractor={(item) => item.op_id}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={styles.cardTitle}>{item.type}</Text>
              <Text style={{ color: item.retry_count > 0 ? C.amber : C.green, fontSize: 11 }}>
                {item.retry_count > 0 ? `retry ${item.retry_count}/8` : 'queued'}
              </Text>
            </View>
            <Text style={styles.mono}>{item.created_at}</Text>
            {!!item.last_error && <Text style={[styles.muted, { color: C.red }]}>{item.last_error}</Text>}
          </View>
        )}
        ListEmptyComponent={<Text style={styles.muted}>✓ Queue is empty — everything is on the server.</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: C.bg, padding: 16 },
  card: { backgroundColor: C.panel, borderColor: C.border, borderWidth: 1, borderRadius: 10, padding: 14, marginBottom: 10 },
  cardTitle: { color: C.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 8 },
  mono: { color: C.text, fontSize: 12.5, fontFamily: undefined },
  section: { color: C.text, fontSize: 15, fontWeight: '600', marginVertical: 10 },
  muted: { color: C.muted, fontSize: 12 },
  button: { backgroundColor: C.accent, borderRadius: 8, paddingVertical: 12, alignItems: 'center', marginBottom: 10 },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 14 },
});
