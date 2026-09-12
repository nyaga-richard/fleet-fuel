'use client';
// Vehicles — server-side search (?q=), add / edit / delete (deactivate) /
// restore. Deletion is a soft delete: fuel history is never touched.
import { useCallback, useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Card, PageHeader, SearchInput, Notice, useForm, Field, DataTable, StatusPill, Skeleton, ConfirmDialog, EmptyState } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtQty } from '@/lib/format';

export default function VehiclesPage() {
  return <Shell><Vehicles /></Shell>;
}

const EMPTY_FORM = { plate: '', make: '', model: '', vehicle_type: '', driver_name: '', tank_capacity: '', notes: '' };

function Vehicles() {
  const { user } = useAuth();
  const canManage = user?.role === 'admin' || user?.role === 'manager';
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null); // vehicle id or 'new'
  const [confirmDel, setConfirmDel] = useState(null);
  const { form, bind, setForm } = useForm(EMPTY_FORM);

  const load = useCallback(async () => {
    setError('');
    try {
      const r = await api(`/api/vehicles?q=${encodeURIComponent(q)}`);
      setRows(r.vehicles);
    } catch (e) { setError(e.message); }
  }, [q]);

  useEffect(() => { load(); }, [load]);

  function openNew() { setEditing('new'); setForm(EMPTY_FORM); }
  function openEdit(v) { setEditing(v.id); setForm({ ...v, tank_capacity: v.tank_capacity ?? '' }); }

  async function save(e) {
    e.preventDefault();
    setBusy(true); setError('');
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
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function toggleActive(v) {
    setBusy(true); setError('');
    try {
      await api(`/api/vehicles/${v.id}`, { method: 'PATCH', body: { active: !v.active } });
      setNotice(v.active ? `Vehicle ${v.plate} deleted (deactivated).` : `Vehicle ${v.plate} restored.`);
      setConfirmDel(null);
      load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  return (
    <>
      <PageHeader
        title="Vehicles"
        subtitle="Fleet register — search by plate, make, model or driver"
        actions={canManage && <button className="btn" onClick={openNew}>+ Add vehicle</button>}
      />

      {error && <Notice kind="error" onDone={() => setError('')}>{error}</Notice>}
      {notice && <Notice kind="success" onDone={() => setNotice('')}>{notice}</Notice>}

      {editing && (
        <Card title={editing === 'new' ? 'Add vehicle' : 'Edit vehicle'}>
          <form onSubmit={save} className="grid c3">
            <Field label="Registration plate *"><input {...bind('plate')} required placeholder="e.g. KDA 123A" style={{ textTransform: 'uppercase' }} /></Field>
            <Field label="Make"><input {...bind('make')} placeholder="Toyota" /></Field>
            <Field label="Model"><input {...bind('model')} placeholder="Hilux" /></Field>
            <Field label="Vehicle type"><input {...bind('vehicle_type')} placeholder="pickup / truck / saloon" /></Field>
            <Field label="Default driver"><input {...bind('driver_name')} /></Field>
            <Field label="Tank capacity (L)"><input type="number" inputMode="decimal" step="0.1" min="0" {...bind('tank_capacity')} /></Field>
            <Field label="Notes"><input {...bind('notes')} /></Field>
            <div style={{ gridColumn: '1 / -1' }}>
              <button className="btn" disabled={busy}>{busy ? 'Saving…' : editing === 'new' ? 'Add vehicle' : 'Save changes'}</button>
              <button type="button" className="btn secondary" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </form>
        </Card>
      )}

      <Card title="Fleet" actions={<SearchInput value={q} onChange={setQ} placeholder="Search plate, make, driver…" width={280} />}>
        {!rows ? <Skeleton lines={6} /> : (
          <DataTable
            columns={[
              { key: 'plate', label: 'Plate', render: (r) => <b>{r.plate}</b> },
              { key: 'make', label: 'Make / model', render: (r) => [r.make, r.model].filter(Boolean).join(' ') || '—' },
              { key: 'vehicle_type', label: 'Type', render: (r) => r.vehicle_type || '—' },
              { key: 'driver_name', label: 'Driver', render: (r) => r.driver_name || '—' },
              { key: 'tank_capacity', label: 'Tank', num: true, render: (r) => (r.tank_capacity ? fmtQty(r.tank_capacity) : '—') },
              { key: 'created_at', label: 'Added', render: (r) => fmtDate(r.created_at) },
              { key: 'status', label: 'Status', render: (r) => r.active !== false
                ? <span className="pill" style={{ color: 'var(--green)', borderColor: 'var(--green)', background: 'rgba(34,197,94,.1)' }}><span className="dot" style={{ background: 'var(--green)' }} />Active</span>
                : <span className="pill" style={{ color: 'var(--muted)', borderColor: 'var(--muted)', background: 'rgba(143,160,184,.1)' }}><span className="dot" style={{ background: 'var(--muted)' }} />Deleted</span> },
              { key: 'actions', label: '', render: (r) => (
                <span className="row-actions">
                  {canManage && <button className="btn secondary sm" onClick={(ev) => { ev.stopPropagation(); openEdit(r); }}>Edit</button>}
                  {canManage && (
                    <button
                      className={`btn sm ${r.active !== false ? 'danger' : 'success'}`}
                      onClick={(ev) => { ev.stopPropagation(); r.active !== false ? setConfirmDel(r) : toggleActive(r); }}
                    >
                      {r.active !== false ? 'Delete' : 'Restore'}
                    </button>
                  )}
                </span>
              )},
            ]}
            rows={rows}
            mobileCard={(r) => (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                  <b>{r.plate}</b>
                  {r.active !== false
                    ? <span className="pill" style={{ color: 'var(--green)', borderColor: 'var(--green)' }}><span className="dot" style={{ background: 'var(--green)' }} />Active</span>
                    : <span className="pill" style={{ color: 'var(--muted)', borderColor: 'var(--muted)' }}><span className="dot" style={{ background: 'var(--muted)' }} />Deleted</span>}
                </div>
                <div className="muted" style={{ margin: '4px 0', fontSize: 12.5 }}>
                  {[r.make, r.model, r.vehicle_type].filter(Boolean).join(' · ') || '—'}{r.driver_name ? ` · driver: ${r.driver_name}` : ''}
                </div>
                {canManage && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button className="btn secondary sm" onClick={(ev) => { ev.stopPropagation(); openEdit(r); }}>Edit</button>
                    <button className={`btn sm ${r.active !== false ? 'danger' : 'success'}`} onClick={(ev) => { ev.stopPropagation(); r.active !== false ? setConfirmDel(r) : toggleActive(r); }}>
                      {r.active !== false ? 'Delete' : 'Restore'}
                    </button>
                  </div>
                )}
              </>
            )}
            empty={q ? <EmptyState icon="🔍" title={`No vehicles match “${q}”`} message="Try another plate, make or driver name." /> : <EmptyState title="No vehicles yet" message="Add your first vehicle to start requesting fuel." action={canManage && <button className="btn" onClick={openNew}>+ Add vehicle</button>} />}
          />
        )}
      </Card>

      <ConfirmDialog
        open={!!confirmDel}
        title={`Delete vehicle ${confirmDel?.plate}?`}
        message="It will be deactivated and hidden from new requests. All fuel history is preserved — you can restore it any time."
        confirmLabel="Delete vehicle"
        danger
        busy={busy}
        onConfirm={() => confirmDel && toggleActive(confirmDel)}
        onCancel={() => setConfirmDel(null)}
      />
    </>
  );
}
