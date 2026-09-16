'use client';
// ─────────────────────────────────────────────────────────────────────────────
// Tire Import (§9–§16) — Tires → Import tab.
//
// Upload → parse → validate/preview (never inserts) → confirm → import.
// • Duplicates are SKIPPED by default; existing records are never modified
// • Row-level errors shown inline; per-batch error file downloadable
// • Import is one server transaction — all rows or none
// • Batch history is kept (§16); every step audited server-side (§44)
// ─────────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, DataTable, StatusPill, Notice, Skeleton, Field, Drawer, EmptyState } from '@/components/ui';
import { api, apiBlob, downloadBlob } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';

const EXAMPLE_ROW = { serial_number: '', brand: '', size: '', pattern: '', type: 'TUBELESS', condition: 'NEW', purchase_cost: '', supplier: '', status: 'IN_STORE', retread_count: '0', tread_depth: '' };

export default function TireImport({ onDone }) {
  const fileRef = useRef(null);
  const [stage, setStage] = useState('upload'); // upload | preview | done
  const [rows, setRows] = useState(null);       // parsed + validated rows
  const [summary, setSummary] = useState(null);
  const [filename, setFilename] = useState('');
  const [b64, setB64] = useState('');
  const [batchId, setBatchId] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  async function handleFile(file) {
    if (!file) return;
    setError(''); setBusy(true); setStage('upload');
    try {
      const b64 = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1]);
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      const parsed = await api('/api/tire-imports/parse', { method: 'POST', body: { file_b64: b64, filename: file.name } });
      const preview = await api('/api/tire-imports/preview', { method: 'POST', body: { rows: parsed.rows } });
      setRows(preview.results);
      setSummary(preview.summary);
      setB64(b64);
      setFilename(file.name);
      setStage('preview');
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function commit() {
    setBusy(true); setError('');
    try {
      const parsed = await api('/api/tire-imports/parse', { method: 'POST', body: { file_b64: b64, filename } });
      const done = await api('/api/tire-imports/commit', { method: 'POST', body: { rows: parsed.rows, filename } });
      setBatchId(done.batch.id);
      setSummary((s) => ({ ...s, created: done.batch.created_count, skipped: done.batch.skipped_count, failed: done.batch.failed_count }));
      setStage('done');
      setNotice(`Imported ${done.batch.created_count} tire(s); ${done.batch.skipped_count} duplicate(s) skipped, ${done.batch.failed_count} row(s) failed.`);
      onDone?.();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  function reset() { setStage('upload'); setRows(null); setSummary(null); setBatchId(null); setFilename(''); setB64(''); setError(''); }

  async function downloadErrors() {
    if (!batchId) return;
    try {
      const d = await api(`/api/tire-imports/batches/${batchId}`);
      const header = 'row_number,serial_no,field,message';
      const lines = (d.errors || []).map((e) => [e.row_number, e.serial_no, e.field, `"${String(e.message).replaceAll('"', '""')}"`].join(','));
      downloadBlob(new Blob([[header].concat(lines).join('\n')], { type: 'text/csv' }), `tire-import-errors-${batchId.slice(0, 8)}.csv`);
    } catch (e) { setError(e.message); }
  }

  const columns = useMemo(() => [
    { key: 'row_number', label: 'Row', render: (r) => r.row_number },
    { key: 'serial_number', label: 'Serial', render: (r) => <b>{r.data?.serial_number || '—'}</b> },
    { key: 'brand', label: 'Brand / Size', render: (r) => `${r.data?.brand || ''} ${r.data?.size || ''}`.trim() || '—' },
    { key: 'status', label: 'Result', render: (r) => (
      <StatusPill status={r.status === 'valid' ? 'VALID' : r.status === 'duplicate' ? 'DUPLICATE' : 'ERROR'} />
    )},
    { key: 'errors', label: 'Details', render: (r) => (
      (r.errors || []).length
        ? <span style={{ color: 'var(--red-ink)', fontSize: 12 }}>{r.errors.map((e) => e.message).join(' · ')}</span>
        : (r.warnings || []).length
          ? <span style={{ color: 'var(--amber-ink)', fontSize: 12 }}>{r.warnings.join(' · ')}</span>
          : <span className="muted">OK</span>
    )},
  ], []);

  if (stage === 'upload') {
    return (
      <Card title="Import tires from CSV / Excel">
        {error && <Notice kind="error" onDone={() => setError('')}>{error}</Notice>}
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          Upload a supplier tire list. You will see a full validation preview before anything is saved —
          duplicates are skipped by default and existing records are never modified.
        </p>
        <div
          role="button"
          tabIndex={0}
          onClick={() => fileRef.current?.click()}
          onKeyDown={(e) => e.key === 'Enter' && fileRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files?.[0]); }}
          style={{
            border: `2px dashed ${dragOver ? 'var(--accent)' : 'var(--border)'}`,
            borderRadius: 12, padding: '38px 20px', textAlign: 'center', cursor: 'pointer',
            background: dragOver ? 'var(--accent-soft)' : 'var(--panel-2)',
          }}
        >
          <div style={{ fontSize: 30, marginBottom: 6 }}>⇪</div>
          <b>{busy ? 'Validating…' : 'Choose a .csv / .xlsx file or drop it here'}</b>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Validated in preview — nothing imports until you confirm.</div>
        </div>
        <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" hidden onChange={(e) => handleFile(e.target.files?.[0])} />
        <div style={{ marginTop: 12 }}>
          <button className="btn secondary sm" onClick={async () => {
            try { const b = await apiBlob('/api/tire-imports/template'); downloadBlob(b, 'tire-import-template.csv'); }
            catch (e) { setError(e.message); }
          }}>⬇ Download template</button>
        </div>
      </Card>
    );
  }

  if (stage === 'preview') {
    const counts = [
      { label: 'Valid', value: summary?.valid ?? 0, tone: 'var(--green-ink)' },
      { label: 'Errors', value: summary?.error ?? 0, tone: 'var(--red-ink)' },
      { label: 'Duplicates', value: summary?.duplicate ?? 0, tone: 'var(--amber-ink)' },
      { label: 'Warnings', value: summary?.warning ?? 0, tone: 'var(--muted)' },
    ];
    return (
      <Card title={`Preview — ${filename}`}>
        {error && <Notice kind="error" onDone={() => setError('')}>{error}</Notice>}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          {counts.map((c) => (
            <div key={c.label} style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '8px 14px', minWidth: 96 }}>
              <div className="muted" style={{ fontSize: 11 }}>{c.label}</div>
              <b style={{ fontSize: 17, color: c.tone }}>{c.value}</b>
            </div>
          ))}
        </div>
        <Notice kind="info">
          {summary?.valid ?? 0} row(s) will be imported. Duplicates are <b>skipped</b> — existing tire records are never
          modified by an import. Rows with errors are recorded and excluded.
        </Notice>
        <div style={{ marginTop: 10 }}>
          <DataTable columns={columns} rows={rows || []} empty="No rows" pageSize={12} />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
          <button className="btn secondary" onClick={reset}>Cancel</button>
          <button className="btn" disabled={busy || !(summary?.valid > 0)} onClick={commit}>
            {busy ? 'Importing…' : `Import ${summary?.valid ?? 0} valid row(s)`}
          </button>
        </div>
      </Card>
    );
  }

  // done
  return (
    <Card title={`Import complete — ${filename}`}>
      {notice && <Notice kind="success" onDone={() => setNotice('')}>{notice}</Notice>}
      {error && <Notice kind="error" onDone={() => setError('')}>{error}</Notice>}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '10px 0 14px' }}>
        <div style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '8px 14px', minWidth: 110 }}>
          <div className="muted" style={{ fontSize: 11 }}>Created</div>
          <b style={{ fontSize: 17, color: 'var(--green-ink)' }}>{summary?.created ?? 0}</b>
        </div>
        <div style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '8px 14px', minWidth: 110 }}>
          <div className="muted" style={{ fontSize: 11 }}>Skipped (duplicates)</div>
          <b style={{ fontSize: 17, color: 'var(--amber-ink)' }}>{summary?.skipped ?? 0}</b>
        </div>
        <div style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '8px 14px', minWidth: 110 }}>
          <div className="muted" style={{ fontSize: 11 }}>Failed</div>
          <b style={{ fontSize: 17, color: 'var(--red-ink)' }}>{summary?.failed ?? 0}</b>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn" onClick={reset}>Import another file</button>
        {(summary?.failed > 0 || summary?.error > 0) && (
          <button className="btn secondary" onClick={downloadErrors}>⬇ Download error file</button>
        )}
      </div>
    </Card>
  );
}

// ── Batch history (§16) ──────────────────────────────────────────────────────
export function ImportHistory() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api('/api/tire-imports/batches').then((r) => setRows(r.batches)).catch((e) => setError(e.message));
  }, []);
  const columns = useMemo(() => [
    { key: 'file_name', label: 'File', render: (r) => <b>{r.file_name}</b> },
    { key: 'status', label: 'Status', render: (r) => <StatusPill status={r.status} /> },
    { key: 'counts', label: 'Created / Skipped / Failed', render: (r) => `${r.created_count} / ${r.skipped_count} / ${r.failed_count}` },
    { key: 'total_rows', label: 'Rows', render: (r) => r.total_rows },
    { key: 'created_at', label: 'When', render: (r) => <span className="muted">{fmtDateTime(r.created_at)}</span> },
  ], []);
  if (error) return <Notice kind="error">{error}</Notice>;
  if (!rows) return <Skeleton />;
  if (!rows.length) return <EmptyState title="No imports yet" message="Imported files and their outcomes will be listed here." />;
  return <DataTable columns={columns} rows={rows} empty="No batches" />;
}
