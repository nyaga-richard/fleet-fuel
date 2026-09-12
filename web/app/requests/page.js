'use client';
// Fuel Requests — search → tap a request → details panel → decide / issue.
// Attendants can create and track requests; only admin/manager can approve.
import { useCallback, useEffect, useMemo, useState } from 'react';
import Shell from '@/components/Shell';
import { Card, PageHeader, SearchInput, Tabs, Notice, useForm, Field, DataTable, Drawer, ConfirmDialog, StatusPill, Skeleton, EmptyState } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtQty, fmtDateTime } from '@/lib/format';

export default function RequestsPage() {
  return <Shell><Requests /></Shell>;
}

const EMPTY_FORM = { vehicle_id: '', fuel_type_id: '', quantity: '', driver_name: '', destination: '', notes: '' };

function Requests() {
  const { user } = useAuth();
  const canDecide = user?.role === 'admin' || user?.role === 'manager';
  const canCreate = ['admin', 'manager', 'attendant'].includes(user?.role);

  const [tab, setTab] = useState('pending');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState(null);
  const [refs, setRefs] = useState({ vehicles: [], fuel_types: [] });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState(null);      // full request shown in the drawer
  const [confirm, setConfirm] = useState(null);    // {action, id, label}
  const { form, bind, setForm } = useForm(EMPTY_FORM);

  const load = useCallback(async () => {
    setError('');
    try {
      const [r, v, f] = await Promise.all([
        api(`/api/requests?status=${tab}&limit=500`),
        api('/api/vehicles?active=true'),
        api('/api/fuel-types'),
      ]);
      setRows(r.requests);
      setRefs({ vehicles: v.vehicles, fuel_types: f.fuel_types });
    } catch (e) { setError(e.message); }
  }, [tab]);

  useEffect(() => { load(); }, [load]);

  // Deep link (?focus=<id>) — open that request's details.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('focus');
    if (id) openDetailsById(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // GET /api/requests/:id returns { request, authorizations } — unwrap it.
  function applyDetail(res, fallback = null) {
    if (!res || !(res.request || res.id)) { setDetail(fallback); return; }
    setDetail({ ...(res.request || res), authorizations: res.authorizations || [] });
  }

  async function openDetailsById(id) {
    try { applyDetail(await api(`/api/requests/${id}`), (rows || []).find((r) => r.id === id) || null); }
    catch { setDetail((rows || []).find((r) => r.id === id) || null); }
  }

  async function openDetails(row) {
    setDetail(row);
    try { applyDetail(await api(`/api/requests/${row.id}`), row); } catch { /* row data is enough */ }
  }

  async function refreshDetail(id) {
    try { applyDetail(await api(`/api/requests/${id}`)); } catch { setDetail(null); }
  }

  async function createRequest(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await api('/api/requests', { method: 'POST', body: { ...form, quantity: Number(form.quantity) } });
      setNotice('Fuel request created and pending authorization.');
      setShowForm(false);
      setForm(EMPTY_FORM);
      load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function decide(id, decision) {
    setBusy(true); setError('');
    try {
      const res = await api(`/api/requests/${id}/${decision}`, { method: 'POST', body: {} });
      setNotice(decision === 'approve' ? 'Request authorized.' : 'Request rejected.');
      setConfirm(null);
      setDetail(res.request || null); // keep the drawer open with the new status
      load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function cancel(id) {
    setBusy(true); setError('');
    try {
      const res = await api(`/api/requests/${id}/cancel`, { method: 'POST', body: {} });
      setNotice('Request cancelled.');
      setConfirm(null);
      setDetail(res.request || null);
      load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  // Client-side free-text filter on top of the server status filter (the
  // requests API filters by status/vehicle; free text is filtered here).
  const filtered = useMemo(() => {
    if (!rows) return [];
    const term = q.trim().toLowerCase();
    if (!term) return rows;
    const m = (s) => String(s ?? '').toLowerCase().includes(term);
    return rows.filter((r) => m(r.request_no) || m(r.plate) || m(r.driver_name) || m(r.fuel_type_name) || m(r.status) || m(r.requested_by_name) || m(r.destination));
  }, [rows, q]);

  const counts = useMemo(() => ({
    pending: tab === 'pending' ? filtered.filter((r) => r.status === 'pending').length : undefined,
  }), [filtered, tab]);

  return (
    <>
      <PageHeader
        title="Fuel Requests"
        subtitle="Create, authorize and track fuel requests — every decision is audited"
        actions={canCreate && (
          <button className="btn" onClick={() => setShowForm(!showForm)}>{showForm ? 'Close form' : '+ New request'}</button>
        )}
      />

      {error && <Notice kind="error" onDone={() => setError('')}>{error}</Notice>}
      {notice && <Notice kind="success" onDone={() => setNotice('')}>{notice}</Notice>}

      {showForm && (
        <Card title="New fuel request">
          <form onSubmit={createRequest} className="grid c3">
            <Field label="Vehicle *">
              <select {...bind('vehicle_id')} required>
                <option value="">Select vehicle…</option>
                {refs.vehicles.map((v) => <option key={v.id} value={v.id}>{v.plate} {v.make ? `· ${v.make} ${v.model || ''}` : ''}</option>)}
              </select>
            </Field>
            <Field label="Fuel type *">
              <select {...bind('fuel_type_id')} required>
                <option value="">Select fuel…</option>
                {refs.fuel_types.filter((f) => f.active).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </Field>
            <Field label="Quantity (L) *" hint={`Authorized quantity is confirmed at approval`}>
              <input type="number" inputMode="decimal" step="0.01" min="0.01" {...bind('quantity')} required />
            </Field>
            <Field label="Driver"><input {...bind('driver_name')} placeholder="auto from vehicle" /></Field>
            <Field label="Destination"><input {...bind('destination')} /></Field>
            <Field label="Notes"><input {...bind('notes')} /></Field>
            <div style={{ gridColumn: '1 / -1' }}>
              <button className="btn" disabled={busy}>{busy ? 'Submitting…' : 'Submit request'}</button>
            </div>
          </form>
        </Card>
      )}

      <Card
        title="Requests"
        actions={<SearchInput value={q} onChange={setQ} placeholder="Search no., plate, driver, status…" />}
      >
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'pending', label: 'Pending' },
            { value: 'approved', label: 'Approved' },
            { value: 'issued', label: 'Issued' },
            { value: 'rejected', label: 'Rejected' },
            { value: 'all', label: 'All' },
          ]}
        />

        {!rows ? <Skeleton lines={6} /> : (
          <DataTable
            columns={[
              { key: 'request_no', label: 'Request' },
              { key: 'created_at', label: 'Date', render: (r) => fmtDateTime(r.created_at) },
              { key: 'plate', label: 'Vehicle' },
              { key: 'fuel_type_name', label: 'Fuel' },
              { key: 'quantity', label: 'Quantity', num: true, render: (r) => fmtQty(r.quantity) },
              { key: 'destination', label: 'Destination', render: (r) => r.destination || '—' },
              { key: 'requested_by_name', label: 'Requested by', render: (r) => r.requested_by_name || '—' },
              { key: 'status', label: 'Status', render: (r) => <StatusPill status={r.status} /> },
            ]}
            rows={filtered}
            onRowClick={openDetails}
            mobileCard={(r) => (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                  <b className="mono">{r.request_no || '—'}</b>
                  <StatusPill status={r.status} />
                </div>
                <div style={{ margin: '5px 0 3px', fontWeight: 600 }}>{r.plate} · {fmtQty(r.quantity)} {r.fuel_type_name}</div>
                <div className="muted" style={{ fontSize: 12 }}>{r.driver_name || '—'} · {fmtDateTime(r.created_at)}</div>
              </>
            )}
            empty={q ? `No requests match “${q}”` : tab === 'pending' ? 'No pending requests — all clear' : 'No requests in this view'}
          />
        )}
      </Card>

      {/* Request details — the single place to decide / issue from */}
      <Drawer
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail?.request_no || 'Request'}
        subtitle={detail ? `${detail.plate || ''} · ${detail.status?.toUpperCase()}` : ''}
        footer={detail && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {canDecide && detail.status === 'pending' && (
              <>
                <button className="btn success" onClick={() => setConfirm({ action: 'approve', id: detail.id, label: 'Authorize this request?' })}>Approve</button>
                <button className="btn danger" onClick={() => setConfirm({ action: 'reject', id: detail.id, label: 'Reject this request?' })}>Reject</button>
              </>
            )}
            {detail.status === 'pending' && (detail.requested_by === user?.id || user?.role === 'admin') && (
              <button className="btn secondary" onClick={() => setConfirm({ action: 'cancel', id: detail.id, label: 'Cancel this request?' })}>Cancel request</button>
            )}
            {detail.status === 'approved' && ['admin', 'manager', 'attendant'].includes(user?.role) && (
              <a className="btn" href={`/issue?request=${detail.id}`}>Issue fuel →</a>
            )}
            {detail.status === 'issued' && <span className="muted">Fuel issued — see Fuel Ledger for the entry.</span>}
          </div>
        )}
      >
        {detail ? <><RequestDetail d={detail} /><AuthorizationTrail items={detail.authorizations} /></> : <Skeleton lines={5} />}
      </Drawer>

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.label || ''}
        message="This action is recorded in the audit trail."
        confirmLabel={confirm?.action === 'approve' ? 'Authorize' : confirm?.action === 'reject' ? 'Reject' : 'Cancel request'}
        danger={confirm?.action !== 'approve'}
        busy={busy}
        onConfirm={() => confirm && (confirm.action === 'cancel' ? cancel(confirm.id) : decide(confirm.id, confirm.action))}
        onCancel={() => setConfirm(null)}
      />
    </>
  );
}

function RequestDetail({ d }) {
  return (
    <div className="kv">
      <span className="k">Status</span><span className="v"><StatusPill status={d.status} /></span>
      <span className="k">Request no.</span><span className="v mono">{d.request_no || '—'}</span>
      <span className="k">Created</span><span className="v">{fmtDateTime(d.created_at)}</span>
      <span className="k">Requested by</span><span className="v">{d.requested_by_name || '—'}</span>
      <span className="k">Vehicle</span><span className="v">{d.plate || '—'}{d.make ? ` · ${d.make} ${d.model || ''}` : ''}</span>
      <span className="k">Fuel type</span><span className="v">{d.fuel_type_name || '—'}</span>
      <span className="k">Quantity requested</span><span className="v"><b>{fmtQty(d.quantity)}</b></span>
      <span className="k">Driver</span><span className="v">{d.driver_name || '—'}</span>
      <span className="k">Destination</span><span className="v">{d.destination || '—'}</span>
      <span className="k">Notes</span><span className="v">{d.notes || '—'}</span>
      <span className="k">Authorized by</span><span className="v">{d.authorized_by_name || '—'}</span>
      <span className="k">Authorized at</span><span className="v">{d.authorized_at ? fmtDateTime(d.authorized_at) : '—'}</span>
    </div>
  );
}

function AuthorizationTrail({ items }) {
  if (!items || items.length === 0) return null;
  return (
    <>
      <h3 style={{ margin: '18px 0 8px', fontSize: 13.5 }}>Authorization history</h3>
      {items.map((a, i) => (
        <div key={a.id ?? i} className="muted" style={{ fontSize: 12.5, padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
          {a.decided_by_name || '—'} · {String(a.action || a.decision || '').toUpperCase() || 'decided'} · {fmtDateTime(a.decided_at)}
          {a.comments ? ` — "${a.comments}"` : ''}
        </div>
      ))}
    </>
  );
}
