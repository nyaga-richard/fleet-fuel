// 013 — Data repair: ledger rows follow their source document's business date.
//
// Before the ledger gained a business timestamp (postLedgerEntry `at`), ledger
// rows were stamped with the posting instant even when the operator chose a
// different date on the form (direct fuel entries, supplier invoice dates).
// Existing rows are repaired here so history reads consistently:
//
//   1. 'issue' ledger rows take the date of the fuel transaction they record
//      (workflow issues already agree; direct entries align exactly).
//      Reversal rows keep their own posting time — a reversal happens when it
//      happens, even if it corrects an older transaction (append-only §16/§32).
//   2. Invoice receipt rows take the invoice's date (midday guard keeps the
//      calendar date stable across timezones).
//   3. Running balances (balance_after) are replayed in the new date order so
//      the Fuel Ledger stays internally consistent.
//
// Deliberately NOT touched: purchases price rows (internal cost-price truth,
// ordering only), odometer/pump-reading trail, and rows whose source document
// itself predates chosen-date capture — for those the posting date IS the only
// date on record, so there is nothing to recover. Idempotent by construction.
export const up = (pgm) => {
  // 1) Ledger issue rows follow their fuel transaction.
  pgm.sql(`
    UPDATE inventory_transactions it
       SET created_at = t.created_at
      FROM fuel_transactions t
     WHERE it.ref_table = 'fuel_transactions'
       AND it.ref_id = t.id
       AND it.entry_type = 'issue'
       AND it.created_at <> t.created_at;
  `);

  // 2) Invoice receipt rows follow the invoice date.
  pgm.sql(`
    UPDATE inventory_transactions it
       SET created_at = (si.invoice_date + time '12:00')
      FROM supplier_invoices si
     WHERE it.ref_table = 'supplier_invoices'
       AND it.ref_id = si.id
       AND it.entry_type = 'receipt'
       AND si.invoice_date IS NOT NULL
       AND it.created_at::date <> si.invoice_date::date;
  `);

  // 3) Replay running balances in deterministic date order (§19).
  pgm.sql(`
    UPDATE inventory_transactions it
       SET balance_after = replay.bal
      FROM (
        SELECT id,
               SUM(quantity) OVER (PARTITION BY fuel_type_id
                                   ORDER BY created_at, id
                                   ROWS UNBOUNDED PRECEDING) AS bal
          FROM inventory_transactions
      ) replay
     WHERE it.id = replay.id
       AND it.balance_after <> replay.bal;
  `);
};

export const down = () => {
  // Data alignment — nothing to revert (dates move forward to their sources).
};
