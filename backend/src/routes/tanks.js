// Storage tanks — master data. Creating a tank may set its opening stock,
// which is posted as the first (immutable) fuel-ledger entry.
import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncH, bad, notFound } from '../middleware/errors.js';
import { needStr, needUuid, needNum, isUuid } from '../middleware/validate.js';
import { tx } from '../db/pool.js';
import { postLedgerEntry, stockByTank } from '../services/ledger.js';
import { audit } from '../services/audit.js';

const router = Router();
router.use(requireAuth);

router.get('/', asyncH(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT t.*, ft.name AS fuel_type_name, ft.code AS fuel_type_code
       FROM tanks t JOIN fuel_types ft ON ft.id = t.fuel_type_id
      ORDER BY t.name`);
  res.json({ tanks: rows });
}));

router.get('/stock', asyncH(async (_req, res) => {
  res.json({ stock: await stockByTank() });
}));

router.post('/', requireRole('manager', 'admin'), asyncH(async (req, res) => {
  const name = needStr(req.body, 'name', { max: 80 });
  const fuelTypeId = needUuid(req.body, 'fuel_type_id');
  const capacity = needNum(req.body, 'capacity', { min: 1 });
  const location = needStr(req.body, 'location', { max: 120, optional: true });
  const openingQty = req.body.opening_quantity != null && req.body.opening_quantity !== ''
    ? Number(req.body.opening_quantity) : null;
  if (openingQty != null && (!Number.isFinite(openingQty) || openingQty < 0)) throw bad('opening_quantity must be ≥ 0');

  const result = await tx(async (client) => {
    let tank;
    try {
      const { rows } = await client.query(
        `INSERT INTO tanks (name, fuel_type_id, capacity, location) VALUES ($1,$2,$3,$4) RETURNING *`,
        [name, fuelTypeId, capacity, location]);
      tank = rows[0];
    } catch (err) {
      if (err.code === '23505') throw bad('A tank with that name already exists');
      throw err;
    }
    if (openingQty != null && openingQty > 0) {
      await postLedgerEntry(client, {
        entry_type: 'opening',
        fuel_type_id: fuelTypeId,
        tank_id: tank.id,
        quantity: openingQty,
        ref_table: 'tanks',
        ref_id: tank.id,
        description: `Opening stock for ${name}`,
        performed_by: req.user.sub,
      });
    }
    await audit(client, { userId: req.user.sub, action: 'tank.create', entity: 'tanks', entityId: tank.id, details: { name, capacity, opening: openingQty ?? 0 }, ip: req.ip });
    return tank;
  });
  res.status(201).json({ tank: result });
}));

router.patch('/:id', requireRole('manager', 'admin'), asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound('Tank not found');
  const b = req.body ?? {};
  const sets = [];
  const params = [req.params.id];
  const push = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (b.name !== undefined) push('name', needStr(b, 'name', { max: 80 }));
  if (b.capacity !== undefined) push('capacity', needNum(b, 'capacity', { min: 1 }));
  if (b.location !== undefined) push('location', needStr(b, 'location', { max: 120, optional: true }));
  if (b.active !== undefined) { params.push(Boolean(b.active)); sets.push(`active = $${params.length}`); }
  if (!sets.length) throw bad('Nothing to update');
  const { rows } = await pool.query(
    `UPDATE tanks SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, params);
  if (!rows.length) throw notFound('Tank not found');
  await audit(null, { userId: req.user.sub, action: 'tank.update', entity: 'tanks', entityId: req.params.id, ip: req.ip });
  res.json({ tank: rows[0] });
}));

router.delete('/:id', asyncH(async (_req, _res) => {
  throw bad('Tanks are never deleted. Deactivate instead (ledger history must remain intact).');
}));

export default router;
