// Express application assembly.
import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { notFoundHandler, errorHandler } from './middleware/errors.js';

import healthRoutes from './routes/health.js';
import authRoutes from './routes/auth.js';
import usersRoutes from './routes/users.js';
import vehiclesRoutes from './routes/vehicles.js';
import fuelTypesRoutes from './routes/fuelTypes.js';
import tanksRoutes from './routes/tanks.js';
import pumpsRoutes from './routes/pumps.js';
import requestsRoutes from './routes/requests.js';
import transactionsRoutes from './routes/transactions.js';
import inventoryRoutes from './routes/inventory.js';
import ledgerRoutes from './routes/ledger.js';
import syncRoutes from './routes/sync.js';
import systemRoutes from './routes/system.js';
import reportsRoutes from './routes/reports.js';
import notificationsRoutes from './routes/notifications.js';
import approvalsRoutes from './routes/approvals.js';
import devicesRoutes from './routes/devices.js';

export function createApp() {
  const app = express();

  // Behind Cloudflare Tunnel → honor X-Forwarded-* for real client IPs.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // CORS: explicit allow-list from CORS_ORIGIN. Native/mobile apps send no
  // Origin header and are unaffected by CORS. Never allow '*' in production.
  app.use(cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // curl, mobile apps, server-to-server
      if (config.corsOrigins.length === 0) return cb(null, true); // dev default
      if (config.corsOrigins.includes(origin)) return cb(null, true);
      cb(new Error(`Origin not allowed by CORS: ${origin}`));
    },
  }));

  // JSON bodies (uploads are base64 inside JSON; kept modest).
  app.use(express.json({ limit: '15mb' }));

  // Minimal request log.
  app.use((req, _res, next) => {
    if (!req.path.startsWith('/api/health')) {
      console.log(`[api] ${new Date().toISOString()} ${req.method} ${req.originalUrl}${req.user ? ` (user:${req.user.email})` : ''}`);
    }
    next();
  });

  app.use('/api/health', healthRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/users', usersRoutes);
  app.use('/api/vehicles', vehiclesRoutes);
  app.use('/api/fuel-types', fuelTypesRoutes);
  app.use('/api/tanks', tanksRoutes);
  app.use('/api/pumps', pumpsRoutes);
  app.use('/api/requests', requestsRoutes);
  app.use('/api/transactions', transactionsRoutes);
  app.use('/api/inventory', inventoryRoutes);
  app.use('/api/ledger', ledgerRoutes);
  app.use('/api/sync', syncRoutes);
  app.use('/api/system', systemRoutes);
  app.use('/api/reports', reportsRoutes);
  app.use('/api/notifications', notificationsRoutes);
  app.use('/api/approvals', approvalsRoutes);
app.use('/api/devices', devicesRoutes);

  app.use('/api', notFoundHandler);
  app.get('/', (_req, res) => res.json({ service: 'fleet-fuel-api', docs: '/api/health', version: config.version }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
