// System/version information — displayed on the web admin "System" page.
import { Router } from 'express';
import os from 'node:os';
import { pool } from '../db/pool.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncH } from '../middleware/errors.js';
import { config } from '../config.js';

const router = Router();

// Every system endpoint requires a signed-in session (matches all other
// routers). Without this, requireRole below saw req.user === undefined and
// returned 401 for EVERYONE — which the web client treats as "session
// expired", logging users out the moment they opened the System page.
router.use(requireAuth);

function buildInfo() {
  return {
    name: 'Fleet Fuel Management System',
    version: config.version,
    commit: config.commit,
    branch: config.branch,
    build_date: config.buildDate,
    environment: config.env,
    timezone: config.timezone,
  };
}

router.get('/version', asyncH(async (_req, res) => {
  let migrations = null;
  try {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS applied, max(name) AS latest FROM pgmigrations`);
    migrations = rows[0];
  } catch { /* not migrated yet */ }
  res.json({
    ...buildInfo(),
    runtime: {
      node: process.version,
      uptime_s: Math.round(process.uptime()),
      hostname: os.hostname(),
      started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    },
    database: { migrations },
    server_time: new Date().toISOString(),
  });
}));

// Deployment state recorded by scripts/deploy.sh (last deploy outcome).
router.get('/deployments', requireRole('admin', 'manager'), asyncH(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT action, entity, details, created_at FROM audit_logs
      WHERE action IN ('deploy.complete', 'deploy.rollback', 'deploy.start')
      ORDER BY created_at DESC LIMIT 20`).catch(() => ({ rows: [] }));
  res.json({ deployments: rows, current: buildInfo() });
}));

export default router;
