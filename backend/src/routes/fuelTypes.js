// Fuel types (Diesel, Petrol, ...) — master data. Never deleted; deactivated.
import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncH, bad, notFound } from '../middleware/errors.js';
import { needStr, isUuid } from '../middleware/validate.js';
import { stockByFuelType } from '../services/ledger.js';
import { audit } from '../services/audit.js';

const router = Router();
router.use(requireAuth);

router.get('/', asyncH(async (_req, res) => {
  const { rows } = await pool.query(`SELECT * FROM fuel_types ORDER BY name`);
  res.json({ fuel_types: rows });
}));

router.get('/stock', asyncH(async (_req, res) => {
  res.json({ stock: await stockByFuelType() });
}));

router.post('/', requireRole('manager', 'admin'), asyncH(async (req, res) => {
  const name = needStr(req.body, 'name', { max: 60 });
  const code = needStr(req.body, 'code', { max: 20 }).toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const unit = needStr(req.body, 'unit', { max: 10, optional: true }) || 'L';
  try {
    const { rows } = await pool.query(
      `INSERT INTO fuel_types (name, code, unit) VALUES ($1,$2,$3) RETURNING *`, [name, code, unit]);
    await audit(null, { userId: req.user.sub, action: 'fuel_type.create', entity: 'fuel_types', entityId: rows[0].id, details: { name, code }, ip: req.ip });
    res.status(201).json({ fuel_type: rows[0] });
  } catch (err) {
    if (err.code === '23505') throw bad('Fuel type name or code already exists');
    throw err;
  }
}));

router.patch('/:id', requireRole('manager', 'admin'), asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound('Fuel type not found');
  const b = req.body ?? {};
  const sets = [];
  const params = [req.params.id];
  if (b.name !== undefined) { params.push(needStr(b, 'name', { max: 60 })); sets.push(`name = $${params.length}`); }
  if (b.unit !== undefined) { params.push(needStr(b, 'unit', { max: 10 })); sets.push(`unit = $${params.length}`); }
  if (b.active !== undefined) { params.push(Boolean(b.active)); sets.push(`active = $${params.length}`); }
  if (!sets.length) throw bad('Nothing to update');
  const { rows } = await pool.query(
    `UPDATE fuel_types SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  if (!rows.length) throw notFound('Fuel type not found');
  await audit(null, { userId: req.user.sub, action: 'fuel_type.update', entity: 'fuel_types', entityId: req.params.id, ip: req.ip });
  res.json({ fuel_type: rows[0] });
}));

router.delete('/:id', asyncH(async (_req, _res) => {
  throw bad('Fuel types are never deleted. Deactivate instead (ledger history must remain intact).');
}));

export default router;
