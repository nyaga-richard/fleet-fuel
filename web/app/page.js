'use client';
// Dashboard (§51 responsive overview) — KPI cards + charts only, no data
// tables: a quick-glance operations overview. Everything is real API data;
// attendants simply don't see the manager/admin sections (server RBAC).
//
// Layout:
//   1. Stock + today KPIs (per fuel type, issued today, pending, approvals)
//   2. Fuel consumption — interactive stacked area chart (90d series)
//   3. Fuel split donut (30d) + fleet KPIs
//   4. Pending requests & recent activity as compact cards
//   5. Top consumers as ranked bars (visual, not a table)
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip as PieTooltip } from 'recharts';
import Shell from '@/components/Shell';
import { Card, PageHeader, Stat, StatusPill, Notice, Skeleton, EmptyState } from '@/components/ui';
import UsageAreaChart from '@/components/usage-area-chart';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtQty, fmtDateTime, fmtNum, fmtKES } from '@/lib/format';

const DONUT_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--muted)'];

export default function DashboardPage() {
  return <Shell><Dashboard /></Shell>;
}

function Dashboard() {
  const { user } = useAuth();
  const isDecider = user?.role === 'admin' || user?.role === 'manager';
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const from = new Date(Date.now() - 13 * 86400000).toISOString().slice(0, 10);
    Promise.all([
      api('/api/inventory/stock'),
      api('/api/requests?status=pending&limit=6'),
      api(`/api/transactions?from=${from}&limit=300`),
      api('/api/system/version'),
      api('/api/dashboard/usage?days=90').catch(() => null),
      api('/api/reports/fleet-dashboard').catch(() => null), // attendants lack reports:view — section hides
      isDecider ? api('/api/approvals?status=PENDING&pageSize=6').catch(() => null) : Promise.resolve(null),
    ]).then(([stock, requests, txns, version, usage, fleet, approvals]) =>
      setData({ stock, requests, txns, version, usage, fleet, approvals }))
      .catch((e) => setError(e.message));
  }, [isDecider]);

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
  const pendingApprovals = data.approvals?.counts?.PENDING ?? 0;
  const usage30 = (data.usage?.series || []).slice(-30);
  const donut = (data.usage?.by_fuel_type || []).filter((d) => Number(d.litres) > 0);

  const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi' }).format(new Date());
  const issuedToday = txns
    .filter((t) => String(t.created_at || '').slice(0, 10) >= todayKey && t.status === 'completed' && !t.reversal_of)
    .reduce((a, t) => a + Number(t.quantity || 0), 0);

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Live fuel position and activity" />

      {/* ── 1. KPI row ── */}
      <div className="grid c4" style={{ marginBottom: 18 }}>
        {stock.map((s) => <StockCard key={s.id} s={s} tanks={tanks} />)}
        <Stat label="Issued today" value={fmtQty(issuedToday)} sub="all fuel types" tone="var(--chart-1)" />
        <Stat
          label="Pending requests"
          value={fmtNum(pending)}
          sub={pending > 0 ? 'awaiting authorization' : 'all clear'}
          tone={pending > 0 ? 'var(--amber)' : 'var(--green)'}
        />
        {isDecider && (
          <Stat
            label="Pending approvals"
            value={fmtNum(pendingApprovals)}
            sub={pendingApprovals > 0 ? 'decisions waiting' : 'nothing to decide'}
            tone={pendingApprovals > 0 ? 'var(--red)' : 'var(--green)'}
          />
        )}
      </div>

      {/* ── 2. Interactive consumption chart ── */}
      <UsageAreaChart />

      {/* ── 3. Split donut + fleet KPIs ── */}
      <div className="grid c2" style={{ gap: 16, marginTop: 16 }}>
        <Card title="Fuel split — last 30 days" actions={<Link href="/inventory" className="muted" style={{ fontSize: 12 }}>Inventory →</Link>}>
          {donut.length ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ width: 190, height: 190, flexShrink: 0 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={donut} dataKey="litres" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={3} strokeWidth={0} isAnimationActive={false}>
                      {donut.map((_, i) => <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />)}
                    </Pie>
                    <PieTooltip content={<DonutTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div style={{ display: 'grid', gap: 8, fontSize: 13, flex: 1, minWidth: 140 }}>
                {donut.map((d, i) => (
                  <div key={d.name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 3, background: DONUT_COLORS[i % DONUT_COLORS.length], flexShrink: 0 }} />
                    <span className="muted" style={{ flex: 1 }}>{d.name}</span>
                    <b>{fmtQty(d.litres)} L</b>
                  </div>
                ))}
              </div>
            </div>
          ) : <EmptyState icon="◔" title="No fuel data" message="Fuel issued or purchased in the last 30 days will chart here." />}
        </Card>

        {fleet ? (
          <Card title="Fleet at a glance" actions={<Link href="/vehicles" className="muted" style={{ fontSize: 12 }}>Vehicles →</Link>}>
            <div className="grid c2" style={{ gap: 12 }}>
              <Stat label="Active vehicles" value={fleetKpi['Active Vehicles'] || '0'} sub="fleet register" />
              <Stat label="Fuel — all sources" value={fleetKpi['Fuel Cost (all sources)'] || '—'} sub="issues + external" />
              <Stat label="Trips (period)" value={fleetKpi['Trips (period)'] || '—'} sub="distance covered" />
              <Stat label="Trip revenue" value={fleetKpi['Trip Revenue (where recorded)'] || fmtKES(0)} sub="optional per trip" />
            </div>
          </Card>
        ) : null}
      </div>

      {/* ── 4. Pending requests + recent activity — cards, not tables ── */}
      <div className="grid c2" style={{ gap: 16, marginTop: 16 }}>
        <Card title={`Pending requests${pending ? ` (${pending})` : ''}`} actions={<Link href="/requests" className="muted" style={{ fontSize: 12 }}>All requests →</Link>}>
          {(data.requests.requests || []).length ? (
            <div style={{ display: 'grid', gap: 8 }}>
              {data.requests.requests.slice(0, 5).map((r) => (
                <Link key={r.id} href="/requests" className="mini-row">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <b className="mono" style={{ fontSize: 12.5 }}>{r.request_no || '—'}</b>
                    <div className="muted" style={{ fontSize: 12 }}>{r.plate} · {fmtQty(r.quantity)} {r.fuel_type_name}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <StatusPill status={r.status} />
                    <div className="muted" style={{ fontSize: 11 }}>{fmtDateTime(r.created_at)}</div>
                  </div>
                </Link>
              ))}
            </div>
          ) : <EmptyState icon="✓" title="Nothing pending" message="All fuel requests have been decided." />}
        </Card>

        <Card title="Recent activity" actions={<Link href="/ledger" className="muted" style={{ fontSize: 12 }}>Fuel ledger →</Link>}>
          {txns.length ? (
            <div style={{ display: 'grid', gap: 8 }}>
              {txns.slice(0, 5).map((t) => (
                <div key={t.id} className="mini-row">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <b className="mono" style={{ fontSize: 12.5 }}>{t.txn_no}</b>
                    <div className="muted" style={{ fontSize: 12 }}>{t.plate} · {fmtQty(t.quantity)} {t.fuel_type_name}{t.operator_name ? ` · ${t.operator_name}` : ''}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <StatusPill status={t.status} />
                    <div className="muted" style={{ fontSize: 11 }}>{fmtDateTime(t.created_at)}</div>
                  </div>
                </div>
              ))}
            </div>
          ) : <EmptyState icon="≡" title="No fuel issued yet" message="Issued fuel appears here immediately." />}
        </Card>
      </div>

      {/* ── 5. Top consumers — ranked bars ── */}
      {fleet && (
        <Card title="Top fuel consumers — this month" actions={<Link href="/external-fuel" className="muted" style={{ fontSize: 12 }}>External fuel →</Link>}>
          {(fleet.rows || []).length ? <TopConsumers rows={fleet.rows} /> : <EmptyState icon="▲" title="Quiet period" message="No fuel recorded this month yet." />}
        </Card>
      )}
    </>
  );
}

function StockCard({ s, tanks }) {
  const tankStock = tanks.filter((t) => t.code === s.code);
  const cap = tankStock.reduce((a, t) => a + Number(t.capacity || 0), 0);
  const pct = cap > 0 ? (Number(s.balance) / cap) * 100 : 0;
  const tone = pct < 15 ? 'var(--red)' : pct < 30 ? 'var(--amber)' : undefined;
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

// Ranked horizontal bars — reads at a glance, works on mobile.
function TopConsumers({ rows }) {
  const max = Math.max(1, ...rows.map((r) => Number(r.litres || 0)));
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {rows.slice(0, 6).map((r, i) => {
        const litres = Number(r.litres || 0);
        const abnormal = r.flag === 'ABNORMAL';
        return (
          <div key={r.registration || i}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12.5, marginBottom: 3 }}>
              <b>{r.registration}{abnormal && <span className="muted" style={{ fontWeight: 500 }}> · ⚠ abnormal KM/L</span>}</b>
              <span className="muted">{fmtNum(litres, 0)} L{r.km_per_l != null ? ` · ${r.km_per_l} KM/L` : ''}</span>
            </div>
            <div style={{ height: 8, borderRadius: 4, background: 'var(--panel-2)', overflow: 'hidden' }}>
              <div style={{
                width: `${Math.max(2, (litres / max) * 100)}%`, height: '100%', borderRadius: 4,
                background: abnormal ? 'var(--red)' : i === 0 ? 'var(--chart-1)' : 'var(--chart-3)',
                opacity: abnormal ? 0.85 : 1,
              }} />
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
              {r.vehicle || '—'} · {fmtNum(r.cost || 0, 0)} KES{r.distance ? ` · ${fmtNum(r.distance)} km` : ''}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DonutTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  return (
    <div style={{
      background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10,
      boxShadow: 'var(--shadow)', padding: '7px 11px', fontSize: 12.5,
    }}>
      <b>{p.name}</b> <span className="muted">· {fmtQty(p.value)} L</span>
    </div>
  );
}
