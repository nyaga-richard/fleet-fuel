// ============================================================================
// On-device SQLite — the LOCAL OPERATIONAL STORE for offline workflows.
//
// This database is completely independent from the server's PostgreSQL.
// PostgreSQL remains the central authority (authorizations, users, roles,
// inventory, fuel ledger, final transactions). SQLite only caches reference
// data and queues operations created while offline, which are replayed to
// the server exactly once (idempotent via op_id / client_uuid).
//
// Local data survives: temporary Internet loss, app restart, device restart.
//
// Hermes/RN note: there is NO `crypto` global in React Native — never
// reference it. uuid4() below generates valid UUID v4 format (required by
// the server's uuid columns) with zero dependencies.
// ============================================================================
import * as SQLite from 'expo-sqlite';
import Constants from 'expo-constants';

export const db = SQLite.openDatabaseSync('fleetfuel.db');

// ── IDs ──────────────────────────────────────────────────────────────────────
function uuid4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export async function initDb() {
  await db.execAsync(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS kv (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    -- Offline operation queue (outbox pattern)
    CREATE TABLE IF NOT EXISTS outbox (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      op_id       TEXT UNIQUE NOT NULL,
      type        TEXT NOT NULL,
      payload     TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error  TEXT
    );

    -- Cached authoritative reference data (refreshed by sync pull)
    CREATE TABLE IF NOT EXISTS vehicles (
      id TEXT PRIMARY KEY, plate TEXT, make TEXT, model TEXT,
      vehicle_type TEXT, driver_name TEXT, active INTEGER, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS fuel_types (
      id TEXT PRIMARY KEY, name TEXT, code TEXT, unit TEXT, active INTEGER, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS tanks (
      id TEXT PRIMARY KEY, name TEXT, fuel_type_id TEXT, capacity REAL, active INTEGER, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS pumps (
      id TEXT PRIMARY KEY, name TEXT, tank_id TEXT, active INTEGER, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY, request_no TEXT, vehicle_id TEXT, plate TEXT,
      fuel_type_id TEXT, quantity REAL, status TEXT, driver_name TEXT,
      created_at TEXT, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY, txn_no TEXT, request_id TEXT, vehicle_id TEXT, plate TEXT,
      fuel_type_id TEXT, quantity REAL, status TEXT, created_at TEXT, updated_at TEXT
    );
  `);
}

// ── Key-value helpers (token, user, sync timestamps, device id) ─────────────
export async function kvGet(key) {
  const row = await db.getFirstAsync('SELECT value FROM kv WHERE key = ?', [key]);
  return row?.value ?? null;
}

export async function kvSet(key, value) {
  await db.runAsync('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, String(value)]);
}

export async function deviceId() {
  let id = await kvGet('device_id');
  if (!id) {
    const label = Constants?.deviceName || 'device';
    id = `${label}-${uuid4().slice(0, 8)}`;
    await kvSet('device_id', id);
  }
  return id;
}

// ── Outbox (pending ops) ─────────────────────────────────────────────────────
export async function enqueue(type, payload) {
  const opId = uuid4();
  await db.runAsync(
    'INSERT INTO outbox (op_id, type, payload, created_at) VALUES (?, ?, ?, ?)',
    [opId, type, JSON.stringify(payload), new Date().toISOString()],
  );
  return opId;
}

export async function pendingOps(limit = 100) {
  return db.getAllAsync(
    'SELECT * FROM outbox WHERE retry_count < 8 ORDER BY created_at ASC LIMIT ?', [limit],
  );
}

export async function outboxCount() {
  const row = await db.getFirstAsync('SELECT count(*) AS n FROM outbox');
  return row?.n ?? 0;
}

export async function removeOp(opId) {
  await db.runAsync('DELETE FROM outbox WHERE op_id = ?', [opId]);
}

export async function failOp(opId, error) {
  await db.runAsync(
    'UPDATE outbox SET retry_count = retry_count + 1, last_error = ? WHERE op_id = ?',
    [String(error).slice(0, 300), opId],
  );
}

export async function wipeLocalData() {
  await db.execAsync(
    `DELETE FROM outbox; DELETE FROM vehicles; DELETE FROM fuel_types;
     DELETE FROM tanks; DELETE FROM pumps; DELETE FROM requests; DELETE FROM transactions;
     DELETE FROM kv WHERE key != 'device_id';`,
  );
}

// ── Cached reference/operational reads (instant, offline) ────────────────────
export async function cachedVehicles() {
  return db.getAllAsync('SELECT * FROM vehicles WHERE active = 1 ORDER BY plate');
}
export async function cachedFuelTypes() {
  return db.getAllAsync('SELECT * FROM fuel_types WHERE active = 1 ORDER BY name');
}
export async function cachedTanks() {
  return db.getAllAsync('SELECT * FROM tanks WHERE active = 1 ORDER BY name');
}
export async function cachedPumps() {
  return db.getAllAsync(
    'SELECT p.*, t.name AS tank_name FROM pumps p LEFT JOIN tanks t ON t.id = p.tank_id WHERE p.active = 1 ORDER BY p.name');
}
export async function cachedRequests(limit = 100) {
  return db.getAllAsync(
    'SELECT * FROM requests ORDER BY created_at DESC LIMIT ?', [limit]);
}
export async function cachedTransactions(limit = 100) {
  return db.getAllAsync(
    'SELECT * FROM transactions ORDER BY created_at DESC LIMIT ?', [limit]);
}

export async function replaceReferenceData(pull) {
  const now = new Date().toISOString();
  await db.execAsync('BEGIN TRANSACTION');
  try {
    for (const v of pull.reference.vehicles) {
      await db.runAsync(
        `INSERT INTO vehicles (id, plate, make, model, vehicle_type, driver_name, active, updated_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET plate=excluded.plate, make=excluded.make, model=excluded.model,
           vehicle_type=excluded.vehicle_type, driver_name=excluded.driver_name, active=excluded.active,
           updated_at=excluded.updated_at`,
        [v.id, v.plate, v.make, v.model, v.vehicle_type, v.driver_name, v.active ? 1 : 0, now]);
    }
    for (const f of pull.reference.fuel_types) {
      await db.runAsync(
        `INSERT INTO fuel_types (id, name, code, unit, active, updated_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, code=excluded.code, unit=excluded.unit,
           active=excluded.active, updated_at=excluded.updated_at`,
        [f.id, f.name, f.code, f.unit, f.active ? 1 : 0, now]);
    }
    for (const t of pull.reference.tanks) {
      await db.runAsync(
        `INSERT INTO tanks (id, name, fuel_type_id, capacity, active, updated_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, fuel_type_id=excluded.fuel_type_id,
           capacity=excluded.capacity, active=excluded.active, updated_at=excluded.updated_at`,
        [t.id, t.name, t.fuel_type_id, t.capacity, t.active ? 1 : 0, now]);
    }
    for (const p of pull.reference.pumps) {
      await db.runAsync(
        `INSERT INTO pumps (id, name, tank_id, active, updated_at) VALUES (?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, tank_id=excluded.tank_id,
           active=excluded.active, updated_at=excluded.updated_at`,
        [p.id, p.name, p.tank_id, p.active ? 1 : 0, now]);
    }
    for (const r of pull.requests || []) {
      await db.runAsync(
        `INSERT INTO requests (id, request_no, vehicle_id, plate, fuel_type_id, quantity, status, driver_name, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET request_no=excluded.request_no, status=excluded.status, updated_at=excluded.updated_at`,
        [r.id, r.request_no, r.vehicle_id, r.plate, r.fuel_type_id, r.quantity, r.status, r.driver_name, r.created_at, r.updated_at]);
    }
    for (const t of pull.transactions || []) {
      await db.runAsync(
        `INSERT INTO transactions (id, txn_no, request_id, vehicle_id, plate, fuel_type_id, quantity, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at`,
        [t.id, t.txn_no, t.request_id, t.vehicle_id, t.plate, t.fuel_type_id, t.quantity, t.status, t.created_at, t.updated_at]);
    }
    await db.execAsync('COMMIT');
  } catch (err) {
    await db.execAsync('ROLLBACK');
    throw err;
  }
}
