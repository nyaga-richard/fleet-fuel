'use client';
// Fuel Ledger — the immutable accounting view over inventory_transactions.
// Filters (fuel type, entry type, date range) are SERVER-side; running
// balances come from the database, so they stay correct under any filter.
import { useCallback, useEffect, useMemo, useState } from 'react';
import Shell from '@/components/Shell';
import { Card, PageHeader, SearchInput, Notice, Field, DataTable, StatusPill, Skeleton, Stat } from '@/components/ui';
import { api } from '@/lib/api';
import { fmtQty, fmtDateTime } from '@/lib/format';

export default function LedgerPage() {
  return <Shell><Ledger /></Shell>;
}

function Ledger() {
  const [refs, setRefs] = useState([]);
  const [fuelTypeId, setFuelTypeId] = useState('');
  const [entryType, setEntryType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState('');
  const [entries, setEntries] = useState(null);
  const [summary, setSummary] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/api/fuel-types').then((r) => setRefs(r.fuel_types)).catch((e) => setError(e.message));
  }, []);

  const load = useCallback(async () => {
    setError('');
    try {
      const p = new URLSearchParams({ limit: '500' });
      if (fuelTypeId) p.set('fuel_type_id', fuelTypeId);
      if (entryType) p.set('entry_type', entryType);
      if (from) p.set('from', from);
      if (to) p.set('to', to);
      const [e, s] = await Promise.all([
        api(`/api/ledger?${p.toString()}`),
        api(`/api/ledger/summary${fuelTypeId ? `?fuel_type_id=${fuelTypeId}` : ''}`),
      ]);
      setEntries(e.entries);
      setSummary(s.summary);
    } catch (e) { setError(e.message); }
  }, [fuelTypeId, entryType, from, to]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    if (!entries) return [];
    const term = q.trim().toLowerCase();
    if (!term) return entries;
    const m = (s) => String(s ?? '').toLowerCase().includes(term);
    return entries.filter((r) => m(r.description) || m(r.fuel_type_name) || m(r.tank_name) || m(r.entry_type) || m(r.performed_by_name));
  }, [entries, q]);

  function exportCsv() {
    const header = ['Date', 'Entry', 'Fuel', 'Tank', 'Quantity', 'Balance after', 'Description', 'By'];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = filtered.map((r) => [
      fmtDateTime(r.created_at), r.entry_type, r.fuel_type_name, r.tank_name || '',
      Number(r.quantity).toFixed(2), Number(r.balance_after).toFixed(2),
      r.description || '', r.performed_by_name || 'system',
    ].map(esc).join(','));
    const blob = new Blob(['\uFEFF' + [header.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fuel-ledger-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <PageHeader
        title="Fuel Ledger"
        subtitle="Every stock movement — immutable, reconstructible, audited"
        actions={<button className="btn secondary" onClick={exportCsv} disabled={!filtered?.length}>⬇ Export CSV</button>}
      />

      {error && <Notice kind="error" onDone={() => setError('')}>{error}</Notice>}

      <div className="grid c3" style={{ marginBottom: 18 }}>
        {!summary.length && !fuelTypeId ? null : (summary || []).map((s) => (
          <div className="card" key={s.fuel_type_id} style={{ marginBottom: 0 }}>
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

      <Card title="Ledger entries">
        <div className="grid c4" style={{ marginBottom: 12 }}>
          <Field label="Fuel type">
            <select value={fuelTypeId} onChange={(e) => setFuelTypeId(e.target.value)}>
              <option value="">All fuel types</option>
              {refs.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </Field>
          <Field label="Entry type">
            <select value={entryType} onChange={(e) => setEntryType(e.target.value)}>
              <option value="">All entries</option>
              <option value="opening">Opening</option>
              <option value="receipt">Receipt</option>
              <option value="issue">Issue</option>
              <option value="adjustment">Adjustment</option>
              <option value="reversal">Reversal</option>
            </select>
          </Field>
          <Field label="From date">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To date">
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        <div style={{ marginBottom: 12 }}>
          <SearchInput value={q} onChange={setQ} placeholder="Search particulars, tank, user…" width={300} />
        </div>

        {!entries ? <Skeleton lines={8} /> : (
          <DataTable
            columns={[
              { key: 'created_at', label: 'Date', render: (r) => fmtDateTime(r.created_at) },
              { key: 'entry_type', label: 'Entry', render: (r) => <StatusPill status={r.entry_type} /> },
              { key: 'fuel_type_name', label: 'Fuel' },
              { key: 'tank_name', label: 'Tank', render: (r) => r.tank_name || '—' },
              {
                key: 'quantity', label: 'Qty in / out', num: true, render: (r) => (
                  <span className={Number(r.quantity) >= 0 ? 'pos' : 'neg'}>
                    {Number(r.quantity) >= 0 ? '+' : ''}{fmtQty(r.quantity, '')}
                  </span>
                ),
              },
              { key: 'balance_after', label: 'Running balance', num: true, render: (r) => fmtQty(r.balance_after, '') },
              { key: 'description', label: 'Particulars', render: (r) => r.description || '—' },
              { key: 'performed_by_name', label: 'User', render: (r) => r.performed_by_name || 'system' },
            ]}
            rows={filtered}
            pageSize={30}
            mobileCard={(r) => (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                  <StatusPill status={r.entry_type} />
                  <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: Number(r.quantity) >= 0 ? 'var(--green)' : 'var(--amber)' }}>
                    {Number(r.quantity) >= 0 ? '+' : ''}{fmtQty(r.quantity, '')}
                  </span>
                </div>
                <div style={{ margin: '5px 0 3px', fontWeight: 600 }}>{r.fuel_type_name}{r.tank_name ? ` · ${r.tank_name}` : ''}</div>
                <div className="muted" style={{ fontSize: 12 }}>{r.description || '—'}</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  Balance: <b>{fmtQty(r.balance_after, '')}</b> · {fmtDateTime(r.created_at)}
                </div>
              </>
            )}
            empty={q ? `No entries match “${q}”` : 'No ledger entries yet — stock comes from deliveries and openings'}
          />
        )}
      </Card>
    </>
  );
}
