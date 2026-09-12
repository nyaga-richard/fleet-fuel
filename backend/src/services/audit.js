// Append-only audit trail. Audit rows are never edited or deleted.
export async function audit(client, { userId, action, entity, entityId, details = null, ip = null }) {
  const q = `INSERT INTO audit_logs (user_id, action, entity, entity_id, details, ip)
             VALUES ($1, $2, $3, $4, $5, $6)`;
  const params = [userId ?? null, action, entity ?? null, entityId ? String(entityId) : null,
    details ? JSON.stringify(details) : null, ip ?? null];
  if (client) return client.query(q, params);
  const { pool } = await import('../db/pool.js');
  return pool.query(q, params);
}
