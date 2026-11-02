'use client';
import React, { useEffect, useMemo, useState } from 'react';
import Shell from '@/components/Shell';
import { Card, PageHeader, Field, SearchableSelect, Notice, ConfirmDialog } from '@/components/ui';
import { api } from '@/lib/api';
import { fmtKES, fmtQty } from '@/lib/format';

// §28–§36 — Direct Fuel Entry: record fuel already issued WITHOUT the
// request→approval workflow. Permission-gated server-side
// (fuel_entries:create); attendants never see it. Posting reuses the same
// ledger, guards and audit as workflow issues, stamped DIRECT_ENTRY.
// Kept to the essentials: date, vehicle, fuel, tank, quantity, odometer,
// optional price, optional destination. Everything else defaults.
export default function DirectEntryPage() {
  return <Shell><DirectEntry /></Shell>;
}

function todayISO() { return new Date().toISOString().slice(0, 10); }
function nowHM() { return new Date().toISOString().slice(11, 16); }
function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function DirectEntry() {
  const [vehicles, setVehicles] = useState([]);
  const [fuels, setFuels] = useState([]);
  const [tanks, setTanks] = useState([]);
  const [role, setRole] = useState(null);
  const [form, setForm] = useState({
    date: todayISO(), vehicle_id: '', fuel_type_id: '', tank_id: '', lpo_no: '',
    quantity: '', odometer: '', unit_price: '', destination: '',
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

  const qty = Number(form.quantity) || 0;
  const userPrice = form.unit_price !== '' && Number(form.unit_price) > 0 ? Number(form.unit_price) : null;
  const applied = userPrice ?? costPrice;
  const source = userPrice != null ? 'USER ENTERED' : costPrice != null ? 'COST PRICE' : '—';
  const total = qty > 0 && applied != null ? qty * applied : null;

  function validate() {
    if (!form.vehicle_id) return 'Select the vehicle.';
    if (!form.fuel_type_id) return 'Select the fuel type.';
    if (!form.tank_id) return 'Select the tank.';
    if (!(qty > 0)) return 'Enter the quantity in litres.';
    if (applied == null) return 'No cost price on record for this fuel type — enter a fueling price.';
    return null;
  }

  // Always responsive: shows WHAT is missing instead of a silently dead button.
  function tryConfirm() {
    const v = validate();
    setError(v || '');
    if (!v) setConfirm(true);
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
          tank_id: form.tank_id,
          quantity: qty,
          unit_price: userPrice ?? undefined, // blank → server applies cost price (§34)
          odometer: form.odometer === '' ? undefined : Number(form.odometer),
          destination: form.destination || undefined,
          transaction_date: form.date ? `${form.date}T${nowHM()}:00` : undefined,
          lpo_no: form.lpo_no?.trim() || undefined,
          client_uuid: uuid(),
        },
      });
      const e = r.entry || {};
      setDone({
        txn_no: e.txn_no, applied: Number(e.unit_price), source: r.price_source,
        total: Number(e.unit_price) * Number(e.quantity), balance: e.balance_after,
      });
      setConfirm(false);
      setForm((f) => ({ ...f, quantity: '', odometer: '', unit_price: '', destination: '' }));
    } catch (e2) {
      setError(e2.message || 'Could not record the entry.');
      setConfirm(false);
    } finally { setBusy(false); }
  }

  const vehicleName = (vehicles.find((v) => v.id === form.vehicle_id) || {}).plate || '—';
  const fuelName = (fuels.find((f) => f.id === form.fuel_type_id) || {}).name || '—';
  const tankName = (tanks.find((t) => t.id === form.tank_id) || {}).name || '—';
  const reset = () => setForm({ date: todayISO(), vehicle_id: '', fuel_type_id: '', tank_id: '', quantity: '', odometer: '', unit_price: '', destination: '', lpo_no: '' });

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
      {(done || error) && (
        <div>
          {done && (
            <Notice kind="success">
              Recorded <b>{done.txn_no}</b> — {fmtKES(done.applied)}/L applied ({done.source}), total {fmtKES(done.total)}.
              {done.balance != null && <> Tank balance now {fmtQty(done.balance)}.</>}
            </Notice>
          )}
          {error && <Notice kind="error">{error}</Notice>}
        </div>
      )}

      <div className="de-grid">
        <Card title="Entry details">
          <div className="frow">
            <Field label="Date"><input type="date" value={form.date} onChange={set('date')} /></Field>
            <Field label="Quantity (L) *"><input type="number" inputMode="decimal" step="0.01" min="0.01" value={form.quantity} onChange={set('quantity')} placeholder="e.g. 85.5" /></Field>
          </div>
          <div className="frow">
            <Field label="Vehicle *">
              <SearchableSelect
                value={form.vehicle_id} onChange={set('vehicle_id')} placeholder="Select vehicle…"
                options={vehicles.map((v) => ({ value: v.id, label: v.plate, sub: [v.make, v.model].filter(Boolean).join(' ') }))}
              />
            </Field>
            <Field label="Fuel type *">
              <SearchableSelect
                value={form.fuel_type_id} onChange={(id) => { set('fuel_type_id')(id); set('tank_id')(''); }}
                placeholder="Select fuel…"
                options={fuels.map((f) => ({ value: f.id, label: f.name, sub: f.code || '' }))}
              />
            </Field>
          </div>
          <div className="frow">
            <Field label="Tank *">
              <SearchableSelect
                value={form.tank_id} onChange={set('tank_id')} placeholder={form.fuel_type_id ? 'Select tank…' : 'Select fuel type first'}
                options={tankOptions}
              />
            </Field>
            <Field label="Odometer (km)"><input type="number" inputMode="numeric" min="0" value={form.odometer} onChange={set('odometer')} placeholder="e.g. 124870" /></Field>
          </div>
          <div className="frow">
            <Field label="Fueling price (KES/L) — optional" hint={costPrice != null ? `Leave blank to use the cost price (${fmtKES(costPrice)}/L).` : 'No cost price on record — enter a price.'}>
              <input type="number" inputMode="decimal" step="0.01" min="0" value={form.unit_price} onChange={set('unit_price')} placeholder={costPrice != null ? String(costPrice) : 'required'} />
            </Field>
            <Field label="Destination — optional"><input value={form.destination} onChange={set('destination')} placeholder="e.g. Molo" /></Field>
            <Field label="LPO No — optional" hint="Customer Local Purchase Order reference"><input value={form.lpo_no} onChange={set('lpo_no')} placeholder="e.g. LPO/2026/00421" /></Field>
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            Posting reduces station stock immediately, writes both ledgers and creates an audit event. No approval is created; corrections use the normal reversal flow.
          </div>
        </Card>

        <div className="de-side">
          <Card title="Preview">
            <div className="kv">
              {[
                ['Vehicle', vehicleName],
                ['Fuel', fuelName],
                ['Tank', tankName],
                ['Quantity', fmtQty(qty)],
                ...(applied != null ? [['Applied price', `${fmtKES(applied)}/L — ${source}`]] : [['Applied price', '—']]),
                ...(total != null ? [['Total value', fmtKES(total)]] : []),
                ...(form.odometer !== '' ? [['Odometer', `${Number(form.odometer).toLocaleString()} km`]] : []),
              ].map(([k, v]) => <div className="kv-row" key={k}><span className="kv-k">{k}</span><span className="kv-v">{v}</span></div>)}
            </div>
            <div className="de-actions" style={{ marginTop: 14 }}>
              <button type="button" className="btn secondary" onClick={reset}>Reset</button>
              <button type="button" className="btn" onClick={tryConfirm} disabled={busy}>Record Fuel…</button>
            </div>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={confirm}
        title="Record this direct fuel entry?"
        message={applied != null
          ? `${fmtQty(qty)} ${fuelName} for ${vehicleName} from ${tankName} — ${fmtKES(applied)}/L applied (${source}), total ${fmtKES(total ?? 0)}. Stock is reduced immediately.`
          : 'Ready to post.'}
        confirmLabel="Record Fuel"
        busy={busy}
        onConfirm={submit}
        onCancel={() => setConfirm(false)}
      />
    </div>
  );
}
