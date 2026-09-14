// ============================================================================
// Notifications (§29–§41). Persistent, per-user, deduplicated. Creation is
// idempotent via dedup_key (§39/§47): offline sync replays can never produce
// duplicates. Rows are scoped to the owning user in every query (§41).
// When called inside an open transaction (client given), the notification
// commits atomically with the business change (§46).
// ============================================================================
import { pool } from '../db/pool.js';

/**
 * create(client, { userId, type, title, message, entityType, entityId,
 *                  severity, metadata, dedupKey, expiresAt })
 * client: pg client (tx) or null → pool.
 */
export async function notify(client, n) {
  if (!n.userId) return null;
  const exec = client ?? pool;
  // §37 — category preference: user can mute categories (default enabled).
  const category = String(n.type || '').split('.')[0];
  try {
    const p = await exec.query('SELECT notification_prefs FROM users WHERE id = $1', [n.userId]);
    const prefs = p.rows[0]?.notification_prefs || {};
    if (prefs[category] === false) return null;
    if (prefs['*'] === false && prefs[category] == null) return null;
  } catch { /* prefs must never break notification delivery */ }
  const { rows } = await exec.query(
    `INSERT INTO notifications (user_id, type, title, message, entity_type, entity_id, severity, metadata, dedup_key, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (dedup_key) DO NOTHING
     RETURNING id`,
    [n.userId, n.type, n.title, n.message ?? null, n.entityType ?? null, n.entityId ?? null,
      n.severity ?? 'INFO', n.metadata ? JSON.stringify(n.metadata) : null,
      n.dedupKey ?? null, n.expiresAt ?? null],
  );
  return rows[0]?.id ?? null; // null = duplicate, intentionally silent (§39)
}

/** Notify every active user holding one of the given roles. */
export async function notifyRoles(client, roles, n, { excludeUserId } = {}) {
  const exec = client ?? pool;
  const { rows } = await exec.query(
    `SELECT id FROM users WHERE role = ANY($1::text[]) AND active${excludeUserId ? ' AND id <> $2' : ''}`,
    excludeUserId ? [roles, excludeUserId] : [roles],
  );
  let created = 0;
  for (const u of rows) {
    const id = await notify(exec, { ...n, userId: u.id, dedupKey: n.dedupKey ? `${n.dedupKey}:${u.id}` : null });
    if (id) created += 1;
  }
  return created;
}
