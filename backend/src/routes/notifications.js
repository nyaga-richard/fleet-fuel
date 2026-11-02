// ============================================================================
// /api/notifications (§42/§41) — every query is scoped to the authenticated
// user. Read state never deletes rows (§36).
// ============================================================================
import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncH, bad } from '../middleware/errors.js';
import { isUuid } from '../middleware/validate.js';

const router = Router();
router.use(requireAuth);

router.get('/', asyncH(async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 50), 200);
  const unreadOnly = req.query.unread === '1' || req.query.unread === 'true';
  const params = [req.user.sub];
  const { rows } = await pool.query(
    `SELECT id, type, title, message, entity_type, entity_id, severity,
            is_read, read_at, created_at, metadata
       FROM notifications
      WHERE user_id = $1 ${unreadOnly ? 'AND is_read = false' : ''}
      ORDER BY created_at DESC
      LIMIT $2`, [params[0], limit]);
  const { rows: c } = await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND is_read = false`, [req.user.sub]);
  res.json({ notifications: rows, unread: c[0].n });
}));

// §37 — per-user category preferences
router.get('/preferences', asyncH(async (req, res) => {
  const { rows } = await pool.query('SELECT notification_prefs FROM users WHERE id = $1', [req.user.sub]);
  res.json({ preferences: rows[0]?.notification_prefs || {} });
}));

router.put('/preferences', asyncH(async (req, res) => {
  const prefs = req.body?.preferences;
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
    return res.status(400).json({ error: 'preferences object required' });
  }
  const clean = {};
  for (const [k, v] of Object.entries(prefs).slice(0, 50)) if (typeof v === 'boolean') clean[String(k).slice(0, 64)] = v;
  await pool.query('UPDATE users SET notification_prefs = $2 WHERE id = $1', [req.user.sub, JSON.stringify(clean)]);
  res.json({ preferences: clean });
}));

router.get('/unread-count', asyncH(async (req, res) => {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND is_read = false`, [req.user.sub]);
  res.json({ unread: rows[0].n });
}));

router.patch('/read-all', asyncH(async (req, res) => {
  const { rowCount } = await pool.query(
    `UPDATE notifications SET is_read = true, read_at = now() WHERE user_id = $1 AND is_read = false`, [req.user.sub]);
  res.json({ updated: rowCount });
}));

router.patch('/:id/read', asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) throw bad('Invalid notification id');
  // Scoped to the owner — another user's id simply matches nothing (§41).
  const { rowCount } = await pool.query(
    `UPDATE notifications SET is_read = true, read_at = now()
      WHERE id = $1 AND user_id = $2 AND is_read = false`, [req.params.id, req.user.sub]);
  res.json({ updated: rowCount });
}));

export default router;
