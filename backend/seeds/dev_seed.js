// ============================================================================
// Idempotent seed data — SAFE to run any number of times, on any environment.
//
// - The admin account is created ONLY if the users table is empty.
// - Reference rows (fuel types) use ON CONFLICT DO NOTHING.
// - Example tank/pump/vehicle are created only when missing.
// - NEVER overwrites or deletes existing production data.
//
// Production deployments do NOT run this automatically. Operators may run
// `npm run seed` once on a fresh install. Development: `npm run seed`.
// ============================================================================
import bcrypt from 'bcryptjs';
import { pool } from '../src/db/pool.js';
import { config } from '../src/config.js';

const SEED_DEMO = String(process.env.SEED_DEMO_DATA ?? 'true') !== 'false';

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── Administrator — only on a completely fresh database ────────────────
    const { rows: userCount } = await client.query('SELECT count(*)::int AS n FROM users');
    if (userCount[0].n === 0) {
      const email = config.seedAdmin.email;
      const name = config.seedAdmin.name;
      const password = config.seedAdmin.password || 'ChangeMe123!';
      if (config.isProduction && (!config.seedAdmin.password || config.seedAdmin.password.toUpperCase().includes('CHANGE_THIS'))) {
        throw new Error('Refusing to seed production without SEED_ADMIN_PASSWORD set in .env');
      }
      const hash = await bcrypt.hash(password, 12);
      const { rows } = await client.query(
        `INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,'admin')
         ON CONFLICT (email) DO NOTHING RETURNING id`,
        [name, email, hash]);
      console.log(`[seed] admin user created: ${email} (role: admin)${rows.length ? '' : ' — already existed'}`);
      console.log('[seed] ⚠  change this password after first login');
    } else {
      console.log('[seed] users exist — admin seed skipped');
    }

    // ── Fuel types — idempotent reference data ─────────────────────────────
    for (const [name, code] of [['Diesel', 'DIESEL'], ['Petrol', 'PETROL']]) {
      await client.query(
        `INSERT INTO fuel_types (name, code) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING`,
        [name, code]);
    }
    console.log('[seed] fuel types ensured (Diesel, Petrol)');

    if (SEED_DEMO) {
      // ── Example tank/pump/vehicle — created only when missing ────────────
      const { rows: diesel } = await client.query(`SELECT id FROM fuel_types WHERE code = 'DIESEL'`);
      const dieselId = diesel[0]?.id;
      if (dieselId) {
        const { rows: tank } = await client.query(
          `INSERT INTO tanks (name, fuel_type_id, capacity, location)
           SELECT 'Main Diesel Tank', $1, 10000, 'Yard A'
           WHERE NOT EXISTS (SELECT 1 FROM tanks WHERE name = 'Main Diesel Tank')
           RETURNING id`, [dieselId]);
        if (tank.length) console.log('[seed] example tank created (Main Diesel Tank, 10,000 L)');
        const { rows: tankRow } = await client.query(`SELECT id FROM tanks WHERE name = 'Main Diesel Tank'`);
        const { rows: pump } = await client.query(
          `INSERT INTO pumps (name, tank_id, serial)
           SELECT 'Pump 1', $1, 'SN-DEMO-001'
           WHERE NOT EXISTS (SELECT 1 FROM pumps WHERE name = 'Pump 1')
           RETURNING id`, [tankRow[0].id]);
        if (pump.length) console.log('[seed] example pump created (Pump 1)');
      }
      await client.query(
        `INSERT INTO vehicles (plate, make, model, vehicle_type, driver_name, tank_capacity)
         SELECT 'KDA 001X', 'Isuzu', 'NPR', 'truck', 'Demo Driver', 100
         WHERE NOT EXISTS (SELECT 1 FROM vehicles WHERE plate = 'KDA 001X')`);
      console.log('[seed] example vehicle ensured (KDA 001X)');
    }

    await client.query('COMMIT');
    console.log('[seed] done — no existing data was modified');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[seed] FAILED:', err.message);
  process.exit(1);
});
