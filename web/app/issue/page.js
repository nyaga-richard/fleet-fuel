'use client';
import { useCallback, useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Card, Table, StatusPill, Notice, useForm, Field } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtQty, fmtDateTime } from '@/lib/format';

export default function IssuePage() {
  return <Shell><Issue /></Shell>;
}

function Issue() {
  const { user } = useAuth();
  const canReverse = user.role === 'admin' || user.role === 'manager';

  const [approved, setApproved] = useState([]);
  const [txns, setTxns] = useState([]);
  const [pumps, setPumps] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const { form, bind, setForm } = useForm({ request_id: '', pump_id: '', quantity: '', unit_price: '', odometer: '', pump_reading: '' });

  const load = useCallback(async () => {
    try {
      const [r, t, p] = await Promise.all([
        api('/api/requests?status=approved&limit=100'),
        api('/api/transactions?limit=100'),
        api('/api/pumps'),
      ]);
      setApproved(r.requests);
      setTxns(t.transactions);
      setPumps(p.pumps);
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-fill quantity when a request is picked.
  function onPickRequest(e) {
    const id = e.target.value;
    const req = approved.find((r) => r.id === id);
    setForm((f) => ({ ...f, request_id: id, quantity: req ? String(req.quantity) : f.quantity }));
  }

  async function issue(e) {
    e.preventDefault();
    setError('');
    try {
      const body = {
        request_id: form.request_id,
        pump_id: form.pump_id || undefined,
        quantity: Number(form.quantity),
        unit_price: form.unit_price ? Number(form.unit_price) : undefined,
        odometer: form.odometer ? Number(form.odometer) : undefined,
        pump_reading: form.pump_reading ? Number(form.pump_reading) : undefined,
      };
      const res = await api('/api/transactions/issue', { method: 'POST', body });
      setNotice(`Fuel issued — transaction ${res.transaction.txn_no}. Ledger balance: ${Number(res.transaction.balance_after).toLocaleString()} L`);
      setForm({ request_id: '', pump_id: '', quantity: '', unit_price: '', odometer: '', pump_reading: '' });
      load();
    } catch (e) { setError(e.message); }
  }

  async function reverse(id) {
    const reason = window.prompt('Reversal reason (required, audited):');
    if (!reason) return;
    setError('');
    try {
      await api(`/api/transactions/${id}/reverse`, { method: 'POST', body: { reason } });
      setNotice('Transaction reversed — stock restored via compensating ledger entry.');
      load();
    } catch (e) { setError(e.message); }
  }

  return (
    <>
      {error && <Notice kind="error" onDone={() => setError('')}>{error}</Notice>}
      {notice && <Notice kind="success" onDone={() => setNotice('')}>{notice}</Notice>}

      <Card title="Issue fuel against an approved request">
        {approved.length === 0 && <div className="msg info">No approved requests waiting. Approve a request first.</div>}
        <form onSubmit={issue} className="grid c3">
          <Field label="Approved request *">
            <select value={form.request_id} onChange={onPickRequest} required>
              <option value="">Select request…</option>
              {approved.map((r) => (
                <option key={r.id} value={r.id}>{r.request_no} · {r.plate} · {fmtQty(r.quantity, '')} {r.fuel_type_name}</option>
              ))}
            </select>
          </Field>
          <Field label="Pump *">
            <select {...bind('pump_id')} required>
              <option value="">Select pump…</option>
              {pumps.filter((p) => p.active).map((p) => (
                <option key={p.id} value={p.id}>{p.name} · {p.fuel_type_name}</option>
              ))}
            </select>
          </Field>
          <Field label="Quantity (L) *"><input type="number" step="0.01" min="0.01" {...bind('quantity')} required /></Field>
          <Field label="Pump meter reading"><input type="number" step="0.01" min="0" {...bind('pump_reading')} placeholder="closing scale" /></Field>
          <Field label="Odometer (km)"><input type="number" step="0.1" min="0" {...bind('odometer')} /></Field>
          <Field label="Unit price"><input type="number" step="0.01" min="0" {...bind('unit_price')} /></Field>
          <div style={{ gridColumn: '1 / -1' }}>
            <button className="btn" disabled={approved.length === 0}>Issue fuel</button>
            <span className="muted" style={{ marginLeft: 10, fontSize: 12 }}>
              Posts an immutable fuel-ledger entry and marks the request issued.
            </span>
          </div>
        </form>
      </Card>

      <Card title="Recent transactions">
        <Table
          columns={[
            { key: 'txn_no', label: 'Txn' },
            { key: 'created_at', label: 'Date', render: (r) => fmtDateTime(r.created_at) },
            { key: 'request_no', label: 'Request', render: (r) => r.request_no || '—' },
            { key: 'plate', label: 'Vehicle' },
            { key: 'fuel_type_name', label: 'Fuel' },
            { key: 'quantity', label: 'Qty', num: true, render: (r) => fmtQty(r.quantity) },
            { key: 'operator_name', label: 'Operator', render: (r) => r.operator_name || '—' },
            { key: 'status', label: 'Status', render: (r) => <StatusPill status={r.status} /> },
            {
              key: 'actions', label: '', render: (r) => (
                canReverse && r.status === 'completed' && !r.reversal_of ? (
                  <button className="btn secondary sm" onClick={() => reverse(r.id)}>Reverse</button>
                ) : null
              ),
            },
          ]}
          rows={txns}
          empty="No fuel issued yet"
        />
      </Card>
    </>
  );
}
