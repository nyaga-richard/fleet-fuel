// ============================================================================
// 009 — Fleet management expansion (§38): vehicle register enrichment +
// odometer history, external fuel (vehicle-sourced, NEVER touches station
// stock), tire lifecycle, trips with optional revenue. Additive only —
// every existing flow keeps working; history rows default correctly.
// ============================================================================
export const up = (pgm) => {
  // ── Vehicles: full register (§8). `active` stays authoritative for fuel
  // workflows and is kept in sync: status ACTIVE ⇔ active = true.
  pgm.sql(`ALTER TABLE vehicles
    ADD COLUMN IF NOT EXISTS year int,
    ADD COLUMN IF NOT EXISTS vin text,
    ADD COLUMN IF NOT EXISTS engine_no text,
    ADD COLUMN IF NOT EXISTS expected_km_l numeric(6,2),
    ADD COLUMN IF NOT EXISTS current_odometer numeric(12,1) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS department text,
    ADD COLUMN IF NOT EXISTS branch text,
    ADD COLUMN IF NOT EXISTS station text,
    ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ACTIVE'
      CHECK (status IN ('ACTIVE','INACTIVE','MAINTENANCE','ACCIDENT','RETIRED','SOLD','DISPOSED')),
    ADD COLUMN IF NOT EXISTS axle_config text NOT NULL DEFAULT '4x2'
      CHECK (axle_config IN ('4x2','4x4','6x2','6x4','8x4')),
    ADD COLUMN IF NOT EXISTS acquisition_date date,
    ADD COLUMN IF NOT EXISTS acquisition_cost numeric(14,2),
    ADD COLUMN IF NOT EXISTS ownership_type text,
    ADD COLUMN IF NOT EXISTS supplier text`);
  pgm.sql(`UPDATE vehicles SET status = CASE WHEN active THEN 'ACTIVE' ELSE 'INACTIVE' END WHERE status = 'ACTIVE' AND active = false`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS vehicles_status_idx ON vehicles (status)`);

  // ── Odometer history (§8/§43): one authoritative mileage trail per vehicle.
  pgm.createTable('vehicle_odometer_history', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    vehicle_id: { type: 'uuid', notNull: true, references: 'vehicles', onDelete: 'CASCADE' },
    odometer: { type: 'numeric(12,1)', notNull: true },
    source: { type: 'text', notNull: true },      // fuel_transaction | external_fuel | trip | manual
    ref_table: { type: 'text' },
    ref_id: { type: 'uuid' },
    dedupe_key: { type: 'text', notNull: true, unique: true }, // idempotent per event
    entered_by: { type: 'uuid', references: 'users', onDelete: 'RESTRICT' },
    recorded_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('vehicle_odometer_history', ['vehicle_id', 'recorded_at']);

  // ── External fuel (§2–§5): complete vehicle fuel history WITHOUT touching
  // station stock, pumps or tank reconciliation. Separate table BY DESIGN.
  pgm.createTable('external_fuel_entries', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    vehicle_id: { type: 'uuid', notNull: true, references: 'vehicles', onDelete: 'RESTRICT' },
    fuel_type_id: { type: 'uuid', notNull: true, references: 'fuel_types', onDelete: 'RESTRICT' },
    supplier: { type: 'text', notNull: true },
    transaction_date: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    odometer: { type: 'numeric(12,1)' },
    quantity: { type: 'numeric(12,2)', notNull: true, check: 'quantity > 0' },
    unit_price: { type: 'numeric(12,2)', check: 'unit_price >= 0' },
    total_amount: { type: 'numeric(14,2)' },
    receipt_no: { type: 'text' },
    payment_method: { type: 'text', check: "payment_method IN ('CASH','CARD','ACCOUNT','OTHER')" },
    notes: { type: 'text' },
    entered_by: { type: 'uuid', references: 'users', onDelete: 'RESTRICT' },
    client_uuid: { type: 'uuid', unique: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('external_fuel_entries', ['vehicle_id', 'transaction_date']);

  // ── Tires (§10–§11): unique serial = the physical asset identity.
  pgm.createTable('tires', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    serial_no: { type: 'text', notNull: true, unique: true },
    brand: { type: 'text' },
    pattern: { type: 'text' },
    size: { type: 'text' },
    tire_type: { type: 'text' },                 // radial / bias…
    ply_rating: { type: 'text' },
    supply_condition: { type: 'text', check: "supply_condition IN ('NEW','RETREAD')" },
    purchase_date: { type: 'date' },
    purchase_cost: { type: 'numeric(12,2)' },
    supplier: { type: 'text' },
    status: { type: 'text', notNull: true, default: 'IN_STORE',
      check: "status IN ('IN_STORE','ON_VEHICLE','USED_STORE','AWAITING_RETREAD','AT_RETREAD_SUPPLIER','DISPOSED')" },
    current_vehicle_id: { type: 'uuid', references: 'vehicles', onDelete: 'SET NULL' },
    current_position: { type: 'text' },
    installed_at: { type: 'timestamptz' },
    installed_odometer: { type: 'numeric(12,1)' },
    mileage_accumulated: { type: 'numeric(12,1)', notNull: true, default: 0 },
    retread_count: { type: 'int', notNull: true, default: 0 },
    tread_depth_mm: { type: 'numeric(5,1)' },
    notes: { type: 'text' },
    client_uuid: { type: 'uuid', unique: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // ── Tire movements = the lifecycle ledger (§16): append-only, never rewritten.
  pgm.createTable('tire_movements', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tire_id: { type: 'uuid', notNull: true, references: 'tires', onDelete: 'CASCADE' },
    vehicle_id: { type: 'uuid', references: 'vehicles', onDelete: 'SET NULL' },
    action: { type: 'text', notNull: true,
      check: "action IN ('FIT','REMOVE','ROTATE','RETREAD_OUT','RETREAD_IN','DISPOSE')" },
    position: { type: 'text' },
    odometer: { type: 'numeric(12,1)' },
    tread_depth_mm: { type: 'numeric(5,1)' },
    reason: { type: 'text' },
    performed_by: { type: 'uuid', references: 'users', onDelete: 'RESTRICT' },
    client_uuid: { type: 'uuid', unique: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('tire_movements', ['tire_id', 'created_at']);
  pgm.createIndex('tire_movements', ['vehicle_id']);

  // ── Trips (§20–§27): revenue OPTIONAL and embedded (one revenue per trip).
  pgm.sql(`CREATE SEQUENCE IF NOT EXISTS trip_no_seq`);
  pgm.createTable('trips', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    trip_no: { type: 'text', notNull: true, unique: true },
    vehicle_id: { type: 'uuid', notNull: true, references: 'vehicles', onDelete: 'RESTRICT' },
    driver_name: { type: 'text' },
    trip_date: { type: 'date' },
    start_location: { type: 'text' },
    destination: { type: 'text' },
    purpose: { type: 'text' },
    department: { type: 'text' },
    start_time: { type: 'timestamptz' },
    end_time: { type: 'timestamptz' },
    start_odometer: { type: 'numeric(12,1)' },
    end_odometer: { type: 'numeric(12,1)' },
    distance: { type: 'numeric(12,1)' },
    status: { type: 'text', notNull: true, default: 'PLANNED',
      check: "status IN ('PLANNED','AUTHORIZED','IN_PROGRESS','COMPLETED','CANCELLED')" },
    revenue_amount: { type: 'numeric(14,2)', check: 'revenue_amount >= 0' },
    revenue_currency: { type: 'text' },
    revenue_customer: { type: 'text' },
    revenue_invoice_ref: { type: 'text' },
    revenue_type: { type: 'text' },
    revenue_payment_status: { type: 'text', check: "revenue_payment_status IN ('UNPAID','PARTPAID','PAID')" },
    load_info: { type: 'text' },
    notes: { type: 'text' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'RESTRICT' },
    client_uuid: { type: 'uuid', unique: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('trips', ['vehicle_id', 'trip_date']);
  pgm.createIndex('trips', ['status']);
};
export const down = (pgm) => {
  pgm.dropTable('trips');
  pgm.sql('DROP SEQUENCE IF EXISTS trip_no_seq');
  pgm.dropTable('tire_movements');
  pgm.dropTable('tires');
  pgm.dropTable('external_fuel_entries');
  pgm.dropTable('vehicle_odometer_history');
  pgm.sql(`ALTER TABLE vehicles
    DROP COLUMN IF EXISTS year, DROP COLUMN IF EXISTS vin, DROP COLUMN IF EXISTS engine_no,
    DROP COLUMN IF EXISTS expected_km_l, DROP COLUMN IF EXISTS current_odometer,
    DROP COLUMN IF EXISTS department, DROP COLUMN IF EXISTS branch, DROP COLUMN IF EXISTS station,
    DROP COLUMN IF EXISTS status, DROP COLUMN IF EXISTS axle_config,
    DROP COLUMN IF EXISTS acquisition_date, DROP COLUMN IF EXISTS acquisition_cost,
    DROP COLUMN IF EXISTS ownership_type, DROP COLUMN IF EXISTS supplier`);
};
