'use client';
// Approvals (§13/§20/§28) — the web decision interface. Managers/admins see
// every pending approval (fuel requests, adjustments, …) and approve or
// reject with a reason. Decisions hit the SAME server endpoints as the mobile
// app (POST /api/approvals/:id/approve | /reject) and are final, auditable
// legal records — reason is mandatory on reject.
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import Shell from '@/components/Shell';
import { Card, PageHeader, StatusPill, Notice, Skeleton, Drawer, ConfirmDialog, EmptyState } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime, fmtQty } from '@/lib/format';

export default function ApprovalsPage() {
  return <Shell><Approvals /></Shell>;
}

function Approvals() {
  const { user } = useAuth();
  const [rows, setRows] = useState(null);
  const [counts, setCounts] = useState({});
  const [filter, setFilter] = useState('PENDING');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [decide, setDecide] = useState(null); // { approval, decision }
  const [reason, setReason] = useState('');
  const [detail, setDetail] = useState(null);

  const isDecider = user?.role === 'admin' || user?.role === 'manager';

  const load = useCallback(() => {
    api(`/api/approvals?status=${filter}&pageSize=100`)
      .then((d) => { setRows(d.approvals || []); setCounts(d.counts || {}); })
      .catch((e) => setError(e.message));
  }, [filter]);
  useEffect(() => { if (isDecider) load(); }, [load, isDecider]);

  async function submitDecision() {
    if (!decide) return;
    if (decide.decision === 'REJECTED' && !reason.trim()) { setError('A reason is required to reject.'); return; }
    setBusy(true); setError('');
    try {
      await api(`/api/approvals/${decide.approval.id}/${decide.decision === 'REJECTED' ? 'reject' : 'approve'}`, {
        method: 'POST', body: reason.trim() ? { reason: reason.trim() } : {},
      });
      setNotice(`${decide.decision === 'APPROVED' ? 'Approved' : 'Rejected'} — ${entityLabel(decide.approval)}.`);
      setDecide(null); setReason('');
      load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function openDetail(a) {
    try { setDetail(await api(`/api/approvals/${a.id}`)); } catch (e) { setError(e.message); }
  }

  const chips = useMemo(() => ([
    { key: 'PENDING', label: `Pending (${counts.PENDING || 0})` },
    { key: 'APPROVED', label: `Approved (${counts.APPROVED || 0})` },
    { key: 'REJECTED', label: `Rejected (${counts.REJECTED || 0})` },
    { key: '', label: 'All' },
  ]), [counts]);

  if (!isDecider) {
    return <Shell><Notice kind="info">Only managers and administrators can approve or reject.</Notice></Shell>;
  }
  if (!rows && !error) return <Shell><Skeleton /></Shell>;

  return (
    <>
      <PageHeader title="Approvals" subtitle="Fuel requests, adjustments and other decisions awaiting you. Decisions are final and audited." />
      {error && <Notice kind="error" onDone={() => setError('')}>{error}</Notice>}
      {notice && <Notice kind="success" onDone={() => setNotice('')}>{notice}</Notice>}

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        {chips.map((c) => (
          <button key={c.key} className={'btn sm ' + (filter === c.key ? '' : 'secondary')} onClick={() => { setFilter(c.key); setRows(null); }}>
            {c.label}
          </button>
        ))}
      </div>

      {rows?.length ? (
        <div style={{ display: 'grid', gap: 10 }}>
          {rows.map((a) => <ApprovalCard key={a.id} a={a} onDecide={setDecide} onOpen={() => openDetail(a)} />)}
        </div>
      ) : (
        <Card>
          <EmptyState icon="✓" title={filter === 'PENDING' ? 'Nothing waiting on you' : 'No records'} message="New approval requests appear here the moment they are submitted." />
        </Card>
      )}

      {/* reason + confirm */}
      <ConfirmDialog
        open={!!decide}
        title={decide?.decision === 'APPROVED' ? 'Approve' : 'Reject'}
        message={decide ? `${entityLabel(decide.approval)} — this decision is final and recorded in the audit trail.` : ''}
        confirmLabel={decide?.decision === 'APPROVED' ? 'Approve' : 'Reject'}
        danger={decide?.decision === 'REJECTED'}
        busy={busy}
        onConfirm={submitDecision}
        onCancel={() => { setDecide(null); setReason(''); }}
      >
        {decide?.decision === 'REJECTED' && (
          <div style={{ marginTop: 10 }}>
            <label className="muted" style={{ fontSize: 12.5 }}>Reason (required, shown to the requester)</label>
            <textarea
              value={reason} onChange={(e) => setReason(e.target.value)} rows={3} autoFocus
              style={{ width: '100%', marginTop: 4 }} placeholder="e.g. Tank stock too low for this quantity"
            />
          </div>
        )}
        {decide?.decision === 'APPROVED' && (
          <div style={{ marginTop: 10 }}>
            <label className="muted" style={{ fontSize: 12.5 }}>Comment (optional)</label>
            <input value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: '100%', marginTop: 4 }} />
          </div>
        )}
      </ConfirmDialog>

      {/* full detail + event trail */}
      <Drawer open={!!detail} onClose={() => setDetail(null)} title={detail ? entityLabel(detail.approval) : ''} subtitle={detail ? `Requested ${fmtDateTime(detail.approval.created_at)}` : ''} width={480}>
        {detail && (
          <>
            <div style={{ display: 'grid', gap: 8, fontSize: 13 }}>
              <KV k="Status" v={<StatusPill status={detail.approval.status} />} />
              {detail.approval.quantity != null && <KV k="Quantity" v={`${fmtQty(detail.approval.quantity)} L`} />}
              {detail.approval.previous_status && <KV k="Status change" v={`${detail.approval.previous_status} → ${detail.approval.new_status || '—'}`} />}
              {detail.approval.reason && <KV k="Reason" v={detail.approval.reason} />}
              <KV k="Requested by" v={detail.approval.requested_by_name || '—'} />
              {detail.approval.decided_at && <KV k="Decided by" v={`${detail.approval.decided_by_name || '—'} · ${fmtDateTime(detail.approval.decided_at)}`} />}
              {detail.approval.payload && Object.keys(detail.approval.payload).length > 0 && (
                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                  {Object.entries(detail.approval.payload).slice(0, 8).map(([k, v]) => (
                    <KV key={k} k={k.replaceAll('_', ' ')} v={String(v ?? '—')} />
                  ))}
                </div>
              )}
            </div>
            <h4 style={{ margin: '14px 0 6px', fontSize: 13 }}>Event trail</h4>
            <div style={{ display: 'grid', gap: 6, fontSize: 12.5 }}>
              {(detail.history || []).map((e) => (
                <div key={e.id} className="mini-row" style={{ alignItems: 'baseline' }}>
                  <b style={{ textTransform: 'capitalize' }}>{String(e.action).replaceAll('.', ' · ')}</b>
                  <span className="muted" style={{ flex: 1, textAlign: 'right' }}>{e.actor_name || ''} {fmtDateTime(e.created_at)}</span>
                </div>
              ))}
            </div>
            {detail.approval.status === 'PENDING' && (
              <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                <button className="btn success" onClick={() => { setDecide({ approval: detail.approval, decision: 'APPROVED' }); setDetail(null); }}>Approve</button>
                <button className="btn danger" onClick={() => { setDecide({ approval: detail.approval, decision: 'REJECTED' }); setReason(''); setDetail(null); }}>Reject…</button>
              </div>
            )}
          </>
        )}
      </Drawer>
    </>
  );
}

function ApprovalCard({ a, onDecide, onOpen }) {
  return (
    <Card>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 3 }}>
            <b style={{ textTransform: 'capitalize', fontSize: 13.5 }}>{entityLabel(a)}</b>
            <StatusPill status={a.status} />
          </div>
          <div className="muted" style={{ fontSize: 12.5 }}>
            {a.quantity != null && <>Quantity <b style={{ color: 'var(--text)' }}>{fmtQty(a.quantity)} L</b> · </>}
            Requested by <b style={{ color: 'var(--text)' }}>{a.requested_by_name || '—'}</b> · {fmtDateTime(a.created_at)}
          </div>
          {a.reason && <div className="muted" style={{ fontSize: 12, marginTop: 3, fontStyle: 'italic' }}>“{a.reason}”</div>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn secondary sm" onClick={onOpen}>Details</button>
          {a.status === 'PENDING' && (
            <>
              <button className="btn success sm" onClick={() => onDecide({ approval: a, decision: 'APPROVED' })}>Approve</button>
              <button className="btn danger sm" onClick={() => onDecide({ approval: a, decision: 'REJECTED' })}>Reject…</button>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

function entityLabel(a) {
  const t = String(a.entity_type || 'approval').replaceAll('_', ' ');
  const p = a.payload || {};
  return `${t}${p.request_no ? ` ${p.request_no}` : ''}${p.plate ? ` · ${p.plate}` : ''}`;
}

function KV({ k, v }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
      <span className="muted" style={{ textTransform: 'capitalize' }}>{k}</span>
      <b style={{ textAlign: 'right' }}>{v}</b>
    </div>
  );
}
