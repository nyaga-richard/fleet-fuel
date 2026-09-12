// Fuel transactions (issues) + reversals. Completed transactions and the
// fuel ledger are PERMANENT — reversal adds compensating entries, nothing
// is ever deleted or rewritten.
import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncH, notFound, bad } from '../middleware/errors.js';
import { needUuid, needNum, needStr, optUuid, isUuid } from '../middleware/validate.js';
import { issueFuel, reverseFuelTransaction } from '../services/ops.js';
import { tx } from '../db/pool.js';

const router = Router();
router.use(requireAuth);

const SELECT = `
  SELECT t.*, v.plate, ft.name AS fuel_type_name, ft.code AS fuel_type_code,
         p.name AS pump_name, u.name AS operator_name, r.request_no
    FROM fuel_transactions t
    JOIN vehicles v ON v.id = t.vehicle_id
    JOIN fuel_types ft ON ft.id = t.fuel_type_id
    LEFT JOIN pumps p ON p.id = t.pump_id
    LEFT JOIN users u ON u.id = t.operator_id
    LEFT JOIN fuel_requests r ON r.id = t.request_id`;

router.get('/', asyncH(async (req, res) => {
  const params = [];
  const where = [`t.status IN ('completed', 'reversed')`];
  if (req.query.vehicle_id) { params.push(String(req.query.vehicle_id)); where.push(`t.vehicle_id = $${params.length}`); }
  if (req.query.fuel_type_id) { params.push(String(req.query.fuel_type_id)); where.push(`t.fuel_type_id = $${params.length}`); }
  if (req.query.from) { params.push(String(req.query.from)); where.push(`t.created_at >= $${params.length}::timestamptz`); }
  if (req.query.to) { params.push(String(req.query.to)); where.push(`t.created_at < ($${params.length}::timestamptz + interval '1 day')`); }
  const limit = Math.min(Number(req.query.limit || 200), 500);
  params.push(limit);
  const { rows } = await pool.query(
    `${SELECT} WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC LIMIT $${params.length}`, params);
  res.json({ transactions: rows });
}));

router.get('/:id', asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound('Transaction not found');
  const { rows } = await pool.query(`${SELECT} WHERE t.id = $1`, [req.params.id]);
  if (!rows.length) throw notFound('Transaction not found');
  const reversal = (await pool.query(`${SELECT} WHERE t.reversal_of = $1`, [req.params.id])).rows[0] ?? null;
  res.json({ transaction: rows[0], reversal });
}));

// Issue fuel against an approved request.
router.post('/issue', requireRole('attendant', 'manager', 'admin'), asyncH(async (req, res) => {
  const payload = {
    request_id: optUuid(req.body, 'request_id'),
    request_no: needStr(req.body, 'request_no', { max: 40, optional: true }),
    pump_id: optUuid(req.body, 'pump_id'),
    tank_id: optUuid(req.body, 'tank_id'),
    quantity: needNum(req.body, 'quantity', { max: 1_000_000 }),
    unit_price: needNum(req.body, 'unit_price', { min: 0, optional: true }),
    odometer: needNum(req.body, 'odometer', { min: 0, optional: true }),
    pump_reading: needNum(req.body, 'pump_reading', { min: 0, optional: true }),
    client_uuid: optUuid(req.body, 'client_uuid'),
  };
  if (!payload.request_id && !payload.request_no) throw bad('request_id or request_no is required');
  if (!payload.pump_id && !payload.tank_id) throw bad('pump_id or tank_id is required');

  const { row, duplicate } = await tx((client) => issueFuel(client, { payload, userId: req.user.sub }));
  res.status(duplicate ? 200 : 201).json({ transaction: row, duplicate });
}));

// Reverse a completed issue (manager/admin) — compensating ledger entry.
router.post('/:id/reverse', requireRole('manager', 'admin'), asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound('Transaction not found');
  const reason = needStr(req.body, 'reason', { max: 300 });
  const result = await tx((client) =>
    reverseFuelTransaction(client, { transactionId: req.params.id, userId: req.user.sub, reason }));
  res.json(result);
}));

export default router;
