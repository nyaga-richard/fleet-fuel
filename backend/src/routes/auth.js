// Authentication — login issues a signed JWT; /me returns the session user.
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../db/pool.js';
import { requireAuth, signToken } from '../middleware/auth.js';
import { asyncH, bad, unauthorized } from '../middleware/errors.js';
import { audit } from '../services/audit.js';

const router = Router();

// Basic in-memory login rate limiting (per IP). No Redis needed at this scale.
const attempts = new Map(); // ip → {count, resetAt}
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 20;
function loginThrottled(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || rec.resetAt < now) {
    attempts.set(ip, { count: 0, resetAt: now + WINDOW_MS });
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}
function recordFailure(ip) {
  const rec = attempts.get(ip) || { count: 0, resetAt: Date.now() + WINDOW_MS };
  rec.count += 1;
  attempts.set(ip, rec);
}

router.post('/login', asyncH(async (req, res) => {
  const ip = req.ip || 'unknown';
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) throw bad('Email and password are required');
  if (loginThrottled(ip)) throw unauthorized('Too many failed attempts — try again later');

  const { rows } = await pool.query(
    `SELECT id, name, email, password_hash, role, active FROM users WHERE email = $1`,
    [email],
  );
  const user = rows[0];
  const ok = user && user.active && (await bcrypt.compare(password, user.password_hash));
  if (!ok) {
    recordFailure(ip);
    await audit(null, { action: 'auth.login_failed', entity: 'users', entityId: user?.id ?? null, ip, details: { email } });
    throw unauthorized('Invalid email or password');
  }
  attempts.delete(ip);

  res.json({ token: signToken(user), user: { id: user.id, name: user.name, email: user.email, role: user.role } });
}));

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

export default router;
