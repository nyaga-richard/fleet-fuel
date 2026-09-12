import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useAuth } from '../../src/auth';
import {
  Screen, ScreenHeader, Card, StatusBadge, Btn, Field, Input, Chip, SearchBar,
  EmptyState, OfflineBanner, Sheet, useDebounced,
} from '../../src/components';
import {
  cachedRequests, cachedVehicles, cachedFuelTypes, enqueue, outboxCount,
} from '../../src/db';
import { fullSync } from '../../src/sync';
import { kvGet } from '../../src/db';
import { C } from '../../src/theme';
import { fmtQty, fmtDateTime } from '../../src/fmt';

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'issued', label: 'Issued' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'cancelled', label: 'Cancelled' },
];

// Fuel Requests — search / filter → tap a card → full details → act.
// Creating works fully OFFLINE (queued in SQLite, synced exactly once).
export default function RequestsScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const [rows, setRows] = useState([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [lastSync, setLastSync] = useState(null);
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sheet, setSheet] = useState(false);
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
      .filter((r) => statusFilter === 'all' || r.status === statusFilter)
      .filter((r) => !term
        || m(r.request_no) || m(r.plate) || m(r.driver_name)
        || m(r.status) || m(r.fuel_type_id) || m(r.destination))
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  }, [rows, dq, statusFilter]);


  return (
    <Screen>
      <ScreenHeader
        title="Fuel Requests"
        subtitle={pendingCount > 0 ? `${pendingCount} offline change(s) queued` : 'Tap a request for details'}
        right={(
          <TouchableOpacity
            onPress={() => setSheet(true)}
            accessibilityRole="button"
            accessibilityLabel="New fuel request"
            style={{ backgroundColor: C.accent, borderRadius: 22, paddingHorizontal: 14, minHeight: 40, justifyContent: 'center' }}
          >
            <Text style={{ color: '#fff', fontWeight: '800', fontSize: 13 }}>＋ New</Text>
          </TouchableOpacity>
        )}
      />
      <OfflineBanner lastSync={lastSync} />

      <SearchBar value={q} onChange={setQ} placeholder="Search requests, plates, drivers…" />

      <FlatList
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ marginBottom: 12 }}
        data={FILTERS}
        keyExtractor={(f) => f.value}
        renderItem={({ item }) => (
          <Chip label={item.label} active={statusFilter === item.value} onPress={() => setStatusFilter(item.value)} />
        )}
      />

      <FlatList
        data={filtered}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => (
          <Card onPress={() => router.push(`/request/${item.id}`)}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ color: C.muted, fontSize: 12, fontWeight: '700', letterSpacing: 0.4 }}>
                {item.request_no || '⏳ pending sync'}
              </Text>
              <StatusBadge status={item.status} />
            </View>
            <Text style={{ color: C.text, fontSize: 15.5, fontWeight: '700', marginVertical: 4 }}>
              {item.plate || 'vehicle'} · {fmtQty(item.quantity)}
            </Text>
            <Text style={{ color: C.muted, fontSize: 12 }}>
              {item.driver_name || '—'} · {fmtDateTime(item.created_at)}
            </Text>
          </Card>
        )}
        ListEmptyComponent={(
          <EmptyState
            icon="🔍"
            title={dq || statusFilter !== 'all' ? 'No matching requests' : 'No requests yet'}
            message={dq || statusFilter !== 'all'
              ? 'Try another registration, request number or clear the filters.'
              : 'Pull down on Home to sync, or create the first request.'}
            action={(dq || statusFilter !== 'all')
              ? <Btn label="Clear search & filters" variant="secondary" onPress={() => { setQ(''); setStatusFilter('all'); }} />
              : <Btn label="＋ New fuel request" onPress={() => setSheet(true)} />}
          />
        )}
        contentContainerStyle={{ paddingBottom: 30 }}
        initialNumToRender={10}
        maxToRenderPerBatch={10}
      />

      <NewRequestSheet
        visible={sheet}
        onClose={() => setSheet(false)}
        onSaved={() => { load(); fullSync().catch(() => {}); }}
        user={user}
      />
    </Screen>
  );
}

// ── New request — bottom sheet, keyboard-safe, works offline ────────────────
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
      // 1. Queue locally first — works fully offline, survives restarts.
      await enqueue('fuel_request', {
        vehicle_id: vehicleId,
        fuel_type_id: fuelId,
        quantity: qty,
        destination: destination || null,
        created_at: new Date().toISOString(),
        created_by_role: user?.role,
      });
      // 2. Show it in the local list immediately, then best-effort sync.
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
      <Field label="Vehicle *" hint={vehicles.length === 0 ? 'No vehicles cached — sync first (Home → pull down).' : null}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {vehicles.map((v) => (
            <Chip key={v.id} label={v.plate} sub={v.make} active={vehicleId === v.id} onPress={() => setVehicleId(v.id)} />
          ))}
        </View>
      </Field>
      <Field label="Fuel type *">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {fuels.map((f) => (
            <Chip key={f.id} label={f.name} active={fuelId === f.id} onPress={() => setFuelId(f.id)} />
          ))}
        </View>
      </Field>
      <Field label="Quantity (litres) *" error={qtyError}>
        <Input
          keyboardType="decimal-pad"
          value={quantity}
          onChangeText={setQuantity}
          placeholder="e.g. 40"
          returnKeyType="done"
        />
      </Field>
      <Field label="Destination">
        <Input
          value={destination}
          onChangeText={setDestination}
          placeholder="optional"
          returnKeyType="done"
          autoCorrect={false}
        />
      </Field>
    </Sheet>
  );
}

