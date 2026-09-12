// ============================================================================
// 002 — Operations: fuel requests, authorizations, fuel transactions,
//       pump readings, tank readings + document number sequences.
// Uses ON DELETE RESTRICT everywhere: operational history is permanent.
// ============================================================================

export const up = (pgm) => {
  pgm.createSequence('request_no_seq', { start: 1001 });
  pgm.createSequence('txn_no_seq', { start: 1001 });
  pgm.createSequence('receipt_no_seq', { start: 1001 });

  pgm.createTable('fuel_requests', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    request_no: { type: 'text', notNull: true, unique: true },
    vehicle_id: { type: 'uuid', notNull: true, references: 'vehicles', onDelete: 'RESTRICT' },
    fuel_type_id: { type: 'uuid', notNull: true, references: 'fuel_types', onDelete: 'RESTRICT' },
    quantity: { type: 'numeric(12,2)', notNull: true, check: 'quantity > 0' },
    driver_name: { type: 'text' },
    odometer: { type: 'numeric(12,1)', check: 'odometer >= 0' },
    destination: { type: 'text' },
    notes: { type: 'text' },
    status: { type: 'text', notNull: true, default: 'pending',
      check: "status IN ('pending','approved','rejected','issued','cancelled')" },
    requested_by: { type: 'uuid', notNull: true, references: 'users', onDelete: 'RESTRICT' },
    // Offline-sync idempotency key from mobile devices (nullable).
    client_uuid: { type: 'uuid', unique: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('fuel_requests', 'status');
  pgm.createIndex('fuel_requests', 'created_at');

  pgm.createTable('authorizations', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    request_id: { type: 'uuid', notNull: true, references: 'fuel_requests', onDelete: 'RESTRICT' },
    decision: { type: 'text', notNull: true, check: "decision IN ('approved','rejected')" },
    decided_by: { type: 'uuid', notNull: true, references: 'users', onDelete: 'RESTRICT' },
    comments: { type: 'text' },
    decided_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('authorizations', 'request_id');

  pgm.createTable('fuel_transactions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    txn_no: { type: 'text', notNull: true, unique: true },
    request_id: { type: 'uuid', references: 'fuel_requests', onDelete: 'RESTRICT' },
    authorization_id: { type: 'uuid', references: 'authorizations', onDelete: 'RESTRICT' },
    vehicle_id: { type: 'uuid', notNull: true, references: 'vehicles', onDelete: 'RESTRICT' },
    fuel_type_id: { type: 'uuid', notNull: true, references: 'fuel_types', onDelete: 'RESTRICT' },
    tank_id: { type: 'uuid', references: 'tanks', onDelete: 'RESTRICT' },
    pump_id: { type: 'uuid', references: 'pumps', onDelete: 'RESTRICT' },
    quantity: { type: 'numeric(12,2)', notNull: true, check: 'quantity > 0' },
    unit_price: { type: 'numeric(12,2)', check: 'unit_price >= 0' },
    operator_id: { type: 'uuid', references: 'users', onDelete: 'RESTRICT' },
    odometer: { type: 'numeric(12,1)', check: 'odometer >= 0' },
    status: { type: 'text', notNull: true, default: 'completed',
      check: "status IN ('completed','reversed')" },
    reversal_of: { type: 'uuid', references: 'fuel_transactions', onDelete: 'RESTRICT' },
    client_uuid: { type: 'uuid', unique: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('fuel_transactions', 'vehicle_id');
  pgm.createIndex('fuel_transactions', 'created_at');
  pgm.createIndex('fuel_transactions', 'request_id');

  pgm.createTable('pump_readings', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    pump_id: { type: 'uuid', notNull: true, references: 'pumps', onDelete: 'RESTRICT' },
    reading: { type: 'numeric(14,2)', notNull: true, check: 'reading >= 0' },
    fuel_transaction_id: { type: 'uuid', references: 'fuel_transactions', onDelete: 'RESTRICT' },
    recorded_by: { type: 'uuid', references: 'users', onDelete: 'RESTRICT' },
    client_uuid: { type: 'uuid', unique: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('pump_readings', 'pump_id');
  pgm.createIndex('pump_readings', 'created_at');

  pgm.createTable('tank_readings', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tank_id: { type: 'uuid', notNull: true, references: 'tanks', onDelete: 'RESTRICT' },
    dip: { type: 'numeric(12,2)', check: 'dip >= 0' },
    quantity_estimate: { type: 'numeric(12,2)', check: 'quantity_estimate >= 0' },
    recorded_by: { type: 'uuid', references: 'users', onDelete: 'RESTRICT' },
    client_uuid: { type: 'uuid', unique: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('tank_readings', 'tank_id');
  pgm.createIndex('tank_readings', 'created_at');
};

export const down = (pgm) => {
  pgm.dropTable('tank_readings');
  pgm.dropTable('pump_readings');
  pgm.dropTable('fuel_transactions');
  pgm.dropTable('authorizations');
  pgm.dropTable('fuel_requests');
  pgm.dropSequence('request_no_seq');
  pgm.dropSequence('txn_no_seq');
  pgm.dropSequence('receipt_no_seq');
};
