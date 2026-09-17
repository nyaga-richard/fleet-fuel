// ============================================================================
// FLEET report builders (§28–§31) — extend the report registry additively.
// Same DATASET contract as services/reports.js so JSON/CSV/XLSX/PDF always
// agree (§44). These consume BOTH fuel sources (§5/§7):
//   • STATION ISSUE  → fuel_transactions (station stock; Station Fuel Ledger)
//   • EXTERNAL PURCHASE → external_fuel_entries (NEVER touches station stock)
// Consumption metrics are computed across sources per the unified odometer
// order; every row is flagged against the vehicle's expected KM/L (§7/§42).
// ============================================================================
import { pool } from '../db/pool.js';
import { bad } from '../middleware/errors.js';
import { orgProfile, dateFilters, filtersText } from './reports.js';

const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));

export const ABNORMAL_DEVIATION = 0.15; // >15% below expected KM/L ⇒ abnormal (§42)

// Unified per-vehicle fill stream: internal + external, odometer-ordered.
const UNIFIED_SQL = `
  WITH fills AS (
    SELECT t.vehicle_id, t.created_at, t.quantity::float AS litres,
           t.unit_price::float AS unit_price, t.odometer::float AS odometer,
           'STATION ISSUE' AS source, t.txn_no AS reference, u.name AS entered_by,
           v.plate, v.make, v.model, v.expected_km_l::float AS expected_km_l
      FROM fuel_transactions t
      JOIN vehicles v ON v.id = t.vehicle_id
      LEFT JOIN users u ON u.id = t.operator_id
     WHERE t.status = 'completed'  -- include fills without odometer (distance simply unknown)
    UNION ALL
    SELECT e.vehicle_id, e.transaction_date, e.quantity::float,
           e.unit_price::float, e.odometer::float,
           'EXTERNAL PURCHASE', COALESCE(e.receipt_no, '—'), u.name,
           v.plate, v.make, v.model, v.expected_km_l::float
      FROM external_fuel_entries e
      JOIN vehicles v ON v.id = e.vehicle_id
      LEFT JOIN users u ON u.id = e.entered_by
     WHERE 1=1  -- external entries without odometer still belong on the vehicle ledger
  )`;

/** §5/§7 — unified Vehicle Fuel Ledger (both sources, one odometer order). */
export async function unifiedVehicleLedger(q) {
  const params = [];
  const where = [];
  if (q.vehicle_id) {
    if (!isUuid(q.vehicle_id)) throw bad('vehicle_id must be a valid id');
    params.push(String(q.vehicle_id)); where.push(`vehicle_id = $${params.length}`);
  }
  if (q.source) {
    const s = String(q.source).toUpperCase();
    if (!['INTERNAL', 'EXTERNAL'].includes(s)) throw bad('source must be INTERNAL or EXTERNAL');
    params.push(s === 'EXTERNAL' ? 'EXTERNAL PURCHASE' : 'STATION ISSUE');
    where.push(`source = $${params.length}`);
  }
  where.push(...dateFilters(q, params, 'created_at'));
  const profile = await orgProfile();
  const { rows } = await pool.query(
    `${UNIFIED_SQL}
     SELECT f.*,
            (odometer - LAG(odometer) OVER (PARTITION BY vehicle_id ORDER BY odometer, created_at)) AS distance
       FROM fills f
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY plate, odometer, created_at`, params);

  const data = rows.map((r) => {
    const distance = Number(r.distance) > 0 ? Number(r.distance) : null;
    const litres = Number(r.litres);
    const cost = r.unit_price != null ? +(r.unit_price * litres).toFixed(2) : null;
    const kmL = distance && litres > 0 ? +(distance / litres).toFixed(2) : null;
    const expected = r.expected_km_l != null ? Number(r.expected_km_l) : null;
    const abnormal = kmL != null && expected != null && expected > 0 && kmL < expected * (1 - ABNORMAL_DEVIATION);
    return {
      date: r.created_at, registration: r.plate,
      vehicle: [r.make, r.model].filter(Boolean).join(' ') || null,
      source: r.source, reference: r.reference,
      odometer: r.odometer != null ? Number(r.odometer) : null, distance, litres,
      km_per_l: kmL, l_per_100km: distance && litres > 0 ? +((litres / distance) * 100).toFixed(2) : null,
      unit_cost: r.unit_price, fuel_cost: cost,
      cost_per_km: distance && cost ? +(cost / distance).toFixed(2) : null,
      consumption_flag: abnormal ? 'ABNORMAL' : 'OK',
      entered_by: r.entered_by,
    };
  });
  const intL = rows.filter((r) => r.source === 'STATION ISSUE').reduce((a, r) => a + Number(r.litres), 0);
  const extL = rows.filter((r) => r.source === 'EXTERNAL PURCHASE').reduce((a, r) => a + Number(r.litres), 0);
  const totD = data.reduce((a, r) => a + (r.distance || 0), 0);
  const totC = data.reduce((a, r) => a + (r.fuel_cost || 0), 0);
  return {
    title: 'Vehicle Fuel Ledger (All Sources)', orientation: 'landscape',
    meta: { filters: filtersText(q, { vehicle_id: 'Vehicle', source: 'Source' }), org: profile },
    columns: [
      { key: 'date', label: 'Date', type: 'datetime', width: 19 },
      { key: 'registration', label: 'Registration', width: 14 },
      { key: 'vehicle', label: 'Vehicle', width: 20 },
      { key: 'source', label: 'Source', width: 18 },
      { key: 'reference', label: 'Txn / Receipt No', width: 16 },
      { key: 'odometer', label: 'Odometer (km)', type: 'number', width: 13 },
      { key: 'distance', label: 'Distance (km)', type: 'number', width: 13 },
      { key: 'litres', label: 'Fuel (L)', type: 'number', width: 10 },
      { key: 'km_per_l', label: 'KM/L', type: 'number', width: 9 },
      { key: 'l_per_100km', label: 'L/100KM', type: 'number', width: 10 },
      { key: 'unit_cost', label: `Unit Cost (${profile.currency})`, type: 'money', width: 13 },
      { key: 'fuel_cost', label: `Fuel Cost (${profile.currency})`, type: 'money', width: 14 },
      { key: 'cost_per_km', label: `Cost/KM (${profile.currency})`, type: 'money', width: 13 },
      { key: 'consumption_flag', label: 'Consumption', width: 12 },
      { key: 'entered_by', label: 'Entered By', width: 15 },
    ],
    rows: data,
    summary: [
      { label: 'Fill-ups', value: String(data.length) },
      { label: 'Station Issue Fuel', value: `${intL.toLocaleString(undefined, { maximumFractionDigits: 2 })} L` },
      { label: 'External Purchase Fuel', value: `${extL.toLocaleString(undefined, { maximumFractionDigits: 2 })} L` },
      { label: 'Total Distance', value: `${totD.toLocaleString(undefined, { maximumFractionDigits: 0 })} km` },
      { label: 'Total Fuel Cost', value: `${profile.currency} ${totC.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` },
      { label: 'Fleet KM/L', value: intL + extL ? (totD / (intL + extL)).toFixed(2) : '—' },
      { label: 'Abnormal Fill-ups', value: String(data.filter((r) => r.consumption_flag === 'ABNORMAL').length) },
    ],
    totals: { litres_int: +intL.toFixed(2), litres_ext: +extL.toFixed(2), distance: totD, fuel_cost: +totC.toFixed(2) },
    total: data.length,
  };
}

/** §28 — fleet consumption & cost per vehicle across BOTH sources. */
export async function fleetConsumption(q) {
  const params = [];
  const where = [];
  if (q.vehicle_id) {
    if (!isUuid(q.vehicle_id)) throw bad('vehicle_id must be a valid id');
    params.push(String(q.vehicle_id)); where.push(`v.id = $${params.length}`);
  }
  where.push(...dateFilters(q, params, 'f.created_at'));
  const profile = await orgProfile();
  const { rows } = await pool.query(
    `${UNIFIED_SQL}
     SELECT v.id, v.plate, v.make, v.model, v.expected_km_l::float AS expected_km_l, v.status,
            COUNT(*)::int AS fillups,
            COALESCE(SUM(litres) FILTER (WHERE source = 'STATION ISSUE'), 0)::float AS litres_station,
            COALESCE(SUM(litres) FILTER (WHERE source = 'EXTERNAL PURCHASE'), 0)::float AS litres_external,
            COALESCE(SUM(litres * COALESCE(unit_price, 0)), 0)::float AS fuel_cost,
            MAX(odometer) - MIN(odometer) AS distance
       FROM fills f JOIN vehicles v ON v.id = f.vehicle_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      GROUP BY v.id, v.plate, v.make, v.model, v.expected_km_l, v.status
      ORDER BY fuel_cost DESC`, params);
  const data = rows.map((r) => {
    const litres = Number(r.litres_station) + Number(r.litres_external);
    const distance = Number(r.distance) || 0;
    const kmL = litres > 0 && distance > 0 ? +(distance / litres).toFixed(2) : null;
    const expected = r.expected_km_l != null ? Number(r.expected_km_l) : null;
    const deviation = kmL != null && expected ? +(((kmL - expected) / expected) * 100).toFixed(1) : null;
    return {
      registration: r.plate,
      vehicle: [r.make, r.model].filter(Boolean).join(' ') || null,
      status: r.status, fillups: Number(r.fillups),
      litres_station: +Number(r.litres_station).toFixed(2),
      litres_external: +Number(r.litres_external).toFixed(2),
      litres_total: +litres.toFixed(2),
      distance: +distance.toFixed(0),
      km_per_l: kmL,
      expected_km_l: expected,
      deviation_pct: deviation == null ? null : `${deviation > 0 ? '+' : ''}${deviation}%`,
      consumption_flag: kmL != null && expected > 0 && kmL < expected * (1 - ABNORMAL_DEVIATION) ? 'ABNORMAL' : 'OK',
      fuel_cost: +Number(r.fuel_cost).toFixed(2),
      cost_per_km: distance > 0 ? +(Number(r.fuel_cost) / distance).toFixed(2) : null,
    };
  });
  const totL = data.reduce((a, r) => a + r.litres_total, 0);
  const totD = data.reduce((a, r) => a + r.distance, 0);
  const totC = data.reduce((a, r) => a + r.fuel_cost, 0);
  return {
    title: 'Fleet Consumption & Cost', orientation: 'landscape',
    meta: { filters: filtersText(q, { vehicle_id: 'Vehicle' }), org: profile },
    columns: [
      { key: 'registration', label: 'Registration', width: 14 },
      { key: 'vehicle', label: 'Vehicle', width: 20 },
      { key: 'status', label: 'Status', width: 12 },
      { key: 'fillups', label: 'Fill-ups', type: 'number', width: 9 },
      { key: 'litres_station', label: 'Station Fuel (L)', type: 'number', width: 14 },
      { key: 'litres_external', label: 'External Fuel (L)', type: 'number', width: 14 },
      { key: 'litres_total', label: 'Total (L)', type: 'number', width: 10 },
      { key: 'distance', label: 'Distance (km)', type: 'number', width: 13 },
      { key: 'km_per_l', label: 'KM/L', type: 'number', width: 9 },
      { key: 'expected_km_l', label: 'Expected KM/L', type: 'number', width: 13 },
      { key: 'deviation_pct', label: 'Deviation', width: 10 },
      { key: 'consumption_flag', label: 'Flag', width: 11 },
      { key: 'fuel_cost', label: `Fuel Cost (${profile.currency})`, type: 'money', width: 14 },
      { key: 'cost_per_km', label: `Cost/KM (${profile.currency})`, type: 'money', width: 13 },
    ],
    rows: data,
    summary: [
      { label: 'Vehicles', value: String(data.length) },
      { label: 'Total Fuel (all sources)', value: `${totL.toLocaleString(undefined, { maximumFractionDigits: 2 })} L` },
      { label: 'Total Distance', value: `${totD.toLocaleString(undefined, { maximumFractionDigits: 0 })} km` },
      { label: 'Fleet KM/L', value: totL ? (totD / totL).toFixed(2) : '—' },
      { label: 'Total Fuel Cost', value: `${profile.currency} ${totC.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` },
      { label: 'Abnormal Vehicles', value: String(data.filter((r) => r.consumption_flag === 'ABNORMAL').length) },
    ],
    totals: { litres: +totL.toFixed(2), distance: totD, fuel_cost: +totC.toFixed(2) },
    total: data.length,
  };
}

/** §26/§30 — trip register: distance, fuel in window, OPTIONAL revenue and
 *  Gross Contribution (revenue − fuel cost). Never called profit (§22). */
export async function tripRegister(q) {
  const params = [];
  const where = [];
  if (q.vehicle_id) {
    if (!isUuid(q.vehicle_id)) throw bad('vehicle_id must be a valid id');
    params.push(String(q.vehicle_id)); where.push(`t.vehicle_id = $${params.length}`);
  }
  if (q.status) {
    const st = String(q.status).toUpperCase();
    if (!['PLANNED', 'AUTHORIZED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'].includes(st)) throw bad('Invalid trip status');
    params.push(st); where.push(`t.status = $${params.length}`);
  }
  where.push(...dateFilters(q, params, 't.trip_date'));
  const profile = await orgProfile();
  const { rows } = await pool.query(
    `SELECT t.*, v.plate, v.make, v.model,
            COALESCE((SELECT SUM(f.quantity)::float FROM fuel_transactions f
                       WHERE f.vehicle_id = t.vehicle_id AND f.status = 'completed'
                         AND f.odometer BETWEEN t.start_odometer AND GREATEST(t.end_odometer, t.start_odometer)), 0)
           + COALESCE((SELECT SUM(e.quantity)::float FROM external_fuel_entries e
                       WHERE e.vehicle_id = t.vehicle_id
                         AND e.odometer BETWEEN t.start_odometer AND GREATEST(t.end_odometer, t.start_odometer)), 0) AS trip_litres,
            COALESCE((SELECT SUM(f.quantity * COALESCE(f.unit_price, 0))::float FROM fuel_transactions f
                       WHERE f.vehicle_id = t.vehicle_id AND f.status = 'completed'
                         AND f.odometer BETWEEN t.start_odometer AND GREATEST(t.end_odometer, t.start_odometer)), 0)
           + COALESCE((SELECT SUM(e.total_amount)::float FROM external_fuel_entries e
                       WHERE e.vehicle_id = t.vehicle_id
                         AND e.odometer BETWEEN t.start_odometer AND GREATEST(t.end_odometer, t.start_odometer)), 0) AS trip_fuel_cost
       FROM trips t JOIN vehicles v ON v.id = t.vehicle_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY t.trip_date DESC, t.created_at DESC`, params);
  const data = rows.map((r) => {
    const distance = Number(r.distance) || 0;
    const fuelCost = Number(r.trip_fuel_cost) || 0;
    const revenue = r.revenue_amount != null ? Number(r.revenue_amount) : null;
    return {
      trip_no: r.trip_no, date: r.trip_date, registration: r.plate,
      vehicle: [r.make, r.model].filter(Boolean).join(' ') || null,
      driver: r.driver_name, route: [r.start_location, r.destination].filter(Boolean).join(' → ') || null,
      status: r.status,
      start_odometer: r.start_odometer != null ? Number(r.start_odometer) : null,
      end_odometer: r.end_odometer != null ? Number(r.end_odometer) : null,
      distance: +distance.toFixed(1),
      fuel_litres: +Number(r.trip_litres).toFixed(2),
      fuel_cost: +fuelCost.toFixed(2),
      cost_per_km: distance > 0 ? +(fuelCost / distance).toFixed(2) : null,
      revenue: revenue,
      revenue_type: r.revenue_type || null,
      revenue_status: r.revenue_payment_status || null,
      // §22 — labelled Gross Contribution, never "profit".
      gross_contribution: revenue != null ? +(revenue - fuelCost).toFixed(2) : null,
    };
  });
  const completed = data.filter((r) => r.status === 'COMPLETED');
  const totD = data.reduce((a, r) => a + r.distance, 0);
  const totC = data.reduce((a, r) => a + r.fuel_cost, 0);
  const totR = data.reduce((a, r) => a + (r.revenue || 0), 0);
  return {
    title: 'Trip Register', orientation: 'landscape',
    meta: { filters: filtersText(q, { vehicle_id: 'Vehicle', status: 'Status' }), org: profile },
    columns: [
      { key: 'trip_no', label: 'Trip No', width: 14 },
      { key: 'date', label: 'Trip Date', type: 'date', width: 12 },
      { key: 'registration', label: 'Registration', width: 14 },
      { key: 'driver', label: 'Driver', width: 16 },
      { key: 'route', label: 'Route', width: 24 },
      { key: 'status', label: 'Status', width: 13 },
      { key: 'distance', label: 'Distance (km)', type: 'number', width: 13 },
      { key: 'fuel_litres', label: 'Fuel (L)', type: 'number', width: 10 },
      { key: 'fuel_cost', label: `Fuel Cost (${profile.currency})`, type: 'money', width: 13 },
      { key: 'cost_per_km', label: `Cost/KM (${profile.currency})`, type: 'money', width: 13 },
      { key: 'revenue', label: `Revenue (${profile.currency})`, type: 'money', width: 13 },
      { key: 'revenue_status', label: 'Payment', width: 11 },
      { key: 'gross_contribution', label: `Gross Contribution (${profile.currency})`, type: 'money', width: 20 },
    ],
    rows: data,
    summary: [
      { label: 'Trips', value: String(data.length) },
      { label: 'Completed', value: String(completed.length) },
      { label: 'Total Distance', value: `${totD.toLocaleString(undefined, { maximumFractionDigits: 0 })} km` },
      { label: 'Fuel Cost', value: `${profile.currency} ${totC.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` },
      { label: 'Revenue (where recorded)', value: `${profile.currency} ${totR.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` },
      { label: 'Gross Contribution', value: `${profile.currency} ${(totR - totC).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` },
    ],
    totals: { distance: +totD.toFixed(1), fuel_cost: +totC.toFixed(2), revenue: +totR.toFixed(2) },
    total: data.length,
  };
}

/** §29 — tire register (one row per tire, lifecycle totals). */
export async function tireRegister(q) {
  const params = [];
  const where = [];
  if (q.status) { params.push(String(q.status).toUpperCase()); where.push(`t.status = $${params.length}`); }
  if (q.q) { params.push(`%${String(q.q)}%`); where.push(`(t.serial_no ILIKE $${params.length} OR t.brand ILIKE $${params.length})`); }
  const profile = await orgProfile();
  const { rows } = await pool.query(
    `SELECT t.*, v.plate AS current_plate,
            (SELECT COUNT(*)::int FROM tire_movements m WHERE m.tire_id = t.id AND m.action = 'FIT') AS fit_count,
            (SELECT MAX(m.odometer)::float FROM tire_movements m WHERE m.tire_id = t.id AND m.action = 'REMOVE') AS last_removed_odo
       FROM tires t LEFT JOIN vehicles v ON v.id = t.current_vehicle_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY t.serial_no`, params);
  const data = rows.map((r) => ({
    serial_no: r.serial_no, brand: r.brand, pattern: r.pattern, size: r.size,
    tire_type: r.tire_type, supply_condition: r.supply_condition,
    status: r.status,
    current_vehicle: r.current_plate || null, current_position: r.current_position || null,
    mileage_accumulated: Number(r.mileage_accumulated) || 0,
    fits: Number(r.fit_count) || 0, retreads: Number(r.retread_count) || 0,
    tread_depth_mm: r.tread_depth_mm != null ? Number(r.tread_depth_mm) : null,
    purchase_cost: r.purchase_cost != null ? Number(r.purchase_cost) : null,
    cost_per_km: Number(r.mileage_accumulated) > 0 && r.purchase_cost != null
      ? +(Number(r.purchase_cost) / Number(r.mileage_accumulated)).toFixed(2) : null,
  }));
  const onVehicles = data.filter((r) => r.status === 'ON_VEHICLE').length;
  return {
    title: 'Tire Register', orientation: 'landscape',
    meta: { filters: filtersText(q, { status: 'Status', q: 'Search' }), org: profile },
    columns: [
      { key: 'serial_no', label: 'Serial No', width: 16 },
      { key: 'brand', label: 'Brand', width: 12 },
      { key: 'pattern', label: 'Pattern', width: 10 },
      { key: 'size', label: 'Size', width: 10 },
      { key: 'status', label: 'Status', width: 13 },
      { key: 'current_vehicle', label: 'On Vehicle', width: 14 },
      { key: 'current_position', label: 'Position', width: 10 },
      { key: 'mileage_accumulated', label: 'Mileage (km)', type: 'number', width: 13 },
      { key: 'fits', label: 'Fits', type: 'number', width: 7 },
      { key: 'retreads', label: 'Retreads', type: 'number', width: 9 },
      { key: 'tread_depth_mm', label: 'Tread (mm)', type: 'number', width: 11 },
      { key: 'purchase_cost', label: `Cost (${profile.currency})`, type: 'money', width: 12 },
      { key: 'cost_per_km', label: `Cost/KM (${profile.currency})`, type: 'money', width: 13 },
    ],
    rows: data,
    summary: [
      { label: 'Tires', value: String(data.length) },
      { label: 'On Vehicles', value: String(onVehicles) },
      { label: 'In Store', value: String(data.filter((r) => ['IN_STORE', 'USED_STORE'].includes(r.status)).length) },
      { label: 'Total Accumulated Mileage', value: `${data.reduce((a, r) => a + r.mileage_accumulated, 0).toLocaleString()} km` },
    ],
    totals: null,
    total: data.length,
  };
}

/** §28 — fleet dashboard KPIs (period defaults to current month). */
export async function fleetDashboard(q) {
  const params = [];
  const from = q.from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
  const to = q.to;
  const periodWhere = [];
  params.push(from); periodWhere.push(`created_at >= $1::date`);
  if (to) { params.push(to); periodWhere.push(`created_at < ($${params.length}::date + interval '1 day')`); }
  const pw = periodWhere.join(' AND ');
  const profile = await orgProfile();

  const [veh, fuelInt, fuelExt, tripsAgg, tiresAgg, top] = await Promise.all([
    pool.query(`SELECT status, COUNT(*)::int AS n FROM vehicles GROUP BY status`),
    pool.query(`SELECT COALESCE(SUM(quantity), 0)::float AS litres, COALESCE(SUM(quantity * COALESCE(unit_price, 0)), 0)::float AS cost, COUNT(*)::int AS n
                  FROM fuel_transactions WHERE status = 'completed' AND ${pw}`, params),
    pool.query(`SELECT COALESCE(SUM(quantity), 0)::float AS litres, COALESCE(SUM(total_amount), 0)::float AS cost, COUNT(*)::int AS n
                  FROM external_fuel_entries WHERE ${pw}`, params),
    pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(distance), 0)::float AS distance,
                       COALESCE(SUM(revenue_amount), 0)::float AS revenue
                  FROM trips WHERE status <> 'CANCELLED' AND trip_date >= $1::date ${to ? `AND trip_date < ($2::date + interval '1 day')` : ''}`, params),
    pool.query(`SELECT COUNT(*) FILTER (WHERE status = 'ON_VEHICLE')::int AS on_vehicles,
                       COUNT(*) FILTER (WHERE status IN ('IN_STORE','USED_STORE'))::int AS in_store,
                       COUNT(*) FILTER (WHERE status = 'DISPOSED')::int AS disposed,
                       COUNT(*)::int AS total FROM tires`),
    pool.query(`${UNIFIED_SQL}
                  SELECT v.plate, v.make, v.model,
                         COALESCE(SUM(litres), 0)::float AS litres,
                         COALESCE(SUM(litres * COALESCE(unit_price, 0)), 0)::float AS cost,
                         MAX(odometer) - MIN(odometer) AS distance,
                         v.expected_km_l::float AS expected_km_l
                    FROM fills f JOIN vehicles v ON v.id = f.vehicle_id
                   WHERE f.created_at >= $1::date ${to ? `AND f.created_at < ($2::date + interval '1 day')` : ''}
                   GROUP BY v.id, v.plate, v.make, v.model, v.expected_km_l
                   ORDER BY cost DESC LIMIT 8`, params),
  ]);

  const vehBy = Object.fromEntries(veh.rows.map((r) => [r.status, Number(r.n)]));
  const intL = Number(fuelInt.rows[0].litres), extL = Number(fuelExt.rows[0].litres);
  const intC = Number(fuelInt.rows[0].cost), extC = Number(fuelExt.rows[0].cost);
  const tripD = Number(tripsAgg.rows[0].distance), tripR = Number(tripsAgg.rows[0].revenue);
  const fuelAll = intL + extL;
  const topRows = top.rows.map((r) => {
    const litres = Number(r.litres), distance = Number(r.distance) || 0;
    const kmL = litres > 0 && distance > 0 ? +(distance / litres).toFixed(2) : null;
    return {
      registration: r.plate, vehicle: [r.make, r.model].filter(Boolean).join(' ') || null,
      litres: +litres.toFixed(2), cost: +Number(r.cost).toFixed(2),
      distance: +distance.toFixed(0), km_per_l: kmL,
      flag: kmL != null && Number(r.expected_km_l) > 0 && kmL < Number(r.expected_km_l) * (1 - ABNORMAL_DEVIATION) ? 'ABNORMAL' : 'OK',
    };
  });
  return {
    title: 'Fleet Dashboard', orientation: 'landscape',
    meta: { filters: filtersText({ ...q, from }, { org: profile.reportLine }), org: profile },
    columns: [
      { key: 'registration', label: 'Registration', width: 14 },
      { key: 'vehicle', label: 'Vehicle', width: 20 },
      { key: 'litres', label: 'Fuel (L)', type: 'number', width: 10 },
      { key: 'cost', label: `Fuel Cost (${profile.currency})`, type: 'money', width: 13 },
      { key: 'distance', label: 'Distance (km)', type: 'number', width: 13 },
      { key: 'km_per_l', label: 'KM/L', type: 'number', width: 9 },
      { key: 'flag', label: 'Consumption', width: 12 },
    ],
    rows: topRows,
    summary: [
      { label: 'Active Vehicles', value: String(vehBy.ACTIVE || 0) },
      { label: 'In Maintenance / Accident', value: String((vehBy.MAINTENANCE || 0) + (vehBy.ACCIDENT || 0)) },
      { label: 'Retired / Sold / Disposed', value: String((vehBy.RETIRED || 0) + (vehBy.SOLD || 0) + (vehBy.DISPOSED || 0)) },
      { label: 'Fuel — Station Issues', value: `${intL.toLocaleString(undefined, { maximumFractionDigits: 2 })} L` },
      { label: 'Fuel — External Purchases', value: `${extL.toLocaleString(undefined, { maximumFractionDigits: 2 })} L` },
      { label: 'Fuel Cost (all sources)', value: `${profile.currency} ${(intC + extC).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` },
      { label: 'Trips (period)', value: `${String(Number(tripsAgg.rows[0].n))} · ${tripD.toLocaleString(undefined, { maximumFractionDigits: 0 })} km` },
      { label: 'Trip Revenue (where recorded)', value: `${profile.currency} ${tripR.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` },
      { label: 'Tires on Vehicles / In Store', value: `${Number(tiresAgg.rows[0].on_vehicles)} / ${Number(tiresAgg.rows[0].in_store)}` },
      { label: 'Fleet KM/L (fills with odometer)', value: fuelAll ? '—' : '—' },
    ],
    totals: { fuel_litres: +fuelAll.toFixed(2), fuel_cost: +(intC + extC).toFixed(2) },
    total: topRows.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Wave-2 reports (§45): tire imports, supplier statement/aging, tire
// inventory, wheel configurations. All derive from authoritative tables —
// no duplicate financial records (§20/§48).
// ─────────────────────────────────────────────────────────────────────────────
export async function tireImports(q) {
  const params = [];
  const where = [];
  where.push(...dateFilters(q, params, 'b.created_at'));
  const profile = await orgProfile();
  const { rows } = await pool.query(
    `SELECT b.id, b.file_name, b.created_at, u.name AS user_name, b.total_rows,
            b.created_count, b.failed_count, b.skipped_count, b.status
       FROM tire_import_batches b LEFT JOIN users u ON u.id = b.imported_by
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY b.created_at DESC LIMIT 500`, params);
  const data = rows.map((r) => ({
    import_id: r.id, file: r.file_name, date: r.created_at, user: r.user_name || '—',
    rows: Number(r.total_rows), successful: Number(r.created_count),
    failed: Number(r.failed_count), skipped: Number(r.skipped_count), status: r.status,
  }));
  return {
    title: 'Tire Import Report', orientation: 'landscape',
    meta: { filters: filtersText(q, {}), org: profile },
    columns: [
      { key: 'import_id', label: 'Import ID', width: 30 },
      { key: 'file', label: 'File', width: 22 },
      { key: 'date', label: 'Date', type: 'datetime', width: 19 },
      { key: 'user', label: 'User', width: 15 },
      { key: 'rows', label: 'Rows', type: 'number', width: 8 },
      { key: 'successful', label: 'Successful', type: 'number', width: 11 },
      { key: 'failed', label: 'Failed', type: 'number', width: 9 },
      { key: 'skipped', label: 'Skipped', type: 'number', width: 9 },
      { key: 'status', label: 'Status', width: 12 },
    ],
    rows: data,
    summary: [
      { label: 'Imports', value: String(data.length) },
      { label: 'Total Rows', value: String(data.reduce((a, r) => a + r.rows, 0)) },
      { label: 'Imported', value: String(data.reduce((a, r) => a + r.successful, 0)) },
      { label: 'Failed', value: String(data.reduce((a, r) => a + r.failed, 0)) },
    ],
    totals: null, total: data.length,
  };
}

/** §27/§45/§46 — supplier statement with opening + period + closing balance. */
export async function supplierStatement(q) {
  if (!q.supplier_id || !/^[0-9a-f-]{36}$/i.test(String(q.supplier_id))) throw bad('supplier_id is required');
  const params = [String(q.supplier_id)];
  const { rows: sup } = await pool.query('SELECT * FROM suppliers WHERE id = $1', params);
  if (!sup.length) throw bad('Supplier not found');
  const period = [];
  if (q.from) { params.push(String(q.from)); period.push(`l.entry_date >= $${params.length}::date`); }
  if (q.to) { params.push(String(q.to)); period.push(`l.entry_date <= $${params.length}::date`); }
  const profile = await orgProfile();

  let opening = 0;
  if (q.from) {
    const { rows: op } = await pool.query(
      `SELECT COALESCE(SUM(debit - credit),0)::float AS opening FROM supplier_ledger_entries
        WHERE supplier_id = $1 AND entry_date < $2::date`, [String(q.supplier_id), String(q.from)]);
    opening = Number(op[0].opening) || 0;
  }
  // §46 — deterministic chronological order; running balance computed in order.
  const { rows } = await pool.query(
    `SELECT l.* FROM supplier_ledger_entries l
      WHERE l.supplier_id = $1 ${period.length ? 'AND ' + period.join(' AND ') : ''}
      ORDER BY l.entry_date ASC, l.created_at ASC, l.id ASC`, params);
  let running = opening;
  let totD = 0; let totC = 0;
  const data = rows.map((r) => {
    running += Number(r.debit) - Number(r.credit);
    totD += Number(r.debit); totC += Number(r.credit);
    return {
      date: r.entry_date, reference: r.reference || '—', type: r.entry_type,
      particulars: r.description || '—',
      debit: Number(r.debit) || null, credit: Number(r.credit) || null,
      balance: +running.toFixed(2),
    };
  });
  return {
    title: `Supplier Statement — ${sup[0].name}`, orientation: 'landscape',
    meta: { filters: filtersText(q, { supplier_id: 'Supplier' }), org: profile },
    columns: [
      { key: 'date', label: 'Date', type: 'date', width: 12 },
      { key: 'reference', label: 'Reference', width: 16 },
      { key: 'type', label: 'Type', width: 16 },
      { key: 'particulars', label: 'Particulars', width: 34 },
      { key: 'debit', label: `Debit (${profile.currency})`, type: 'money', width: 14 },
      { key: 'credit', label: `Credit (${profile.currency})`, type: 'money', width: 14 },
      { key: 'balance', label: `Balance (${profile.currency})`, type: 'money', width: 14 },
    ],
    rows: data,
    summary: [
      { label: 'Opening Balance', value: `${profile.currency} ${opening.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` },
      { label: 'Purchases/Debits (period)', value: `${profile.currency} ${totD.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` },
      { label: 'Payments/Credits (period)', value: `${profile.currency} ${totC.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` },
      { label: 'Closing Balance', value: `${profile.currency} ${running.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` },
    ],
    totals: { debit: +totD.toFixed(2), credit: +totC.toFixed(2), closing: +running.toFixed(2), opening: +opening.toFixed(2) },
    total: data.length,
  };
}

/** §28/§45 — supplier aging: current, 1–30, 31–60, 61–90, 90+ from invoice
 *  dates + payment terms, against unallocated invoice balances. */
export async function supplierAging(q) {
  const profile = await orgProfile();
  const { rows } = await pool.query(
    `SELECT s.id, s.code, s.name, s.payment_terms_days,
            (SELECT COALESCE(SUM(debit - credit),0)::float FROM supplier_ledger_entries WHERE supplier_id = s.id) AS balance
       FROM suppliers s WHERE s.status = 'ACTIVE' ORDER BY s.name`);
  const { rows: inv } = await pool.query(
    `SELECT l.supplier_id, l.entry_date, (l.debit - COALESCE(a.allocated,0))::float AS outstanding
       FROM supplier_ledger_entries l
       LEFT JOIN (SELECT ledger_entry_id, SUM(amount)::float AS allocated FROM supplier_payment_allocations GROUP BY ledger_entry_id) a
         ON a.ledger_entry_id = l.id
      WHERE l.entry_type = 'PURCHASE' AND l.debit - COALESCE(a.allocated,0) > 0.005`);
  const bySup = {};
  for (const i of inv) (bySup[i.supplier_id] = bySup[i.supplier_id] || []).push(i);
  const data = rows.map((s) => {
    const buckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90: 0 };
    const today = new Date();
    for (const i of bySup[s.id] || []) {
      const due = new Date(i.entry_date);
      due.setDate(due.getDate() + (s.payment_terms_days ?? 30));
      const days = Math.floor((today - due) / 86400000);
      if (days <= 0) buckets.current += Number(i.outstanding);
      else if (days <= 30) buckets.d1_30 += Number(i.outstanding);
      else if (days <= 60) buckets.d31_60 += Number(i.outstanding);
      else if (days <= 90) buckets.d61_90 += Number(i.outstanding);
      else buckets.d90 += Number(i.outstanding);
    }
    const r5 = (x) => +x.toFixed(2);
    return {
      code: s.code || '—', supplier: s.name,
      current: r5(buckets.current), d1_30: r5(buckets.d1_30), d31_60: r5(buckets.d31_60),
      d61_90: r5(buckets.d61_90), d90: r5(buckets.d90),
      total_balance: r5(Number(s.balance) || 0),
    };
  });
  const sum = (k) => data.reduce((a, r) => a + r[k], 0);
  return {
    title: 'Supplier Aging', orientation: 'landscape',
    meta: { filters: filtersText(q, {}), org: profile },
    columns: [
      { key: 'code', label: 'Code', width: 10 },
      { key: 'supplier', label: 'Supplier', width: 26 },
      { key: 'current', label: 'Current', type: 'money', width: 13 },
      { key: 'd1_30', label: '1–30 Days', type: 'money', width: 13 },
      { key: 'd31_60', label: '31–60 Days', type: 'money', width: 13 },
      { key: 'd61_90', label: '61–90 Days', type: 'money', width: 13 },
      { key: 'd90', label: '90+ Days', type: 'money', width: 13 },
      { key: 'total_balance', label: 'Balance', type: 'money', width: 14 },
    ],
    rows: data,
    summary: [
      { label: 'Suppliers', value: String(data.length) },
      { label: 'Total Outstanding', value: `${profile.currency} ${(sum('current') + sum('d1_30') + sum('d31_60') + sum('d61_90') + sum('d90')).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` },
      { label: 'Overdue (1–30)', value: `${profile.currency} ${sum('d1_30').toLocaleString()}` },
      { label: 'Overdue (90+)', value: `${profile.currency} ${sum('d90').toLocaleString()}` },
    ],
    totals: null, total: data.length,
  };
}

/** §45 — tire inventory: serial, brand, size, status, vehicle, position, supplier, cost. */
export async function tireInventory(q) {
  const params = [];
  const where = [];
  if (q.status) { params.push(String(q.status).toUpperCase()); where.push(`t.status = $${params.length}`); }
  const profile = await orgProfile();
  const { rows } = await pool.query(
    `SELECT t.*, v.plate AS current_plate
       FROM tires t LEFT JOIN vehicles v ON v.id = t.current_vehicle_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY t.serial_no`, params);
  const data = rows.map((r) => ({
    serial: r.serial_no, brand: r.brand || '—', size: r.size || '—', status: r.status,
    vehicle: r.current_plate || null, position: r.current_position || null,
    supplier: r.supplier || '—', cost: r.purchase_cost != null ? Number(r.purchase_cost) : null,
    mileage: Number(r.mileage_accumulated) || 0,
  }));
  return {
    title: 'Tire Inventory', orientation: 'landscape',
    meta: { filters: filtersText(q, { status: 'Status' }), org: profile },
    columns: [
      { key: 'serial', label: 'Serial', width: 16 },
      { key: 'brand', label: 'Brand', width: 12 },
      { key: 'size', label: 'Size', width: 10 },
      { key: 'status', label: 'Status', width: 14 },
      { key: 'vehicle', label: 'Vehicle', width: 12 },
      { key: 'position', label: 'Position', width: 9 },
      { key: 'supplier', label: 'Supplier', width: 18 },
      { key: 'cost', label: `Cost (${profile.currency})`, type: 'money', width: 13 },
      { key: 'mileage', label: 'Mileage (km)', type: 'number', width: 12 },
    ],
    rows: data,
    summary: [
      { label: 'Tires', value: String(data.length) },
      { label: 'On Vehicles', value: String(data.filter((r) => r.status === 'ON_VEHICLE').length) },
      { label: 'In Store', value: String(data.filter((r) => ['IN_STORE', 'USED_STORE'].includes(r.status)).length) },
    ],
    totals: null, total: data.length,
  };
}

/** §45 — wheel configuration report: configuration, axles, wheel count, active vehicles. */
export async function wheelConfigsReport(q) {
  const profile = await orgProfile();
  const { rows } = await pool.query(
    `SELECT w.*, 
            (SELECT COUNT(*)::int FROM vehicles v WHERE v.wheel_configuration_id = w.id) AS vehicles_total,
            (SELECT COUNT(*)::int FROM vehicles v WHERE v.wheel_configuration_id = w.id AND v.status = 'ACTIVE') AS active_vehicles
       FROM wheel_configurations w ORDER BY w.is_system DESC, w.code`);
  const data = rows.map((r) => ({
    configuration: r.code, name: r.name, axles: Number(r.axles), wheel_count: Number(r.wheel_count),
    active_vehicles: Number(r.active_vehicles), vehicles_total: Number(r.vehicles_total),
    state: r.is_active ? 'Active' : 'Inactive', system: r.is_system ? 'System' : 'Custom',
  }));
  return {
    title: 'Wheel Configurations', orientation: 'landscape',
    meta: { filters: filtersText(q, {}), org: profile },
    columns: [
      { key: 'configuration', label: 'Configuration', width: 14 },
      { key: 'name', label: 'Name', width: 20 },
      { key: 'axles', label: 'Axles', type: 'number', width: 8 },
      { key: 'wheel_count', label: 'Wheels', type: 'number', width: 9 },
      { key: 'active_vehicles', label: 'Active Vehicles', type: 'number', width: 14 },
      { key: 'vehicles_total', label: 'All Vehicles', type: 'number', width: 12 },
      { key: 'state', label: 'State', width: 9 },
      { key: 'system', label: 'Origin', width: 9 },
    ],
    rows: data,
    summary: [
      { label: 'Configurations', value: String(data.length) },
      { label: 'Active', value: String(data.filter((r) => r.state === 'Active').length) },
      { label: 'Vehicles Mapped', value: String(data.reduce((a, r) => a + r.vehicles_total, 0)) },
    ],
    totals: null, total: data.length,
  };
}

/** Approval history (§§13/§20) — the immutable trail of every approval
 *  decision, from `approvals` + `approval_events` (append-only). No derived
 *  rows: each output line IS a real decision event. */
export async function approvalHistory(q) {
  const profile = await orgProfile();
  const params = [];
  const where = ['1=1'];
  if (q.from) { params.push(String(q.from)); where.push(`a.decided_at >= $${params.length}::date`); }
  if (q.to) { params.push(String(q.to)); where.push(`(a.decided_at < ($${params.length}::date + interval '1 day'))`); }
  const { rows } = await pool.query(
    `SELECT a.entity_type, a.approval_type, a.status, a.decision, a.reason,
            a.previous_status, a.new_status, a.quantity, a.decided_at, a.created_at,
            fr.request_no, v.plate,
            ru.name  AS requested_by_name,
            du.name  AS decided_by_name,
            (SELECT json_agg(json_build_object('action', e.action, 'actor', au.name,
                                               'reason', e.reason, 'at', e.created_at)
                             ORDER BY e.created_at, e.id)
               FROM approval_events e LEFT JOIN users au ON au.id = e.actor_id
              WHERE e.approval_id = a.id) AS events
       FROM approvals a
       LEFT JOIN fuel_requests fr ON a.entity_type = 'fuel_request' AND fr.id = a.entity_id
       LEFT JOIN vehicles v ON fr.vehicle_id = v.id
       LEFT JOIN users ru ON ru.id = a.requested_by
       LEFT JOIN users du ON du.id = a.decided_by
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(a.decided_at, a.created_at) DESC, a.id DESC`, params);
  const data = rows.map((r) => ({
    when: new Date(r.decided_at ?? r.created_at).toISOString().replace('T', ' ').slice(0, 16),
    request: r.request_no || `${r.entity_type}:${String(r.entity_id).slice(0, 8)}`,
    plate: r.plate || '',
    requested_by: r.requested_by_name || '',
    status: r.status || '',
    decision: r.decision || '',
    decided_by: r.decided_by_name || '',
    reason: r.reason || '',
    events: (r.events || []).map((e) => `${e.action}${e.actor ? ' by ' + e.actor : ''}`).join(' → '),
  }));
  const decided = data.filter((r) => r.decision);
  return {
    title: 'Approval History', orientation: 'landscape',
    meta: { filters: filtersText(q, {}), org: profile },
    columns: [
      { key: 'when', label: 'When', width: 17 },
      { key: 'request', label: 'Request', width: 18 },
      { key: 'plate', label: 'Vehicle', width: 10 },
      { key: 'requested_by', label: 'Requested By', width: 16 },
      { key: 'status', label: 'Status', width: 11 },
      { key: 'decision', label: 'Decision', width: 11 },
      { key: 'decided_by', label: 'Decided By', width: 16 },
      { key: 'reason', label: 'Reason / Comment', width: 34 },
      { key: 'events', label: 'Event Trail', width: 40 },
    ],
    rows: data,
    summary: [
      { label: 'Decisions', value: String(decided.length) },
      { label: 'Approved', value: String(data.filter((r) => /approv/i.test(r.decision)).length) },
      { label: 'Rejected', value: String(data.filter((r) => /reject/i.test(r.decision)).length) },
      { label: 'Pending', value: String(data.filter((r) => !r.decision).length) },
    ],
    totals: null, total: data.length,
  };
}
