// Vehicles — master data. Never deleted; deactivated.
import { Router } from 'express';
import { pool, tx } from '../db/pool.js';
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

// Bulk import (CSV/paste rows from the web UI) — manager/admin only.
// Per-row outcomes: created | skipped (plate already exists or duplicate in
// file) | failed (row-level reason). One bad row never blocks the rest.
// The whole batch commits atomically; the report says exactly what happened.
router.post('/bulk', requireRole('manager', 'admin'), asyncH(async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
  if (!rows || rows.length === 0) throw bad('rows[] is required');
  if (rows.length > 500) throw bad('Import at most 500 vehicles per batch');

  const clean = [];
  const results = [];
  const seenPlates = new Set();

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i] ?? {};
    const plate = String(raw.plate ?? '').trim().toUpperCase();
    if (!plate) { results.push({ row: i + 1, plate: '', status: 'failed', reason: 'Plate is required' }); continue; }
    if (plate.length > 30) { results.push({ row: i + 1, plate, status: 'failed', reason: 'Plate must be at most 30 characters' }); continue; }
    if (seenPlates.has(plate)) { results.push({ row: i + 1, plate, status: 'skipped', reason: 'Duplicate plate in this file' }); continue; }
    const make = str(raw.make, 80), model = str(raw.model, 80);
    const vehicleType = str(raw.vehicle_type, 40), driverName = str(raw.driver_name, 120);
    const notes = str(raw.notes, 500);
    let tankCapacity = raw.tank_capacity === '' || raw.tank_capacity == null ? null : Number(raw.tank_capacity);
    if (tankCapacity != null && (!Number.isFinite(tankCapacity) || tankCapacity <= 0)) {
      results.push({ row: i + 1, plate, status: 'failed', reason: 'Tank capacity must be a positive number' });
      continue;
    }
    seenPlates.add(plate);
    clean.push({ row: i + 1, plate, make, model, vehicleType, driverName, notes, tankCapacity });
  }

  // Existing plates → skipped (idempotent re-imports never error).
  const plates = clean.map((r) => r.plate);
  const existing = new Set(
    plates.length
      ? (await pool.query('SELECT plate FROM vehicles WHERE plate = ANY($1::text[])', [plates])).rows.map((r) => r.plate)
      : [],
  );

  const createdPlates = [];
  await tx(async (client) => {
    for (const r of clean) {
      if (existing.has(r.plate)) {
        results.push({ row: r.row, plate: r.plate, status: 'skipped', reason: 'Already in the fleet' });
        continue;
      }
      try {
        const { rows: ins } = await client.query(
          `INSERT INTO vehicles (plate, make, model, vehicle_type, driver_name, tank_capacity, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [r.plate, r.make, r.model, r.vehicleType, r.driverName, r.tankCapacity, r.notes]);
        results.push({ row: r.row, plate: r.plate, status: 'created', id: ins[0].id });
        createdPlates.push(r.plate);
      } catch (err) {
        if (err.code === '23505') results.push({ row: r.row, plate: r.plate, status: 'skipped', reason: 'Already in the fleet' });
        else results.push({ row: r.row, plate: r.plate, status: 'failed', reason: 'Database rejected the row' });
      }
    }
    if (createdPlates.length) {
      await audit(client, {
        userId: req.user.sub,
        action: 'vehicle.bulk_import', entity: 'vehicles',
        details: { created: createdPlates.length, plates: createdPlates.slice(0, 50) },
        ip: req.ip,
      });
    }
  });

  const tally = (st) => results.filter((r) => r.status === st).length;
  res.json({ created: tally('created'), skipped: tally('skipped'), failed: tally('failed'), results });
}));

// Small helper for optional bounded strings (trim → null when empty).
function str(v, max) {
  if (v == null) return null;
  const t = String(v).trim();
  if (!t) return null;
  return t.slice(0, max);
}

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
