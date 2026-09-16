// Vehicles — master data. Never deleted; deactivated.
import { Router } from 'express';
import { pool, tx } from '../db/pool.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncH, bad, notFound } from '../middleware/errors.js';
import { needStr, optUuid, isUuid } from '../middleware/validate.js';
import { audit } from '../services/audit.js';
import { checkOdometerProgression, recordOdometer } from '../services/fleet.js';
import { loadConfiguration } from '../services/wheel-configs.js';

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
  const year = req.body.year != null && req.body.year !== '' ? Number(req.body.year) : null;
  if (year != null && (!Number.isInteger(year) || year < 1950 || year > 2100)) throw bad('year must be a valid model year');
  const status = String(req.body.status || 'ACTIVE').toUpperCase();
  if (!['ACTIVE','INACTIVE','MAINTENANCE','ACCIDENT','RETIRED','SOLD','DISPOSED'].includes(status)) throw bad('Invalid vehicle status');
  const initialOdo = req.body.current_odometer != null && req.body.current_odometer !== '' ? Number(req.body.current_odometer) : null;
  if (tankCapacity != null && (!Number.isFinite(tankCapacity) || tankCapacity <= 0)) throw bad('tank_capacity must be > 0');

  // §1/§6 — a vehicle may be created directly on a configuration.
  let initialCfgId = req.body.wheel_configuration_id || null;
  if (initialCfgId != null) {
    if (!isUuid(String(initialCfgId))) throw bad('wheel_configuration_id must be a valid id');
    const { rows: cfgRow } = await pool.query('SELECT id, code FROM wheel_configurations WHERE id = $1 AND is_active = true', [initialCfgId]);
    if (!cfgRow.length) throw bad('Wheel configuration not found or inactive');
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO vehicles (plate, make, model, vehicle_type, driver_name, tank_capacity, notes,
                             year, vin, engine_no, expected_km_l, current_odometer, department,
                             branch, station, status, axle_config, acquisition_date, acquisition_cost,
                             ownership_type, supplier, wheel_configuration_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       RETURNING *`,
      [plate, make, model, vehicleType, driverName, tankCapacity, needStr(req.body, 'notes', { max: 500, optional: true }),
        year, needStr(req.body, 'vin', { max: 60, optional: true }), needStr(req.body, 'engine_no', { max: 60, optional: true }),
        req.body.expected_km_l != null && req.body.expected_km_l !== '' ? Number(req.body.expected_km_l) : null,
        initialOdo ?? 0,
        needStr(req.body, 'department', { max: 120, optional: true }),
        needStr(req.body, 'branch', { max: 120, optional: true }), needStr(req.body, 'station', { max: 120, optional: true }),
        status, needStr(req.body, 'axle_config', { max: 4, optional: true }) || '4x2',
        needStr(req.body, 'acquisition_date', { max: 20, optional: true }),
        req.body.acquisition_cost != null && req.body.acquisition_cost !== '' ? Number(req.body.acquisition_cost) : null,
        needStr(req.body, 'ownership_type', { max: 40, optional: true }),
        needStr(req.body, 'supplier', { max: 200, optional: true }), initialCfgId]);
    await audit(null, { userId: req.user.sub, action: 'vehicle.create', entity: 'vehicles', entityId: rows[0].id, details: { plate }, ip: req.ip });
    if (initialCfgId) {
      await pool.query(
        'INSERT INTO vehicle_wheel_config_history (vehicle_id, configuration_id, changed_by) VALUES ($1,$2,$3)',
        [rows[0].id, initialCfgId, req.user.sub]);
    }
    if (initialOdo != null) {
      await recordOdometer(pool, { vehicleId: rows[0].id, odometer: initialOdo,
        source: 'manual', refTable: 'vehicles', refId: rows[0].id, enteredBy: req.user.sub });
    }
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
  if (b.year !== undefined) { params.push(b.year === '' || b.year == null ? null : Number(b.year)); sets.push(`year = $${params.length}`); }
  for (const [col, key, max] of [['vin','vin',60],['engine_no','engine_no',60],['department','department',120],['branch','branch',120],['station','station',120],['ownership_type','ownership_type',40],['supplier','supplier',200]]) {
    if (b[key] !== undefined) push(col, needStr(b, key, { max, optional: true }));
  }
  if (b.expected_km_l !== undefined) { params.push(b.expected_km_l === '' || b.expected_km_l == null ? null : Number(b.expected_km_l)); sets.push(`expected_km_l = $${params.length}`); }
  if (b.acquisition_date !== undefined) push('acquisition_date', needStr(b, 'acquisition_date', { max: 20, optional: true }));
  if (b.acquisition_cost !== undefined) { params.push(b.acquisition_cost === '' || b.acquisition_cost == null ? null : Number(b.acquisition_cost)); sets.push(`acquisition_cost = $${params.length}`); }
  if (b.axle_config !== undefined) {
    const cfg = needStr(b, 'axle_config', { max: 4, optional: true }) || '4x2';
    if (!['4x2','4x4','6x2','6x4','8x4'].includes(cfg)) throw bad('Invalid axle configuration');
    push('axle_config', cfg);
  }
  if (b.status !== undefined) {
    const st = String(b.status || 'ACTIVE').toUpperCase();
    if (!['ACTIVE','INACTIVE','MAINTENANCE','ACCIDENT','RETIRED','SOLD','DISPOSED'].includes(st)) throw bad('Invalid vehicle status');
    push('status', st);
    params.push(st === 'ACTIVE'); sets.push(`active = $${params.length}`); // keep fuel workflows in sync (§8)
  }
  // Wheel configuration assignment (§6): validate conflicts with existing
  // tire assignments; authorization escalates for vehicles in operation;
  // history rows are append-only.
  if (b.wheel_configuration_id !== undefined) {
    const cfgId = b.wheel_configuration_id || null;
    const { rows: vehRows } = await pool.query('SELECT * FROM vehicles WHERE id = $1', [req.params.id]);
    if (!vehRows.length) throw notFound('Vehicle not found');
    const veh = vehRows[0];
    if (cfgId && !isUuid(cfgId)) throw bad('wheel_configuration_id must be a valid id');
    let cfg = null;
    if (cfgId) {
      cfg = await loadConfiguration(pool, cfgId);
      if (!cfg) throw bad('Wheel configuration not found');
      if (!cfg.configuration.is_active) throw bad('That wheel configuration is inactive');
    }
    if (cfgId && String(cfgId) !== String(veh.wheel_configuration_id)) {
      const { rows: fitted } = await pool.query(
        'SELECT serial_no, current_position FROM tires WHERE current_vehicle_id = $1 AND current_position IS NOT NULL', [req.params.id]);
      const codes = new Set(cfg.positions.map((p) => p.position_code));
      const conflicts = fitted.filter((t) => !codes.has(t.current_position));
      if (conflicts.length) {
        // §6/§8 — never silently move tires; the user must remove them first.
        throw bad(`Cannot change configuration: tire(s) ${conflicts.map((t) => `${t.serial_no} @ ${t.current_position}`).join(', ')} do not exist on ${cfg.configuration.code}. Remove them first`);
      }
      const { rows: hist } = await pool.query(
        'SELECT COUNT(*)::int AS n FROM vehicle_wheel_config_history WHERE vehicle_id = $1', [req.params.id]);
      const inOperation = (veh.current_odometer > 0 && hist[0].n > 0) || fitted.length > 0;
      if (inOperation && req.user.role !== 'admin') {
        throw bad('Only an administrator can change the wheel configuration of a vehicle already in operation (§6)');
      }
    }
    if (cfgId && String(cfgId) !== String(veh.wheel_configuration_id)) {
      await pool.query('UPDATE vehicle_wheel_config_history SET ended_at = now() WHERE vehicle_id = $1 AND ended_at IS NULL', [req.params.id]);
      await pool.query(
        'INSERT INTO vehicle_wheel_config_history (vehicle_id, configuration_id, changed_by) VALUES ($1,$2,$3)',
        [req.params.id, cfgId, req.user.sub]);
      // Keep the legacy axle_config column in sync for older flows.
      const { rows: cfgRow } = await pool.query('SELECT code FROM wheel_configurations WHERE id = $1', [cfgId]);
      if (cfgRow.length) { params.push(cfgRow[0].code); sets.push(`axle_config = $${params.length}`); }
      params.push(cfgId); sets.push(`wheel_configuration_id = $${params.length}`);
      await audit(null, { userId: req.user.sub, action: 'vehicle.wheel_config_changed', entity: 'vehicles', entityId: req.params.id,
        details: { to: cfg.configuration.code }, ip: req.ip });
    } else if (!cfgId && veh.wheel_configuration_id) {
      await pool.query('UPDATE vehicle_wheel_config_history SET ended_at = now() WHERE vehicle_id = $1 AND ended_at IS NULL', [req.params.id]);
      params.push(null); sets.push('wheel_configuration_id = $' + params.length);
    }
  }
  const hasOdo = b.current_odometer !== undefined && b.current_odometer !== '' && b.current_odometer != null;
  if (!sets.length && !hasOdo) throw bad('Nothing to update');
  // current_odometer is not a row edit: it is validated against the odometer
  // trail (§41) and appended as a history entry, never silently overwritten.
  if (hasOdo) await checkOdometerProgression(pool, req.params.id, Number(b.current_odometer), null);
  let rows;
  if (sets.length) {
    ({ rows } = await pool.query(
      `UPDATE vehicles SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, params));
  } else {
    ({ rows } = await pool.query('SELECT * FROM vehicles WHERE id = $1', [req.params.id]));
  }
  if (!rows.length) throw notFound('Vehicle not found');
  if (hasOdo) {
    await recordOdometer(pool, { vehicleId: req.params.id, odometer: Number(b.current_odometer),
      source: 'manual', refTable: 'vehicles', refId: req.params.id, enteredBy: req.user.sub });
  }
  await audit(null, { userId: req.user.sub, action: 'vehicle.update', entity: 'vehicles', entityId: req.params.id, ip: req.ip });
  res.json({ vehicle: rows[0] });
}));

router.delete('/:id', asyncH(async (_req, _res) => {
  throw bad('Vehicles are never deleted. Deactivate instead (transaction history must remain intact).');
}));

// Vehicle profile (§9/§44) — register fields + the authoritative odometer trail.
router.get('/:id/detail', asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound('Vehicle not found');
  const { rows } = await pool.query('SELECT * FROM vehicles WHERE id = $1', [req.params.id]);
  if (!rows.length) throw notFound('Vehicle not found');
  const { rows: odo } = await pool.query(
    `SELECT odometer::float AS odometer, source, recorded_at
       FROM vehicle_odometer_history WHERE vehicle_id = $1
      ORDER BY recorded_at DESC LIMIT 200`, [req.params.id]);
  res.json({ vehicle: rows[0], odometer_history: odo });
}));

export default router;
