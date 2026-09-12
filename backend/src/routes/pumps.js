// Pumps (dispensers) — each pump draws from exactly one tank.
import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncH, bad, notFound } from '../middleware/errors.js';
import { needStr, needUuid, isUuid } from '../middleware/validate.js';
import { audit } from '../services/audit.js';

const router = Router();
router.use(requireAuth);

router.get('/', asyncH(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT p.*, t.name AS tank_name, ft.name AS fuel_type_name, ft.code AS fuel_type_code
       FROM pumps p
       JOIN tanks t ON t.id = p.tank_id
       JOIN fuel_types ft ON ft.id = t.fuel_type_id
      ORDER BY p.name`);
  res.json({ pumps: rows });
}));

router.post('/', requireRole('manager', 'admin'), asyncH(async (req, res) => {
  const name = needStr(req.body, 'name', { max: 80 });
  const tankId = needUuid(req.body, 'tank_id');
  const serial = needStr(req.body, 'serial', { max: 60, optional: true });
  try {
    const { rows } = await pool.query(
      `INSERT INTO pumps (name, tank_id, serial) VALUES ($1,$2,$3) RETURNING *`,
      [name, tankId, serial]);
    await audit(null, { userId: req.user.sub, action: 'pump.create', entity: 'pumps', entityId: rows[0].id, details: { name }, ip: req.ip });
    res.status(201).json({ pump: rows[0] });
  } catch (err) {
    if (err.code === '23505') throw bad('A pump with that name already exists');
    throw err;
  }
}));

router.patch('/:id', requireRole('manager', 'admin'), asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound('Pump not found');
  const b = req.body ?? {};
  const sets = [];
  const params = [req.params.id];
  const push = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (b.name !== undefined) push('name', needStr(b, 'name', { max: 80 }));
  if (b.tank_id !== undefined) push('tank_id', needUuid(b, 'tank_id'));
  if (b.serial !== undefined) push('serial', needStr(b, 'serial', { max: 60, optional: true }));
  if (b.active !== undefined) { params.push(Boolean(b.active)); sets.push(`active = $${params.length}`); }
  if (!sets.length) throw bad('Nothing to update');
  const { rows } = await pool.query(
    `UPDATE pumps SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, params);
  if (!rows.length) throw notFound('Pump not found');
  await audit(null, { userId: req.user.sub, action: 'pump.update', entity: 'pumps', entityId: req.params.id, ip: req.ip });
  res.json({ pump: rows[0] });
}));

router.delete('/:id', asyncH(async (_req, _res) => {
  throw bad('Pumps are never deleted. Deactivate instead (transaction history must remain intact).');
}));

export default router;
