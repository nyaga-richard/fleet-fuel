// ============================================================================
// /api/approvals (§24/§25/§42). Listing/deciding is permission-gated per
// entity type (§26); rejection requires a reason (§23); duplicates are
// idempotent (§47); every action is audited and notifies the requester.
// An approved inventory adjustment posts its ledger entry INSIDE the same
// transaction as the decision (§46/§53) — pending/rejected alter nothing.
// ============================================================================
import { Router } from 'express';
import { pool, tx } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncH, bad, ApiError } from '../middleware/errors.js';
import { isUuid, needStr } from '../middleware/validate.js';
import { can, ROLE_PERMS } from '../services/permissions.js';
import { listApprovals, getApproval, decideApproval, createApproval, APPROVAL_ENTITIES } from '../services/approvals.js';
import { postLedgerEntry } from '../services/ledger.js';

const router = Router();
router.use(requireAuth);

const DECIDER_PERMS = Object.keys(ROLE_PERMS.admin).filter((p) => p.endsWith(':approve'));

function assertDecider(req) {
  const ok = DECIDER_PERMS.some((p) => can(req.user.role, p));
  if (!ok) throw bad('Requires an approval permission');
}

router.get('/', asyncH(async (req, res) => {
  assertDecider(req);
  const data = await listApprovals({ status: req.query.status, entityType: req.query.entity_type, page: req.query.page, pageSize: req.query.pageSize });
  res.json(data);
}));

router.get('/:id', asyncH(async (req, res) => {
  assertDecider(req);
  if (!isUuid(req.params.id)) throw bad('Invalid approval id');
  res.json(await getApproval(req.params.id));
}));

router.get('/:id/history', asyncH(async (req, res) => {
  assertDecider(req);
  if (!isUuid(req.params.id)) throw bad('Invalid approval id');
  const { history } = await getApproval(req.params.id);
  res.json({ history });
}));

// Business effects for an APPROVED decision, applied in-tx (§46/§53).
async function applyApprovedEffects(exec, decided) {
  if (decided.entity_type !== 'inventory_adjustment') return;
  const p = decided.payload || {};
  if (!p.fuel_type_id || !p.tank_id || !Number.isFinite(Number(p.quantity))) {
    throw new ApiError(400, 'Approved adjustment is missing its payload');
  }
  // Same guard as direct adjustments: never allow a negative tank balance.
  const { rows } = await exec.query(
    `SELECT COALESCE(SUM(quantity),0)::float AS balance FROM inventory_transactions
      WHERE fuel_type_id = $1 AND tank_id = $2`, [p.fuel_type_id, p.tank_id]);
  if (rows[0].balance + Number(p.quantity) < -0.001) {
    throw new ApiError(409, `Adjustment would make tank balance negative (current ${rows[0].balance} L)`);
  }
  await postLedgerEntry(exec, {
    entry_type: 'adjustment',
    fuel_type_id: p.fuel_type_id,
    tank_id: p.tank_id,
    quantity: Number(p.quantity),
    ref_table: 'approvals',
    ref_id: decided.id,
    description: `Approved adjustment: ${p.reason || '—'}`,
    performed_by: decided.decided_by,
    client_uuid: decided.client_uuid ?? null,
  });
}

async function decide(req, res, decision) {
  assertDecider(req);
  if (!isUuid(req.params.id)) throw bad('Invalid approval id');
  const reason = req.body?.reason != null ? String(req.body.reason) : undefined;
  if (decision === 'REJECTED' && !(reason && reason.trim())) throw bad('Reason for rejection is required');
  const result = await tx((client) => decideApproval(client, {
    approvalId: req.params.id,
    decision,
    actor: { id: req.user.sub, role: req.user.role },
    reason,
    clientUuid: req.body?.client_uuid ?? null,
    ip: req.ip,
    onApproved: applyApprovedEffects,
  }));
  res.json({ approval: result.approval, duplicate: result.duplicate });
}

router.post('/:id/approve', (req, res, next) => { decide(req, res, 'APPROVED').catch(next); });
router.post('/:id/reject', (req, res, next) => { decide(req, res, 'REJECTED').catch(next); });

// Generic submit endpoint for review requests raised by clients (§20/§42).
router.post('/', asyncH(async (req, res) => {
  assertDecider(req);
  const entityType = needStr(req.body, 'entity_type');
  if (!APPROVAL_ENTITIES[entityType]) throw bad(`Unknown entity_type: ${entityType}`);
  if (!isUuid(String(req.body.entity_id))) throw bad('entity_id must be a uuid');
  const { id, existing } = await createApproval(pool, {
    entityType,
    entityId: String(req.body.entity_id),
    requestedBy: req.user.sub,
    quantity: req.body.quantity ?? null,
    payload: req.body.payload ?? null,
    clientUuid: req.body.client_uuid ?? null,
    notifyTitle: `${APPROVAL_ENTITIES[entityType].label} requires review`,
    notifyMessage: req.body.message || null,
  });
  res.status(existing ? 200 : 201).json({ id, existing });
}));

export default router;
