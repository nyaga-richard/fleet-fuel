'use client';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Card, Table } from '@/components/ui';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';

export default function SystemPage() {
  return <Shell><System /></Shell>;
}

function System() {
  const [state, setState] = useState({ loading: true, error: null, needsAuth: false, data: null });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null, needsAuth: false }));
    (async () => {
      try {
        const [v, h, d] = await Promise.all([
          api('/api/system/version'),
          api('/api/health'),
          api('/api/system/deployments').catch(() => ({ deployments: [] })),
        ]);
        if (alive) setState({ loading: false, error: null, needsAuth: false, data: { v, h, deployments: d.deployments || [] } });
      } catch (e) {
        if (!alive) return;
        if (e.status === 401) {
          // Boundary for the exact case of an expired/rotated session.
          setState({ loading: false, error: null, needsAuth: true, data: null });
        } else {
          setState({ loading: false, error: e.message, needsAuth: false, data: null });
        }
      }
    })();
    return () => { alive = false; };
  }, [tick]);

  if (state.loading) return <p className="muted">Loading…</p>;

  if (state.needsAuth) {
    return (
      <div className="card" style={{ maxWidth: 560, margin: '60px auto', textAlign: 'center' }}>
        <h2 style={{ marginBottom: 8 }}>Sign in required</h2>
        <p className="muted" style={{ marginBottom: 16 }}>
          Your session has expired or is no longer valid. Sign in again to view system information.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <button className="btn" onClick={() => { window.location.href = '/login'; }}>Go to sign-in</button>
          <button className="btn secondary" onClick={() => setTick((t) => t + 1)}>Retry</button>
        </div>
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="card" style={{ maxWidth: 560, margin: '60px auto', textAlign: 'center' }}>
        <h2 style={{ marginBottom: 8 }}>Could not load system information</h2>
        <p className="muted" style={{ marginBottom: 16 }}>{state.error}</p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <button className="btn" onClick={() => setTick((t) => t + 1)}>Try again</button>
          <button className="btn secondary" onClick={() => { window.location.href = '/'; }}>Go to dashboard</button>
        </div>
      </div>
    );
  }

  const { v, h, deployments } = state.data;
  return (
    <>
      <div className="grid c3" style={{ marginBottom: 18 }}>
        <div className="stat">
          <div className="label">Application version</div>
          <div className="value">v{v.version}</div>
          <div className="sub mono">git commit: {v.commit} · {v.branch}</div>
        </div>
        <div className="stat">
          <div className="label">Deployed</div>
          <div className="value" style={{ fontSize: 17 }}>{v.build_date !== 'unknown' ? v.build_date : '—'}</div>
          <div className="sub">environment: {v.environment} · tz {v.timezone}</div>
        </div>
        <div className="stat">
          <div className="label">API status</div>
          <div className="value" style={{ color: h?.status === 'ok' ? '#22c55e' : '#ef4444', fontSize: 20 }}>
            {h?.status === 'ok' ? 'ONLINE' : 'DEGRADED'}
          </div>
          <div className="sub">database: {h?.database} · uptime {Math.round(v.runtime.uptime_s / 60)} min</div>
        </div>
      </div>

      <Card title="Runtime">
        <Table
          columns={[{ key: 'k', label: 'Setting' }, { key: 'v', label: 'Value' }]}
          rows={[
            { k: 'Node.js', v: v.runtime.node },
            { k: 'API host', v: v.runtime.hostname },
            { k: 'API started at', v: fmtDateTime(v.runtime.started_at) },
            { k: 'Database migrations applied', v: v.database.migrations?.applied ?? '—' },
            { k: 'Latest migration', v: v.database.migrations?.latest ?? '—' },
            { k: 'Server time', v: fmtDateTime(v.server_time) },
          ]}
          keyField="k"
        />
      </Card>

      <Card title="Deployment history (audit)">
        <Table
          columns={[
            { key: 'created_at', label: 'When', render: (r) => fmtDateTime(r.created_at) },
            { key: 'action', label: 'Event', render: (r) => String(r.action || '').replace('deploy.', '') },
            { key: 'details', label: 'Details', render: (r) => <span className="mono">{r.details ? JSON.stringify(r.details) : '—'}</span> },
          ]}
          rows={deployments}
          empty="No deployment events recorded yet"
        />
      </Card>
    </>
  );
}
