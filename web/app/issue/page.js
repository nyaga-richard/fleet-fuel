'use client';
// Issue Fuel — dispensing happens against an APPROVED request only.
// Shows the authorized quantity; exceeding it warns immediately (the server
// enforces the excess-approval workflow — the UI never bypasses it).
import { useCallback, useEffect, useMemo, useState } from 'react';
import Shell from '@/components/Shell';
import { Card, PageHeader, SearchInput, Notice, useForm, Field, DataTable, StatusPill, Skeleton, ConfirmDialog, Select, SearchableSelect, ExportMenu } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtQty, fmtDateTime } from '@/lib/format';

export default function IssuePage() {
  return <Shell><Issue /></Shell>;
}

function Issue() {
  const { user } = useAuth();
  const canReverse = user?.role === 'admin' || user?.role === 'manager';

  const [approved, setApproved] = useState(null);
  const [txns, setTxns] = useState(null);
  const [pumps, setPumps] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [fVehicle, setFVehicle] = useState('');
  const [fFrom, setFFrom] = useState('');
  const [fTo, setFTo] = useState('');
  const [reverseTarget, setReverseTarget] = useState(null);
  const { form, bind, setForm } = useForm({ request_id: '', pump_id: '', quantity: '', unit_price: '', odometer: '', pump_reading: '', lpo_no: '' });

  const loadTxns = useCallback(async (from, to, vehicleId) => {
    const p = new URLSearchParams();
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (vehicleId) p.set('vehicle_id', vehicleId);
    p.set('limit', '500');
    const t = await api(`/api/transactions?${p.toString()}`);
    setTxns(t.transactions);
  }, []);

  const load = useCallback(async () => {
    setError('');
    try {
      const [r, t, p, v] = await Promise.all([
        api('/api/requests?status=approved&limit=100'),
        api('/api/transactions?limit=500'),
        api('/api/pumps'),
        api('/api/vehicles?active=true'),
      ]);
      setApproved(r.requests);
      setTxns(t.transactions);
      setPumps(p.pumps);
      setVehicles(v.vehicles);
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Deep link: /issue?request=<id> — coming from a request's details panel.
  useEffect(() => {
    if (!approved) return;
    const id = new URLSearchParams(window.location.search).get('request');
    if (id && approved.some((r) => r.id === id)) {
      const req = approved.find((r) => r.id === id);
      setForm((f) => ({ ...f, request_id: id, quantity: String(req.quantity) }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approved]);

  const selected = useMemo(() => (approved || []).find((r) => r.id === form.request_id), [approved, form.request_id]);
  const excess = selected && form.quantity !== '' && Number(form.quantity) > Number(selected.quantity);

  async function issue(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      const body = {
        request_id: form.request_id,
        pump_id: form.pump_id || undefined,
        quantity: Number(form.quantity),
        unit_price: form.unit_price ? Number(form.unit_price) : undefined,
        odometer: form.odometer ? Number(form.odometer) : undefined,
        pump_reading: form.pump_reading ? Number(form.pump_reading) : undefined,
        lpo_no: form.lpo_no?.trim() || undefined,
      };
      const res = await api('/api/transactions/issue', { method: 'POST', body });
      setNotice(`Fuel issued — transaction ${res.transaction.txn_no}. Ledger balance: ${Number(res.transaction.balance_after).toLocaleString()} L`);
      setForm({ request_id: '', pump_id: '', quantity: '', unit_price: '', odometer: '', pump_reading: '', lpo_no: '' });
      window.history.replaceState(null, '', '/issue');
      await load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function doReverse() {
    const reason = window.prompt('Reversal reason (required, audited):');
    if (!reason || !reason.trim()) return;
    setBusy(true); setError('');
    try {
      await api(`/api/transactions/${reverseTarget}/reverse`, { method: 'POST', body: { reason: reason.trim() } });
      setNotice('Transaction reversed — stock restored via compensating ledger entry.');
      setReverseTarget(null);
      load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  const filteredTxns = useMemo(() => {
    if (!txns) return [];
    const term = q.trim().toLowerCase();
    const m = (s) => String(s ?? '').toLowerCase().includes(term);
    return txns.filter((r) => !term || m(r.txn_no) || m(r.plate) || m(r.request_no) || m(r.operator_name));
  }, [txns, q]);

  return (
    <>
      <PageHeader title="Issue Fuel" subtitle="Dispensing posts an immutable ledger entry and marks the request issued" />

      {error && <Notice kind="error" onDone={() => setError('')}>{error}</Notice>}
      {notice && <Notice kind="success" onDone={() => setNotice('')}>{notice}</Notice>}

      <Card title="Dispense fuel against an approved request">
        {!approved ? <Skeleton lines={4} /> : approved.length === 0 ? (
          <div className="msg info">No approved requests waiting. Approve a request first — see Fuel Requests.</div>
        ) : (
          <form onSubmit={issue} className="grid c3">
            <Field label="Approved request *">
              <SearchableSelect value={form.request_id} required placeholder="Select request…"
                onChange={(v) => {
                  const req = approved.find((r) => r.id === v);
                  setForm((f) => ({ ...f, request_id: v, quantity: req ? String(req.quantity) : f.quantity }));
                }}
                options={approved.map((r) => ({ value: r.id, label: `${r.request_no} · ${r.plate}`, sub: `${fmtQty(r.quantity, '')} ${r.fuel_type_name}` }))} />
            </Field>
            <Field label="Pump *">
              <SearchableSelect {...bind('pump_id')} required placeholder="Select pump…"
                options={pumps.filter((p) => p.active).map((p) => ({ value: p.id, label: p.name, sub: p.fuel_type_name || '' }))} />
            </Field>
            <Field
              label="Quantity (L) *"
              hint={selected ? `Authorized: ${fmtQty(selected.quantity)}` : 'Pick a request to see its authorized quantity'}
            >
              <input type="number" inputMode="decimal" step="0.01" min="0.01" {...bind('quantity')} required style={excess ? { borderColor: 'var(--amber)' } : undefined} />
            </Field>
            <Field label="Odometer (km)">
              <input type="number" inputMode="numeric" step="0.1" min="0" {...bind('odometer')} />
            </Field>
            <Field label="Pump meter reading">
              <input type="number" inputMode="decimal" step="0.01" min="0" {...bind('pump_reading')} placeholder="closing scale" />
            </Field>
            <Field label="Unit price (KES)">
              <input type="number" inputMode="decimal" step="0.01" min="0" {...bind('unit_price')} />
            </Field>
            <Field label="LPO No" hint="Customer Local Purchase Order reference (optional)">
              <input {...bind('lpo_no')} placeholder="e.g. LPO/2026/00421" />
            </Field>
            <div style={{ gridColumn: '1 / -1' }}>
              {excess && (
                <div className="msg error" role="alert">
                  ⚠ Authorized: {fmtQty(selected?.quantity)} — you entered {fmtQty(form.quantity)}. Excess fuel requires manager approval.
                </div>
              )}
              <button className="btn" disabled={busy || !approved.length || !form.request_id}>{busy ? 'Issuing…' : 'Issue fuel'}</button>
              <span className="muted" style={{ marginLeft: 10, fontSize: 12 }}>
                Posts an immutable fuel-ledger entry and marks the request issued.
              </span>
            </div>
          </form>
        )}
      </Card>

      <Card
        title="Fuel transactions"
        actions={(
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <SearchInput value={q} onChange={setQ} placeholder="Search txn, plate, operator…" />
            <ExportMenu
              report="fuel-transactions"
              params={{ ...(fFrom ? { from: fFrom } : {}), ...(fTo ? { to: fTo } : {}), ...(fVehicle ? { vehicle_id: fVehicle } : {}) }}
            />
          </div>
        )}
      >
        <div className="grid c3" style={{ marginBottom: 12 }}>
          <Field label="From date">
            <input type="date" value={fFrom} onChange={(e) => { setFFrom(e.target.value); loadTxns(e.target.value, fTo, fVehicle).catch((er) => setError(er.message)); }} />
          </Field>
          <Field label="To date">
            <input type="date" value={fTo} onChange={(e) => { setFTo(e.target.value); loadTxns(fFrom, e.target.value, fVehicle).catch((er) => setError(er.message)); }} />
          </Field>
          <Field label="Vehicle">
            <SearchableSelect value={fVehicle}
              onChange={(v) => { setFVehicle(v); loadTxns(fFrom, fTo, v).catch((er) => setError(er.message)); }}
              placeholder="All vehicles"
              options={vehicles.map((v) => ({ value: v.id, label: v.plate, sub: [v.make, v.model].filter(Boolean).join(' ') }))} />
          </Field>
        </div>

        {!txns ? <Skeleton lines={6} /> : (
          <DataTable
            columns={[
              { key: 'txn_no', label: 'Txn' },
              { key: 'created_at', label: 'Date', render: (r) => fmtDateTime(r.created_at) },
              { key: 'request_no', label: 'Request', render: (r) => r.request_no || '—' },
              { key: 'lpo_no', label: 'LPO No', render: (r) => r.lpo_no || '—' },
              { key: 'plate', label: 'Vehicle' },
              { key: 'fuel_type_name', label: 'Fuel' },
              { key: 'quantity', label: 'Qty', num: true, render: (r) => fmtQty(r.quantity) },
              { key: 'operator_name', label: 'Operator', render: (r) => r.operator_name || '—' },
              { key: 'status', label: 'Status', render: (r) => <StatusPill status={r.status} /> },
              {
                key: 'actions', label: '', render: (r) => (
                  canReverse && r.status === 'completed' && !r.reversal_of ? (
                    <button className="btn secondary sm" onClick={(ev) => { ev.stopPropagation(); setReverseTarget(r.id); }}>Reverse</button>
                  ) : null
                ),
              },
            ]}
            rows={filteredTxns}
            mobileCard={(r) => (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                  <b className="mono">{r.txn_no}</b>
                  <StatusPill status={r.status} />
                </div>
                <div style={{ margin: '5px 0 3px', fontWeight: 600 }}>{r.plate} · {fmtQty(r.quantity)} {r.fuel_type_name}</div>
                <div className="muted" style={{ fontSize: 12 }}>{r.request_no || '—'} · {r.operator_name || '—'} · {fmtDateTime(r.created_at)}</div>
              </>
            )}
            empty={q ? `No transactions match “${q}”` : 'No fuel issued yet'}
          />
        )}
      </Card>

      <ConfirmDialog
        open={!!reverseTarget}
        title="Reverse this transaction?"
        message="A compensating ledger entry restores the stock. The original entry stays in the ledger — reversals are never deletions."
        confirmLabel="Reverse transaction"
        danger
        busy={busy}
        onConfirm={doReverse}
        onCancel={() => setReverseTarget(null)}
      />
    </>
  );
}
