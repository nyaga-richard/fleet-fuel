// ============================================================================
// /api/wheel-configs — administration of wheel/axle configuration master data
// (§1–§8). Stored in the DB; never hardcoded in the frontend. Codes are
// stable identifiers; structure edits are locked once vehicles use the
// configuration (create a new one instead — history is preserved, §6).
// ============================================================================
import { Router } from 'express';
import { pool, tx } from '../db/pool.js';
import { requireAuth, requirePerm, requireRole } from '../middleware/auth.js';
import { asyncH, bad, notFound } from '../middleware/errors.js';
import { needStr, isUuid, optStr } from '../middleware/validate.js';
import { audit } from '../services/audit.js';
import { normalizeConfiguration, insertConfiguration, loadConfiguration } from '../services/wheel-configs.js';

const router = Router();
router.use(requireAuth);

// List with per-configuration vehicle usage (§45 report data).
router.get('/', requirePerm('wheel_configs:view'), asyncH(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT w.*,
            (SELECT COUNT(*)::int FROM vehicles v WHERE v.wheel_configuration_id = w.id) AS vehicle_count,
            (SELECT COUNT(*)::int FROM vehicles v WHERE v.wheel_configuration_id = w.id AND v.status = 'ACTIVE') AS active_vehicles
       FROM wheel_configurations w
      WHERE ($1::text IS NULL OR w.is_active = ($1::text = 'ACTIVE'))
      ORDER BY w.is_system DESC, w.code`, [req.query.active ? String(req.query.active).toUpperCase() : null]);
  res.json({ configurations: rows });
}));

router.get('/:id', requirePerm('wheel_configs:view'), asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound('Configuration not found');
  const cfg = await loadConfiguration(pool, req.params.id);
  if (!cfg) throw notFound('Configuration not found');
  const { rows: usage } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM vehicles WHERE wheel_configuration_id = $1', [req.params.id]);
  res.json({ ...cfg, vehicles_using: usage[0].n });
}));

// Create (§1/§3) — payload validated server-side (§8).
router.post('/', requirePerm('wheel_configs:manage'), asyncH(async (req, res) => {
  const normalized = normalizeConfiguration(req.body ?? {});
  const { row } = await tx(async (client) => {
    const dup = await client.query('SELECT id FROM wheel_configurations WHERE code = $1', [normalized.code]);
    if (dup.rows.length) throw bad(`A configuration with code ${normalized.code} already exists`);
    const cfg = await insertConfiguration(client, normalized, { notes: optStr(req.body ?? {}, 'notes', { max: 300 }) });
    await audit(client, { userId: req.user.sub, action: 'wheel_config.created', entity: 'wheel_configurations', entityId: cfg.id,
      details: { code: cfg.code, axles: cfg.axles, wheel_count: cfg.wheel_count }, ip: req.ip });
    return { row: cfg };
  });
  res.status(201).json({ configuration: row });
}));

// Update. The code is immutable (§5). Structure (axles/positions) can only
// change while no vehicle uses the configuration — otherwise assignments and
// history would silently break (§6).
router.patch('/:id', requirePerm('wheel_configs:manage'), asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound('Configuration not found');
  const b = req.body ?? {};
  const { row } = await tx(async (client) => {
    const { rows } = await client.query('SELECT * FROM wheel_configurations WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!rows.length) throw notFound('Configuration not found');
    const cur = rows[0];
    if (b.code !== undefined && String(b.code).trim().toUpperCase() !== cur.code) {
      throw bad('Position codes and configuration codes are permanent identifiers — create a new configuration instead (§5)');
    }
    const { rows: usage } = await client.query(
      'SELECT COUNT(*)::int AS n FROM vehicles WHERE wheel_configuration_id = $1', [req.params.id]);
    const structureChange = b.axles !== undefined;
    if (structureChange && usage[0].n > 0) {
      throw bad(`${usage[0].n} vehicle(s) use this configuration — its axle structure is locked. Create a new configuration (§6)`);
    }
    if (structureChange) {
      const normalized = normalizeConfiguration({ ...cur, ...b });
      await client.query('DELETE FROM wheel_configuration_positions WHERE configuration_id = $1', [req.params.id]);
      await client.query('DELETE FROM wheel_configuration_axles WHERE configuration_id = $1', [req.params.id]);
      await client.query('UPDATE wheel_configurations SET axles = $2, wheel_count = $3 WHERE id = $1',
        [req.params.id, normalized.axle_count, normalized.wheel_count]);
      for (const a of normalized.axles) {
        await client.query('INSERT INTO wheel_configuration_axles (configuration_id, axle_number, axle_type) VALUES ($1,$2,$3)',
          [req.params.id, a.axle_number, a.axle_type]);
        for (const p of a.positions) {
          await client.query(
            `INSERT INTO wheel_configuration_positions
               (configuration_id, axle_number, axle_type, side, wheel_position, position_code, display_name, is_required, sort_order)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [req.params.id, p.axle_number, p.axle_type, p.side, p.wheel_position, p.position_code, p.display_name, p.is_required, p.sort_order]);
        }
      }
    }
    const sets = []; const params = [req.params.id];
    const push = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (b.name !== undefined) push('name', needStr(b, 'name', { max: 80, optional: true }) || `${cur.code} — Wheel Configuration`);
    if (b.notes !== undefined) push('notes', needStr(b, 'notes', { max: 300, optional: true }));
    if (!sets.length && !structureChange) throw bad('Nothing to update');
    if (sets.length || structureChange) {
      await client.query(`UPDATE wheel_configurations SET ${sets.length ? sets.join(', ') + ', ' : ''}updated_at = now() WHERE id = $1`, params);
    }
    await audit(client, { userId: req.user.sub, action: 'wheel_config.updated', entity: 'wheel_configurations', entityId: req.params.id,
      details: { structureChange }, ip: req.ip });
    return { row: (await loadConfiguration(client, req.params.id)) };
  });
  res.json(row);
}));

router.post('/:id/activate', requirePerm('wheel_configs:manage'), asyncH(async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE wheel_configurations SET is_active = true, updated_at = now() WHERE id = $1 RETURNING *', [req.params.id]);
  if (!rows.length) throw notFound('Configuration not found');
  await audit(null, { userId: req.user.sub, action: 'wheel_config.activated', entity: 'wheel_configurations', entityId: req.params.id, ip: req.ip });
  res.json({ configuration: rows[0] });
}));

router.post('/:id/deactivate', requirePerm('wheel_configs:manage'), asyncH(async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE wheel_configurations SET is_active = false, updated_at = now() WHERE id = $1 RETURNING *', [req.params.id]);
  if (!rows.length) throw notFound('Configuration not found');
  await audit(null, { userId: req.user.sub, action: 'wheel_config.deactivated', entity: 'wheel_configurations', entityId: req.params.id, ip: req.ip });
  res.json({ configuration: rows[0] });
}));

export default router;
