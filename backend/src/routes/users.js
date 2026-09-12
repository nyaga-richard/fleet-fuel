// User administration (admin only). Users are NEVER deleted — deactivated,
// preserving history and accountability.
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../db/pool.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncH, bad, notFound } from '../middleware/errors.js';
import { needStr, needOneOf, isUuid } from '../middleware/validate.js';
import { audit } from '../services/audit.js';

const router = Router();
router.use(requireAuth, requireRole('admin'));

router.get('/', asyncH(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, email, role, phone, active, created_at, updated_at
       FROM users ORDER BY created_at`);
  res.json({ users: rows });
}));

router.post('/', asyncH(async (req, res) => {
  const name = needStr(req.body, 'name', { max: 120 });
  const email = needStr(req.body, 'email', { max: 200 }).toLowerCase();
  const password = needStr(req.body, 'password', { min: 8, max: 100 });
  const role = needOneOf(req.body, 'role', ['admin', 'manager', 'attendant']);
  const phone = needStr(req.body, 'phone', { max: 30, optional: true });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Invalid email address');

  const hash = await bcrypt.hash(password, 12);
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, phone)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, name, email, role, phone, active, created_at`,
      [name, email, hash, role, phone]);
    await audit(null, { userId: req.user.sub, action: 'user.create', entity: 'users', entityId: rows[0].id, details: { email, role }, ip: req.ip });
    res.status(201).json({ user: rows[0] });
  } catch (err) {
    if (err.code === '23505') throw bad('A user with that email already exists');
    throw err;
  }
}));

router.patch('/:id', asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound('User not found');
  const current = (await pool.query(`SELECT id FROM users WHERE id = $1`, [req.params.id])).rows[0];
  if (!current) throw notFound('User not found');

  const sets = [];
  const params = [req.params.id];
  const b = req.body ?? {};
  if (b.name !== undefined) { params.push(needStr(b, 'name', { max: 120 })); sets.push(`name = $${params.length}`); }
  if (b.phone !== undefined) { params.push(needStr(b, 'phone', { max: 30, optional: true })); sets.push(`phone = $${params.length}`); }
  if (b.role !== undefined) { params.push(needOneOf(b, 'role', ['admin', 'manager', 'attendant'])); sets.push(`role = $${params.length}`); }
  if (b.active !== undefined) {
    if (req.params.id === req.user.sub && b.active === false) throw bad('You cannot deactivate your own account');
    params.push(Boolean(b.active)); sets.push(`active = $${params.length}`);
  }
  if (b.password !== undefined) {
    params.push(await bcrypt.hash(needStr(b, 'password', { min: 8, max: 100 }), 12));
    sets.push(`password_hash = $${params.length}`);
  }
  if (!sets.length) throw bad('Nothing to update');

  const { rows } = await pool.query(
    `UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $1
     RETURNING id, name, email, role, phone, active, updated_at`, params);
  await audit(null, { userId: req.user.sub, action: 'user.update', entity: 'users', entityId: req.params.id, details: { fields: sets.map((s) => s.split('=')[0].trim()) }, ip: req.ip });
  res.json({ user: rows[0] });
}));

router.delete('/:id', asyncH(async (_req, _res) => {
  throw bad('Users are never deleted. Deactivate the account instead (preserves audit history).');
}));

export default router;
