// 012 — LPO (Local Purchase Order) reference on fuel transactions (§51).
// Common in Kenya for institutional fuel drawdowns: every issue / direct
// entry can carry the customer's LPO number. Additive only (§43).
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE fuel_transactions ADD COLUMN IF NOT EXISTS lpo_no text;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE fuel_transactions DROP COLUMN IF EXISTS lpo_no;
  `);
};
