// ============================================================================
// Migration runner — node-pg-migrate wrapped in a PostgreSQL advisory lock so
// concurrent deployments/containers can never run migrations simultaneously.
//
// Only PENDING migrations are applied ("Existing DB → run pending → updated").
// Each migration runs inside its own transaction: a failure rolls back that
// migration completely and leaves the database at the previous good version.
// This script NEVER creates, drops, or resets the database.
//
// Usage: node src/db/migrate.js [--down]
// ============================================================================
import runner from 'node-pg-migrate';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_TABLE = 'pgmigrations';
const LOCK_KEY = 0xF1E37 // deterministic app-specific advisory lock id

async function main() {
  if (!config.databaseUrl) {
    console.error('FATAL: DATABASE_URL is not set.');
    process.exit(1);
  }

  const direction = process.argv.includes('--down') ? 'down' : 'up';

  const client = await pool.connect();
  try {
    // Serialize migrations across containers/hosts.
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    try {
      const applied = await runner({
        dbClient: client,
        dir: path.join(__dirname, '../../migrations'),
        migrationsTable: MIGRATIONS_TABLE,
        direction,
        count: direction === 'up' ? Infinity : 1,
        verbose: true,
        log: (msg) => console.log(`[migrate] ${msg}`),
      });
      const count = Array.isArray(applied) ? applied.length : 0;
      console.log(`[migrate] done — ${count} migration(s) ${direction === 'up' ? 'applied' : 'reverted'}.`);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[migrate] FAILED:', err.message);
  process.exit(1);
});
