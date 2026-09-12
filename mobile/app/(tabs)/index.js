import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, FlatList, RefreshControl, TouchableOpacity } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useRouter } from 'expo-router';
import { Screen, ScreenHeader, Card, StatusBadge, Btn, EmptyState, OfflineBanner } from '../../src/components';
import { kvGet, cachedTransactions, cachedRequests, outboxCount } from '../../src/db';
import { getSyncState, onSyncChange, fullSync } from '../../src/sync';
import { useAuth } from '../../src/auth';
import { C } from '../../src/theme';
import { fmtQty, fmtNum, fmtRel, fmtDateTime, todayKey } from '../../src/fmt';

// Role-aware dashboard (spec §29–30):
//   manager/admin → stock, issued today, pending requests, pending sync
//   attendant     → authorized requests ready to fuel, today's fueling, sync
export default function HomeScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const isAttendant = user?.role === 'attendant';
  const canIssue = ['attendant', 'manager', 'admin'].includes(user?.role);

  const [stock, setStock] = useState([]);
  const [txns, setTxns] = useState([]);
  const [requests, setRequests] = useState([]);
  const [pendingOps, setPendingOps] = useState(0);
  const [lastSync, setLastSync] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const raw = await kvGet('stock_snapshot');
    setStock(raw ? JSON.parse(raw) : []);
    setTxns(await cachedTransactions(200));
    setRequests(await cachedRequests(200));
    setPendingOps(await outboxCount());
    setLastSync(await kvGet('last_sync_success'));
    setSyncing(!!getSyncState().syncing);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => onSyncChange(() => { load(); }), [load]);

  async function refresh() {
    setRefreshing(true);
    await fullSync();
    await load();
    setRefreshing(false);
  }

  const today = todayKey();
  const issuedToday = txns
    .filter((t) => String(t.created_at || '').slice(0, 10) === today && !t.reversal_of)
    .reduce((a, t) => a + Number(t.quantity || 0), 0);
  const pendingCount = requests.filter((r) => r.status === 'pending').length;
  const approvedCount = requests.filter((r) => r.status === 'approved').length;
  const recent = txns.slice(0, 8);

  return (
    <Screen>
      <ScreenHeader
        title={`Hello, ${(user?.name || 'there').split(' ')[0]}`}
        subtitle={isAttendant ? 'Attendant · ready to fuel' : `${(user?.role || '').replace(/^\w/, (c) => c.toUpperCase())} overview`}
        right={<TouchableOpacity onPress={() => router.push('/(tabs)/sync')} accessibilityLabel="Open sync status">
          <Text style={{ color: pendingOps > 0 ? C.amber : C.muted, fontSize: 12, fontWeight: '600' }}>
            {syncing ? '⟳ Syncing…' : pendingOps > 0 ? `⏳ ${pendingOps} queued` : '✓ Synced'}
          </Text>
        </TouchableOpacity>}
      />
      <OfflineBanner lastSync={lastSync} />

      <FlatList
        data={recent}
        keyExtractor={(item) => String(item.id)}
        ListHeaderComponent={(
          <>
            <View style={{ flexDirection: 'row', gap: S_GAP }}>
              <StatBox label={isAttendant ? 'Ready to fuel' : 'Pending requests'} value={fmtNum(isAttendant ? approvedCount : pendingCount)} tone={isAttendant ? (approvedCount > 0 ? C.green : C.muted) : (pendingCount > 0 ? C.amber : C.green)} onPress={() => router.push('/(tabs)/requests')} />
              <StatBox label="Issued today" value={fmtQty(issuedToday, '')} tone={C.accent2} onPress={() => router.push('/(tabs)/issue')} />
            </View>
            {stock.length > 0 && (
              <Card>
                <Text style={s.section}>Current stock</Text>
                {stock.map((item) => {
                  const pct = Number(item.capacity) > 0 ? (Number(item.balance) / Number(item.capacity)) * 100 : 0;
                  const tone = pct < 15 ? C.red : pct < 30 ? C.amber : C.accent;
                  return (
                    <View key={String(item.id || item.code)} style={{ marginBottom: 10 }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                        <Text style={{ color: C.text, fontSize: 13.5, fontWeight: '600' }}>{item.name}</Text>
                        <Text style={{ color: C.text, fontSize: 13.5, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{fmtQty(item.balance, item.unit || 'L')}</Text>
                      </View>
                      {Number(item.capacity) > 0 && (
                        <View style={s.bar}>
                          <View style={[s.barFill, { width: `${Math.min(pct, 100)}%`, backgroundColor: tone }]} />
                        </View>
                      )}
                    </View>
                  );
                })}
              </Card>
            )}
            {!isAttendant && (
              <View style={{ flexDirection: 'row', gap: S_GAP, marginBottom: 12 }}>
                <Btn label="＋ New request" onPress={() => router.push('/(tabs)/requests')} style={{ flex: 1 }} />
                {canIssue && <Btn label="⛽ Fueling" variant="secondary" onPress={() => router.push('/(tabs)/issue')} style={{ flex: 1 }} />}
              </View>
            )}
            {isAttendant && approvedCount > 0 && (
              <Card style={{ borderColor: C.green, borderWidth: 1 }}>
                <Text style={{ color: C.text, fontSize: 14, fontWeight: '700' }}>🚚 {approvedCount} authorized request(s) waiting</Text>
                <Text style={{ color: C.muted, fontSize: 12, marginVertical: 4 }}>Open Fueling to dispense — works offline.</Text>
                <Btn label="Go to Fueling" onPress={() => router.push('/(tabs)/issue')} />
              </Card>
            )}
            {recent.length > 0 && <Text style={[s.section, { marginTop: 4 }]}>Recent activity</Text>}
            {recent.length === 0 && (
              <EmptyState
                icon="⛽"
                title="Nothing here yet"
                message="Pull down to sync your vehicles, fuel types and requests from the server."
                action={<Btn label="Sync now" onPress={refresh} />}
              />
            )}
          </>
        )}
        renderItem={({ item }) => (
          <Card onPress={() => router.push(`/request/${item.request_id || item.id}`)}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ color: C.muted, fontSize: 12, fontWeight: '700', letterSpacing: 0.4 }}>{item.txn_no || 'FT-…'}</Text>
              <StatusBadge status={item.status} />
            </View>
            <Text style={{ color: C.text, fontSize: 15, fontWeight: '600', marginVertical: 4 }}>
              {item.plate || '—'} · {fmtQty(item.quantity)} {item.fuel_type_name || ''}
            </Text>
            <Text style={{ color: C.muted, fontSize: 12 }}>{fmtDateTime(item.created_at)}</Text>
          </Card>
        )}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.muted} />}
        contentContainerStyle={{ paddingBottom: 30 }}
        initialNumToRender={8}
        maxToRenderPerBatch={8}
      />
    </Screen>
  );
}

const S_GAP = 12;

function StatBox({ label, value, tone, onPress }) {
  const body = (
    <View style={[s.statBox, { borderLeftColor: tone }]}>
      <Text style={{ color: C.muted, fontSize: 11.5, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</Text>
      <Text style={{ color: tone, fontSize: 26, fontWeight: '800', marginVertical: 2, fontVariant: ['tabular-nums'] }}>{value}</Text>
    </View>
  );
  if (!onPress) return <View style={{ flex: 1 }}>{body}</View>;
  return (
    <TouchableOpacity style={{ flex: 1 }} activeOpacity={0.85} onPress={onPress} accessibilityRole="button">
      {body}
    </TouchableOpacity>
  );
}

const s = {
  section: { color: C.muted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 },
  statBox: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, borderLeftWidth: 3, borderRadius: 14, padding: 16 },
  bar: { height: 5, backgroundColor: C.panel2, borderRadius: 3, overflow: 'hidden' },
  barFill: { height: 5, borderRadius: 3 },
};
