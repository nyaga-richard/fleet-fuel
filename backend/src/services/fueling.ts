import { PoolClient } from 'pg';
import type { Db } from '../db';
import { qOne } from '../db';
import { ApiError } from '../utils/errors';
import { nextDocNumber } from '../utils/doc';
import { uuidv7 } from '../utils/uuidv7';
import { postInventoryMovement, round2, round3 } from './ledger';
import { createException } from './exceptions';
import { notify, notifyManagers } from './notifications';
import { recordAudit } from './audit';
import { getSettingsTx } from './settings';

export interface FuelingPayload {
  requestId: string;
  vehicleId: string;
  fuelTypeId: string;
  pumpId: string;
  odometer: number;
  pumpStartMeter: number;
  pumpEndMeter: number;
  actualLitres: number;
  excessReason?: string;
  unitPrice?: number;
  transactionDate?: string;
  startTime?: string;
  endTime?: string;
  gpsLat?: number | null;
  gpsLng?: number | null;
  selfieRef?: string;
  deviceId?: string | null;
  notes?: string;
  overrideApplied?: boolean;
  overrideReason?: string;
}

export type FuelingResult =
  | {
      ok: true;
      txnId: string;
      transactionNumber: string;
      status: 'COMPLETED' | 'EXCESS_PENDING';
      issuedLitres: number;
      excessLitres: number;
      unitCost: number;
      totalCost: number;
      distanceKm: number;
      authorizationVersion: number;
    }
  | {
      ok: false;
      code:
        | 'ODOMETER_ROLLBACK'
        | 'NEGATIVE_STOCK'
        | 'TANK_OVERFILL'
        | 'REQUEST_NOT_FUELABLE'
        | 'PUMP_METER_INVALID'
        | 'FUEL_TYPE_MISMATCH'
        | 'DUPLICATE_TRANSACTION'
        | 'UNKNOWN_ERROR';
      message: string;
    };

/**
 * The authoritative fueling pipeline. Runs server-side for BOTH the
 * offline-mobile sync push and the server-side (manager) entry point.
 * A client-generated transaction id (UUID) makes the whole operation
 * idempotent: re-pushing the same record can never double-issue fuel.
 */
export async function processFuelTransaction(
  db: Db,
  payload: FuelingPayload,
  opts: { attendantId: string; txnId: string }
): Promise<FuelingResult> {
  const settings = await getSettingsTx(db);

  // ---- Precondition checks (read-only, before any writes) ----
  const request = (await qOne(
    `SELECT fr.*, v.registration_number AS vehicle_reg
       FROM fuel_requests fr JOIN vehicles v ON v.id = fr.vehicle_id
      WHERE fr.id = $1`,
    [payload.requestId]
  )) as Record<string, unknown> | undefined;
  if (!request) return { ok: false, code: 'REQUEST_NOT_FUELABLE', message: 'Fuel request not found' };

  const fuelable = ['AUTHORIZED', 'IN_PROGRESS'];
  if (!fuelable.includes(request.status as string)) {
    return {
      ok: false,
      code: 'REQUEST_NOT_FUELABLE',
      message: `Request is ${request.status}; only AUTHORIZED/IN_PROGRESS requests can be fueled`,
    };
  }

  const vehicle = (await qOne('SELECT * FROM vehicles WHERE id = $1', [payload.vehicleId])) as Record<string, unknown> | undefined;
  const pump = (await qOne('SELECT * FROM fuel_pumps WHERE id = $1', [payload.pumpId])) as Record<string, unknown> | undefined;
  if (!vehicle || !pump) return { ok: false, code: 'UNKNOWN_ERROR', message: 'Vehicle or pump not found' };

  const tankId = pump.tank_id as string;
  const tank = (await qOne('SELECT * FROM fuel_tanks WHERE id = $1', [tankId])) as Record<string, unknown> | undefined;
  const fuel = (await qOne('SELECT * FROM fuel_types WHERE id = $1', [payload.fuelTypeId])) as Record<string, unknown> | undefined;
  if (!tank || !fuel) return { ok: false, code: 'UNKNOWN_ERROR', message: 'Tank or fuel type not found' };

  if (vehicle.fuel_type_id !== payload.fuelTypeId || pump.fuel_type_id !== payload.fuelTypeId) {
    return { ok: false, code: 'FUEL_TYPE_MISMATCH', message: 'Fuel type does not match vehicle/pump configuration' };
  }

  // Odometer rollback prevention
  const prevOdometer = Number(vehicle.current_odometer);
  const newOdometer = round3(payload.odometer);
  if (newOdometer < prevOdometer) {
    await createException(db, {
      type: 'ODOMETER_ROLLBACK',
      severity: 'HIGH',
      description: `Odometer rollback attempt on ${vehicle.registration_number}: ${newOdometer} < previous ${prevOdometer}`,
      entityType: 'FUEL_REQUEST',
      entityId: payload.requestId,
      vehicleId: payload.vehicleId,
      userId: opts.attendantId,
      details: { newOdometer, prevOdometer, pumpId: payload.pumpId },
    });
    return { ok: false, code: 'ODOMETER_ROLLBACK', message: `Odometer ${newOdometer} is below previous ${prevOdometer}; transaction rejected` };
  }

  if (payload.pumpEndMeter < payload.pumpStartMeter) {
    return { ok: false, code: 'PUMP_METER_INVALID', message: 'Pump closing meter cannot be below opening meter' };
  }
  if (payload.actualLitres <= 0) {
    return { ok: false, code: 'UNKNOWN_ERROR', message: 'Actual litres must be positive' };
  }

  const distanceKm = round3(newOdometer - prevOdometer);
  const authorized = Number(request.authorized_litres);
  const tolerance = settings.excess_tolerance_l;
  const excess = round3(Math.max(0, payload.actualLitres - authorized));
  const isExcess = excess > tolerance;
  const issuedLitres = isExcess ? authorized : round3(payload.actualLitres);

  // ---- Main transaction ----
  try {
    const r = await withClient(db, async (c) => {
      // Serialize on the request row
      const locked = await c.query(
        `SELECT * FROM fuel_requests WHERE id = $1 FOR UPDATE`,
        [payload.requestId]
      );
      const req = locked.rows[0];
      if (!fuelable.includes(req.status)) {
        throw Object.assign(new Error('REQUEST_NOT_FUELABLE'), { code: 'REQUEST_NOT_FUELABLE' });
      }

      const actual = round3(payload.actualLitres);
      const issueQty = isExcess ? authorized : actual;

      // Latest sale price for the fuel type (falls back to payload/0)
      const priceRow = await c.query(
        `SELECT unit_cost FROM fuel_price_history
          WHERE fuel_type_id = $1
            AND effective_from <= now()
            AND (effective_to IS NULL OR effective_to > now())
          ORDER BY effective_from DESC LIMIT 1`,
        [payload.fuelTypeId]
      );
      const unitPrice = round2(payload.unitPrice ?? Number(priceRow.rows[0]?.unit_cost ?? 0));

      // Idempotency: same client id already processed
      const dup = await c.query('SELECT id FROM fuel_transactions WHERE id = $1', [opts.txnId]);
      if (dup.rows.length > 0) {
        throw Object.assign(new Error('DUPLICATE_TRANSACTION'), { code: 'DUPLICATE_TRANSACTION' });
      }

      const transactionNumber = await nextDocNumber(c, 'FT');

      // Post inventory issue (weighted average cost). Throws NEGATIVE_STOCK / TANK_OVERFILL when blocked.
      const movement = await postInventoryMovement(c, {
        transactionDate: payload.transactionDate ? new Date(payload.transactionDate) : undefined,
        fuelTypeId: payload.fuelTypeId,
        tankId,
        type: 'FUEL_ISSUE',
        referenceType: 'FUEL_TRANSACTION',
        referenceId: opts.txnId,
        referenceNumber: transactionNumber,
        vehicleId: payload.vehicleId,
        particulars: `Fueling ${vehicle.registration_number}${isExcess ? ' (authorized portion; excess pending approval)' : ''}`,
        qtyOut: issueQty,
        overrideApplied: Boolean(payload.overrideApplied),
        overrideReason: payload.overrideReason,
        createdBy: opts.attendantId,
      });

      const totalCost = round2(actual * unitPrice);
      const txnStatus: 'COMPLETED' | 'EXCESS_PENDING' = isExcess ? 'EXCESS_PENDING' : 'COMPLETED';

      await c.query(
        `INSERT INTO fuel_transactions (
           id, transaction_number, fuel_request_id, vehicle_id, fuel_type_id, pump_id, tank_id,
           attendant_id, device_id, odometer, previous_odometer, distance_km,
           authorized_litres, actual_litres, excess_litres, excess_status, excess_reason,
           pump_start_meter, pump_end_meter, pump_movement, unit_price, unit_cost, total_cost,
           transaction_date, start_time, end_time, gps_lat, gps_lng, selfie_ref, status, notes
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31
         )`,
        [
          opts.txnId, transactionNumber, payload.requestId, payload.vehicleId, payload.fuelTypeId,
          payload.pumpId, tankId, opts.attendantId, payload.deviceId ?? null,
          newOdometer, prevOdometer, distanceKm,
          authorized, actual, round3(excess), isExcess ? 'PENDING' : 'NONE',
          payload.excessReason ?? null,
          payload.pumpStartMeter, payload.pumpEndMeter, round3(payload.pumpEndMeter - payload.pumpStartMeter),
          unitPrice, movement.unitCost, totalCost,
          payload.transactionDate ? new Date(payload.transactionDate) : new Date(),
          payload.startTime ? new Date(payload.startTime) : null,
          payload.endTime ? new Date(payload.endTime) : null,
          payload.gpsLat ?? null, payload.gpsLng ?? null, payload.selfieRef ?? null,
          txnStatus, payload.notes ?? null,
        ]
      );

      // Odometer history (immutable) + vehicle state
      await c.query(
        `INSERT INTO vehicle_odometer_history
           (vehicle_id, odometer, recorded_by, source, reference_type, reference_id)
         VALUES ($1, $2, $3, 'FUEL_TRANSACTION', 'FUEL_TRANSACTION', $4)`,
        [payload.vehicleId, newOdometer, opts.attendantId, opts.txnId]
      );
      await c.query(
        `UPDATE vehicles SET current_odometer = $1, updated_at = now() WHERE id = $2`,
        [newOdometer, payload.vehicleId]
      );

      // Pump meter advances
      await c.query(
        `UPDATE fuel_pumps SET current_meter = $1, updated_at = now() WHERE id = $2`,
        [payload.pumpEndMeter, payload.pumpId]
      );

      // Request status
      const reqStatus = isExcess ? 'EXCESS_APPROVAL_REQUIRED' : 'COMPLETED';
      await c.query(
        `UPDATE fuel_requests
            SET status = $1, pump_id = $2, excess_pending_litres = $3,
                gps_lat = $4, gps_lng = $5, updated_at = now()
          WHERE id = $6`,
        [reqStatus, payload.pumpId, round3(excess), payload.gpsLat ?? null, payload.gpsLng ?? null, payload.requestId]
      );

      // ---- Automatic exception detection ----
      const pumpMovement = round3(payload.pumpEndMeter - payload.pumpStartMeter);
      if (Math.abs(pumpMovement - actual) > settings.pump_variance_threshold_l) {
        await createException(c, {
          type: 'PUMP_VARIANCE',
          severity: 'MEDIUM',
          description: `Pump ${pump.pump_number} movement ${pumpMovement}L differs from recorded ${actual}L by ${round3(Math.abs(pumpMovement - actual))}L`,
          entityType: 'FUEL_TRANSACTION',
          entityId: opts.txnId,
          vehicleId: payload.vehicleId,
          userId: opts.attendantId,
          details: { pumpMovement, recorded: actual, pumpId: payload.pumpId },
        });
      }
      if (actual > Number(vehicle.tank_capacity_l)) {
        await createException(c, {
          type: 'FUEL_OVER_TANK_CAPACITY',
          severity: 'HIGH',
          description: `${vehicle.registration_number}: ${actual}L dispensed exceeds tank capacity ${vehicle.tank_capacity_l}L`,
          entityType: 'FUEL_TRANSACTION',
          entityId: opts.txnId,
          vehicleId: payload.vehicleId,
          details: { actual, capacity: Number(vehicle.tank_capacity_l) },
        });
      }
      if (distanceKm > 0 && actual > 0) {
        const expected = Number(vehicle.expected_km_per_l);
        const kmpl = distanceKm / actual;
        const variancePct = expected > 0 ? ((expected - kmpl) / expected) * 100 : 0;
        if (variancePct > settings.abnormal_consumption_variance_pct) {
          await createException(c, {
            type: 'ABNORMAL_CONSUMPTION',
            severity: 'LOW',
            description: `${vehicle.registration_number}: KM/L ${kmpl.toFixed(2)} is ${variancePct.toFixed(0)}% worse than expected ${expected}`,
            entityType: 'FUEL_TRANSACTION',
            entityId: opts.txnId,
            vehicleId: payload.vehicleId,
            details: { kmpl, expected, distanceKm, actual },
          });
        }
      }
      const recent = await c.query(
        `SELECT COUNT(*)::int AS n FROM fuel_transactions
          WHERE vehicle_id = $1 AND transaction_date >= now() - make_interval(hours => $2)
            AND status IN ('COMPLETED','EXCESS_PENDING')`,
        [payload.vehicleId, settings.frequent_fueling_window_hours]
      );
      if (recent.rows[0].n > settings.frequent_fueling_max) {
        await createException(c, {
          type: 'FREQUENT_FUELING',
          severity: 'LOW',
          description: `${vehicle.registration_number} fueled ${recent.rows[0].n} times within ${settings.frequent_fueling_window_hours}h (limit ${settings.frequent_fueling_max})`,
          entityType: 'FUEL_TRANSACTION',
          entityId: opts.txnId,
          vehicleId: payload.vehicleId,
        });
      }
      if (movement.newStockQty < settings.low_stock_threshold_l) {
        await createException(c, {
          type: 'LOW_STOCK',
          severity: 'MEDIUM',
          description: `Tank ${tank.name} below low-stock threshold: ${movement.newStockQty}L (< ${settings.low_stock_threshold_l}L)`,
          entityType: 'TANK',
          entityId: tankId,
          details: { stock: movement.newStockQty, threshold: settings.low_stock_threshold_l },
        });
        await notifyManagers(c, {
          type: 'LOW_STOCK',
          title: `Low stock: ${tank.name}`,
          body: `Current ${fuel.name} stock is ${movement.newStockQty}L.`,
          data: { tankId },
        });
      }

      if (isExcess) {
        await createException(c, {
          type: 'EXCESS_FUEL',
          severity: 'HIGH',
          description: `Excess fuel ${round3(excess)}L on ${vehicle.registration_number} (authorized ${authorized}L, actual ${actual}L) — manager approval required`,
          entityType: 'FUEL_REQUEST',
          entityId: payload.requestId,
          vehicleId: payload.vehicleId,
          userId: opts.attendantId,
          details: { excess, authorized, actual, reason: payload.excessReason ?? null },
        });
        await notifyManagers(c, {
          type: 'EXCESS_APPROVAL_REQUIRED',
          title: `Excess fuel approval required: ${vehicle.registration_number}`,
          body: `${round3(excess)}L above authorization (${authorized}L). Request ${request.request_number}.`,
          data: { requestId: payload.requestId, txnId: opts.txnId },
        });
      }

      await recordAudit(c, {
        userId: opts.attendantId,
        action: isExcess ? 'FUEL_DISPENSED_EXCESS_PENDING' : 'FUEL_DISPENSED',
        entityType: 'FUEL_TRANSACTION',
        entityId: opts.txnId,
        newValue: {
          transactionNumber, vehicle: vehicle.registration_number, actual, issued: issueQty,
          odometer: newOdometer, pump: pump.pump_number,
          pumpStart: payload.pumpStartMeter, pumpEnd: payload.pumpEndMeter,
          unitPrice, unitCost: movement.unitCost, totalCost,
        },
        deviceId: payload.deviceId ?? null,
      });

      const res = await c.query<{ user_id: string }>(
        `SELECT u.id AS user_id FROM fuel_transactions t JOIN users u ON u.id = t.attendant_id WHERE t.id = $1`,
        [opts.txnId]
      );
      const attendantUserId = res.rows[0]?.user_id;
      if (isExcess) {
        await notify(c, {
          userId: attendantUserId,
          type: 'EXCESS_APPROVAL_REQUIRED',
          title: `Excess fuel recorded on ${vehicle.registration_number}`,
          body: `${round3(excess)}L above authorized quantity. It remains PENDING until the manager decides.`,
          data: { txnId: opts.txnId, requestId: payload.requestId },
        });
      } else {
        await notify(c, {
          userId: attendantUserId,
          type: 'FUELING_COMPLETED',
          title: `Fueling completed: ${vehicle.registration_number}`,
          body: `${actual}L dispensed from ${pump.pump_number}.`,
          data: { txnId: opts.txnId },
        });
      }

      return {
        txnId: opts.txnId,
        transactionNumber,
        status: txnStatus,
        issuedLitres: issueQty,
        excessLitres: round3(excess),
        unitCost: movement.unitCost,
        totalCost,
        distanceKm,
        authorizationVersion: Number(req.authorization_version),
      };
    });
    return { ok: true, ...r };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e.code === 'NEGATIVE_STOCK' || /NEGATIVE_STOCK_PREVENTED/.test(e.message ?? '')) {
      await createException(db, {
        type: 'NEGATIVE_STOCK',
        severity: 'HIGH',
        description: `Blocked fuel issue of ${issuedLitres}L on ${vehicle.registration_number}: insufficient stock in tank ${tank.name}`,
        entityType: 'FUEL_REQUEST',
        entityId: payload.requestId,
        vehicleId: payload.vehicleId,
        userId: opts.attendantId,
        details: { requested: issuedLitres, message: e.message ?? '' },
      });
      return { ok: false, code: 'NEGATIVE_STOCK', message: e.message ?? 'Negative stock prevented' };
    }
    if (e.code === 'TANK_OVERFILL' || /TANK_OVERFILL_PREVENTED/.test(e.message ?? '')) {
      return { ok: false, code: 'TANK_OVERFILL', message: e.message ?? 'Tank overfill prevented' };
    }
    if (e.code === 'DUPLICATE_TRANSACTION') {
      return { ok: false, code: 'DUPLICATE_TRANSACTION', message: 'Transaction already processed (idempotent duplicate)' };
    }
    if (e.code === 'REQUEST_NOT_FUELABLE') {
      return { ok: false, code: 'REQUEST_NOT_FUELABLE', message: e.message ?? 'Request not fuelable' };
    }
    throw err;
  }
}

/**
 * Run fn in a transaction. The shared Pool opens a fresh client/transaction;
 * an already-open PoolClient (sync batch) uses a SAVEPOINT so one failed
 * record cannot abort the surrounding sync batch.
 */
async function withClient<T>(db: Db, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  if (typeof (db as PoolClient).release === 'function') {
    const client = db as PoolClient;
    const spName = `sp_${Math.random().toString(36).slice(2, 10)}`;
    await client.query(`SAVEPOINT ${spName}`);
    try {
      const out = await fn(client);
      await client.query(`RELEASE SAVEPOINT ${spName}`);
      return out;
    } catch (err) {
      await client.query(`ROLLBACK TO SAVEPOINT ${spName}`);
      throw err;
    }
  }
  const client = await (db as unknown as { connect(): Promise<PoolClient> }).connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/* =====================================================================
 * EXCESS FUEL DECISION (manager only)
 * ===================================================================== */

export async function decideExcess(
  db: Db,
  input: { requestId: string; approve: boolean; reason: string; decidedById: string }
) {
  return withClient(db, async (c) => {
    const locked = await c.query('SELECT * FROM fuel_requests WHERE id = $1 FOR UPDATE', [input.requestId]);
    const req = locked.rows[0];
    if (!req) throw new ApiError(404, 'Fuel request not found');
    if (req.status !== 'EXCESS_APPROVAL_REQUIRED') {
      throw new ApiError(409, `Request is ${req.status}, not EXCESS_APPROVAL_REQUIRED`);
    }
    const excess = round3(Number(req.excess_pending_litres));
    if (excess <= 0) throw new ApiError(400, 'No excess pending on this request');

    const txnRow = (await c.query(
      `SELECT * FROM fuel_transactions WHERE fuel_request_id = $1 AND status = 'EXCESS_PENDING' ORDER BY created_at DESC LIMIT 1`,
      [req.id]
    )).rows[0];
    if (!txnRow) throw new ApiError(409, 'No EXCESS_PENDING transaction found for this request');

    const vehicleRow = (await c.query('SELECT registration_number, fuel_type_id FROM vehicles WHERE id = $1', [txnRow.vehicle_id])).rows[0];

    if (input.approve) {
      await postInventoryMovement(c, {
        fuelTypeId: txnRow.fuel_type_id,
        tankId: txnRow.tank_id,
        type: 'FUEL_ISSUE',
        referenceType: 'FUEL_TRANSACTION',
        referenceId: txnRow.id,
        referenceNumber: txnRow.transaction_number,
        vehicleId: txnRow.vehicle_id,
        particulars: `Excess fuel approved — ${vehicleRow.registration_number} (${input.reason})`,
        qtyOut: excess,
        createdBy: input.decidedById,
      });
      await c.query(
        `UPDATE fuel_transactions SET excess_status = 'APPROVED', status = 'COMPLETED', excess_reason = $1, updated_at = now() WHERE id = $2`,
        [input.reason, txnRow.id]
      );
    } else {
      // The excess litres were NEVER issued to inventory (only the authorized
      // quantity was posted at fueling time), so rejecting them requires no
      // inventory movement: the driver physically returns the fuel to the tank,
      // and the books already reflect that state.
      await c.query(
        `UPDATE fuel_transactions SET excess_status = 'REJECTED', status = 'COMPLETED', excess_reason = $1, updated_at = now() WHERE id = $2`,
        [input.reason, txnRow.id]
      );
    }

    await c.query(
      `UPDATE fuel_requests SET status = 'COMPLETED', excess_pending_litres = 0, updated_at = now() WHERE id = $1`,
      [req.id]
    );
    await c.query(
      `INSERT INTO fuel_request_approvals
         (request_id, action, excess_litres, reason, decided_by, authorization_version)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [req.id, input.approve ? 'EXCESS_APPROVED' : 'EXCESS_REJECTED', excess, input.reason, input.decidedById, req.authorization_version]
    );
    await recordAudit(c, {
      userId: input.decidedById,
      action: input.approve ? 'EXCESS_FUEL_APPROVED' : 'EXCESS_FUEL_REJECTED',
      entityType: 'FUEL_REQUEST',
      entityId: req.id,
      newValue: { approve: input.approve, excess, reason: input.reason },
    });
    await notify(c, {
      userId: txnRow.attendant_id,
      type: input.approve ? 'EXCESS_APPROVED' : 'EXCESS_REJECTED',
      title: `Excess fuel ${input.approve ? 'approved' : 'rejected'}: ${vehicleRow.registration_number}`,
      body: `${excess}L — ${input.reason}`,
      data: { requestId: req.id, txnId: txnRow.id },
    });

    return {
      requestId: req.id,
      requestNumber: req.request_number,
      approved: input.approve,
      excessLitres: excess,
      transactionId: txnRow.id,
    };
  });
}

/* =====================================================================
 * REVERSAL (corrections — completed transactions are never deleted)
 * ===================================================================== */

export async function reverseTransaction(
  db: Db,
  input: { txnId: string; reason: string; byUserId: string; deviceId?: string }
) {
  return withClient(db, async (c) => {
    const locked = (await c.query('SELECT * FROM fuel_transactions WHERE id = $1 FOR UPDATE', [input.txnId])).rows[0];
    if (!locked) throw new ApiError(404, 'Transaction not found');
    if (locked.is_reversal_of) throw new ApiError(409, 'Reversals cannot be reversed');
    if (!['COMPLETED', 'EXCESS_PENDING'].includes(locked.status)) {
      throw new ApiError(409, `Transaction is ${locked.status}; only COMPLETED transactions can be reversed`);
    }

    const origLedger = (
      await c.query(
        `SELECT * FROM fuel_inventory_transactions
          WHERE reference_type = 'FUEL_TRANSACTION' AND reference_id = $1
          ORDER BY created_at DESC LIMIT 1`,
        [locked.id]
      )
    ).rows[0];

    const wasIssue = locked.status === 'COMPLETED' || origLedger?.quantity_out > 0;
    const qty = wasIssue ? Number(origLedger?.quantity_out ?? 0) : Number(origLedger?.quantity_in ?? 0);
    if (qty > 0 && origLedger) {
      const mv = wasIssue
        ? await postInventoryMovement(c, {
            fuelTypeId: locked.fuel_type_id,
            tankId: locked.tank_id,
            type: 'REVERSAL',
            referenceType: 'FUEL_TRANSACTION',
            referenceId: locked.id,
            referenceNumber: locked.transaction_number,
            vehicleId: locked.vehicle_id,
            particulars: `Reversal of ${locked.transaction_number} — ${input.reason}`,
            qtyIn: qty,
            unitCostIn: Number(origLedger.unit_cost),
            createdBy: input.byUserId,
          })
        : await postInventoryMovement(c, {
            fuelTypeId: locked.fuel_type_id,
            tankId: locked.tank_id,
            type: 'REVERSAL',
            referenceType: 'FUEL_TRANSACTION',
            referenceId: locked.id,
            referenceNumber: locked.transaction_number,
            vehicleId: locked.vehicle_id,
            particulars: `Reversal of ${locked.transaction_number} — ${input.reason}`,
            qtyOut: qty,
            unitCostOut: Number(origLedger.unit_cost),
            createdBy: input.byUserId,
          });
    }

    const newTxnId = uuidv7();
    const transactionNumber = await nextDocNumber(c, 'FT');
    await c.query(
      `INSERT INTO fuel_transactions (
         id, transaction_number, fuel_request_id, vehicle_id, fuel_type_id, pump_id, tank_id,
         attendant_id, device_id, odometer, previous_odometer, distance_km,
         authorized_litres, actual_litres, excess_litres, excess_status,
         pump_start_meter, pump_end_meter, pump_movement, unit_price, unit_cost, total_cost,
         transaction_date, status, is_reversal_of, reversal_reason
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26
       )`,
      [
        newTxnId, transactionNumber, locked.fuel_request_id, locked.vehicle_id, locked.fuel_type_id,
        locked.pump_id, locked.tank_id, input.byUserId, input.deviceId ?? null,
        locked.odometer, locked.odometer, 0,
        locked.authorized_litres, locked.actual_litres, 0, 'NONE',
        locked.pump_end_meter, locked.pump_end_meter, 0,
        locked.unit_price, Number(origLedger?.unit_cost ?? 0), -Number(locked.total_cost),
        new Date(), 'REVERSED', locked.id, input.reason,
      ]
    );
    await c.query(
      `UPDATE fuel_transactions SET status = 'REVERSED', reversal_reason = $1, updated_at = now() WHERE id = $2`,
      [input.reason, locked.id]
    );
    // If the reversed fueling was awaiting excess approval, the excess litres
    // never reached inventory and the decision no longer applies: return the
    // request to AUTHORIZED (it can be re-fueled) instead of leaving it
    // stuck in EXCESS_APPROVAL_REQUIRED with no transaction to decide on.
    if (locked.status === 'EXCESS_PENDING') {
      await c.query(
        `UPDATE fuel_requests
            SET status = 'AUTHORIZED', excess_pending_litres = 0, updated_at = now()
          WHERE id = $1 AND status = 'EXCESS_APPROVAL_REQUIRED'`,
        [locked.fuel_request_id]
      );
    }
    await recordAudit(c, {
      userId: input.byUserId,
      action: 'TRANSACTION_REVERSED',
      entityType: 'FUEL_TRANSACTION',
      entityId: newTxnId,
      newValue: { reversedTxn: locked.id, reversedNumber: locked.transaction_number, reason: input.reason },
    });
    await notifyManagers(c, {
      type: 'TRANSACTION_REVERSED',
      title: `Transaction reversed: ${locked.transaction_number}`,
      body: input.reason,
      data: { txnId: newTxnId },
    });
    return { txnId: newTxnId, transactionNumber, reversedTxnId: locked.id };
  });
}

/* =====================================================================
 * STOCK ADJUSTMENTS
 * ===================================================================== */

export async function adjustStock(
  db: Db,
  input: {
    tankId: string;
    direction: 'IN' | 'OUT';
    qty: number;
    reason: string;
    byUserId: string;
    overrideApplied?: boolean;
    overrideReason?: string;
  }
) {
  return withClient(db, async (c) => {
    const tank = (await c.query('SELECT t.*, f.name AS fuel_name FROM fuel_tanks t JOIN fuel_types f ON f.id = t.fuel_type_id WHERE t.id = $1', [input.tankId])).rows[0];
    if (!tank) throw new ApiError(404, 'Tank not found');
    const qty = round3(input.qty);
    if (qty <= 0) throw new ApiError(400, 'Adjustment quantity must be positive');
    try {
      const mv = await postInventoryMovement(c, {
        fuelTypeId: tank.fuel_type_id,
        tankId: tank.id,
        type: input.direction === 'IN' ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT',
        referenceType: 'INVENTORY_ADJUSTMENT',
        particulars: `Stock adjustment ${input.direction === 'IN' ? 'in' : 'out'} — ${tank.name}: ${input.reason}`,
        qtyIn: input.direction === 'IN' ? qty : 0,
        qtyOut: input.direction === 'OUT' ? qty : 0,
        overrideApplied: input.overrideApplied,
        overrideReason: input.overrideReason,
        createdBy: input.byUserId,
      });
      await recordAudit(c, {
        userId: input.byUserId,
        action: 'INVENTORY_ADJUSTMENT',
        entityType: 'TANK',
        entityId: tank.id,
        newValue: { direction: input.direction, qty, reason: input.reason, ledgerNo: mv.ledgerNo },
      });
      return { ledgerId: mv.ledgerId, ledgerNo: mv.ledgerNo, runningBalance: mv.runningBalance };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e.code === 'NEGATIVE_STOCK') {
        await createException(c, {
          type: 'NEGATIVE_STOCK',
          severity: 'HIGH',
          description: `Blocked adjustment OUT of ${qty}L from ${tank.name}: insufficient stock`,
          entityType: 'TANK',
          entityId: tank.id,
          userId: input.byUserId,
          details: { message: e.message ?? '' },
        });
      }
      throw err;
    }
  });
}

/* =====================================================================
 * BULK FUEL RECEIVING
 * ===================================================================== */

export async function receiveBulkFuel(
  db: Db,
  input: {
    supplierId: string;
    fuelTypeId: string;
    tankId: string;
    invoiceNumber?: string;
    deliveryNumber?: string;
    purchaseDate?: string;
    orderedQty: number;
    receivedQty: number;
    unitCost: number;
    notes?: string;
    byUserId: string;
    deviceId?: string;
  }
) {
  return withClient(db, async (c) => {
    const settings = await getSettingsTx(c);
    const [tankRow, supplierRow, fuelRow] = (
      await Promise.all([
        c.query('SELECT t.id, t.name, t.capacity_l, f.name AS fuel_name FROM fuel_tanks t JOIN fuel_types f ON f.id = t.fuel_type_id WHERE t.id = $1', [input.tankId]),
        c.query('SELECT name FROM suppliers WHERE id = $1', [input.supplierId]),
        c.query('SELECT name FROM fuel_types WHERE id = $1', [input.fuelTypeId]),
      ])
    ).map((r) => r.rows[0]);
    if (!tankRow || !supplierRow || !fuelRow) throw new ApiError(404, 'Tank, supplier or fuel type not found');
    if (tankRow.fuel_name !== fuelRow.name) throw new ApiError(400, 'Fuel type does not match tank', 'FUEL_TYPE_MISMATCH');

    const ordered = round3(input.orderedQty);
    const received = round3(input.receivedQty);
    const shortage = round3(Math.max(0, ordered - received));
    const totalCost = round2(received * input.unitCost);

    const referenceNumber = await nextDocNumber(c, 'GRN');
    const purchaseId = uuidv7();
    const purchaseDate = input.purchaseDate ? new Date(input.purchaseDate) : new Date();

    await c.query(
      `INSERT INTO fuel_purchases (
         id, reference_number, supplier_id, fuel_type_id, tank_id, invoice_number, delivery_number,
         purchase_date, ordered_qty, received_qty, shortage_qty, unit_cost, total_cost,
         received_by, status, notes
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'RECEIVED',$15)`,
      [
        purchaseId, referenceNumber, input.supplierId, input.fuelTypeId, input.tankId,
        input.invoiceNumber ?? null, input.deliveryNumber ?? null, purchaseDate,
        ordered, received, shortage, input.unitCost, totalCost, input.byUserId, input.notes ?? null,
      ]
    );

    const mv = await postInventoryMovement(c, {
      transactionDate: purchaseDate,
      fuelTypeId: input.fuelTypeId,
      tankId: input.tankId,
      type: 'BULK_RECEIPT',
      referenceType: 'FUEL_PURCHASE',
      referenceId: purchaseId,
      referenceNumber,
      particulars: `Bulk ${fuelRow.name} receipt — ${supplierRow.name} (${referenceNumber})`,
      qtyIn: received,
      unitCostIn: input.unitCost,
      createdBy: input.byUserId,
    });

    if (shortage > settings.bulk_shortage_threshold_l) {
      await createException(c, {
        type: 'BULK_SHORTAGE',
        severity: 'MEDIUM',
        description: `Delivery ${input.deliveryNumber ?? referenceNumber}: ordered ${ordered}L, received ${received}L (shortage ${shortage}L)`,
        entityType: 'FUEL_PURCHASE',
        entityId: purchaseId,
        userId: input.byUserId,
        details: { ordered, received, shortage, invoice: input.invoiceNumber ?? null },
      });
      await notifyManagers(c, {
        type: 'BULK_SHORTAGE',
        title: `Bulk shortage ${shortage}L on ${referenceNumber}`,
        body: `${supplierRow.name} delivered ${received}L of ${ordered}L ordered.`,
        data: { purchaseId },
      });
    }

    if (mv.newStockQty < settings.low_stock_threshold_l) {
      /* already covered by tank reading checks; no-op */
    }

    await recordAudit(c, {
      userId: input.byUserId,
      action: 'BULK_FUEL_RECEIVED',
      entityType: 'FUEL_PURCHASE',
      entityId: purchaseId,
      newValue: { referenceNumber, supplier: supplierRow.name, fuel: fuelRow.name, ordered, received, unitCost: input.unitCost, totalCost },
      deviceId: input.deviceId ?? null,
    });

    return {
      purchaseId,
      referenceNumber,
      ordered,
      received,
      shortage,
      totalCost,
      runningBalance: mv.runningBalance,
      newAvgCost: mv.newAvgCost,
    };
  });
}
