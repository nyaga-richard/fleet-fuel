'use client';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Card, Table, Notice } from '@/components/ui';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';

export default function SystemPage() {
  return <Shell><System /></Shell>;
}

function System() {
  const [version, setVersion] = useState(null);
  const [health, setHealth] = useState(null);
  const [deployments, setDeployments] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api('/api/system/version'), api('/api/health'), api('/api/system/deployments')])
      .then(([v, h, d]) => { setVersion(v); setHealth(h); setDeployments(d.deployments || []); })
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <Notice kind="error">{error}</Notice>;
  if (!version) return <p className="muted">Loading…</p>;

  return (
    <>
      <div className="grid c3" style={{ marginBottom: 18 }}>
        <div className="stat">
          <div className="label">Application version</div>
          <div className="value">v{version.version}</div>
          <div className="sub mono">git commit: {version.commit} · {version.branch}</div>
        </div>
        <div className="stat">
          <div className="label">Deployed</div>
          <div className="value" style={{ fontSize: 17 }}>{version.build_date !== 'unknown' ? version.build_date : '—'}</div>
          <div className="sub">environment: {version.environment} · tz {version.timezone}</div>
        </div>
        <div className="stat">
          <div className="label">API status</div>
          <div className="value" style={{ color: health?.status === 'ok' ? '#22c55e' : '#ef4444', fontSize: 20 }}>
            {health?.status === 'ok' ? 'ONLINE' : 'DEGRADED'}
          </div>
          <div className="sub">database: {health?.database} · uptime {Math.round(version.runtime.uptime_s / 60)} min</div>
        </div>
      </div>

      <Card title="Runtime">
        <Table
          columns={[{ key: 'k', label: 'Setting' }, { key: 'v', label: 'Value' }]}
          rows={[
            { k: 'Node.js', v: version.runtime.node },
            { k: 'API host', v: version.runtime.hostname },
            { k: 'API started at', v: fmtDateTime(version.runtime.started_at) },
            { k: 'Database migrations applied', v: version.database.migrations?.applied ?? '—' },
            { k: 'Latest migration', v: version.database.migrations?.latest ?? '—' },
            { k: 'Server time', v: fmtDateTime(version.server_time) },
          ]}
          keyField="k"
        />
      </Card>

      <Card title="Deployment history (audit)">
        <Table
          columns={[
            { key: 'created_at', label: 'When', render: (r) => fmtDateTime(r.created_at) },
            { key: 'action', label: 'Event', render: (r) => r.action.replace('deploy.', '') },
            { key: 'details', label: 'Details', render: (r) => <span className="mono">{r.details ? JSON.stringify(r.details) : '—'}</span> },
          ]}
          rows={deployments}
          empty="No deployment events recorded yet"
        />
      </Card>
    </>
  );
}
