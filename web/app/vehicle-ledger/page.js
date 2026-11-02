'use client';
// Vehicle Fuel Ledger (§18) — consumption & cost per fill-up. Clearly named
// "Vehicle" to distinguish it from the station stock Fuel Ledger.
import { useCallback, useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Card, PageHeader, FilterBar, Field, StatusPill, Skeleton, Stat, SearchableSelect, ExportMenu } from '@/components/ui';
import { api } from '@/lib/api';
import { fmtDateTime, fmtNum, fmtKES } from '@/lib/format';

export default function VehicleLedgerPage() {
  return <Shell><VehicleLedger /></Shell>;
}

function VehicleLedger() {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 89 * 864e5).toISOString().slice(0, 10);
  const [from, setFrom] = useState(monthAgo);
  const [to, setTo] = useState(today);
  const [vehicleId, setVehicleId] = useState('');
  const [vehicles, setVehicles] = useState([]);
  const [data, setData] = useState(null);

  useEffect(() => {
    api('/api/vehicles').then((r) => setVehicles(r.vehicles || [])).catch(() => {});
  }, []);

  const params = { from, to, vehicle_id: vehicleId || undefined };
  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v)));
      setData(await api('/api/reports/vehicle-ledger?' + qs.toString()));
    } catch { setData(null); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, vehicleId]);

  useEffect(() => { load(); }, [load]);

  return (
    <>
      <PageHeader
        title="Vehicle Fuel Ledger"
        subtitle="Per fill-up: odometer, distance, consumption (KM/L) and cost per KM"
        actions={<ExportMenu report="vehicle-ledger" params={params} />}
      />

      <div className="cards4">
        {(data?.summary || []).map((s) => <Stat key={s.label} label={s.label} value={s.value} />)}
      </div>

      <FilterBar activeCount={vehicleId ? 1 : 0}>
        <div className="frow">
  <div className="frow">
            <Field label="Date from"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label="Date to"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
            <Field label="Vehicle">
              <SearchableSelect
                value={vehicleId} onChange={setVehicleId} placeholder="All vehicles"
                options={[{ value: '', label: 'All vehicles' }, ...vehicles.map((v) => ({ value: v.id, label: v.plate, sub: [v.make, v.model].filter(Boolean).join(' ') || '' }))]}
              />
            </Field>
          </div>
  
          {!data ? <Skeleton lines={10} /> : (
            <div className="dt-tablewrap">
              <table className="tbl sticky">
                <thead>
                  <tr>
                    <th>Date</th><th>Registration</th><th>Vehicle</th>
                    <th className="num">Odometer</th><th className="num">Distance</th><th className="num">Fuel (L)</th>
                    <th className="num">KM/L</th><th className="num">L/100KM</th>
                    <th className="num">Unit cost</th><th className="num">Fuel cost</th><th className="num">Cost/KM</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.length === 0 && (
                    <tr><td colSpan={12} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                      No fuel-ups with odometer readings in this period.
                    </td></tr>
                  )}
                  {data.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="nowrap">{fmtDateTime(r.date)}</td>
                      <td>{r.registration}</td>
                      <td>{r.vehicle || '—'}</td>
                      <td className="num">{fmtNum(r.odometer)} km</td>
                      <td className="num">{r.distance != null ? `${fmtNum(r.distance)} km` : '—'}</td>
                      <td className="num">{fmtNum(r.litres, 2)}</td>
                      <td className="num" style={{ fontWeight: 700 }}>{r.km_per_l != null ? r.km_per_l : '—'}</td>
                      <td className="num">{r.l_per_100km != null ? r.l_per_100km : '—'}</td>
                      <td className="num">{r.unit_cost != null ? fmtKES(r.unit_cost) : '—'}</td>
                      <td className="num">{r.fuel_cost != null ? fmtKES(r.fuel_cost) : '—'}</td>
                      <td className="num">{r.cost_per_km != null ? fmtKES(r.cost_per_km) : '—'}</td>
                      <td><StatusPill status={r.status} /></td>
                    </tr>
                  ))}
                  {data.totals && data.rows.length > 0 && (
                    <tr style={{ fontWeight: 800, borderTop: '2px solid var(--border)' }}>
                      <td>TOTAL</td><td colSpan={4}></td>
                      <td className="num">{fmtNum(data.totals.litres, 2)}</td>
                      <td colSpan={3}></td>
                      <td className="num">{fmtKES(data.totals.fuel_cost)}</td>
                      <td colSpan={2}></td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </FilterBar>
    </>
  );
}
