'use client';
import { useCallback, useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Card, Table, StatusPill, Tabs, Notice, Stat, useForm, Field } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtQty, fmtDateTime } from '@/lib/format';

export default function InventoryPage() {
  return <Shell><Inventory /></Shell>;
}

function Inventory() {
  const { user } = useAuth();
  const canManage = user.role === 'admin' || user.role === 'manager';
  const [tab, setTab] = useState('stock');

  return (
    <>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'stock', label: 'Stock' },
          { value: 'receipts', label: 'Bulk receipts' },
          { value: 'adjustments', label: 'Adjustments' },
          { value: 'readings', label: 'Readings' },
        ]}
      />
      {tab === 'stock' && <Stock />}
      {tab === 'receipts' && <Receipts canManage={canManage} />}
      {tab === 'adjustments' && <Adjustments canManage={canManage} />}
      {tab === 'readings' && <Readings />}
    </>
  );
}

function useRefs() {
  const [refs, setRefs] = useState({ fuel_types: [], tanks: [], pumps: [] });
  const load = useCallback(async () => {
    const [f, t, p] = await Promise.all([api('/api/fuel-types'), api('/api/tanks'), api('/api/pumps')]);
    setRefs({ fuel_types: f.fuel_types, tanks: t.tanks, pumps: p.pumps });
  }, []);
  useEffect(() => { load().catch(() => {}); }, [load]);
  return { ...refs, reload: load };
}

function Stock() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api('/api/inventory/stock').then(setData).catch((e) => setError(e.message)); }, []);
  if (error) return <Notice kind="error">{error}</Notice>;
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <>
      <div className="grid c3" style={{ marginBottom: 18 }}>
        {(data.by_fuel_type || []).map((s) => (
          <Stat key={s.id} label={s.name} value={fmtQty(s.balance, s.unit)} sub={`code ${s.code}`} />
        ))}
      </div>
      <Card title="Stock by tank">
        <Table
          columns={[
            { key: 'tank', label: 'Tank' },
            { key: 'fuel_type', label: 'Fuel' },
            { key: 'capacity', label: 'Capacity', num: true, render: (r) => fmtQty(r.capacity) },
            { key: 'balance', label: 'Current', num: true, render: (r) => fmtQty(r.balance) },
            { key: 'pct_full', label: 'Full', num: true, render: (r) => `${r.pct_full ?? 0}%` },
          ]}
          rows={data.by_tank || []}
        />
      </Card>
    </>
  );
}

function Receipts({ canManage }) {
  const refs = useRefs();
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const { form, bind, setForm } = useForm({ fuel_type_id: '', tank_id: '', quantity: '', supplier: '', invoice_no: '', unit_price: '', delivery_note: '' });

  const load = useCallback(() => { api('/api/inventory/receipts').then((r) => setRows(r.receipts)).catch((e) => setError(e.message)); }, []);
  useEffect(() => { load(); }, [load]);

  async function submit(e) {
    e.preventDefault();
    setError('');
    try {
      const res = await api('/api/inventory/receipts', { method: 'POST', body: { ...form, quantity: Number(form.quantity), unit_price: form.unit_price ? Number(form.unit_price) : undefined } });
      setNotice(`Receipt ${res.receipt.receipt_no} recorded — ${fmtQty(res.receipt.quantity)} added to the ledger.`);
      setForm({ fuel_type_id: '', tank_id: '', quantity: '', supplier: '', invoice_no: '', unit_price: '', delivery_note: '' });
      load();
    } catch (e) { setError(e.message); }
  }

  const tanksForFuel = refs.tanks.filter((t) => !form.fuel_type_id || t.fuel_type_id === form.fuel_type_id);

  return (
    <>
      {error && <Notice kind="error" onDone={() => setError('')}>{error}</Notice>}
      {notice && <Notice kind="success" onDone={() => setNotice('')}>{notice}</Notice>}
      {canManage && (
        <Card title="Record a bulk delivery (purchase)">
          <form onSubmit={submit} className="grid c3">
            <Field label="Fuel type *">
              <select {...bind('fuel_type_id')} required>
                <option value="">Select fuel…</option>
                {refs.fuel_types.filter((f) => f.active).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </Field>
            <Field label="Into tank *">
              <select {...bind('tank_id')} required>
                <option value="">Select tank…</option>
                {tanksForFuel.filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            <Field label="Quantity (L) *"><input type="number" step="0.01" min="0.01" {...bind('quantity')} required /></Field>
            <Field label="Supplier *"><input {...bind('supplier')} required placeholder="e.g. Vivo Energy" /></Field>
            <Field label="Invoice no."><input {...bind('invoice_no')} /></Field>
            <Field label="Unit price"><input type="number" step="0.01" min="0" {...bind('unit_price')} /></Field>
            <div style={{ gridColumn: '1 / -1' }}><button className="btn">Record receipt</button></div>
          </form>
        </Card>
      )}
      <Card title="Delivery history">
        <Table
          columns={[
            { key: 'receipt_no', label: 'Receipt' },
            { key: 'created_at', label: 'Date', render: (r) => fmtDateTime(r.created_at) },
            { key: 'supplier', label: 'Supplier' },
            { key: 'invoice_no', label: 'Invoice', render: (r) => r.invoice_no || '—' },
            { key: 'fuel_type_name', label: 'Fuel' },
            { key: 'tank_name', label: 'Tank' },
            { key: 'quantity', label: 'Qty', num: true, render: (r) => fmtQty(r.quantity) },
            { key: 'received_by_name', label: 'Received by', render: (r) => r.received_by_name || '—' },
          ]}
          rows={rows}
          empty="No deliveries recorded"
        />
      </Card>
    </>
  );
}

function Adjustments({ canManage }) {
  const refs = useRefs();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const { form, bind, setForm } = useForm({ fuel_type_id: '', tank_id: '', quantity: '', reason: '' });

  async function submit(e) {
    e.preventDefault();
    setError('');
    try {
      await api('/api/inventory/adjustments', { method: 'POST', body: { ...form, quantity: Number(form.quantity) } });
      setNotice('Adjustment posted to the fuel ledger (signed quantity, reason audited).');
      setForm({ fuel_type_id: '', tank_id: '', quantity: '', reason: '' });
    } catch (e) { setError(e.message); }
  }

  const tanksForFuel = refs.tanks.filter((t) => !form.fuel_type_id || t.fuel_type_id === form.fuel_type_id);

  return (
    <>
      {error && <Notice kind="error" onDone={() => setError('')}>{error}</Notice>}
      {notice && <Notice kind="success" onDone={() => setNotice('')}>{notice}</Notice>}
      {canManage ? (
        <Card title="Stock adjustment">
          <div className="msg info">Use negative quantities for losses/shrinkage, positive for gains. Every adjustment is an immutable ledger entry with a mandatory reason.</div>
          <form onSubmit={submit} className="grid c3">
            <Field label="Fuel type *">
              <select {...bind('fuel_type_id')} required>
                <option value="">Select fuel…</option>
                {refs.fuel_types.filter((f) => f.active).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </Field>
            <Field label="Tank *">
              <select {...bind('tank_id')} required>
                <option value="">Select tank…</option>
                {tanksForFuel.filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            <Field label="Signed quantity (L) *"><input type="number" step="0.01" {...bind('quantity')} required placeholder="-120 or 80" /></Field>
            <Field label="Reason *"><input {...bind('reason')} required placeholder="e.g. temperature shrinkage" /></Field>
            <div><button className="btn">Post adjustment</button></div>
          </form>
        </Card>
      ) : <Notice kind="info">Only managers and admins may post adjustments.</Notice>}
    </>
  );
}

function Readings() {
  const refs = useRefs();
  const [rows, setRows] = useState({ pump: [], tank: [] });
  const [error, setError] = useState('');
  const { form, bind, setForm } = useForm({ pump_id: '', tank_id: '', reading: '', dip: '', quantity_estimate: '' });

  const load = useCallback(async () => {
    try {
      const [p, t] = await Promise.all([
        api('/api/inventory/readings?type=pump&limit=50'),
        api('/api/inventory/readings?type=tank&limit=50'),
      ]);
      setRows({ pump: p.readings, tank: t.readings });
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function submit(e) {
    e.preventDefault();
    setError('');
    try {
      await api('/api/inventory/readings', {
        method: 'POST',
        body: {
          type: 'pump',
          pump_id: form.pump_id,
          reading: form.reading ? Number(form.reading) : undefined,
        },
      });
      if (form.tank_id) {
        await api('/api/inventory/readings', {
          method: 'POST',
          body: {
            type: 'tank',
            tank_id: form.tank_id,
            dip: form.dip ? Number(form.dip) : undefined,
            quantity_estimate: form.quantity_estimate ? Number(form.quantity_estimate) : undefined,
          },
        });
      }
      setForm({ pump_id: '', tank_id: '', reading: '', dip: '', quantity_estimate: '' });
      load();
    } catch (err) { setError(err.message); }
  }

  return (
    <>
      {error && <Notice kind="error" onDone={() => setError('')}>{error}</Notice>}
      <Card title="Record meter / dip readings">
        <form onSubmit={submit} className="grid c3">
          <Field label="Pump">
            <select {...bind('pump_id')}>
              <option value="">—</option>
              {refs.pumps.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Pump meter reading"><input type="number" step="0.01" {...bind('reading')} /></Field>
          <Field label="Tank">
            <select {...bind('tank_id')}>
              <option value="">—</option>
              {refs.tanks.filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
          <Field label="Dip (cm)"><input type="number" step="0.1" {...bind('dip')} /></Field>
          <Field label="Estimated quantity (L)"><input type="number" step="0.01" {...bind('quantity_estimate')} /></Field>
          <div><button className="btn">Save readings</button></div>
        </form>
      </Card>
      <div className="grid c2">
        <Card title="Recent pump readings">
          <Table
            columns={[
              { key: 'created_at', label: 'Date', render: (r) => fmtDateTime(r.created_at) },
              { key: 'pump_name', label: 'Pump' },
              { key: 'reading', label: 'Meter', num: true },
              { key: 'recorded_by_name', label: 'By', render: (r) => r.recorded_by_name || '—' },
            ]}
            rows={rows.pump}
          />
        </Card>
        <Card title="Recent tank dips">
          <Table
            columns={[
              { key: 'created_at', label: 'Date', render: (r) => fmtDateTime(r.created_at) },
              { key: 'tank_name', label: 'Tank' },
              { key: 'dip', label: 'Dip', num: true, render: (r) => r.dip ?? '—' },
              { key: 'quantity_estimate', label: 'Est. qty', num: true, render: (r) => (r.quantity_estimate != null ? fmtQty(r.quantity_estimate) : '—') },
            ]}
            rows={rows.tank}
          />
        </Card>
      </div>
    </>
  );
}
