// ============================================================================
// 005 — Reporting, Approvals & Notifications foundation.
//
//   approvals + approval_events : formal, immutable approval workflow records
//   notifications               : per-user persistent notification center
//   push_devices                : mobile push token registry (§40)
//   settings seeds              : org identity + currency for report headers
//                                 (values come from configuration, never code)
//
// Forward-compatible only: additive tables/rows, nothing existing is altered.
// ============================================================================

export const up = (pgm) => {
  // ── Approvals (§22) — one row per formal decision; events keep history ──
  pgm.createTable('approvals', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    entity_type: { type: 'text', notNull: true },   // fuel_request | inventory_adjustment | fuel_receipt | pump_variance | tank_variance | fuel_excess
    entity_id: { type: 'uuid', notNull: true },
    approval_type: { type: 'text', notNull: true }, // e.g. fuel_requests:approve
    status: { type: 'text', notNull: true, default: 'PENDING',
      check: "status IN ('PENDING','APPROVED','REJECTED','CANCELLED','EXPIRED','REQUIRES_REVIEW')" },
    requested_by: { type: 'uuid', references: 'users', onDelete: 'RESTRICT' },
    decided_by: { type: 'uuid', references: 'users', onDelete: 'RESTRICT' },
    decision: { type: 'text' },                      // APPROVED | REJECTED | CANCELLED
    reason: { type: 'text' },
    quantity: { type: 'numeric(14,3)' },
    previous_status: { type: 'text' },
    new_status: { type: 'text' },
    device_id: { type: 'text' },
    client_uuid: { type: 'uuid', unique: true },     // idempotency (§47)
    decided_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('approvals', ['entity_type', 'entity_id']);
  pgm.createIndex('approvals', ['status', 'created_at']);

  pgm.createTable('approval_events', {
    id: { type: 'bigserial', primaryKey: true },
    approval_id: { type: 'uuid', notNull: true, references: 'approvals', onDelete: 'CASCADE' },
    actor_id: { type: 'uuid', references: 'users', onDelete: 'RESTRICT' },
    action: { type: 'text', notNull: true }, // SUBMITTED | APPROVED | REJECTED | CANCELLED | REVIEW
    reason: { type: 'text' },
    meta: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('approval_events', ['approval_id', 'created_at']);

  // ── Notifications (§34) — scoped per user; dedup_key makes offline/sync
  // replay creation idempotent (§39/§47). Rows are never auto-deleted on read.
  pgm.createTable('notifications', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    type: { type: 'text', notNull: true },
    title: { type: 'text', notNull: true },
    message: { type: 'text' },
    entity_type: { type: 'text' },
    entity_id: { type: 'uuid' },
    severity: { type: 'text', notNull: true, default: 'INFO',
      check: "severity IN ('INFO','SUCCESS','WARNING','ERROR','CRITICAL')" },
    is_read: { type: 'boolean', notNull: true, default: false },
    read_at: { type: 'timestamptz' },
    expires_at: { type: 'timestamptz' },
    metadata: { type: 'jsonb' },
    dedup_key: { type: 'text', unique: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('notifications', ['user_id', 'is_read', 'created_at']);

  // ── Push devices (§40) ──
  pgm.createTable('push_devices', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    device_id: { type: 'text', notNull: true },
    platform: { type: 'text' },
    push_token: { type: 'text' },
    app_version: { type: 'text' },
    last_seen_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('push_devices', ['user_id', 'device_id'], { unique: true });

  // ── Report identity settings (§3/§7) — seeded defaults, operator-editable ──
  // NOTE: values are inlined — node-pg-migrate's pgm.sql does not accept
  // array-style $n args (its transformer treats [..] keys as {0} placeholders).
  pgm.sql(`INSERT INTO settings (key, value) VALUES
             ('org.name', '"Trusted Systems Ltd"'),
             ('org.report.line', '"Fleet Fuel Management System"'),
             ('currency', '"KES"')
           ON CONFLICT (key) DO NOTHING`);
};

export const down = (pgm) => {
  pgm.dropTable('push_devices');
  pgm.dropTable('notifications');
  pgm.dropTable('approval_events');
  pgm.dropTable('approvals');
};
