'use client';
// Vehicle profile (§9/§44) — tabs over the vehicle's real data:
// Overview · Fuel (all sources) · Trips · Tires · Mileage trail · Revenue ·
// Expenses/Maintenance/Documents (later phases render an explicit empty state)
// · History (audit trail, admin). No mock data anywhere.
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Shell from '@/components/Shell';
import { Card, PageHeader, DataTable, StatusPill, Notice, Skeleton, Tabs, ExportMenu, EmptyState, Stat } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtKES, fmtQty, fmtDateTime } from '@/lib/format';

export default function VehicleDetailPage() {
  return <Shell><VehicleDetail /></Shell>;
}

function VehicleDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const [tab, setTab] = useState('overview');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try { setData(await api(`/api/vehicles/${id}/detail`)); }
    catch (e) { setError(e.message); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  if (error) return <Notice kind="error">{error}</Notice>;
  if (!data) return <><PageHeader title="Vehicle" /><Card><Skeleton lines={6} /></Card></>;
  const v = data.vehicle;
  const title = v.plate;

  const TABS = [
    { value: 'overview', label: 'Overview' },
    { value: 'fuel', label: 'Fuel' },
    { value: 'trips', label: 'Trips' },
    { value: 'tires', label: 'Tires' },
    { value: 'mileage', label: 'Mileage' },
    { value: 'revenue', label: 'Revenue' },
    { value: 'expenses', label: 'Expenses' },
    { value: 'maintenance', label: 'Maintenance' },
    { value: 'documents', label: 'Documents' },
    ...(user?.role === 'admin' ? [{ value: 'history', label: 'History' }] : []),
  ];

  return (
    <>
      <PageHeader
        title={title}
        subtitle={[v.make, v.model, v.year].filter(Boolean).join(' · ') || 'Vehicle profile'}
        actions={<StatusPill status={v.status} />}
      />
      <Tabs value={tab} onChange={setTab} tabs={TABS} />
      <div style={{ height: 14 }} />
      {tab === 'overview' && <Overview v={v} />}
      {tab === 'fuel' && <FuelTab vehicleId={id} expected={v.expected_km_l} />}
      {tab === 'trips' && <TripsTab vehicleId={id} />}
      {tab === 'tires' && <TiresTab vehicleId={id} />}
      {tab === 'mileage' && <MileageTab trail={data.odometer_history} current={v.current_odometer} />}
      {tab === 'revenue' && <RevenueTab vehicleId={id} />}
      {tab === 'expenses' && <Soon title="Expenses" message="Running expenses beyond fuel (repairs, tolls, licences) land here in a later phase." />}
      {tab === 'maintenance' && <Soon title="Maintenance" message="Service schedules and maintenance history land here in a later phase." />}
      {tab === 'documents' && <Soon title="Documents" message="Insurance, inspection and logbook records land here in a later phase." />}
      {tab === 'history' && <HistoryTab plate={v.plate} />}
    </>
  );
}

function Row({ label, value }) {
  return (
    <div style={{ display: 'flex', gap: 10, padding: '7px 0', borderBottom: '1px solid #f0f0f2' }}>
      <div className="muted" style={{ width: 190, flexShrink: 0 }}>{label}</div>
      <div>{value ?? '—'}</div>
    </div>
  );
}

function Overview({ v }) {
  return (
    <>
      <div className="grid c4" style={{ marginBottom: 14 }}>
        <Stat label="Status" value={v.status} sub={v.active ? 'fuel workflows enabled' : 'not issuable — inactive status'} />
        <Stat label="Current odometer" value={`${fmtQty(v.current_odometer, 'km')}`} sub="high-water mark from the unified trail" />
        <Stat label="Expected consumption" value={v.expected_km_l ? `${Number(v.expected_km_l).toFixed(2)} km/L` : '—'} sub={v.expected_km_l ? 'deviations >15% are flagged' : 'set it to enable abnormal-consumption flags'} />
        <Stat label="Tank capacity" value={v.tank_capacity ? fmtQty(v.tank_capacity) : '—'} sub={v.axle_config} />
      </div>
      <Card title="Registration (§8)">
        <Row label="Plate" value={v.plate} />
        <Row label="Make / Model" value={[v.make, v.model].filter(Boolean).join(' ') || '—'} />
        <Row label="Type" value={v.vehicle_type || '—'} />
        <Row label="Year" value={v.year} />
        <Row label="VIN" value={v.vin || '—'} />
        <Row label="Engine no" value={v.engine_no || '—'} />
        <Row label="Driver" value={v.driver_name || '—'} />
        <Row label="Department" value={v.department || '—'} />
        <Row label="Branch" value={v.branch || '—'} />
        <Row label="Station" value={v.station || '—'} />
        <Row label="Axle configuration" value={v.axle_config} />
        <Row label="Ownership" value={v.ownership_type || '—'} />
        <Row label="Supplier" value={v.supplier || '—'} />
        <Row label="Acquired" value={[v.acquisition_date ? fmtDate(v.acquisition_date) : null, v.acquisition_cost != null ? fmtKES(v.acquisition_cost) : null].filter(Boolean).join(' · ') || '—'} />
        <Row label="Added" value={fmtDate(v.created_at)} />
      </Card>
    </>
  );
}

// Unified ledger across BOTH sources (§5/§7) — clearly labelled.
function FuelTab({ vehicleId }) {
  const [ds, setDs] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api(`/api/reports/vehicle-fuel-unified?vehicle_id=${vehicleId}`).then(setDs).catch((e) => setError(e.message));
  }, [vehicleId]);
  if (error) return <Notice kind="error">{error}</Notice>;
  if (!ds) return <Card><Skeleton lines={6} /></Card>;
  const cols = [
    { key: 'date', label: 'Date', render: (r) => fmtDateTime(r.date) },
    { key: 'source', label: 'Source', render: (r) => <StatusPill status={r.source === 'STATION ISSUE' ? 'issue' : 'receipt'} /> },
    { key: 'reference', label: 'Ref' },
    { key: 'odometer', label: 'Odometer', right: true, render: (r) => fmtQty(r.odometer, 'km') },
    { key: 'distance', label: 'Distance', right: true, render: (r) => (r.distance != null ? `${fmtQty(r.distance, 'km')}` : '—') },
    { key: 'litres', label: 'Qty (L)', right: true, render: (r) => fmtQty(r.litres) },
    { key: 'km_per_l', label: 'KM/L', right: true, render: (r) => r.km_per_l ?? '—' },
    { key: 'fuel_cost', label: 'Cost', right: true, render: (r) => fmtKES(r.fuel_cost) },
    { key: 'consumption_flag', label: 'Flag', render: (r) => (r.consumption_flag === 'ABNORMAL' ? <span className="pill" style={{ background: '#fee2e2', color: '#b91c1c' }}>ABNORMAL</span> : <span className="muted">OK</span>) },
  ];
  return (
    <>
      <div className="grid c4" style={{ marginBottom: 14 }}>
        {ds.summary.slice(0, 4).map((s) => <Stat key={s.label} label={s.label} value={s.value} />)}
      </div>
      <Card title="Vehicle Fuel Ledger — all sources" actions={<ExportMenu report="vehicle-fuel-unified" params={{ vehicle_id: vehicleId }} />}>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>STATION ISSUE rows come from the station's own stock; EXTERNAL PURCHASE rows were bought outside and never touched station stock.</p>
        <DataTable columns={cols} rows={ds.rows} empty="No fuel recorded for this vehicle yet" />
      </Card>
    </>
  );
}

function TripsTab({ vehicleId }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api(`/api/trips?vehicle_id=${vehicleId}`).then((r) => setRows(r.trips)).catch((e) => setError(e.message));
  }, [vehicleId]);
  if (error) return <Notice kind="error">{error}</Notice>;
  const cols = [
    { key: 'trip_no', label: 'Trip No' },
    { key: 'trip_date', label: 'Date', render: (t) => fmtDate(t.trip_date) },
    { key: 'route', label: 'Route', render: (t) => [t.start_location, t.destination].filter(Boolean).join(' → ') || '—' },
    { key: 'driver_name', label: 'Driver', render: (t) => t.driver_name || '—' },
    { key: 'status', label: 'Status', render: (t) => <StatusPill status={t.status} /> },
    { key: 'distance', label: 'Distance', right: true, render: (t) => (t.distance != null ? fmtQty(t.distance, 'km') : '—') },
    { key: 'revenue_amount', label: 'Revenue', right: true, render: (t) => (t.revenue_amount != null ? fmtKES(t.revenue_amount) : <span className="muted">—</span>) },
  ];
  return <Card title="Trip history"><DataTable columns={cols} rows={rows || []} empty={rows == null ? undefined : 'No trips for this vehicle yet'} /></Card>;
}

function TiresTab({ vehicleId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api(`/api/tires/vehicle/${vehicleId}/layout`).then(setData).catch((e) => setError(e.message));
  }, [vehicleId]);
  if (error) return <Notice kind="error">{error}</Notice>;
  if (!data) return <Card><Skeleton lines={4} /></Card>;
  const fitted = data.layout.filter((l) => l.tire);
  return (
    <Card title="Tires on this vehicle">
      {fitted.length === 0 ? <EmptyState icon="⚁" title="No tires fitted" message="Fit tires from the Tires page to see them here." /> : (
        <DataTable
          keyField="code"
          columns={[
            { key: 'position', label: 'Position', render: (l) => `${l.code} — ${l.label}` },
            { key: 'serial', label: 'Serial No', render: (l) => l.tire.serial_no },
            { key: 'brand', label: 'Brand', render: (l) => l.tire.brand || '—' },
            { key: 'since', label: 'Fitted', render: (l) => (l.tire.installed_at ? fmtDate(l.tire.installed_at) : '—') },
            { key: 'odo', label: 'At odometer', render: (l) => (l.tire.installed_odometer != null ? fmtQty(l.tire.installed_odometer, 'km') : '—') },
          ]}
          rows={fitted.map((l) => ({ ...l, id: l.code }))}
        />
      )}
    </Card>
  );
}

// The authoritative odometer trail (§43) — every source, append-only.
function MileageTab({ trail, current }) {
  return (
    <>
      <div className="grid c4" style={{ marginBottom: 14 }}>
        <Stat label="Current odometer" value={fmtQty(current, 'km')} sub="never moves backwards (§41)" />
        <Stat label="Trail entries" value={String(trail.length)} sub="fuel, trips, tires, manual" />
      </div>
      <Card title="Odometer trail">
        <DataTable
          keyField="k"
          columns={[
            { key: 'recorded_at', label: 'Recorded', render: (r) => fmtDateTime(r.recorded_at) },
            { key: 'odometer', label: 'Odometer', right: true, render: (r) => fmtQty(r.odometer, 'km') },
            { key: 'source', label: 'Source' },
          ]}
          rows={trail.map((r, i) => ({ ...r, id: r.dedupe_key || i, k: r.dedupe_key || i }))}
          empty="No odometer history yet"
        />
      </Card>
    </>
  );
}

function RevenueTab({ vehicleId }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api(`/api/trips?vehicle_id=${vehicleId}`).then((r) => setRows(r.trips)).catch((e) => setError(e.message));
  }, [vehicleId]);
  if (error) return <Notice kind="error">{error}</Notice>;
  const withRev = (rows || []).filter((t) => t.revenue_amount != null);
  const total = withRev.reduce((a, t) => a + Number(t.revenue_amount), 0);
  return (
    <>
      <div className="grid c4" style={{ marginBottom: 14 }}>
        <Stat label="Trips with revenue" value={String(withRev.length)} sub="revenue is optional per trip" />
        <Stat label="Total revenue" value={fmtKES(total)} />
      </div>
      <Card title="Revenue by trip">
        <DataTable
          columns={[
            { key: 'trip_no', label: 'Trip No' },
            { key: 'trip_date', label: 'Date', render: (t) => fmtDate(t.trip_date) },
            { key: 'revenue_amount', label: 'Revenue', right: true, render: (t) => fmtKES(t.revenue_amount) },
            { key: 'revenue_type', label: 'Type', render: (t) => t.revenue_type || '—' },
            { key: 'revenue_customer', label: 'Customer', render: (t) => t.revenue_customer || '—' },
            { key: 'revenue_payment_status', label: 'Payment', render: (t) => <StatusPill status={t.revenue_payment_status} /> },
          ]}
          rows={withRev}
          empty="No revenue-bearing trips yet — that is perfectly normal (§22)"
        />
      </Card>
    </>
  );
}

function Soon({ title, message }) {
  return <Card title={title}><EmptyState icon="◍" title={`${title} — coming in a later phase`} message={message} /></Card>;
}

function HistoryTab({ plate }) {
  const [ds, setDs] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api(`/api/reports/audit-logs?q=${encodeURIComponent(plate)}`).then(setDs).catch((e) => setError(e.message));
  }, [plate]);
  if (error) return <Notice kind="error">{error}</Notice>;
  return (
    <Card title="Audit history" actions={<ExportMenu report="audit-logs" params={{ q: plate }} />}>
      <DataTable
        columns={[
          { key: 'created_at', label: 'When', render: (r) => fmtDateTime(r.created_at) },
          { key: 'user_name', label: 'User', render: (r) => r.user_name || 'system' },
          { key: 'action', label: 'Action' },
          { key: 'entity', label: 'Entity' },
        ]}
        rows={ds?.rows || []}
        empty={ds ? 'No audit entries referencing this plate yet' : undefined}
      />
    </Card>
  );
}
