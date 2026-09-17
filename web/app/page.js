'use client';
// Dashboard — KPI cards, 14-day usage chart, recent activity.
// All numbers come from live APIs (stock snapshot, requests, transactions).
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import Shell from '@/components/Shell';
import { Card, PageHeader, Stat, DataTable, StatusPill, Notice, Skeleton, EmptyState } from '@/components/ui';
import UsageAreaChart from '@/components/usage-area-chart';
import { api } from '@/lib/api';
import { fmtQty, fmtDateTime, fmtNum } from '@/lib/format';

export default function DashboardPage() {
  return <Shell><Dashboard /></Shell>;
}

function Dashboard() {
  const [data, setData] = useState(null);

  const [error, setError] = useState('');

  useEffect(() => {
  }, []);
  useEffect(() => {
    const from = new Date(Date.now() - 13 * 86400000).toISOString().slice(0, 10);
    Promise.all([
      api('/api/inventory/stock'),
      api('/api/requests?status=pending&limit=8'),
      api(`/api/transactions?from=${from}&limit=500`),
      api('/api/system/version'),
      api('/api/reports/fleet-dashboard').catch(() => null), // attendants lack reports:view — section hides
    ]).then(([stock, requests, txns, version, fleet]) => setData({ stock, requests, txns, version, fleet }))
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

  const fleet = data.fleet;
  const fleetKpi = Object.fromEntries((fleet?.summary || []).map((s) => [s.label, s.value]));
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
        <Stat
          label="Pending requests"
          value={fmtNum(pending)}
          sub={pending > 0 ? 'awaiting authorization' : 'all clear'}
          tone={pending > 0 ? '#f59e0b' : '#22c55e'}
        />
      </div>

      <UsageAreaChart />
      <div style={{ height: 2 }} />

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
    
      {fleet && (
        <>
          <div className="grid c4" style={{ marginTop: 18, marginBottom: 14 }}>
            <Stat label="Active vehicles" value={fleetKpi['Active Vehicles'] || '0'} sub="fleet register" tone="#2563eb" />
            <Stat label="Fuel — all sources" value={fleetKpi['Fuel Cost (all sources)'] || '—'} sub="station issues + external purchases" tone="#f59e0b" />
            <Stat label="Trips (period)" value={fleetKpi['Trips (period)'] || '—'} sub="distance covered" tone="#8b5cf6" />
            <Stat label="Trip revenue" value={fleetKpi['Trip Revenue (where recorded)'] || 'KES 0.00'} sub="revenue is optional per trip" tone="#22c55e" />
          </div>
          <Card title="Top fuel consumers — this month" actions={<Link className="btn secondary sm" href="/external-fuel">External fuel →</Link>}>
            <DataTable
              keyField="registration"
              columns={[
                { key: 'registration', label: 'Plate', render: (r) => <b>{r.registration}</b> },
                { key: 'vehicle', label: 'Vehicle', render: (r) => r.vehicle || '—' },
                { key: 'litres', label: 'Fuel (L)', num: true, render: (r) => fmtNum(r.litres, 2) },
                { key: 'cost', label: 'Cost', num: true, render: (r) => fmtNum(r.cost, 2) },
                { key: 'distance', label: 'Distance (km)', num: true, render: (r) => fmtNum(r.distance) },
                { key: 'km_per_l', label: 'KM/L', num: true, render: (r) => r.km_per_l ?? '—' },
                { key: 'flag', label: 'Consumption', render: (r) => r.flag === 'ABNORMAL'
                  ? <span className="pill" style={{ color: 'var(--red)', borderColor: 'var(--red)', background: 'rgba(239,68,68,.1)' }}><span className="dot" style={{ background: 'var(--red)' }} />Abnormal</span>
                  : <span className="muted">OK</span> },
              ]}
              rows={fleet.rows || []}
              empty={<span className="muted">No fuel recorded in this period yet.</span>}
            />
          </Card>
        </>
      )}
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
