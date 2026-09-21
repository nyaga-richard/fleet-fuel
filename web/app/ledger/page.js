'use client';
// Fuel Ledger (§10–§17) — first-class accounting view.
//   • Running balance is computed SERVER-SIDE across the whole filtered set,
//     so pagination can never falsify it (§16).
//   • Opening/closing derive from every valid entry before Date From (§12).
//   • Export ▾ (PDF/Excel/CSV/Print) reuses the exact same server filters (§44).
//   • Clicking a row drills into the source entry (§17).
import { useCallback, useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Card, PageHeader, SearchInput, Field, StatusPill, Skeleton, Stat, SearchableSelect, ExportMenu, Drawer, Notice, FilterBar } from '@/components/ui';
import { api } from '@/lib/api';
import { fmtQty, fmtDateTime, fmtKES } from '@/lib/format';

const ENTRY_TYPES = [
  { value: 'opening', label: 'Opening Balance' },
  { value: 'receipt', label: 'Bulk Receipt' },
  { value: 'issue', label: 'Fuel Issue' },
  { value: 'adjustment', label: 'Adjustment' },
  { value: 'reversal', label: 'Reversal' },
];

export default function LedgerPage() {
  return <Shell><Ledger /></Shell>;
}

function Ledger() {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
  const [from, setFrom] = useState(monthAgo);
  const [to, setTo] = useState(today);
  const [fuelTypeId, setFuelTypeId] = useState('');
  const [entryType, setEntryType] = useState('');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);
  const [data, setData] = useState(null);
  const [fuels, setFuels] = useState([]);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => { const t = setTimeout(() => setDebouncedQ(q), 300); return () => clearTimeout(t); }, [q]);

  useEffect(() => {
    api('/api/fuel-types').then((r) => setFuels(r.fuel_types || [])).catch(() => {});
  }, []);

  const params = {
    from, to,
    fuel_type_id: fuelTypeId || undefined,
    entry_type: entryType || undefined,
    q: debouncedQ || undefined,
  };

  const load = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const qs = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).filter(([, v]) => v)), page: String(page), pageSize: String(pageSize) });
      setData(await api('/api/reports/fuel-ledger?' + qs.toString()));
    } catch (e) {
      setError(e?.message || 'Could not load the ledger.');
    }
    finally { setBusy(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, fuelTypeId, entryType, debouncedQ, page, pageSize]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [from, to, fuelTypeId, entryType, debouncedQ]);

  const summary = data?.summary || [];
  const total = data?.total || 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page0 = data?.page ?? page;
  const pageSize0 = data?.pageSize ?? pageSize;
  const from1 = total === 0 ? 0 : (page0 - 1) * pageSize0 + 1;
  const to1 = Math.min(total, page0 * pageSize0);

  return (
    <>
      <PageHeader
        title="Fuel Ledger"
        subtitle="Accounting view — every stock movement with its running balance"
        actions={<ExportMenu report="fuel-ledger" params={{ ...params, page: 1, pageSize: 1000 }} />}
      />

      <div className="cards4">
        {summary.map((s) => <Stat key={s.label} label={s.label} value={s.value} />)}
      </div>

      <div style={{ marginBottom: 12 }}>
        <SearchInput value={q} onChange={setQ} placeholder="Search reference, particulars, vehicle…" width={320} />
      </div>

      <FilterBar activeCount={(fuelTypeId ? 1 : 0) + (entryType ? 1 : 0)}>
        <div className="frow">
          <Field label="Date from"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="Date to"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          <Field label="Fuel type">
            <SearchableSelect
              value={fuelTypeId} onChange={setFuelTypeId} placeholder="All fuel types"
              options={[{ value: '', label: 'All fuel types' }, ...fuels.map((f) => ({ value: f.id, label: f.name, sub: f.code || '' }))]}
            />
          </Field>
          <Field label="Transaction type">
            <SearchableSelect
              value={entryType} onChange={setEntryType} placeholder="All transactions"
              options={[{ value: '', label: 'All transactions' }, ...ENTRY_TYPES]}
            />
          </Field>
        </div>
      </FilterBar>

      <Card>
          {error && (
            <div style={{ margin: '10px 0', display: 'flex', gap: 10, alignItems: 'center' }}>
              <Notice kind="error">{error}{data ? ' Showing the last successfully loaded view.' : ''}</Notice>
              <button className="btn secondary sm" onClick={load}>Try again</button>
            </div>
          )}
          {!data ? <Skeleton lines={10} /> : (
            <>
              <div className="dt-tablewrap">
                <table className="tbl sticky">
                  <thead>
                    <tr>
                      <th>Date</th><th>Reference</th><th>LPO</th><th>Particulars</th><th>Fuel</th><th>Type</th>
                      <th className="num">Qty In</th><th className="num">Qty Out</th><th className="num">Running</th>
                      <th className="num">Amount</th><th>Vehicle</th><th>Tank</th><th>User</th><th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.length === 0 && (
                      <tr><td colSpan={13} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                        No ledger entries in this period for the selected filters.
                      </td></tr>
                    )}
                    {data.rows.map((r) => (
                      <tr key={r.id} className="clickable" onClick={() => setDetail(r)}>
                        <td className="nowrap">{fmtDateTime(r.date)}</td>
                        <td className="mono">{r.reference}</td>
                        <td className="wrap" style={{ maxWidth: 260 }}>{r.particulars}</td>
                        <td>{r.fuel_type}</td>
                        <td><StatusPill status={r.raw_type} /></td>
                        <td className="num pos">{r.qty_in ? fmtQty(r.qty_in, '') : ''}</td>
                        <td className="num neg">{r.qty_out ? fmtQty(r.qty_out, '') : ''}</td>
                        <td className="num" style={{ fontWeight: 700 }}>{fmtQty(r.running_balance, '')}</td>
                        <td className="num">{r.amount != null ? fmtKES(r.amount) : '—'}</td>
                        <td>{r.vehicle || '—'}</td>
                        <td>{r.tank || '—'}</td>
                        <td>{r.user || 'system'}</td>
                        <td><StatusPill status={r.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="pager">
                <button className="btn secondary sm" disabled={page <= 1 || busy} onClick={() => setPage(page - 1)}>← Previous</button>
                <span className="muted">Showing {from1.toLocaleString()}–{to1.toLocaleString()} of {total.toLocaleString()}</span>
                <button className="btn secondary sm" disabled={page >= pages || busy} onClick={() => setPage(page + 1)}>Next →</button>
              </div>
            </>
          )}
      </Card>

      <Drawer open={!!detail} onClose={() => setDetail(null)} title="Ledger entry" subtitle={detail?.reference}>
        {detail && (
          <div className="kv">
            {[
              ['Date', fmtDateTime(detail.date)],
              ['Reference', detail.reference],
              ['Particulars', detail.particulars],
              ['Fuel type', detail.fuel_type],
              ['Transaction type', detail.entry_type],
              ['Qty in', detail.qty_in ? fmtQty(detail.qty_in) : '—'],
              ['Qty out', detail.qty_out ? fmtQty(detail.qty_out) : '—'],
              ['Running balance', fmtQty(detail.running_balance)],
              ['Unit cost', detail.unit_cost != null ? fmtKES(detail.unit_cost) : '—'],
              ['Amount', detail.amount != null ? fmtKES(detail.amount) : '—'],
              ['Vehicle', detail.vehicle || '—'],
              ['Pump', detail.pump || '—'],
              ['Tank', detail.tank || '—'],
              ['User', detail.user || 'system'],
              ['Status', detail.status],
            ].map(([k, v]) => (
              <div className="kv-row" key={k}><span className="kv-k">{k}</span><span className="kv-v">{v}</span></div>
            ))}
          </div>
        )}
      </Drawer>
    </>
  );
}
