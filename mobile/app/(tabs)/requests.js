import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useAuth } from '../../src/auth';
import {
  Screen, ScreenHeader, SectionHeader, StatusBadge, Btn, Field, Input, Chip,
  SearchBar, FilterButton, EmptyState, OfflineBanner, Sheet, RequestCard,
  SelectField, useDebounced, useTabBarPad,
} from '../../src/components';
import {
  cachedRequests, cachedVehicles, cachedFuelTypes, enqueue, outboxCount, kvGet,
} from '../../src/db';
import { fullSync } from '../../src/sync';
import { C, spacing as SP } from '../../theme';
import { fmtDateTime } from '../../src/fmt';

const STATUS_FILTERS = ['all', 'pending', 'approved', 'issued', 'rejected', 'cancelled'];
const DEFAULT_FILTERS = { status: 'all', fuel_type_id: '', vehicle_id: '', from: '', to: '' };

// Fuel Requests (spec §14): Search → [Filters] → list → TAP → details.
// Creating works fully OFFLINE (queued in SQLite, synced exactly once).
export default function RequestsScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const [rows, setRows] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  const [fuels, setFuels] = useState([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [lastSync, setLastSync] = useState(null);
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [sheet, setSheet] = useState(false);
  const [createSheet, setCreateSheet] = useState(false);
  const dq = useDebounced(q, 250);

  const load = useCallback(async () => {
    setRows(await cachedRequests(500));
    setPendingCount(await outboxCount());
    setLastSync(await kvGet('last_sync_success'));
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const filtered = useMemo(() => {
    const term = dq.trim().toLowerCase();
    const m = (s) => String(s ?? '').toLowerCase().includes(term);
    return rows
      .filter((r) => filters.status === 'all' || r.status === filters.status)
      .filter((r) => !filters.fuel_type_id || r.fuel_type_id === filters.fuel_type_id)
      .filter((r) => !filters.vehicle_id || r.vehicle_id === filters.vehicle_id)
      .filter((r) => !filters.from || String(r.created_at || '').slice(0, 10) >= filters.from)
      .filter((r) => !filters.to || String(r.created_at || '').slice(0, 10) <= filters.to)
      .filter((r) => !term || m(r.request_no) || m(r.plate) || m(r.driver_name) || m(r.status) || m(r.destination))
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  }, [rows, dq, filters]);

  const filterCount = ['fuel_type_id', 'vehicle_id', 'from', 'to'].filter((k) => filters[k]).length
    + (filters.status !== 'all' ? 1 : 0);

  return (
    <Screen>
      <ScreenHeader
        title="Fuel Requests"
        subtitle={pendingCount > 0 ? `${pendingCount} offline change(s) queued` : 'Tap a request for details'}
        right={(
          <TouchableOpacity
            onPress={() => setCreateSheet(true)}
            accessibilityRole="button"
            accessibilityLabel="New fuel request"
            style={{ backgroundColor: C.accent, borderRadius: 20, paddingHorizontal: 14, minHeight: 40, justifyContent: 'center' }}
          >
            <Text style={{ color: '#fff', fontWeight: '800', fontSize: 13 }}>＋ New</Text>
          </TouchableOpacity>
        )}
      />
      <OfflineBanner lastSync={lastSync} />

      <SearchBar value={q} onChange={setQ} placeholder="Search requests, plates, drivers…" />

      <View style={{ flexDirection: 'row', gap: SP.sm, marginBottom: SP.md, alignItems: 'center' }}>
        <FilterButton count={filterCount} onPress={() => setSheet(true)} />
        <FlatList
          horizontal
          showsHorizontalScrollIndicator={false}
          data={STATUS_FILTERS}
          keyExtractor={(f) => f}
          renderItem={({ item }) => (
            <View style={{ marginRight: SP.sm }}>
              <Chip
                label={item === 'all' ? 'All' : item}
                active={filters.status === item}
                onPress={() => setFilters((f) => ({ ...f, status: item }))}
              />
            </View>
          )}
        />
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => <RequestCard request={item} onPress={() => router.push(`/request/${item.id}`)} />}
        ListEmptyComponent={(
          <EmptyState
            icon="🔍"
            title={dq || filterCount ? 'No matching requests' : 'No requests yet'}
            message={dq || filterCount
              ? 'Try another registration, request number, or clear the filters.'
              : 'Pull down on Home to sync, or create the first request.'}
            action={(dq || filterCount)
              ? <Btn label="Clear search & filters" variant="secondary" onPress={() => { setQ(''); setFilters(DEFAULT_FILTERS); }} />
              : <Btn label="＋ New fuel request" onPress={() => setCreateSheet(true)} />}
          />
        )}
        contentContainerStyle={{ paddingBottom: useTabBarPad() }}
        initialNumToRender={10}
        maxToRenderPerBatch={10}
      />

      <FilterSheet
        visible={sheet}
        onClose={() => setSheet(false)}
        filters={filters}
        setFilters={setFilters}
        vehicles={vehicles}
        fuels={fuels}
        onLoadRefs={async () => {
          setVehicles(await cachedVehicles());
          setFuels(await cachedFuelTypes());
        }}
      />

      <NewRequestSheet
        visible={createSheet}
        onClose={() => setCreateSheet(false)}
        onSaved={() => { load(); fullSync().catch(() => {}); }}
        user={user}
      />
    </Screen>
  );
}

// ── Filter bottom sheet (spec §13) ──────────────────────────────────────────
function FilterSheet({ visible, onClose, filters, setFilters, vehicles, fuels, onLoadRefs }) {
  const [draft, setDraft] = useState(filters);

  useEffect(() => {
    if (visible) {
      setDraft(filters);
      onLoadRefs?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const dateBad = (v) => v !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(v);

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Filters"
      footer={(
        <>
          <View style={{ flex: 1 }}>
            <Btn label="Clear" variant="secondary" onPress={() => setDraft({ ...DEFAULT_FILTERS, status: 'all' })} />
          </View>
          <View style={{ flex: 1 }}>
            <Btn label="Apply" onPress={() => { setFilters(draft); onClose(); }} />
          </View>
        </>
      )}
    >
      <Field label="Status">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SP.sm }}>
          {STATUS_FILTERS.map((s) => (
            <Chip key={s} label={s === 'all' ? 'All' : s} active={draft.status === s} onPress={() => setDraft((d) => ({ ...d, status: s }))} />
          ))}
        </View>
      </Field>
      <Field label="Fuel type">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SP.sm }}>
          {fuels.map((f) => (
            <Chip key={f.id} label={f.name} active={draft.fuel_type_id === f.id} onPress={() => setDraft((d) => ({ ...d, fuel_type_id: d.fuel_type_id === f.id ? '' : f.id }))} />
          ))}
          {fuels.length === 0 && <Text style={{ color: C.muted, fontSize: 13 }}>No fuel types cached — sync first.</Text>}
        </View>
      </Field>
      <Field label="Vehicle">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SP.sm }}>
          {vehicles.map((v) => (
            <Chip key={v.id} label={v.plate} active={draft.vehicle_id === v.id} onPress={() => setDraft((d) => ({ ...d, vehicle_id: d.vehicle_id === v.id ? '' : v.id }))} />
          ))}
          {vehicles.length === 0 && <Text style={{ color: C.muted, fontSize: 13 }}>No vehicles cached — sync first.</Text>}
        </View>
      </Field>
      <Field label="Date from" hint="YYYY-MM-DD">
        <Input
          keyboardType="numbers-and-punctuation"
          value={draft.from}
          onChangeText={(v) => setDraft((d) => ({ ...d, from: v }))}
          placeholder="YYYY-MM-DD"
          autoCapitalize="none"
        />
      </Field>
      <Field label="Date to" hint={dateBad(draft.to) || dateBad(draft.from) ? 'Use the YYYY-MM-DD format' : null} error={dateBad(draft.to) ? 'Invalid date' : null}>
        <Input
          keyboardType="numbers-and-punctuation"
          value={draft.to}
          onChangeText={(v) => setDraft((d) => ({ ...d, to: v }))}
          placeholder="YYYY-MM-DD"
          autoCapitalize="none"
        />
      </Field>
    </Sheet>
  );
}

// ── New request — keyboard-safe bottom sheet, works offline ─────────────────
function NewRequestSheet({ visible, onClose, onSaved, user }) {
  const [vehicles, setVehicles] = useState([]);
  const [fuels, setFuels] = useState([]);
  const [vehicleId, setVehicleId] = useState(null);
  const [fuelId, setFuelId] = useState(null);
  const [quantity, setQuantity] = useState('');
  const [destination, setDestination] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    (async () => {
      setVehicles(await cachedVehicles());
      setFuels(await cachedFuelTypes());
    })();
  }, [visible]);

  const qty = Number(quantity);
  const qtyError = quantity !== '' && (!Number.isFinite(qty) || qty <= 0) ? 'Enter a quantity greater than 0' : null;

  async function save() {
    if (busy) return;
    if (!vehicleId || !fuelId || !qty || qty <= 0) return;
    setBusy(true);
    try {
      await enqueue('fuel_request', {
        vehicle_id: vehicleId,
        fuel_type_id: fuelId,
        quantity: qty,
        destination: destination || null,
        created_at: new Date().toISOString(),
        created_by_role: user?.role,
      });
      onClose();
      setQuantity(''); setDestination(''); setVehicleId(null); setFuelId(null);
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="New fuel request"
      footer={(
        <>
          <View style={{ flex: 1 }}>
            <Btn label="Cancel" variant="secondary" onPress={onClose} disabled={busy} />
          </View>
          <View style={{ flex: 2 }}>
            <Btn label={busy ? 'Saving…' : 'Save (works offline)'} onPress={save} busy={busy} disabled={!vehicleId || !fuelId || !qty || qty <= 0} />
          </View>
        </>
      )}
    >
      <SelectField
        label="Vehicle *"
        placeholder="Select vehicle"
        value={vehicleId}
        onChange={setVehicleId}
        options={vehicles.map((v) => ({ value: v.id, label: v.plate, sub: [v.make, v.model].filter(Boolean).join(' ') || v.driver_name || '' }))}
        emptyHint="No vehicles are cached on this device. Sync first (Home → pull down), then create the request."
      />
      <SelectField
        label="Fuel type *"
        placeholder="Select fuel type"
        value={fuelId}
        onChange={setFuelId}
        options={fuels.map((f) => ({ value: f.id, label: f.name, sub: f.code || '' }))}
        emptyHint="No fuel types are cached on this device. Sync first (Home → pull down)."
      />
      <Field label="Quantity (litres) *" error={qtyError}>
        <Input keyboardType="decimal-pad" value={quantity} onChangeText={setQuantity} placeholder="e.g. 40" returnKeyType="done" />
      </Field>
      <Field label="Destination">
        <Input value={destination} onChangeText={setDestination} placeholder="optional" returnKeyType="done" autoCorrect={false} />
      </Field>
    </Sheet>
  );
}
