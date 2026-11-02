import React, { useCallback, useMemo, useState } from 'react';
import { Text, FlatList } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useAuth } from '../../src/auth';
import {
  Screen, ScreenHeader, SectionHeader, Card, Btn, SearchBar, EmptyState,
  OfflineBanner, RequestCard, TxnCard, useDebounced, useTabBarPad,
} from '../../src/components';
import { cachedRequests, cachedTransactions, outboxCount, kvGet } from '../../src/db';
import { C } from '../../theme';
import { fmtQty, todayKey } from '../../src/fmt';

// Fueling (spec §30) — the attendant lands directly on authorized requests.
// No issuing from list rows: tapping opens Request Details; ISSUE FUEL lives
// only there (spec §14/§17).
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
  const bottomPad = useTabBarPad();

  if (!canIssue) {
    return (
      <Screen>
        <ScreenHeader title="Fueling" subtitle="Dispensing" />
        <Card><Text style={{ color: C.muted, fontSize: 13.5 }}>Your role does not dispense fuel. Fuel requests and approvals are your tools — see Requests.</Text></Card>
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
            {pendingCount} offline change(s) queued — they sync automatically (exactly once).
          </Text>
        </Card>
      )}

      <SearchBar value={q} onChange={setQ} placeholder="Search authorized requests…" />

      <FlatList
        data={filtered}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => <RequestCard request={item} onPress={() => router.push(`/request/${item.id}`)} />}
        ListEmptyComponent={(
          <EmptyState
            icon="clipboard-text-outline"
            title={dq ? 'No matching authorized requests' : 'No authorized requests waiting'}
            message={dq
              ? 'Try another plate or request number.'
              : 'When a manager authorizes a request it appears here, ready to dispense.'}
            action={dq ? <Btn label="Clear search" variant="secondary" onPress={() => setQ('')} /> : null}
          />
        )}
        ListFooterComponent={(
          <>
            {txns.length > 0 && <SectionHeader style={{ marginTop: SP_TOP }}>Recent fueling</SectionHeader>}
            {txns.slice(0, 4).map((t) => <TxnCard key={String(t.id)} txn={t} />)}
          </>
        )}
        contentContainerStyle={{ paddingBottom: bottomPad }}
        initialNumToRender={8}
      />
    </Screen>
  );
}

const SP_TOP = 16;
