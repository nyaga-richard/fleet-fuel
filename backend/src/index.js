// Server bootstrap with graceful shutdown (Docker sends SIGTERM on stop).
import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db/pool.js';

const app = createApp();
const server = app.listen(config.port, '0.0.0.0', () => {
  console.log('┌─────────────────────────────────────────────────┐');
  console.log('│ Fleet Fuel Management System — API              │');
  console.log(`│ version : ${config.version.padEnd(42)}│`);
  console.log(`│ commit  : ${config.commit.padEnd(42)}│`);
  console.log(`│ env     : ${config.env.padEnd(42)}│`);
  console.log(`│ listening on 0.0.0.0:${String(config.port).padEnd(26)}│`);
  console.log('└─────────────────────────────────────────────────┘');
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[api] ${signal} received — shutting down gracefully ...`);
  server.close(async () => {
    try { await pool.end(); } catch { /* ignore */ }
    process.exit(0);
  });
  // Hard exit if connections do not drain in time.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => {
  console.error('[api] unhandled rejection:', err);
});
