// §10–§19 Tire management — serial-numbered assets with an append-only
// lifecycle ledger (tire_movements). Current state is derived/authoritative
// on the tire row; history is NEVER rewritten (§16/§47).
import { Router } from 'express';
import { pool, tx } from '../db/pool.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { asyncH, notFound, bad } from '../middleware/errors.js';
import { needStr, needUuid, needNum, optUuid, optNum, optStr, isUuid } from '../middleware/validate.js';
import { audit } from '../services/audit.js';
import { recordOdometer } from '../services/fleet.js';
import { POSITIONS, POSITION_LABELS } from '../services/fleet.js';

const router = Router();
router.use(requireAuth);

const SELECT = `
  SELECT t.*, v.plate AS current_vehicle_plate
    FROM tires t LEFT JOIN vehicles v ON v.id = t.current_vehicle_id`;

router.get('/', requirePerm('tires:view'), asyncH(async (req, res) => {
  const params = [];
  const where = [];
  if (req.query.status) { params.push(String(req.query.status).toUpperCase()); where.push(`t.status = $${params.length}`); }
  if (req.query.vehicle_id) { params.push(String(req.query.vehicle_id)); where.push(`t.current_vehicle_id = $${params.length}`); }
  if (req.query.q) { params.push(`%${String(req.query.q).trim()}%`); where.push(`(t.serial_no ILIKE $${params.length} OR COALESCE(t.brand,'') ILIKE $${params.length})`); }
  const limit = Math.min(Number(req.query.limit || 300), 1000);
  params.push(limit);
  const { rows } = await pool.query(
    `${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.serial_no LIMIT $${params.length}`, params);
  res.json({ tires: rows });
}));

router.get('/positions', requirePerm('tires:view'), asyncH(async (req, res) => {
  const config = String(req.query.axle_config || '4x2');
  const list = POSITIONS[config] || POSITIONS['4x2'];
  res.json({ positions: list.map((p) => ({ code: p, label: POSITION_LABELS[p] })) });
}));

router.get('/:id', requirePerm('tires:view'), asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound('Tire not found');
  const { rows } = await pool.query(`${SELECT} WHERE t.id = $1`, [req.params.id]);
  if (!rows.length) throw notFound('Tire not found');
  const { rows: history } = await pool.query(
    `SELECT m.*, v.plate, u.name AS performed_by_name
       FROM tire_movements m LEFT JOIN vehicles v ON v.id = m.vehicle_id
       LEFT JOIN users u ON u.id = m.performed_by
      WHERE m.tire_id = $1 ORDER BY m.created_at DESC, m.id DESC`, [req.params.id]);
  res.json({ tire: rows[0], history });
}));

// Create a tire (registered into store) — serial must be unique (§18).
router.post('/', requirePerm('tires:manage'), asyncH(async (req, res) => {
  const payload = {
    serial_no: needStr(req.body, 'serial_no', { max: 60 }).toUpperCase(),
    brand: optStr(req.body, 'brand', { max: 80 }),
    pattern: optStr(req.body, 'pattern', { max: 80 }),
    size: optStr(req.body, 'size', { max: 40 }),
    tire_type: optStr(req.body, 'tire_type', { max: 40 }),
    ply_rating: optStr(req.body, 'ply_rating', { max: 30 }),
    supply_condition: (optStr(req.body, 'supply_condition', { max: 10 }) || 'NEW').toUpperCase(),
    purchase_date: optStr(req.body, 'purchase_date', { max: 20 }),
    purchase_cost: optNum(req.body, 'purchase_cost', { min: 0 }),
    supplier: optStr(req.body, 'supplier', { max: 200 }),
    tread_depth_mm: optNum(req.body, 'tread_depth_mm', { min: 0 }),
    notes: optStr(req.body, 'notes', { max: 500 }),
    client_uuid: optUuid(req.body, 'client_uuid'),
  };
  if (!['NEW', 'RETREAD'].includes(payload.supply_condition)) throw bad('Supply condition must be NEW or RETREAD');
  const existing = payload.client_uuid
    ? (await pool.query('SELECT * FROM tires WHERE client_uuid = $1', [payload.client_uuid])).rows[0]
    : (await pool.query('SELECT * FROM tires WHERE serial_no = $1', [payload.serial_no])).rows[0];
  if (existing) return res.status(200).json({ tire: existing, duplicate: true });
  try {
    const { rows } = await pool.query(
      `INSERT INTO tires (serial_no, brand, pattern, size, tire_type, ply_rating, supply_condition,
                          purchase_date, purchase_cost, supplier, tread_depth_mm, notes, client_uuid)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [payload.serial_no, payload.brand, payload.pattern, payload.size, payload.tire_type,
        payload.ply_rating, payload.supply_condition, payload.purchase_date, payload.purchase_cost,
        payload.supplier, payload.tread_depth_mm, payload.notes, payload.client_uuid]);
    await audit(null, { userId: req.user.sub, action: 'tire.create', entity: 'tires', entityId: rows[0].id, details: { serial_no: payload.serial_no }, ip: req.ip });
    res.status(201).json({ tire: rows[0] });
  } catch (err) {
    if (err.code === '23505') throw bad(`Tire serial ${payload.serial_no} already exists`);
    throw err;
  }
}));

// ── Fit (§13): tire → vehicle position. All §18 validations enforced.
router.post('/fit', requirePerm('tires:manage'), asyncH(async (req, res) => {
  const tireId = needUuid(req.body, 'tire_id');
  const vehicleId = needUuid(req.body, 'vehicle_id');
  const position = needStr(req.body, 'position', { max: 4 }).toUpperCase();
  const odometer = needNum(req.body, 'odometer', { min: 0 });
  const treadDepth = optNum(req.body, 'tread_depth_mm', { min: 0 });

  const row = await tx(async (client) => {
    const { rows: tire } = await client.query('SELECT * FROM tires WHERE id = $1 FOR UPDATE', [tireId]);
    if (!tire.length) throw notFound('Tire not found');
    const t = tire[0];
    if (t.status === 'DISPOSED') throw bad('Cannot fit a disposed tire');
    if (t.status === 'ON_VEHICLE') throw bad(`Tire is already on ${t.current_vehicle_id === vehicleId ? 'this vehicle' : 'another vehicle'} — remove it first`);
    const { rows: veh } = await client.query('SELECT id, plate, axle_config, current_odometer FROM vehicles WHERE id = $1', [vehicleId]);
    if (!veh.length) throw notFound('Vehicle not found');
    const allowed = POSITIONS[veh[0].axle_config] || POSITIONS['4x2'];
    if (!allowed.includes(position)) throw bad(`Position ${position} is not valid for a ${veh[0].axle_config} vehicle (${allowed.join(', ')})`);
    // No double-booking of positions (§18).
    const { rows: occupied } = await client.query(
      'SELECT serial_no FROM tires WHERE current_vehicle_id = $1 AND current_position = $2', [vehicleId, position]);
    if (occupied.length) throw bad(`Position ${position} already holds tire ${occupied[0].serial_no} — remove it first`);

    await client.query(
      `UPDATE tires SET status = 'ON_VEHICLE', current_vehicle_id = $2, current_position = $3,
                        installed_at = now(), installed_odometer = $4,
                        tread_depth_mm = COALESCE($5, tread_depth_mm), updated_at = now()
        WHERE id = $1`,
      [tireId, vehicleId, position, odometer, treadDepth]);
    await client.query(
      `INSERT INTO tire_movements (tire_id, vehicle_id, action, position, odometer, tread_depth_mm, performed_by, client_uuid)
       VALUES ($1,$2,'FIT',$3,$4,$5,$6,$7)`,
      [tireId, vehicleId, position, odometer, treadDepth, req.user.sub, req.body.client_uuid ?? null]);
    await recordOdometer(client, { vehicleId, odometer, source: 'tire_fit',
      refTable: 'tire_movements', refId: tireId, enteredBy: req.user.sub });
    await audit(client, {
      userId: req.user.sub, action: 'tire.fitted', entity: 'tires', entityId: tireId,
      details: { vehicle: veh[0].plate, position, odometer, serial: t.serial_no }, ip: req.ip,
    });
    return { tireId: t.id, plate: veh[0].plate, position };
  });
  res.json({ ok: true, ...row });
}));

// ── Remove (§14): position freed, mileage accumulated, status per destination.
router.post('/remove', requirePerm('tires:manage'), asyncH(async (req, res) => {
  const tireId = needUuid(req.body, 'tire_id');
  const odometer = needNum(req.body, 'odometer', { min: 0 });
  const reason = needStr(req.body, 'reason', { max: 200 });
  const destination = (optStr(req.body, 'destination', { max: 30 }) || 'USED_STORE').toUpperCase();
  const treadDepth = optNum(req.body, 'tread_depth_mm', { min: 0 });
  if (!['IN_STORE', 'USED_STORE', 'AWAITING_RETREAD', 'AT_RETREAD_SUPPLIER', 'DISPOSED'].includes(destination)) {
    throw bad('Destination must be IN_STORE, USED_STORE, AWAITING_RETREAD, AT_RETREAD_SUPPLIER or DISPOSED');
  }

  const row = await tx(async (client) => {
    const { rows: tire } = await client.query('SELECT * FROM tires WHERE id = $1 FOR UPDATE', [tireId]);
    if (!tire.length) throw notFound('Tire not found');
    const t = tire[0];
    if (t.status !== 'ON_VEHICLE') throw bad('Tire is not on a vehicle');
    const { rows: veh } = await client.query('SELECT plate FROM vehicles WHERE id = $1', [t.current_vehicle_id]);

    const accrued = odometer >= Number(t.installed_odometer || 0)
      ? +(odometer - Number(t.installed_odometer || 0)).toFixed(1) : 0;
    await client.query(
      `UPDATE tires SET status = $2, current_vehicle_id = NULL, current_position = NULL,
                        installed_at = NULL, installed_odometer = NULL,
                        mileage_accumulated = mileage_accumulated + $3,
                        tread_depth_mm = COALESCE($4, tread_depth_mm), updated_at = now()
        WHERE id = $1`,
      [tireId, destination, accrued, treadDepth]);
    await client.query(
      `INSERT INTO tire_movements (tire_id, vehicle_id, action, position, odometer, tread_depth_mm, reason, performed_by)
       VALUES ($1,$2,'REMOVE',$3,$4,$5,$6,$7)`,
      [tireId, t.current_vehicle_id, t.current_position, odometer, treadDepth, `${reason} → ${destination}`, req.user.sub]);
    await recordOdometer(client, { vehicleId: t.current_vehicle_id, odometer, source: 'tire_remove',
      refTable: 'tire_movements', refId: tireId, enteredBy: req.user.sub });
    await audit(client, {
      userId: req.user.sub, action: 'tire.removed', entity: 'tires', entityId: tireId,
      details: { vehicle: veh[0]?.plate, position: t.current_position, odometer, accrued_km: accrued, destination, reason }, ip: req.ip,
    });
    return { accrued_km: accrued, destination, plate: veh[0]?.plate, position: t.current_position };
  });
  res.json({ ok: true, ...row });
}));

// ── Rotate (§15): same vehicle, position A → position B; history preserved.
router.post('/rotate', requirePerm('tires:manage'), asyncH(async (req, res) => {
  const tireId = needUuid(req.body, 'tire_id');
  const toPosition = needStr(req.body, 'to_position', { max: 4 }).toUpperCase();
  const odometer = needNum(req.body, 'odometer', { min: 0 });

  const row = await tx(async (client) => {
    const { rows: tire } = await client.query('SELECT * FROM tires WHERE id = $1 FOR UPDATE', [tireId]);
    if (!tire.length) throw notFound('Tire not found');
    const t = tire[0];
    if (t.status !== 'ON_VEHICLE') throw bad('Only a tire on a vehicle can be rotated');
    const { rows: veh } = await client.query('SELECT plate, axle_config FROM vehicles WHERE id = $1', [t.current_vehicle_id]);
    const allowed = POSITIONS[veh[0].axle_config] || POSITIONS['4x2'];
    if (!allowed.includes(toPosition)) throw bad(`Position ${toPosition} is not valid for a ${veh[0].axle_config} vehicle`);
    if (toPosition === t.current_position) throw bad('The tire is already in that position');
    const { rows: occupied } = await client.query(
      'SELECT serial_no FROM tires WHERE current_vehicle_id = $1 AND current_position = $2', [t.current_vehicle_id, toPosition]);
    if (occupied.length) throw bad(`Position ${toPosition} already holds tire ${occupied[0].serial_no} — remove or rotate it away first`);

    await client.query(
      `INSERT INTO tire_movements (tire_id, vehicle_id, action, position, odometer, reason, performed_by)
       VALUES ($1,$2,'ROTATE',$3,$4,$5,$6)`,
      [tireId, t.current_vehicle_id, toPosition, odometer, `rotated ${t.current_position} → ${toPosition}`, req.user.sub]);
    await recordOdometer(client, { vehicleId: t.current_vehicle_id, odometer, source: 'tire_rotate',
      refTable: 'tire_movements', refId: tireId, enteredBy: req.user.sub });
    await client.query(
      'UPDATE tires SET current_position = $2, updated_at = now() WHERE id = $1', [tireId, toPosition]);
    await audit(client, {
      userId: req.user.sub, action: 'tire.rotated', entity: 'tires', entityId: tireId,
      details: { vehicle: veh[0].plate, from: t.current_position, to: toPosition, odometer }, ip: req.ip,
    });
    return { from: t.current_position, to: toPosition, plate: veh[0].plate };
  });
  res.json({ ok: true, ...row });
}));

// Current layout of a vehicle (§17).
router.get('/vehicle/:id/layout', requirePerm('tires:view'), asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound('Vehicle not found');
  const { rows: veh } = await pool.query('SELECT id, plate, axle_config, current_odometer FROM vehicles WHERE id = $1', [req.params.id]);
  if (!veh.length) throw notFound('Vehicle not found');
  const { rows: fitted } = await pool.query(
    'SELECT id, serial_no, brand, size, current_position, tread_depth_mm, installed_odometer, installed_at FROM tires WHERE current_vehicle_id = $1',
    [req.params.id]);
  const allowed = POSITIONS[veh[0].axle_config] || POSITIONS['4x2'];
  res.json({
    vehicle: veh[0],
    layout: allowed.map((p) => ({ code: p, label: POSITION_LABELS[p], tire: fitted.find((t) => t.current_position === p) ?? null })),
  });
}));

export default router;
