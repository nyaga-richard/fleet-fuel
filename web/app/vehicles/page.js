'use client';
// Vehicles — server-side search (?q=), add / edit / delete (deactivate) /
// restore. Deletion is a soft delete: fuel history is never touched.
import { useCallback, useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Card, PageHeader, SearchInput, Notice, useForm, Field, DataTable, StatusPill, Skeleton, ConfirmDialog, EmptyState } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtQty } from '@/lib/format';

export default function VehiclesPage() {
  return <Shell><Vehicles /></Shell>;
}

const EMPTY_FORM = { plate: '', make: '', model: '', vehicle_type: '', driver_name: '', tank_capacity: '', notes: '' };

function Vehicles() {
  const { user } = useAuth();
  const canManage = user?.role === 'admin' || user?.role === 'manager';
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null); // vehicle id or 'new'
  const [importOpen, setImportOpen] = useState(false);
  const [csvText, setCsvText] = useState('');
  const [importResult, setImportResult] = useState(null);
  const [importBusy, setImportBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(null);
  const { form, bind, setForm } = useForm(EMPTY_FORM);

  const load = useCallback(async () => {
    setError('');
    try {
      const r = await api(`/api/vehicles?q=${encodeURIComponent(q)}`);
      setRows(r.vehicles);
    } catch (e) { setError(e.message); }
  }, [q]);

  useEffect(() => { load(); }, [load]);

  function openNew() { setEditing('new'); setForm(EMPTY_FORM); }
  function openEdit(v) { setEditing(v.id); setForm({ ...v, tank_capacity: v.tank_capacity ?? '' }); }

  // ── CSV bulk import ──
  function parseCsv(text) {
    const rows = [];
    let cur = [''], inQ = false, r = 0, c = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') { if (text[i + 1] === '"') { cur[c] += '"'; i++; } else inQ = false; }
        else cur[c] += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ',') { cur[++c] = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        rows[r++] = cur; cur = ['']; c = 0;
      } else cur[c] += ch;
    }
    if (cur.length > 1 || cur[0] !== '') rows[r] = cur;
    return rows.filter((row) => row.some((cell) => cell.trim() !== ''));
  }

  function parsedRows() {
    const table = parseCsv(csvText);
    if (!table.length) return [];
    const first = table[0].map((h) => h.trim().toLowerCase());
    const hasHeader = first.includes('plate');
    const header = hasHeader ? first : ['plate', 'make', 'model', 'vehicle_type', 'driver_name', 'tank_capacity'];
    const body = hasHeader ? table.slice(1) : table;
    return body.map((cells) => {
      const o = {};
      header.forEach((h, i) => { if (h) o[h] = (cells[i] ?? '').trim(); });
      return o;
    }).filter((o) => o.plate);
  }

  async function runImport() {
    const rows = parsedRows();
    if (!rows.length) { setError('Nothing to import — add CSV rows with a plate column.'); return; }
    setImportBusy(true); setError('');
    try {
      const r = await api('/api/vehicles/bulk', { method: 'POST', body: { rows } });
      setImportResult(r);
      load();
    } catch (e) { setError(e.message); }
    finally { setImportBusy(false); }
  }

  function downloadTemplate() {
    const csv = 'plate,make,model,vehicle_type,driver_name,tank_capacity\nKDA 123A,Toyota,Hilux,pickup,John Kamau,120\nKDB 456B,Isuzu,NQR,truck,,';
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'vehicles-template.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  async function save(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const body = { ...form, tank_capacity: form.tank_capacity === '' ? undefined : Number(form.tank_capacity) };
      if (editing === 'new') {
        await api('/api/vehicles', { method: 'POST', body });
        setNotice(`Vehicle ${form.plate} added.`);
      } else {
        await api(`/api/vehicles/${editing}`, { method: 'PATCH', body });
        setNotice('Vehicle updated.');
      }
      setEditing(null);
      load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function toggleActive(v) {
    setBusy(true); setError('');
    try {
      await api(`/api/vehicles/${v.id}`, { method: 'PATCH', body: { active: !v.active } });
      setNotice(v.active ? `Vehicle ${v.plate} deleted (deactivated).` : `Vehicle ${v.plate} restored.`);
      setConfirmDel(null);
      load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  return (
    <>
      <PageHeader
        title="Vehicles"
        subtitle="Fleet register — search by plate, make, model or driver"
        actions={canManage && (
          <>
            <button className="btn secondary" onClick={() => { setImportOpen(!importOpen); setImportResult(null); }}>⬆ Import CSV</button>
            <button className="btn" onClick={openNew}>+ Add vehicle</button>
          </>
        )}
      />

      {error && <Notice kind="error" onDone={() => setError('')}>{error}</Notice>}
      {notice && <Notice kind="success" onDone={() => setNotice('')}>{notice}</Notice>}

      {canManage && importOpen && (
        <Card title="Bulk import vehicles">
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
            Paste CSV rows or choose a file. Columns: <b>plate</b> (required), make, model, vehicle_type, driver_name, tank_capacity. A header row is detected automatically; existing plates are skipped, so re-importing is safe.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            <input
              type="file" accept=".csv,.txt"
              onChange={(e) => { const f = e.target.files?.[0]; if (!f) return; f.text().then(setCsvText).catch(() => setError('Could not read that file.')); }}
              style={{ maxWidth: 320 }}
            />
            <button type="button" className="btn secondary sm" onClick={downloadTemplate}>Download template</button>
          </div>
          <textarea
            value={csvText} onChange={(e) => setCsvText(e.target.value)}
            placeholder={'plate,make,model,vehicle_type,driver_name,tank_capacity\nKDA 123A,Toyota,Hilux,pickup,John Kamau,120'}
            rows={6}
            style={{ width: '100%', background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: 10, fontFamily: 'ui-monospace, monospace', fontSize: 12.5 }}
          />
          {csvText.trim() && (
            <div className="muted" style={{ fontSize: 12.5, margin: '8px 0' }}>
              {parsedRows().length} vehicle row(s) detected.
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn" onClick={runImport} disabled={importBusy || !parsedRows().length}>
              {importBusy ? 'Importing…' : `Import${parsedRows().length ? ` ${parsedRows().length}` : ''} vehicles`}
            </button>
            <button type="button" className="btn secondary" onClick={() => { setImportOpen(false); setImportResult(null); setCsvText(''); }}>Close</button>
          </div>
          {importResult && (
            <div style={{ marginTop: 12 }}>
              <Notice kind={importResult.failed === 0 ? 'success' : 'info'}>
                {importResult.created} created · {importResult.skipped} skipped · {importResult.failed} failed
              </Notice>
              <div style={{ overflowX: 'auto', marginTop: 8 }}>
                <table className="tbl">
                  <thead><tr><th>Row</th><th>Plate</th><th>Result</th><th>Detail</th></tr></thead>
                  <tbody>
                    {importResult.results.map((r, i) => (
                      <tr key={i}>
                        <td>{r.row}</td>
                        <td className="mono">{r.plate || '—'}</td>
                        <td style={{ color: r.status === 'created' ? 'var(--green)' : r.status === 'skipped' ? 'var(--muted)' : 'var(--red)', fontWeight: 600 }}>{r.status}</td>
                        <td className="muted">{r.reason || ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </Card>
      )}

      {editing && (
        <Card title={editing === 'new' ? 'Add vehicle' : 'Edit vehicle'}>
          <form onSubmit={save} className="grid c3">
            <Field label="Registration plate *"><input {...bind('plate')} required placeholder="e.g. KDA 123A" style={{ textTransform: 'uppercase' }} /></Field>
            <Field label="Make"><input {...bind('make')} placeholder="Toyota" /></Field>
            <Field label="Model"><input {...bind('model')} placeholder="Hilux" /></Field>
            <Field label="Vehicle type"><input {...bind('vehicle_type')} placeholder="pickup / truck / saloon" /></Field>
            <Field label="Default driver"><input {...bind('driver_name')} /></Field>
            <Field label="Tank capacity (L)"><input type="number" inputMode="decimal" step="0.1" min="0" {...bind('tank_capacity')} /></Field>
            <Field label="Notes"><input {...bind('notes')} /></Field>
            <div style={{ gridColumn: '1 / -1' }}>
              <button className="btn" disabled={busy}>{busy ? 'Saving…' : editing === 'new' ? 'Add vehicle' : 'Save changes'}</button>
              <button type="button" className="btn secondary" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </form>
        </Card>
      )}

      <Card title="Fleet" actions={<SearchInput value={q} onChange={setQ} placeholder="Search plate, make, driver…" width={280} />}>
        {!rows ? <Skeleton lines={6} /> : (
          <DataTable
            columns={[
              { key: 'plate', label: 'Plate', render: (r) => <b>{r.plate}</b> },
              { key: 'make', label: 'Make / model', render: (r) => [r.make, r.model].filter(Boolean).join(' ') || '—' },
              { key: 'vehicle_type', label: 'Type', render: (r) => r.vehicle_type || '—' },
              { key: 'driver_name', label: 'Driver', render: (r) => r.driver_name || '—' },
              { key: 'tank_capacity', label: 'Tank', num: true, render: (r) => (r.tank_capacity ? fmtQty(r.tank_capacity) : '—') },
              { key: 'created_at', label: 'Added', render: (r) => fmtDate(r.created_at) },
              { key: 'status', label: 'Status', render: (r) => r.active !== false
                ? <span className="pill" style={{ color: 'var(--green)', borderColor: 'var(--green)', background: 'rgba(34,197,94,.1)' }}><span className="dot" style={{ background: 'var(--green)' }} />Active</span>
                : <span className="pill" style={{ color: 'var(--muted)', borderColor: 'var(--muted)', background: 'rgba(143,160,184,.1)' }}><span className="dot" style={{ background: 'var(--muted)' }} />Deleted</span> },
              { key: 'actions', label: '', render: (r) => (
                <span className="row-actions">
                  {canManage && <button className="btn secondary sm" onClick={(ev) => { ev.stopPropagation(); openEdit(r); }}>Edit</button>}
                  {canManage && (
                    <button
                      className={`btn sm ${r.active !== false ? 'danger' : 'success'}`}
                      onClick={(ev) => { ev.stopPropagation(); r.active !== false ? setConfirmDel(r) : toggleActive(r); }}
                    >
                      {r.active !== false ? 'Delete' : 'Restore'}
                    </button>
                  )}
                </span>
              )},
            ]}
            rows={rows}
            mobileCard={(r) => (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                  <b>{r.plate}</b>
                  {r.active !== false
                    ? <span className="pill" style={{ color: 'var(--green)', borderColor: 'var(--green)' }}><span className="dot" style={{ background: 'var(--green)' }} />Active</span>
                    : <span className="pill" style={{ color: 'var(--muted)', borderColor: 'var(--muted)' }}><span className="dot" style={{ background: 'var(--muted)' }} />Deleted</span>}
                </div>
                <div className="muted" style={{ margin: '4px 0', fontSize: 12.5 }}>
                  {[r.make, r.model, r.vehicle_type].filter(Boolean).join(' · ') || '—'}{r.driver_name ? ` · driver: ${r.driver_name}` : ''}
                </div>
                {canManage && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button className="btn secondary sm" onClick={(ev) => { ev.stopPropagation(); openEdit(r); }}>Edit</button>
                    <button className={`btn sm ${r.active !== false ? 'danger' : 'success'}`} onClick={(ev) => { ev.stopPropagation(); r.active !== false ? setConfirmDel(r) : toggleActive(r); }}>
                      {r.active !== false ? 'Delete' : 'Restore'}
                    </button>
                  </div>
                )}
              </>
            )}
            empty={q ? <EmptyState icon="🔍" title={`No vehicles match “${q}”`} message="Try another plate, make or driver name." /> : <EmptyState title="No vehicles yet" message="Add your first vehicle to start requesting fuel." action={canManage && <button className="btn" onClick={openNew}>+ Add vehicle</button>} />}
          />
        )}
      </Card>

      <ConfirmDialog
        open={!!confirmDel}
        title={`Delete vehicle ${confirmDel?.plate}?`}
        message="It will be deactivated and hidden from new requests. All fuel history is preserved — you can restore it any time."
        confirmLabel="Delete vehicle"
        danger
        busy={busy}
        onConfirm={() => confirmDel && toggleActive(confirmDel)}
        onCancel={() => setConfirmDel(null)}
      />
    </>
  );
}
