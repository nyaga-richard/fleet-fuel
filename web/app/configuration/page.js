'use client';
import { useCallback, useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Card, Table, Notice, Tabs, useForm, Field, SearchableSelect } from '@/components/ui';
import { api } from '@/lib/api';
import { fmtQty } from '@/lib/format';
import WheelConfigManager from '@/components/wheel-configs';

export default function ConfigurationPage() {
  return <Shell><Config /></Shell>;
}

function Config() {
  const [tab, setTab] = useState('fuel');
  return (
    <>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'fuel', label: 'Fuel types' },
          { value: 'tanks', label: 'Tanks' },
          { value: 'pumps', label: 'Pumps' },
          { value: 'wheel', label: 'Wheel Configurations' },
        ]}
      />
      {tab === 'fuel' && <FuelTypes />}
      {tab === 'tanks' && <Tanks />}
      {tab === 'pumps' && <Pumps />}
      {tab === 'wheel' && <WheelConfigManager />}
    </>
  );
}

// ── Fuel types ───────────────────────────────────────────────────────────────
function FuelTypes() {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(null); // 'new' | fuel_type.id
  const { form, bind, setForm } = useForm({ name: '', code: '', unit: 'L' });

  const load = useCallback(() => api('/api/fuel-types').then((r) => setRows(r.fuel_types)).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  function openNew() { setEditing('new'); setForm({ name: '', code: '', unit: 'L' }); }
  function openEdit(r) { setEditing(r.id); setForm({ name: r.name, code: r.code, unit: r.unit }); }

  async function submit(e) {
    e.preventDefault();
    setError('');
    try {
      if (editing === 'new') {
        await api('/api/fuel-types', { method: 'POST', body: form });
        setNotice(`Fuel type ${form.name} added.`);
      } else {
        await api(`/api/fuel-types/${editing}`, { method: 'PATCH', body: { name: form.name, unit: form.unit } });
        setNotice('Fuel type updated.');
      }
      setEditing(null);
      load();
    } catch (e) { setError(e.message); }
  }

  async function remove(r) {
    if (!window.confirm(`Delete fuel type "${r.name}"?\n\nIt will be deactivated and hidden from new records. All ledger history and past transactions are fully preserved; you can restore it any time.`)) return;
    try { await api(`/api/fuel-types/${r.id}`, { method: 'PATCH', body: { active: false } }); setNotice('Fuel type deleted (deactivated).'); load(); }
    catch (e) { setError(e.message); }
  }

  async function restore(r) {
    try { await api(`/api/fuel-types/${r.id}`, { method: 'PATCH', body: { active: true } }); setNotice('Fuel type restored.'); load(); }
    catch (e) { setError(e.message); }
  }

  return (
    <>
      {error && <Notice kind="error" onDone={() => setError('')}>{error}</Notice>}
      {notice && <Notice kind="success" onDone={() => setNotice('')}>{notice}</Notice>}
      <Card
        title="Fuel types"
        actions={<button className="btn" onClick={editing ? () => setEditing(null) : openNew}>{editing ? 'Cancel' : '+ Add fuel type'}</button>}
      >
        {editing && (
          <form onSubmit={submit} className="grid c3" style={{ marginBottom: 16 }}>
            <Field label="Name *"><input {...bind('name')} required placeholder="Diesel" /></Field>
            <Field label="Code *"><input {...bind('code')} required disabled={editing !== 'new'} placeholder="DIESEL" style={{ textTransform: 'uppercase' }} /></Field>
            <Field label="Unit"><input {...bind('unit')} /></Field>
            <div style={{ gridColumn: '1 / -1' }}>
              <button className="btn">{editing === 'new' ? 'Add fuel type' : 'Save changes'}</button>
            </div>
          </form>
        )}
        <Table
          columns={[
            { key: 'name', label: 'Name' },
            { key: 'code', label: 'Code' },
            { key: 'unit', label: 'Unit' },
            {
              key: 'active', label: 'Status', render: (r) => r.active
                ? <span className="pill" style={{ color: '#22c55e', borderColor: '#22c55e' }}>Active</span>
                : <span className="pill" style={{ color: '#9ca3af', borderColor: '#9ca3af' }}>Deleted</span>,
            },
            {
              key: 'actions', label: '', render: (r) => (
                <span className="row-actions">
                  <button className="btn secondary sm" onClick={() => openEdit(r)}>Edit</button>
                  {r.active
                    ? <button className="btn danger sm" onClick={() => remove(r)}>Delete</button>
                    : <button className="btn secondary sm" onClick={() => restore(r)}>Restore</button>}
                </span>
              ),
            },
          ]}
          rows={rows}
        />
        <p className="muted" style={{ fontSize: 12 }}>
          Deleting deactivates the fuel type — ledger history and past transactions are never touched.
        </p>
      </Card>
    </>
  );
}

// ── Tanks ────────────────────────────────────────────────────────────────────
function Tanks() {
  const [rows, setRows] = useState([]);
  const [fuels, setFuels] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(null);
  const { form, bind, setForm } = useForm({ name: '', fuel_type_id: '', capacity: '', location: '', opening_quantity: '' });

  const load = useCallback(async () => {
    try {
      const [t, f] = await Promise.all([api('/api/tanks'), api('/api/fuel-types')]);
      setRows(t.tanks); setFuels(f.fuel_types);
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  function openNew() { setEditing('new'); setForm({ name: '', fuel_type_id: '', capacity: '', location: '', opening_quantity: '' }); }
  function openEdit(r) {
    setEditing(r.id);
    setForm({ name: r.name, fuel_type_id: r.fuel_type_id, capacity: String(r.capacity ?? ''), location: r.location || '', opening_quantity: '' });
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    try {
      if (editing === 'new') {
        await api('/api/tanks', {
          method: 'POST',
          body: {
            ...form,
            capacity: Number(form.capacity),
            opening_quantity: form.opening_quantity === '' ? undefined : Number(form.opening_quantity),
          },
        });
        setNotice(`Tank ${form.name} created.${form.opening_quantity ? ' Opening stock posted to the ledger.' : ''}`);
      } else {
        await api(`/api/tanks/${editing}`, {
          method: 'PATCH',
          body: { name: form.name, capacity: Number(form.capacity), location: form.location || null },
        });
        setNotice('Tank updated. (Capacity changes do not alter recorded stock.)');
      }
      setEditing(null);
      load();
    } catch (e) { setError(e.message); }
  }

  async function remove(r) {
    if (!window.confirm(`Delete tank "${r.name}"?\n\nIt will be deactivated and hidden from new operations. The complete fuel ledger for this tank is preserved; you can restore it any time.`)) return;
    try { await api(`/api/tanks/${r.id}`, { method: 'PATCH', body: { active: false } }); setNotice('Tank deleted (deactivated).'); load(); }
    catch (e) { setError(e.message); }
  }

  async function restore(r) {
    try { await api(`/api/tanks/${r.id}`, { method: 'PATCH', body: { active: true } }); setNotice('Tank restored.'); load(); }
    catch (e) { setError(e.message); }
  }

  return (
    <>
      {error && <Notice kind="error" onDone={() => setError('')}>{error}</Notice>}
      {notice && <Notice kind="success" onDone={() => setNotice('')}>{notice}</Notice>}
      <Card
        title="Tanks"
        actions={<button className="btn" onClick={editing ? () => setEditing(null) : openNew}>{editing ? 'Cancel' : '+ Add tank'}</button>}
      >
        {editing && (
          <form onSubmit={submit} className="grid c3" style={{ marginBottom: 16 }}>
            <Field label="Name *"><input {...bind('name')} required placeholder="Main Diesel Tank" /></Field>
            <Field label="Fuel type *">
              <SearchableSelect {...bind('fuel_type_id')} required disabled={editing !== 'new'} placeholder="Select fuel…"
                options={fuels.map((f) => ({ value: f.id, label: f.name, sub: f.code || '' }))} />
            </Field>
            <Field label="Capacity (L) *"><input type="number" step="0.01" min="1" {...bind('capacity')} required /></Field>
            <Field label="Location"><input {...bind('location')} /></Field>
            {editing === 'new' && (
              <Field label="Opening stock (L)"><input type="number" step="0.01" min="0" {...bind('opening_quantity')} placeholder="0" /></Field>
            )}
            <div style={{ gridColumn: '1 / -1' }}>
              <button className="btn">{editing === 'new' ? 'Create tank' : 'Save changes'}</button>
            </div>
          </form>
        )}
        <Table
          columns={[
            { key: 'name', label: 'Tank' },
            { key: 'fuel_type_name', label: 'Fuel' },
            { key: 'capacity', label: 'Capacity', num: true, render: (r) => fmtQty(r.capacity) },
            { key: 'location', label: 'Location', render: (r) => r.location || '—' },
            {
              key: 'active', label: 'Status', render: (r) => r.active
                ? <span className="pill" style={{ color: '#22c55e', borderColor: '#22c55e' }}>Active</span>
                : <span className="pill" style={{ color: '#9ca3af', borderColor: '#9ca3af' }}>Deleted</span>,
            },
            {
              key: 'actions', label: '', render: (r) => (
                <span className="row-actions">
                  <button className="btn secondary sm" onClick={() => openEdit(r)}>Edit</button>
                  {r.active
                    ? <button className="btn danger sm" onClick={() => remove(r)}>Delete</button>
                    : <button className="btn secondary sm" onClick={() => restore(r)}>Restore</button>}
                </span>
              ),
            },
          ]}
          rows={rows}
        />
        <p className="muted" style={{ fontSize: 12 }}>
          Fuel type is fixed after creation (a tank&apos;s stock history belongs to one fuel). Deleting deactivates the tank; ledger history is preserved.
        </p>
      </Card>
    </>
  );
}

// ── Pumps ────────────────────────────────────────────────────────────────────
function Pumps() {
  const [rows, setRows] = useState([]);
  const [tanks, setTanks] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(null);
  const { form, bind, setForm } = useForm({ name: '', tank_id: '', serial: '' });

  const load = useCallback(async () => {
    try {
      const [p, t] = await Promise.all([api('/api/pumps'), api('/api/tanks')]);
      setRows(p.pumps); setTanks(t.tanks);
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  function openNew() { setEditing('new'); setForm({ name: '', tank_id: '', serial: '' }); }
  function openEdit(r) { setEditing(r.id); setForm({ name: r.name, tank_id: r.tank_id, serial: r.serial || '' }); }

  async function submit(e) {
    e.preventDefault();
    setError('');
    try {
      if (editing === 'new') {
        await api('/api/pumps', { method: 'POST', body: form });
        setNotice(`Pump ${form.name} added.`);
      } else {
        await api(`/api/pumps/${editing}`, { method: 'PATCH', body: form });
        setNotice('Pump updated.');
      }
      setEditing(null);
      load();
    } catch (e) { setError(e.message); }
  }

  async function remove(r) {
    if (!window.confirm(`Delete pump "${r.name}"?\n\nIt will be deactivated and hidden from new issues. Past transactions and readings are preserved; you can restore it any time.`)) return;
    try { await api(`/api/pumps/${r.id}`, { method: 'PATCH', body: { active: false } }); setNotice('Pump deleted (deactivated).'); load(); }
    catch (e) { setError(e.message); }
  }

  async function restore(r) {
    try { await api(`/api/pumps/${r.id}`, { method: 'PATCH', body: { active: true } }); setNotice('Pump restored.'); load(); }
    catch (e) { setError(e.message); }
  }

  return (
    <>
      {error && <Notice kind="error" onDone={() => setError('')}>{error}</Notice>}
      {notice && <Notice kind="success" onDone={() => setNotice('')}>{notice}</Notice>}
      <Card
        title="Pumps"
        actions={<button className="btn" onClick={editing ? () => setEditing(null) : openNew}>{editing ? 'Cancel' : '+ Add pump'}</button>}
      >
        {editing && (
          <form onSubmit={submit} className="grid c3" style={{ marginBottom: 16 }}>
            <Field label="Name *"><input {...bind('name')} required placeholder="Pump 1" /></Field>
            <Field label="Tank *">
              <SearchableSelect {...bind('tank_id')} required placeholder="Select tank…"
                options={tanks.filter((t) => t.active).map((t) => ({ value: t.id, label: t.name, sub: t.fuel_type_name || t.location || '' }))} />
            </Field>
            <Field label="Serial"><input {...bind('serial')} /></Field>
            <div style={{ gridColumn: '1 / -1' }}>
              <button className="btn">{editing === 'new' ? 'Add pump' : 'Save changes'}</button>
            </div>
          </form>
        )}
        <Table
          columns={[
            { key: 'name', label: 'Pump' },
            { key: 'tank_name', label: 'Tank' },
            { key: 'fuel_type_name', label: 'Fuel' },
            { key: 'serial', label: 'Serial', render: (r) => r.serial || '—' },
            {
              key: 'active', label: 'Status', render: (r) => r.active
                ? <span className="pill" style={{ color: '#22c55e', borderColor: '#22c55e' }}>Active</span>
                : <span className="pill" style={{ color: '#9ca3af', borderColor: '#9ca3af' }}>Deleted</span>,
            },
            {
              key: 'actions', label: '', render: (r) => (
                <span className="row-actions">
                  <button className="btn secondary sm" onClick={() => openEdit(r)}>Edit</button>
                  {r.active
                    ? <button className="btn danger sm" onClick={() => remove(r)}>Delete</button>
                    : <button className="btn secondary sm" onClick={() => restore(r)}>Restore</button>}
                </span>
              ),
            },
          ]}
          rows={rows}
        />
        <p className="muted" style={{ fontSize: 12 }}>
          Deleting deactivates the pump; transaction history and readings are preserved.
        </p>
      </Card>
    </>
  );
}
