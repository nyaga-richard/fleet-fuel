import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, FlatList, RefreshControl, TouchableOpacity } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  Icon,
  Screen, ScreenHeader, SectionHeader, Card, StatCard, TxnCard, Btn,
  EmptyState, OfflineBanner, useTabBarPad,
} from '../../src/components';
import { kvGet, cachedTransactions, cachedRequests, outboxCount, localUnreadCount } from '../../src/db';
import { getSyncState, onSyncChange, fullSync } from '../../src/sync';
import { useAuth } from '../../src/auth';
import { C, spacing as SP , ICON } from '../../theme';
import { fmtQty, fmtNum, fmtDateTime, todayKey } from '../../src/fmt';

// Role-aware dashboard (spec §29–30) built from shared components.
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
  const [unread, setUnread] = useState(0);

  const load = useCallback(async () => {
    const raw = await kvGet('stock_snapshot');
    setStock(raw ? JSON.parse(raw) : []);
    setTxns(await cachedTransactions(200));
    setRequests(await cachedRequests(200));
    setPendingOps(await outboxCount());
    setLastSync(await kvGet('last_sync_success'));
    setSyncing(!!getSyncState().syncing);
    setUnread(await localUnreadCount());
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
  const recent = txns.slice(0, 6);
  const bottomPad = useTabBarPad();

  return (
    <Screen>
      <ScreenHeader
        title={`Hello, ${(user?.name || 'there').split(' ')[0]}`}
        subtitle={isAttendant ? 'Attendant · ready to fuel' : `${(user?.role || '').replace(/^\w/, (c) => c.toUpperCase())} overview`}
        right={(
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <TouchableOpacity onPress={() => router.push('/(tabs)/sync')} accessibilityLabel="Open sync status" hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Icon
                name={syncing ? 'sync-circle' : pendingOps > 0 ? 'clock-outline' : 'check-circle-outline'}
                size={ICON.sm}
                color={syncing || pendingOps > 0 ? C.amber : C.green}
              />
              <Text style={{ color: syncing || pendingOps > 0 ? C.amber : C.green, fontSize: 12, fontWeight: '600' }}>
                {syncing ? 'Syncing…' : pendingOps > 0 ? `${pendingOps} queued` : 'Synced'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => router.push('/(tabs)/alerts')}
              accessibilityRole="button"
              accessibilityLabel={`Notifications, ${unread} unread`}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}
            >
              <Icon name="bell-outline" size={ICON.md} color={unread > 0 ? C.amber : C.muted} />
              {unread > 0 && (
                <View style={{ backgroundColor: C.red, borderRadius: 8, minWidth: 15, height: 15, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ color: '#fff', fontSize: 9.5, fontWeight: '800' }}>{unread > 9 ? '9+' : unread}</Text>
                </View>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => router.push('/profile')}
              accessibilityRole="button"
              accessibilityLabel="Open profile"
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' }}
            >
              <Text style={{ color: '#fff', fontSize: 13, fontWeight: '800' }}>
                {String(user?.name || user?.email || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()}
              </Text>
            </TouchableOpacity>
          </View>
        )}
      />
      <OfflineBanner lastSync={lastSync} />

      <FlatList
        data={recent}
        keyExtractor={(item) => String(item.id)}
        ListHeaderComponent={(
          <>
            <View style={{ flexDirection: 'row', gap: SP.md }}>
              <StatCard
                label={isAttendant ? 'Ready to fuel' : 'Pending requests'}
                value={fmtNum(isAttendant ? approvedCount : pendingCount)}
                tone={isAttendant ? (approvedCount > 0 ? C.green : C.muted) : (pendingCount > 0 ? C.amber : C.green)}
                onPress={() => router.push('/(tabs)/requests')}
                style={{ flex: 1 }}
              />
              <StatCard label="Issued today" value={fmtQty(issuedToday, '')} tone={C.accent2} onPress={() => router.push('/(tabs)/issue')} style={{ flex: 1 }} />
            </View>

            {isAttendant && approvedCount > 0 && (
              <Card style={{ borderColor: C.green, marginTop: SP.md }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Icon name="clipboard-check-outline" size={ICON.lg} color={C.green} />
                  <Text style={{ color: C.text, fontSize: 14, fontWeight: '700', flex: 1 }}>{approvedCount} authorized request(s) waiting</Text>
                </View>
                <Text style={{ color: C.muted, fontSize: 12.5, marginVertical: 4 }}>Open Fueling to dispense — works offline.</Text>
                <Btn label="Go to Fueling" onPress={() => router.push('/(tabs)/issue')} />
              </Card>
            )}

            {stock.length > 0 && (
              <>
                <SectionHeader style={{ marginTop: SP.xl - 4 }}>Current stock</SectionHeader>
                <Card>
                  {stock.map((item, i) => {
                    const pct = Number(item.capacity) > 0 ? (Number(item.balance) / Number(item.capacity)) * 100 : 0;
                    const tone = pct < 15 ? C.red : pct < 30 ? C.amber : C.accent;
                    return (
                      <View key={String(item.id || item.code)} style={{ marginBottom: i === stock.length - 1 ? 0 : SP.md }}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                          <Text style={{ color: C.text, fontSize: 13.5, fontWeight: '600' }}>{item.name}</Text>
                          <Text style={{ color: C.text, fontSize: 13.5, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{fmtQty(item.balance, item.unit || 'L')}</Text>
                        </View>
                        {Number(item.capacity) > 0 && (
                          <View style={{ height: 5, backgroundColor: C.panel2, borderRadius: 3, overflow: 'hidden' }}>
                            <View style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: tone, borderRadius: 3, height: 5 }} />
                          </View>
                        )}
                      </View>
                    );
                  })}
                </Card>
              </>
            )}

            {!isAttendant && (
              <View style={{ flexDirection: 'row', gap: SP.md, marginTop: SP.md }}>
                <Btn label="New request" icon="plus" onPress={() => router.push('/(tabs)/requests')} style={{ flex: 1 }} />
                {canIssue && <Btn label="Fueling" icon="gas-station" variant="secondary" onPress={() => router.push('/(tabs)/issue')} style={{ flex: 1 }} />}
              </View>
            )}

            <SectionHeader style={{ marginTop: SP.xl - 4 }}>Recent activity</SectionHeader>
            {recent.length === 0 && (
              <EmptyState
                icon="gas-station-outline"
                title="Nothing here yet"
                message="Pull down to sync your vehicles, fuel types and requests from the server."
                action={<Btn label="Sync now" onPress={refresh} />}
              />
            )}
          </>
        )}
        renderItem={({ item }) => <TxnCard txn={item} />}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.muted} />}
        contentContainerStyle={{ paddingBottom: bottomPad }}
        initialNumToRender={6}
        maxToRenderPerBatch={8}
        ListFooterComponent={recent.length > 0 ? (
          <Btn label="Open Fueling" variant="secondary" small onPress={() => router.push('/(tabs)/issue')} />
        ) : null}
      />
    </Screen>
  );
}
