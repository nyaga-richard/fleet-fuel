'use client';
// Suppliers (§17–§30) — list + create/edit. Balance convention: positive =
// payable to the supplier (DEBIT increases, CREDIT decreases).
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import Shell from '@/components/Shell';
import { Card, PageHeader, DataTable, StatusPill, Notice, Skeleton, Field, Drawer, SearchInput, SearchableSelect, useForm, EmptyState } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtKES } from '@/lib/format';

export default function SuppliersPage() {
  return <Shell><Suppliers /></Shell>;
}

const EMPTY = { name: '', code: '', phone: '', email: '', tax_pin: '', address: '', payment_terms_days: '30', credit_limit: '' };

function Suppliers() {
  const { user } = useAuth();
  const canManage = user?.role === 'admin' || user?.role === 'manager';
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(null); // 'new' | supplier
  const [busy, setBusy] = useState(false);
  const { form, bind, setForm } = useForm(EMPTY);

  const load = useCallback(() => {
    api(`/api/suppliers${q ? `?q=${encodeURIComponent(q)}` : ''}`).then((r) => setRows(r.suppliers)).catch((e) => setError(e.message));
  }, [q]);
  useEffect(() => { load(); }, [load]);

  function openNew() { setForm(EMPTY); setEditing('new'); }
  function openEdit(s) {
    setForm({
      name: s.name || '', code: s.code || '', phone: s.phone || '', email: s.email || '',
      tax_pin: s.tax_pin || '', address: s.address || '',
      payment_terms_days: String(s.payment_terms_days ?? 30), credit_limit: s.credit_limit ?? '',
    });
    setEditing(s);
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const body = {
        ...form,
        payment_terms_days: form.payment_terms_days === '' ? null : Number(form.payment_terms_days),
        credit_limit: form.credit_limit === '' ? null : Number(form.credit_limit),
      };
      if (editing === 'new') {
        const r = await api('/api/suppliers', { method: 'POST', body });
        setNotice(`Supplier ${r.supplier.name} created.`);
      } else {
        await api(`/api/suppliers/${editing.id}`, { method: 'PATCH', body });
        setNotice('Supplier updated.');
      }
      setEditing(null);
      load();
    } catch (e2) { setError(e2.message); } finally { setBusy(false); }
  }

  const columns = useMemo(() => [
    { key: 'name', label: 'Supplier', render: (r) => (
      <Link href={`/suppliers/${r.id}`}><b>{r.name}</b></Link>
    )},
    { key: 'code', label: 'Code', render: (r) => r.code || <span className="muted">—</span> },
    { key: 'phone', label: 'Phone', render: (r) => r.phone || <span className="muted">—</span> },
    { key: 'payment_terms_days', label: 'Terms', render: (r) => (r.payment_terms_days != null ? `${r.payment_terms_days} days` : '—') },
    { key: 'balance', label: 'Balance', render: (r) => (
      <b style={{ color: Number(r.balance) > 0 ? 'var(--amber-ink)' : 'var(--green-ink)' }}>{fmtKES(r.balance)}</b>
    )},
    { key: 'is_active', label: 'Status', render: (r) => <StatusPill status={r.is_active === false ? 'INACTIVE' : 'ACTIVE'} /> },
    { key: 'actions', label: '', render: (r) => (
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <Link href={`/suppliers/${r.id}`}><button className="btn secondary sm">Ledger</button></Link>
        {canManage && <button className="btn secondary sm" onClick={() => openEdit(r)}>Edit</button>}
      </div>
    )},
  ], [rows, canManage]);

  if (!rows && !error) return <Skeleton />;

  return (
    <>
      <PageHeader
        title="Suppliers"
        subtitle="Fuel, tire, parts and service vendors — balances, ledgers, payments and statements."
        actions={canManage && <button className="btn" onClick={openNew}>+ New supplier</button>}
      />
      {error && <Notice kind="error" onDone={() => setError('')}>{error}</Notice>}
      {notice && <Notice kind="success" onDone={() => setNotice('')}>{notice}</Notice>}
      <Card
        title="All suppliers"
        actions={<SearchInput value={q} onChange={setQ} placeholder="Search name, code, phone, PIN…" />}
      >
        {rows.length ? <DataTable columns={columns} rows={rows} /> : (
          <EmptyState title="No suppliers" message="Add your first supplier to start recording purchases and payments." />
        )}
      </Card>

      <Drawer
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'New supplier' : `Edit ${editing?.name || ''}`}
        subtitle="Balance = Opening + Purchases + Debit adjustments − Payments − Credit notes"
        footer={(
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn secondary" onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn" disabled={busy || !form.name} onClick={submit}>{busy ? 'Saving…' : 'Save supplier'}</button>
          </div>
        )}
      >
        <form onSubmit={submit}>
          <Field label="Name *"><input {...bind('name')} required placeholder="ABC Fuel Suppliers" /></Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label="Code"><input {...bind('code')} placeholder="ABC-001" /></Field>
            <Field label="Phone"><input {...bind('phone')} placeholder="07…" /></Field>
          </div>
          <Field label="Email"><input {...bind('email')} type="email" /></Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label="Tax PIN (KRA)"><input {...bind('tax_pin')} placeholder="P0…" /></Field>
            <Field label="Payment terms (days)"><input {...bind('payment_terms_days')} type="number" min="0" /></Field>
          </div>
          <Field label="Credit limit (KES)"><input {...bind('credit_limit')} type="number" min="0" step="0.01" /></Field>
          <Field label="Address"><textarea {...bind('address')} rows={2} /></Field>
        </form>
      </Drawer>
    </>
  );
}
