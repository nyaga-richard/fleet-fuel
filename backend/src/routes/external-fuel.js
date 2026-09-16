// §2–§7 External fuel — fuel a vehicle obtained OUTSIDE the organization's
// station. Lives in the VEHICLE fuel history only: it never touches station
// stock, pumps, tank reconciliation or the Station Fuel Ledger (§4).
import { Router } from 'express';
import { pool, tx } from '../db/pool.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { asyncH, notFound, bad } from '../middleware/errors.js';
import { needUuid, needStr, needNum, optUuid, optNum, optStr, isUuid } from '../middleware/validate.js';
import { audit } from '../services/audit.js';
import { recordOdometer, checkOdometerProgression } from '../services/fleet.js';

const router = Router();
router.use(requireAuth);

const SELECT = `
  SELECT e.*, v.plate, ft.name AS fuel_type_name, u.name AS entered_by_name
    FROM external_fuel_entries e
    JOIN vehicles v ON v.id = e.vehicle_id
    JOIN fuel_types ft ON ft.id = e.fuel_type_id
    LEFT JOIN users u ON u.id = e.entered_by`;

router.get('/', requirePerm('external_fuel:view'), asyncH(async (req, res) => {
  const params = [];
  const where = [];
  if (req.query.vehicle_id) { params.push(String(req.query.vehicle_id)); where.push(`e.vehicle_id = $${params.length}`); }
  if (req.query.fuel_type_id) { params.push(String(req.query.fuel_type_id)); where.push(`e.fuel_type_id = $${params.length}`); }
  if (req.query.supplier) { params.push(`%${String(req.query.supplier).trim()}%`); where.push(`e.supplier ILIKE $${params.length}`); }
  if (req.query.from) { params.push(String(req.query.from)); where.push(`e.transaction_date >= $${params.length}::timestamptz`); }
  if (req.query.to) { params.push(String(req.query.to)); where.push(`e.transaction_date < ($${params.length}::timestamptz + interval '1 day')`); }
  const limit = Math.min(Number(req.query.limit || 200), 500);
  params.push(limit);
  const { rows } = await pool.query(
    `${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.transaction_date DESC LIMIT $${params.length}`, params);
  res.json({ entries: rows });
}));

router.get('/:id', requirePerm('external_fuel:view'), asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound('Entry not found');
  const { rows } = await pool.query(`${SELECT} WHERE e.id = $1`, [req.params.id]);
  if (!rows.length) throw notFound('Entry not found');
  res.json({ entry: rows[0] });
}));

router.post('/', requirePerm('external_fuel:record'), asyncH(async (req, res) => {
  const payload = {
    vehicle_id: needUuid(req.body, 'vehicle_id'),
    fuel_type_id: needUuid(req.body, 'fuel_type_id'),
    supplier: needStr(req.body, 'supplier', { max: 200 }),
    quantity: needNum(req.body, 'quantity', { max: 100_000 }),
    unit_price: needNum(req.body, 'unit_price', { min: 0 }),
    odometer: optNum(req.body, 'odometer', { min: 0 }),
    receipt_no: optStr(req.body, 'receipt_no', { max: 60 }),
    payment_method: optStr(req.body, 'payment_method', { max: 20 }),
    notes: optStr(req.body, 'notes', { max: 500 }),
    transaction_date: optStr(req.body, 'transaction_date', { max: 40 }),
    client_uuid: optUuid(req.body, 'client_uuid'),
  };
  if (!['CASH', 'CARD', 'ACCOUNT', 'OTHER'].includes((payload.payment_method || 'CASH').toUpperCase())) {
    throw bad('Payment method must be CASH, CARD, ACCOUNT or OTHER');
  }
  payload.payment_method = (payload.payment_method || 'CASH').toUpperCase();

  const { row, duplicate } = await tx(async (client) => {
    const existing = payload.client_uuid
      ? (await client.query('SELECT * FROM external_fuel_entries WHERE client_uuid = $1', [payload.client_uuid])).rows[0]
      : null;
    if (existing) return { row: existing, duplicate: true };

    const { rows: veh } = await client.query('SELECT id, plate, active FROM vehicles WHERE id = $1', [payload.vehicle_id]);
    if (!veh.length) throw bad('Vehicle not found');
    const { rows: ft } = await client.query('SELECT id FROM fuel_types WHERE id = $1', [payload.fuel_type_id]);
    if (!ft.length) throw bad('Fuel type not found');
    await checkOdometerProgression(client, payload.vehicle_id, payload.odometer, payload.transaction_date);

    const total = +(payload.quantity * payload.unit_price).toFixed(2);
    const { rows: ins } = await client.query(
      `INSERT INTO external_fuel_entries
         (vehicle_id, fuel_type_id, supplier, transaction_date, odometer, quantity, unit_price,
          total_amount, receipt_no, payment_method, notes, entered_by, client_uuid)
       VALUES ($1,$2,$3, COALESCE($4::timestamptz, now()),$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [payload.vehicle_id, payload.fuel_type_id, payload.supplier, payload.transaction_date,
        payload.odometer, payload.quantity, payload.unit_price, total, payload.receipt_no,
        payload.payment_method, payload.notes, req.user.sub, payload.client_uuid]);
    if (payload.odometer != null) {
      await recordOdometer(client, { vehicleId: payload.vehicle_id, odometer: payload.odometer,
        source: 'external_fuel', refTable: 'external_fuel_entries', refId: ins[0].id,
        enteredBy: req.user.sub, at: payload.transaction_date });
    }
    await audit(client, {
      userId: req.user.sub, action: 'external_fuel.record', entity: 'external_fuel_entries',
      entityId: ins[0].id,
      details: { plate: veh[0].plate, supplier: payload.supplier, quantity: payload.quantity, total },
      ip: req.ip,
    });
    return { row: ins[0], duplicate: false };
  });
  res.status(duplicate ? 200 : 201).json({ entry: row, duplicate });
}));

export default router;
