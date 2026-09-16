// ============================================================================
// Report builders (§9–§18). Every builder returns a DATASET:
//   { title, orientation, columns:[{key,label,type,width}],
//     rows, totals:{...}|null, summary:[{label,value}], meta:{filters} }
// Exporters (CSV/XLSX/PDF) and JSON endpoints consume the same shape, so the
// screen and the file ALWAYS contain the same filtered data (§44).
//
// Ledger math (§12/§16): running balance = base (all valid entries before
// Date From, per fuel type) + window sum over the filtered period — computed
// entirely in SQL, so pagination can never reset or falsify it.
// ============================================================================
import { pool } from '../db/pool.js';
import { bad } from '../middleware/errors.js';

const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
const uuidParam = (v, name) => {
  if (!isUuid(v)) throw bad(`${name} must be a valid id`);
  return String(v);
};
const dayStart = (v, name) => {
  const d = new Date(v);
  if (isNaN(d.getTime())) throw bad(`${name} must be a date (YYYY-MM-DD)`);
  return d.toISOString();
};

// Display mapping §11 — the DB stores the five physical entry types.
const ENTRY_TYPE_LABEL = {
  opening: 'OPENING_BALANCE',
  receipt: 'BULK_RECEIPT',
  issue: 'FUEL_ISSUE',
  adjustment: 'ADJUSTMENT', // refined to _IN/_OUT per row by quantity sign
  reversal: 'REVERSAL',
};
export const LEDGER_ENTRY_TYPES = Object.keys(ENTRY_TYPE_LABEL);

/** Org identity + currency from settings (§3/§7) — never hard-coded. */
export async function orgProfile() {
  const { rows } = await pool.query(`SELECT key, value FROM settings WHERE key IN ('org.name','org.report.line','currency')`);
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    orgName: map['org.name'] || 'Fleet Fuel',
    reportLine: map['org.report.line'] || 'Fleet Fuel Management System',
    currency: map['currency'] || 'KES',
  };
}

function dateFilters(q, params, alias = 'it.created_at') {
  const where = [];
  if (q.from) { params.push(dayStart(q.from, 'from')); where.push(`${alias} >= $${params.length}`); }
  if (q.to) { params.push(dayStart(q.to, 'to')); where.push(`${alias} < ($${params.length}::timestamptz + interval '1 day')`); }
  return where;
}
function filtersText(q, labels) {
  return Object.entries(labels)
    .filter(([k]) => q[k])
    .map(([k, label]) => `${label}: ${q[k]}`)
    .concat([`Date From: ${q.from || '—'}`, `Date To: ${q.to || '—'}`]);
}

// ─────────────────────────────────────────────────────────────────────────────
// FUEL LEDGER (§10–§16) — accounting view over inventory_transactions.
// ─────────────────────────────────────────────────────────────────────────────
export async function fuelLedger(q, { page = 1, pageSize = 50 } = {}) {
  const params = [];
  const where = [];

  if (q.fuel_type_id) { params.push(uuidParam(q.fuel_type_id, 'fuel_type_id')); where.push(`it.fuel_type_id = $${params.length}`); }
  if (q.tank_id) { params.push(uuidParam(q.tank_id, 'tank_id')); where.push(`it.tank_id = $${params.length}`); }
  if (q.entry_type) {
    if (!LEDGER_ENTRY_TYPES.includes(String(q.entry_type))) throw bad('Unknown entry type');
    params.push(String(q.entry_type)); where.push(`it.entry_type = $${params.length}`);
  }
  if (q.vehicle_id) {
    params.push(uuidParam(q.vehicle_id, 'vehicle_id'));
    where.push(`(ftx.vehicle_id = $${params.length} OR EXISTS (SELECT 1 FROM fuel_transactions fx2 WHERE fx2.id = it.ref_id AND it.ref_table = 'fuel_transactions' AND fx2.vehicle_id = $${params.length}))`);
  }
  where.push(...dateFilters(q, params));
  if (q.q) {
    params.push(`%${String(q.q).trim()}%`);
    where.push(`(ftx.txn_no ILIKE $${params.length} OR p.receipt_no ILIKE $${params.length} OR v.plate ILIKE $${params.length} OR it.description ILIKE $${params.length})`);
  }
  const WHERE = where.length ? 'WHERE ' + where.join(' AND ') : '';

  // Opening base per fuel type: everything before Date From (unfiltered by
  // in-range row filters, but respecting the fuel-type filter §12).
  // Opening base per fuel type = all valid entries BEFORE Date From (§12).
  // No Date From → the period starts at zero (nothing is excluded).
  const baseParams = [];
  let baseWhere = '';
  if (q.fuel_type_id) { baseParams.push(String(q.fuel_type_id)); baseWhere = 'AND it.fuel_type_id = $1'; }
  let baseFromSql;
  if (q.from) {
    baseParams.push(dayStart(q.from, 'from'));
    baseFromSql = `SELECT it.fuel_type_id, COALESCE(SUM(it.quantity),0)::float AS base
                     FROM inventory_transactions it
                    WHERE true ${baseWhere} AND it.created_at < $${baseParams.length}
                    GROUP BY it.fuel_type_id`;
  } else {
    baseFromSql = `SELECT id AS fuel_type_id, 0::float AS base FROM fuel_types`;
  }

  page = Math.max(1, Number(page) || 1);
  pageSize = Math.min(Math.max(1, Number(pageSize) || 50), 500);

  const [rowsRes, countRes, sumRes, baseRes, profile] = await Promise.all([
    pool.query(
      `WITH base AS (${baseFromSql}),
       scoped AS (
         SELECT it.id, it.entry_type, it.fuel_type_id, it.tank_id, it.quantity::float AS quantity,
                it.ref_table, it.ref_id, it.description, it.created_at,
                it.performed_by,
                COALESCE(b.base, 0)::float AS base
           FROM inventory_transactions it
           LEFT JOIN base b ON b.fuel_type_id = it.fuel_type_id
           LEFT JOIN purchases p ON it.ref_table = 'purchases' AND p.id = it.ref_id
           LEFT JOIN fuel_transactions ftx ON it.ref_table = 'fuel_transactions' AND ftx.id = it.ref_id
           LEFT JOIN vehicles v ON v.id = ftx.vehicle_id
          ${WHERE}
       ),
       numbered AS (
         SELECT s.*,
                SUM(s.quantity) OVER (PARTITION BY s.fuel_type_id ORDER BY s.created_at, s.id
                                      ROWS UNBOUNDED PRECEDING) + s.base AS running_balance
           FROM scoped s
       )
       SELECT n.*,
              ft.name AS fuel_type_name, ft.code AS fuel_type_code,
              t.name AS tank_name,
              u.name AS performed_by_name,
              ftx.txn_no, ftx.status AS txn_status, ftx.unit_price, ftx.odometer, ftx.id AS txn_id,
              ftxr.request_no,
              p.receipt_no, p.supplier, p.unit_price AS purchase_unit_price, p.invoice_no,
              v.plate,
              pu.name AS pump_name,
              ax.status AS excess_status
         FROM numbered n
         JOIN fuel_types ft ON ft.id = n.fuel_type_id
         LEFT JOIN tanks t ON t.id = n.tank_id
         LEFT JOIN users u ON u.id = n.performed_by
         LEFT JOIN fuel_transactions ftx ON n.ref_table = 'fuel_transactions' AND ftx.id = n.ref_id
         LEFT JOIN fuel_requests ftxr ON ftxr.id = ftx.request_id
         LEFT JOIN purchases p ON n.ref_table = 'purchases' AND p.id = n.ref_id
         LEFT JOIN vehicles v ON v.id = ftx.vehicle_id
         LEFT JOIN pumps pu ON pu.id = ftx.pump_id
         LEFT JOIN LATERAL (
           SELECT a.status FROM approvals a
            WHERE a.entity_type = 'fuel_excess' AND a.entity_id = ftx.id
            ORDER BY a.created_at DESC LIMIT 1
         ) ax ON true
         ORDER BY n.created_at ASC, n.id ASC
         LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      params,
    ),
    pool.query(`SELECT count(*)::int AS n
                  FROM inventory_transactions it
                  LEFT JOIN purchases p ON it.ref_table = 'purchases' AND p.id = it.ref_id
                  LEFT JOIN fuel_transactions ftx ON it.ref_table = 'fuel_transactions' AND ftx.id = it.ref_id
                  LEFT JOIN vehicles v ON v.id = ftx.vehicle_id
                 ${WHERE}`, params),
    pool.query(`SELECT COALESCE(SUM(it.quantity) FILTER (WHERE it.quantity > 0), 0)::float AS qty_in,
                       COALESCE(-SUM(it.quantity) FILTER (WHERE it.quantity < 0), 0)::float AS qty_out,
                       COALESCE(SUM(it.quantity) FILTER (WHERE it.entry_type = 'receipt'), 0)::float AS receipts,
                       COALESCE(-SUM(it.quantity) FILTER (WHERE it.entry_type = 'issue'), 0)::float AS issues,
                       COALESCE(SUM(it.quantity) FILTER (WHERE it.entry_type = 'adjustment'), 0)::float AS adjustments,
                       COALESCE(SUM(it.quantity) FILTER (WHERE it.entry_type = 'reversal'), 0)::float AS reversals
                  FROM inventory_transactions it
                  LEFT JOIN purchases p ON it.ref_table = 'purchases' AND p.id = it.ref_id
                  LEFT JOIN fuel_transactions ftx ON it.ref_table = 'fuel_transactions' AND ftx.id = it.ref_id
                  LEFT JOIN vehicles v ON v.id = ftx.vehicle_id
                 ${WHERE}`, params),
    pool.query(baseFromSql, baseParams),
    orgProfile(),
  ]);

  const opening = baseRes.rows.reduce((a, r) => a + Number(r.base), 0);
  const s = sumRes.rows[0];
  const total = countRes.rows[0].n;
  const lastRunning = rowsRes.rows.length
    ? Number(rowsRes.rows[rowsRes.rows.length - 1].running_balance)
    : opening;
  // Closing for the CURRENT page window = last running balance on the page.
  // The authoritative period closing (all rows) comes from summary below.

  const rows = rowsRes.rows.map((r) => {
    const qtyIn = Number(r.quantity) > 0 ? Number(r.quantity) : 0;
    const qtyOut = Number(r.quantity) < 0 ? -Number(r.quantity) : 0;
    const type = r.entry_type === 'adjustment' ? (qtyIn > 0 ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT') : ENTRY_TYPE_LABEL[r.entry_type];
    const unitCost = r.entry_type === 'receipt' ? (r.purchase_unit_price != null ? Number(r.purchase_unit_price) : null)
      : r.entry_type === 'issue' ? (r.unit_price != null ? Number(r.unit_price) : null)
      : null;
    const amount = unitCost != null ? unitCost * qtyOut || unitCost * qtyIn || 0 : null;
    return {
      id: r.id,
      date: r.created_at,
      reference: r.txn_no || r.receipt_no || `LT-${String(r.id).slice(0, 8).toUpperCase()}`,
      particulars: r.description || (r.txn_no ? `Fuel issue against ${r.request_no || r.txn_no}` : r.receipt_no ? `Bulk receipt — ${r.supplier || 'supplier'}` : type),
      fuel_type: r.fuel_type_name,
      entry_type: type,
      raw_type: r.entry_type,
      qty_in: qtyIn,
      qty_out: qtyOut,
      running_balance: Number(r.running_balance),
      unit_cost: unitCost,
      amount: amount != null && Number.isFinite(amount) ? amount : null,
      vehicle: r.plate || null,
      pump: r.pump_name || null,
      tank: r.tank_name || null,
      user: r.performed_by_name || null,
      status: r.txn_status || 'posted',
      excess_status: r.excess_status || null,
      txn_id: r.txn_id || null,
    };
  });

  const periodIn = Number(s.qty_in);
  const periodOut = Number(s.qty_out);
  const closingAll = opening + periodIn - periodOut;

  return {
    title: 'Fuel Ledger',
    orientation: 'landscape',
    meta: { filters: filtersText(q, { fuel_type_id: 'Fuel Type', tank_id: 'Tank', entry_type: 'Transaction Type', vehicle_id: 'Vehicle', q: 'Search' }), org: profile },
    columns: [
      { key: 'date', label: 'Date', type: 'datetime', width: 19 },
      { key: 'reference', label: 'Reference', width: 14 },
      { key: 'particulars', label: 'Particulars', width: 34 },
      { key: 'fuel_type', label: 'Fuel Type', width: 12 },
      { key: 'entry_type', label: 'Transaction Type', width: 18 },
      { key: 'qty_in', label: 'Qty In (L)', type: 'number', width: 11 },
      { key: 'qty_out', label: 'Qty Out (L)', type: 'number', width: 11 },
      { key: 'running_balance', label: 'Running Balance (L)', type: 'number', width: 17 },
      { key: 'unit_cost', label: `Unit Cost (${profile.currency})`, type: 'money', width: 13 },
      { key: 'amount', label: `Amount (${profile.currency})`, type: 'money', width: 13 },
      { key: 'vehicle', label: 'Vehicle', width: 12 },
      { key: 'pump', label: 'Pump', width: 12 },
      { key: 'tank', label: 'Tank', width: 14 },
      { key: 'user', label: 'User', width: 14 },
      { key: 'status', label: 'Status', width: 10 },
      { key: 'excess_status', label: 'Excess Approval', width: 13 },
    ],
    rows,
    summary: [
      { label: 'Opening Balance', value: `${opening.toLocaleString()} L` },
      { label: 'Total In', value: `${periodIn.toLocaleString()} L` },
      { label: 'Total Out', value: `${periodOut.toLocaleString()} L` },
      { label: 'Closing Balance', value: `${closingAll.toLocaleString()} L` },
      { label: 'Transactions', value: String(total) },
      { label: 'Page Closing (this page)', value: `${lastRunning.toLocaleString()} L` },
    ],
    totals: {
      qty_in: periodIn, qty_out: periodOut,
      running_balance: closingAll,
    },
    page, pageSize, total,
    openingBalance: opening,
    closingBalance: closingAll,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// VEHICLE FUEL LEDGER (§18) — consumption & cost per fill-up.
// ─────────────────────────────────────────────────────────────────────────────
export async function vehicleLedger(q) {
  const params = [];
  const where = [`t.status IN ('completed','reversed')`, `t.odometer IS NOT NULL`];
  if (q.vehicle_id) { params.push(uuidParam(q.vehicle_id, 'vehicle_id')); where.push(`t.vehicle_id = $${params.length}`); }
  where.push(...dateFilters(q, params, 't.created_at'));
  const profile = await orgProfile();

  const { rows } = await pool.query(
    `WITH fills AS (
       SELECT t.id, t.created_at, t.quantity::float AS litres, t.odometer::float AS odometer,
              t.unit_price::float AS unit_price, t.status, t.source, t.destination,
              u.name AS entered_by, v.plate, v.make, v.model,
              LAG(t.odometer::float) OVER (PARTITION BY t.vehicle_id ORDER BY t.odometer, t.created_at) AS prev_odo
         FROM fuel_transactions t
         JOIN vehicles v ON v.id = t.vehicle_id
         LEFT JOIN users u ON u.id = t.operator_id
        ${'WHERE ' + where.join(' AND ')}
     )
     SELECT f.*, (f.odometer - f.prev_odo) AS distance
       FROM fills f
      ORDER BY f.plate, f.odometer`, params);

  const data = rows.map((r) => {
    const distance = Number(r.distance) > 0 ? Number(r.distance) : null;
    const cost = r.unit_price != null ? r.unit_price * Number(r.litres) : null;
    return {
      id: r.id,
      date: r.created_at,
      vehicle: [r.make, r.model].filter(Boolean).join(' ') || null,
      registration: r.plate,
      odometer: Number(r.odometer),
      distance,
      litres: Number(r.litres),
      km_per_l: distance ? +(distance / Number(r.litres)).toFixed(2) : null,
      l_per_100km: distance ? +((Number(r.litres) / distance) * 100).toFixed(2) : null,
      unit_cost: r.unit_price,
      fuel_cost: cost,
      cost_per_km: distance && cost ? +(cost / distance).toFixed(2) : null,
      status: r.status,
      source: r.source,
      destination: r.destination,
      entered_by: r.entered_by,
    };
  });
  const totL = data.reduce((a, r) => a + r.litres, 0);
  const totD = data.reduce((a, r) => a + (r.distance || 0), 0);
  const totC = data.reduce((a, r) => a + (r.fuel_cost || 0), 0);

  return {
    title: 'Vehicle Fuel Ledger',
    orientation: 'landscape',
    meta: { filters: filtersText(q, { vehicle_id: 'Vehicle' }), org: profile },
    columns: [
      { key: 'date', label: 'Date', type: 'datetime', width: 19 },
      { key: 'registration', label: 'Registration', width: 14 },
      { key: 'vehicle', label: 'Vehicle', width: 20 },
      { key: 'odometer', label: 'Odometer (km)', type: 'number', width: 13 },
      { key: 'distance', label: 'Distance (km)', type: 'number', width: 13 },
      { key: 'litres', label: 'Fuel (L)', type: 'number', width: 10 },
      { key: 'km_per_l', label: 'KM/L', type: 'number', width: 9 },
      { key: 'l_per_100km', label: 'L/100KM', type: 'number', width: 10 },
      { key: 'unit_cost', label: `Unit Cost (${profile.currency})`, type: 'money', width: 13 },
      { key: 'fuel_cost', label: `Fuel Cost (${profile.currency})`, type: 'money', width: 14 },
      { key: 'cost_per_km', label: `Cost/KM (${profile.currency})`, type: 'money', width: 13 },
      { key: 'status', label: 'Status', width: 10 },
      { key: 'source', label: 'Source', width: 17 },
      { key: 'destination', label: 'Destination', width: 16 },
      { key: 'entered_by', label: 'Entered By', width: 15 },
    ],
    rows: data,
    summary: [
      { label: 'Fill-ups', value: String(data.length) },
      { label: 'Total Fuel', value: `${totL.toLocaleString(undefined, { maximumFractionDigits: 2 })} L` },
      { label: 'Total Distance', value: `${totD.toLocaleString(undefined, { maximumFractionDigits: 0 })} km` },
      { label: `Total Fuel Cost`, value: `${profile.currency} ${totC.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` },
      { label: 'Fleet KM/L', value: totL ? (totD / totL).toFixed(2) : '—' },
    ],
    totals: { litres: +totL.toFixed(2), distance: totD, fuel_cost: +totC.toFixed(2) },
    total: data.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Daily fuel (per day, per fuel type) + bulk purchases + transactions + audit.
// ─────────────────────────────────────────────────────────────────────────────
export async function dailyFuel(q) {
  const params = [];
  const where = [];
  if (q.fuel_type_id) { params.push(uuidParam(q.fuel_type_id, 'fuel_type_id')); where.push(`it.fuel_type_id = $${params.length}`); }
  where.push(...dateFilters(q, params));
  const profile = await orgProfile();
  const { rows } = await pool.query(
    `SELECT date_trunc('day', it.created_at)::date AS day, ft.name AS fuel_type,
            COALESCE(SUM(it.quantity) FILTER (WHERE it.entry_type = 'receipt'), 0)::float AS received,
            COALESCE(-SUM(it.quantity) FILTER (WHERE it.entry_type = 'issue'), 0)::float AS issued,
            COALESCE(SUM(it.quantity) FILTER (WHERE it.entry_type = 'adjustment'), 0)::float AS adjustments,
            COALESCE(SUM(it.quantity) FILTER (WHERE it.entry_type = 'reversal'), 0)::float AS reversals,
            (SELECT b2.bal FROM (SELECT it2.fuel_type_id, SUM(it2.quantity)::float AS bal
              FROM inventory_transactions it2 WHERE it2.created_at < date_trunc('day', it.created_at) + interval '1 day'
              GROUP BY it2.fuel_type_id) b2 WHERE b2.fuel_type_id = it.fuel_type_id) AS closing
       FROM inventory_transactions it JOIN fuel_types ft ON ft.id = it.fuel_type_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      GROUP BY day, ft.name, ft.id, it.fuel_type_id, it.created_at
      ORDER BY day DESC, fuel_type`, params);
  const data = rows.map((r) => ({ day: r.day, fuel_type: r.fuel_type, received: Number(r.received), issued: Number(r.issued), adjustments: Number(r.adjustments), reversals: Number(r.reversals), closing: Number(r.closing) }));
  return {
    title: 'Daily Fuel', orientation: 'portrait',
    meta: { filters: filtersText(q, { fuel_type_id: 'Fuel Type' }), org: profile },
    columns: [
      { key: 'day', label: 'Date', type: 'date', width: 12 },
      { key: 'fuel_type', label: 'Fuel Type', width: 14 },
      { key: 'received', label: 'Received (L)', type: 'number', width: 12 },
      { key: 'issued', label: 'Issued (L)', type: 'number', width: 12 },
      { key: 'adjustments', label: 'Adjustments (L)', type: 'number', width: 14 },
      { key: 'reversals', label: 'Reversals (L)', type: 'number', width: 13 },
      { key: 'closing', label: 'Closing (L)', type: 'number', width: 12 },
    ],
    rows: data,
    totals: { received: +data.reduce((a, r) => a + r.received, 0).toFixed(2), issued: +data.reduce((a, r) => a + r.issued, 0).toFixed(2) },
    total: data.length,
  };
}

export async function bulkPurchases(q) {
  const params = [];
  const where = [];
  if (q.fuel_type_id) { params.push(uuidParam(q.fuel_type_id, 'fuel_type_id')); where.push(`p.fuel_type_id = $${params.length}`); }
  if (q.tank_id) { params.push(uuidParam(q.tank_id, 'tank_id')); where.push(`p.tank_id = $${params.length}`); }
  where.push(...dateFilters(q, params, 'p.created_at'));
  const profile = await orgProfile();
  const { rows } = await pool.query(
    `SELECT p.receipt_no, p.supplier, p.invoice_no, ft.name AS fuel_type, t.name AS tank,
            p.quantity::float AS quantity, p.unit_price::float AS unit_price,
            (p.quantity * COALESCE(p.unit_price, 0))::float AS amount,
            p.delivery_note, u.name AS received_by, p.created_at
       FROM purchases p
       JOIN fuel_types ft ON ft.id = p.fuel_type_id
       JOIN tanks t ON t.id = p.tank_id
       LEFT JOIN users u ON u.id = p.received_by
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY p.created_at DESC`, params);
  const data = rows.map((r) => ({ ...r, amount: Number(r.amount) }));
  const totQ = data.reduce((a, r) => a + Number(r.quantity), 0);
  const totA = data.reduce((a, r) => a + Number(r.amount), 0);
  return {
    title: 'Bulk Fuel Purchases', orientation: 'landscape',
    meta: { filters: filtersText(q, { fuel_type_id: 'Fuel Type', tank_id: 'Tank' }), org: profile },
    columns: [
      { key: 'created_at', label: 'Date', type: 'datetime', width: 19 },
      { key: 'receipt_no', label: 'Receipt No', width: 15 },
      { key: 'supplier', label: 'Supplier', width: 22 },
      { key: 'invoice_no', label: 'Invoice', width: 15 },
      { key: 'fuel_type', label: 'Fuel Type', width: 12 },
      { key: 'tank', label: 'Tank', width: 14 },
      { key: 'quantity', label: 'Quantity (L)', type: 'number', width: 12 },
      { key: 'unit_price', label: `Unit Price (${profile.currency})`, type: 'money', width: 13 },
      { key: 'amount', label: `Amount (${profile.currency})`, type: 'money', width: 14 },
      { key: 'received_by', label: 'Received By', width: 15 },
    ],
    rows: data,
    totals: { quantity: +totQ.toFixed(2), amount: +totA.toFixed(2) },
    total: data.length,
  };
}

export async function fuelTransactions(q) {
  const params = [];
  const where = [`t.status IN ('completed','reversed')`];
  if (q.vehicle_id) { params.push(uuidParam(q.vehicle_id, 'vehicle_id')); where.push(`t.vehicle_id = $${params.length}`); }
  if (q.fuel_type_id) { params.push(uuidParam(q.fuel_type_id, 'fuel_type_id')); where.push(`t.fuel_type_id = $${params.length}`); }
  if (q.source) { params.push(String(q.source).toUpperCase()); where.push(`t.source = $${params.length}`); }
  where.push(...dateFilters(q, params, 't.created_at'));
  const profile = await orgProfile();
  const { rows } = await pool.query(
    `SELECT t.txn_no, t.created_at, v.plate, ft.name AS fuel_type, p.name AS pump, t2.name AS tank,
            t.source, t.destination,
            t.quantity::float AS quantity, t.unit_price::float AS unit_price,
            (t.quantity * COALESCE(t.unit_price, 0))::float AS amount,
            t.odometer, u.name AS operator, r.request_no, t.status
       FROM fuel_transactions t
       JOIN vehicles v ON v.id = t.vehicle_id
       JOIN fuel_types ft ON ft.id = t.fuel_type_id
       LEFT JOIN pumps p ON p.id = t.pump_id
       LEFT JOIN tanks t2 ON t2.id = t.tank_id
       LEFT JOIN users u ON u.id = t.operator_id
       LEFT JOIN fuel_requests r ON r.id = t.request_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY t.created_at DESC`, params);
  const data = rows.map((r) => ({ ...r, amount: r.amount == null ? null : Number(r.amount) }));
  return {
    title: 'Fuel Transactions', orientation: 'landscape',
    meta: { filters: filtersText(q, { vehicle_id: 'Vehicle', fuel_type_id: 'Fuel Type', source: 'Source' }), org: profile },
    columns: [
      { key: 'created_at', label: 'Date', type: 'datetime', width: 19 },
      { key: 'txn_no', label: 'Transaction', width: 15 },
      { key: 'request_no', label: 'Request', width: 14 },
      { key: 'plate', label: 'Vehicle', width: 12 },
      { key: 'fuel_type', label: 'Fuel Type', width: 12 },
      { key: 'pump', label: 'Pump', width: 12 },
      { key: 'tank', label: 'Tank', width: 13 },
      { key: 'source', label: 'Source', width: 17 },
      { key: 'destination', label: 'Destination', width: 16 },
      { key: 'quantity', label: 'Quantity (L)', type: 'number', width: 12 },
      { key: 'unit_price', label: `Unit Price (${profile.currency})`, type: 'money', width: 13 },
      { key: 'amount', label: `Amount (${profile.currency})`, type: 'money', width: 13 },
      { key: 'odometer', label: 'Odometer (km)', type: 'number', width: 13 },
      { key: 'operator', label: 'Attendant', width: 15 },
      { key: 'status', label: 'Status', width: 10 },
    ],
    rows: data,
    totals: { quantity: +data.reduce((a, r) => a + Number(r.quantity), 0).toFixed(2), amount: +data.reduce((a, r) => a + (r.amount || 0), 0).toFixed(2) },
    total: data.length,
  };
}

export async function auditLogs(q) {
  const params = [];
  const where = [];
  if (q.q) { params.push(`%${String(q.q).trim()}%`); where.push(`(a.action ILIKE $${params.length} OR a.entity ILIKE $${params.length})`); }
  where.push(...dateFilters(q, params, 'a.created_at'));
  const profile = await orgProfile();
  const { rows } = await pool.query(
    `SELECT a.created_at, a.action, a.entity, a.entity_id, u.name AS user_name, a.ip, a.details
       FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY a.created_at DESC LIMIT 2000`, params);
  return {
    title: 'Audit Logs', orientation: 'landscape',
    meta: { filters: filtersText(q, { q: 'Search' }), org: profile },
    columns: [
      { key: 'created_at', label: 'Date', type: 'datetime', width: 19 },
      { key: 'user_name', label: 'User', width: 16 },
      { key: 'action', label: 'Action', width: 26 },
      { key: 'entity', label: 'Entity', width: 18 },
      { key: 'entity_id', label: 'Entity ID', width: 20 },
      { key: 'ip', label: 'IP', width: 14 },
      { key: 'details', label: 'Details', width: 40 },
    ],
    rows: rows.map((r) => ({ ...r, details: r.details ? JSON.stringify(r.details) : null })),
    totals: null,
    total: rows.length,
  };
}


// ─────────────────────────────────────────────────────────────────────────────
// Remaining §9 reports — same DATASET contract; all server-filtered (§44).
// ─────────────────────────────────────────────────────────────────────────────
export async function fuelRequests(q) {
  const params = [];
  const where = [];
  if (q.vehicle_id) { params.push(uuidParam(q.vehicle_id, 'vehicle_id')); where.push(`r.vehicle_id = $${params.length}`); }
  if (q.fuel_type_id) { params.push(uuidParam(q.fuel_type_id, 'fuel_type_id')); where.push(`r.fuel_type_id = $${params.length}`); }
  if (q.status) { params.push(String(q.status)); where.push(`r.status = $${params.length}`); }
  where.push(...dateFilters(q, params, 'r.created_at'));
  const profile = await orgProfile();
  const { rows } = await pool.query(
    `SELECT r.request_no, r.created_at, v.plate, ft.name AS fuel_type, r.quantity::float AS quantity,
            r.status, u.name AS requested_by, r.destination, r.odometer
       FROM fuel_requests r
       JOIN vehicles v ON v.id = r.vehicle_id
       JOIN fuel_types ft ON ft.id = r.fuel_type_id
       LEFT JOIN users u ON u.id = r.requested_by
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY r.created_at DESC LIMIT 5000`, params);
  return {
    title: 'Fuel Requests', orientation: 'landscape',
    meta: { filters: filtersText(q, { vehicle_id: 'Vehicle', fuel_type_id: 'Fuel Type', status: 'Status' }), org: profile },
    columns: [
      { key: 'created_at', label: 'Date', type: 'datetime', width: 19 },
      { key: 'request_no', label: 'Request', width: 14 },
      { key: 'plate', label: 'Vehicle', width: 12 },
      { key: 'fuel_type', label: 'Fuel', width: 12 },
      { key: 'quantity', label: 'Quantity (L)', type: 'number', width: 12 },
      { key: 'status', label: 'Status', width: 11 },
      { key: 'requested_by', label: 'Requested By', width: 16 },
      { key: 'destination', label: 'Destination', width: 22 },
    ],
    rows, totals: { quantity: +rows.reduce((a, r) => a + Number(r.quantity), 0).toFixed(2) }, total: rows.length,
  };
}

export async function fuelAuthorizations(q) {
  const params = [];
  const where = [];
  if (q.decision) { params.push(String(q.decision)); where.push(`z.decision = $${params.length}`); }
  where.push(...dateFilters(q, params, 'z.decided_at'));
  const profile = await orgProfile();
  const { rows } = await pool.query(
    `SELECT z.decided_at, r.request_no, z.decision, u.name AS decided_by, z.comments,
            r.quantity::float AS authorized_qty, ru.name AS requested_by
       FROM authorizations z
       JOIN fuel_requests r ON r.id = z.request_id
       LEFT JOIN users u ON u.id = z.decided_by
       LEFT JOIN users ru ON ru.id = r.requested_by
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY z.decided_at DESC LIMIT 5000`, params);
  return {
    title: 'Fuel Authorizations', orientation: 'landscape',
    meta: { filters: filtersText(q, { decision: 'Decision' }), org: profile },
    columns: [
      { key: 'decided_at', label: 'Decided', type: 'datetime', width: 19 },
      { key: 'request_no', label: 'Request', width: 14 },
      { key: 'decision', label: 'Decision', width: 11 },
      { key: 'decided_by', label: 'Decided By', width: 16 },
      { key: 'authorized_qty', label: 'Authorized (L)', type: 'number', width: 13 },
      { key: 'requested_by', label: 'Requested By', width: 16 },
      { key: 'comments', label: 'Comments', width: 40 },
    ],
    rows, totals: null, total: rows.length,
  };
}

export async function excessFuel(q) {
  const params = [];
  const where = [`a.entity_type = 'fuel_excess'`];
  if (q.status) { params.push(String(q.status).toUpperCase()); where.push(`a.status = $${params.length}`); }
  where.push(...dateFilters(q, params, 'a.created_at'));
  const profile = await orgProfile();
  const { rows } = await pool.query(
    `SELECT a.created_at, a.payload->>'txn_no' AS txn_no, a.payload->>'request_no' AS request_no,
            (a.payload->>'authorized')::float AS authorized, (a.payload->>'actual')::float AS actual,
            a.quantity::float AS excess, a.status, ud.name AS decided_by, a.reason
       FROM approvals a LEFT JOIN users ud ON ud.id = a.decided_by
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY a.created_at DESC LIMIT 5000`, params);
  return {
    title: 'Excess Fuel', orientation: 'landscape',
    meta: { filters: filtersText(q, { status: 'Status' }), org: profile },
    columns: [
      { key: 'created_at', label: 'Date', type: 'datetime', width: 19 },
      { key: 'txn_no', label: 'Transaction', width: 15 },
      { key: 'request_no', label: 'Request', width: 14 },
      { key: 'authorized', label: 'Authorized (L)', type: 'number', width: 13 },
      { key: 'actual', label: 'Actual (L)', type: 'number', width: 11 },
      { key: 'excess', label: 'Excess (L)', type: 'number', width: 10 },
      { key: 'status', label: 'Approval', width: 11 },
      { key: 'decided_by', label: 'Decided By', width: 15 },
      { key: 'reason', label: 'Reason', width: 34 },
    ],
    rows, totals: { excess: +rows.reduce((a, r) => a + Number(r.excess || 0), 0).toFixed(2) }, total: rows.length,
  };
}

export async function exceptions(q) {
  const params = [];
  const where = [];
  where.push(...dateFilters(q, params, 'd.at'));
  const profile = await orgProfile();
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT t.created_at AS at, 'REVERSED TRANSACTION' AS kind, t.txn_no AS reference,
              v.plate || ' · ' || t.quantity::text || ' L' AS detail, u.name AS actor, t.status AS status
         FROM fuel_transactions t
         LEFT JOIN vehicles v ON v.id = t.vehicle_id
         LEFT JOIN users u ON u.id = t.operator_id
        WHERE t.status = 'reversed'
       UNION ALL
       SELECT r.updated_at AS at, 'REJECTED REQUEST' AS kind, r.request_no AS reference,
              v.plate || ' · ' || r.quantity::text || ' L' AS detail, u.name AS actor, r.status AS status
         FROM fuel_requests r
         LEFT JOIN vehicles v ON v.id = r.vehicle_id
         LEFT JOIN users u ON u.id = (SELECT decided_by FROM authorizations z WHERE z.request_id = r.id AND z.decision = 'rejected' ORDER BY decided_at DESC LIMIT 1)
        WHERE r.status = 'rejected'
       UNION ALL
       SELECT a.created_at AS at, 'REJECTED ' || a.entity_type AS kind, a.payload->>'txn_no' AS reference,
            COALESCE(a.reason, '') AS detail, ud.name AS actor, a.status AS status
         FROM approvals a LEFT JOIN users ud ON ud.id = a.decided_by
        WHERE a.status = 'REJECTED'
     ) d
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY d.at DESC LIMIT 5000`, params);
  return {
    title: 'Exceptions', orientation: 'landscape',
    meta: { filters: filtersText(q, {}), org: profile },
    columns: [
      { key: 'at', label: 'Date', type: 'datetime', width: 19 },
      { key: 'kind', label: 'Exception', width: 24 },
      { key: 'reference', label: 'Reference', width: 16 },
      { key: 'detail', label: 'Detail', width: 30 },
      { key: 'actor', label: 'Actor', width: 16 },
      { key: 'status', label: 'Status', width: 11 },
    ],
    rows, totals: null, total: rows.length,
  };
}

export async function attendantActivity(q) {
  const params = [];
  const where = [`t.status IN ('completed','reversed')`];
  where.push(...dateFilters(q, params, 't.created_at'));
  const profile = await orgProfile();
  const { rows } = await pool.query(
    `SELECT u.name AS attendant, count(*)::int AS issues,
            COALESCE(SUM(t.quantity), 0)::float AS litres,
            COALESCE(SUM(t.quantity * COALESCE(t.unit_price, 0)), 0)::float AS cost,
            count(*) FILTER (WHERE t.status = 'reversed')::int AS reversals
       FROM fuel_transactions t LEFT JOIN users u ON u.id = t.operator_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      GROUP BY u.name ORDER BY litres DESC`, params);
  return {
    title: 'Attendant Activity', orientation: 'portrait',
    meta: { filters: filtersText(q, {}), org: profile },
    columns: [
      { key: 'attendant', label: 'Attendant', width: 22 },
      { key: 'issues', label: 'Issues', type: 'number', width: 9 },
      { key: 'litres', label: 'Litres Issued', type: 'number', width: 13 },
      { key: 'cost', label: `Value (${profile.currency})`, type: 'money', width: 15 },
      { key: 'reversals', label: 'Reversals', type: 'number', width: 10 },
    ],
    rows, totals: { issues: rows.reduce((a, r) => a + r.issues, 0), litres: +rows.reduce((a, r) => a + Number(r.litres), 0).toFixed(2) }, total: rows.length,
  };
}

export async function pumpReconciliation(q) {
  const params = [];
  const where = [];
  where.push(...dateFilters(q, params, 'pr.created_at'));
  const profile = await orgProfile();
  const { rows } = await pool.query(
    `SELECT p.name AS pump, t.name AS tank,
            MIN(pr.reading)::float AS meter_start, MAX(pr.reading)::float AS meter_end,
            (MAX(pr.reading) - MIN(pr.reading))::float AS meter_delta,
            COALESCE((SELECT SUM(-it.quantity) FROM inventory_transactions it
                       JOIN fuel_transactions f2 ON f2.id = it.ref_id AND it.ref_table = 'fuel_transactions'
                       JOIN pumps p2 ON p2.id = f2.pump_id
                      WHERE p2.id = p.id AND it.created_at >= COALESCE(MIN(pr.created_at), 'epoch') AND it.created_at < COALESCE(MAX(pr.created_at) + interval '1 day', 'epoch')), 0)::float AS issued_litres
       FROM pump_readings pr JOIN pumps p ON p.id = pr.pump_id LEFT JOIN tanks t ON t.id = p.tank_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      GROUP BY p.id, p.name, t.name ORDER BY p.name`, params);
  const data = rows.map((r) => ({ ...r, variance: +(Number(r.meter_delta) - Number(r.issued_litres)).toFixed(2) }));
  return {
    title: 'Pump Reconciliation', orientation: 'landscape',
    meta: { filters: filtersText(q, {}), org: profile },
    columns: [
      { key: 'pump', label: 'Pump', width: 16 },
      { key: 'tank', label: 'Tank', width: 16 },
      { key: 'meter_start', label: 'Meter Start', type: 'number', width: 12 },
      { key: 'meter_end', label: 'Meter End', type: 'number', width: 12 },
      { key: 'meter_delta', label: 'Meter Δ (L)', type: 'number', width: 12 },
      { key: 'issued_litres', label: 'Issued (L)', type: 'number', width: 11 },
      { key: 'variance', label: 'Variance (L)', type: 'number', width: 12 },
    ],
    rows: data, totals: null, total: data.length,
  };
}

export async function tankReconciliation(q) {
  const params = [];
  const where = [];
  if (q.fuel_type_id) { params.push(uuidParam(q.fuel_type_id, 'fuel_type_id')); where.push(`t.fuel_type_id = $${params.length}`); }
  const profile = await orgProfile();
  const { rows } = await pool.query(
    `WITH bal AS (
       SELECT t.id, COALESCE(SUM(it.quantity), 0)::float AS book
         FROM tanks t LEFT JOIN inventory_transactions it ON it.tank_id = t.id
        GROUP BY t.id)
     SELECT t.name AS tank, ft.name AS fuel_type, t.capacity::float AS capacity,
            b.book::float AS book_stock,
            (SELECT tr.quantity_estimate::float FROM tank_readings tr WHERE tr.tank_id = t.id ORDER BY tr.created_at DESC LIMIT 1) AS dip_estimate,
            (SELECT tr.created_at FROM tank_readings tr WHERE tr.tank_id = t.id ORDER BY tr.created_at DESC LIMIT 1) AS dip_at
       FROM tanks t JOIN fuel_types ft ON ft.id = t.fuel_type_id JOIN bal b ON b.id = t.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY t.name`, params);
  const data = rows.map((r) => ({
    ...r,
    variance: r.dip_estimate != null ? +(Number(r.dip_estimate) - Number(r.book_stock)).toFixed(2) : null,
    pct_full: Number(r.capacity) > 0 ? +((Number(r.book_stock) / Number(r.capacity)) * 100).toFixed(1) : null,
  }));
  return {
    title: 'Tank Reconciliation', orientation: 'landscape',
    meta: { filters: filtersText(q, { fuel_type_id: 'Fuel Type' }), org: profile },
    columns: [
      { key: 'tank', label: 'Tank', width: 18 },
      { key: 'fuel_type', label: 'Fuel', width: 12 },
      { key: 'capacity', label: 'Capacity (L)', type: 'number', width: 12 },
      { key: 'book_stock', label: 'Book Stock (L)', type: 'number', width: 13 },
      { key: 'dip_estimate', label: 'Last Dip Estimate (L)', type: 'number', width: 16 },
      { key: 'variance', label: 'Variance (L)', type: 'number', width: 12 },
      { key: 'pct_full', label: '% Full', type: 'number', width: 9 },
      { key: 'dip_at', label: 'Dip At', type: 'datetime', width: 19 },
    ],
    rows: data, totals: null, total: data.length,
  };
}

export async function fuelInventory(q) {
  const profile = await orgProfile();
  const { rows: tanks } = await pool.query(
    `SELECT t.name AS tank, ft.name AS fuel_type, t.capacity::float AS capacity,
            COALESCE(SUM(it.quantity), 0)::float AS balance
       FROM tanks t JOIN fuel_types ft ON ft.id = t.fuel_type_id
       LEFT JOIN inventory_transactions it ON it.tank_id = t.id
      GROUP BY t.id, t.name, ft.name, t.capacity ORDER BY t.name`);
  const data = tanks.map((r) => ({
    ...r,
    pct_full: Number(r.capacity) > 0 ? +((Number(r.balance) / Number(r.capacity)) * 100).toFixed(1) : null,
    status: Number(r.balance) <= 0 ? 'EMPTY' : (Number(r.balance) / Math.max(Number(r.capacity), 1)) < 0.15 ? 'LOW' : 'OK',
  }));
  return {
    title: 'Fuel Inventory', orientation: 'landscape',
    meta: { filters: filtersText(q, {}), org: profile },
    columns: [
      { key: 'tank', label: 'Tank', width: 20 },
      { key: 'fuel_type', label: 'Fuel', width: 13 },
      { key: 'capacity', label: 'Capacity (L)', type: 'number', width: 13 },
      { key: 'balance', label: 'Balance (L)', type: 'number', width: 13 },
      { key: 'pct_full', label: '% Full', type: 'number', width: 9 },
      { key: 'status', label: 'Status', width: 9 },
    ],
    rows: data, totals: { balance: +data.reduce((a, r) => a + Number(r.balance), 0).toFixed(2) }, total: data.length,
  };
}

export async function fuelCost(q) {
  const params = [];
  const where = [`t.status IN ('completed','reversed')`];
  where.push(...dateFilters(q, params, 't.created_at'));
  const profile = await orgProfile();
  const { rows } = await pool.query(
    `SELECT ft.name AS fuel_type,
            COALESCE(SUM(t.quantity), 0)::float AS litres,
            COALESCE(AVG(NULLIF(t.unit_price, 0)), 0)::float AS avg_unit_price,
            COALESCE(SUM(t.quantity * COALESCE(t.unit_price, 0)), 0)::float AS total_cost
       FROM fuel_transactions t JOIN fuel_types ft ON ft.id = t.fuel_type_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      GROUP BY ft.name ORDER BY ft.name`, params);
  return {
    title: 'Fuel Cost', orientation: 'portrait',
    meta: { filters: filtersText(q, {}), org: profile },
    columns: [
      { key: 'fuel_type', label: 'Fuel Type', width: 18 },
      { key: 'litres', label: 'Litres Issued', type: 'number', width: 13 },
      { key: 'avg_unit_price', label: `Avg Unit Price (${profile.currency})`, type: 'money', width: 18 },
      { key: 'total_cost', label: `Total Cost (${profile.currency})`, type: 'money', width: 17 },
    ],
    rows, totals: { total_cost: +rows.reduce((a, r) => a + Number(r.total_cost), 0).toFixed(2) }, total: rows.length,
  };
}

export async function costPerKm(q) {
  const vl = await vehicleLedger(q);
  const byVehicle = new Map();
  for (const r of vl.rows) {
    const k = r.registration;
    const cur = byVehicle.get(k) || { vehicle: r.vehicle, registration: k, fillups: 0, litres: 0, distance: 0, fuel_cost: 0 };
    cur.fillups += 1; cur.litres += Number(r.litres); cur.distance += Number(r.distance || 0);
    cur.fuel_cost += Number(r.fuel_cost || 0);
    byVehicle.set(k, cur);
  }
  const data = [...byVehicle.values()].map((v) => ({
    ...v,
    litres: +v.litres.toFixed(2),
    distance: +v.distance.toFixed(0),
    fuel_cost: +v.fuel_cost.toFixed(2),
    km_per_l: v.litres ? +(v.distance / v.litres).toFixed(2) : null,
    cost_per_km: v.distance ? +(v.fuel_cost / v.distance).toFixed(2) : null,
  }));
  return {
    title: 'Cost per KM', orientation: 'landscape',
    meta: { filters: filtersText(q, { vehicle_id: 'Vehicle' }), org: vl.meta.org },
    columns: [
      { key: 'registration', label: 'Registration', width: 14 },
      { key: 'vehicle', label: 'Vehicle', width: 22 },
      { key: 'fillups', label: 'Fill-ups', type: 'number', width: 10 },
      { key: 'litres', label: 'Fuel (L)', type: 'number', width: 11 },
      { key: 'distance', label: 'Distance (km)', type: 'number', width: 13 },
      { key: 'km_per_l', label: 'KM/L', type: 'number', width: 9 },
      { key: 'fuel_cost', label: `Fuel Cost (${vl.meta.org.currency})`, type: 'money', width: 14 },
      { key: 'cost_per_km', label: `Cost/KM (${vl.meta.org.currency})`, type: 'money', width: 13 },
    ],
    rows: data, totals: null, total: data.length,
  };
}

export const REPORTS = {
  'fuel-ledger': { build: fuelLedger, paginated: true, perm: 'reports:view' },
  'vehicle-ledger': { build: vehicleLedger, perm: 'reports:view' },
  'daily-fuel': { build: dailyFuel, perm: 'reports:view' },
  'bulk-purchases': { build: bulkPurchases, perm: 'reports:view' },
  'fuel-transactions': { build: fuelTransactions, perm: 'reports:view' },
  'audit-logs': { build: auditLogs, perm: 'audit_logs:view' },
};

Object.assign(REPORTS, {
  'fuel-requests': { build: fuelRequests, perm: 'reports:view' },
  'fuel-authorizations': { build: fuelAuthorizations, perm: 'reports:view' },
  'excess-fuel': { build: excessFuel, perm: 'reports:view' },
  'exceptions': { build: exceptions, perm: 'reports:view' },
  'attendant-activity': { build: attendantActivity, perm: 'reports:view' },
  'pump-reconciliation': { build: pumpReconciliation, perm: 'reports:view' },
  'tank-reconciliation': { build: tankReconciliation, perm: 'reports:view' },
  'fuel-inventory': { build: fuelInventory, perm: 'reports:view' },
  'fuel-cost': { build: fuelCost, perm: 'reports:view' },
  'cost-per-km': { build: costPerKm, perm: 'reports:view' },
});
