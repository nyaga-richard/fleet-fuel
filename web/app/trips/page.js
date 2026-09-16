'use client';
// Trips (§20–§27) — journeys with OPTIONAL revenue. A trip is valid without
// any revenue (internal, administrative, empty-return). Profitability is
// always labelled "Gross Contribution", never profit (§22).
import { useCallback, useEffect, useMemo, useState } from 'react';
import Shell from '@/components/Shell';
import { Card, PageHeader, DataTable, StatusPill, Notice, Skeleton, Field, ExportMenu, SearchableSelect, FilterBar, Tabs, useForm, Drawer, ConfirmDialog } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtKES, fmtQty } from '@/lib/format';

export default function TripsPage() {
  return <Shell><Trips /></Shell>;
}

const STATUSES = ['PLANNED', 'AUTHORIZED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];

function Trips() {
  const { user } = useAuth();
  const canManage = user?.role === 'admin' || user?.role === 'manager';
  const [rows, setRows] = useState(null);
  const [vehicles, setVehicles] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [fVehicle, setFVehicle] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [tab, setTab] = useState('all');
  const [formOpen, setFormOpen] = useState(false);
  const [completing, setCompleting] = useState(null); // trip being completed
  const [endOdo, setEndOdo] = useState('');
  const [cancelling, setCancelling] = useState(null);
  const [cancelReason, setCancelReason] = useState('');
  const [revenueFor, setRevenueFor] = useState(null); // trip for revenue drawer
  const { form, setForm } = useForm({ vehicle_id: '', driver_name: '', trip_date: '', start_location: '', destination: '', purpose: '', department: '', start_odometer: '', load_info: '', notes: '', revenue_amount: '', revenue_customer: '', revenue_type: '' });
  const { form: revForm, setForm: setRevForm } = useForm({ revenue_amount: '', revenue_customer: '', revenue_type: '', revenue_payment_status: 'UNPAID', revenue_invoice_ref: '' });

  const load = useCallback(async () => {
    setError('');
    try {
      const p = new URLSearchParams();
      if (fVehicle) p.set('vehicle_id', fVehicle);
      if (fStatus) p.set('status', fStatus);
      const r = await api('/api/trips?' + p.toString());
      setRows(r.trips);
    } catch (e) { setError(e.message); }
  }, [fVehicle, fStatus]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api('/api/vehicles').then((r) => setVehicles(r.vehicles || [])).catch(() => {}); }, []);

  const vehicleOptions = useMemo(() => vehicles.map((v) => ({ value: v.id, label: v.plate, sub: [v.make, v.model].filter(Boolean).join(' ') })), [vehicles]);
  const shown = useMemo(() => (rows || []).filter((t) => tab === 'all' || t.status === tab), [rows, tab]);
  const selectedVehicle = vehicles.find((v) => v.id === form.vehicle_id);

  async function pickVehicle(id) {
    setForm((f) => ({ ...f, vehicle_id: id, start_odometer: '' }));
    if (id) {
      try {
        const d = await api(`/api/vehicles/${id}/detail`);
        if (d.vehicle?.current_odometer != null) setForm((f) => ({ ...f, vehicle_id: id, start_odometer: String(d.vehicle.current_odometer) }));
      } catch { /* leave blank */ }
    }
  }

  async function submit(e) {
    e.preventDefault();
    if (!form.vehicle_id) return setError('Select a vehicle');
    setBusy(true); setError('');
    try {
      const body = { ...form };
      if (body.revenue_amount === '') delete body.revenue_amount; else body.revenue_amount = Number(body.revenue_amount);
      for (const k of Object.keys(body)) if (body[k] === '') delete body[k];
      if (body.start_odometer != null) body.start_odometer = Number(body.start_odometer);
      await api('/api/trips', { method: 'POST', body });
      setNotice('Trip created.');
      setFormOpen(false);
      setForm({ vehicle_id: '', driver_name: '', trip_date: '', start_location: '', destination: '', purpose: '', department: '', start_odometer: '', load_info: '', notes: '', revenue_amount: '', revenue_customer: '', revenue_type: '' });
      load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function act(path, body, msg) {
    setBusy(true); setError('');
    try {
      await api(path, { method: 'POST', body });
      setNotice(msg);
      load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function saveRevenue(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const body = {};
      for (const k of Object.keys(revForm)) if (revForm[k] !== '') body[k] = revForm[k];
      if (body.revenue_amount != null) body.revenue_amount = Number(body.revenue_amount);
      await api(`/api/trips/${revenueFor.id}/revenue`, { method: 'PUT', body });
      setNotice(`Revenue recorded for ${revenueFor.trip_no}.`);
      setRevenueFor(null);
      load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  const cols = [
    { key: 'trip_no', label: 'Trip No' },
    { key: 'trip_date', label: 'Date', render: (t) => fmtDate(t.trip_date) },
    { key: 'plate', label: 'Vehicle', render: (t) => t.plate || '—' },
    { key: 'driver_name', label: 'Driver', render: (t) => t.driver_name || '—' },
    { key: 'route', label: 'Route', render: (t) => [t.start_location, t.destination].filter(Boolean).join(' → ') || '—' },
    { key: 'status', label: 'Status', render: (t) => <StatusPill status={t.status} /> },
    { key: 'distance', label: 'Distance', right: true, render: (t) => (t.distance != null ? `${fmtQty(t.distance)} km` : '—') },
    { key: 'revenue_amount', label: 'Revenue', right: true, render: (t) => (t.revenue_amount != null ? fmtKES(t.revenue_amount) : <span className="muted">no revenue</span>) },
    { key: 'revenue_payment_status', label: 'Payment', render: (t) => (t.revenue_payment_status ? <StatusPill status={t.revenue_payment_status} /> : '—') },
    {
      key: 'actions', label: '', render: (t) => !canManage ? null : (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {['PLANNED', 'AUTHORIZED'].includes(t.status) && (
            <button className="btn small" disabled={busy} onClick={() => act(`/api/trips/${t.id}/start`, {}, `${t.trip_no} started.`)}>Start</button>
          )}
          {['PLANNED', 'AUTHORIZED', 'IN_PROGRESS'].includes(t.status) && (
            <button className="btn small" onClick={() => { setCompleting(t); setEndOdo(t.start_odometer != null ? String(t.start_odometer) : ''); }}>Complete</button>
          )}
          {t.status !== 'COMPLETED' && t.status !== 'CANCELLED' && (
            <button className="btn small" onClick={() => { setCancelling(t); setCancelReason(''); }}>Cancel</button>
          )}
          <button className="btn small" onClick={() => { setRevenueFor(t); setRevForm({ revenue_amount: t.revenue_amount != null ? String(t.revenue_amount) : '', revenue_customer: t.revenue_customer || '', revenue_type: t.revenue_type || '', revenue_payment_status: t.revenue_payment_status || 'UNPAID', revenue_invoice_ref: t.revenue_invoice_ref || '' }); }}>Revenue</button>
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Trips"
        subtitle="Journeys with optional revenue — internal and administrative trips never require it."
        actions={<>
          <ExportMenu report="trips" params={{ vehicle_id: fVehicle, status: fStatus }} />
          {canManage && <button className="btn primary" onClick={() => setFormOpen(true)}>+ New Trip</button>}
        </>}
      />

      {error && <Notice kind="error">{error}</Notice>}
      {notice && <Notice kind="success" onDone={() => setNotice('')}>{notice}</Notice>}

      <FilterBar activeCount={(fVehicle ? 1 : 0) + (fStatus ? 1 : 0)}>
        <div style={{ width: 230 }}>
          <SearchableSelect value={fVehicle} onChange={setFVehicle} options={vehicleOptions} placeholder="All vehicles" />
        </div>
        <div style={{ width: 180 }}>
          <SearchableSelect value={fStatus} onChange={setFStatus} options={STATUSES.map((s) => ({ value: s, label: s }))} placeholder="All statuses" />
        </div>
      </FilterBar>

      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'all', label: 'All' }, ...STATUSES.map((s) => ({ value: s, label: s }))]} />

      <Card>
        {rows == null ? <Skeleton lines={7} /> : (
          <DataTable columns={cols} rows={shown} empty="No trips yet — create one to start tracking" />
        )}
      </Card>

      {/* New trip — revenue section is explicitly OPTIONAL (§22) */}
      <Drawer open={formOpen} onClose={() => setFormOpen(false)} title="New trip" subtitle="Revenue is optional — leave it blank for internal or admin trips" width={540}>
        <form onSubmit={submit}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Vehicle *">
              <SearchableSelect required value={form.vehicle_id} onChange={pickVehicle} options={vehicleOptions} placeholder="Select vehicle…" />
            </Field>
            <Field label="Driver">
              <input className="input" value={form.driver_name} onChange={(e) => setForm((f) => ({ ...f, driver_name: e.target.value }))} />
            </Field>
            <Field label="Trip date">
              <input className="input" type="date" value={form.trip_date} onChange={(e) => setForm((f) => ({ ...f, trip_date: e.target.value }))} />
            </Field>
            <Field label="Department">
              <input className="input" value={form.department} onChange={(e) => setForm((f) => ({ ...f, department: e.target.value }))} />
            </Field>
            <Field label="From">
              <input className="input" value={form.start_location} onChange={(e) => setForm((f) => ({ ...f, start_location: e.target.value }))} />
            </Field>
            <Field label="Destination">
              <input className="input" value={form.destination} onChange={(e) => setForm((f) => ({ ...f, destination: e.target.value }))} />
            </Field>
            <Field label="Purpose">
              <input className="input" value={form.purpose} onChange={(e) => setForm((f) => ({ ...f, purpose: e.target.value }))} placeholder="Delivery, site visit…" />
            </Field>
            <Field label="Load info">
              <input className="input" value={form.load_info} onChange={(e) => setForm((f) => ({ ...f, load_info: e.target.value }))} />
            </Field>
            <Field label="Start odometer (km)" hint={selectedVehicle ? `Current: ${fmtQty(selectedVehicle.current_odometer)} km` : 'Prefilled from the vehicle'}>
              <input className="input" type="number" min="0" step="0.1" value={form.start_odometer} onChange={(e) => setForm((f) => ({ ...f, start_odometer: e.target.value }))} />
            </Field>
            <div />
            <div style={{ gridColumn: '1 / -1', borderTop: '1px dashed #d4d4d8', paddingTop: 10 }}>
              <Field label="Revenue amount — OPTIONAL" hint="Leave blank for internal, admin or empty-return trips. Never required.">
                <input className="input" type="number" min="0" step="0.01" value={form.revenue_amount} onChange={(e) => setForm((f) => ({ ...f, revenue_amount: e.target.value }))} placeholder="e.g. 25000" />
              </Field>
            </div>
            {form.revenue_amount !== '' && <>
              <Field label="Customer">
                <input className="input" value={form.revenue_customer} onChange={(e) => setForm((f) => ({ ...f, revenue_customer: e.target.value }))} />
              </Field>
              <Field label="Revenue type">
                <input className="input" value={form.revenue_type} onChange={(e) => setForm((f) => ({ ...f, revenue_type: e.target.value }))} placeholder="Contract, ad-hoc…" />
              </Field>
            </>}
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Notes">
                <input className="input" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
              </Field>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={() => setFormOpen(false)}>Cancel</button>
            <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Creating…' : 'Create trip'}</button>
          </div>
        </form>
      </Drawer>

      {/* Completion (§23): end ≥ start enforced server-side; distance computed */}
      <Drawer open={!!completing} onClose={() => setCompleting(null)} title={`Complete ${completing?.trip_no || ''}`} subtitle="Ending odometer cannot be less than the starting odometer" width={420}>
        <form onSubmit={(e) => { e.preventDefault(); act(`/api/trips/${completing.id}/complete`, { end_odometer: Number(endOdo) }, `${completing.trip_no} completed.`).then(() => setCompleting(null)); }}>
          <Field label="Ending odometer (km) *" hint={completing?.start_odometer != null ? `Start: ${fmtQty(completing.start_odometer)} km` : ''}>
            <input className="input" required type="number" min="0" step="0.1" value={endOdo} onChange={(e) => setEndOdo(e.target.value)} />
          </Field>
          {completing?.start_odometer != null && Number(endOdo) > Number(completing.start_odometer) && (
            <p className="muted" style={{ fontSize: 13 }}>Distance: {fmtQty(Number(endOdo) - Number(completing.start_odometer))} km</p>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={() => setCompleting(null)}>Back</button>
            <button type="submit" className="btn primary" disabled={busy}>Complete trip</button>
          </div>
        </form>
      </Drawer>

      {/* Revenue upsert (§24) — adds or amends, never forced */}
      <Drawer open={!!revenueFor} onClose={() => setRevenueFor(null)} title={`Revenue — ${revenueFor?.trip_no || ''}`} subtitle="Optional: record or amend what this trip earned" width={460}>
        <form onSubmit={saveRevenue}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Revenue amount">
              <input className="input" type="number" min="0" step="0.01" value={revForm.revenue_amount} onChange={(e) => setRevForm((f) => ({ ...f, revenue_amount: e.target.value }))} />
            </Field>
            <Field label="Payment status">
              <SearchableSelect value={revForm.revenue_payment_status} onChange={(v) => setRevForm((f) => ({ ...f, revenue_payment_status: v }))} options={['UNPAID', 'PARTPAID', 'PAID'].map((s) => ({ value: s, label: s }))} />
            </Field>
            <Field label="Customer">
              <input className="input" value={revForm.revenue_customer} onChange={(e) => setRevForm((f) => ({ ...f, revenue_customer: e.target.value }))} />
            </Field>
            <Field label="Invoice ref">
              <input className="input" value={revForm.revenue_invoice_ref} onChange={(e) => setRevForm((f) => ({ ...f, revenue_invoice_ref: e.target.value }))} />
            </Field>
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Revenue type">
                <input className="input" value={revForm.revenue_type} onChange={(e) => setRevForm((f) => ({ ...f, revenue_type: e.target.value }))} />
              </Field>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={() => setRevenueFor(null)}>Back</button>
            <button type="submit" className="btn primary" disabled={busy}>Save revenue</button>
          </div>
        </form>
      </Drawer>

      <ConfirmDialog
        open={!!cancelling} danger title={`Cancel ${cancelling?.trip_no || ''}?`}
        message="The trip is marked CANCELLED and the reason is kept in its history. It is never deleted."
        busy={busy}
        onCancel={() => setCancelling(null)}
        onConfirm={() => { act(`/api/trips/${cancelling.id}/cancel`, { reason: cancelReason || 'Cancelled by user' }, `${cancelling.trip_no} cancelled.`); setCancelling(null); }}
      >
        <Field label="Reason">
          <input className="input" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} placeholder="Why is this trip cancelled?" />
        </Field>
      </ConfirmDialog>
    </>
  );
}
