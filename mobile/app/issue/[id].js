import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { Screen, Card, Btn, Field, Input, SelectField, KV, StatusBadge, Icon } from '../../src/components';
import { cachedRequests, cachedPumps, cachedVehicles, cachedFuelTypes, enqueue, outboxCount, kvGet, opStillQueued } from '../../src/db';
import { getSyncState, fullSync, refreshStock } from '../../src/sync';
import { C, spacing as SP, ICON } from '../../theme';
import { fmtQty } from '../../src/fmt';

// ─────────────────────────────────────────────────────────────────────────────
// Fueling flow (spec §18) — a guided, keyboard-aware workflow:
//   1 Confirm vehicle → 2 Odometer → 3 Pump → 4 Start meter
//   → 5 Quantity (protected) → 6 End meter → 7 Review → 8 Complete
// Queues OFFLINE-FIRST (idempotent op_id); confirmation shows SYNCED /
// PENDING SYNC (spec §39). Double-submission impossible (spec §40).
// Payload shape is EXACTLY what the server's sync endpoint has always
// accepted for op type 'fuel_transaction' — business logic untouched.
// ─────────────────────────────────────────────────────────────────────────────
export default function FuelingFlow() {
  const { id } = useLocalSearchParams();
  const router = useRouter();
  const [req, setReq] = useState(null);
  const [vehicle, setVehicle] = useState(null);
  const [fuel, setFuel] = useState(null);
  const [pumps, setPumps] = useState([]);
  const [pumpId, setPumpId] = useState(null);
  const [tankStock, setTankStock] = useState([]);
  const [odometer, setOdometer] = useState('');
  const [lpoNo, setLpoNo] = useState('');
  const [startMeter, setStartMeter] = useState('');
  const [quantity, setQuantity] = useState('');
  const [endMeter, setEndMeter] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [queuedBefore, setQueuedBefore] = useState(0);

  useFocusEffect(useCallback(() => {
    (async () => {
      const r = (await cachedRequests(500)).find((x) => x.id === id);
      if (!r) return;
      setReq(r);
      setVehicle((await cachedVehicles()).find((v) => v.id === r.vehicle_id) || null);
      setFuel((await cachedFuelTypes()).find((f) => f.id === r.fuel_type_id) || null);
      setPumps(await cachedPumps());
      setTankStock(JSON.parse((await kvGet('stock_tanks')) || '[]'));
      // Online → pull fresh per-tank stock so a receipt made anywhere (web
      // console or another device) is visible here immediately, not just after
      // the next full sync. Offline → the cached values above stay (spec §23).
      refreshStock()
        .then(() => kvGet('stock_tanks'))
        .then((raw) => setTankStock(JSON.parse(raw || '[]')))
        .catch(() => {});
      setQuantity((q) => q || String(r.quantity ?? ''));
    })();
  }, [id]));

  useEffect(() => { outboxCount().then(setQueuedBefore); }, []);

  const authorized = req ? Number(req.quantity) : 0;
  const qty = Number(quantity);
  const qtyInvalid = quantity !== '' && (!Number.isFinite(qty) || qty <= 0);
  const excess = Number.isFinite(qty) && qty > authorized && authorized > 0;
  const canComplete = !!req && !!pumpId && Number.isFinite(qty) && qty > 0 && !busy;
  const selectedPump = pumps.find((p) => p.id === pumpId) || null;
  // null = stock UNKNOWN (no row for this tank). Never coerce a missing row to
  // 0 — Number(null) is 0, which used to fake a "Tank stock: 0 L" warning.
  const tankRow = selectedPump?.tank_id ? tankStock.find((t) => t.id === selectedPump.tank_id) : null;
  const tankBalance = tankRow ? Number(tankRow.balance) : null;
  const lowStock = tankBalance !== null && Number.isFinite(qty) && qty > tankBalance;

  const suggestedEnd = useMemo(() => {
    const s = Number(startMeter);
    if (!startMeter || !Number.isFinite(s) || !Number.isFinite(qty) || qty <= 0) return null;
    return (s + qty).toFixed(2);
  }, [startMeter, qty]);

  async function complete() {
    if (busy || !req || !pumpId || !Number.isFinite(qty) || qty <= 0) return;
    setBusy(true);
    try {
      const opId = await enqueue('fuel_transaction', {
        request_id: req.id,          // exact row — immune to stale request_no
        request_no: req.request_no,  // human reference / cross-device fallback
        pump_id: pumpId,
        quantity: qty,
        pump_reading: endMeter !== '' ? Number(endMeter) : (startMeter !== '' ? Number(startMeter) + qty : null),
        odometer: odometer !== '' ? Number(odometer) : null,
        lpo_no: lpoNo.trim() || null,
        created_at: new Date().toISOString(),
      });
      setDone({
        synced: false,
        txn: {
          request_no: req.request_no,
          plate: req.plate || vehicle?.plate,
          fuel: fuel?.name,
          authorized,
          issued: qty,
          pump: (pumps.find((p) => p.id === pumpId) || {}).name,
        },
      });
      // Try an immediate sync in the background; flip the badge if it lands.
      fullSync().then(async () => {
        if (!(await opStillQueued(opId))) setDone((d) => (d ? { ...d, synced: true } : d));
      });
    } finally {
      setBusy(false);
    }
  }

  if (!req) {
    return (
      <Screen>
        <Card><Text style={{ color: C.muted }}>Loading request… pull down on Home to sync if this persists.</Text></Card>
      </Screen>
    );
  }

  // ── Confirmation (spec §39) ────────────────────────────────────────────────
  if (done) {
    return (
      <Screen scroll>
        <Card style={{ borderColor: C.green, borderWidth: 1, alignItems: 'center', paddingVertical: SP.xl }}>
          <Icon name="check-circle-outline" size={ICON.xxl} color={C.green} style={{ marginBottom: 6 }} />
          <Text style={{ color: C.text, fontSize: 19, fontWeight: '800' }}>Fueling completed</Text>
          <Text style={{ color: done.synced ? C.green : C.amber, fontSize: 12.5, fontWeight: '700', marginTop: 4 }}>
            {done.synced ? 'Status: SYNCED' : 'Status: PENDING SYNC'}
          </Text>
        </Card>
        <Card>
          <KV rows={[
            ['Request', done.txn.request_no || 'pending sync'],
            ['Vehicle', done.txn.plate || '—'],
            ['Fuel', done.txn.fuel || '—'],
            ['Authorized', fmtQty(done.txn.authorized)],
            ['Issued', fmtQty(done.txn.issued)],
            ['Pump', done.txn.pump || '—'],
          ]} />
        </Card>
        {!done.synced && (
          <Card>
            <Text style={{ color: '#fcd34d', fontSize: 12.5 }}>
              You're offline — the transaction is saved on this device and will synchronize exactly once when Internet returns. Do not re-enter it.
            </Text>
          </Card>
        )}
        <Btn label="Done" onPress={() => router.back()} />
      </Screen>
    );
  }

  // ── Workflow ────────────────────────────────────────────────────────────────
  return (
    <Screen scroll keyboard>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingBottom: 12 }}>
        <TouchableOpacity onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Go back" hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Icon name="arrow-left" size={ICON.xl} color={C.accent2} />
        </TouchableOpacity>
        <Text style={{ color: C.text, fontSize: 17, fontWeight: '800', flexShrink: 1 }} numberOfLines={1}>Fueling — {req.request_no || 'pending sync'}</Text>
      </View>

      <Step n={1} title="Confirm vehicle">
        <Card style={{ marginBottom: 0 }}>
          <KV rows={[
            ['Vehicle', req.plate || vehicle?.plate || '—'],
            ['Make / model', vehicle ? [vehicle.make, vehicle.model].filter(Boolean).join(' ') || '—' : '—'],
            ['Fuel type', fuel?.name || '—'],
          ]} />
          <View style={{ alignItems: 'flex-start', marginTop: 8 }}><StatusBadge status={req.status} /></View>
        </Card>
      </Step>

      <Step n={2} title="Odometer (km)">
        <Field hint="Current vehicle odometer">
          <Input keyboardType="number-pad" value={odometer} onChangeText={setOdometer} placeholder="e.g. 105000" returnKeyType="next" />
        </Field>
      </Step>

      <Step n={3} title="Select pump">
        <SelectField
          label="Pump"
          placeholder="Select pump"
          value={pumpId}
          onChange={setPumpId}
          options={pumps.map((p) => {
            const row = p.tank_id ? tankStock.find((t) => t.id === p.tank_id) : null;
            const bal = row ? Number(row.balance) : null; // null = unknown, never fake 0
            const sub = p.tank_name ? (bal !== null ? `${p.tank_name} · ${fmtQty(bal)}` : p.tank_name) : undefined;
            return { value: p.id, label: p.name, sub };
          })}
          emptyHint="No pumps are cached on this device. Sync first (Home → pull down)."
        />
        {selectedPump && tankBalance !== null && (
          <Text style={{ color: tankBalance <= 0 ? C.red : C.muted, fontSize: 12, marginTop: 2 }}>
            Tank stock: {fmtQty(tankBalance)}{tankBalance <= 0 ? ' — the server will REJECT issues until stock is received (Inventory → Bulk receipts)' : ''}
          </Text>
        )}
        {selectedPump && tankBalance === null && (
          <Text style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>
            Tank stock: unknown for this pump's tank — not synced yet, or the tank is inactive. Pull down on Home to sync, or check the tank in Inventory.
          </Text>
        )}
      </Step>

      <Step n={4} title="Pump start meter">
        <Field hint="Optional — closing meter is calculated if left out">
          <Input
            keyboardType="decimal-pad"
            value={startMeter}
            onChangeText={(v) => { setStartMeter(v); if (suggestedEnd) setEndMeter(suggestedEnd); }}
            placeholder="e.g. 45230.50"
            returnKeyType="next"
          />
        </Field>
      </Step>

      <Step n={5} title="LPO number">
        <Field hint="Optional — customer Local Purchase Order reference">
          <Input
            value={lpoNo}
            onChangeText={setLpoNo}
            placeholder="e.g. LPO/2026/00421"
            autoCapitalize="characters"
            returnKeyType="next"
          />
        </Field>
      </Step>

      <Step n={6} title="Fuel quantity (L)">
        <Field hint={`Authorized: ${fmtQty(authorized)}`} error={qtyInvalid ? 'Enter a valid quantity' : excess ? `Excess fuel requires manager approval. Authorized: ${fmtQty(authorized)}.` : null}>
          <Input
            keyboardType="decimal-pad"
            value={quantity}
            onChangeText={setQuantity}
            placeholder={String(authorized || '')}
            returnKeyType="next"
            style={excess ? { borderColor: C.amber } : undefined}
          />
        </Field>
        {excess && (
          <Card style={{ borderColor: C.amber, borderWidth: 1, marginBottom: 0 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Icon name="alert" size={ICON.md} color="#fcd34d" />
              <Text style={{ color: '#fcd34d', fontSize: 12.5, flex: 1 }}>
                You entered {fmtQty(qty)} — that exceeds the authorized {fmtQty(authorized)}. The server will hold this transaction for manager approval.
              </Text>
            </View>
          </Card>
        )}
        {lowStock && !excess && (
          <Card style={{ borderColor: C.amber, borderWidth: 1, marginBottom: 0 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Icon name="fuel" size={ICON.md} color="#fcd34d" />
              <Text style={{ color: '#fcd34d', fontSize: 12.5, flex: 1 }}>
                Tank has only {fmtQty(tankBalance)} — issuing {fmtQty(qty)} will be rejected by the server until stock is received (Inventory → Bulk receipts on the web console).
              </Text>
            </View>
          </Card>
        )}
      </Step>

      <Step n={7} title="Pump end meter">
        <Field hint={suggestedEnd ? `Suggested from start meter: ${suggestedEnd}` : 'Optional — closing scale reading'}>
          <Input
            keyboardType="decimal-pad"
            value={endMeter}
            onChangeText={setEndMeter}
            placeholder={suggestedEnd || 'e.g. 45328.50'}
            returnKeyType="done"
          />
        </Field>
      </Step>

      <Step n={8} title="Review">
        <Card style={{ marginBottom: 0 }}>
          <KV rows={[
            ['Vehicle', req.plate || vehicle?.plate || '—'],
            ['Pump', (pumps.find((p) => p.id === pumpId) || {}).name || '—'],
            ['Odometer', odometer ? `${Number(odometer).toLocaleString()} km` : '—'],
        ...(lpoNo ? [['LPO No', lpoNo]] : []),
            ['Start meter', startMeter || '—'],
            ['End meter', endMeter || (suggestedEnd ? `${suggestedEnd} (calc)` : '—')],
            ['Authorized', fmtQty(authorized)],
            ['Issuing', fmtQty(Number.isFinite(qty) ? qty : 0)],
            ['Excess', excess ? 'needs manager approval' : 'none'],
          ]} />
        </Card>
      </Step>

      <Btn
        label={busy ? 'COMPLETING…' : 'COMPLETE FUELING'}
        icon="check-bold"
        variant="success"
        large
        busy={busy}
        disabled={!canComplete}
        onPress={complete}
        style={{ marginTop: 4, marginBottom: 26 }}
      />
    </Screen>
  );
}

function Step({ n, title, children }) {
  return (
    <View style={{ marginBottom: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>{n}</Text>
        </View>
        <Text style={{ color: C.text, fontSize: 14, fontWeight: '700' }}>{title}</Text>
      </View>
      {children}
    </View>
  );
}
