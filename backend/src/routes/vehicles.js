// Vehicles — master data. Never deleted; deactivated.
import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncH, bad, notFound } from '../middleware/errors.js';
import { needStr, optUuid, isUuid } from '../middleware/validate.js';
import { audit } from '../services/audit.js';

const router = Router();
router.use(requireAuth);

router.get('/', asyncH(async (req, res) => {
  const q = [];
  const params = [];
  if (req.query.active === 'true') { params.push(true); q.push(`v.active = $${params.length}`); }
  if (req.query.q) {
    params.push(`%${String(req.query.q).trim()}%`);
    q.push(`(v.plate ILIKE $${params.length} OR COALESCE(v.driver_name,'') ILIKE $${params.length})`);
  }
  const { rows } = await pool.query(
    `SELECT v.* FROM vehicles v ${q.length ? 'WHERE ' + q.join(' AND ') : ''}
      ORDER BY v.plate`, params);
  res.json({ vehicles: rows });
}));

router.post('/', requireRole('manager', 'admin'), asyncH(async (req, res) => {
  const plate = needStr(req.body, 'plate', { max: 30 }).toUpperCase();
  const make = needStr(req.body, 'make', { max: 80, optional: true });
  const model = needStr(req.body, 'model', { max: 80, optional: true });
  const vehicleType = needStr(req.body, 'vehicle_type', { max: 40, optional: true });
  const driverName = needStr(req.body, 'driver_name', { max: 120, optional: true });
  const tankCapacity = req.body.tank_capacity != null && req.body.tank_capacity !== '' ? Number(req.body.tank_capacity) : null;
  if (tankCapacity != null && (!Number.isFinite(tankCapacity) || tankCapacity <= 0)) throw bad('tank_capacity must be > 0');

  try {
    const { rows } = await pool.query(
      `INSERT INTO vehicles (plate, make, model, vehicle_type, driver_name, tank_capacity, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [plate, make, model, vehicleType, driverName, tankCapacity, needStr(req.body, 'notes', { max: 500, optional: true })]);
    await audit(null, { userId: req.user.sub, action: 'vehicle.create', entity: 'vehicles', entityId: rows[0].id, details: { plate }, ip: req.ip });
    res.status(201).json({ vehicle: rows[0] });
  } catch (err) {
    if (err.code === '23505') throw bad(`A vehicle with plate ${plate} already exists`);
    throw err;
  }
}));

router.patch('/:id', requireRole('manager', 'admin'), asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound('Vehicle not found');
  const b = req.body ?? {};
  const sets = [];
  const params = [req.params.id];
  const push = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (b.plate !== undefined) push('plate', needStr(b, 'plate', { max: 30 }).toUpperCase());
  if (b.make !== undefined) push('make', needStr(b, 'make', { max: 80, optional: true }));
  if (b.model !== undefined) push('model', needStr(b, 'model', { max: 80, optional: true }));
  if (b.vehicle_type !== undefined) push('vehicle_type', needStr(b, 'vehicle_type', { max: 40, optional: true }));
  if (b.driver_name !== undefined) push('driver_name', needStr(b, 'driver_name', { max: 120, optional: true }));
  if (b.tank_capacity !== undefined) {
    const v = b.tank_capacity === '' || b.tank_capacity == null ? null : Number(b.tank_capacity);
    if (v != null && (!Number.isFinite(v) || v <= 0)) throw bad('tank_capacity must be > 0');
    push('tank_capacity', v);
  }
  if (b.notes !== undefined) push('notes', needStr(b, 'notes', { max: 500, optional: true }));
  if (b.active !== undefined) { params.push(Boolean(b.active)); sets.push(`active = $${params.length}`); }
  if (!sets.length) throw bad('Nothing to update');

  const { rows } = await pool.query(
    `UPDATE vehicles SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, params);
  if (!rows.length) throw notFound('Vehicle not found');
  await audit(null, { userId: req.user.sub, action: 'vehicle.update', entity: 'vehicles', entityId: req.params.id, ip: req.ip });
  res.json({ vehicle: rows[0] });
}));

router.delete('/:id', asyncH(async (_req, _res) => {
  throw bad('Vehicles are never deleted. Deactivate instead (transaction history must remain intact).');
}));

export default router;
