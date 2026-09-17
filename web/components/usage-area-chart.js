'use client';
// ─────────────────────────────────────────────────────────────────────────────
// Fuel consumption — interactive stacked area chart (dashboard hero).
//
// Modeled on the modern shadcn "area chart interactive" pattern: gradient
// stacked areas, smooth curves, themed tooltip + legend, and a time-range
// selector (7d / 30d / 90d) that filters a 90-day server-fetched series.
//
// Data: /api/dashboard/usage — real station issues + external fuel (§48:
// distinct sources, one view). Colors come from --chart-* tokens so the chart
// re-themes instantly with LIGHT/DARK (§33). §42: the range control is the
// shared SearchableSelect.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useState } from 'react';
import {
  Area, AreaChart, CartesianGrid, XAxis, YAxis,
} from 'recharts';
import { Card, SearchableSelect, Notice } from '@/components/ui';
import { api } from '@/lib/api';
import { fmtQty } from '@/lib/format';

const RANGES = [
  { value: '90', label: 'Last 3 months' },
  { value: '30', label: 'Last 30 days' },
  { value: '7', label: 'Last 7 days' },
];

const SERIES = [
  { key: 'station', label: 'Station issues', color: 'var(--chart-1)', fillId: 'fillStation' },
  { key: 'external', label: 'External fuel', color: 'var(--chart-2)', fillId: 'fillExternal' },
];

const dayLabel = (v) => {
  const d = new Date(String(v).length <= 10 ? `${v}T00:00:00` : v);
  return d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });
};

export default function UsageAreaChart() {
  const [series, setSeries] = useState(null); // full 90-day series
  const [range, setRange] = useState('30');
  const [error, setError] = useState('');

  useEffect(() => {
    api('/api/dashboard/usage?days=90')
      .then((d) => setSeries(d.series || []))
      .catch((e) => setError(e.message));
  }, []);

  const data = useMemo(() => {
    if (!series) return null;
    const days = Number(range);
    return series.slice(-days);
  }, [series, range]);

  const totals = useMemo(() => {
    if (!data) return { station: 0, external: 0, peak: 0 };
    let s = 0, e = 0, peak = 0;
    for (const d of data) {
      s += Number(d.station || 0);
      e += Number(d.external || 0);
      peak = Math.max(peak, Number(d.station || 0) + Number(d.external || 0));
    }
    return { station: s, external: e, peak };
  }, [data]);

  if (error) return <Notice kind="info">{error} — the rest of the dashboard is unaffected.</Notice>;

  return (
    <Card
      title="Fuel consumption"
      actions={(
        <div style={{ width: 190 }}>
          <SearchableSelect value={range} onChange={setRange} options={RANGES} placeholder="Select range…" id="usage-range" />
        </div>
      )}
    >
      <div className="muted" style={{ fontSize: 12.5, marginTop: -6, marginBottom: 8 }}>
        Station issues vs external fuel purchases — litres per day, last {RANGES.find((r) => r.value === range)?.label.toLowerCase().replace('last ', '')}
      </div>
      {!data ? (
        <div style={{ height: 250, display: 'flex', alignItems: 'center', justifyContent: 'center' }} className="muted">
          Loading chart…
        </div>
      ) : (
        <>
          <div style={{ width: '100%', height: 250 }}>
            <AreaChart data={data} margin={{ top: 6, right: 6, left: -14, bottom: 0 }}>
              <defs>
                {SERIES.map((s) => (
                  <linearGradient key={s.key} id={s.fillId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={s.color} stopOpacity={0.75} />
                    <stop offset="95%" stopColor={s.color} stopOpacity={0.06} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="0" />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={32}
                tick={{ fill: 'var(--muted)', fontSize: 11 }}
                tickFormatter={dayLabel}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tick={{ fill: 'var(--muted)', fontSize: 11 }}
                tickFormatter={(v) => fmtQty(v)}
                width={58}
              />
              <Tooltip
                cursor={{ stroke: 'var(--muted)', strokeDasharray: '3 3' }}
                content={<UsageTooltip />}
              />
              <Legend content={<UsageLegend />} />
              {SERIES.map((s) => (
                <Area
                  key={s.key}
                  dataKey={s.key}
                  name={s.label}
                  type="natural"
                  fill={`url(#${s.fillId})`}
                  stroke={s.color}
                  strokeWidth={2}
                  stackId="fuel"
                  isAnimationActive={false}
                />
              ))}
            </AreaChart>
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 8, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <span>Total <b style={{ color: 'var(--text)' }}>{fmtQty(totals.station + totals.external)}</b></span>
            <span>Station <b style={{ color: 'var(--chart-1)' }}>{fmtQty(totals.station)}</b></span>
            <span>External <b style={{ color: 'var(--chart-2)' }}>{fmtQty(totals.external)}</b></span>
            <span>Peak day <b style={{ color: 'var(--text)' }}>{fmtQty(totals.peak)}</b></span>
          </div>
        </>
      )}
    </Card>
  );
}

// Themed tooltip — token colors only, flips with the theme automatically.
function UsageTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((a, p) => a + Number(p.value || 0), 0);
  return (
    <div style={{
      background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10,
      boxShadow: 'var(--shadow)', padding: '9px 12px', fontSize: 12.5, minWidth: 170,
    }}>
      <div className="muted" style={{ marginBottom: 5 }}>{dayLabel(label)}</div>
      {payload.map((p) => (
        <div key={p.dataKey} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '1.5px 0' }}>
          <span style={{ width: 8, height: 8, borderRadius: 4, background: p.stroke || p.color, flexShrink: 0 }} />
          <span className="muted" style={{ flex: 1 }}>{p.name}</span>
          <b>{fmtQty(p.value)}</b>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 7, borderTop: '1px solid var(--border)', marginTop: 5, paddingTop: 5 }}>
        <span className="muted" style={{ flex: 1 }}>Total</span>
        <b>{fmtQty(total)}</b>
      </div>
    </div>
  );
}

function UsageLegend() {
  return (
    <div style={{ display: 'flex', gap: 18, justifyContent: 'center', paddingTop: 6, fontSize: 12.5 }}>
      {SERIES.map((s) => (
        <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          <span style={{ width: 9, height: 9, borderRadius: 3, background: s.color }} />
          <span className="muted">{s.label}</span>
        </span>
      ))}
    </div>
  );
}
