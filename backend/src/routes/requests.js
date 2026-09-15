// Fuel requests + authorizations workflow:
//   attendant/manager creates → pending → manager approves/rejects → issued
import { Router } from 'express';
import { pool, tx } from '../db/pool.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncH, notFound, bad } from '../middleware/errors.js';
import { needUuid, needNum, needStr, optUuid, isUuid } from '../middleware/validate.js';
import { createFuelRequest, decideFuelRequest } from '../services/ops.js';

const router = Router();
router.use(requireAuth);

const SELECT = `
  SELECT r.*, v.plate, v.make, v.model, ft.name AS fuel_type_name, ft.code AS fuel_type_code,
         u.name AS requested_by_name,
         a.decision AS auth_decision, au.name AS authorized_by_name, a.decided_at
    FROM fuel_requests r
    JOIN vehicles v ON v.id = r.vehicle_id
    JOIN fuel_types ft ON ft.id = r.fuel_type_id
    JOIN users u ON u.id = r.requested_by
    LEFT JOIN LATERAL (
      SELECT * FROM authorizations a2 WHERE a2.request_id = r.id
      ORDER BY decided_at DESC LIMIT 1) a ON true
    LEFT JOIN users au ON au.id = a.decided_by`;

router.get('/', asyncH(async (req, res) => {
  const params = [];
  const where = [];
  if (req.query.status) { params.push(String(req.query.status)); where.push(`r.status = $${params.length}`); }
  if (req.query.vehicle_id) { params.push(String(req.query.vehicle_id)); where.push(`r.vehicle_id = $${params.length}`); }
  if (req.query.mine === 'true') { params.push(req.user.sub); where.push(`r.requested_by = $${params.length}`); }
  const limit = Math.min(Number(req.query.limit || 200), 500);
  params.push(limit);
  const { rows } = await pool.query(
    `${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY r.created_at DESC LIMIT $${params.length}`, params);
  res.json({ requests: rows });
}));

router.get('/:id', asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound('Request not found');
  const { rows } = await pool.query(`${SELECT} WHERE r.id = $1`, [req.params.id]);
  if (!rows.length) throw notFound('Request not found');
  const authorizations = (await pool.query(
    `SELECT a.*, u.name AS decided_by_name FROM authorizations a
       JOIN users u ON u.id = a.decided_by WHERE a.request_id = $1 ORDER BY a.decided_at DESC`,
    [req.params.id])).rows;
  res.json({ request: rows[0], authorizations });
}));

// Create a fuel request (attendants and managers). Idempotent on client_uuid
// (offline mobile sync replays safely).
router.post('/', requireRole('attendant', 'manager', 'admin'), asyncH(async (req, res) => {
  const payload = {
    vehicle_id: needUuid(req.body, 'vehicle_id'),
    fuel_type_id: needUuid(req.body, 'fuel_type_id'),
    quantity: needNum(req.body, 'quantity', { max: 1_000_000 }),
    driver_name: needStr(req.body, 'driver_name', { max: 120, optional: true }),
    odometer: needNum(req.body, 'odometer', { min: 0, optional: true }),
    destination: needStr(req.body, 'destination', { max: 200, optional: true }),
    notes: needStr(req.body, 'notes', { max: 500, optional: true }),
    client_uuid: optUuid(req.body, 'client_uuid'),
  };
  const { row, duplicate } = await tx((client) =>
    createFuelRequest(client, { payload, userId: req.user.sub }));
  res.status(duplicate ? 200 : 201).json({ request: row, duplicate });
}));

router.post('/:id/approve', requireRole('manager', 'admin'), asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound('Request not found');
  const comments = needStr(req.body, 'comments', { max: 500, optional: true });
  const row = await tx((client) =>
    decideFuelRequest(client, { requestId: req.params.id, decision: 'approved', userId: req.user.sub, comments }));
  res.json({ request: row });
}));

router.post('/:id/reject', requireRole('manager', 'admin'), asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound('Request not found');
  const comments = needStr(req.body, 'comments', { max: 500, optional: true });
  if (!comments || !comments.trim()) throw bad('A rejection reason is required (§19)');
  const row = await tx((client) =>
    decideFuelRequest(client, { requestId: req.params.id, decision: 'rejected', userId: req.user.sub, comments }));
  res.json({ request: row });
}));

router.post('/:id/cancel', asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound('Request not found');
  const row = await tx(async (client) => {
    const { rows } = await client.query(`SELECT * FROM fuel_requests WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!rows.length) throw notFound('Request not found');
    if (rows[0].status !== 'pending') throw bad(`Only pending requests can be cancelled (status: ${rows[0].status})`);
    if (rows[0].requested_by !== req.user.sub && req.user.role !== 'admin') {
      throw bad('Only the requester or an admin can cancel a request');
    }
    const { rows: updated } = await client.query(
      `UPDATE fuel_requests SET status = 'cancelled', updated_at = now() WHERE id = $1 RETURNING *`, [req.params.id]);
    const { audit } = await import('../services/audit.js');
    await audit(client, { userId: req.user.sub, action: 'fuel_request.cancel', entity: 'fuel_requests', entityId: req.params.id, ip: req.ip });
    return updated[0];
  });
  res.json({ request: row });
}));

export default router;
