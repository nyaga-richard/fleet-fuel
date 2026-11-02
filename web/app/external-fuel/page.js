'use client';
// External Fuel Records (§1–§7) — fuel bought OUTSIDE the station (supplier,
// garage, roadside) and charged to the VEHICLE only. This ledger NEVER moves
// station stock, pumps or reconciliations (§1 pillar) — the page is labelled
// accordingly so users cannot confuse the two ledgers.
import { useCallback, useEffect, useMemo, useState } from 'react';
import Shell from '@/components/Shell';
import { Card, PageHeader, DataTable, StatusPill, Notice, Skeleton, Field, ExportMenu, SearchableSelect, FilterBar, useForm, Drawer } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtKES, fmtQty } from '@/lib/format';

export default function ExternalFuelPage() {
  return <Shell><ExternalFuel /></Shell>;
}

const PAY_METHODS = [
  { value: 'CASH', label: 'Cash' },
  { value: 'CARD', label: 'Card' },
  { value: 'ACCOUNT', label: 'Account' },
  { value: 'OTHER', label: 'Other' },
];

function ExternalFuel() {
  const { user } = useAuth();
  const canRecord = user?.role === 'admin' || user?.role === 'manager';
  const [rows, setRows] = useState(null);
  const [vehicles, setVehicles] = useState([]);
  const [fuelTypes, setFuelTypes] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [fVehicle, setFVehicle] = useState('');
  const [fSupplier, setFSupplier] = useState('');
  const [fFrom, setFFrom] = useState('');
  const [fTo, setFTo] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const { form, setForm } = useForm({ vehicle_id: '', fuel_type_id: '', supplier: '', quantity: '', unit_price: '', odometer: '', receipt_no: '', payment_method: 'CASH', transaction_date: '', notes: '' });

  const load = useCallback(async () => {
    setError('');
    try {
      const p = new URLSearchParams();
      if (fVehicle) p.set('vehicle_id', fVehicle);
      if (fSupplier) p.set('supplier', fSupplier);
      if (fFrom) p.set('from', fFrom);
      if (fTo) p.set('to', fTo);
      const r = await api('/api/external-fuel?' + p.toString());
      setRows(r.entries);
    } catch (e) { setError(e.message); }
  }, [fVehicle, fSupplier, fFrom, fTo]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    Promise.all([api('/api/vehicles'), api('/api/fuel-types')])
      .then(([v, f]) => { setVehicles(v.vehicles || []); setFuelTypes(f.fuel_types || []); })
      .catch(() => { /* filters degrade to plain lists */ });
  }, []);

  const vehicleOptions = useMemo(() => vehicles.map((v) => ({ value: v.id, label: v.plate, sub: [v.make, v.model].filter(Boolean).join(' ') })), [vehicles]);
  const fuelOptions = useMemo(() => fuelTypes.map((f) => ({ value: f.id, label: f.name })), [fuelTypes]);
  const total = (Number(form.quantity) || 0) * (Number(form.unit_price) || 0);

  async function submit(e) {
    e.preventDefault();
    if (!form.vehicle_id) return setError('Select a vehicle');
    if (!form.fuel_type_id) return setError('Select a fuel type');
    setBusy(true); setError('');
    try {
      const body = { ...form, quantity: Number(form.quantity), unit_price: Number(form.unit_price) };
      if (!body.odometer) delete body.odometer;
      if (!body.receipt_no) delete body.receipt_no;
      if (!body.transaction_date) delete body.transaction_date;
      if (!body.notes) delete body.notes;
      const r = await api('/api/external-fuel', { method: 'POST', body });
      const v = vehicles.find((x) => x.id === form.vehicle_id);
      setNotice(`External fuel recorded against ${v ? v.plate : 'vehicle'} — station stock untouched.`);
      setFormOpen(false);
      setForm({ vehicle_id: '', fuel_type_id: '', supplier: '', quantity: '', unit_price: '', odometer: '', receipt_no: '', payment_method: 'CASH', transaction_date: '', notes: '' });
      load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  const cols = [
    { key: 'transaction_date', label: 'Date', render: (r) => fmtDate(r.transaction_date || r.created_at) },
    { key: 'plate', label: 'Vehicle', render: (r) => r.plate || '—' },
    { key: 'supplier', label: 'Supplier' },
    { key: 'fuel_type', label: 'Fuel', render: (r) => r.fuel_type_name || '—' },
    { key: 'quantity', label: 'Qty (L)', right: true, render: (r) => fmtQty(r.quantity) },
    { key: 'unit_price', label: 'Unit Price', right: true, render: (r) => fmtKES(r.unit_price) },
    { key: 'total_amount', label: 'Total', right: true, render: (r) => fmtKES(r.total_amount) },
    { key: 'odometer', label: 'Odometer', right: true, render: (r) => (r.odometer != null ? fmtQty(r.odometer) + ' km' : '—') },
    { key: 'receipt_no', label: 'Receipt No', render: (r) => r.receipt_no || '—' },
    { key: 'payment_method', label: 'Paid By', render: (r) => <StatusPill status={r.payment_method} /> },
  ];

  return (
    <>
      <PageHeader
        title="External Fuel"
        subtitle="Fuel purchased outside the station — recorded against the vehicle only. Never affects station stock."
        actions={<>
          <ExportMenu report="vehicle-fuel-unified" params={{ source: 'EXTERNAL', vehicle_id: fVehicle, from: fFrom, to: fTo }} />
          {canRecord && <button className="btn primary" onClick={() => setFormOpen(true)}>+ Record External Fuel</button>}
        </>}
      />

      <div style={{ marginBottom: 14, padding: '10px 14px', border: '1px solid #fcd34d', background: '#fffbeb', borderRadius: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="pill" style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fcd34d' }}>
          ⚠ Vehicle Fuel Ledger — separate from the Station Fuel Ledger
        </span>
        <span className="muted" style={{ fontSize: 13 }}>Entries here never reduce pump/tank stock and never appear as station issues (§1–§7).</span>
      </div>

      {error && <Notice kind="error">{error}</Notice>}
      {notice && <Notice kind="success" onDone={() => setNotice('')}>{notice}</Notice>}

      <FilterBar activeCount={(fVehicle ? 1 : 0) + (fSupplier ? 1 : 0) + (fFrom ? 1 : 0) + (fTo ? 1 : 0)}>
        <div style={{ width: 240 }}>
          <SearchableSelect value={fVehicle} onChange={setFVehicle} options={vehicleOptions} placeholder="All vehicles" />
        </div>
        <input className="input" placeholder="Supplier contains…" value={fSupplier} onChange={(e) => setFSupplier(e.target.value)} style={{ width: 200 }} />
        <input className="input" type="date" value={fFrom} onChange={(e) => setFFrom(e.target.value)} style={{ width: 150 }} />
        <input className="input" type="date" value={fTo} onChange={(e) => setFTo(e.target.value)} style={{ width: 150 }} />
      </FilterBar>

      <Card>
        {rows == null ? <Skeleton lines={6} /> : (
          <DataTable columns={cols} rows={rows} empty="No external fuel records yet" />
        )}
      </Card>

      <Drawer open={formOpen} onClose={() => setFormOpen(false)} title="Record external fuel" subtitle="Against the vehicle only — this never touches station stock" width={520}>
        <form onSubmit={submit}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Vehicle *">
              <SearchableSelect required value={form.vehicle_id} onChange={(v) => setForm((f) => ({ ...f, vehicle_id: v }))} options={vehicleOptions} placeholder="Select vehicle…" />
            </Field>
            <Field label="Fuel type *">
              <SearchableSelect required value={form.fuel_type_id} onChange={(v) => setForm((f) => ({ ...f, fuel_type_id: v }))} options={fuelOptions} placeholder="Select fuel…" />
            </Field>
            <Field label="Supplier *" hint="Garage, oil marketer, roadside…">
              <input className="input" required value={form.supplier} onChange={(e) => setForm((f) => ({ ...f, supplier: e.target.value }))} placeholder="e.g. Total Nakuru" />
            </Field>
            <Field label="Payment method">
              <SearchableSelect value={form.payment_method} onChange={(v) => setForm((f) => ({ ...f, payment_method: v || 'CASH' }))} options={PAY_METHODS} placeholder="Cash" />
            </Field>
            <Field label="Quantity (L) *">
              <input className="input" required type="number" min="0.01" step="0.01" value={form.quantity} onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))} />
            </Field>
            <Field label="Unit price *">
              <input className="input" required type="number" min="0" step="0.01" value={form.unit_price} onChange={(e) => setForm((f) => ({ ...f, unit_price: e.target.value }))} />
            </Field>
            <Field label="Odometer (km)" hint="Feeds the vehicle's mileage trail">
              <input className="input" type="number" min="0" step="0.1" value={form.odometer} onChange={(e) => setForm((f) => ({ ...f, odometer: e.target.value }))} />
            </Field>
            <Field label="Receipt no">
              <input className="input" value={form.receipt_no} onChange={(e) => setForm((f) => ({ ...f, receipt_no: e.target.value }))} />
            </Field>
            <Field label="Transaction date">
              <input className="input" type="date" value={form.transaction_date} onChange={(e) => setForm((f) => ({ ...f, transaction_date: e.target.value }))} />
            </Field>
            <Field label="Total (computed)">
              <input className="input" disabled value={fmtKES(total)} />
            </Field>
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Notes">
                <input className="input" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
              </Field>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={() => setFormOpen(false)}>Cancel</button>
            <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Recording…' : 'Record fuel'}</button>
          </div>
        </form>
      </Drawer>
    </>
  );
}
