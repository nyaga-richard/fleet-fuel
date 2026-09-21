// §28–§41 Direct fuel entry routes. Existing request→approval→issue workflow
// is untouched; this is a parallel, permission-gated path for fuel already
// issued outside the workflow. Reuses ops.directFuelEntry (same ledger,
// guards, audit, idempotency as workflow issues).
import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { asyncH, notFound, bad } from '../middleware/errors.js';
import { needUuid, needNum, needStr, optUuid, optNum, optStr, isUuid } from '../middleware/validate.js';
import { directFuelEntry } from '../services/ops.js';
import { tx } from '../db/pool.js';

const router = Router();
router.use(requireAuth);

const SELECT = `
  SELECT t.*, v.plate, ft.name AS fuel_type_name, p.name AS pump_name, tk.name AS tank_name,
         u.name AS operator_name
    FROM fuel_transactions t
    JOIN vehicles v ON v.id = t.vehicle_id
    JOIN fuel_types ft ON ft.id = t.fuel_type_id
    LEFT JOIN pumps p ON p.id = t.pump_id
    LEFT JOIN tanks tk ON tk.id = t.tank_id
    LEFT JOIN users u ON u.id = t.operator_id`;

// Applicable cost price for the §34 preview: what a BLANK fueling price will
// resolve to right now.
router.get('/price-preview', requirePerm('fuel_entries:view'), asyncH(async (req, res) => {
  const fuelTypeId = String(req.query.fuel_type_id || '');
  if (!isUuid(fuelTypeId)) throw bad('fuel_type_id is required');
  const { rows } = await pool.query(
    `SELECT unit_price FROM purchases
      WHERE fuel_type_id = $1 AND unit_price IS NOT NULL AND unit_price > 0
      ORDER BY created_at DESC LIMIT 1`, [fuelTypeId]);
  res.json({ cost_price: rows.length ? Number(rows[0].unit_price) : null });
}));

router.get('/', requirePerm('fuel_entries:view'), asyncH(async (req, res) => {
  const params = [];
  const where = [`t.source = 'DIRECT_ENTRY'`];
  if (req.query.vehicle_id) { params.push(String(req.query.vehicle_id)); where.push(`t.vehicle_id = $${params.length}`); }
  if (req.query.fuel_type_id) { params.push(String(req.query.fuel_type_id)); where.push(`t.fuel_type_id = $${params.length}`); }
  if (req.query.from) { params.push(String(req.query.from)); where.push(`t.created_at >= $${params.length}::timestamptz`); }
  if (req.query.to) { params.push(String(req.query.to)); where.push(`t.created_at < ($${params.length}::timestamptz + interval '1 day')`); }
  const limit = Math.min(Number(req.query.limit || 200), 500);
  params.push(limit);
  const { rows } = await pool.query(
    `${SELECT} WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC LIMIT $${params.length}`, params);
  res.json({ entries: rows });
}));

router.get('/:id', requirePerm('fuel_entries:view'), asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound('Entry not found');
  const { rows } = await pool.query(`${SELECT} WHERE t.id = $1 AND t.source = 'DIRECT_ENTRY'`, [req.params.id]);
  if (!rows.length) throw notFound('Entry not found');
  res.json({ entry: rows[0] });
}));

router.post('/direct', requirePerm('fuel_entries:create'), asyncH(async (req, res) => {
  const payload = {
    vehicle_id: needUuid(req.body, 'vehicle_id'),
    fuel_type_id: needUuid(req.body, 'fuel_type_id'),
    pump_id: optUuid(req.body, 'pump_id'),
    tank_id: optUuid(req.body, 'tank_id'),
    quantity: needNum(req.body, 'quantity', { max: 1_000_000 }),
    unit_price: optNum(req.body, 'unit_price', { min: 0 }), // §33 optional — blank → cost price
    odometer: optNum(req.body, 'odometer', { min: 0 }),
    pump_start: optNum(req.body, 'pump_start', { min: 0 }),
    pump_end: optNum(req.body, 'pump_end', { min: 0 }),
    destination: optStr(req.body, 'destination', { max: 200 }),
    purpose: optStr(req.body, 'purpose', { max: 200 }),
    remarks: optStr(req.body, 'remarks', { max: 500 }),
    lpo_no: optStr(req.body, 'lpo_no', { max: 60 }),
    transaction_date: optStr(req.body, 'transaction_date', { max: 40 }),
    client_uuid: optUuid(req.body, 'client_uuid'),
  };
  if (!payload.pump_id && !payload.tank_id) throw bad('pump_id or tank_id is required');
  const { row, duplicate, price_source } = await tx((client) => directFuelEntry(client, { payload, userId: req.user.sub }));
  res.status(duplicate ? 200 : 201).json({ entry: row, duplicate, price_source });
}));

export default router;
