// §20–§27 Trip management — journeys with OPTIONAL revenue. Trips reference
// fuel via odometer windows at report level; fuel transactions are never
// duplicated (§25/§47).
import { Router } from 'express';
import { pool, tx } from '../db/pool.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { asyncH, notFound, bad } from '../middleware/errors.js';
import { needStr, needUuid, needNum, optUuid, optNum, optStr, isUuid } from '../middleware/validate.js';
import { audit } from '../services/audit.js';
import { nextDocNumber } from '../services/numbering.js';
import { recordOdometer, checkOdometerProgression } from '../services/fleet.js';

const router = Router();
router.use(requireAuth);

const SELECT = `
  SELECT t.*, v.plate, u.name AS created_by_name
    FROM trips t JOIN vehicles v ON v.id = t.vehicle_id
    LEFT JOIN users u ON u.id = t.created_by`;

router.get('/', requirePerm('trips:view'), asyncH(async (req, res) => {
  const params = [];
  const where = [];
  if (req.query.vehicle_id) { params.push(String(req.query.vehicle_id)); where.push(`t.vehicle_id = $${params.length}`); }
  if (req.query.status) { params.push(String(req.query.status).toUpperCase()); where.push(`t.status = $${params.length}`); }
  if (req.query.from) { params.push(String(req.query.from)); where.push(`t.trip_date >= $${params.length}::date`); }
  if (req.query.to) { params.push(String(req.query.to)); where.push(`t.trip_date <= $${params.length}::date`); }
  const limit = Math.min(Number(req.query.limit || 200), 500);
  params.push(limit);
  const { rows } = await pool.query(
    `${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.trip_date DESC, t.created_at DESC LIMIT $${params.length}`, params);
  res.json({ trips: rows });
}));

router.get('/:id', requirePerm('trips:view'), asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound('Trip not found');
  const { rows } = await pool.query(`${SELECT} WHERE t.id = $1`, [req.params.id]);
  if (!rows.length) throw notFound('Trip not found');
  const t = rows[0];
  // §25 — fuel transactions whose odometer falls inside the trip window
  // (internal + external, read-only reference; never duplicated).
  let fuel = [];
  if (t.start_odometer != null && t.end_odometer != null) {
    const { rows: f } = await pool.query(
      `SELECT txn_no AS reference, quantity, unit_price, odometer, 'INTERNAL' AS source
         FROM fuel_transactions WHERE vehicle_id = $1 AND status = 'completed'
           AND odometer BETWEEN $2 AND $3
       UNION ALL
       SELECT receipt_no AS reference, quantity, unit_price, odometer, 'EXTERNAL' AS source
         FROM external_fuel_entries WHERE vehicle_id = $1
           AND odometer BETWEEN $2 AND $3
       ORDER BY odometer`, [t.vehicle_id, t.start_odometer, t.end_odometer]);
    fuel = f;
  }
  res.json({ trip: t, fuel });
}));


// §22/§24 — revenue is OPTIONAL. Validate only what is supplied; never force it.
const REV_STATUSES = ['UNPAID', 'PARTPAID', 'PAID'];
function revenueFields(b) {
  const out = {};
  if (b.revenue_amount !== undefined && b.revenue_amount !== '' && b.revenue_amount !== null) {
    const v = Number(b.revenue_amount);
    if (!Number.isFinite(v) || v < 0) throw bad('Revenue must be ≥ 0');
    out.revenue_amount = v;
  }
  for (const k of ['revenue_currency', 'revenue_customer', 'revenue_invoice_ref', 'revenue_type']) {
    if (b[k] !== undefined) out[k] = optStr({ [k]: b[k] }, k, { max: 120 });
  }
  if (b.revenue_payment_status !== undefined && b.revenue_payment_status) {
    const v = String(b.revenue_payment_status).toUpperCase();
    if (!REV_STATUSES.includes(v)) throw bad('Payment status must be UNPAID, PARTPAID or PAID');
    out.revenue_payment_status = v;
  }
  return out;
}

router.post('/', requirePerm('trips:manage'), asyncH(async (req, res) => {
  const vehicleId = needUuid(req.body, 'vehicle_id');
  const startOdo = optNum(req.body, 'start_odometer', { min: 0 });
  const { row, duplicate } = await tx(async (client) => {
    const existing = req.body.client_uuid
      ? (await client.query('SELECT * FROM trips WHERE client_uuid = $1', [req.body.client_uuid])).rows[0]
      : null;
    if (existing) return { row: existing, duplicate: true };
    const { rows: veh } = await client.query('SELECT plate, current_odometer FROM vehicles WHERE id = $1', [vehicleId]);
    if (!veh.length) throw bad('Vehicle not found');
    await checkOdometerProgression(client, vehicleId, startOdo, null);
    const rev = revenueFields(req.body); // optional (§22)
    const tripNo = await nextDocNumber(client, 'trip');
    const { rows } = await client.query(
      `INSERT INTO trips
         (trip_no, vehicle_id, driver_name, trip_date, start_location, destination, purpose,
          department, start_time, start_odometer, load_info, notes, created_by, client_uuid,
          revenue_amount, revenue_currency, revenue_customer, revenue_invoice_ref, revenue_type, revenue_payment_status)
       VALUES ($1,$2,$3, COALESCE($4::date, CURRENT_DATE),$5,$6,$7,$8,
               COALESCE($9::timestamptz, now()),$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING *`,
      [tripNo, vehicleId,
        optStr(req.body, 'driver_name', { max: 120 }),
        optStr(req.body, 'trip_date', { max: 20 }),
        optStr(req.body, 'start_location', { max: 160 }),
        optStr(req.body, 'destination', { max: 160 }),
        optStr(req.body, 'purpose', { max: 200 }),
        optStr(req.body, 'department', { max: 120 }),
        optStr(req.body, 'start_time', { max: 40 }),
        startOdo,
        optStr(req.body, 'load_info', { max: 300 }),
        optStr(req.body, 'notes', { max: 500 }),
        req.user.sub, optUuid(req.body, 'client_uuid'),
        rev.revenue_amount ?? null, rev.revenue_currency ?? 'KES', rev.revenue_customer ?? null,
        rev.revenue_invoice_ref ?? null, rev.revenue_type ?? null, rev.revenue_payment_status ?? 'UNPAID']);
    await audit(client, { userId: req.user.sub, action: 'trip.created', entity: 'trips', entityId: rows[0].id,
      details: { trip_no: tripNo, plate: veh[0].plate }, ip: req.ip });
    return { row: rows[0], duplicate: false };
  });
  res.status(duplicate ? 200 : 201).json({ trip: row, duplicate });
}));

router.patch('/:id', requirePerm('trips:manage'), asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound('Trip not found');
  const b = req.body ?? {};
  const { row } = await tx(async (client) => {
    const { rows: cur } = await client.query('SELECT * FROM trips WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!cur.length) throw notFound('Trip not found');
    const sets = []; const params = [req.params.id];
    const push = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    for (const k of ['driver_name', 'start_location', 'destination', 'purpose', 'department', 'load_info', 'notes']) {
      if (b[k] !== undefined) push(k, optStr({ [k]: b[k] }, k, { max: 500 }));
    }
    // §22/§24 — revenue is optional; supplied fields are validated then merged.
    const rev = revenueFields(b);
    if (rev.revenue_amount === undefined && (b.revenue_amount === '' || b.revenue_amount == null)) push('revenue_amount', null); // explicit clear
    for (const [k, v] of Object.entries(rev)) push(k, v);
    if (!sets.length) throw bad('Nothing to update');
    sets.push('updated_at = now()');
    const { rows } = await client.query(`UPDATE trips SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    await audit(client, { userId: req.user.sub, action: 'trip.updated', entity: 'trips', entityId: req.params.id, details: b, ip: req.ip });
    return { row: rows[0] };
  });
  res.json({ trip: row });
}));

// §24 — record/replace trip revenue. Optional by design: a trip can live its
// whole life without revenue (internal/admin/empty-return), and this endpoint
// only ever adds or amends it when management chooses to.
router.put('/:id/revenue', requirePerm('trips:manage'), asyncH(async (req, res) => {
  const rev = revenueFields(req.body);
  if (!Object.keys(rev).length) throw bad('No revenue fields supplied');
  const { rows } = await pool.query(
    `UPDATE trips SET
       revenue_amount = COALESCE($2, revenue_amount),
       revenue_currency = COALESCE($3, revenue_currency, 'KES'),
       revenue_customer = COALESCE($4, revenue_customer),
       revenue_invoice_ref = COALESCE($5, revenue_invoice_ref),
       revenue_type = COALESCE($6, revenue_type),
       revenue_payment_status = COALESCE($7, revenue_payment_status, 'UNPAID'),
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [req.params.id, rev.revenue_amount ?? null, rev.revenue_currency ?? null, rev.revenue_customer ?? null,
      rev.revenue_invoice_ref ?? null, rev.revenue_type ?? null, rev.revenue_payment_status ?? null]);
  if (!rows.length) throw notFound('Trip not found');
  await audit(null, { userId: req.user.sub, action: 'trip.revenue_recorded', entity: 'trips',
    entityId: req.params.id, details: rev, ip: req.ip });
  res.json({ trip: rows[0] });
}));

router.post('/:id/start', requirePerm('trips:manage'), asyncH(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE trips SET status = 'IN_PROGRESS', start_time = COALESCE(start_time, now()), updated_at = now()
      WHERE id = $1 AND status IN ('PLANNED','AUTHORIZED') RETURNING *`, [req.params.id]);
  if (!rows.length) throw bad('Only a PLANNED or AUTHORIZED trip can be started');
  await audit(null, { userId: req.user.sub, action: 'trip.started', entity: 'trips', entityId: req.params.id, ip: req.ip });
  res.json({ trip: rows[0] });
}));

// §23 — completion computes distance; end ≥ start enforced; odometer recorded.
router.post('/:id/complete', requirePerm('trips:manage'), asyncH(async (req, res) => {
  const endOdo = needNum(req.body, 'end_odometer', { min: 0 });
  const { row } = await tx(async (client) => {
    const { rows: cur } = await client.query('SELECT * FROM trips WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!cur.length) throw notFound('Trip not found');
    const t = cur[0];
    if (!['PLANNED', 'AUTHORIZED', 'IN_PROGRESS'].includes(t.status)) throw bad(`Trip is ${t.status} — only PLANNED/AUTHORIZED/IN_PROGRESS trips can be completed`);
    const start = t.start_odometer != null ? Number(t.start_odometer) : null;
    if (start != null && endOdo < start) throw bad(`Ending odometer (${endOdo}) cannot be less than the starting odometer (${start})`);
    await checkOdometerProgression(client, t.vehicle_id, endOdo, req.body.end_time ?? null);
    const distance = start != null ? +(endOdo - start).toFixed(1) : null;
    const { rows } = await client.query(
      `UPDATE trips SET status = 'COMPLETED', end_odometer = $2, distance = $3,
                        end_time = COALESCE(end_time, COALESCE($4::timestamptz, now())), updated_at = now()
        WHERE id = $1 RETURNING *`,
      [req.params.id, endOdo, distance, optStr(req.body, 'end_time', { max: 40 })]);
    await recordOdometer(client, { vehicleId: t.vehicle_id, odometer: endOdo, source: 'trip',
      refTable: 'trips', refId: t.id, enteredBy: req.user.sub, at: req.body.end_time ?? null });
    await audit(client, { userId: req.user.sub, action: 'trip.completed', entity: 'trips', entityId: t.id,
      details: { trip_no: t.trip_no, distance, end_odometer: endOdo }, ip: req.ip });
    return { row: rows[0] };
  });
  res.json({ trip: row });
}));

router.post('/:id/cancel', requirePerm('trips:manage'), asyncH(async (req, res) => {
  const reason = needStr(req.body, 'reason', { max: 300 });
  const { rows } = await pool.query(
    `UPDATE trips SET status = 'CANCELLED', notes = COALESCE(notes || ' | ', '') || $2, updated_at = now()
      WHERE id = $1 AND status <> 'COMPLETED' RETURNING *`, [req.params.id, `Cancelled: ${reason}`]);
  if (!rows.length) throw bad('Only an uncompleted trip can be cancelled');
  await audit(null, { userId: req.user.sub, action: 'trip.cancelled', entity: 'trips', entityId: req.params.id, details: { reason }, ip: req.ip });
  res.json({ trip: rows[0] });
}));

export default router;
