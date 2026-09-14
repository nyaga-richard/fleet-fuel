'use client';
// Dashboard — KPI cards, 14-day usage chart, recent activity.
// All numbers come from live APIs (stock snapshot, requests, transactions).
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import Shell from '@/components/Shell';
import { Card, PageHeader, Stat, DataTable, StatusPill, Notice, Skeleton, EmptyState } from '@/components/ui';
import { api } from '@/lib/api';
import { fmtQty, fmtDateTime, fmtNum } from '@/lib/format';

export default function DashboardPage() {
  return <Shell><Dashboard /></Shell>;
}

function Dashboard() {
  const [data, setData] = useState(null);
  const [pendingApprovals, setPendingApprovals] = useState('…');
  const [error, setError] = useState('');

  useEffect(() => {
    api('/api/approvals?status=PENDING').then((d) => setPendingApprovals(String(d.total ?? d.approvals?.length ?? 0))).catch(() => setPendingApprovals('—'));
  }, []);
  useEffect(() => {
    const from = new Date(Date.now() - 13 * 86400000).toISOString().slice(0, 10);
    Promise.all([
      api('/api/inventory/stock'),
      api('/api/requests?status=pending&limit=8'),
      api(`/api/transactions?from=${from}&limit=500`),
      api('/api/system/version'),
    ]).then(([stock, requests, txns, version]) => setData({ stock, requests, txns, version }))
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <Notice kind="error">{error}</Notice>;
  if (!data) {
    return (
      <>
        <PageHeader title="Dashboard" subtitle="Live fuel position and activity" />
        <div className="grid c4" style={{ marginBottom: 18 }}>
          {[0, 1, 2, 3].map((i) => <div key={i} className="stat"><Skeleton lines={2} /></div>)}
        </div>
        <Card><Skeleton lines={7} /></Card>
      </>
    );
  }

  const stock = data.stock.by_fuel_type || [];
  const tanks = data.stock.by_tank || [];
  const txns = data.txns.transactions || [];
  const pending = (data.requests.requests || []).length;

  const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi' }).format(new Date());
  const issuedToday = txns
    .filter((t) => String(t.created_at || '').slice(0, 10) >= todayKey && t.status === 'completed' && !t.reversal_of)
    .reduce((a, t) => a + Number(t.quantity || 0), 0);

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Live fuel position and activity" />

      <div className="grid c4" style={{ marginBottom: 18 }}>
        {stock.map((s) => <StockCard key={s.id} s={s} tanks={tanks} />)}
        <Stat label="Issued today" value={fmtQty(issuedToday)} sub="all fuel types" tone="#60a5fa" />
        <Link href="/approvals?status=PENDING" style={{ textDecoration: 'none' }}>
          <Stat label="Pending approvals" value={pendingApprovals} sub="excess · adjustments · requests" tone={pendingApprovals > 0 ? '#f59e0b' : '#22c55e'} />
        </Link>
        <Stat
          label="Pending requests"
          value={fmtNum(pending)}
          sub={pending > 0 ? 'awaiting authorization' : 'all clear'}
          tone={pending > 0 ? '#f59e0b' : '#22c55e'}
        />
      </div>

      <Card title="Fuel issued — last 14 days" actions={<Link href="/ledger">Open ledger →</Link>}>
        <UsageChart txns={txns} />
      </Card>

      <Card title="Recent fuel transactions" actions={<Link href="/issue">Issue fuel →</Link>}>
        <DataTable
          columns={[
            { key: 'txn_no', label: 'Txn' },
            { key: 'created_at', label: 'Date', render: (r) => fmtDateTime(r.created_at) },
            { key: 'plate', label: 'Vehicle' },
            { key: 'fuel_type_name', label: 'Fuel' },
            { key: 'quantity', label: 'Quantity', num: true, render: (r) => fmtQty(r.quantity) },
            { key: 'operator_name', label: 'Operator', render: (r) => r.operator_name || '—' },
            { key: 'status', label: 'Status', render: (r) => <StatusPill status={r.status} /> },
          ]}
          rows={txns.slice(0, 25)}
          mobileCard={(r) => (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                <b className="mono">{r.txn_no}</b>
                <StatusPill status={r.status} />
              </div>
              <div style={{ margin: '5px 0 3px', fontWeight: 600 }}>{r.plate} · {fmtQty(r.quantity)} {r.fuel_type_name}</div>
              <div className="muted" style={{ fontSize: 12 }}>{fmtDateTime(r.created_at)}</div>
            </>
          )}
          empty="No fuel issued yet"
          pageSize={10}
        />
      </Card>

      <Card title="Pending fuel requests" actions={<Link href="/requests">All requests →</Link>}>
        <DataTable
          columns={[
            { key: 'request_no', label: 'Request' },
            { key: 'created_at', label: 'Date', render: (r) => fmtDateTime(r.created_at) },
            { key: 'plate', label: 'Vehicle' },
            { key: 'fuel_type_name', label: 'Fuel' },
            { key: 'quantity', label: 'Quantity', num: true, render: (r) => fmtQty(r.quantity) },
            { key: 'requested_by_name', label: 'Requested by', render: (r) => r.requested_by_name || '—' },
          ]}
          rows={data.requests.requests || []}
          mobileCard={(r) => (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                <b className="mono">{r.request_no || '—'}</b>
                <StatusPill status={r.status} />
              </div>
              <div style={{ margin: '5px 0 3px', fontWeight: 600 }}>{r.plate} · {fmtQty(r.quantity)} {r.fuel_type_name}</div>
              <div className="muted" style={{ fontSize: 12 }}>{fmtDateTime(r.created_at)}</div>
            </>
          )}
          empty={<EmptyState icon="✓" title="Nothing pending" message="All fuel requests have been decided." action={<Link className="btn secondary" href="/requests">Go to requests</Link>} />}
          pageSize={10}
        />
      </Card>
    </>
  );
}

function StockCard({ s, tanks }) {
  const tankStock = tanks.filter((t) => t.code === s.code);
  const cap = tankStock.reduce((a, t) => a + Number(t.capacity || 0), 0);
  const pct = cap > 0 ? (Number(s.balance) / cap) * 100 : 0;
  const tone = pct < 15 ? '#ef4444' : pct < 30 ? '#f59e0b' : undefined;
  return (
    <Stat
      label={`${s.name} stock`}
      value={fmtQty(s.balance, s.unit)}
      sub={cap > 0 ? `${pct.toFixed(0)}% of ${fmtQty(cap, s.unit)} capacity` : '—'}
      pct={pct}
      tone={tone}
    />
  );
}

// Compact SVG bar chart — 14 daily buckets, real transaction data.
function UsageChart({ txns }) {
  const days = useMemo(() => {
    const out = [];
    const now = new Date();
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000);
      const key = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi' }).format(d);
      out.push({ key, label: key.slice(5).replace('-', '/'), total: 0 });
    }
    for (const t of txns) {
      if (t.status !== 'completed' || t.reversal_of) continue;
      const key = String(t.created_at || '').slice(0, 10);
      const bucket = out.find((o) => o.key === key);
      if (bucket) bucket.total += Number(t.quantity || 0);
    }
    return out;
  }, [txns]);

  const max = Math.max(1, ...days.map((d) => d.total));
  const W = 100; // viewBox width in units — responsive via CSS
  const H = 42;
  const bw = W / days.length;

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H + 8}`} preserveAspectRatio="none" style={{ width: '100%', height: 130 }} role="img" aria-label="Daily fuel issued, last 14 days">
        {days.map((d, i) => {
          const h = (d.total / max) * H;
          return (
            <g key={d.key}>
              <rect x={i * bw + bw * 0.15} y={H - h} width={bw * 0.7} height={Math.max(h, d.total > 0 ? 1.2 : 0.4)} rx="0.8" fill={d.total > 0 ? 'var(--accent)' : 'var(--panel-2)'} />
              {i % 3 === 0 && (
                <text x={i * bw + bw / 2} y={H + 6} textAnchor="middle" fontSize="3" fill="var(--muted)">{d.label}</text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        Peak day: {fmtQty(max)} · total 14 days: {fmtQty(days.reduce((a, d) => a + d.total, 0))}
      </div>
    </div>
  );
}
