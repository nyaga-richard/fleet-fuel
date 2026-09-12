// ============================================================================
// Mobile offline sync.
//
// The mobile app queues operations in on-device SQLite while offline and
// replays them here. Every op carries a client_uuid (or op_id) and is applied
// AT MOST ONCE — replaying a batch is always safe (idempotent by design).
//
//   POST /api/sync/batch  → apply queued ops (per-op result, never all-or-nothing)
//   GET  /api/sync/pull   → authoritative reference data + recent ops + stock
//   GET  /api/sync/log    → recent sync outcomes (ops diagnostics)
//
// PostgreSQL remains the central authority for authorizations, users, roles,
// inventory, the fuel ledger and final transactions — SQLite is only the
// device's local operational store.
// ============================================================================
import { Router } from 'express';
import { pool, tx } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncH, bad } from '../middleware/errors.js';
import { SYNC_OP_TYPES } from '../services/ops.js';
import { stockByFuelType, stockByTank } from '../services/ledger.js';

const router = Router();
router.use(requireAuth);

router.post('/batch', asyncH(async (req, res) => {
  const deviceId = String(req.body?.device_id || '').trim().slice(0, 100);
  if (!deviceId) throw bad('device_id is required');
  const ops = Array.isArray(req.body?.ops) ? req.body.ops.slice(0, 200) : [];
  if (!ops.length) throw bad('ops array is required');

  const results = [];
  for (const op of ops) {
    const opId = String(op?.op_id || '').slice(0, 100) || null;
    const type = String(op?.type || '');
    const payload = (op?.payload && typeof op.payload === 'object') ? op.payload : {};
    const handler = SYNC_OP_TYPES[type];

    let result;
    try {
      if (!handler) throw new Error(`Unsupported operation type: ${type || '(none)'}`);
      if (opId) payload.client_uuid = payload.client_uuid || opId; // idempotency key
      const { row, duplicate } = await tx((client) => handler(client, { payload, userId: req.user.sub }));
      result = {
        op_id: opId,
        status: duplicate ? 'duplicate' : 'applied',
        ref: { id: row.id, ...(row.request_no ? { request_no: row.request_no } : {}), ...(row.txn_no ? { txn_no: row.txn_no } : {}) },
      };
    } catch (err) {
      // Permanent failure (validation/conflict): reported per-op so the
      // device can park it instead of retrying forever.
      result = { op_id: opId, status: 'failed', message: err.status ? err.message : 'Server error applying operation' };
      if (!err.status) console.error(`[sync] op ${opId} crashed:`, err.message);
    }

    try {
      await pool.query(
        `INSERT INTO sync_log (device_id, op_id, op_type, status, message, server_ref, user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [deviceId, opId, type || null, result.status, result.message ?? null, result.ref?.id ?? null, req.user.sub]);
    } catch (e) {
      console.error('[sync] failed to record sync_log:', e.message);
    }
    results.push(result);
  }

  res.json({ results, server_time: new Date().toISOString() });
}));

router.get('/pull', asyncH(async (req, res) => {
  // `since` lets the device request only deltas; empty → full snapshot.
  const sinceRaw = req.query.since ? new Date(String(req.query.since)) : null;
  const since = sinceRaw && !Number.isNaN(sinceRaw.getTime()) ? sinceRaw.toISOString() : null;

  const refParams = [];
  const refWhere = since ? `WHERE updated_at > $1` : '';
  if (since) refParams.push(since);
  const opParams = since ? [since] : [];
  const opSince = since ? `AND updated_at > $1` : '';

  const [vehicles, fuelTypes, tanks, pumps, stockType, stockTank, requests, transactions] = await Promise.all([
    pool.query(`SELECT id, plate, make, model, vehicle_type, driver_name, tank_capacity, active, updated_at FROM vehicles ${refWhere} ORDER BY plate`, refParams),
    pool.query(`SELECT id, name, code, unit, active FROM fuel_types ${refWhere} ORDER BY name`, refParams),
    pool.query(`SELECT t.id, t.name, t.fuel_type_id, t.capacity, t.active, ft.name AS fuel_type_name FROM tanks t JOIN fuel_types ft ON ft.id = t.fuel_type_id ${refWhere ? 'WHERE t.updated_at > $1' : ''} ORDER BY t.name`, refParams),
    pool.query(`SELECT p.id, p.name, p.tank_id, p.active, t.name AS tank_name, ft.code AS fuel_type_code FROM pumps p JOIN tanks t ON t.id = p.tank_id JOIN fuel_types ft ON ft.id = t.fuel_type_id ${refWhere ? 'WHERE p.updated_at > $1' : ''} ORDER BY p.name`, refParams),
    stockByFuelType(),
    stockByTank(),
    pool.query(
      `SELECT r.id, r.request_no, r.vehicle_id, r.fuel_type_id, r.quantity, r.status,
              r.driver_name, r.created_at, r.updated_at, v.plate
         FROM fuel_requests r JOIN vehicles v ON v.id = r.vehicle_id
        WHERE true ${opSince.replace('updated_at', 'r.updated_at')}
        ORDER BY r.created_at DESC LIMIT 400`, opParams),
    pool.query(
      `SELECT t.id, t.txn_no, t.request_id, t.vehicle_id, t.fuel_type_id, t.quantity,
              t.status, t.created_at, t.updated_at, v.plate
         FROM fuel_transactions t JOIN vehicles v ON v.id = t.vehicle_id
        WHERE true ${opSince.replace('updated_at', 't.updated_at')}
        ORDER BY t.created_at DESC LIMIT 400`, opParams),
  ]);

  res.json({
    server_time: new Date().toISOString(),
    full_sync: !since,
    reference: {
      vehicles: vehicles.rows,
      fuel_types: fuelTypes.rows,
      tanks: tanks.rows,
      pumps: pumps.rows,
    },
    stock: { by_fuel_type: stockType, by_tank: stockTank },
    requests: requests.rows,
    transactions: transactions.rows,
  });
}));

router.get('/log', asyncH(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT s.*, u.name AS user_name FROM sync_log s
       LEFT JOIN users u ON u.id = s.user_id
      ORDER BY s.created_at DESC LIMIT 200`);
  const counts = (await pool.query(
    `SELECT status, count(*)::int FROM sync_log
      WHERE created_at > now() - interval '7 days' GROUP BY status`)).rows;
  res.json({ recent: rows, counts_7d: Object.fromEntries(counts.map((r) => [r.status, r.count])) });
}));

export default router;
