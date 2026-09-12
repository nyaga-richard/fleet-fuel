// Health endpoints — used by Docker healthchecks, deploy scripts and monitors.
import { Router } from 'express';
import { dbCheck } from '../db/pool.js';
import { config } from '../config.js';
import { pool } from '../db/pool.js';

const router = Router();

// Liveness: process is up (Docker restart policy relies on this).
router.get('/live', (_req, res) => {
  res.json({ status: 'ok', uptime_s: Math.round(process.uptime()) });
});

// Readiness: process is up AND database accepts connections.
router.get('/ready', async (_req, res) => {
  try {
    await dbCheck();
    res.json({ status: 'ok', database: 'connected' });
  } catch {
    res.status(503).json({ status: 'error', database: 'disconnected' });
  }
});

// Full health summary.
router.get('/', async (_req, res) => {
  let db = 'connected';
  try {
    await dbCheck();
  } catch {
    db = 'disconnected';
  }
  const body = {
    status: db === 'connected' ? 'ok' : 'error',
    service: 'fleet-fuel-api',
    database: db,
    version: config.version,
    commit: config.commit,
    environment: config.env,
  };
  res.status(db === 'connected' ? 200 : 503).json(body);
});

router.get('/db', async (_req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT version() AS v, current_database() AS db, now() AS now');
    res.json(rows[0]);
  } catch (err) { next(err); }
});

export default router;
