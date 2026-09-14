'use client';
// Approvals (§24/§25/§28) — queue with tabs, detail drawer, decision with
// required rejection reason (§23), immutable history (§28).
import { useCallback, useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Card, PageHeader, Tabs, StatusPill, Skeleton, ConfirmDialog, Drawer, EmptyState } from '@/components/ui';
import { api } from '@/lib/api';
import { fmtDateTime, fmtQty, fmtKES } from '@/lib/format';

const TABS = [
  { value: 'ALL', label: 'All' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
];

export default function ApprovalsPage() {
  return <Shell><Approvals /></Shell>;
}

function Approvals() {
  const [tab, setTab] = useState('PENDING');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState(null);      // full approval + history
  const [rejecting, setRejecting] = useState(null); // approval being rejected
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const qs = tab === 'ALL' ? '' : `?status=${tab}`;
      setData(await api('/api/approvals' + qs));
    } catch (e) { setError(e.message); setData(null); }
    finally { setBusy(false); }
  }, [tab]);

  useEffect(() => { load(); }, [load]);

  async function openDetail(id) {
    try { setDetail(await api('/api/approvals/' + id)); } catch { /* keep */ }
  }

  async function decide(id, decision) {
    setBusy(true); setError('');
    try {
      const body = decision === 'REJECTED' ? { reason } : {};
      await api(`/api/approvals/${id}/${decision.toLowerCase()}`, { method: 'POST', body });
      setDetail(null); setRejecting(null); setReason('');
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  const counts = data?.counts || {};
  const rows = data?.approvals || [];

  return (
    <>
      <PageHeader
        title="Approvals"
        subtitle="Requests, excess fuel, adjustments and variances awaiting a decision"
      />
      <Card>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
          <Tabs tabs={TABS.map((t) => ({ ...t, label: t.value === 'ALL' ? 'All' : `${t.label}${counts[t.value] != null ? ` (${counts[t.value]})` : ''}` }))} value={tab} onChange={setTab} />
          {error && <span style={{ color: 'var(--red)', fontSize: 12 }} role="alert">{error}</span>}
        </div>

        {!data ? <Skeleton lines={8} /> : rows.length === 0 ? (
          <EmptyState icon="check-circle" title="Nothing here" message={tab === 'PENDING' ? 'No pending approvals — you are all caught up.' : 'No records for this filter.'} />
        ) : (
          <div className="dt-tablewrap">
            <table className="tbl sticky">
              <thead>
                <tr>
                  <th>Type</th><th>Reference</th><th>Requested by</th><th className="num">Quantity</th>
                  <th>Date</th><th>Status</th><th>Decided by</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id} className="clickable" onClick={() => openDetail(a.id)}>
                    <td>{a.entity_type.replace(/_/g, ' ')}</td>
                    <td className="mono">{String(a.entity_id).slice(0, 8)}</td>
                    <td>{a.requested_by_name || '—'}</td>
                    <td className="num">{a.quantity != null ? fmtQty(a.quantity) : '—'}</td>
                    <td className="nowrap">{fmtDateTime(a.created_at)}</td>
                    <td><StatusPill status={a.status.toLowerCase()} /></td>
                    <td>{a.decided_by_name || '—'}</td>
                    <td className="nowrap">
                      {a.status === 'PENDING' && (
                        <>
                          <button className="btn sm" disabled={busy} onClick={(e) => { e.stopPropagation(); decide(a.id, 'APPROVED'); }}>Approve</button>{' '}
                          <button className="btn danger sm" disabled={busy} onClick={(e) => { e.stopPropagation(); setRejecting(a); }}>Reject</button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Drawer open={!!detail} onClose={() => setDetail(null)} title="Approval details" subtitle={detail?.approval?.entity_type?.replace(/_/g, ' ')}>
        {detail && (
          <>
            <div className="kv">
              {[
                ['Status', detail.approval.status],
                ['Type', detail.approval.entity_type.replace(/_/g, ' ')],
                ['Requested by', detail.approval.requested_by_name || '—'],
                ['Quantity', detail.approval.quantity != null ? fmtQty(detail.approval.quantity) : '—'],
                ['Submitted', fmtDateTime(detail.approval.created_at)],
                ['Decided by', detail.approval.decided_by_name || '—'],
                ['Decided at', detail.approval.decided_at ? fmtDateTime(detail.approval.decided_at) : '—'],
                ['Decision reason', detail.approval.reason || '—'],
              ].map(([k, v]) => <div className="kv-row" key={k}><span className="kv-k">{k}</span><span className="kv-v">{v}</span></div>)}
            </div>

            <h4 style={{ margin: '14px 0 6px' }}>Approval history</h4>
            {detail.history.map((e) => (
              <div key={e.id} style={{ borderLeft: '2px solid var(--border)', paddingLeft: 10, marginBottom: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 700 }}>{e.action} — {e.actor_name || 'system'}</div>
                <div className="muted" style={{ fontSize: 11.5 }}>{fmtDateTime(e.created_at)}</div>
                {e.reason && <div style={{ fontSize: 12, marginTop: 2 }}>Reason: {e.reason}</div>}
              </div>
            ))}

            {detail.approval.status === 'PENDING' && (
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button className="btn" disabled={busy} onClick={() => decide(detail.approval.id, 'APPROVED')}>Approve</button>
                <button className="btn danger" disabled={busy} onClick={() => setRejecting(detail.approval)}>Reject…</button>
              </div>
            )}
          </>
        )}
      </Drawer>

      <ConfirmDialog
        open={!!rejecting}
        title="Reject approval"
        message={rejecting ? `Reject this ${rejecting.entity_type.replace(/_/g, ' ')}? A reason is required.` : ''}
        confirmLabel="Reject"
        danger
        busy={busy}
        onConfirm={() => rejecting && decide(rejecting.id, 'REJECTED')}
        onCancel={() => { setRejecting(null); setReason(''); }}
      >
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason for rejection (required)…"
          rows={3}
          style={{ width: '100%', marginTop: 8 }}
        />
      </ConfirmDialog>
    </>
  );
}
