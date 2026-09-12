import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, FlatList } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useAuth } from '../../src/auth';
import {
  Screen, ScreenHeader, Card, StatusBadge, Btn, SearchBar, EmptyState, OfflineBanner, useDebounced,
} from '../../src/components';
import { cachedRequests, cachedTransactions, outboxCount, kvGet } from '../../src/db';
import { C } from '../../src/theme';
import { fmtQty, fmtDateTime, todayKey } from '../../src/fmt';

// Fueling (spec §30) — the attendant lands directly on authorized requests.
// NO issuing from list rows: tapping opens the request details, and the
// ISSUE FUEL action lives only there (spec §14/§17).
export default function FuelingScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const canIssue = ['attendant', 'manager', 'admin'].includes(user?.role);
  const [rows, setRows] = useState([]);
  const [txns, setTxns] = useState([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [lastSync, setLastSync] = useState(null);
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 250);

  const load = useCallback(async () => {
    const all = await cachedRequests(500);
    setRows(all.filter((r) => r.status === 'approved'));
    setTxns(await cachedTransactions(100));
    setPendingCount(await outboxCount());
    setLastSync(await kvGet('last_sync_success'));
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const filtered = useMemo(() => {
    const term = dq.trim().toLowerCase();
    const m = (s) => String(s ?? '').toLowerCase().includes(term);
    return rows
      .filter((r) => !term || m(r.request_no) || m(r.plate) || m(r.driver_name))
      .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
  }, [rows, dq]);

  const today = todayKey();
  const issuedToday = txns
    .filter((t) => String(t.created_at || '').slice(0, 10) === today && !t.reversal_of)
    .reduce((a, t) => a + Number(t.quantity || 0), 0);

  if (!canIssue) {
    return (
      <Screen>
        <ScreenHeader title="Fueling" subtitle="Dispensing" />
        <Card>
          <Text style={{ color: C.muted, fontSize: 13.5 }}>
            Your role does not dispense fuel. Fuel requests and approvals are your tools — see Requests.
          </Text>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScreenHeader
        title="Fueling"
        subtitle={`${filtered.length} authorized · ${fmtQty(issuedToday, '')} issued today`}
      />
      <OfflineBanner lastSync={lastSync} />
      {pendingCount > 0 && (
        <Card style={{ borderColor: C.amber, borderWidth: 1, paddingVertical: 10 }}>
          <Text style={{ color: '#fcd34d', fontSize: 12.5 }}>
            ⏳ {pendingCount} offline change(s) queued — they sync automatically (exactly once).
          </Text>
        </Card>
      )}

      <SearchBar value={q} onChange={setQ} placeholder="Search authorized requests…" />

      <FlatList
        data={filtered}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => (
          <Card onPress={() => router.push(`/request/${item.id}`)}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ color: C.muted, fontSize: 12, fontWeight: '700' }}>{item.request_no || '⏳ pending sync'}</Text>
              <StatusBadge status={item.status} />
            </View>
            <Text style={{ color: C.text, fontSize: 16, fontWeight: '700', marginVertical: 4 }}>
              {item.plate || '—'} · {fmtQty(item.quantity)}
            </Text>
            <Text style={{ color: C.muted, fontSize: 12 }}>Tap for details → Issue fuel</Text>
          </Card>
        )}
        ListEmptyComponent={(
          <EmptyState
            icon="🚚"
            title={dq ? 'No matching authorized requests' : 'No authorized requests waiting'}
            message={dq
              ? 'Try another plate or request number.'
              : 'When a manager authorizes a request it appears here, ready to dispense.'}
            action={dq ? <Btn label="Clear search" variant="secondary" onPress={() => setQ('')} /> : null}
          />
        )}
        ListFooterComponent={(
          <>
            <Text style={{ color: C.muted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginVertical: 10 }}>Recent fueling</Text>
            {txns.slice(0, 5).map((t) => (
              <Card key={String(t.id)}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={{ color: C.muted, fontSize: 12, fontWeight: '700' }}>{t.txn_no || 'FT-…'}</Text>
                  <StatusBadge status={t.status} />
                </View>
                <Text style={{ color: C.text, fontSize: 14.5, fontWeight: '600', marginVertical: 3 }}>
                  {t.plate || '—'} · {fmtQty(t.quantity)}
                </Text>
                <Text style={{ color: C.muted, fontSize: 12 }}>{fmtDateTime(t.created_at)}</Text>
              </Card>
            ))}
            {txns.length === 0 && <Text style={{ color: C.muted, fontSize: 12.5 }}>Nothing issued yet from this device.</Text>}
          </>
        )}
        contentContainerStyle={{ paddingBottom: 30 }}
        initialNumToRender={8}
      />
    </Screen>
  );
}
