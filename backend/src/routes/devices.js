import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { asyncH } from '../middleware/errors.js';

const r = Router();
r.use(requireAuth);

// Register/update this device's push token (§40) — one row per device.
r.post('/', asyncH(async (req, res) => {
  const { device_id, platform, push_token, app_version } = req.body || {};
  if (!device_id || !platform) return res.status(400).json({ error: 'device_id and platform are required' });
  if (!['android', 'ios', 'web'].includes(platform)) return res.status(400).json({ error: 'Invalid platform' });
  const { rows } = await pool.query(
    `INSERT INTO push_devices (device_id, user_id, platform, push_token, app_version, last_seen_at, active)
     VALUES ($1, $2, $3, $4, $5, now(), true)
     ON CONFLICT (user_id, device_id) DO UPDATE
        SET platform = EXCLUDED.platform,
            push_token = COALESCE(EXCLUDED.push_token, push_devices.push_token),
            app_version = COALESCE(EXCLUDED.app_version, push_devices.app_version),
            last_seen_at = now(), active = true
     RETURNING id, device_id, platform, active`,
    [String(device_id).slice(0, 128), req.user.sub, platform, push_token ? String(push_token).slice(0, 256) : null, app_version ? String(app_version).slice(0, 32) : null]);
  res.json({ device: rows[0] });
}));

// Admin: list registered devices
r.get('/', requireRole('admin'), asyncH(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT d.id, d.device_id, d.platform, d.app_version, d.last_seen_at AS last_seen, d.active, u.name AS user, u.email
       FROM push_devices d LEFT JOIN users u ON u.id = d.user_id ORDER BY d.last_seen_at DESC LIMIT 1000`);
  res.json({ devices: rows });
}));

// Admin: deactivate/reactivate a device (e.g. lost phone)
r.patch('/:id/active', requireRole('admin'), asyncH(async (req, res) => {
  const active = !!req.body?.active;
  const { rows } = await pool.query('UPDATE push_devices SET active = $2 WHERE id = $1 RETURNING id, active',
    [req.params.id, active]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  await audit(null, { userId: req.user.sub, action: 'push_device.' + (active ? 'activated' : 'deactivated'), entity: 'push_device', entityId: rows[0].id, details: { active }, ip: req.ip });
  res.json({ device: rows[0] });
}));

export default r;
