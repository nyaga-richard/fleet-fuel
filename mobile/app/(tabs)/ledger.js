import React, { useCallback, useState } from 'react';
import { View, Text, FlatList, RefreshControl, ScrollView, TouchableOpacity } from 'react-native';
import { useFocusEffect } from 'expo-router';
import {
  Screen, ScreenHeader, Card, Btn, EmptyState, OfflineBanner, SearchBar, SelectField, FilterBar,
  useNetState, useDebounced, useTabBarPad,
} from '../../src/components';
import { api } from '../../src/api';
import { fullSync } from '../../src/sync';
import { cachedFuelTypes, saveLedgerCache, loadLedgerCache } from '../../src/db';
import { C, spacing as SP } from '../../theme';
import { fmtQty, fmtKES, fmtDateTime } from '../../src/fmt';

const ENTRY_TYPES = [
  { value: '', label: 'All transactions' },
  { value: 'opening', label: 'Opening Balance' },
  { value: 'receipt', label: 'Bulk Receipt' },
  { value: 'issue', label: 'Fuel Issue' },
  { value: 'return', label: 'Fuel Return' },
  { value: 'adjustment', label: 'Adjustment' },
  { value: 'reversal', label: 'Reversal' },
  { value: 'transfer', label: 'Transfer' },
];

function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function monthStart() { return iso(new Date(new Date().getFullYear(), new Date().getMonth(), 1)); }
function todayISO() { return iso(new Date()); }

// Fuel Ledger (§11–§14) — ONE scrolling surface: search stays visible, filters
// collapse behind [Filters], summary chips compress to a single row, and the
// entries list owns the rest of the screen (FlatList header/footer pattern).
// Same server dataset + server-side running balance as web (§45); per-filter
// SQLite cache keeps it readable offline (§39) — never invented numbers.
export default function LedgerScreen() {
  const net = useNetState();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(todayISO());
  const [fuelTypeId, setFuelTypeId] = useState('');
  const [entryType, setEntryType] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 300);
  const [page, setPage] = useState(1);
  const [fuels, setFuels] = useState([]);
  const [data, setData] = useState(null);
  const [cacheInfo, setCacheInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pageSize = 25;
  const bottomPad = useTabBarPad();

  useFocusEffect(useCallback(() => {
    cachedFuelTypes().then((rows) => setFuels(rows || [])).catch(() => {});
  }, []));

  const cacheKey = [from, to, fuelTypeId, entryType, dq].join('|');

  const load = useCallback(async (p = page) => {
    setBusy(true); setError('');
    if (net.isConnected) {
      try {
        const ds = await api.ledgerReport({ from, to, fuel_type_id: fuelTypeId || undefined, entry_type: entryType || undefined, q: dq || undefined, page: p, pageSize });
        setData(ds);
        setCacheInfo(null);
        saveLedgerCache(cacheKey, ds).catch(() => {});
        setBusy(false);
        return;
      } catch (e) { setError(e.message); }
    }
    const hit = await loadLedgerCache(cacheKey).catch(() => null);
    if (hit) { setData(hit.dataset); setCacheInfo(hit.fetched_at); }
    else if (!net.isConnected) setError('Offline and no saved ledger for these filters yet — connect once to cache it.');
    setBusy(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, fuelTypeId, entryType, dq, page, cacheKey, net.isConnected]);

  useFocusEffect(useCallback(() => { load(page); }, [load])); // eslint-disable-line react-hooks/exhaustive-deps

  function applyPage(p) { setPage(p); load(p); }
  function resetFilters() {
    setQ(''); setFrom(monthStart()); setTo(todayISO()); setFuelTypeId(''); setEntryType(''); setPage(1);
  }

  const total = data?.total || 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page0 = data?.page ?? page;
  const from1 = total === 0 ? 0 : (page0 - 1) * (data?.pageSize ?? pageSize) + 1;
  const to1 = Math.min(total, page0 * (data?.pageSize ?? pageSize));

  const filterCount = (fuelTypeId ? 1 : 0) + (entryType ? 1 : 0);
  const fuelName = fuels.find((f) => f.id === fuelTypeId)?.name;
  const filterSummary = [fuelName, entryType ? ENTRY_TYPES.find((t) => t.value === entryType)?.label : null]
    .filter(Boolean).join(' · ') || null;

  const summary = (data?.summary || []).slice(0, 8);

  return (
    <Screen>
      <ScreenHeader title="Fuel Ledger" subtitle="The book of record — every movement" />

      <FlatList
        data={data?.rows || []}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={(
          <View>
            {!net.isConnected && <OfflineBanner lastSync={null} />}
            {cacheInfo && (
              <Card style={{ marginBottom: SP.md }}>
                <Text style={{ color: '#fcd34d', fontSize: 12 }}>
                  Offline — ledger as cached {fmtDateTime(cacheInfo)}. Balances are exactly as the server calculated them.
                </Text>
              </Card>
            )}
            {!!error && (
              <Card style={{ borderColor: C.red, borderWidth: 1, marginBottom: SP.md }}>
                <Text style={{ color: C.red, fontSize: 12.5 }}>{error}</Text>
              </Card>
            )}

            <View style={{ marginBottom: SP.md }}>
              <SearchBar value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Search reference, particulars, vehicle…" />
            </View>

            <FilterBar summary={filterSummary} count={filterCount}>
              <Text style={{ color: C.muted, fontSize: 11.5, marginBottom: 4 }}>From</Text>
              <SearchBar value={from} onChange={(v) => { setFrom(v); setPage(1); }} placeholder="YYYY-MM-DD" />
              <View style={{ height: SP.md }} />
              <Text style={{ color: C.muted, fontSize: 11.5, marginBottom: 4 }}>To</Text>
              <SearchBar value={to} onChange={(v) => { setTo(v); setPage(1); }} placeholder="YYYY-MM-DD" />
              <View style={{ height: SP.md }} />
              <SelectField
                label="Fuel type" placeholder="All fuel types" value={fuelTypeId}
                onChange={(v) => { setFuelTypeId(v || ''); setPage(1); }}
                options={[{ value: '', label: 'All fuel types' }, ...fuels.map((f) => ({ value: f.id, label: f.name, sub: f.code || '' }))]}
              />
              <View style={{ height: SP.md }} />
              <SelectField
                label="Transaction type" placeholder="All transactions" value={entryType}
                onChange={(v) => { setEntryType(v || ''); setPage(1); }}
                options={ENTRY_TYPES}
              />
              <View style={{ height: SP.md }} />
              <Btn label="Apply" onPress={() => { setPage(1); load(1); }} />
              <View style={{ height: SP.sm }} />
              <Btn label="Reset filters" variant="secondary" onPress={resetFilters} />
            </FilterBar>

            {summary.length > 0 && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: SP.sm }} contentContainerStyle={{ gap: SP.md, paddingRight: SP.md }}>
                {summary.map((sm) => (
                  <Card key={sm.label} style={{ minWidth: 112, marginBottom: 0 }}>
                    <Text style={{ color: C.muted, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }} numberOfLines={1}>{sm.label}</Text>
                    <Text style={{ color: C.text, fontSize: 14.5, fontWeight: '800', marginTop: 2 }} numberOfLines={1}>{sm.value}</Text>
                  </Card>
                ))}
              </ScrollView>
            )}
          </View>
        )}
        renderItem={({ item: r }) => (
          <Card style={{ marginBottom: SP.md }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: SP.sm }}>
              <Text style={{ color: C.muted, fontSize: 11.5, flex: 1 }}>{fmtDateTime(r.date)}</Text>
              <Text style={{ color: C.accent2, fontSize: 11.5, fontWeight: '700' }}>{r.reference}</Text>
            </View>
            <Text style={{ color: C.text, fontSize: 13, marginTop: 4 }} numberOfLines={2}>{r.particulars}</Text>
            <View style={{ flexDirection: 'row', marginTop: SP.sm, gap: SP.md }}>
              {!!r.qty_in && <Metric label="In" value={fmtQty(r.qty_in, '')} tone={C.green} />}
              {!!r.qty_out && <Metric label="Out" value={fmtQty(r.qty_out, '')} tone={C.amber} />}
              <Metric label="Balance" value={fmtQty(r.running_balance, '')} />
              {r.amount != null && <Metric label="Amount" value={fmtKES(r.amount)} />}
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: SP.sm }}>
              <Text style={{ color: C.muted, fontSize: 11 }}>{r.fuel_type}{r.raw_type ? ` · ${r.raw_type}` : ''}{r.status ? ` · ${r.status}` : ''}</Text>
              <Text style={{ color: C.muted, fontSize: 11 }}>{r.user || 'system'}</Text>
            </View>
          </Card>
        )}
        ListEmptyComponent={!busy ? (
          <EmptyState
            icon="book-open-variant"
            title={data ? 'No entries' : 'Ledger not loaded yet'}
            message={data ? 'No ledger entries in this period for the selected filters.' : 'Connect to the server to load the ledger.'}
          />
        ) : null}
        ListFooterComponent={data ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SP.md, paddingVertical: SP.md, paddingBottom: bottomPad }}>
            <View style={{ flex: 1 }}>
              <Btn label="← Previous" variant="secondary" small disabled={page0 <= 1 || busy} onPress={() => applyPage(page0 - 1)} />
            </View>
            <Text style={{ color: C.muted, fontSize: 11.5 }}>
              {from1.toLocaleString()}–{to1.toLocaleString()} of {total.toLocaleString()}
            </Text>
            <View style={{ flex: 1 }}>
              <Btn label="Next →" variant="secondary" small disabled={page0 >= pages || busy} onPress={() => applyPage(page0 + 1)} />
            </View>
          </View>
        ) : <View style={{ height: bottomPad }} />}
        refreshControl={(
          <RefreshControl
            refreshing={busy}
            onRefresh={async () => { await fullSync().catch(() => {}); await load(page); }}
            tintColor={C.muted}
          />
        )}
      />
    </Screen>
  );
}

function Metric({ label, value, tone }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={{ color: C.muted, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</Text>
      <Text style={{ color: tone || C.text, fontSize: 13.5, fontWeight: '800' }}>{value}</Text>
    </View>
  );
}
