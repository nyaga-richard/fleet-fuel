'use client';
import { useCallback, useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Card, Table, StatusPill, Tabs, Notice, useForm, Field } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtQty, fmtDateTime } from '@/lib/format';

export default function RequestsPage() {
  return <Shell><Requests /></Shell>;
}

function Requests() {
  const { user } = useAuth();
  const canDecide = user.role === 'admin' || user.role === 'manager';
  const canCreate = ['admin', 'manager', 'attendant'].includes(user.role);

  const [tab, setTab] = useState('pending');
  const [rows, setRows] = useState([]);
  const [refs, setRefs] = useState({ vehicles: [], fuel_types: [] });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showForm, setShowForm] = useState(false);
  const { form, bind, setForm } = useForm({ vehicle_id: '', fuel_type_id: '', quantity: '', driver_name: '', destination: '', notes: '' });

  const load = useCallback(async () => {
    try {
      const [r, v, f] = await Promise.all([
        api(`/api/requests?status=${tab}&limit=200`),
        api('/api/vehicles?active=true'),
        api('/api/fuel-types'),
      ]);
      setRows(r.requests);
      setRefs({ vehicles: v.vehicles, fuel_types: f.fuel_types });
    } catch (e) { setError(e.message); }
  }, [tab]);

  useEffect(() => { load(); }, [load]);

  async function createRequest(e) {
    e.preventDefault();
    setError('');
    try {
      await api('/api/requests', { method: 'POST', body: { ...form, quantity: Number(form.quantity) } });
      setNotice('Fuel request created and pending authorization.');
      setShowForm(false);
      setForm({ vehicle_id: '', fuel_type_id: '', quantity: '', driver_name: '', destination: '', notes: '' });
      load();
    } catch (e) { setError(e.message); }
  }

  async function decide(id, decision) {
    setError('');
    try {
      await api(`/api/requests/${id}/${decision}`, { method: 'POST', body: {} });
      load();
    } catch (e) { setError(e.message); }
  }

  async function cancel(id) {
    setError('');
    try { await api(`/api/requests/${id}/cancel`, { method: 'POST', body: {} }); load(); }
    catch (e) { setError(e.message); }
  }

  return (
    <>
      {error && <Notice kind="error" onDone={() => setError('')}>{error}</Notice>}
      {notice && <Notice kind="success" onDone={() => setNotice('')}>{notice}</Notice>}

      <Card
        title="Fuel requests"
        actions={canCreate && <button className="btn" onClick={() => setShowForm(!showForm)}>{showForm ? 'Close' : '+ New request'}</button>}
      >
        {showForm && (
          <form onSubmit={createRequest} className="grid c3" style={{ marginBottom: 16 }}>
            <Field label="Vehicle *">
              <select {...bind('vehicle_id')} required>
                <option value="">Select vehicle…</option>
                {refs.vehicles.map((v) => <option key={v.id} value={v.id}>{v.plate} {v.make ? `· ${v.make} ${v.model || ''}` : ''}</option>)}
              </select>
            </Field>
            <Field label="Fuel type *">
              <select {...bind('fuel_type_id')} required>
                <option value="">Select fuel…</option>
                {refs.fuel_types.filter((f) => f.active).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </Field>
            <Field label="Quantity (L) *">
              <input type="number" step="0.01" min="0.01" {...bind('quantity')} required />
            </Field>
            <Field label="Driver"><input {...bind('driver_name')} placeholder="auto from vehicle" /></Field>
            <Field label="Destination"><input {...bind('destination')} /></Field>
            <Field label="Notes"><input {...bind('notes')} /></Field>
            <div style={{ gridColumn: '1 / -1' }}>
              <button className="btn">Submit request</button>
            </div>
          </form>
        )}

        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'pending', label: 'Pending' },
            { value: 'approved', label: 'Approved' },
            { value: 'issued', label: 'Issued' },
            { value: 'rejected', label: 'Rejected' },
            { value: 'all', label: 'All' },
          ]}
        />

        <Table
          columns={[
            { key: 'request_no', label: 'Request' },
            { key: 'created_at', label: 'Date', render: (r) => fmtDateTime(r.created_at) },
            { key: 'plate', label: 'Vehicle' },
            { key: 'fuel_type_name', label: 'Fuel' },
            { key: 'quantity', label: 'Quantity', num: true, render: (r) => fmtQty(r.quantity) },
            { key: 'destination', label: 'Destination' },
            { key: 'requested_by_name', label: 'Requested by' },
            { key: 'authorized_by_name', label: 'Authorized by', render: (r) => r.authorized_by_name || '—' },
            { key: 'status', label: 'Status', render: (r) => <StatusPill status={r.status} /> },
            {
              key: 'actions', label: '', render: (r) => (
                <span className="row-actions">
                  {canDecide && r.status === 'pending' && (
                    <>
                      <button className="btn success sm" onClick={() => decide(r.id, 'approve')}>Approve</button>
                      <button className="btn danger sm" onClick={() => decide(r.id, 'reject')}>Reject</button>
                    </>
                  )}
                  {r.status === 'pending' && (r.requested_by === user.id || user.role === 'admin') && (
                    <button className="btn secondary sm" onClick={() => cancel(r.id)}>Cancel</button>
                  )}
                </span>
              ),
            },
          ]}
          rows={rows}
        />
      </Card>
    </>
  );
}
