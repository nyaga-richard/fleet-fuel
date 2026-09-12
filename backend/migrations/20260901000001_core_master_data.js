// ============================================================================
// 001 — Core master data: users, vehicles, fuel_types, tanks, pumps.
// Additive, non-destructive. Runs inside its own transaction.
// ============================================================================

const UPDATED_AT_FN = `BEGIN NEW.updated_at := now(); RETURN NEW; END;`;

function touchTrigger(pgm, table) {
  pgm.createTrigger(table, `${table}_set_updated_at`, {
    when: 'BEFORE',
    operation: 'UPDATE',
    function: 'set_updated_at',
    level: 'ROW',
  });
}

export const up = (pgm) => {
  pgm.createFunction('set_updated_at', [], { returns: 'trigger', language: 'plpgsql', replace: true }, UPDATED_AT_FN);

  pgm.createTable('users', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true },
    email: { type: 'text', notNull: true, unique: true },
    password_hash: { type: 'text', notNull: true },
    role: { type: 'text', notNull: true, default: 'attendant',
      check: "role IN ('admin','manager','attendant')" },
    phone: { type: 'text' },
    active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('fuel_types', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true, unique: true },
    code: { type: 'text', notNull: true, unique: true },
    unit: { type: 'text', notNull: true, default: 'L' },
    active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('vehicles', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    plate: { type: 'text', notNull: true, unique: true },
    make: { type: 'text' },
    model: { type: 'text' },
    vehicle_type: { type: 'text' },
    driver_name: { type: 'text' },
    tank_capacity: { type: 'numeric(10,2)', check: 'tank_capacity > 0' },
    notes: { type: 'text' },
    active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('vehicles', 'driver_name');

  pgm.createTable('tanks', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true, unique: true },
    fuel_type_id: { type: 'uuid', notNull: true, references: 'fuel_types', onDelete: 'RESTRICT' },
    capacity: { type: 'numeric(12,2)', notNull: true, check: 'capacity > 0' },
    location: { type: 'text' },
    active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('pumps', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true, unique: true },
    tank_id: { type: 'uuid', notNull: true, references: 'tanks', onDelete: 'RESTRICT' },
    serial: { type: 'text' },
    active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  for (const t of ['users', 'fuel_types', 'vehicles', 'tanks', 'pumps']) touchTrigger(pgm, t);
};

export const down = (pgm) => {
  pgm.dropTable('pumps');
  pgm.dropTable('tanks');
  pgm.dropTable('vehicles');
  pgm.dropTable('fuel_types');
  pgm.dropTable('users');
  pgm.dropFunction('set_updated_at', []);
};
