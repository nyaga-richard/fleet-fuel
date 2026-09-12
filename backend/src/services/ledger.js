// ============================================================================
// FUEL LEDGER ENGINE — the authoritative, append-only inventory ledger.
//
// Every movement of fuel (opening balance, bulk receipt, issue, adjustment,
// reversal) is an immutable row in `inventory_transactions` with the running
// balance stamped at write time. Rows are NEVER updated or deleted.
//
// The fuel ledger is therefore always reconstructible from persistent
// PostgreSQL data — across app updates, container rebuilds, and reboots.
//
// Balance correctness: per-fuel-type PostgreSQL advisory transaction locks
// serialize concurrent writes, so `balance_after` is always exact.
// ============================================================================
import { ApiError } from '../middleware/errors.js';
import { pool } from '../db/pool.js';

export const ENTRY_TYPES = ['opening', 'receipt', 'issue', 'adjustment', 'reversal'];

/**
 * Post one immutable ledger entry. MUST be called inside an open transaction
 * (client = transaction-scoped pg client).
 *
 * @param {import('pg').PoolClient} client
 * @param {object} entry {entry_type, fuel_type_id, tank_id, quantity (signed),
 *                 ref_table, ref_id, description, performed_by, client_uuid}
 */
export async function postLedgerEntry(client, entry) {
  if (!ENTRY_TYPES.includes(entry.entry_type)) {
    throw new ApiError(400, `Unknown ledger entry type: ${entry.entry_type}`);
  }
  const qty = Number(entry.quantity);
  if (!Number.isFinite(qty) || qty === 0) {
    throw new ApiError(400, 'Ledger quantity must be a non-zero number');
  }
  // Serialize balance updates per fuel type.
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`fleetfuel:ledger:${entry.fuel_type_id}`]);

  const { rows } = await client.query(
    `INSERT INTO inventory_transactions
       (entry_type, fuel_type_id, tank_id, quantity, balance_after,
        ref_table, ref_id, description, performed_by, client_uuid)
     VALUES ($1, $2, $3, $4,
             (SELECT COALESCE(SUM(quantity), 0) FROM inventory_transactions WHERE fuel_type_id = $2) + $4,
             $5, $6, $7, $8, $9)
     RETURNING id, entry_type, fuel_type_id, tank_id, quantity, balance_after,
               ref_table, ref_id, description, created_at`,
    [
      entry.entry_type,
      entry.fuel_type_id,
      entry.tank_id ?? null,
      qty,
      entry.ref_table ?? null,
      entry.ref_id ?? null,
      entry.description ?? null,
      entry.performed_by ?? null,
      entry.client_uuid ?? null,
    ],
  );
  return rows[0];
}

/** Look up an existing row by client-supplied UUID (offline idempotency). */
export async function findByClientUuid(client, table, clientUuid) {
  if (!clientUuid) return null;
  const { rows } = await client.query(
    `SELECT * FROM ${table} WHERE client_uuid = $1 LIMIT 1`,
    [clientUuid],
  );
  return rows[0] ?? null;
}

/** Current stock (litres) per fuel type. */
export async function stockByFuelType(client = null) {
  const q = `SELECT ft.id, ft.name, ft.code, ft.unit,
                    COALESCE(SUM(it.quantity), 0)::float AS balance
               FROM fuel_types ft
               LEFT JOIN inventory_transactions it ON it.fuel_type_id = ft.id
              WHERE ft.active
              GROUP BY ft.id, ft.name, ft.code, ft.unit
              ORDER BY ft.name`;
  const exec = client ? (sql) => client.query(sql) : (sql) => pool.query(sql);
  return (await exec(q)).rows;
}

/** Current stock per tank with capacity utilisation. */
export async function stockByTank(client = null) {
  const q = `SELECT t.id, t.name AS tank, t.capacity::float, ft.name AS fuel_type, ft.code,
                    COALESCE(SUM(it.quantity), 0)::float AS balance,
                    ROUND((COALESCE(SUM(it.quantity), 0) / NULLIF(t.capacity, 0) * 100)::numeric, 1)::float AS pct_full
               FROM tanks t
               JOIN fuel_types ft ON ft.id = t.fuel_type_id
               LEFT JOIN inventory_transactions it ON it.tank_id = t.id
              WHERE t.active
              GROUP BY t.id, t.name, t.capacity, ft.name, ft.code
              ORDER BY t.name`;
  const exec = client ? (sql) => client.query(sql) : (sql) => pool.query(sql);
  return (await exec(q)).rows;
}

/**
 * Ledger movement summary for a period (reconstructible totals).
 * Opening = balance before `from`; Closing = current balance.
 */
export async function ledgerSummary(fuelTypeId, from, to) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(quantity) FILTER (WHERE created_at < $2), 0)::float AS opening,
       COALESCE(SUM(quantity) FILTER (WHERE entry_type = 'receipt'  AND created_at >= $2 AND created_at < $3), 0)::float AS receipts,
       COALESCE(SUM(quantity) FILTER (WHERE entry_type = 'issue'    AND created_at >= $2 AND created_at < $3), 0)::float AS issues,
       COALESCE(SUM(quantity) FILTER (WHERE entry_type = 'adjustment' AND created_at >= $2 AND created_at < $3), 0)::float AS adjustments,
       COALESCE(SUM(quantity) FILTER (WHERE entry_type = 'reversal' AND created_at >= $2 AND created_at < $3), 0)::float AS reversals,
       COALESCE(SUM(quantity), 0)::float AS closing
       FROM inventory_transactions
      WHERE fuel_type_id = $1`,
    [fuelTypeId, from, to],
  );
  return rows[0];
}
