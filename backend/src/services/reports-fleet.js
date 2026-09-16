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
     WHERE t.status = 'completed' AND t.odometer IS NOT NULL
    UNION ALL
    SELECT e.vehicle_id, e.transaction_date, e.quantity::float,
           e.unit_price::float, e.odometer::float,
           'EXTERNAL PURCHASE', COALESCE(e.receipt_no, '—'), u.name,
           v.plate, v.make, v.model, v.expected_km_l::float
      FROM external_fuel_entries e
      JOIN vehicles v ON v.id = e.vehicle_id
      LEFT JOIN users u ON u.id = e.entered_by
     WHERE e.odometer IS NOT NULL
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
      odometer: Number(r.odometer), distance, litres,
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
