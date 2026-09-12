'use client';
import { useCallback, useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Card, Table, Notice, useForm, Field } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/format';

export default function UsersPage() {
  return <Shell><Users /></Shell>;
}

function Users() {
  const { user: me } = useAuth();
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showForm, setShowForm] = useState(false);
  const { form, bind, setForm } = useForm({ name: '', email: '', password: '', role: 'attendant', phone: '' });

  const load = useCallback(() => api('/api/users').then((r) => setRows(r.users)).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    setError('');
    try {
      await api('/api/users', { method: 'POST', body: form });
      setNotice(`User ${form.email} created.`);
      setForm({ name: '', email: '', password: '', role: 'attendant', phone: '' });
      setShowForm(false);
      load();
    } catch (e) { setError(e.message); }
  }

  async function patch(id, body, msg) {
    setError('');
    try { await api(`/api/users/${id}`, { method: 'PATCH', body }); if (msg) setNotice(msg); load(); }
    catch (e) { setError(e.message); }
  }

  async function resetPassword(id) {
    const pw = window.prompt('New password (min 8 chars):');
    if (!pw) return;
    await patch(id, { password: pw }, 'Password updated.');
  }

  return (
    <>
      {error && <Notice kind="error" onDone={() => setError('')}>{error}</Notice>}
      {notice && <Notice kind="success" onDone={() => setNotice('')}>{notice}</Notice>}
      <Card
        title="Users"
        actions={<button className="btn" onClick={() => setShowForm(!showForm)}>{showForm ? 'Close' : '+ Add user'}</button>}
      >
        {showForm && (
          <form onSubmit={create} className="grid c3" style={{ marginBottom: 16 }}>
            <Field label="Name *"><input {...bind('name')} required /></Field>
            <Field label="Email *"><input type="email" {...bind('email')} required /></Field>
            <Field label="Password *"><input type="password" {...bind('password')} required minLength={8} /></Field>
            <Field label="Role *">
              <select {...bind('role')}>
                <option value="attendant">Pump Attendant</option>
                <option value="manager">Fleet Manager</option>
                <option value="admin">Administrator</option>
              </select>
            </Field>
            <Field label="Phone"><input {...bind('phone')} /></Field>
            <div><button className="btn">Create user</button></div>
          </form>
        )}
        <Table
          columns={[
            { key: 'name', label: 'Name' },
            { key: 'email', label: 'Email' },
            { key: 'role', label: 'Role', render: (r) => <span style={{ textTransform: 'capitalize' }}>{r.role}</span> },
            { key: 'phone', label: 'Phone', render: (r) => r.phone || '—' },
            { key: 'created_at', label: 'Created', render: (r) => fmtDate(r.created_at) },
            {
              key: 'active', label: 'Status', render: (r) => r.active
                ? <span className="pill" style={{ color: '#22c55e', borderColor: '#22c55e' }}>Active</span>
                : <span className="pill" style={{ color: '#9ca3af', borderColor: '#9ca3af' }}>Disabled</span>,
            },
            {
              key: 'actions', label: '', render: (r) => (
                <span className="row-actions">
                  <button className="btn secondary sm" onClick={() => resetPassword(r.id)}>Reset password</button>
                  {r.id !== me.sub && (
                    <button className="btn secondary sm" onClick={() => patch(r.id, { active: !r.active })}>
                      {r.active ? 'Disable' : 'Enable'}
                    </button>
                  )}
                </span>
              ),
            },
          ]}
          rows={rows}
          empty="No users"
        />
        <p className="muted" style={{ fontSize: 12 }}>
          Users are never deleted — disabling preserves audit history.
        </p>
      </Card>
    </>
  );
}
