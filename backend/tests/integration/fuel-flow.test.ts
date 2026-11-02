import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, api, login, ensureUsers, createFixture, getStock } from '../helpers';
import { pool, qOne } from '../../src/db';

let api_: Awaited<ReturnType<typeof startApp>>;
let manager: string;
let attendant: string;

async function seedOpening(tankId: string, fuelTypeId: string, qty: number, unitCost: number) {
  const byUserId = (await pool.query('SELECT id FROM users LIMIT 1')).rows[0].id;
  const amount = Math.round(qty * unitCost * 100) / 100;
  await pool.query(
    `INSERT INTO fuel_inventory_transactions
       (id, ledger_no, transaction_date, fuel_type_id, tank_id, transaction_type,
        particulars, quantity_in, quantity_out, unit_cost, amount, running_balance, created_by)
     VALUES (gen_random_uuid(), 'OB-TEST-' || substr(md5(random()::text), 1, 8), now(), $1, $2,
             'OPENING_BALANCE', 'Opening (test)', $3, 0, $4, $5, $3, $6)`,
    [fuelTypeId, tankId, qty, unitCost, amount, byUserId]
  );
  await pool.query(
    `INSERT INTO tank_stock (tank_id, fuel_type_id, quantity_l, avg_unit_cost)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tank_id) DO UPDATE SET quantity_l = $3, avg_unit_cost = $4`,
    [tankId, fuelTypeId, qty, unitCost]
  );
}

async function fuelVia(base: string, token: string, fix: Awaited<ReturnType<typeof createFixture>>, opts: {
  newOdo: number; actual: number; authorize?: number; excessReason?: string;
}) {
  const reqRes = await api(base, 'POST', '/api/fuel-requests', {
    token,
    body: { vehicleId: fix.vehicleId, currentOdometer: opts.newOdo },
  });
  if (reqRes.status !== 201) throw new Error(`create request failed: ${JSON.stringify(reqRes.data)}`);
  const authQty = opts.authorize ?? reqRes.data.calculatedLitres;
  const authRes = await api(base, 'POST', `/api/fuel-requests/${reqRes.data.id}/authorize`, {
    token,
    body: { quantity: authQty, reason: 'test authorization' },
  });
  if (authRes.status !== 200) throw new Error(`authorize failed: ${JSON.stringify(authRes.data)}`);
  const txnRes = await api(base, 'POST', '/api/fuel-transactions', {
    token,
    body: {
      requestId: reqRes.data.id,
      pumpId: fix.pumpId,
      odometer: opts.newOdo,
      pumpStartMeter: 1000,
      pumpEndMeter: 1000 + opts.actual,
      actualLitres: opts.actual,
      excessReason: opts.excessReason ?? 'pump lag',
    },
  });
  return { request: reqRes.data, authorize: authRes.data, txn: txnRes };
}

beforeAll(async () => {
  api_ = await startApp();
  const users = await ensureUsers();
  manager = (await login(api_.base, 'manager@test.io', 'Password123!')).accessToken;
  attendant = (await login(api_.base, 'attendant@test.io', 'Password123!')).accessToken;
});

afterAll(async () => {
  await api_.close();
});

describe('Fuel request → calculation → authorization → dispensing', () => {
  it('calculates fuel from mileage and completes a normal fueling end-to-end', async () => {
    const fix = await createFixture({ odo: 100000, kmpl: 5.0 });
    await seedOpening(fix.tankId, fix.fuelTypeId, 5000, 200);

    const { request, authorize, txn } = await fuelVia(api_.base, manager, fix, { newOdo: 100500, actual: 98.5 });

    // Calculation: 500 km / 5 km/l = 100 L
    expect(request.distanceKm).toBeCloseTo(500, 1);
    expect(request.calculatedLitres).toBeCloseTo(100, 3);
    expect(authorize.status).toBe('AUTHORIZED');

    expect(txn.status).toBe(201);
    expect(txn.data.status).toBe('COMPLETED');
    expect(txn.data.issuedLitres).toBeCloseTo(98.5, 3);
    expect(txn.data.unitCost).toBeCloseTo(200, 2);

    // Inventory decreased by actual
    const stock = await getStock(fix.tankId);
    expect(stock.qty).toBeCloseTo(5000 - 98.5, 3);

    // Odometer advanced immutably
    const odo = await qOne(
      `SELECT * FROM vehicle_odometer_history WHERE vehicle_id = $1 ORDER BY recorded_at DESC LIMIT 1`,
      [fix.vehicleId]
    );
    expect(Number(odo.odometer)).toBeCloseTo(100500, 1);
  });

  it('rejects odometer rollback with an exception and no transaction', async () => {
    const fix = await createFixture({ odo: 100000, kmpl: 5.0 });
    await seedOpening(fix.tankId, fix.fuelTypeId, 5000, 200);

    const reqRes = await api(api_.base, 'POST', '/api/fuel-requests', {
      token: manager,
      body: { vehicleId: fix.vehicleId, currentOdometer: 99500 }, // < 100000
    });
    expect(reqRes.status).toBe(422);
    expect(reqRes.data.error.code).toBe('ODOMETER_ROLLBACK');

    // Exception recorded
    const exc = await qOne(
      `SELECT * FROM exceptions WHERE exception_type = 'ODOMETER_ROLLBACK' AND vehicle_id = $1`,
      [fix.vehicleId]
    );
    expect(exc).toBeTruthy();

    // Fueling-path rollback: first fuel the vehicle to 100500 (commits it),
    // then a later fueling that reports 100400 must be rejected.
    const ok = await api(api_.base, 'POST', '/api/fuel-requests', {
      token: manager,
      body: { vehicleId: fix.vehicleId, currentOdometer: 100500 },
    });
    await api(api_.base, 'POST', `/api/fuel-requests/${ok.data.id}/authorize`, {
      token: manager,
      body: { quantity: 100, reason: 'test' },
    });
    const first = await api(api_.base, 'POST', '/api/fuel-transactions', {
      token: manager,
      body: {
        requestId: ok.data.id,
        pumpId: fix.pumpId,
        odometer: 100500,
        pumpStartMeter: 1000,
        pumpEndMeter: 1100,
        actualLitres: 100,
      },
    });
    expect(first.status).toBe(201);

    const second = await api(api_.base, 'POST', '/api/fuel-requests', {
      token: manager,
      body: { vehicleId: fix.vehicleId, currentOdometer: 100900 },
    });
    await api(api_.base, 'POST', `/api/fuel-requests/${second.data.id}/authorize`, {
      token: manager,
      body: { quantity: 80, reason: 'test' },
    });
    const bad = await api(api_.base, 'POST', '/api/fuel-transactions', {
      token: manager,
      body: {
        requestId: second.data.id,
        pumpId: fix.pumpId,
        odometer: 100400, // below the committed 100500 → rollback
        pumpStartMeter: 1100,
        pumpEndMeter: 1180,
        actualLitres: 80,
      },
    });
    expect(bad.status).toBe(422);
    expect(bad.data.error.code).toBe('ODOMETER_ROLLBACK');
    const txns = await pool.query('SELECT * FROM fuel_transactions WHERE fuel_request_id = $1', [second.data.id]);
    expect(txns.rows.length).toBe(0);
  });

  it('holds excess fuel until manager approval (unapproved excess is never issued)', async () => {
    const fix = await createFixture({ odo: 200000, kmpl: 5.0 });
    await seedOpening(fix.tankId, fix.fuelTypeId, 5000, 200);

    const { request, txn } = await fuelVia(api_.base, manager, fix, { newOdo: 200500, actual: 105 });

    // 105 > 100 + 0.5 tolerance → excess pending
    expect(txn.status).toBe(201);
    expect(txn.data.status).toBe('EXCESS_PENDING');
    expect(txn.data.excessLitres).toBeCloseTo(5, 3);

    // Only the authorized 100L was issued to inventory
    const stockBefore = await getStock(fix.tankId);
    expect(stockBefore.qty).toBeCloseTo(5000 - 100, 3);

    // Request moved to EXCESS_APPROVAL_REQUIRED
    const req = await qOne('SELECT * FROM fuel_requests WHERE id = $1', [request.id]);
    expect(req.status).toBe('EXCESS_APPROVAL_REQUIRED');
    expect(Number(req.excess_pending_litres)).toBeCloseTo(5, 3);

    // Manager approves → the 5L is now issued
    const approve = await api(api_.base, 'POST', `/api/fuel-requests/${request.id}/excess/approve`, {
      token: manager,
      body: { reason: 'verified on site' },
    });
    expect(approve.status).toBe(200);
    const stockAfter = await getStock(fix.tankId);
    expect(stockAfter.qty).toBeCloseTo(5000 - 105, 3);
    const req2 = await qOne('SELECT * FROM fuel_requests WHERE id = $1', [request.id]);
    expect(req2.status).toBe('COMPLETED');
  });

  it('returns rejected excess fuel to inventory', async () => {
    const fix = await createFixture({ odo: 300000, kmpl: 5.0 });
    await seedOpening(fix.tankId, fix.fuelTypeId, 5000, 200);
    const { request, txn } = await fuelVia(api_.base, manager, fix, { newOdo: 300500, actual: 103 });
    expect(txn.data.status).toBe('EXCESS_PENDING');

    const reject = await api(api_.base, 'POST', `/api/fuel-requests/${request.id}/excess/reject`, {
      token: manager,
      body: { reason: 'driver to return excess' },
    });
    expect(reject.status).toBe(200);
    const stock = await getStock(fix.tankId);
    // Only the authorized 100L was ever issued. The 3L excess physically
    // returns to the tank, and since it was never booked out, no movement.
    expect(stock.qty).toBeCloseTo(5000 - 100, 3);

    // No FUEL_RETURN ledger row (the excess was never issued, so nothing to return)
    const ret = await qOne(
      `SELECT * FROM fuel_inventory_transactions
        WHERE tank_id = $1 AND transaction_type = 'FUEL_RETURN'`,
      [fix.tankId]
    );
    expect(ret).toBeUndefined();
  });

  it('blocks fueling above available stock (negative stock prevention)', async () => {
    const fix = await createFixture({ odo: 400000, kmpl: 5.0 });
    await seedOpening(fix.tankId, fix.fuelTypeId, 80, 200); // only 80L available
    const { txn } = await fuelVia(api_.base, manager, fix, { newOdo: 400500, actual: 100 });
    expect(txn.status).toBe(422);
    expect(txn.data.error.code).toBe('NEGATIVE_STOCK');
    const stock = await getStock(fix.tankId);
    expect(stock.qty).toBeCloseTo(80, 3);
    const exc = await qOne(
      `SELECT * FROM exceptions WHERE exception_type = 'NEGATIVE_STOCK' AND vehicle_id = $1`,
      [fix.vehicleId]
    );
    expect(exc).toBeTruthy();
  });

  it('reversals restore inventory without deleting the original', async () => {
    const fix = await createFixture({ odo: 500000, kmpl: 5.0 });
    await seedOpening(fix.tankId, fix.fuelTypeId, 5000, 200);
    const { request, txn } = await fuelVia(api_.base, manager, fix, { newOdo: 500500, actual: 100 });
    expect(txn.status).toBe(201);

    const rev = await api(api_.base, 'POST', `/api/fuel-transactions/${txn.data.txnId}/reverse`, {
      token: manager,
      body: { reason: 'mistaken fueling' },
    });
    expect(rev.status).toBe(200);

    const stock = await getStock(fix.tankId);
    expect(stock.qty).toBeCloseTo(5000, 3);

    // Original still exists, marked REVERSED
    const orig = await qOne('SELECT * FROM fuel_transactions WHERE id = $1', [txn.data.txnId]);
    expect(orig.status).toBe('REVERSED');
    // Reversal ledger row posted
    const revLedger = await qOne(
      `SELECT * FROM fuel_inventory_transactions WHERE tank_id = $1 AND transaction_type = 'REVERSAL'`,
      [fix.tankId]
    );
    expect(Number(revLedger.quantity_in)).toBeCloseTo(100, 3);
  });

  it('transaction detail endpoint returns the full payload (regression: uuid/text param mix)', async () => {
    const fix = await createFixture({ odo: 600000, kmpl: 5.0 });
    await seedOpening(fix.tankId, fix.fuelTypeId, 5000, 200);
    const { txn } = await fuelVia(api_.base, manager, fix, { newOdo: 600500, actual: 80 });
    expect(txn.status).toBe(201);

    // Detail endpoint must not 500 — historically failed with
    // "operator does not exist: uuid = text" (audit query) and omitted
    // pumpReadings (page crashed on .map of undefined).
    const detail = await api(api_.base, 'GET', `/api/fuel-transactions/${txn.data.txnId}`, {
      token: manager,
    });
    expect(detail.status).toBe(200);
    expect(detail.data.row.transaction_number).toBeTruthy();
    expect(Array.isArray(detail.data.ledger)).toBe(true);
    expect(Array.isArray(detail.data.audit)).toBe(true);
    expect(Array.isArray(detail.data.sync)).toBe(true);
    expect(Array.isArray(detail.data.odometer)).toBe(true);
    expect(Array.isArray(detail.data.pumpReadings)).toBe(true);
    expect(detail.data.ledger.length).toBeGreaterThan(0);

    // After reversal the detail endpoint must still work and the audit
    // trail must pick up the reversal via the is_reversal_of subquery.
    const rev = await api(api_.base, 'POST', `/api/fuel-transactions/${txn.data.txnId}/reverse`, {
      token: manager,
      body: { reason: 'detail regression reversal' },
    });
    expect(rev.status).toBe(200);
    const detail2 = await api(api_.base, 'GET', `/api/fuel-transactions/${txn.data.txnId}`, {
      token: manager,
    });
    expect(detail2.status).toBe(200);
    expect(detail2.data.row.status).toBe('REVERSED');
    expect(detail2.data.audit.length).toBeGreaterThan(0);
  });

  it('reversing an EXCESS_PENDING fueling restores the request to AUTHORIZED', async () => {
    const fix = await createFixture({ odo: 700000, kmpl: 5.0 });
    await seedOpening(fix.tankId, fix.fuelTypeId, 5000, 200);
    // Authorize 100 L, dispense 105 L → 5 L excess pending approval
    const { request, txn } = await fuelVia(api_.base, manager, fix, {
      newOdo: 700500,
      actual: 105,
      authorize: 100,
    });
    expect(txn.status).toBe(201);
    expect(txn.data.status).toBe('EXCESS_PENDING');
    const reqBefore = await qOne('SELECT * FROM fuel_requests WHERE id = $1', [request.id]);
    expect(reqBefore.status).toBe('EXCESS_APPROVAL_REQUIRED');
    expect(Number(reqBefore.excess_pending_litres)).toBeCloseTo(5, 3);

    const rev = await api(api_.base, 'POST', `/api/fuel-transactions/${txn.data.txnId}/reverse`, {
      token: manager,
      body: { reason: 'excess fueling entered twice' },
    });
    expect(rev.status).toBe(200);

    // Request is back where it was before the (cancelled) fueling, so it can
    // be re-fuelled — and decideExcess has nothing left to decide on.
    const reqAfter = await qOne('SELECT * FROM fuel_requests WHERE id = $1', [request.id]);
    expect(reqAfter.status).toBe('AUTHORIZED');
    expect(Number(reqAfter.excess_pending_litres)).toBe(0);

    const decide = await api(api_.base, 'POST', `/api/fuel-requests/${request.id}/excess/approve`, {
      token: manager,
      body: { reason: 'should not be possible anymore' },
    });
    expect(decide.status).toBe(409);
  });

  it('attendant cannot authorize fuel (RBAC)', async () => {
    const fix = await createFixture();
    const reqRes = await api(api_.base, 'POST', '/api/fuel-requests', {
      token: manager,
      body: { vehicleId: fix.vehicleId, currentOdometer: 20500 },
    });
    const forbidden = await api(api_.base, 'POST', `/api/fuel-requests/${reqRes.data.id}/authorize`, {
      token: attendant,
      body: { quantity: 100 },
    });
    expect(forbidden.status).toBe(403);

    // Attendant also cannot create requests or receive fuel
    const noCreate = await api(api_.base, 'POST', '/api/fuel-requests', {
      token: attendant,
      body: { vehicleId: fix.vehicleId, currentOdometer: 20600 },
    });
    expect(noCreate.status).toBe(403);
    const noPurchases = await api(api_.base, 'GET', '/api/fuel-purchases', { token: attendant });
    expect(noPurchases.status).toBe(403);
  });
});
