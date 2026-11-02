import { Router } from 'express';
import { z } from 'zod';
import { q, qOne } from '../db';
import { ApiError } from '../utils/errors';
import { authenticate, requirePermission } from '../middleware/auth';
import { createRequest, submitRequest, authorizeRequest, rejectRequest, cancelRequest } from '../services/requests';
import { processFuelTransaction, decideExcess, reverseTransaction, adjustStock, receiveBulkFuel } from '../services/fueling';
import { getTankStock, getStockByFuelType } from '../services/ledger';
import { recordAudit } from '../services/audit';
import { withTransaction } from '../db';
import { pool } from '../db';
import { uuidv7 } from '../utils/uuidv7';
import { qsParams, pstr } from '../utils/query';

export const fuelRouter = Router();
fuelRouter.use(authenticate);

/* ---------------- Fuel requests ---------------- */

const REQUEST_SELECT = `
  SELECT fr.*, v.registration_number, v.make AS vehicle_make, v.model AS vehicle_model,
         v.tank_capacity_l, f.name AS fuel_name, p.pump_number,
         ru.full_name AS requested_by_name,
         au.full_name AS authorized_by_name,
         (SELECT COUNT(*)::int FROM fuel_transactions t WHERE t.fuel_request_id = fr.id) AS transaction_count
    FROM fuel_requests fr
    JOIN vehicles v ON v.id = fr.vehicle_id
    JOIN fuel_types f ON f.id = fr.fuel_type_id
    LEFT JOIN fuel_pumps p ON p.id = fr.pump_id
    LEFT JOIN users ru ON ru.id = fr.requested_by
    LEFT JOIN users au ON au.id = fr.authorized_by
`;

fuelRouter.get('/fuel-requests', requirePermission('fuel_requests:read'), async (req, res, next) => {
  try {
    const p = qsParams(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, v: unknown) => {
      params.push(v);
      where.push(clause.replace('?', `$${params.length}`));
    };
    if (p.status) add('fr.status = ?', String(p.status));
    if (p.vehicleId) add('fr.vehicle_id = ?', String(p.vehicleId));
    if (p.fuelTypeId) add('fr.fuel_type_id = ?', String(p.fuelTypeId));
    if (p.from) add('fr.created_at >= ?', String(p.from));
    if (p.to) add('fr.created_at <= ?', `${String(p.to)}T23:59:59+03:00`);
    if (p.search) add('(fr.request_number ILIKE ? OR v.registration_number ILIKE ?)', [`%${p.search}%`, `%${p.search}%`].flat());
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const page = Math.max(1, Number(p.page ?? 1));
    const limit = Math.min(200, Number(p.limit ?? 50));
    const rows = await q(
      `${REQUEST_SELECT} ${w} ORDER BY fr.created_at DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      params
    );
    const total = await qOne(
      `SELECT COUNT(*)::int AS n FROM fuel_requests fr
         JOIN vehicles v ON v.id = fr.vehicle_id ${w}`,
      params
    );
    res.json({ rows, total: total?.n ?? 0, page, limit });
  } catch (err) {
    next(err);
  }
});

fuelRouter.get('/fuel-requests/:id', requirePermission('fuel_requests:read'), async (req, res, next) => {
  try {
    const row = await qOne(`${REQUEST_SELECT} WHERE fr.id = $1`, [(pstr(req.params.id) ?? '')]);
    if (!row) throw new ApiError(404, 'Fuel request not found');
    const approvals = await q(
      `SELECT a.*, u.full_name AS decided_by_name
         FROM fuel_request_approvals a LEFT JOIN users u ON u.id = a.decided_by
        WHERE a.request_id = $1 ORDER BY a.decided_at ASC`,
      [(pstr(req.params.id) ?? '')]
    );
    const transactions = await q(
      `SELECT t.*, p.pump_number FROM fuel_transactions t LEFT JOIN fuel_pumps p ON p.id = t.pump_id
        WHERE t.fuel_request_id = $1 ORDER BY t.created_at ASC`,
      [(pstr(req.params.id) ?? '')]
    );
    res.json({ row, approvals, transactions });
  } catch (err) {
    next(err);
  }
});

fuelRouter.post('/fuel-requests', requirePermission('fuel_requests:create'), async (req, res, next) => {
  try {
    const body = z.object({
      vehicleId: z.string().uuid(),
      fuelTypeId: z.string().uuid().optional(),
      currentOdometer: z.number().min(0),
      requestedLitres: z.number().positive().optional(),
      adjustmentReason: z.string().optional(),
      notes: z.string().optional(),
      submit: z.boolean().default(true),
    }).parse(req.body);
    const out = await createRequest(pool, body, req.user!.id);
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
});

fuelRouter.post('/fuel-requests/:id/submit', requirePermission('fuel_requests:create'), async (req, res, next) => {
  try {
    res.json(await submitRequest(pool, (pstr(req.params.id) ?? ''), req.user!.id));
  } catch (err) {
    next(err);
  }
});

fuelRouter.post('/fuel-requests/:id/authorize', requirePermission('fuel_requests:authorize'), async (req, res, next) => {
  try {
    const body = z.object({
      quantity: z.number().positive(),
      reason: z.string().optional(),
    }).parse(req.body);
    res.json(await authorizeRequest(pool, (pstr(req.params.id) ?? ''), { ...body, byUserId: req.user!.id }));
  } catch (err) {
    next(err);
  }
});

fuelRouter.post('/fuel-requests/:id/reject', requirePermission('fuel_requests:authorize'), async (req, res, next) => {
  try {
    const body = z.object({ reason: z.string().min(3) }).parse(req.body);
    res.json(await rejectRequest(pool, (pstr(req.params.id) ?? ''), { ...body, byUserId: req.user!.id }));
  } catch (err) {
    next(err);
  }
});

fuelRouter.post('/fuel-requests/:id/cancel', requirePermission('fuel_requests:create'), async (req, res, next) => {
  try {
    const body = z.object({ reason: z.string().optional() }).parse(req.body ?? {});
    res.json(await cancelRequest(pool, (pstr(req.params.id) ?? ''), { ...body, byUserId: req.user!.id }));
  } catch (err) {
    next(err);
  }
});

fuelRouter.post('/fuel-requests/:id/excess/approve', requirePermission('fuel_requests:excess'), async (req, res, next) => {
  try {
    const body = z.object({ reason: z.string().min(3) }).parse(req.body);
    res.json(await decideExcess(pool, { requestId: (pstr(req.params.id) ?? ''), approve: true, reason: body.reason, decidedById: req.user!.id }));
  } catch (err) {
    next(err);
  }
});

fuelRouter.post('/fuel-requests/:id/excess/reject', requirePermission('fuel_requests:excess'), async (req, res, next) => {
  try {
    const body = z.object({ reason: z.string().min(3) }).parse(req.body);
    res.json(await decideExcess(pool, { requestId: (pstr(req.params.id) ?? ''), approve: false, reason: body.reason, decidedById: req.user!.id }));
  } catch (err) {
    next(err);
  }
});

/* ---------------- Fuel transactions ---------------- */

const TXN_SELECT = `
  SELECT t.*, v.registration_number, f.name AS fuel_name,
         p.pump_number, t_tank.name AS tank_name,
         u.full_name AS attendant_name,
         fr.request_number
    FROM fuel_transactions t
    JOIN vehicles v ON v.id = t.vehicle_id
    JOIN fuel_types f ON f.id = t.fuel_type_id
    JOIN fuel_pumps p ON p.id = t.pump_id
    JOIN fuel_tanks t_tank ON t_tank.id = t.tank_id
    JOIN users u ON u.id = t.attendant_id
    JOIN fuel_requests fr ON fr.id = t.fuel_request_id
`;

fuelRouter.get('/fuel-transactions', requirePermission('fuel_transactions:read'), async (req, res, next) => {
  try {
    const p = qsParams(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, v: unknown) => {
      params.push(v);
      where.push(clause.replace('?', `$${params.length}`));
    };
    if (p.status) add('t.status = ?', String(p.status));
    if (p.vehicleId) add('t.vehicle_id = ?', String(p.vehicleId));
    if (p.pumpId) add('t.pump_id = ?', String(p.pumpId));
    if (p.attendantId) add('t.attendant_id = ?', String(p.attendantId));
    if (p.fuelTypeId) add('t.fuel_type_id = ?', String(p.fuelTypeId));
    if (p.from) add('t.transaction_date >= ?', String(p.from));
    if (p.to) add('t.transaction_date <= ?', `${String(p.to)}T23:59:59+03:00`);
    if (p.search) add('(t.transaction_number ILIKE ? OR v.registration_number ILIKE ? OR fr.request_number ILIKE ?)', [`%${p.search}%`, `%${p.search}%`, `%${p.search}%`].flat());
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const page = Math.max(1, Number(p.page ?? 1));
    const limit = Math.min(200, Number(p.limit ?? 50));
    const rows = await q(`${TXN_SELECT} ${w} ORDER BY t.transaction_date DESC, t.created_at DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`, params);
    const total = await qOne(`SELECT COUNT(*)::int AS n FROM fuel_transactions t
      JOIN vehicles v ON v.id = t.vehicle_id JOIN fuel_requests fr ON fr.id = t.fuel_request_id ${w}`, params);
    res.json({ rows, total: total?.n ?? 0, page, limit });
  } catch (err) {
    next(err);
  }
});

fuelRouter.get('/fuel-transactions/:id', requirePermission('fuel_transactions:read'), async (req, res, next) => {
  try {
    const row = await qOne(`${TXN_SELECT} WHERE t.id = $1`, [(pstr(req.params.id) ?? '')]);
    if (!row) throw new ApiError(404, 'Transaction not found');
    const ledger = await q(
      `SELECT * FROM fuel_inventory_transactions
        WHERE reference_type = 'FUEL_TRANSACTION' AND reference_id = $1
        ORDER BY created_at ASC`,
      [(pstr(req.params.id) ?? '')]
    );
    const audit = await q(
      `SELECT a.*, u.full_name FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.entity_type = 'FUEL_TRANSACTION' AND (a.entity_id = $1 OR a.entity_id IN
          (SELECT t2.id::text FROM fuel_transactions t2 WHERE t2.is_reversal_of = $2))
        ORDER BY a.created_at DESC LIMIT 50`,
      // NB: two separate params — $1 binds to a TEXT column, $2 to a UUID
      // column; one param cannot satisfy both type contexts.
      [(pstr(req.params.id) ?? ''), (pstr(req.params.id) ?? '')]
    );
    const sync = await q(
      `SELECT id, client_uuid, status, retry_count, last_attempt_at, error_message, server_response, created_at, synced_at
         FROM sync_records WHERE entity_type = 'FUEL_TRANSACTION' AND entity_id = $1::uuid
        ORDER BY created_at DESC LIMIT 10`,
      [(pstr(req.params.id) ?? '')]
    );
    const odometer = await q(
      `SELECT o.*, u.full_name AS recorded_by_name
         FROM vehicle_odometer_history o LEFT JOIN users u ON u.id = o.recorded_by
        WHERE o.vehicle_id = $1 AND o.recorded_at >= $2::timestamptz - INTERVAL '30 days'
        ORDER BY o.recorded_at DESC LIMIT 20`,
      [row.vehicle_id, row.transaction_date]
    );
    const pumpReadings = await q(
      `SELECT id, reading_date, opening_meter, closing_meter, movement
         FROM pump_meter_readings
        WHERE pump_id = $1 AND reading_date::date = $2::date
        ORDER BY reading_date ASC`,
      [row.pump_id, row.transaction_date]
    );
    res.json({ row, ledger, audit, sync, odometer, pumpReadings });
  } catch (err) {
    next(err);
  }
});

/**
 * Server-side fueling entry (manager workstation). Runs the exact same
 * pipeline as the mobile sync push; uses a server-generated UUID so the
 * idempotency guarantees still hold.
 */
fuelRouter.post('/fuel-transactions', requirePermission('fuel_transactions:create'), async (req, res, next) => {
  try {
    const body = z.object({
      requestId: z.string().uuid(),
      pumpId: z.string().uuid(),
      odometer: z.number().min(0),
      pumpStartMeter: z.number().min(0),
      pumpEndMeter: z.number().min(0),
      actualLitres: z.number().positive(),
      excessReason: z.string().optional(),
      unitPrice: z.number().nonnegative().optional(),
      transactionDate: z.string().optional(),
      gpsLat: z.number().optional(),
      gpsLng: z.number().optional(),
      notes: z.string().optional(),
      overrideApplied: z.boolean().default(false),
      overrideReason: z.string().optional(),
    }).parse(req.body);
    if (body.overrideApplied && !req.user!.perms.has('inventory:override_negative')) {
      throw new ApiError(403, 'Negative stock override requires inventory:override_negative', 'MISSING_PERMISSION');
    }
    if (body.overrideApplied && !(body.overrideReason ?? '').trim()) {
      throw new ApiError(400, 'Override reason is required');
    }
    const request = await qOne(
      'SELECT id, vehicle_id, fuel_type_id FROM fuel_requests WHERE id = $1',
      [body.requestId]
    );
    if (!request) throw new ApiError(404, 'Fuel request not found');
    const result = await processFuelTransaction(
      pool,
      {
        requestId: body.requestId,
        vehicleId: String(request.vehicle_id),
        fuelTypeId: String(request.fuel_type_id),
        pumpId: body.pumpId,
        odometer: body.odometer,
        pumpStartMeter: body.pumpStartMeter,
        pumpEndMeter: body.pumpEndMeter,
        actualLitres: body.actualLitres,
        excessReason: body.excessReason,
        unitPrice: body.unitPrice,
        transactionDate: body.transactionDate,
        gpsLat: body.gpsLat ?? null,
        gpsLng: body.gpsLng ?? null,
        notes: body.notes,
        deviceId: null,
        overrideApplied: body.overrideApplied,
        overrideReason: body.overrideReason,
      },
      { attendantId: req.user!.id, txnId: uuidv7() }
    );
    if (!result.ok) {
      throw new ApiError(422, result.message, result.code);
    }
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

fuelRouter.post('/fuel-transactions/:id/reverse', requirePermission('fuel_transactions:correct'), async (req, res, next) => {
  try {
    const body = z.object({ reason: z.string().min(3) }).parse(req.body);
    res.json(await reverseTransaction(pool, { txnId: (pstr(req.params.id) ?? ''), reason: body.reason, byUserId: req.user!.id }));
  } catch (err) {
    next(err);
  }
});

/* ---------------- Bulk purchases ---------------- */

fuelRouter.get('/fuel-purchases', requirePermission('purchases:read'), async (req, res, next) => {
  try {
    const p = qsParams(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, v: unknown) => {
      params.push(v);
      where.push(clause.replace('?', `$${params.length}`));
    };
    if (p.supplierId) add('fp.supplier_id = ?', String(p.supplierId));
    if (p.fuelTypeId) add('fp.fuel_type_id = ?', String(p.fuelTypeId));
    if (p.from) add('fp.purchase_date >= ?', String(p.from));
    if (p.to) add('fp.purchase_date <= ?', `${String(p.to)}T23:59:59+03:00`);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const page = Math.max(1, Number(p.page ?? 1));
    const limit = Math.min(200, Number(p.limit ?? 50));
    const rows = await q(
      `SELECT fp.*, s.name AS supplier_name, f.name AS fuel_name, t.name AS tank_name,
              u.full_name AS received_by_name
         FROM fuel_purchases fp
         JOIN suppliers s ON s.id = fp.supplier_id
         JOIN fuel_types f ON f.id = fp.fuel_type_id
         JOIN fuel_tanks t ON t.id = fp.tank_id
         LEFT JOIN users u ON u.id = fp.received_by
        ${w}
        ORDER BY fp.purchase_date DESC
        LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      params
    );
    const total = await qOne(`SELECT COUNT(*)::int AS n FROM fuel_purchases fp ${w}`, params);
    res.json({ rows, total: total?.n ?? 0, page, limit });
  } catch (err) {
    next(err);
  }
});

fuelRouter.post('/fuel-purchases', requirePermission('purchases:create'), async (req, res, next) => {
  try {
    const body = z.object({
      supplierId: z.string().uuid(),
      fuelTypeId: z.string().uuid(),
      tankId: z.string().uuid(),
      invoiceNumber: z.string().optional(),
      deliveryNumber: z.string().optional(),
      purchaseDate: z.string().optional(),
      orderedQty: z.number().positive(),
      receivedQty: z.number().min(0),
      unitCost: z.number().nonnegative(),
      notes: z.string().optional(),
    }).parse(req.body);
    const out = await receiveBulkFuel(pool, { ...body, byUserId: req.user!.id });
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
});

/* ---------------- Inventory ---------------- */

fuelRouter.get('/inventory', requirePermission('inventory:read'), async (_req, res, next) => {
  try {
    const tanks = await q(
      `SELECT t.id, t.code, t.name, t.capacity_l, t.location, t.status,
              f.id AS fuel_type_id, f.name AS fuel_name,
              COALESCE(s.quantity_l, 0) AS system_qty,
              COALESCE(s.avg_unit_cost, 0) AS avg_unit_cost,
              ROUND(COALESCE(s.quantity_l,0) * 100.0 / t.capacity_l, 1) AS fill_pct
         FROM fuel_tanks t
         JOIN fuel_types f ON f.id = t.fuel_type_id
         LEFT JOIN tank_stock s ON s.tank_id = t.id
        ORDER BY f.name, t.code`
    );
    const byFuel = await getStockByFuelType(pool);
    res.json({ tanks, byFuel });
  } catch (err) {
    next(err);
  }
});

fuelRouter.get('/inventory/tanks/:id', requirePermission('inventory:read'), async (req, res, next) => {
  try {
    const stock = await getTankStock(pool, (pstr(req.params.id) ?? ''));
    if (!stock) throw new ApiError(404, 'Tank not found');
    res.json({ stock });
  } catch (err) {
    next(err);
  }
});

fuelRouter.post('/inventory/adjustments', requirePermission('inventory:adjust'), async (req, res, next) => {
  try {
    const body = z.object({
      tankId: z.string().uuid(),
      direction: z.enum(['IN', 'OUT']),
      qty: z.number().positive(),
      reason: z.string().min(3),
      overrideApplied: z.boolean().default(false),
      overrideReason: z.string().optional(),
    }).parse(req.body);
    if (body.overrideApplied && !req.user!.perms.has('inventory:override_negative')) {
      throw new ApiError(403, 'Negative stock override requires inventory:override_negative', 'MISSING_PERMISSION');
    }
    const out = await adjustStock(pool, { ...body, byUserId: req.user!.id });
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
});

fuelRouter.get('/inventory/adjustments', requirePermission('inventory:read'), async (req, res, next) => {
  try {
    const p = qsParams(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, v: unknown) => {
      params.push(v);
      where.push(clause.replace('?', `$${params.length}`));
    };
    if (p.from) add('fit.transaction_date >= ?', String(p.from));
    if (p.to) add('fit.transaction_date <= ?', `${String(p.to)}T23:59:59+03:00`);
    if (p.tankId) add('fit.tank_id = ?', String(p.tankId));
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await q(
      `SELECT fit.*, u.full_name AS user_name, t.name AS tank_name, f.name AS fuel_name
         FROM fuel_inventory_transactions fit
         JOIN users u ON u.id = fit.created_by
         JOIN fuel_tanks t ON t.id = fit.tank_id
         JOIN fuel_types f ON f.id = fit.fuel_type_id
        ${w}
        AND fit.transaction_type IN ('ADJUSTMENT_IN','ADJUSTMENT_OUT')
        ORDER BY fit.transaction_date DESC
        LIMIT ${Math.min(200, Number(p.limit ?? 50))}`,
      params
    );
    res.json({ rows });
  } catch (err) {
    next(err);
  }
});
