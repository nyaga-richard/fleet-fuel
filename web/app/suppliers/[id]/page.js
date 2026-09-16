'use client';
// Supplier detail (§21–§28) — account dashboard, ledger with running balance
// and drill-down, purchases, adjustments (opening/debit/credit note), payments
// with multi-invoice allocation, reversals, statement export.
//
// Ledger convention (§19/§46): DEBIT increases payable, CREDIT decreases.
// Entries are append-only; corrections happen through reversals (§26).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Shell from '@/components/Shell';
import { Card, PageHeader, DataTable, StatusPill, Notice, Skeleton, Field, Drawer, Stat, ExportMenu, SearchableSelect, ConfirmDialog, EmptyState } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtKES, fmtDate, fmtDateTime } from '@/lib/format';

const ENTRY_TYPES = [
  { value: 'OPENING', label: 'Opening balance' },
  { value: 'DEBIT_ADJUSTMENT', label: 'Debit adjustment' },
  { value: 'CREDIT_NOTE', label: 'Credit note' },
];
const PAY_METHODS = [
  { value: 'CASH', label: 'Cash' },
  { value: 'BANK_TRANSFER', label: 'Bank transfer' },
  { value: 'CHEQUE', label: 'Cheque' },
  { value: 'MOBILE_MONEY', label: 'Mobile money' },
  { value: 'CARD', label: 'Card' },
  { value: 'OTHER', label: 'Other' },
];
const PURCHASE_SOURCES = [
  { value: 'FUEL', label: 'Fuel' },
  { value: 'TIRE', label: 'Tires' },
  { value: 'RETREAD', label: 'Retread' },
  { value: 'PARTS', label: 'Parts' },
  { value: 'SERVICE', label: 'Service' },
  { value: 'OTHER', label: 'Other' },
];

export default function SupplierDetailPage() {
  return <Shell><SupplierDetail /></Shell>;
}

function SupplierDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const canPay = user?.role === 'admin' || user?.role === 'manager';
  const [supplier, setSupplier] = useState(null);
  const [account, setAccount] = useState(null);
  const [ledger, setLedger] = useState(null);
  const [range, setRange] = useState({ from: '', to: '' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [drawer, setDrawer] = useState(null); // 'purchase' | 'adjustment' | 'payment'
  const [drill, setDrill] = useState(null);   // ledger entry
  const [reverse, setReverse] = useState(null); // payment entry
  const [busy, setBusy] = useState(false);

  const loadLedger = useCallback((r = range) => {
    const p = new URLSearchParams();
    if (r.from) p.set('from', r.from);
    if (r.to) p.set('to', r.to);
    return api(`/api/suppliers/${id}/ledger?${p.toString()}`).then((d) => setLedger(d));
  }, [id, range]);

  const load = useCallback(() => {
    api(`/api/suppliers/${id}`).then((d) => { setSupplier(d.supplier); setAccount(d.account); }).catch((e) => setError(e.message));
    loadLedger().catch((e) => setError(e.message));
  }, [id, loadLedger]);
  useEffect(() => { load(); }, [load]);

  function onRange(next) { setRange(next); loadLedger(next).catch((e) => setError(e.message)); }

  const entryColumns = useMemo(() => [
    { key: 'entry_date', label: 'Date', render: (r) => fmtDate(r.entry_date ?? r.transaction_date) },
    { key: 'entry_no', label: 'Ref', render: (r) => <b>{r.reference || '—'}</b> },
    { key: 'entry_type', label: 'Type', render: (r) => <span style={{ fontSize: 12 }}>{String(r.entry_type || '').replaceAll('_', ' ')}</span> },
    { key: 'description', label: 'Description', render: (r) => <span style={{ fontSize: 12.5 }}>{r.description || '—'}</span> },
    { key: 'debit', label: 'Debit', render: (r) => Number(r.debit) ? fmtKES(r.debit) : '' },
    { key: 'credit', label: 'Credit', render: (r) => Number(r.credit) ? fmtKES(r.credit) : '' },
    { key: 'balance', label: 'Balance', render: (r) => <b>{fmtKES(r.balance)}</b> },
    { key: 'alloc', label: 'Allocated', render: (r) => (r.entry_type === 'PAYMENT' && Number(r.credit) > 0
      ? <span style={{ fontSize: 11.5 }} className="muted">{fmtKES(r.allocated ?? 0)} of {fmtKES(r.credit)} · unallocated {fmtKES(Math.max(0, Number(r.credit) - Number(r.allocated || 0)))}</span> : '') },
    { key: 'actions', label: '', render: (r) => (
      r.entry_type === 'PAYMENT' && canPay && (
        <button className="btn secondary sm" onClick={() => setReverse(r)}>Reverse</button>
      )
    )},
  ], [canPay]);

  if (!supplier && !error) return <Skeleton />;

  return (
    <>
      <PageHeader
        title={supplier?.name || 'Supplier'}
        subtitle={`Ledger — Debit increases payable · Credit decreases. Append-only; corrections via reversal.`}
        actions={canPay && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <ExportMenu report="supplier-statement" params={{ supplier_id: id, ...(range.from ? { from: range.from } : {}), ...(range.to ? { to: range.to } : {}) }} />
            <button className="btn secondary" onClick={() => setDrawer('purchase')}>+ Purchase</button>
            <button className="btn secondary" onClick={() => setDrawer('adjustment')}>+ Adjustment</button>
            <button className="btn" onClick={() => setDrawer('payment')}>Record payment</button>
          </div>
        )}
      />
      {error && <Notice kind="error" onDone={() => setError('')}>{error}</Notice>}
      {notice && <Notice kind="success" onDone={() => setNotice('')}>{notice}</Notice>}

      {account && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginBottom: 14 }}>
          <Stat label="Current balance" value={fmtKES(account.current_balance)} sub={Number(account.current_balance) > 0 ? 'Payable to supplier' : 'No balance owed'} />
          <Stat label="Outstanding invoices" value={String(account.outstanding_invoices ?? 0)} sub={fmtKES(account.outstanding_amount || 0)} />
          {account.credit_limit != null && (
            <Stat label="Credit limit" value={fmtKES(account.credit_limit)} sub={`Available ${fmtKES(account.available_credit || 0)}`} />
          )}
          <Stat label="Total purchases" value={fmtKES(account.totals?.purchases || 0)} sub={`Payments ${fmtKES(account.totals?.payments || 0)}`} />
        </div>
      )}

      <Card
        title="Ledger"
        actions={(
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input type="date" value={range.from} onChange={(e) => onRange({ ...range, from: e.target.value })} aria-label="From date" />
            <input type="date" value={range.to} onChange={(e) => onRange({ ...range, to: e.target.value })} aria-label="To date" />
          </div>
        )}
      >
        {ledger && (
          <div style={{ display: 'flex', gap: 16, marginBottom: 10, fontSize: 12.5 }} className="muted">
            <span>Opening balance <b style={{ color: 'var(--text)' }}>{fmtKES(ledger.opening_balance)}</b></span>
            <span>Closing balance <b style={{ color: 'var(--text)' }}>{fmtKES(ledger.closing_balance)}</b></span>
          </div>
        )}
        {ledger?.entries?.length
          ? <DataTable columns={entryColumns} rows={ledger.entries} onRowClick={setDrill} pageSize={15} />
          : <EmptyState title="No ledger entries" message="Record an opening balance or the first purchase to start the ledger." />}
      </Card>

      {drawer === 'purchase' && (
        <PurchaseDrawer id={id} supplier={supplier} busy={busy} setBusy={setBusy}
          onClose={() => setDrawer(null)} onDone={(m) => { setNotice(m); setDrawer(null); load(); }} setError={setError} />
      )}
      {drawer === 'adjustment' && (
        <AdjustmentDrawer id={id} busy={busy} setBusy={setBusy}
          onClose={() => setDrawer(null)} onDone={(m) => { setNotice(m); setDrawer(null); load(); }} setError={setError} />
      )}
      {drawer === 'payment' && (
        <PaymentDrawer id={id} busy={busy} setBusy={setBusy}
          onClose={() => setDrawer(null)} onDone={(m) => { setNotice(m); setDrawer(null); load(); }} setError={setError} />
      )}

      {/* Ledger drill-down (§21) */}
      <Drawer open={!!drill} onClose={() => setDrill(null)} title={drill?.reference || 'Ledger entry'} subtitle={drill ? fmtDateTime(drill.created_at) : ''} width={430}>
        {drill && (
          <div style={{ display: 'grid', gap: 8, fontSize: 13 }}>
            <Row k="Type" v={String(drill.entry_type || '').replaceAll('_', ' ')} />
            <Row k="Date" v={fmtDate(drill.entry_date ?? drill.transaction_date)} />
            {drill.description && <Row k="Description" v={drill.description} />}
            {drill.reference && <Row k="Reference" v={drill.reference} />}
            <Row k="Debit" v={Number(drill.debit) ? fmtKES(drill.debit) : '—'} />
            <Row k="Credit" v={Number(drill.credit) ? fmtKES(drill.credit) : '—'} />
            <Row k="Running balance" v={fmtKES(drill.balance)} />
            {drill.entry_type === 'PAYMENT' && (
              <>
                <Row k="Allocated" v={fmtKES(drill.allocated ?? 0)} />
                <Row k="Unallocated (supplier credit)" v={fmtKES(drill.unallocated ?? Math.max(0, Number(drill.amount || 0) - Number(drill.allocated || 0)))} />
                {drill.reference && <Row k="Reference" v={drill.reference} />}
              </>
            )}
            {/* §20 — source document link */}
            {drill.source_table && (
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                <Row k="Source" v={`${String(drill.source_table)} · ${(drill.source_id || '').slice(0, 8)}…`} />
              </div>
            )}
          </div>
        )}
      </Drawer>

      <ConfirmDialog
        open={!!reverse}
        title={`Reverse payment ${reverse?.entry_no || ''}?`}
        message="A reversal adds an opposite debit entry. The original payment is never deleted — history stays intact (§26)."
        confirmLabel="Reverse payment" danger busy={busy}
        onConfirm={async () => {
          setBusy(true); setError('');
          try {
            await api(`/api/suppliers/payments/${reverse.source_id || reverse.payment_id || reverse.id}/reverse`, {
              method: 'POST', body: { reason: 'Reversed from supplier ledger' },
            });
            setNotice('Payment reversed. The ledger shows both the original entry and the reversal.');
            setReverse(null); load();
          } catch (e) { setError(e.message); } finally { setBusy(false); }
        }}
        onCancel={() => setReverse(null)}
      />
    </>
  );
}

function Row({ k, v }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
    <span className="muted">{k}</span><b style={{ textAlign: 'right' }}>{v}</b>
  </div>;
}

// ── Record purchase (§23) ────────────────────────────────────────────────────
function PurchaseDrawer({ id, busy, setBusy, onClose, onDone, setError }) {
  const { form, bind, setForm } = useForm({ amount: '', source_type: 'FUEL', reference: '', description: '', entry_date: '' });
  useEffect(() => { setForm((f) => ({ ...f, entry_date: new Date().toISOString().slice(0, 10) })); }, []); // eslint-disable-line
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const r = await api(`/api/suppliers/${id}/purchases`, {
        method: 'POST',
        body: { ...form, amount: Number(form.amount), entry_date: form.entry_date || undefined },
      });
      onDone(`Purchase ${r.entry?.reference || ''} recorded — ${fmtKES(form.amount)} debited.`);
    } catch (e2) { setError(e2.message); } finally { setBusy(false); }
  }
  return (
    <Drawer open onClose={onClose} title="Record purchase" subtitle="Debits the supplier account (payable increases)"
      footer={<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn secondary" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={busy || !form.amount} onClick={submit}>{busy ? 'Saving…' : 'Record purchase'}</button>
      </div>}>
      <form onSubmit={submit}>
        <Field label="Amount (KES) *"><input {...bind('amount')} type="number" min="0.01" step="0.01" required /></Field>
        <Field label="What was purchased">
          <SearchableSelect value={form.source_type} onChange={(v) => setForm((f) => ({ ...f, source_type: v }))} options={PURCHASE_SOURCES} />
        </Field>
        <Field label="Invoice / reference"><input {...bind('reference')} placeholder="INV-1001" /></Field>
        <Field label="Description"><input {...bind('description')} placeholder="Tire purchase" /></Field>
        <Field label="Date"><input {...bind('entry_date')} type="date" required /></Field>
      </form>
    </Drawer>
  );
}

// ── Adjustment: opening balance / debit / credit note (§18, §24) ────────────
function AdjustmentDrawer({ id, busy, setBusy, onClose, onDone, setError }) {
  const { form, bind, setForm } = useForm({ entry_type: 'OPENING', amount: '', reason: '', entry_date: '' });
  useEffect(() => { setForm((f) => ({ ...f, entry_date: new Date().toISOString().slice(0, 10) })); }, []); // eslint-disable-line
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const r = await api(`/api/suppliers/${id}/adjustments`, {
        method: 'POST', body: { ...form, amount: Number(form.amount), entry_date: form.entry_date || undefined },
      });
      onDone(`Adjustment ${r.adjustment?.adjustment_no || r.adjustment?.reference || ''} recorded.`);
    } catch (e2) { setError(e2.message); } finally { setBusy(false); }
  }
  return (
    <Drawer open onClose={onClose} title="Ledger adjustment"
      subtitle="Opening balance & debit adjustments increase payable · credit notes decrease it"
      footer={<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn secondary" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={busy || !form.amount || !form.reason} onClick={submit}>{busy ? 'Saving…' : 'Record adjustment'}</button>
      </div>}>
      <form onSubmit={submit}>
        <Field label="Type">
          <SearchableSelect value={form.entry_type} onChange={(v) => setForm((f) => ({ ...f, entry_type: v }))} options={ENTRY_TYPES} />
        </Field>
        <Field label="Amount (KES) *"><input {...bind('amount')} type="number" min="0.01" step="0.01" required /></Field>
        <Field label="Reason *" hint="Required for audit — e.g. Opening balance c/f, supplier discount note"><input {...bind('reason')} required /></Field>
        <Field label="Date"><input {...bind('entry_date')} type="date" required /></Field>
      </form>
    </Drawer>
  );
}

// ── Payment with multi-invoice allocation (§24–§26) ─────────────────────────
function PaymentDrawer({ id, busy, setBusy, onClose, onDone, setError }) {
  const [outstanding, setOutstanding] = useState([]);
  const { form, bind, setForm } = useForm({ amount: '', payment_method: 'BANK_TRANSFER', bank: '', reference: '', payment_date: '' });
  const [allocs, setAllocs] = useState({}); // ledger_entry_id → amount string
  useEffect(() => {
    setForm((f) => ({ ...f, payment_date: new Date().toISOString().slice(0, 10) }));
    api(`/api/suppliers/${id}/outstanding`).then((d) => setOutstanding(d.invoices || d.outstanding || [])).catch(() => {});
  }, [id, setForm]); // eslint-disable-line

  const total = Number(form.amount) || 0;
  const allocated = Object.values(allocs).reduce((s, v) => s + (Number(v) || 0), 0);
  const unallocated = total - allocated;

  function setAlloc(entryId, val) {
    setAllocs((a) => {
      const next = { ...a, [entryId]: val };
      if (val === '') delete next[entryId];
      return next;
    });
  }

  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const allocations = Object.entries(allocs)
        .filter(([, v]) => Number(v) > 0)
        .map(([ledger_entry_id, v]) => ({ ledger_entry_id, amount: Number(v) }));
      const r = await api(`/api/suppliers/${id}/payments`, {
        method: 'POST',
        body: {
          amount: total, payment_method: form.payment_method, bank: form.bank || undefined,
          reference: form.reference || undefined, payment_date: form.payment_date || undefined,
          allocations,
        },
      });
      const un = r.payment?.unallocated ?? 0;
      onDone(`Payment ${r.payment?.payment_no || ''} recorded.${un > 0 ? ` ${fmtKES(un)} remains as unallocated supplier credit.` : ''}`);
    } catch (e2) { setError(e2.message); } finally { setBusy(false); }
  }

  return (
    <Drawer open onClose={onClose} title="Record payment" subtitle="Allocate across invoices — anything left stays as unallocated supplier credit" width={540}
      footer={<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn secondary" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={busy || total <= 0 || allocated > total} onClick={submit}>{busy ? 'Saving…' : 'Record payment'}</button>
      </div>}>
      <form onSubmit={submit}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Amount (KES) *"><input {...bind('amount')} type="number" min="0.01" step="0.01" required /></Field>
          <Field label="Date"><input {...bind('payment_date')} type="date" required /></Field>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Method">
            <SearchableSelect value={form.payment_method} onChange={(v) => setForm((f) => ({ ...f, payment_method: v }))} options={PAY_METHODS} />
          </Field>
          <Field label="Bank / reference"><input {...bind('bank')} placeholder="KCB" /></Field>
        </div>
        <Field label="Transaction / cheque no."><input {...bind('reference')} placeholder="TRX-456891" /></Field>

        <h4 style={{ margin: '14px 0 6px', fontSize: 13 }}>Allocate to invoices</h4>
        {outstanding.length === 0 && <p className="muted" style={{ fontSize: 12.5 }}>No outstanding invoices — the full amount will be unallocated supplier credit.</p>}
        {outstanding.map((inv) => {
          const a = Number(allocs[inv.id] ?? allocs[inv.ledger_entry_id] ?? 0);
          const key = inv.id || inv.ledger_entry_id;
          return (
            <div key={key} style={{ display: 'grid', gridTemplateColumns: '1fr 110px 110px', gap: 8, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 12.5 }}>
              <div>
                <b>{inv.entry_no || inv.reference || 'Invoice'}</b>
                <div className="muted" style={{ fontSize: 11.5 }}>{fmtKES(inv.amount)} · outstanding {fmtKES(inv.outstanding ?? inv.balance)}</div>
              </div>
              <span className="muted" style={{ textAlign: 'right' }}>← {fmtKES(a)}</span>
              <input
                type="number" min="0" step="0.01" placeholder="0.00"
                value={allocs[key] ?? ''}
                onChange={(e) => setAlloc(key, e.target.value)}
                aria-label={`Allocate to ${inv.entry_no || 'invoice'}`}
              />
            </div>
          );
        })}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 16, padding: '10px 2px 0', fontSize: 12.5 }}>
          <span>Allocated <b>{fmtKES(allocated)}</b></span>
          <span style={{ color: unallocated < 0 ? 'var(--red-ink)' : 'var(--text)' }}>Unallocated <b>{fmtKES(unallocated)}</b></span>
        </div>
        {allocated > total && <Notice kind="error">Allocations exceed the payment amount.</Notice>}
      </form>
    </Drawer>
  );
}
