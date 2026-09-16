'use client';
// ─────────────────────────────────────────────────────────────────────────────
// Wheel Configurations manager (§1–§8) — Settings → Fleet Configuration.
//
// • Master data lives in the DB; this UI never hardcodes layouts (§7)
// • Visual builder: axles → type, sides, duals; live SVG + generated codes
// • Position codes are stable identifiers; display names are mutable (§5)
// • Structure is locked while a configuration is in use (§6) — the server
//   enforces it; the builder disables editing and explains why
// • Assignment happens through vehicle PATCH (stranding / in-operation rules
//   enforced server-side, §6)
// ─────────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, DataTable, StatusPill, Notice, Skeleton, Field, Drawer, ConfirmDialog, SearchableSelect } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/format';

const AXLE_TYPES = [
  { value: 'STEERING', label: 'Steering' },
  { value: 'DRIVE', label: 'Drive' },
  { value: 'TRAILING', label: 'Trailing / Tag' },
];

const emptyAxle = (n) => ({
  key: `a${n}-${Math.random().toString(36).slice(2, 7)}`,
  axle_number: n, axle_type: n === 1 ? 'STEERING' : 'DRIVE', duals: n > 1,
});

// Client-side mirror of the server's §8 shape validation — instant feedback,
// server remains authoritative.
function validateDraft(draft) {
  const errs = [];
  if (!draft.code?.trim()) errs.push('Code is required.');
  if (!draft.axles.length) errs.push('At least one axle is required.');
  draft.axles.forEach((ax, i) => {
    if (!ax.duals && !(ax.positions?.L && ax.positions?.R)) errs.push(`Axle ${i + 1}: both LEFT and RIGHT positions are required.`);
    if (ax.duals && ax.axle_type === 'STEERING') errs.push(`Axle ${i + 1}: steering axles cannot have dual wheels.`);
  });
  return errs;
}

/** Builds the §3/§5 position payload: sides → optional INNER/OUTER duals. */
function draftToPayload(draft) {
  return {
    code: draft.code.trim().toLowerCase(),
    name: draft.name.trim() || null,
    axles: draft.axles.map((ax, i) => {
      const sides = ['L', 'R'];
      const positions = [];
      for (const side of sides) {
        if (ax.duals) {
          positions.push({ side, wheel_position: 'INNER' });
          positions.push({ side, wheel_position: 'OUTER' });
        } else {
          positions.push({ side });
        }
      }
      return { axle_number: i + 1, axle_type: ax.axle_type, positions };
    }),
  };
}

// ── Visual preview (SVG, both themes via currentColor/vars) ──────────────────
export function ConfigSvg({ config, size = 1 }) {
  const axles = config?.axles || [];
  const W = 150, H = 46 + (axles.length + 1) * 58;
  const cx = W / 2;
  const wheelR = 13;
  const rows = [];
  axles.forEach((ax, ai) => {
    const y = 52 + ai * 58;
    const sides = (ax.positions || []).map((p) => p.side);
    const dualSides = new Set((ax.positions || []).filter((p) => p.wheel_position === 'INNER').map((p) => p.side));
    rows.push({ y, sides, dualSides, type: ax.axle_type });
  });
  const tone = { STEERING: 'var(--accent)', DRIVE: 'var(--green)', TRAILING: 'var(--amber)' };
  return (
    <svg width={W * size} height={H * size} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Configuration preview" style={{ maxWidth: '100%' }}>
      <rect x={cx - 26} y={18} width={52} height={H - 60} rx={10} fill="var(--panel-2)" stroke="var(--border)" />
      {rows.map((r, i) => (
        <g key={i}>
          <rect x={cx - 3} y={r.y - 3} width={6} height={6} fill="var(--muted)" />
          {r.sides.map((s) => {
            const x = s === 'L' ? cx - 52 : cx + 52;
            return (
              <g key={s}>
                <circle cx={x} cy={r.y} r={wheelR} fill="var(--panel)" stroke={tone[r.type] || 'var(--muted)'} strokeWidth={2.4} />
                {r.dualSides.has(s) && (
                  <circle cx={s === 'L' ? x - 15 : x + 15} cy={r.y} r={wheelR} fill="var(--panel)" stroke={tone[r.type] || 'var(--muted)'} strokeWidth={2.4} />
                )}
              </g>
            );
          })}
          <text x={cx + 62} y={r.y + 4} fontSize={9.5} fill="var(--muted)">
            {r.type.slice(0, 3)} · A{i + 1}
          </text>
        </g>
      ))}
    </svg>
  );
}

export default function WheelConfigManager() {
  const { user } = useAuth();
  const canManage = user?.role === 'admin' || user?.role === 'manager';
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [builder, setBuilder] = useState(null); // draft object
  const [editLocked, setEditLocked] = useState(false);
  const [assigning, setAssigning] = useState(null); // configuration row
  const [vehicles, setVehicles] = useState([]);
  const [vehicleId, setVehicleId] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDeact, setConfirmDeact] = useState(null);

  const load = useCallback(() => {
    api('/api/wheel-configs').then((r) => setRows(r.configurations)).catch((e) => setError(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  function openNew() {
    setEditLocked(false);
    setBuilder({ id: null, code: '', name: '', axles: [emptyAxle(1), emptyAxle(2)] });
  }
  function openEdit(cfg) {
    api(`/api/wheel-configs/${cfg.id}`).then((d) => {
      const axles = (d.axles || d.configuration?.axles || []).map((ax, i) => ({
        key: `e${i}-${ax.axle_number}`,
        axle_number: ax.axle_number,
        axle_type: ax.axle_type,
        duals: (ax.positions || []).some((p) => p.wheel_position === 'INNER'),
        positions: ax.positions,
      }));
      const locked = Number(cfg.vehicle_count || 0) > 0; // §6 — structure locked in use
      setEditLocked(locked);
      setBuilder({ id: cfg.id, code: cfg.code, name: cfg.name || '', axles, vehicleCount: cfg.vehicle_count });
    }).catch((e) => setError(e.message));
  }

  function mutateAxle(idx, patch) {
    setBuilder((b) => ({
      ...b,
      axles: b.axles.map((ax, i) => {
        if (i !== idx) return ax;
        const next = { ...ax, ...patch };
        if (patch.duals === true && next.axle_type === 'STEERING') next.axle_type = 'DRIVE';
        if (patch.axle_type === 'STEERING') next.duals = false;
        if (!next.positions) next.positions = null;
        return next;
      }),
    }));
  }

  const draftErrors = useMemo(() => (builder ? validateDraft(builder) : []), [builder]);

  async function saveBuilder(e) {
    e.preventDefault();
    if (draftErrors.length || !builder) return;
    setBusy(true); setError('');
    try {
      const payload = draftToPayload(builder);
      if (builder.id) {
        await api(`/api/wheel-configs/${builder.id}`, { method: 'PATCH', body: editLocked ? { name: payload.name } : payload });
        setNotice(editLocked
          ? 'Display name saved. The axle structure is locked while vehicles use this configuration (§6).'
          : 'Configuration updated.');
      } else {
        await api('/api/wheel-configs', { method: 'POST', body: payload });
        setNotice(`Configuration ${payload.code} created.`);
      }
      setBuilder(null);
      load();
    } catch (e2) { setError(e2.message); } finally { setBusy(false); }
  }

  function openAssign(cfg) {
    setAssigning(cfg); setVehicleId(''); setError('');
    api('/api/vehicles?limit=500').then((r) => setVehicles(r.vehicles || [])).catch((e) => setError(e.message));
  }

  async function assign(e) {
    e.preventDefault();
    if (!vehicleId) return;
    setBusy(true); setError('');
    try {
      await api(`/api/vehicles/${vehicleId}`, { method: 'PATCH', body: { wheel_configuration_id: assigning.id } });
      setNotice(`Configuration ${assigning.code} assigned. Stranded tires are rejected by the server (§6).`);
      setAssigning(null);
      load();
    } catch (e2) { setError(e2.message); } finally { setBusy(false); }
  }

  async function toggleActive(cfg) {
    setError('');
    try {
      await api(`/api/wheel-configs/${cfg.id}/${cfg.is_active ? 'deactivate' : 'activate'}`, { method: 'POST' });
      setNotice(`${cfg.code} ${cfg.is_active ? 'deactivated' : 'activated'}.`);
      load();
    } catch (e) { setError(e.message); }
  }

  const columns = useMemo(() => [
    { key: 'code', label: 'Code', render: (r) => <b>{r.code}</b> },
    { key: 'name', label: 'Name', render: (r) => r.name || <span className="muted">—</span> },
    { key: 'axle_count', label: 'Axles', render: (r) => `${r.axles?.length ?? '—'} × ${r.wheel_count}w` },
    { key: 'vehicle_count', label: 'Vehicles', render: (r) => r.vehicle_count },
    { key: 'is_active', label: 'Status', render: (r) => <StatusPill status={r.is_active ? 'ACTIVE' : 'INACTIVE'} /> },
    { key: 'updated_at', label: 'Updated', render: (r) => <span className="muted">{fmtDateTime(r.updated_at)}</span> },
    { key: 'actions', label: '', render: (r) => (
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        {canManage && <button className="btn secondary sm" onClick={() => openEdit(r)}>Edit</button>}
        {canManage && <button className="btn secondary sm" onClick={() => openAssign(r)}>Assign…</button>}
        {canManage && (
          <button className="btn secondary sm" onClick={() => (r.is_active ? setConfirmDeact(r) : toggleActive(r))}>
            {r.is_active ? 'Deactivate' : 'Activate'}
          </button>
        )}
      </div>
    )},
  ], [rows, canManage]);

  if (!rows && !error) return <Skeleton />;

  return (
    <>
      {error && <Notice kind="error" onDone={() => setError('')}>{error}</Notice>}
      {notice && <Notice kind="success" onDone={() => setNotice('')}>{notice}</Notice>}
      <Card
        title="Wheel configurations"
        actions={canManage && <button className="btn" onClick={openNew}>+ New configuration</button>}
      >
        <p className="muted" style={{ marginTop: 0, fontSize: 12.5 }}>
          Position codes (A1-L, A2-L-O…) are stable identifiers — display names can change, codes never do.
          Axle structure locks while any vehicle uses the configuration.
        </p>
        <DataTable columns={columns} rows={rows || []} empty="No wheel configurations" />
      </Card>

      {/* ── Builder drawer (§2) ── */}
      <Drawer
        open={!!builder}
        onClose={() => setBuilder(null)}
        title={builder?.id ? `Edit ${builder.code}` : 'New wheel configuration'}
        subtitle={builder?.id && editLocked
          ? `In use by ${builder.vehicleCount} vehicle(s) — axle structure locked (§6)`
          : 'Axles, sides and duals — codes are generated automatically'}
        width={620}
        footer={(
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn secondary" onClick={() => setBuilder(null)}>Cancel</button>
            <button className="btn" disabled={busy || draftErrors.length > 0} onClick={saveBuilder}>
              {busy ? 'Saving…' : builder?.id ? 'Save changes' : 'Create configuration'}
            </button>
          </div>
        )}
      >
        {builder && (
          <form onSubmit={saveBuilder}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <div style={{ flex: 1, display: 'grid', gap: 10 }}>
                <Field label="Code" hint="Lowercase, unique — e.g. 6x4. Immutable identifier.">
                  <input value={builder.code} disabled={!!builder.id} onChange={(e) => setBuilder({ ...builder, code: e.target.value })} placeholder="6x4" required />
                </Field>
                <Field label="Display name (optional)" hint="Mutable label, e.g. Ten-wheeler tipper">
                  <input value={builder.name} onChange={(e) => setBuilder({ ...builder, name: e.target.value })} placeholder="Ten-wheeler" />
                </Field>
              </div>
              <div style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 10, padding: 8 }}>
                <ConfigPreview draft={builder} />
              </div>
            </div>

            <h4 style={{ margin: '14px 0 6px' }}>Axles</h4>
            {editLocked && (
              <Notice kind="info">This configuration is in use — its axle structure cannot change. Create a new configuration instead (§6).</Notice>
            )}
            {!editLocked && builder.axles.map((ax, i) => (
              <div key={ax.key} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                <b style={{ width: 52 }}>A{i + 1}</b>
                <SearchableSelect
                  value={ax.axle_type}
                  onChange={(v) => mutateAxle(i, { axle_type: v })}
                  options={AXLE_TYPES}
                  placeholder="Axle type"
                  id={`axle-type-${i}`}
                />
                <label style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 12.5, whiteSpace: 'nowrap' }}>
                  <input type="checkbox" checked={!!ax.duals} disabled={ax.axle_type === 'STEERING'} onChange={(e) => mutateAxle(i, { duals: e.target.checked })} />
                  Dual wheels
                </label>
                {builder.axles.length > 1 && (
                  <button type="button" className="iconbtn" title="Remove axle" onClick={() => setBuilder((b) => ({ ...b, axles: b.axles.filter((_, j) => j !== i).map((a, j) => ({ ...a, axle_number: j + 1 })) }))}>🗑</button>
                )}
              </div>
            ))}
            {!editLocked && (
              <button type="button" className="btn secondary sm" style={{ marginTop: 8 }} onClick={() => setBuilder((b) => ({ ...b, axles: [...b.axles, emptyAxle(b.axles.length + 1)] }))}>
                + Add axle
              </button>
            )}
            {draftErrors.length > 0 && (
              <ul style={{ color: 'var(--red-ink)', fontSize: 12.5, margin: '10px 0 0', paddingLeft: 18 }}>
                {draftErrors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            )}
          </form>
        )}
      </Drawer>

      {/* ── Assign to vehicle ── */}
      <Drawer
        open={!!assigning}
        onClose={() => setAssigning(null)}
        title={`Assign ${assigning?.code || ''}`}
        subtitle="Vehicles with fitted tires that the new layout cannot hold are rejected (§6)"
        footer={(
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn secondary" onClick={() => setAssigning(null)}>Cancel</button>
            <button className="btn" disabled={!vehicleId || busy} onClick={assign}>{busy ? 'Assigning…' : 'Assign'}</button>
          </div>
        )}
      >
        <Field label="Vehicle" hint="Changing a configuration records history; fitted tires are never moved silently.">
          <SearchableSelect
            value={vehicleId}
            onChange={setVehicleId}
            options={vehicles.map((v) => ({ value: v.id, label: `${v.plate} — ${v.make || ''} ${v.model || ''}`.trim(), sub: v.axle_config || '' }))}
            placeholder="Select vehicle…"
          />
        </Field>
      </Drawer>

      <ConfirmDialog
        open={!!confirmDeact}
        title={`Deactivate ${confirmDeact?.code || ''}?`}
        message="Deactivated configurations stay on vehicles already using them but cannot be assigned to new ones."
        confirmLabel="Deactivate"
        onConfirm={() => { toggleActive(confirmDeact); setConfirmDeact(null); }}
        onCancel={() => setConfirmDeact(null)}
      />
    </>
  );
}

// Preview during editing: build a transient config-like structure from draft.
function ConfigPreview({ draft }) {
  const config = useMemo(() => ({
    axles: draft.axles.map((ax) => ({
      axle_type: ax.axle_type,
      positions: ax.duals
        ? [{ side: 'LEFT', wheel_position: 'INNER' }, { side: 'LEFT', wheel_position: 'OUTER' }, { side: 'RIGHT', wheel_position: 'INNER' }, { side: 'RIGHT', wheel_position: 'OUTER' }]
        : [{ side: 'LEFT' }, { side: 'RIGHT' }],
    })),
  }), [draft]);
  return <ConfigSvg config={config} size={0.82} />;
}
