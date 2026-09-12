'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import Shell from '@/components/Shell';
import { Card, Stat, Table, StatusPill, Notice } from '@/components/ui';
import { api } from '@/lib/api';
import { fmtQty, fmtDateTime } from '@/lib/format';

export default function DashboardPage() {
  return <Shell><Dashboard /></Shell>;
}

function Dashboard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api('/api/inventory/stock'),
      api('/api/requests?status=pending&limit=8'),
      api('/api/transactions?limit=8'),
      api('/api/system/version'),
    ]).then(([stock, requests, txns, version]) => setData({ stock, requests, txns, version }))
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <Notice kind="error">{error}</Notice>;
  if (!data) return <p className="muted">Loading…</p>;

  const stock = data.stock.by_fuel_type || [];
  const tanks = data.stock.by_tank || [];
  const pending = (data.requests.requests || []).length;

  return (
    <>
      <div className="grid c4" style={{ marginBottom: 18 }}>
        {stock.map((s) => <StockCard key={s.id} s={s} tanks={tanks} />)}
        <Stat label="Pending requests" value={pending} sub={pending > 0 ? 'awaiting authorization' : 'all clear'} />
      </div>

      <Card title="Recent fuel transactions">
        <Table
          columns={[
            { key: 'txn_no', label: 'Txn' },
            { key: 'created_at', label: 'Date', render: (r) => fmtDateTime(r.created_at) },
            { key: 'plate', label: 'Vehicle' },
            { key: 'fuel_type_name', label: 'Fuel' },
            { key: 'quantity', label: 'Quantity', num: true, render: (r) => fmtQty(r.quantity) },
            { key: 'operator_name', label: 'Operator' },
            { key: 'status', label: 'Status', render: (r) => <StatusPill status={r.status} /> },
          ]}
          rows={data.txns.transactions || []}
          empty="No fuel issued yet"
        />
      </Card>

      <Card title="Pending fuel requests" actions={<Link href="/requests">All requests →</Link>}>
        <Table
          columns={[
            { key: 'request_no', label: 'Request' },
            { key: 'created_at', label: 'Date', render: (r) => fmtDateTime(r.created_at) },
            { key: 'plate', label: 'Vehicle' },
            { key: 'fuel_type_name', label: 'Fuel' },
            { key: 'quantity', label: 'Quantity', num: true, render: (r) => fmtQty(r.quantity) },
            { key: 'requested_by_name', label: 'Requested by' },
          ]}
          rows={data.requests.requests || []}
          empty="Nothing pending"
        />
      </Card>
    </>
  );
}

function StockCard({ s, tanks }) {
  const tankStock = tanks.filter((t) => t.code === s.code);
  const cap = tankStock.reduce((a, t) => a + Number(t.capacity || 0), 0);
  const pct = cap > 0 ? (Number(s.balance) / cap) * 100 : 0;
  return (
    <Stat
      label={`${s.name} stock`}
      value={fmtQty(s.balance, s.unit)}
      sub={cap > 0 ? `${pct.toFixed(0)}% of ${fmtQty(cap, s.unit)} capacity` : '—'}
      pct={pct}
    />
  );
}
