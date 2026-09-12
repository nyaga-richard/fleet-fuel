// ============================================================================
// 004 — Platform: audit logs, sync records, uploads, settings.
// ============================================================================

export const up = (pgm) => {
  pgm.createTable('audit_logs', {
    id: { type: 'bigserial', primaryKey: true },
    user_id: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    action: { type: 'text', notNull: true },
    entity: { type: 'text' },
    entity_id: { type: 'text' },
    details: { type: 'jsonb' },
    ip: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('audit_logs', 'created_at');
  pgm.createIndex('audit_logs', ['entity', 'entity_id']);
  pgm.createIndex('audit_logs', 'action');

  pgm.createTable('sync_log', {
    id: { type: 'bigserial', primaryKey: true },
    device_id: { type: 'text', notNull: true },
    op_id: { type: 'text' },
    op_type: { type: 'text' },
    status: { type: 'text', notNull: true, check: "status IN ('applied','duplicate','failed')" },
    message: { type: 'text' },
    server_ref: { type: 'uuid' },
    user_id: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('sync_log', 'device_id');
  pgm.createIndex('sync_log', 'created_at');
  pgm.createIndex('sync_log', 'status');

  pgm.createTable('uploads', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    filename: { type: 'text', notNull: true },
    mime: { type: 'text', notNull: true },
    size_bytes: { type: 'bigint', notNull: true },
    storage_path: { type: 'text', notNull: true },
    entity_type: { type: 'text' },
    entity_id: { type: 'uuid' },
    uploaded_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('uploads', 'created_at');

  pgm.createTable('settings', {
    key: { type: 'text', primaryKey: true },
    value: { type: 'jsonb', notNull: true },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
};

export const down = (pgm) => {
  pgm.dropTable('settings');
  pgm.dropTable('uploads');
  pgm.dropTable('sync_log');
  pgm.dropTable('audit_logs');
};
