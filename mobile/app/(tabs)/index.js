import React, { useCallback, useState } from 'react';
import { View, Text, FlatList, StyleSheet, RefreshControl } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useEffect } from 'react';
import { kvGet, cachedTransactions, outboxCount } from '../../src/db';
import { getSyncState, onSyncChange, fullSync } from '../../src/sync';

const C = {
  bg: '#0b1220', panel: '#14203a', border: '#24344f', text: '#e6ecf5',
  muted: '#8fa0b8', accent: '#3b82f6', green: '#22c55e', amber: '#f59e0b',
};

export default function HomeScreen() {
  const [stock, setStock] = useState([]);
  const [txns, setTxns] = useState([]);
  const [pending, setPending] = useState(0);
  const [lastSync, setLastSync] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const raw = await kvGet('stock_snapshot');
    setStock(raw ? JSON.parse(raw) : []);
    setTxns(await cachedTransactions(10));
    setPending(await outboxCount());
    setLastSync(await kvGet('last_sync_success'));
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => onSyncChange(() => { load(); }), [load]);

  async function refresh() {
    setRefreshing(true);
    await fullSync();
    await load();
    setRefreshing(false);
  }

  return (
    <View style={styles.wrap}>
      <Text style={styles.heading}>Fuel stock</Text>
      <Text style={styles.sub}>
        {lastSync ? `Last synced ${new Date(lastSync).toLocaleString()}` : 'Not synced yet'}
      </Text>
      <FlatList
        data={stock}
        keyExtractor={(item) => String(item.id || item.code)}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{item.name}</Text>
            <Text style={styles.cardValue}>
              {Number(item.balance || 0).toLocaleString()} {item.unit || 'L'}
            </Text>
            {Number(item.capacity) > 0 && (
              <>
                <View style={styles.bar}>
                  <View style={[styles.barFill, { width: `${Math.min((Number(item.balance) / Number(item.capacity)) * 100, 100)}%` }]} />
                </View>
                <Text style={styles.cardSub}>
                  {((Number(item.balance) / Number(item.capacity)) * 100).toFixed(0)}% of {Number(item.capacity).toLocaleString()} L capacity
                </Text>
              </>
            )}
          </View>
        )}
        ListEmptyComponent={(
          <Text style={styles.muted}>
            No stock data yet — pull down to sync, or check the Sync tab.
          </Text>
        )}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.muted} />}
      />
      <View style={styles.footer}>
        <Text style={[styles.muted, pending > 0 && { color: C.amber }]}>
          {pending > 0 ? `⏳ ${pending} offline change(s) queued — will sync automatically` : '✓ All changes synced'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: C.bg, padding: 16 },
  heading: { color: C.text, fontSize: 18, fontWeight: '700' },
  sub: { color: C.muted, fontSize: 12, marginBottom: 12 },
  card: { backgroundColor: C.panel, borderColor: C.border, borderWidth: 1, borderRadius: 10, padding: 14, marginBottom: 10 },
  cardTitle: { color: C.muted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5 },
  cardValue: { color: C.text, fontSize: 24, fontWeight: '700', marginVertical: 2 },
  cardSub: { color: C.muted, fontSize: 11, marginTop: 4 },
  bar: { height: 5, backgroundColor: C.border, borderRadius: 3, marginTop: 8, overflow: 'hidden' },
  barFill: { height: 5, backgroundColor: C.accent, borderRadius: 3 },
  muted: { color: C.muted, fontSize: 13 },
  footer: { paddingVertical: 10, alignItems: 'center' },
});
