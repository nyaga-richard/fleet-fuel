'use client';
// ─────────────────────────────────────────────────────────────────────────────
// Reusable web UI kit — one visual language for every page.
// Card · Stat · StatusPill · Field · Notice · Tabs · Table · DataTable ·
// PageHeader · SearchInput · Select · EmptyState · ErrorState · Skeleton ·
// ConfirmDialog · Drawer · useForm
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useRef, useState } from 'react';
import { STATUS_COLORS } from '@/lib/format';

export function Card({ title, children, actions }) {
  return (
    <div className="card">
      {(title || actions) && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
          {title ? <h2 style={{ margin: 0 }}>{title}</h2> : <span />}
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="page-head">
      <div>
        <h1 style={{ margin: 0 }}>{title}</h1>
        {subtitle && <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{subtitle}</div>}
      </div>
      {actions && <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, sub, pct, tone }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value" style={tone ? { color: tone } : undefined}>{value}</div>
      {sub && <div className="sub">{sub}</div>}
      {pct !== undefined && (
        <div className="bar"><div style={{ width: `${Math.min(Math.max(pct, 0), 100)}%` }} /></div>
      )}
    </div>
  );
}

// Status badge — never color-only: dot + capitalized text.
export function StatusPill({ status }) {
  const color = STATUS_COLORS[status] || '#9ca3af';
  return (
    <span className="pill" style={{ color, borderColor: color, background: `${color}1a` }}>
      <span className="dot" style={{ background: color }} />
      {String(status || '—').replace(/_/g, ' ')}
    </span>
  );
}

export function Field({ label, children, hint }) {
  return (
    <label className="fld">
      <span>{label}</span>
      {children}
      {hint && <small className="muted" style={{ display: 'block', marginTop: 3 }}>{hint}</small>}
    </label>
  );
}

export function Select({ label, value, onChange, options, required, placeholder = 'Select…', disabled }) {
  return (
    <Field label={label}>
      <select value={value} onChange={(e) => onChange(e.target.value)} required={required} disabled={disabled}>
        <option value="">{placeholder}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </Field>
  );
}

export function Notice({ kind = 'info', children, onDone }) {
  if (!children) return null;
  return (
    <div className={`msg ${kind}`} onClick={onDone} style={onDone ? { cursor: 'pointer' } : undefined} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={value === t.value} className={value === t.value ? 'on' : ''} onClick={() => onChange(t.value)}>
          {t.label}{t.count !== undefined ? ` (${t.count})` : ''}
        </button>
      ))}
    </div>
  );
}

// Debounced search input — emits onChange at most every `delay` ms.
export function SearchInput({ value, onChange, placeholder = 'Search…', delay = 300, autoFocus, width = 260 }) {
  const [txt, setTxt] = useState(value ?? '');
  const timer = useRef(null);
  useEffect(() => { setTxt(value ?? ''); }, [value]);
  function change(v) {
    setTxt(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onChange(v), delay);
  }
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <div className="searchbox" style={{ width: `min(${width}px, 100%)` }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
      </svg>
      <input
        type="search" value={txt} placeholder={placeholder} autoFocus={autoFocus}
        onChange={(e) => change(e.target.value)} aria-label={placeholder}
      />
      {txt && <button type="button" className="searchbox-clear" aria-label="Clear search" onClick={() => { setTxt(''); onChange(''); }}>×</button>}
    </div>
  );
}

// Simple data table (kept for compact admin tables).
export function Table({ columns, rows, empty = 'No records yet', keyField = 'id' }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="tbl">
        <thead>
          <tr>{columns.map((c) => <th key={c.key ?? c.label} className={c.num ? 'num' : ''}>{c.label}</th>)}</tr>
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

// Full-featured data table: sticky header, client pagination, row click,
// and a card-based layout on small screens (pass `mobileCard` render prop).
export function DataTable({ columns, rows, keyField = 'id', empty = 'No records', pageSize = 25, onRowClick, mobileCard }) {
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [rows]);
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(page, pages - 1);
  const view = rows.slice(safePage * pageSize, safePage * pageSize + pageSize);

  return (
    <div className="dt">
      <div className="dt-tablewrap">
        <table className="tbl sticky">
          <thead>
            <tr>{columns.map((c) => <th key={c.key ?? c.label} className={c.num ? 'num' : ''}>{c.label}</th>)}</tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={columns.length} className="muted" style={{ textAlign: 'center', padding: 24 }}>{empty}</td></tr>
            )}
            {view.map((r, i) => (
              <tr
                key={r[keyField] ?? r.id ?? i}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                className={onRowClick ? 'clickable' : ''}
              >
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

      {mobileCard && (
        <div className="dt-cards">
          {rows.length === 0 && <EmptyState title="Nothing here" message={empty} />}
          {view.map((r) => (
            <div key={r[keyField] ?? r.id} className="mcard" onClick={onRowClick ? () => onRowClick(r) : undefined} role={onRowClick ? 'button' : undefined}>
              {mobileCard(r)}
            </div>
          ))}
        </div>
      )}

      {pages > 1 && (
        <div className="pager">
          <button className="btn secondary sm" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>← Prev</button>
          <span className="muted">Page {safePage + 1} of {pages} · {rows.length} records</span>
          <button className="btn secondary sm" disabled={safePage >= pages - 1} onClick={() => setPage(safePage + 1)}>Next →</button>
        </div>
      )}
    </div>
  );
}

export function EmptyState({ icon = '◌', title, message, action }) {
  return (
    <div className="statebox">
      <div className="statebox-icon" aria-hidden="true">{icon}</div>
      <h3>{title}</h3>
      {message && <p>{message}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }) {
  return (
    <div className="statebox error">
      <div className="statebox-icon" aria-hidden="true">⚠</div>
      <h3>Something went wrong</h3>
      <p>{message}</p>
      {onRetry && <button className="btn" onClick={onRetry}>Try again</button>}
    </div>
  );
}

export function Skeleton({ lines = 4, cards = false }) {
  return (
    <div className={cards ? 'skel-grid' : ''} aria-busy="true" aria-label="Loading">
      {cards
        ? [0, 1, 2, 3].map((i) => <div key={i} className="skel skel-card" />)
        : Array.from({ length: lines }).map((_, i) => <div key={i} className="skel skel-line" style={{ width: `${88 - i * 9}%` }} />)}
    </div>
  );
}

export function ConfirmDialog({ open, title = 'Are you sure?', message, confirmLabel = 'Confirm', danger = false, busy = false, onConfirm, onCancel }) {
  if (!open) return null;
  return (
    <div className="overlay" onClick={busy ? undefined : onCancel} role="dialog" aria-modal="true" aria-label={title}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{title}</h3>
        {message && <p className="muted">{message}</p>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
          <button className="btn secondary" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className={`btn ${danger ? 'danger' : ''}`} onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Drawer({ open, onClose, title, subtitle, children, footer, width = 460 }) {
  if (!open) return null;
  return (
    <div className="overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label={title}>
      <div className="drawer" onClick={(e) => e.stopPropagation()} style={{ width: `min(${width}px, 100%)` }}>
        <div className="drawer-head">
          <div>
            <h3 style={{ margin: 0 }}>{title}</h3>
            {subtitle && <div className="muted" style={{ fontSize: 12.5 }}>{subtitle}</div>}
          </div>
          <button className="btn secondary sm" onClick={onClose} aria-label="Close panel">✕ Close</button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </div>
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
