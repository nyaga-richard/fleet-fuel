// ============================================================================
// Approvals engine (§19–§28, §46–§48). Permission-key based (§26); every
// decision writes an immutable event (§28), is audited (§48), idempotent
// (§47: double-click/retry with the same client_uuid returns the decided
// record; deciding a decided record is a 409), and blocks self-approval
// (§27) unless the explicit override setting is enabled (then audited).
// Business effects (e.g. posting an approved adjustment to the fuel ledger)
// run inside the SAME transaction as the decision (§46).
// ============================================================================
import { pool } from '../db/pool.js';
import { ApiError } from '../middleware/errors.js';
import { audit } from './audit.js';
import { notify, notifyRoles } from './notify.js';
import { can } from './permissions.js';

// entity_type → approve/reject permission keys (§26).
export const APPROVAL_ENTITIES = {
  fuel_requests: { perm: 'fuel_requests', label: 'Fuel Request Authorization' },
  fuel_excess: { perm: 'fuel_excess', label: 'Excess Fuel' },
  inventory_adjustment: { perm: 'inventory_adjustments', label: 'Inventory Adjustment' },
  fuel_receipt: { perm: 'fuel_receipts', label: 'Bulk Receipt Exception' },
  pump_variance: { perm: 'pump_variances', label: 'Pump Variance' },
  tank_variance: { perm: 'tank_variances', label: 'Tank Variance' },
};

async function settingOn(client, key, fallback = false) {
  const exec = client ?? pool;
  const { rows } = await exec.query(`SELECT value FROM settings WHERE key = $1`, [key]);
  if (!rows.length) return fallback;
  const v = rows[0].value;
  return v === true || v === 'true' || v === 'on';
}

/**
 * Create a PENDING approval. Idempotent: if the same entity already has an
 * open PENDING approval, that one is returned instead of a duplicate.
 * Notify deciders (same transaction, deduped §39/§46).
 */
export async function createApproval(client, a) {
  if (!APPROVAL_ENTITIES[a.entityType]) throw new ApiError(400, `Unknown approval entity: ${a.entityType}`);
  const exec = client ?? pool;

  const open = await exec.query(
    `SELECT id FROM approvals
      WHERE entity_type = $1 AND entity_id = $2 AND status = 'PENDING'
      ORDER BY created_at DESC LIMIT 1`, [a.entityType, a.entityId]);
  if (open.rows.length) return { id: open.rows[0].id, existing: true };

  const { rows } = await exec.query(
    `INSERT INTO approvals (entity_type, entity_id, approval_type, status, requested_by, quantity, payload, client_uuid)
     VALUES ($1, $2, $3, 'PENDING', $4, $5, $6, $7)
     RETURNING id`,
    [a.entityType, a.entityId, `${a.entityType}:approve`, a.requestedBy ?? null,
      a.quantity ?? null, a.payload ? JSON.stringify(a.payload) : null, a.clientUuid ?? null]);
  const id = rows[0].id;

  await exec.query(
    `INSERT INTO approval_events (approval_id, actor_id, action, reason, meta)
     VALUES ($1, $2, 'SUBMITTED', $3, $4)`,
    [id, a.requestedBy ?? null, a.reason ?? null, a.eventMeta ? JSON.stringify(a.eventMeta) : null]);

  await notifyRoles(exec, ['manager', 'admin'], {
    type: `approval.${a.entityType}`,
    title: a.notifyTitle || 'Approval required',
    message: a.notifyMessage || `${APPROVAL_ENTITIES[a.entityType].label} requires review.`,
    entityType: 'approval', entityId: id,
    severity: a.severity || 'WARNING',
    dedupKey: `approval.created:${id}`,
    metadata: { approval_id: id, entity_type: a.entityType, entity_id: a.entityId },
  }, { excludeUserId: a.requestedBy });

  await audit(exec, {
    userId: a.requestedBy ?? null,
    action: 'approval.submitted',
    entity: 'approvals', entityId: id,
    details: { entity_type: a.entityType, entity_id: a.entityId, quantity: a.quantity ?? null },
  });
  return { id, existing: false };
}

/**
 * Decide an approval. Returns { approval, duplicate }.
 *   - Same client_uuid as an already-applied event → duplicate (200 path §47).
 *   - Already decided without that client_uuid → 409.
 * onApproved(client, approval) may apply business effects in-tx (§46).
 */
export async function decideApproval(client, { approvalId, decision, actor, reason, clientUuid, ip, onApproved }) {
  const exec = client ?? pool;
  if (!['APPROVED', 'REJECTED'].includes(decision)) throw new ApiError(400, 'decision must be APPROVED or REJECTED');

  const { rows } = await exec.query(`SELECT * FROM approvals WHERE id = $1 FOR UPDATE`, [approvalId]);
  const approval = rows[0];
  if (!approval) throw new ApiError(404, 'Approval not found');
  if (!APPROVAL_ENTITIES[approval.entity_type]) throw new ApiError(400, 'Unknown approval entity');

  if (approval.status !== 'PENDING') {
    if (clientUuid) {
      const dup = await exec.query(
        `SELECT 1 FROM approval_events WHERE approval_id = $1 AND meta->>'client_uuid' = $2`, [approvalId, String(clientUuid)]);
      if (dup.rows.length) return { approval, duplicate: true };
    }
    throw new ApiError(409, `Approval already ${approval.status.toLowerCase()}`);
  }

  // §26 — permission by KEY, never role name.
  const perm = APPROVAL_ENTITIES[approval.entity_type].perm;
  if (!can(actor.role, `${perm}:approve`)) throw new ApiError(403, `Requires permission: ${perm}:approve`);

  // §27 — no self-approval (unless explicitly overridden, then audited).
  let selfOverride = false;
  if (approval.requested_by && approval.requested_by === actor.id) {
    if (await settingOn(exec, 'approvals.allow_self_approval_override', false)) {
      selfOverride = true;
    } else {
      throw new ApiError(403, 'Self-approval is not allowed — another manager or administrator must decide this.');
    }
  }

  // §23 — rejection requires a reason.
  if (decision === 'REJECTED' && !(reason && String(reason).trim())) {
    throw new ApiError(400, 'Reason for rejection is required');
  }

  const entity = APPROVAL_ENTITIES[approval.entity_type];
  const { rows: upd } = await exec.query(
    `UPDATE approvals
        SET status = $2, decision = $2, decided_by = $3, reason = $4,
            previous_status = status, new_status = $2, decided_at = now(), updated_at = now()
      WHERE id = $1 RETURNING *`, [approvalId, decision, actor.id, reason?.trim() || null]);
  const decided = upd[0];

  await exec.query(
    `INSERT INTO approval_events (approval_id, actor_id, action, reason, meta)
     VALUES ($1, $2, $3, $4, $5)`,
    [approvalId, actor.id, decision, reason?.trim() || null,
      JSON.stringify({ client_uuid: clientUuid ?? null, self_override: selfOverride, ip: ip ?? null })]);

  // §46 — business effects commit atomically with the decision.
  if (decision === 'APPROVED' && onApproved) await onApproved(exec, decided);

  // §28/§48 — notify the requester of the outcome.
  if (decided.requested_by) {
    await notify(exec, {
      userId: decided.requested_by,
      type: decision === 'APPROVED' ? `approval.${approval.entity_type}.approved` : `approval.${approval.entity_type}.rejected`,
      title: decision === 'APPROVED'
        ? `${entity.label} approved`
        : `${entity.label} rejected`,
      message: decision === 'APPROVED'
        ? 'Your submission was approved.'
        : `Reason: ${reason?.trim() || '—'}`,
      entityType: approval.entity_type, entityId: approval.entity_id,
      severity: decision === 'APPROVED' ? 'SUCCESS' : 'ERROR',
      dedupKey: `approval.decided:${approvalId}`,
      metadata: { approval_id: approvalId },
    });
  }

  await audit(exec, {
    userId: actor.id,
    action: `approval.${decision.toLowerCase()}`,
    entity: 'approvals', entityId: approvalId,
    details: { entity_type: approval.entity_type, entity_id: approval.entity_id, self_override: selfOverride, reason: reason?.trim() || null },
    ip,
  });

  return { approval: decided, duplicate: false };
}

export async function listApprovals({ status, entityType, page = 1, pageSize = 50 } = {}) {
  const params = [];
  const where = [];
  if (status) { params.push(String(status).toUpperCase()); where.push(`a.status = $${params.length}`); }
  if (entityType) { params.push(String(entityType)); where.push(`a.entity_type = $${params.length}`); }
  const LIMIT = Math.min(Math.max(1, Number(pageSize) || 50), 200);
  const { rows } = await pool.query(
    `SELECT a.id, a.entity_type, a.approval_type, a.status, a.quantity, a.reason,
            a.previous_status, a.new_status, a.decided_at, a.created_at,
            a.entity_id, a.payload,
            ur.name AS requested_by_name, ud.name AS decided_by_name
       FROM approvals a
       LEFT JOIN users ur ON ur.id = a.requested_by
       LEFT JOIN users ud ON ud.id = a.decided_by
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY (a.status = 'PENDING') DESC, a.created_at DESC
      LIMIT ${LIMIT} OFFSET ${(Math.max(1, Number(page) || 1) - 1) * LIMIT}`, params);
  const { rows: c } = await pool.query(
    `SELECT status, count(*)::int AS n FROM approvals a ${where.length ? 'WHERE ' + where.join(' AND ') : ''} GROUP BY a.status`, params);
  const counts = Object.fromEntries(c.map((r) => [r.status, r.n]));
  return { approvals: rows, counts, total: rows.length };
}

export async function getApproval(id) {
  const { rows } = await pool.query(
    `SELECT a.*, ur.name AS requested_by_name, ud.name AS decided_by_name
       FROM approvals a
       LEFT JOIN users ur ON ur.id = a.requested_by
       LEFT JOIN users ud ON ud.id = a.decided_by
      WHERE a.id = $1`, [id]);
  if (!rows.length) throw new ApiError(404, 'Approval not found');
  const history = await pool.query(
    `SELECT e.id, e.action, e.reason, e.created_at, u.name AS actor_name
       FROM approval_events e LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.approval_id = $1 ORDER BY e.created_at ASC`, [id]);
  return { approval: rows[0], history: history.rows };
}
