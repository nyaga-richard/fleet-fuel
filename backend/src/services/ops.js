// ============================================================================
// SHARED OPERATIONS — one authoritative implementation per business action,
// used BOTH by the REST API routes and by the mobile offline-sync batch
// endpoint. Supports client_uuid idempotency so a queued offline operation
// can be replayed any number of times and be applied exactly once.
// ============================================================================
import { findByClientUuid, postLedgerEntry } from './ledger.js';
import { audit } from './audit.js';
import { notify, notifyRoles } from './notify.js';
import { createApproval } from './approvals.js';
import { nextDocNumber } from './numbering.js';
import { recordOdometer } from './fleet.js';
import { ApiError } from '../middleware/errors.js';

const dupResult = (existing) => ({ status: 'duplicate', ref: { id: existing.id } });

/**
 * Create a fuel request. Idempotent on payload.client_uuid.
 * Returns {row, duplicate:boolean}.
 */
export async function createFuelRequest(client, { payload, userId }) {
  const clientUuid = payload.client_uuid || null;
  const existing = await findByClientUuid(client, 'fuel_requests', clientUuid);
  if (existing) return { row: existing, duplicate: true };

  const missing = ['vehicle_id', 'fuel_type_id'].filter((f) => !payload[f]);
  if (missing.length) throw new ApiError(400, `Missing required fields: ${missing.join(', ')}`);
  const qty = Number(payload.quantity);
  if (!Number.isFinite(qty) || qty <= 0) throw new ApiError(400, 'quantity must be > 0');

  const { rows: vehicle } = await client.query(
    `SELECT id, plate, driver_name FROM vehicles WHERE id = $1 AND active`, [payload.vehicle_id]);
  if (!vehicle.length) throw new ApiError(400, 'Vehicle not found or inactive');
  const { rows: ft } = await client.query(`SELECT id FROM fuel_types WHERE id = $1 AND active`, [payload.fuel_type_id]);
  if (!ft.length) throw new ApiError(400, 'Fuel type not found or inactive');

  const requestNo = await nextDocNumber(client, 'request');
  const driver = payload.driver_name?.trim() || vehicle[0].driver_name || null;

  const { rows } = await client.query(
    `INSERT INTO fuel_requests
       (request_no, vehicle_id, fuel_type_id, quantity, driver_name, odometer,
        destination, notes, status, requested_by, client_uuid, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,
             COALESCE($11::timestamptz, now()))
     RETURNING *`,
    [requestNo, payload.vehicle_id, payload.fuel_type_id, qty, driver,
      payload.odometer ?? null, payload.destination ?? null, payload.notes ?? null,
      userId, clientUuid, payload.created_at ?? null],
  );
  await audit(client, { userId, action: 'fuel_request.create', entity: 'fuel_requests', entityId: rows[0].id, details: { request_no: requestNo, quantity: qty } });
  await notifyRoles(client, ['manager', 'admin'], {
    type: 'fuel_request.submitted',
    title: 'New fuel request submitted',
    message: `${rows[0].request_no} — ${qty} L submitted for approval.`,
    entityType: 'fuel_request', entityId: rows[0].id,
    severity: 'INFO', dedupKey: `fuel_request.submitted:${rows[0].id}`,
    metadata: { request_no: rows[0].request_no, quantity: qty },
  }, { excludeUserId: userId });
  return { row: rows[0], duplicate: false };
}

/**
 * Approve or reject a fuel request (manager/admin).
 */
export async function decideFuelRequest(client, { requestId, decision, userId, comments }) {
  if (!['approved', 'rejected'].includes(decision)) throw new ApiError(400, 'decision must be approved|rejected');
  const { rows } = await client.query(`SELECT * FROM fuel_requests WHERE id = $1 FOR UPDATE`, [requestId]);
  const request = rows[0];
  if (!request) throw new ApiError(404, 'Fuel request not found');
  if (request.status !== 'pending') {
    throw new ApiError(409, `Request is already ${request.status} (only pending requests can be decided)`);
  }

  await client.query(
    `INSERT INTO authorizations (request_id, decision, decided_by, comments)
     VALUES ($1,$2,$3,$4)`,
    [requestId, decision, userId, comments ?? null],
  );
  const { rows: updated } = await client.query(
    `UPDATE fuel_requests SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [requestId, decision],
  );
  await audit(client, { userId, action: `fuel_request.${decision}`, entity: 'fuel_requests', entityId: requestId, details: { request_no: request.request_no, comments } });
  if (decision === 'approved') {
    await notify(client, {
      userId: request.requested_by,
      type: 'fuel_request.approved',
      title: `Fuel request ${request.request_no} approved`,
      message: `Your fuel request ${request.request_no} was approved and is ready for fueling.`,
      entityType: 'fuel_request', entityId: request.id,
      severity: 'SUCCESS', dedupKey: `fuel_request.approved:${request.id}`,
      metadata: { request_no: request.request_no, decided_by: userId },
    });
  } else if (decision === 'rejected') {
    await notify(client, {
      userId: request.requested_by,
      type: 'fuel_request.rejected',
      title: `Fuel request ${request.request_no} rejected`,
      message: comments ? `Reason: ${comments}` : 'Your fuel request was rejected.',
      entityType: 'fuel_request', entityId: request.id,
      severity: 'WARNING', dedupKey: `fuel_request.rejected:${request.id}`,
      metadata: { request_no: request.request_no, reason: comments ?? null },
    });
  }
  return updated[0];
}

/**
 * Issue fuel against an APPROVED request → immutable fuel transaction +
// negative fuel-ledger entry + optional pump reading. Idempotent on client_uuid.
 */
export async function issueFuel(client, { payload, userId }) {
  const clientUuid = payload.client_uuid || null;
  const existing = await findByClientUuid(client, 'fuel_transactions', clientUuid);
  if (existing) return { row: existing, duplicate: true };

  let request = null;
  if (payload.request_id) {
    const { rows } = await client.query(`SELECT * FROM fuel_requests WHERE id = $1 FOR UPDATE`, [payload.request_id]);
    request = rows[0] ?? null;
  } else if (payload.request_no) {
    const { rows } = await client.query(`SELECT * FROM fuel_requests WHERE request_no = $1 FOR UPDATE`, [payload.request_no]);
    request = rows[0] ?? null;
  }
  if (!request) throw new ApiError(404, 'Fuel request not found');
  if (request.status === 'issued') throw new ApiError(409, 'Request already fully issued');
  if (request.status !== 'approved') throw new ApiError(409, `Request is ${request.status} — only approved requests can be issued`);

  const qty = Number(payload.quantity);
  if (!Number.isFinite(qty) || qty <= 0) throw new ApiError(400, 'quantity must be > 0');

  // Resolve pump → tank. Pump is optional for mobile metered deliveries.
  let tankId = null;
  let pumpId = null;
  if (payload.pump_id) {
    const { rows: pump } = await client.query(
      `SELECT p.id, p.tank_id, p.active FROM pumps p WHERE p.id = $1`, [payload.pump_id]);
    if (!pump.length) throw new ApiError(400, 'Pump not found');
    if (!pump[0].active) throw new ApiError(400, 'Pump is inactive');
    pumpId = pump[0].id;
    tankId = pump[0].tank_id;
  } else if (payload.tank_id) {
    tankId = payload.tank_id;
  } else {
    throw new ApiError(400, 'Either pump_id or tank_id is required');
  }

  // Fuel type must match the request.
  const fuelTypeId = request.fuel_type_id;
  if (payload.fuel_type_id && payload.fuel_type_id !== fuelTypeId) {
    throw new ApiError(400, 'Fuel type does not match the request');
  }

  // Guard: never allow stock to go negative (physical impossibility / data error).
  const { rows: bal } = await client.query(
    `SELECT COALESCE(SUM(quantity),0)::float AS balance FROM inventory_transactions
      WHERE fuel_type_id = $1 AND tank_id = $2`, [fuelTypeId, tankId]);
  if (bal[0].balance - qty < -0.001) {
    throw new ApiError(409, `Insufficient fuel in tank: available ${bal[0].balance} L, requested ${qty} L`);
  }

  // Authorization reference (the approval decision row).
  const { rows: authz } = await client.query(
    `SELECT id FROM authorizations WHERE request_id = $1 AND decision = 'approved' ORDER BY decided_at DESC LIMIT 1`,
    [request.id]);

  const txnNo = await nextDocNumber(client, 'transaction');
  const { rows: inserted } = await client.query(
    `INSERT INTO fuel_transactions
       (txn_no, request_id, authorization_id, vehicle_id, fuel_type_id, tank_id, pump_id,
        quantity, unit_price, operator_id, odometer, status, client_uuid, lpo_no, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'completed',$12,$13, COALESCE($14::timestamptz, now()))
     RETURNING *`,
    [txnNo, request.id, authz[0]?.id ?? null, request.vehicle_id, fuelTypeId, tankId, pumpId,
      qty, payload.unit_price ?? null, userId, payload.odometer ?? request.odometer ?? null,
      clientUuid, payload.lpo_no ?? null, payload.created_at ?? null],
  );

  // THE LEDGER: immutable negative issue entry with running balance.
  const entry = await postLedgerEntry(client, {
    entry_type: 'issue',
    fuel_type_id: fuelTypeId,
    tank_id: tankId,
    quantity: -qty,
    ref_table: 'fuel_transactions',
    ref_id: inserted[0].id,
    description: `Issue ${qty} L against ${request.request_no}`,
    performed_by: userId,
  });

  // Optional pump meter reading captured at handover.
  if (payload.pump_reading !== undefined && payload.pump_reading !== null && payload.pump_reading !== '') {
    await client.query(
      `INSERT INTO pump_readings (pump_id, reading, fuel_transaction_id, recorded_by, client_uuid, created_at)
       VALUES ($1,$2,$3,$4,$5, COALESCE($6::timestamptz, now()))`,
      [pumpId, Number(payload.pump_reading), inserted[0].id, userId,
        clientUuid, payload.created_at ?? null],
    );
  }

  await client.query(`UPDATE fuel_requests SET status = 'issued', updated_at = now() WHERE id = $1`, [request.id]);
  const issueOdo = payload.odometer ?? request.odometer ?? null;
  if (issueOdo != null) {
    await recordOdometer(client, { vehicleId: request.vehicle_id, odometer: issueOdo,
      source: 'fuel_transaction', refTable: 'fuel_transactions', refId: inserted[0].id,
      enteredBy: userId, at: payload.created_at ?? null });
  }
  await audit(client, { userId, action: 'fuel_transaction.issue', entity: 'fuel_transactions', entityId: inserted[0].id, details: { txn_no: txnNo, quantity: qty, ledger_entry: entry.id } });
  // §52/§53 — issuing beyond the authorized quantity records the ACTUAL
  // quantity (physical truth, never silently altered) and raises an excess
  // approval. The approval tracks the review separately from the movement.
  const excess = Number(request.quantity) > 0 ? +(qty - Number(request.quantity)).toFixed(3) : 0;
  if (excess > 0.0001) {
    await createApproval(client, {
      entityType: 'fuel_excess',
      entityId: inserted[0].id,
      requestedBy: userId,
      quantity: excess,
      payload: { txn_no: txnNo, request_no: request.request_no, authorized: Number(request.quantity), actual: qty, excess },
      clientUuid: clientUuid ?? null,
      notifyTitle: 'Excess fuel approval required',
      notifyMessage: `${request.request_no}: authorized ${request.quantity} L, issued ${qty} L (excess ${excess} L).`,
      severity: 'WARNING',
    });
  }

  return { row: { ...inserted[0], balance_after: entry.balance_after }, duplicate: false };
}

/**
 * §28–§36 Direct Fuel Entry — record fuel already issued WITHOUT a request.
 * Never creates an approval; posts FUEL_ISSUE to the inventory ledger and is
 * stamped source=DIRECT_ENTRY so reporting can distinguish it forever.
 * §34 price rule: user-entered fueling price wins; blank → applicable cost
 * price (last receipt price for the fuel type) — never 0, never NULL.
 */
export async function directFuelEntry(client, { payload, userId }) {
  const clientUuid = payload.client_uuid || null;
  const existing = await findByClientUuid(client, 'fuel_transactions', clientUuid);
  if (existing) return { row: existing, duplicate: true, price_source: 'UNCHANGED' };

  const qty = Number(payload.quantity);
  if (!Number.isFinite(qty) || qty <= 0) throw new ApiError(400, 'quantity must be > 0');

  // Vehicle + fuel type must be real and active.
  const { rows: veh } = await client.query('SELECT id, plate, active FROM vehicles WHERE id = $1', [payload.vehicle_id]);
  if (!veh.length) throw new ApiError(400, 'Vehicle not found');
  if (!veh[0].active) throw new ApiError(400, 'Vehicle is inactive');
  const { rows: ft } = await client.query('SELECT id, name, active FROM fuel_types WHERE id = $1', [payload.fuel_type_id]);
  if (!ft.length) throw new ApiError(400, 'Fuel type not found');
  if (!ft[0].active) throw new ApiError(400, 'Fuel type is inactive');

  // Resolve pump → tank (or explicit tank). Tank's fuel must match.
  let tankId = null;
  let pumpId = null;
  if (payload.pump_id) {
    const { rows: pump } = await client.query('SELECT id, tank_id, active FROM pumps WHERE id = $1', [payload.pump_id]);
    if (!pump.length) throw new ApiError(400, 'Pump not found');
    if (!pump[0].active) throw new ApiError(400, 'Pump is inactive');
    pumpId = pump[0].id;
    tankId = pump[0].tank_id;
  } else if (payload.tank_id) {
    tankId = payload.tank_id;
  } else {
    throw new ApiError(400, 'Either pump_id or tank_id is required');
  }
  const { rows: tank } = await client.query('SELECT id, fuel_type_id, active FROM tanks WHERE id = $1', [tankId]);
  if (!tank.length) throw new ApiError(400, 'Tank not found');
  if (!tank[0].active) throw new ApiError(400, 'Tank is inactive');
  if (tank[0].fuel_type_id !== payload.fuel_type_id) throw new ApiError(400, 'Tank does not hold that fuel type');

  // §34 — applicable cost price = latest receipt price for this fuel type.
  const { rows: costRow } = await client.query(
    `SELECT unit_price FROM purchases
      WHERE fuel_type_id = $1 AND unit_price IS NOT NULL AND unit_price > 0
      ORDER BY created_at DESC LIMIT 1`, [payload.fuel_type_id]);
  const costPrice = costRow.length ? Number(costRow[0].unit_price) : null;

  let appliedPrice;
  let priceSource;
  if (payload.unit_price != null && payload.unit_price !== '' && Number(payload.unit_price) > 0) {
    appliedPrice = Number(payload.unit_price);
    priceSource = 'USER ENTERED';
  } else {
    if (costPrice == null) throw new ApiError(400, 'No cost price on record for this fuel type — enter a fueling price');
    appliedPrice = costPrice;
    priceSource = 'COST PRICE';
  }

  // Same physical-impossibility guard as issueFuel: stock never goes negative.
  const { rows: bal } = await client.query(
    `SELECT COALESCE(SUM(quantity),0)::float AS balance FROM inventory_transactions
      WHERE fuel_type_id = $1 AND tank_id = $2`, [payload.fuel_type_id, tankId]);
  if (bal[0].balance - qty < -0.001) {
    throw new ApiError(409, `Insufficient fuel in tank: available ${bal[0].balance} L, requested ${qty} L`);
  }

  // Pump meter sanity: end must not be before start.
  const pumpStart = payload.pump_start != null && payload.pump_start !== '' ? Number(payload.pump_start) : null;
  const pumpEnd = payload.pump_end != null && payload.pump_end !== '' ? Number(payload.pump_end) : null;
  if (pumpStart != null && pumpEnd != null && pumpEnd < pumpStart) {
    throw new ApiError(400, 'Pump end reading cannot be less than the start reading');
  }

  const txnNo = await nextDocNumber(client, 'transaction');
  const { rows: inserted } = await client.query(
    `INSERT INTO fuel_transactions
       (txn_no, request_id, authorization_id, vehicle_id, fuel_type_id, tank_id, pump_id,
        quantity, unit_price, unit_cost, operator_id, odometer, status, client_uuid, lpo_no,
        source, destination, purpose, remarks, pump_start, pump_end, created_at)
     VALUES ($1,NULL,NULL,$2,$3,$4,$5,$6,$7,$8,$9,$10,'completed',$11,$12,'DIRECT_ENTRY',$13,$14,$15,$16,$17,
             COALESCE($18::timestamptz, now()))
     RETURNING *`,
    [txnNo, payload.vehicle_id, payload.fuel_type_id, tankId, pumpId,
      qty, appliedPrice, costPrice, userId, payload.odometer ?? null,
      clientUuid, payload.lpo_no ?? null, payload.destination ?? null, payload.purpose ?? null, payload.remarks ?? null,
      pumpStart, pumpEnd, payload.transaction_date ?? null]);

  // THE LEDGER — same immutable negative issue entry as workflow issues.
  const entry = await postLedgerEntry(client, {
    entry_type: 'issue',
    fuel_type_id: payload.fuel_type_id,
    tank_id: tankId,
    quantity: -qty,
    ref_table: 'fuel_transactions',
    ref_id: inserted[0].id,
    description: `Direct entry ${qty} L — ${veh[0].plate}${payload.destination ? ` to ${payload.destination}` : ''}`,
    performed_by: userId,
    at: payload.transaction_date ?? null, // ledger row dated as entered, not today
  });

  // Meter truth for reconciliation: record the end reading like a handover.
  if (pumpId && pumpEnd != null) {
    await client.query(
      `INSERT INTO pump_readings (pump_id, reading, fuel_transaction_id, recorded_by, client_uuid, created_at)
       VALUES ($1,$2,$3,$4,$5, COALESCE($6::timestamptz, now()))`,
      [pumpId, pumpEnd, inserted[0].id, userId, clientUuid, payload.transaction_date ?? null]);
  }

  if (payload.odometer != null) {
    await recordOdometer(client, { vehicleId: payload.vehicle_id, odometer: payload.odometer,
      source: 'fuel_transaction', refTable: 'fuel_transactions', refId: inserted[0].id,
      enteredBy: userId, at: payload.transaction_date ?? null });
  }

  await audit(client, {
    userId,
    action: 'DIRECT_FUEL_ENTRY_CREATED',
    entity: 'fuel_transactions', entityId: inserted[0].id,
    details: { txn_no: txnNo, vehicle: veh[0].plate, quantity: qty, tank_id: tankId, pump_id: pumpId,
      fueling_price: appliedPrice, price_source: priceSource, unit_cost: costPrice,
      destination: payload.destination ?? null, ledger_entry: entry.id },
  });

  await notifyRoles(client, ['manager', 'admin'], {
    type: 'fuel_entry.direct',
    title: 'Direct fuel entry recorded',
    message: `${veh[0].plate}: ${qty} L (${txnNo}) by direct entry — no request workflow.`,
    entityType: 'fuel_transaction', entityId: inserted[0].id,
    severity: 'INFO',
    dedupKey: `fuel_entry.direct:${inserted[0].id}`,
    metadata: { txn_no: txnNo, quantity: qty },
  }, { excludeUserId: userId });

  return { row: { ...inserted[0], balance_after: entry.balance_after }, duplicate: false, price_source: priceSource };
}

/** Reverse a completed issue (manager/admin) — restores stock, keeps history. */
export async function reverseFuelTransaction(client, { transactionId, userId, reason }) {
  const { rows } = await client.query(`SELECT * FROM fuel_transactions WHERE id = $1 FOR UPDATE`, [transactionId]);
  const original = rows[0];
  if (!original) throw new ApiError(404, 'Transaction not found');
  if (original.status === 'reversed') throw new ApiError(409, 'Transaction is already reversed');
  if (original.reversal_of) throw new ApiError(400, 'Cannot reverse a reversal');

  // Resolve the tank the issue drew from (stamped on the transaction; fall
  // back to the pump's tank for legacy rows).
  let tankId = original.tank_id ?? null;
  if (!tankId && original.pump_id) {
    const { rows: p } = await client.query(`SELECT tank_id FROM pumps WHERE id = $1`, [original.pump_id]);
    tankId = p[0]?.tank_id ?? null;
  }
  if (!tankId) throw new ApiError(500, 'Cannot determine source tank for reversal');

  const reversalNo = await nextDocNumber(client, 'transaction');
  const { rows: rev } = await client.query(
    `INSERT INTO fuel_transactions
       (txn_no, request_id, vehicle_id, fuel_type_id, pump_id, quantity, unit_price,
        operator_id, status, reversal_of, client_uuid)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'completed',$9,$10)
     RETURNING *`,
    [reversalNo, original.request_id, original.vehicle_id, original.fuel_type_id, original.pump_id,
      original.quantity, original.unit_price, userId, original.id,
      original.client_uuid ? original.client_uuid + ':reversal' : null],
  );

  await postLedgerEntry(client, {
    entry_type: 'reversal',
    fuel_type_id: original.fuel_type_id,
    tank_id: tankId,
    quantity: Number(original.quantity), // restore stock
    ref_table: 'fuel_transactions',
    ref_id: rev[0].id,
    description: `Reversal of ${original.txn_no}${reason ? ` — ${reason}` : ''}`,
    performed_by: userId,
  });

  const { rows: updated } = await client.query(
    `UPDATE fuel_transactions SET status = 'reversed', updated_at = now() WHERE id = $1 RETURNING *`,
    [original.id],
  );
  await audit(client, { userId, action: 'fuel_transaction.reverse', entity: 'fuel_transactions', entityId: original.id, details: { reversal: rev[0].txn_no, reason } });
  return { original: updated[0], reversal: rev[0] };
}

/** Bulk receipt / delivery of fuel into a tank (manager/admin). */
export async function createReceipt(client, { payload, userId }) {
  const clientUuid = payload.client_uuid || null;
  const existing = await findByClientUuid(client, 'purchases', clientUuid);
  if (existing) return { row: existing, duplicate: true };

  for (const f of ['fuel_type_id', 'tank_id']) {
    if (!payload[f]) throw new ApiError(400, `Missing required field: ${f}`);
  }
  const qty = Number(payload.quantity);
  if (!Number.isFinite(qty) || qty <= 0) throw new ApiError(400, 'quantity must be > 0');
  if (!payload.supplier || !String(payload.supplier).trim()) throw new ApiError(400, 'supplier is required');

  const { rows: tank } = await client.query(
    `SELECT t.id, t.fuel_type_id, t.name FROM tanks t WHERE t.id = $1 AND t.active`, [payload.tank_id]);
  if (!tank.length) throw new ApiError(400, 'Tank not found or inactive');
  if (tank[0].fuel_type_id !== payload.fuel_type_id) {
    throw new ApiError(400, 'Fuel type does not match the tank fuel type');
  }

  const receiptNo = await nextDocNumber(client, 'receipt');
  const { rows } = await client.query(
    `INSERT INTO purchases
       (receipt_no, supplier, invoice_no, fuel_type_id, tank_id, quantity, unit_price,
        delivery_note, received_by, client_uuid, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, COALESCE($11::timestamptz, now()))
     RETURNING *`,
    [receiptNo, String(payload.supplier).trim(), payload.invoice_no ?? null, payload.fuel_type_id,
      payload.tank_id, qty, payload.unit_price ?? null, payload.delivery_note ?? null,
      userId, clientUuid, payload.created_at ?? null],
  );

  const entry = await postLedgerEntry(client, {
    entry_type: 'receipt',
    fuel_type_id: payload.fuel_type_id,
    tank_id: payload.tank_id,
    quantity: qty,
    ref_table: 'purchases',
    ref_id: rows[0].id,
    description: `Receipt ${receiptNo} — ${String(payload.supplier).trim()}`,
    performed_by: userId,
  });

  // §21 — fuel purchase → fuel inventory + supplier payable. Optional: only
  // when the receipt names a supplier account. One authoritative ledger entry.
  if (payload.supplier_id) {
    const isU = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(payload.supplier_id));
    if (!isU) throw new ApiError(400, 'supplier_id must be a valid id');
    if (payload.unit_price == null) throw new ApiError(400, 'unit_price is required when recording the purchase against a supplier account');
    const { rows: sup } = await client.query('SELECT id, name FROM suppliers WHERE id = $1', [payload.supplier_id]);
    if (!sup.length) throw new ApiError(400, 'Supplier not found');
    const payable = +(qty * Number(payload.unit_price)).toFixed(2);
    await client.query(
      `INSERT INTO supplier_ledger_entries
         (supplier_id, entry_type, entry_date, reference, description, debit, source_table, source_id, created_by)
       VALUES ($1,'PURCHASE', COALESCE($2::date, CURRENT_DATE),$3,$4,$5,'purchases',$6,$7)`,
      [payload.supplier_id, payload.created_at ?? null, payload.invoice_no || receiptNo,
        `Fuel purchase ${receiptNo} — ${qty} L @ ${payload.unit_price}`, payable, rows[0].id, userId]);
  }

  await audit(client, { userId, action: 'purchase.receipt', entity: 'purchases', entityId: rows[0].id, details: { receipt_no: receiptNo, quantity: qty } });
  return { row: { ...rows[0], balance_after: entry.balance_after }, duplicate: false };
}

/** Stock adjustment (+/-) with mandatory reason — always an audit event. */
export async function createAdjustment(client, { payload, userId }) {
  for (const f of ['fuel_type_id', 'tank_id']) {
    if (!payload[f]) throw new ApiError(400, `Missing required field: ${f}`);
  }
  const qty = Number(payload.quantity);
  if (!Number.isFinite(qty) || qty === 0) throw new ApiError(400, 'quantity must be a non-zero signed number');
  if (!payload.reason || !String(payload.reason).trim()) throw new ApiError(400, 'reason is required for any adjustment');

  const { rows: tank } = await client.query(
    `SELECT t.fuel_type_id FROM tanks t WHERE t.id = $1 AND t.active`, [payload.tank_id]);
  if (!tank.length) throw new ApiError(400, 'Tank not found or inactive');
  if (tank[0].fuel_type_id !== payload.fuel_type_id) {
    throw new ApiError(400, 'Fuel type does not match the tank fuel type');
  }

  const { rows: bal } = await client.query(
    `SELECT COALESCE(SUM(quantity),0)::float AS balance FROM inventory_transactions
      WHERE fuel_type_id = $1 AND tank_id = $2`, [payload.fuel_type_id, payload.tank_id]);
  if (bal[0].balance + qty < -0.001) {
    throw new ApiError(409, `Adjustment would make tank balance negative (current ${bal[0].balance} L)`);
  }

  const entry = await postLedgerEntry(client, {
    entry_type: 'adjustment',
    fuel_type_id: payload.fuel_type_id,
    tank_id: payload.tank_id,
    quantity: qty,
    ref_table: null,
    ref_id: null,
    description: `Adjustment — ${String(payload.reason).trim()}`,
    performed_by: userId,
  });
  await audit(client, { userId, action: 'inventory.adjust', entity: 'inventory_transactions', entityId: entry.id, details: { quantity: qty, reason: payload.reason } });
  return { row: entry, duplicate: false };
}

/** Record a pump meter or tank dip reading. */
export async function createReading(client, { payload, userId }) {
  const type = payload.type === 'tank' ? 'tank' : 'pump';
  // client_uuid columns are Postgres type `uuid` — the op_id must go in
  // UNMODIFIED (the old ':tank' suffix made every tank-reading op crash with
  // `invalid input syntax for type uuid`). Uniqueness is per table, so the
  // same value as the parent op is safe and replay-idempotent.
  const clientUuid = payload.client_uuid || null;
  const existing = await findByClientUuid(client, type === 'pump' ? 'pump_readings' : 'tank_readings', clientUuid);
  if (existing) return { row: existing, kind: type, duplicate: true };
  if (type === 'pump') {
    if (!payload.pump_id) throw new ApiError(400, 'pump_id is required');
    const value = Number(payload.reading);
    if (!Number.isFinite(value) || value < 0) throw new ApiError(400, 'reading must be a number ≥ 0');
    const { rows } = await client.query(
      `INSERT INTO pump_readings (pump_id, reading, recorded_by, client_uuid, created_at)
       VALUES ($1,$2,$3,$4, COALESCE($5::timestamptz, now())) RETURNING *`,
      [payload.pump_id, value, userId, clientUuid, payload.created_at ?? null],
    );
    return { row: rows[0], kind: 'pump' };
  }
  if (!payload.tank_id) throw new ApiError(400, 'tank_id is required');
  const dip = payload.dip != null ? Number(payload.dip) : null;
  const estimate = payload.quantity_estimate != null ? Number(payload.quantity_estimate) : null;
  if ((dip == null && estimate == null) || (dip != null && dip < 0) || (estimate != null && estimate < 0)) {
    throw new ApiError(400, 'Provide dip and/or a non-negative quantity_estimate');
  }
  const { rows } = await client.query(
    `INSERT INTO tank_readings (tank_id, dip, quantity_estimate, recorded_by, client_uuid, created_at)
     VALUES ($1,$2,$3,$4,$5, COALESCE($6::timestamptz, now())) RETURNING *`,
    [payload.tank_id, dip, estimate, userId, clientUuid, payload.created_at ?? null],
  );
  return { row: rows[0], kind: 'tank' };
}

// Ops accepted by the offline sync endpoint (mobile → server).
export const SYNC_OP_TYPES = {
  fuel_request: (client, { payload, userId }) => createFuelRequest(client, { payload, userId }),
  fuel_transaction: (client, { payload, userId }) => issueFuel(client, { payload, userId }),
  pump_reading: (client, { payload, userId }) => createReading(client, { payload: { ...payload, type: 'pump' }, userId }),
  tank_reading: (client, { payload, userId }) => createReading(client, { payload: { ...payload, type: 'tank' }, userId }),
};
