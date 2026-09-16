'use client';
import React, { useEffect, useMemo, useState } from 'react';
import Shell from '@/components/Shell';
import { Card, PageHeader, Field, SearchableSelect, Notice, ConfirmDialog } from '@/components/ui';
import { api } from '@/lib/api';
import { fmtKES, fmtQty, fmtDateTime } from '@/lib/format';

// §28–§36 — Direct Fuel Entry: record fuel already issued WITHOUT the
// request→approval workflow. Permission-gated server-side
// (fuel_entries:create — §29); attendants never see it. Posting reuses the
// same ledger, guards and audit as workflow issues, stamped DIRECT_ENTRY.
export default function DirectEntryPage() {
  return <Shell><DirectEntry /></Shell>;
}

function todayISO() { return new Date().toISOString().slice(0, 10); }
function nowHM() { return new Date().toISOString().slice(11, 16); }

function DirectEntry() {
  const [vehicles, setVehicles] = useState([]);
  const [fuels, setFuels] = useState([]);
  const [tanks, setTanks] = useState([]);
  const [pumps, setPumps] = useState([]);
  const [role, setRole] = useState(null);
  const [form, setForm] = useState({
    date: todayISO(), time: nowHM(), vehicle_id: '', fuel_type_id: '', tank_id: '', pump_id: '',
    quantity: '', odometer: '', pump_start: '', pump_end: '', destination: '', purpose: '',
    unit_price: '', remarks: '',
  });
  const [costPrice, setCostPrice] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null); // { txn_no, applied, source, total, balance }

  // Accepts BOTH raw-input events (e.target.value) and plain values from
  // SearchableSelect — a raw event object must never reach state/render.
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v && v.target ? v.target.value : v }));

  useEffect(() => {
    api('/api/auth/me').then((d) => setRole(d?.user?.role || d?.role || null)).catch(() => {});
    api('/api/vehicles').then((r) => setVehicles(r.vehicles || [])).catch(() => {});
    api('/api/fuel-types').then((r) => setFuels(r.fuel_types || [])).catch(() => {});
    api('/api/tanks').then((r) => setTanks(r.tanks || [])).catch(() => {});
    api('/api/pumps').then((r) => setPumps(r.pumps || [])).catch(() => {});
  }, []);

  // §34 — cost price for the blank-price preview
  useEffect(() => {
    if (!form.fuel_type_id) { setCostPrice(null); return; }
    api(`/api/fuel-entries/price-preview?fuel_type_id=${form.fuel_type_id}`)
      .then((r) => setCostPrice(r.cost_price)).catch(() => setCostPrice(null));
  }, [form.fuel_type_id]);

  const tankOptions = useMemo(
    () => tanks.filter((t) => !form.fuel_type_id || t.fuel_type_id === form.fuel_type_id)
      .map((t) => ({ value: t.id, label: t.name, sub: (fuels.find((f) => f.id === t.fuel_type_id) || {}).name || '' })),
    [tanks, fuels, form.fuel_type_id],
  );
  const pumpOptions = useMemo(
    () => pumps.filter((p) => !form.tank_id || p.tank_id === form.tank_id)
      .map((p) => ({ value: p.id, label: p.name })),
    [pumps, form.tank_id],
  );

  function pickPump(id) {
    const p = pumps.find((x) => x.id === id);
    setForm((f) => ({ ...f, pump_id: id || '', tank_id: p?.tank_id || f.tank_id }));
  }

  const qty = Number(form.quantity) || 0;
  const userPrice = form.unit_price !== '' && Number(form.unit_price) > 0 ? Number(form.unit_price) : null;
  const applied = userPrice ?? costPrice;
  const source = userPrice != null ? 'USER ENTERED' : costPrice != null ? 'COST PRICE' : '—';
  const total = qty > 0 && applied != null ? qty * applied : null;

  function validate() {
    if (!form.vehicle_id) return 'Select the vehicle.';
    if (!form.fuel_type_id) return 'Select the fuel type.';
    if (!form.pump_id && !form.tank_id) return 'Select a pump or a tank.';
    if (!(qty > 0)) return 'Quantity must be greater than 0.';
    if (applied == null) return 'No cost price on record for this fuel type — enter a fueling price.';
    if (form.pump_start !== '' && form.pump_end !== '' && Number(form.pump_end) < Number(form.pump_start)) {
      return 'Pump end reading cannot be less than the start reading.';
    }
    return null;
  }

  async function submit() {
    setError('');
    setBusy(true);
    try {
      const r = await api('/api/fuel-entries/direct', {
        method: 'POST',
        body: {
          vehicle_id: form.vehicle_id,
          fuel_type_id: form.fuel_type_id,
          pump_id: form.pump_id || undefined,
          tank_id: form.tank_id || undefined,
          quantity: qty,
          unit_price: userPrice ?? undefined, // blank → server applies cost price (§34)
          odometer: form.odometer === '' ? undefined : Number(form.odometer),
          pump_start: form.pump_start === '' ? undefined : Number(form.pump_start),
          pump_end: form.pump_end === '' ? undefined : Number(form.pump_end),
          destination: form.destination || undefined,
          purpose: form.purpose || undefined,
          remarks: form.remarks || undefined,
          transaction_date: form.date && form.time ? `${form.date}T${form.time}:00` : undefined,
          client_uuid: crypto.randomUUID(),
        },
      });
      const e = r.entry || {};
      setDone({
        txn_no: e.txn_no, applied: Number(e.unit_price), source: r.price_source,
        total: Number(e.unit_price) * Number(e.quantity), balance: e.balance_after,
      });
      setConfirm(false);
      setForm((f) => ({ ...f, quantity: '', odometer: '', pump_start: '', pump_end: '', destination: '', purpose: '', unit_price: '', remarks: '' }));
    } catch (e2) {
      setError(e2.message || 'Could not record the entry.');
      setConfirm(false);
    } finally { setBusy(false); }
  }

  const vehicleName = (vehicles.find((v) => v.id === form.vehicle_id) || {}).plate || '—';
  const fuelName = (fuels.find((f) => f.id === form.fuel_type_id) || {}).name || '—';
  const tankName = (tanks.find((t) => t.id === form.tank_id) || {}).name || (form.pump_id ? '(from pump)' : '—');
  const pumpName = (pumps.find((p) => p.id === form.pump_id) || {}).name || '—';

  if (role === 'attendant') {
    return (
      <div style={{ display: 'grid', gap: 16 }}>
        <PageHeader title="Direct Fuel Entry" subtitle="Fuel already issued, recorded without a request" />
        <Card><span className="muted">Direct fuel entry is restricted to managers and administrators. Record fuel through an approved request instead.</span></Card>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <PageHeader
        title="Direct Fuel Entry"
        subtitle="Record fuel already issued — no request or approval needed. Posts straight to the inventory ledger."
      />

      {done && (
        <Notice kind="success">
          Recorded <b>{done.txn_no}</b> — {fmtKES(done.applied)}/L applied ({done.source}), total {fmtKES(done.total)}.
          {done.balance != null && <> Tank balance now {fmtQty(done.balance)}.</>}
        </Notice>
      )}
      {error && <Notice kind="error">{error}</Notice>}

      <Card title="Transaction details">
        <div className="frow">
          <Field label="Date"><input type="date" value={form.date} onChange={set('date')} /></Field>
          <Field label="Time"><input type="time" value={form.time} onChange={set('time')} /></Field>
          <Field label="Vehicle">
            <SearchableSelect
              value={form.vehicle_id} onChange={set('vehicle_id')} placeholder="Select vehicle…"
              options={vehicles.map((v) => ({ value: v.id, label: v.plate, sub: [v.make, v.model].filter(Boolean).join(' ') }))}
            />
          </Field>
          <Field label="Fuel type">
            <SearchableSelect
              value={form.fuel_type_id} onChange={(id) => { set('fuel_type_id')(id); set('pump_id')(''); set('tank_id')(''); }}
              placeholder="Select fuel…"
              options={fuels.map((f) => ({ value: f.id, label: f.name, sub: f.code || '' }))}
            />
          </Field>
        </div>
        <div className="frow">
          <Field label="Tank" hint={form.pump_id ? 'Auto-filled from the pump — you can override.' : undefined}>
            <SearchableSelect
              value={form.tank_id} onChange={set('tank_id')} placeholder="Select tank…"
              options={[{ value: '', label: '— none —' }, ...tankOptions]}
            />
          </Field>
          <Field label="Pump" hint="Optional — meter readings need a pump.">
            <SearchableSelect
              value={form.pump_id} onChange={pickPump} placeholder="Select pump…"
              options={[{ value: '', label: '— none —' }, ...pumpOptions]}
            />
          </Field>
        </div>
        <div className="frow">
          <Field label="Quantity (L) *"><input type="number" inputMode="decimal" step="0.01" min="0.01" value={form.quantity} onChange={set('quantity')} /></Field>
          <Field label="Odometer (km)"><input type="number" inputMode="numeric" min="0" value={form.odometer} onChange={set('odometer')} /></Field>
          <Field label="Pump start"><input type="number" inputMode="decimal" min="0" value={form.pump_start} onChange={set('pump_start')} /></Field>
          <Field label="Pump end"><input type="number" inputMode="decimal" min="0" value={form.pump_end} onChange={set('pump_end')} /></Field>
        </div>
        <div className="frow">
          <Field label="Destination"><input value={form.destination} onChange={set('destination')} placeholder="e.g. Molo" /></Field>
          <Field label="Purpose"><input value={form.purpose} onChange={set('purpose')} placeholder="e.g. Site visit" /></Field>
          <Field label="Fueling price (KES/L) — optional" hint={costPrice != null ? `Blank = cost price ${fmtKES(costPrice)}/L applies.` : 'No cost price on record — a price is required.'}>
            <input type="number" inputMode="decimal" step="0.01" min="0" value={form.unit_price} onChange={set('unit_price')} placeholder={costPrice != null ? String(costPrice) : 'required'} />
          </Field>
        </div>
        <Field label="Remarks"><input value={form.remarks} onChange={set('remarks')} placeholder="Anything worth noting (optional)" /></Field>
      </Card>

      <Card title="Preview">
        <div className="kv">
          {[
            ['Date', `${form.date} ${form.time}`],
            ['Vehicle', vehicleName],
            ['Fuel type', fuelName],
            ['Tank', tankName],
            ['Pump', pumpName],
            ['Destination', form.destination || '—'],
            ['Quantity', fmtQty(qty)],
            ...(applied != null ? [['Applied price', `${fmtKES(applied)}/L — ${source}`]] : [['Applied price', '—']]),
            ...(total != null ? [['Total value', fmtKES(total)]] : []),
            ...(form.odometer !== '' ? [['Odometer', `${Number(form.odometer).toLocaleString()} km`]] : []),
          ].map(([k, v]) => <div className="kv-row" key={k}><span className="kv-k">{k}</span><span className="kv-v">{v}</span></div>)}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
          <button type="button" className="btn secondary" onClick={() => setForm({ date: todayISO(), time: nowHM(), vehicle_id: '', fuel_type_id: '', tank_id: '', pump_id: '', quantity: '', odometer: '', pump_start: '', pump_end: '', destination: '', purpose: '', unit_price: '', remarks: '' })}>Reset</button>
          <button type="button" className="btn" onClick={() => setError(validate() || '')} disabled={!!validate()}>Record Fuel…</button>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          Posting reduces station stock immediately, writes both ledgers and creates a DIRECT_FUEL_ENTRY_CREATED audit event. No approval is created; corrections use the normal reversal flow.
        </div>
      </Card>

      <ConfirmDialog
        open={confirm}
        title="Record this direct fuel entry?"
        message={applied != null
          ? `${fmtQty(qty)} ${fuelName} for ${vehicleName} — ${fmtKES(applied)}/L applied (${source}), total ${fmtKES(total ?? 0)}. Stock is reduced immediately.`
          : 'Ready to post.'}
        confirmLabel="Record Fuel"
        busy={busy}
        onConfirm={submit}
        onCancel={() => setConfirm(false)}
      />
    </div>
  );
}
