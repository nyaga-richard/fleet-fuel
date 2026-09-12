'use client';
import { useCallback, useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Card, Table, StatusPill, Notice, Stat } from '@/components/ui';
import { api } from '@/lib/api';
import { fmtQty, fmtDateTime } from '@/lib/format';

export default function LedgerPage() {
  return <Shell><Ledger /></Shell>;
}

function Ledger() {
  const [refs, setRefs] = useState([]);
  const [fuelTypeId, setFuelTypeId] = useState('');
  const [entries, setEntries] = useState([]);
  const [summary, setSummary] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/api/fuel-types').then((r) => setRefs(r.fuel_types)).catch((e) => setError(e.message));
  }, []);

  const load = useCallback(async () => {
    setError('');
    try {
      const q = fuelTypeId ? `?fuel_type_id=${fuelTypeId}&limit=500` : '?limit=500';
      const [e, s] = await Promise.all([
        api(`/api/ledger${q}`),
        api(`/api/ledger/summary${fuelTypeId ? `?fuel_type_id=${fuelTypeId}` : ''}`),
      ]);
      setEntries(e.entries);
      setSummary(s.summary);
    } catch (e) { setError(e.message); }
  }, [fuelTypeId]);

  useEffect(() => { load(); }, [load]);

  return (
    <>
      {error && <Notice kind="error" onDone={() => setError('')}>{error}</Notice>}

      <div className="grid c3" style={{ marginBottom: 18 }}>
        {(summary || []).map((s) => (
          <div className="card" key={s.fuel_type_id}>
            <h3 style={{ textTransform: 'uppercase', letterSpacing: '.5px' }}>{s.fuel_type}</h3>
            <table className="tbl">
              <tbody>
                <tr><td className="muted">Opening balance</td><td className="num">{fmtQty(s.opening_balance)}</td></tr>
                <tr><td className="muted">Receipts</td><td className="num pos">+{fmtQty(s.receipts)}</td></tr>
                <tr><td className="muted">Issues</td><td className="num neg">{fmtQty(s.issues)}</td></tr>
                <tr><td className="muted">Adjustments</td><td className="num">{fmtQty(s.adjustments)}</td></tr>
                <tr><td className="muted">Reversals</td><td className="num pos">+{fmtQty(s.reversals)}</td></tr>
                <tr><td><b>Closing balance</b></td><td className="num"><b>{fmtQty(s.closing_balance)}</b></td></tr>
              </tbody>
            </table>
          </div>
        ))}
      </div>

      <Card
        title="Fuel ledger — immutable inventory transactions"
        actions={(
          <select value={fuelTypeId} onChange={(e) => setFuelTypeId(e.target.value)} style={{ width: 180 }}>
            <option value="">All fuel types</option>
            {refs.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        )}
      >
        <Table
          columns={[
            { key: 'created_at', label: 'Date', render: (r) => fmtDateTime(r.created_at) },
            { key: 'entry_type', label: 'Entry', render: (r) => <StatusPill status={r.entry_type} /> },
            { key: 'fuel_type_name', label: 'Fuel' },
            { key: 'tank_name', label: 'Tank', render: (r) => r.tank_name || '—' },
            {
              key: 'quantity', label: 'Quantity', num: true, render: (r) => (
                <span className={Number(r.quantity) >= 0 ? 'pos' : 'neg'}>
                  {Number(r.quantity) >= 0 ? '+' : ''}{fmtQty(r.quantity, '')}
                </span>
              ),
            },
            { key: 'balance_after', label: 'Balance after', num: true, render: (r) => fmtQty(r.balance_after, '') },
            { key: 'description', label: 'Description', render: (r) => r.description || '—' },
            { key: 'performed_by_name', label: 'By', render: (r) => r.performed_by_name || 'system' },
          ]}
          rows={entries}
          empty="No ledger entries yet — stock comes from deliveries and openings"
        />
      </Card>
    </>
  );
}
