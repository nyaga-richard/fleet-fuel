-- Demo data — coherent Fuel Ledger history for the sandbox.
-- Run after `npm run migrate` + SEED_DEMO_DATA + the 90-day demo series.
-- Idempotent: guarded by NOT EXISTS / date guards, safe to re-run.
--
-- Why: the demo series inserts fuel_transactions spread over ~90 days, but
-- ledger (inventory_transactions) rows must carry the BUSINESS date of each
-- movement (same rule the app applies to dated direct entries since
-- postLedgerEntry gained `at`). This script:
--   1. dates the initial fill / mid-series receipts so reconstruction never dips
--      negative,
--   2. backfills one dated 'issue' ledger row per demo direct-entry transaction,
--   3. replays balance_after in deterministic date order (created_at, id).

-- 1) Spread the demo receipts across the window (only if still stamped today).
UPDATE inventory_transactions
   SET created_at = '2026-06-20T08:00:00+03'
 WHERE entry_type = 'receipt' AND ref_table = 'purchases'
   AND description LIKE 'Receipt RCP-2026-001001%'   -- initial 20,000 L fill
   AND created_at::date = CURRENT_DATE;

UPDATE inventory_transactions
   SET created_at = '2026-07-28T10:00:00+03'
 WHERE entry_type = 'receipt' AND ref_table = 'purchases'
   AND description LIKE 'Receipt RCP-2026-001002%'   -- 5,000 L mid-series
   AND created_at::date = CURRENT_DATE;

UPDATE inventory_transactions
   SET created_at = '2026-08-25T10:00:00+03'
 WHERE entry_type = 'receipt' AND ref_table = 'purchases'
   AND description LIKE 'Receipt RCP-2026-001003%'   -- 1,000 L mid-series
   AND created_at::date = CURRENT_DATE;

-- 2) One dated ledger issue per demo DIRECT_ENTRY transaction lacking one.
INSERT INTO inventory_transactions
  (entry_type, fuel_type_id, tank_id, quantity, balance_after,
   ref_table, ref_id, description, performed_by, client_uuid, created_at)
SELECT 'issue', t.fuel_type_id, t.tank_id, -t.quantity, 0,
       'fuel_transactions', t.id,
       'Direct entry ' || t.quantity || ' L — ' || v.plate,
       t.operator_id, md5(random()::text)::uuid, t.created_at
  FROM fuel_transactions t
  JOIN vehicles v ON v.id = t.vehicle_id
 WHERE t.txn_no LIKE 'TXN-DEMO%'
   AND NOT EXISTS (SELECT 1 FROM inventory_transactions it
                    WHERE it.ref_table = 'fuel_transactions' AND it.ref_id = t.id);

-- 3) Replay running balances in ledger date order.
UPDATE inventory_transactions it
   SET balance_after = replay.bal
  FROM (
    SELECT id,
           SUM(quantity) OVER (PARTITION BY fuel_type_id
                               ORDER BY created_at, id
                               ROWS UNBOUNDED PRECEDING) AS bal
      FROM inventory_transactions
  ) replay
 WHERE it.id = replay.id;
