// ============================================================================
// /api/me — the signed-in user's own preferences (§31–§33). Theme preference
// is stored per user (user_theme_preferences) so web and mobile can stay
// consistent (§39); the web ALSO keeps it in localStorage for instant paint.
// ============================================================================
import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncH, bad } from '../middleware/errors.js';

const router = Router();
router.use(requireAuth);

router.get('/theme', asyncH(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT theme, updated_at FROM user_theme_preferences WHERE user_id = $1', [req.user.sub]);
  res.json({ theme: rows[0]?.theme || 'SYSTEM' });
}));

router.put('/theme', asyncH(async (req, res) => {
  const theme = String(req.body?.theme || '').toUpperCase();
  if (!['LIGHT', 'DARK', 'SYSTEM'].includes(theme)) throw bad('Theme must be LIGHT, DARK or SYSTEM');
  const { rows } = await pool.query(
    `INSERT INTO user_theme_preferences (user_id, theme) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET theme = $2, updated_at = now()
     RETURNING theme`, [req.user.sub, theme]);
  res.json({ theme: rows[0].theme });
}));

export default router;
