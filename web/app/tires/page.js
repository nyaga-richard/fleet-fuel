'use client';
// Tires (§10–§19) — serial-numbered assets with an append-only lifecycle.
// Fit / remove / rotate only; history is never rewritten. The Vehicle Layout
// tab draws the live wheel positions for the selected axle configuration.
import { useCallback, useEffect, useMemo, useState } from 'react';
import Shell from '@/components/Shell';
import { Card, PageHeader, DataTable, StatusPill, Notice, Skeleton, Field, ExportMenu, SearchableSelect, Tabs, useForm, Drawer, EmptyState } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtKES, fmtQty } from '@/lib/format';

export default function TiresPage() {
  return <Shell><Tires /></Shell>;
}

const POSITION_LABELS = {
  FL: 'Front Left', FR: 'Front Right', RL: 'Rear Left', RR: 'Rear Right',
  RLO: 'Rear Left Outer', RLI: 'Rear Left Inner', RRO: 'Rear Right Outer', RRI: 'Rear Right Inner',
  MLO: 'Mid Left Outer', MLI: 'Mid Left Inner', MRO: 'Mid Right Outer', MRI: 'Mid Right Inner',
};

function Tires() {
  const { user } = useAuth();
  const canManage = user?.role === 'admin' || user?.role === 'manager';
  const [tab, setTab] = useState('register');
  return (
    <>
      <PageHeader
        title="Tires"
        subtitle="Serial-numbered tire assets — one tire, one position. Full lifecycle history, never rewritten."
        actions={<ExportMenu report="tire-register" />}
      />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'register', label: 'Register' }, { value: 'layout', label: 'Vehicle Layout' }]} />
      {tab === 'register' ? <Register canManage={canManage} /> : <Layout canManage={canManage} />}
    </>
  );
}

// ── Register ────────────────────────────────────────────────────────────────
function Register({ canManage }) {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [detail, setDetail] = useState(null); // {tire, history}
  const [fitting, setFitting] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [rotating, setRotating] = useState(null);
  const [vehicles, setVehicles] = useState([]);
  const { form, setForm } = useForm({ serial_no: '', brand: '', pattern: '', size: '', tire_type: '', ply_rating: '', supply_condition: 'NEW', purchase_date: '', purchase_cost: '', supplier: '', tread_depth_mm: '', notes: '' });
  const { form: fitForm, setForm: setFitForm } = useForm({ vehicle_id: '', position: '', odometer: '', tread_depth_mm: '' });
  const { form: remForm, setForm: setRemForm } = useForm({ odometer: '', reason: '', destination: 'USED_STORE', tread_depth_mm: '' });
  const { form: rotForm, setForm: setRotForm } = useForm({ to_position: '', odometer: '' });
  const [fitPositions, setFitPositions] = useState([]);
  const [rotPositions, setRotPositions] = useState([]);

  const load = useCallback(async () => {
    setError('');
    try {
      const p = new URLSearchParams();
      if (q) p.set('q', q);
      if (fStatus) p.set('status', fStatus);
      const r = await api('/api/tires?' + p.toString());
      setRows(r.tires);
    } catch (e) { setError(e.message); }
  }, [q, fStatus]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api('/api/vehicles').then((r) => setVehicles(r.vehicles || [])).catch(() => {}); }, []);

  const vehicleOptions = useMemo(() => vehicles.map((v) => ({ value: v.id, label: v.plate, sub: [v.make, v.model].filter(Boolean).join(' ') })), [vehicles]);

  async function addTire(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const body = { ...form };
      if (body.purchase_cost !== '') body.purchase_cost = Number(body.purchase_cost);
      if (body.tread_depth_mm !== '') body.tread_depth_mm = Number(body.tread_depth_mm);
      for (const k of Object.keys(body)) if (body[k] === '') delete body[k];
      await api('/api/tires', { method: 'POST', body });
      setNotice(`Tire ${String(form.serial_no).toUpperCase()} registered.`);
      setAddOpen(false);
      setForm({ serial_no: '', brand: '', pattern: '', size: '', tire_type: '', ply_rating: '', supply_condition: 'NEW', purchase_date: '', purchase_cost: '', supplier: '', tread_depth_mm: '', notes: '' });
      load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function openDetail(t) {
    try {
      const r = await api(`/api/tires/${t.id}`);
      setDetail(r);
    } catch (e) { setError(e.message); }
  }

  async function startFit(t) {
    setFitting(t);
    setFitForm({ vehicle_id: '', position: '', odometer: '', tread_depth_mm: t.tread_depth_mm != null ? String(t.tread_depth_mm) : '' });
    setFitPositions([]);
  }
  async function pickFitVehicle(id) {
    setFitForm((f) => ({ ...f, vehicle_id: id, position: '' }));
    if (!id) return setFitPositions([]);
    try {
      const d = await api(`/api/vehicles/${id}/detail`);
      const r = await api(`/api/tires/positions?axle_config=${d.vehicle.axle_config || '4x2'}`);
      setFitPositions(r.positions);
      const layout = await api(`/api/tires/vehicle/${id}/layout`);
      setFitForm((f) => ({ ...f, current_layout: layout.layout }));
    } catch { setFitPositions([]); }
  }

  async function submitFit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const body = { tire_id: fitting.id, vehicle_id: fitForm.vehicle_id, position: fitForm.position, odometer: Number(fitForm.odometer) };
      if (fitForm.tread_depth_mm !== '') body.tread_depth_mm = Number(fitForm.tread_depth_mm);
      await api('/api/tires/fit', { method: 'POST', body });
      setNotice(`${fitting.serial_no} fitted at ${fitForm.position}.`);
      setFitting(null);
      load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  function startRemove(t) { setRemoving(t); setRemForm({ odometer: '', reason: '', destination: 'USED_STORE', tread_depth_mm: t.tread_depth_mm != null ? String(t.tread_depth_mm) : '' }); }
  async function submitRemove(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const body = { tire_id: removing.id, odometer: Number(remForm.odometer), reason: remForm.reason, destination: remForm.destination };
      if (remForm.tread_depth_mm !== '') body.tread_depth_mm = Number(remForm.tread_depth_mm);
      const r = await api('/api/tires/remove', { method: 'POST', body });
      setNotice(`${removing.serial_no} removed — ${fmtQty(r.accrued_km, 'km')} accrued this fit.`);
      setRemoving(null);
      load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  function startRotate(t) { setRotating(t); setRotForm({ to_position: '', odometer: '' }); setRotPositions([]); }
  async function submitRotate(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await api('/api/tires/rotate', { method: 'POST', body: { tire_id: rotating.id, to_position: rotForm.to_position, odometer: Number(rotForm.odometer) } });
      setNotice(`${rotating.serial_no} rotated to ${rotForm.to_position}.`);
      setRotating(null);
      load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function openRotate(t) {
    startRotate(t);
    try {
      const layout = await api(`/api/tires/vehicle/${t.current_vehicle_id}/layout`);
      const free = layout.layout.filter((p) => !p.tire).map((p) => ({ value: p.code, label: `${p.code} — ${POSITION_LABELS[p.code] || p.code}` }));
      setRotPositions(free);
    } catch { setRotPositions([]); }
  }

  const cols = [
    { key: 'serial_no', label: 'Serial No' },
    { key: 'brand', label: 'Brand', render: (t) => [t.brand, t.pattern].filter(Boolean).join(' ') || '—' },
    { key: 'size', label: 'Size', render: (t) => t.size || '—' },
    { key: 'status', label: 'Status', render: (t) => <StatusPill status={t.status} /> },
    { key: 'vehicle', label: 'On Vehicle', render: (t) => t.current_vehicle_plate || <span className="muted">—</span> },
    { key: 'position', label: 'Position', render: (t) => (t.current_position ? `${t.current_position} (${POSITION_LABELS[t.current_position] || t.current_position})` : '—') },
    { key: 'mileage', label: 'Mileage', right: true, render: (t) => fmtQty(t.mileage_accumulated, 'km') },
    { key: 'retreads', label: 'Retreads', right: true, render: (t) => String(t.retread_count ?? 0) },
    { key: 'tread', label: 'Tread (mm)', right: true, render: (t) => (t.tread_depth_mm != null ? Number(t.tread_depth_mm).toFixed(1) : '—') },
    { key: 'actions', label: '', render: (t) => !canManage ? null : (
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {t.status !== 'ON_VEHICLE' && t.status !== 'DISPOSED' && <button className="btn small" onClick={() => startFit(t)}>Fit</button>}
        {t.status === 'ON_VEHICLE' && <button className="btn small" onClick={() => openRotate(t)}>Rotate</button>}
        {t.status === 'ON_VEHICLE' && <button className="btn small" onClick={() => startRemove(t)}>Remove</button>}
        <button className="btn small" onClick={() => openDetail(t)}>History</button>
      </div>
    ) },
  ];

  return (
    <>
      {error && <Notice kind="error">{error}</Notice>}
      {notice && <Notice kind="success" onDone={() => setNotice('')}>{notice}</Notice>}
      <div style={{ display: 'flex', gap: 10, margin: '12px 0', flexWrap: 'wrap', alignItems: 'center' }}>
        <input className="input" placeholder="Search serial or brand…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 240 }} />
        <div style={{ width: 190 }}>
          <SearchableSelect value={fStatus} onChange={setFStatus} placeholder="All statuses" options={['IN_STORE', 'USED_STORE', 'ON_VEHICLE', 'AWAITING_RETREAD', 'AT_RETREAD_SUPPLIER', 'DISPOSED'].map((s) => ({ value: s, label: s }))} />
        </div>
        {canManage && <button className="btn primary" onClick={() => setAddOpen(true)}>+ Register Tire</button>}
      </div>
      <Card>
        {rows == null ? <Skeleton lines={7} /> : <DataTable columns={cols} rows={rows} empty="No tires registered yet" />}
      </Card>

      <Drawer open={addOpen} onClose={() => setAddOpen(false)} title="Register tire" subtitle="The serial number is the asset identity — it must be unique" width={520}>
        <form onSubmit={addTire}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Serial no *"><input className="input" required value={form.serial_no} onChange={(e) => setForm((f) => ({ ...f, serial_no: e.target.value }))} placeholder="TR-000458" /></Field>
            <Field label="Brand"><input className="input" value={form.brand} onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))} /></Field>
            <Field label="Pattern"><input className="input" value={form.pattern} onChange={(e) => setForm((f) => ({ ...f, pattern: e.target.value }))} /></Field>
            <Field label="Size"><input className="input" value={form.size} onChange={(e) => setForm((f) => ({ ...f, size: e.target.value }))} placeholder="11R22.5" /></Field>
            <Field label="Type"><input className="input" value={form.tire_type} onChange={(e) => setForm((f) => ({ ...f, tire_type: e.target.value }))} placeholder="TUBELESS" /></Field>
            <Field label="Ply rating"><input className="input" value={form.ply_rating} onChange={(e) => setForm((f) => ({ ...f, ply_rating: e.target.value }))} /></Field>
            <Field label="Supply condition">
              <SearchableSelect value={form.supply_condition} onChange={(v) => setForm((f) => ({ ...f, supply_condition: v }))} options={[{ value: 'NEW', label: 'New' }, { value: 'RETREAD', label: 'Retread' }]} />
            </Field>
            <Field label="Purchase date"><input className="input" type="date" value={form.purchase_date} onChange={(e) => setForm((f) => ({ ...f, purchase_date: e.target.value }))} /></Field>
            <Field label="Purchase cost"><input className="input" type="number" min="0" step="0.01" value={form.purchase_cost} onChange={(e) => setForm((f) => ({ ...f, purchase_cost: e.target.value }))} /></Field>
            <Field label="Supplier"><input className="input" value={form.supplier} onChange={(e) => setForm((f) => ({ ...f, supplier: e.target.value }))} /></Field>
            <Field label="Tread depth (mm)"><input className="input" type="number" min="0" step="0.1" value={form.tread_depth_mm} onChange={(e) => setForm((f) => ({ ...f, tread_depth_mm: e.target.value }))} /></Field>
            <Field label="Notes"><input className="input" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} /></Field>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={() => setAddOpen(false)}>Cancel</button>
            <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Register tire'}</button>
          </div>
        </form>
      </Drawer>

      {/* Fit (§13): axle-config positions only, no double-booking */}
      <Drawer open={!!fitting} onClose={() => setFitting(null)} title={`Fit ${fitting?.serial_no || ''}`} subtitle="Only free positions valid for the vehicle's axle configuration are listed" width={460}>
        <form onSubmit={submitFit}>
          <Field label="Vehicle *">
            <SearchableSelect required value={fitForm.vehicle_id} onChange={pickFitVehicle} options={vehicleOptions} placeholder="Select vehicle…" />
          </Field>
          <Field label="Position *">
            <SearchableSelect required value={fitForm.position} onChange={(v) => setFitForm((f) => ({ ...f, position: v }))} options={fitPositions.filter((p) => !(fitForm.current_layout || []).some((l) => l.code === p.code && l.tire)).map((p) => ({ value: p.code, label: `${p.code} — ${POSITION_LABELS[p.code] || p.code}` }))} placeholder={fitForm.vehicle_id ? 'Select free position…' : 'Pick a vehicle first'} disabled={!fitForm.vehicle_id} />
          </Field>
          <Field label="Odometer at fit (km) *">
            <input className="input" required type="number" min="0" step="0.1" value={fitForm.odometer} onChange={(e) => setFitForm((f) => ({ ...f, odometer: e.target.value }))} />
          </Field>
          <Field label="Tread depth (mm)">
            <input className="input" type="number" min="0" step="0.1" value={fitForm.tread_depth_mm} onChange={(e) => setFitForm((f) => ({ ...f, tread_depth_mm: e.target.value }))} />
          </Field>
          <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={() => setFitting(null)}>Back</button>
            <button type="submit" className="btn primary" disabled={busy || !fitForm.vehicle_id || !fitForm.position}>Fit tire</button>
          </div>
        </form>
      </Drawer>

      {/* Remove (§14): accrued mileage computed; destination sets new status */}
      <Drawer open={!!removing} onClose={() => setRemoving(null)} title={`Remove ${removing?.serial_no || ''}`} subtitle="Mileage since fit is accrued to the tire's lifetime total" width={460}>
        <form onSubmit={submitRemove}>
          <Field label="Odometer at removal (km) *"><input className="input" required type="number" min="0" step="0.1" value={remForm.odometer} onChange={(e) => setRemForm((f) => ({ ...f, odometer: e.target.value }))} /></Field>
          <Field label="Reason *"><input className="input" required value={remForm.reason} onChange={(e) => setRemForm((f) => ({ ...f, reason: e.target.value }))} placeholder="Wear, puncture, rotation policy…" /></Field>
          <Field label="Destination">
            <SearchableSelect value={remForm.destination} onChange={(v) => setRemForm((f) => ({ ...f, destination: v }))} options={['USED_STORE', 'IN_STORE', 'AWAITING_RETREAD', 'AT_RETREAD_SUPPLIER', 'DISPOSED'].map((s) => ({ value: s, label: s }))} />
          </Field>
          <Field label="Tread depth (mm)"><input className="input" type="number" min="0" step="0.1" value={remForm.tread_depth_mm} onChange={(e) => setRemForm((f) => ({ ...f, tread_depth_mm: e.target.value }))} /></Field>
          <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={() => setRemoving(null)}>Back</button>
            <button type="submit" className="btn primary" disabled={busy}>Remove tire</button>
          </div>
        </form>
      </Drawer>

      {/* Rotate (§15): same vehicle, free positions only */}
      <Drawer open={!!rotating} onClose={() => setRotating(null)} title={`Rotate ${rotating?.serial_no || ''}`} subtitle="Same vehicle only — target position must be free" width={420}>
        <form onSubmit={submitRotate}>
          <Field label="New position *">
            <SearchableSelect required value={rotForm.to_position} onChange={(v) => setRotForm((f) => ({ ...f, to_position: v }))} options={rotPositions} placeholder={rotPositions.length ? 'Select position…' : 'No free positions'} disabled={!rotPositions.length} />
          </Field>
          <Field label="Odometer (km) *"><input className="input" required type="number" min="0" step="0.1" value={rotForm.odometer} onChange={(e) => setRotForm((f) => ({ ...f, odometer: e.target.value }))} /></Field>
          <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={() => setRotating(null)}>Back</button>
            <button type="submit" className="btn primary" disabled={busy || !rotForm.to_position}>Rotate</button>
          </div>
        </form>
      </Drawer>

      {/* Lifecycle history — append-only (§16) */}
      <Drawer open={!!detail} onClose={() => setDetail(null)} title={detail?.tire?.serial_no || ''} subtitle="Lifecycle ledger — newest first, never rewritten" width={520}>
        {detail && <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <StatusPill status={detail.tire.status} />
            <span className="muted">{detail.tire.brand} {detail.tire.size || ''}</span>
            <span className="muted">· Lifetime {fmtQty(detail.tire.mileage_accumulated, 'km')} · {detail.tire.retread_count} retread(s)</span>
          </div>
          {detail.history.length === 0 ? <EmptyState title="No movements yet" message="Fit this tire to a vehicle to start its lifecycle." /> : (
            <table className="table" style={{ width: '100%' }}>
              <thead><tr><th>Action</th><th>Vehicle / Position</th><th>Odometer</th><th>Date</th><th>Reason</th></tr></thead>
              <tbody>
                {detail.history.map((m) => (
                  <tr key={m.id}>
                    <td><StatusPill status={m.action} /></td>
                    <td>{m.plate || '—'}{m.position ? ` · ${m.position}` : ''}</td>
                    <td>{m.odometer != null ? fmtQty(m.odometer, 'km') : '—'}</td>
                    <td>{fmtDate(m.created_at)}</td>
                    <td className="muted">{m.reason || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>}
      </Drawer>
    </>
  );
}

// ── Vehicle Layout (§17) — live wheel-position map per axle configuration ───
function Layout({ canManage }) {
  const [vehicles, setVehicles] = useState([]);
  const [vehicleId, setVehicleId] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => { api('/api/vehicles').then((r) => setVehicles(r.vehicles || [])).catch(() => {}); }, []);
  useEffect(() => {
    if (!vehicleId) { setData(null); return; }
    api(`/api/tires/vehicle/${vehicleId}/layout`).then(setData).catch((e) => setError(e.message));
  }, [vehicleId]);

  const vehicleOptions = useMemo(() => vehicles.map((v) => ({ value: v.id, label: v.plate, sub: [v.make, v.model].filter(Boolean).join(' ') })), [vehicles]);
  const byCode = Object.fromEntries((data?.layout || []).map((l) => [l.code, l]));
  const cfg = data?.vehicle?.axle_config || '4x2';
  const front = ['FL', 'FR'];
  const mid = ['MLO', 'MLI', 'MRO', 'MRI'];
  const rear = ['RLO', 'RLI', 'RRO', 'RRI', 'RL', 'RR'].filter((c) => byCode[c]);

  function Slot({ code }) {
    const slot = byCode[code];
    if (!slot) return null;
    return (
      <div style={{
        width: 108, minHeight: 64, borderRadius: 10, border: slot.tire ? '2px solid #2563eb' : '2px dashed #d4d4d8',
        background: slot.tire ? '#eff6ff' : '#fafafa', padding: '8px 6px', textAlign: 'center',
      }}>
        <div className="muted" style={{ fontSize: 11, letterSpacing: 0.4 }}>{code}</div>
        {slot.tire ? (
          <>
            <div style={{ fontWeight: 700, fontSize: 13, marginTop: 2 }}>{slot.tire.serial_no}</div>
            <div className="muted" style={{ fontSize: 11 }}>{slot.tire.brand || ''}</div>
          </>
        ) : <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>empty</div>}
      </div>
    );
  }

  return (
    <>
      {error && <Notice kind="error">{error}</Notice>}
      <Card title="Vehicle wheel layout">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
          <div style={{ width: 280 }}>
            <SearchableSelect value={vehicleId} onChange={setVehicleId} options={vehicleOptions} placeholder="Select a vehicle…" />
          </div>
          {data && <span className="pill">{cfg} · {data.layout.filter((l) => l.tire).length}/{data.layout.length} fitted</span>}
        </div>
        {!vehicleId ? <EmptyState icon="⚁" title="Pick a vehicle" message="The layout shows every wheel position for its axle configuration, with the tire fitted in each." /> : !data ? <Skeleton lines={4} /> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'center', padding: '12px 0' }}>
            <div className="muted" style={{ fontSize: 12, letterSpacing: 1 }}>FRONT</div>
            <div style={{ display: 'flex', gap: 10 }}>
              {front.map((c) => <Slot key={c} code={c} />)}
            </div>
            {mid.some((c) => byCode[c]) && <>
              <div className="muted" style={{ fontSize: 12, letterSpacing: 1 }}>MID</div>
              <div style={{ display: 'flex', gap: 10 }}>
                {['MLO', 'MLI'].map((c) => <Slot key={c} code={c} />)}
                <div style={{ width: 40 }} />
                {['MRO', 'MRI'].map((c) => <Slot key={c} code={c} />)}
              </div>
            </>}
            <div className="muted" style={{ fontSize: 12, letterSpacing: 1 }}>REAR</div>
            <div style={{ display: 'flex', gap: 10 }}>
              {rear.filter((c) => c.startsWith('RL')).map((c) => <Slot key={c} code={c} />)}
              <div style={{ width: 40 }} />
              {rear.filter((c) => c.startsWith('RR')).map((c) => <Slot key={c} code={c} />)}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>◀ left side · right side ▶</div>
          </div>
        )}
      </Card>
    </>
  );
}
