'use client';
// Tiny UI primitives shared across pages.
import { useState } from 'react';
import { STATUS_COLORS } from '@/lib/format';

export function Card({ title, children, actions }) {
  return (
    <div className="card">
      {(title || actions) && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          {title ? <h2 style={{ margin: 0 }}>{title}</h2> : <span />}
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}

export function StatusPill({ status }) {
  const color = STATUS_COLORS[status] || '#9ca3af';
  return (
    <span className="pill" style={{ color, borderColor: color, background: `${color}1a` }}>
      {String(status || '').replace('_', ' ')}
    </span>
  );
}

export function Stat({ label, value, sub, pct }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
      {pct !== undefined && (
        <div className="bar"><div style={{ width: `${Math.min(Math.max(pct, 0), 100)}%` }} /></div>
      )}
    </div>
  );
}

export function Field({ label, children }) {
  return (
    <label className="fld">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Notice({ kind = 'info', children, onDone }) {
  if (!children) return null;
  return (
    <div className={`msg ${kind}`} onClick={onDone} style={onDone ? { cursor: 'pointer' } : undefined}>
      {children}
    </div>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <button key={t.value} className={value === t.value ? 'on' : ''} onClick={() => onChange(t.value)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

// Simple data table.
export function Table({ columns, rows, empty = 'No records yet', keyField = 'id' }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="tbl">
        <thead>
          <tr>{columns.map((c) => <th key={c.key} className={c.num ? 'num' : ''}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={columns.length} className="muted" style={{ textAlign: 'center', padding: 24 }}>{empty}</td></tr>
          )}
          {rows.map((r, i) => (
            <tr key={r[keyField] ?? r.id ?? i}>
              {columns.map((c) => (
                <td key={c.key ?? c.label} className={c.num ? 'num' : ''}>
                  {c.render ? c.render(r) : (r[c.key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Controlled form helper: const {form, set, bind} = useForm({...})
export function useForm(initial) {
  const [form, setForm] = useState(initial);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }));
  const bind = (k) => ({ value: form[k] ?? '', onChange: set(k) });
  return { form, setForm, set, bind };
}
