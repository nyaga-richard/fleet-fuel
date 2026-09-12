'use client';
import { useCallback, useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Card, Table, Notice, useForm, Field } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/format';

export default function VehiclesPage() {
  return <Shell><Vehicles /></Shell>;
}

function Vehicles() {
  const { user } = useAuth();
  const canManage = user.role === 'admin' || user.role === 'manager';
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(null); // vehicle being edited or 'new'
  const { form, bind, setForm } = useForm({ plate: '', make: '', model: '', vehicle_type: '', driver_name: '', tank_capacity: '', notes: '' });

  const load = useCallback(async () => {
    try {
      const r = await api(`/api/vehicles?q=${encodeURIComponent(q)}`);
      setRows(r.vehicles);
    } catch (e) { setError(e.message); }
  }, [q]);

  useEffect(() => { load(); }, [load]);

  function openNew() { setEditing('new'); setForm({ plate: '', make: '', model: '', vehicle_type: '', driver_name: '', tank_capacity: '', notes: '' }); }
  function openEdit(v) { setEditing(v.id); setForm({ ...v, tank_capacity: v.tank_capacity ?? '' }); }

  async function save(e) {
    e.preventDefault();
    setError('');
    try {
      const body = { ...form, tank_capacity: form.tank_capacity === '' ? undefined : Number(form.tank_capacity) };
      if (editing === 'new') {
        await api('/api/vehicles', { method: 'POST', body });
        setNotice(`Vehicle ${form.plate} added.`);
      } else {
        await api(`/api/vehicles/${editing}`, { method: 'PATCH', body });
        setNotice('Vehicle updated.');
      }
      setEditing(null);
      load();
    } catch (e) { setError(e.message); }
  }

  async function toggleActive(v) {
    setError('');
    try {
      await api(`/api/vehicles/${v.id}`, { method: 'PATCH', body: { active: !v.active } });
      load();
    } catch (e) { setError(e.message); }
  }

  return (
    <>
      {error && <Notice kind="error" onDone={() => setError('')}>{error}</Notice>}
      {notice && <Notice kind="success" onDone={() => setNotice('')}>{notice}</Notice>}

      <Card
        title="Vehicles"
        actions={(
          <div style={{ display: 'flex', gap: 10 }}>
            <input placeholder="Search plate / driver…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
            {canManage && <button className="btn" onClick={openNew}>+ Add vehicle</button>}
          </div>
        )}
      >
        {editing && (
          <form onSubmit={save} className="grid c3" style={{ marginBottom: 16 }}>
            <Field label="Plate *"><input {...bind('plate')} required placeholder="KDA 001X" style={{ textTransform: 'uppercase' }} /></Field>
            <Field label="Make"><input {...bind('make')} /></Field>
            <Field label="Model"><input {...bind('model')} /></Field>
            <Field label="Type"><input {...bind('vehicle_type')} placeholder="truck / car / forklift" /></Field>
            <Field label="Driver"><input {...bind('driver_name')} /></Field>
            <Field label="Tank capacity (L)"><input type="number" step="0.1" min="0" {...bind('tank_capacity')} /></Field>
            <Field label="Notes"><input {...bind('notes')} /></Field>
            <div style={{ gridColumn: '1 / -1' }}>
              <button className="btn">{editing === 'new' ? 'Add vehicle' : 'Save changes'}</button>
              <button type="button" className="btn secondary" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </form>
        )}

        <Table
          columns={[
            { key: 'plate', label: 'Plate' },
            { key: 'make', label: 'Make / model', render: (r) => [r.make, r.model].filter(Boolean).join(' ') || '—' },
            { key: 'vehicle_type', label: 'Type', render: (r) => r.vehicle_type || '—' },
            { key: 'driver_name', label: 'Driver', render: (r) => r.driver_name || '—' },
            { key: 'tank_capacity', label: 'Tank (L)', num: true, render: (r) => (r.tank_capacity ? Number(r.tank_capacity).toLocaleString() : '—') },
            { key: 'created_at', label: 'Added', render: (r) => fmtDate(r.created_at) },
            {
              key: 'active', label: 'Status', render: (r) => r.active
                ? <span className="pill" style={{ color: '#22c55e', borderColor: '#22c55e' }}>Active</span>
                : <span className="pill" style={{ color: '#9ca3af', borderColor: '#9ca3af' }}>Inactive</span>,
            },
            {
              key: 'actions', label: '', render: (r) => canManage ? (
                <span className="row-actions">
                  <button className="btn secondary sm" onClick={() => openEdit(r)}>Edit</button>
                  <button className="btn secondary sm" onClick={() => toggleActive(r)}>{r.active ? 'Deactivate' : 'Activate'}</button>
                </span>
              ) : null,
            },
          ]}
          rows={rows}
          empty="No vehicles yet"
        />
      </Card>
    </>
  );
}
