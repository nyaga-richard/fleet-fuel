'use client';
import React, { useEffect, useMemo, useState } from 'react';
import Shell from '@/components/Shell';
import { Card, ExportMenu, Field, FilterBar, SearchableSelect } from '@/components/ui';
import { api } from '@/lib/api';
import { fmtKES, fmtDateTime } from '@/lib/format';

// §9 — Reports hub: all reports, one date-range control, per-report
// ExportMenu (PDF/Excel/CSV/Print). Datasets come from the same server
// builders as the detail screens (screen = export, §45). Server RBAC (§43)
// still decides who can actually export each one.
const REPORTS = [
  { key: 'fuel-ledger', title: 'Fuel Ledger', desc: 'Every stock movement with running balance — the book of record.', dated: true },
  { key: 'vehicle-ledger', title: 'Vehicle Fuel Consumption', desc: 'Per fill-up: distance, KM/L, cost per KM.', dated: true },
  { key: 'cost-per-km', title: 'Cost per KM', desc: 'Per vehicle totals: litres, distance, cost, efficiency.', dated: true },
  { key: 'fuel-inventory', title: 'Fuel Inventory', desc: 'Current stock per tank with % full and LOW flags.', dated: false },
  { key: 'daily-fuel', title: 'Daily Fuel', desc: 'Issued vs received per day, per fuel type.', dated: true },
  { key: 'bulk-purchases', title: 'Bulk Fuel Purchases', desc: 'Deliveries with unit cost and totals.', dated: true },
  { key: 'pump-reconciliation', title: 'Pump Reconciliation', desc: 'Meter movement vs litres issued, with variance.', dated: true },
  { key: 'tank-reconciliation', title: 'Tank Reconciliation', desc: 'Book stock vs last dip estimate.', dated: false },
  { key: 'fuel-cost', title: 'Fuel Cost', desc: 'Litres, average unit price and total cost per fuel type.', dated: true },
  { key: 'fuel-requests', title: 'Fuel Requests', desc: 'All requests with status and destination.', dated: true },
  { key: 'fuel-authorizations', title: 'Fuel Authorizations', desc: 'Authorization decisions with comments.', dated: true },
  { key: 'excess-fuel', title: 'Excess Fuel', desc: 'Over-issued quantities and their approval outcomes.', dated: true },
  { key: 'exceptions', title: 'Exceptions', desc: 'Reversals, rejections and other exceptions.', dated: true },
  { key: 'attendant-activity', title: 'Attendant Activity', desc: 'Issues, litres and value per attendant.', dated: true },
  { key: 'fuel-transactions', title: 'Fuel Transactions', desc: 'Every issue/return/receipt transaction.', dated: true },
  { key: 'approval-history', title: 'Approval History', desc: 'Immutable trail of every approval decision.', dated: true },
  { key: 'audit-logs', title: 'Audit Logs', desc: 'Full system audit trail.', dated: true, adminOnly: true },
  // Wave 2 (§45)
  { key: 'tire-imports', title: 'Tire Imports', desc: 'Bulk import batches with created/skipped/failed counts.', dated: false },
  { key: 'tire-inventory', title: 'Tire Inventory', desc: 'Tire stock with vehicle, position, supplier and cost.', dated: false },
  { key: 'wheel-configs', title: 'Wheel Configurations', desc: 'Configurations with axle layouts and vehicle usage.', dated: false },
  { key: 'supplier-statement', title: 'Supplier Statement', desc: 'Per-supplier statement with running balance.', dated: true, needsSupplier: true },
  { key: 'supplier-aging', title: 'Supplier Aging', desc: 'Outstanding payables by age bucket (Current/30/60/90/90+).', dated: true },
];

export default function ReportsPage() {
  return <Shell><Reports /></Shell>;
}

function Reports() {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
  const [role, setRole] = useState(null);
  const [from, setFrom] = useState(monthAgo);
  const [to, setTo] = useState(today);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [suppliers, setSuppliers] = useState([]);
  const [supplierId, setSupplierId] = useState('');

  useEffect(() => {
    api('/api/suppliers').then((d) => setSuppliers(d.suppliers || [])).catch(() => {});
  }, []);

  useEffect(() => {
    api('/api/auth/me').then((d) => setRole(d?.user?.role || d?.role || null)).catch(() => setRole(null));
  }, []);
  const list = useMemo(
    () => REPORTS.filter((r) => !r.adminOnly || role === 'admin'),
    [role],
  );

  const params = useMemo(() => {
    const p = {};
    if (from) p.from = from;
    if (to) p.to = to;
    return p;
  }, [from, to]);

  // §29/§42 — supplier statements pick their supplier from a searchable select.
  function paramsFor(r) {
    if (!r.needsSupplier) return params;
    return { ...params, ...(supplierId ? { supplier_id: supplierId } : {}) };
  }

  async function peekKey(key) {
    const r = REPORTS.find((x) => x.key === key);
    setLoading(true); setPreview(null);
    try {
      const qs = new URLSearchParams(paramsFor(r)).toString();
      setPreview(await api('/api/reports/' + key + (qs ? '?' + qs : '')));
    } catch { setPreview(null); }
    setLoading(false);
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <FilterBar>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="Date From"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="Date To"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          <button type="button" className="btn secondary sm" onClick={() => { setFrom(monthAgo); setTo(today); }}>Reset range</button>
          <span className="muted" style={{ fontSize: 12, paddingBottom: 8 }}>
            The range below is baked into every dated report you export here.
          </span>
        </div>
      </FilterBar>

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
        {list.map((r) => (
          <Card key={r.key}>
            <div style={{ fontWeight: 800, fontSize: 14.5 }}>{r.title}</div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>{r.desc}</div>
            {!r.dated && <div className="muted" style={{ fontSize: 11, marginTop: 6, fontStyle: 'italic' }}>Current position (not date-filtered)</div>}
            {r.needsSupplier && (
              <div style={{ marginTop: 10 }}>
                <SearchableSelect
                  value={supplierId}
                  onChange={setSupplierId}
                  options={suppliers.map((sp) => ({ value: sp.id, label: sp.name, sub: sp.code || '' }))}
                  placeholder="Select supplier…"
                />
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <ExportMenu report={r.key} params={paramsFor(r)} formats={['pdf', 'excel', 'csv', 'print']} />
              <button type="button" className="btn secondary sm" onClick={() => peekKey(r.key)} disabled={loading || (r.needsSupplier && !supplierId)}>
                {loading ? '…' : 'Preview'}
              </button>
            </div>
          </Card>
        ))}
      </div>

      {preview && (
        <Card title={`${preview.title} — first ${Math.min(10, preview.rows?.length || 0)} of ${preview.total} rows`}>
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead><tr>{(preview.columns || []).map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
              <tbody>
                {(preview.rows || []).slice(0, 10).map((row, i) => (
                  <tr key={i}>{(preview.columns || []).map((c) => (
                    <td key={c.key} className={c.type === 'number' || c.type === 'money' ? 'num' : ''}>
                      {c.type === 'money' && row[c.key] != null ? fmtKES(row[c.key])
                        : c.type === 'datetime' && row[c.key] ? fmtDateTime(row[c.key])
                          : String(row[c.key] ?? '')}
                    </td>
                  ))}</tr>
                ))}
                {!preview.rows?.length && (
                  <tr><td colSpan={(preview.columns || []).length} className="muted" style={{ textAlign: 'center', padding: 20 }}>No rows in this range.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 10 }}>
            <button type="button" className="btn secondary sm" onClick={() => setPreview(null)}>Close preview</button>
          </div>
        </Card>
      )}
    </div>
  );
}
