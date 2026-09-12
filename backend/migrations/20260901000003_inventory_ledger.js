// ============================================================================
// 003 — THE FUEL LEDGER (inventory_transactions) and bulk receipts/purchases.
//
// inventory_transactions is the append-only, permanent operational ledger:
//   opening | receipt | issue | adjustment | reversal
// The running balance is stamped into every row (balance_after) and the
// entire ledger is reconstructible from this table at any time. Rows are
// never updated or deleted by application code.
// ============================================================================

export const up = (pgm) => {
  pgm.createTable('purchases', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    receipt_no: { type: 'text', notNull: true, unique: true },
    supplier: { type: 'text', notNull: true },
    invoice_no: { type: 'text' },
    fuel_type_id: { type: 'uuid', notNull: true, references: 'fuel_types', onDelete: 'RESTRICT' },
    tank_id: { type: 'uuid', notNull: true, references: 'tanks', onDelete: 'RESTRICT' },
    quantity: { type: 'numeric(12,2)', notNull: true, check: 'quantity > 0' },
    unit_price: { type: 'numeric(12,2)', check: 'unit_price >= 0' },
    delivery_note: { type: 'text' },
    received_by: { type: 'uuid', references: 'users', onDelete: 'RESTRICT' },
    client_uuid: { type: 'uuid', unique: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('purchases', 'created_at');

  pgm.createTable('inventory_transactions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    entry_type: { type: 'text', notNull: true,
      check: "entry_type IN ('opening','receipt','issue','adjustment','reversal')" },
    fuel_type_id: { type: 'uuid', notNull: true, references: 'fuel_types', onDelete: 'RESTRICT' },
    tank_id: { type: 'uuid', notNull: true, references: 'tanks', onDelete: 'RESTRICT' },
    quantity: { type: 'numeric(14,3)', notNull: true }, // signed: issues negative
    balance_after: { type: 'numeric(14,3)', notNull: true },
    ref_table: { type: 'text' },
    ref_id: { type: 'uuid' },
    description: { type: 'text' },
    performed_by: { type: 'uuid', references: 'users', onDelete: 'RESTRICT' },
    client_uuid: { type: 'uuid', unique: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('inventory_transactions', ['fuel_type_id', 'created_at']);
  pgm.createIndex('inventory_transactions', ['tank_id', 'created_at']);
  pgm.createIndex('inventory_transactions', ['ref_table', 'ref_id']);
};

export const down = (pgm) => {
  pgm.dropTable('inventory_transactions');
  pgm.dropTable('purchases');
};
