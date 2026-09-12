// Fuel Ledger — read-only view over the immutable inventory_transactions.
// Opening Balance / Receipts / Issues / Adjustments / Reversals / Closing
// are all reconstructible from these rows at any time.
import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncH } from '../middleware/errors.js';
import { isUuid } from '../middleware/validate.js';

const router = Router();
router.use(requireAuth);

router.get('/', asyncH(async (req, res) => {
  const params = [];
  const where = [];
  if (req.query.fuel_type_id) {
    if (!isUuid(String(req.query.fuel_type_id))) params.push(String(req.query.fuel_type_id));
    else { params.push(String(req.query.fuel_type_id)); where.push(`it.fuel_type_id = $${params.length}`); }
  }
  if (req.query.tank_id) { params.push(String(req.query.tank_id)); where.push(`it.tank_id = $${params.length}`); }
  if (req.query.entry_type) { params.push(String(req.query.entry_type)); where.push(`it.entry_type = $${params.length}`); }
  if (req.query.from) { params.push(String(req.query.from)); where.push(`it.created_at >= $${params.length}::timestamptz`); }
  if (req.query.to) { params.push(String(req.query.to)); where.push(`it.created_at < ($${params.length}::timestamptz + interval '1 day')`); }
  const limit = Math.min(Number(req.query.limit || 300), 1000);
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT it.*, ft.name AS fuel_type_name, ft.code AS fuel_type_code,
            t.name AS tank_name, u.name AS performed_by_name
       FROM inventory_transactions it
       JOIN fuel_types ft ON ft.id = it.fuel_type_id
       LEFT JOIN tanks t ON t.id = it.tank_id
       LEFT JOIN users u ON u.id = it.performed_by
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY it.created_at DESC, it.id DESC
      LIMIT $${params.length}`, params);
  res.json({ entries: rows });
}));

// Period movement summary: opening → receipts/issues/adjustments/reversals → closing.
router.get('/summary', asyncH(async (req, res) => {
  const params = [];
  const where = [];
  if (req.query.fuel_type_id && isUuid(String(req.query.fuel_type_id))) {
    params.push(String(req.query.fuel_type_id));
    where.push(`it.fuel_type_id = $${params.length}`);
  }
  const to = req.query.to ? new Date(String(req.query.to)) : new Date();
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(to.getTime() - 30 * 864e5);

  const { rows } = await pool.query(
    `SELECT ft.id AS fuel_type_id, ft.name AS fuel_type, ft.code,
            COALESCE(SUM(it.quantity) FILTER (WHERE it.created_at < $1), 0)::float AS opening_balance,
            COALESCE(SUM(it.quantity) FILTER (WHERE it.entry_type = 'receipt' AND it.created_at >= $1 AND it.created_at < $2), 0)::float AS receipts,
            COALESCE(SUM(it.quantity) FILTER (WHERE it.entry_type = 'issue' AND it.created_at >= $1 AND it.created_at < $2), 0)::float AS issues,
            COALESCE(SUM(it.quantity) FILTER (WHERE it.entry_type = 'adjustment' AND it.created_at >= $1 AND it.created_at < $2), 0)::float AS adjustments,
            COALESCE(SUM(it.quantity) FILTER (WHERE it.entry_type = 'reversal' AND it.created_at >= $1 AND it.created_at < $2), 0)::float AS reversals,
            COALESCE(SUM(it.quantity), 0)::float AS closing_balance
       FROM fuel_types ft
       LEFT JOIN inventory_transactions it ON it.fuel_type_id = ft.id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      GROUP BY ft.id, ft.name, ft.code
      ORDER BY ft.name`, [from, to]);
  res.json({ from, to, summary: rows });
}));

export default router;
