import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, api, login, ensureUsers, createFixture, getStock, ledgerRows, DIESEL } from '../helpers';
import { postInventoryMovement } from '../../src/services/ledger';
import { pool, withTransaction } from '../../src/db';

let api_: Awaited<ReturnType<typeof startApp>>;
let manager: string;
let admin: string;

beforeAll(async () => {
  api_ = await startApp();
  const users = await ensureUsers();
  manager = (await login(api_.base, 'manager@test.io', 'Password123!')).accessToken;
  admin = (await login(api_.base, 'admin@test.io', 'Password123!')).accessToken;
});

afterAll(async () => {
  await api_.close();
});

async function postOpening(tankId: string, fuelTypeId: string, qty: number, unitCost: number, date: Date, byUserId: string) {
  await withTransaction((c) =>
    postInventoryMovement(c, {
      transactionDate: date,
      fuelTypeId,
      tankId,
      type: 'OPENING_BALANCE',
      particulars: 'Opening Balance (test)',
      qtyIn: qty,
      unitCostIn: unitCost,
      createdBy: byUserId,
    })
  );
}

describe('Fuel Ledger — running balance & filtered opening balance', () => {
  it('computes opening + in - out = closing and a consistent running balance', async () => {
    const fix = await createFixture({ odo: 5000 });
    const byUserId = (await pool.query('SELECT id FROM users LIMIT 1')).rows[0].id;
    const d = (s: string) => new Date(s);
    await postOpening(fix.tankId, fix.fuelTypeId, 5000, 100, d('2026-09-01T00:00:00+03:00'), byUserId);
    await withTransaction((c) =>
      postInventoryMovement(c, {
        transactionDate: d('2026-09-02T10:00:00+03:00'),
        fuelTypeId: fix.fuelTypeId,
        tankId: fix.tankId,
        type: 'BULK_RECEIPT',
        particulars: 'Test receipt',
        qtyIn: 10000,
        unitCostIn: 120,
        createdBy: byUserId,
      })
    );
    await withTransaction((c) =>
      postInventoryMovement(c, {
        transactionDate: d('2026-09-03T10:00:00+03:00'),
        fuelTypeId: fix.fuelTypeId,
        tankId: fix.tankId,
        type: 'FUEL_ISSUE',
        particulars: 'Test issue 1',
        qtyOut: 120,
        createdBy: byUserId,
      })
    );
    await withTransaction((c) =>
      postInventoryMovement(c, {
        transactionDate: d('2026-09-03T11:00:00+03:00'),
        fuelTypeId: fix.fuelTypeId,
        tankId: fix.tankId,
        type: 'FUEL_ISSUE',
        particulars: 'Test issue 2',
        qtyOut: 150,
        createdBy: byUserId,
      })
    );
    await withTransaction((c) =>
      postInventoryMovement(c, {
        transactionDate: d('2026-09-04T10:00:00+03:00'),
        fuelTypeId: fix.fuelTypeId,
        tankId: fix.tankId,
        type: 'ADJUSTMENT_OUT',
        particulars: 'Test adjustment',
        qtyOut: 20,
        createdBy: byUserId,
      })
    );

    // tank_stock must equal the final ledger balance
    const stock = await getStock(fix.tankId);
    expect(stock.qty).toBeCloseTo(14710, 3);

    // Full period: opening 0 (opening balance itself is inside the period)
    const full = await api(api_.base, 'GET',
      `/api/reports/fuel-ledger?dateFrom=2026-09-01&dateTo=2026-09-30&tankId=${fix.tankId}&limit=50`,
      { token: manager });
    expect(full.status).toBe(200);
    expect(full.data.openingBalance).toBe(0);
    expect(full.data.totalIn).toBeCloseTo(15000, 3);
    expect(full.data.totalOut).toBeCloseTo(290, 3);
    expect(full.data.closingBalance).toBeCloseTo(14710, 3);
    expect(full.data.lastRunningBalance).toBeCloseTo(14710, 3);
    expect(full.data.balanceConsistent).toBe(true);

    // Running balances of the rows: 5000, 15000, 14880, 14730, 14710
    const balances = full.data.rows.map((r: any) => r.runningBalance);
    expect(balances).toEqual([5000, 15000, 14880, 14730, 14710]);

    // Filtered from 03/09: opening must be 15000 (OB + receipt before 03/09)
    const filtered = await api(api_.base, 'GET',
      `/api/reports/fuel-ledger?dateFrom=2026-09-03&dateTo=2026-09-30&tankId=${fix.tankId}&limit=50`,
      { token: manager });
    expect(filtered.status).toBe(200);
    expect(filtered.data.openingBalance).toBeCloseTo(15000, 3);
    expect(filtered.data.totalOut).toBeCloseTo(290, 3);
    expect(filtered.data.closingBalance).toBeCloseTo(14710, 3);
    expect(filtered.data.lastRunningBalance).toBeCloseTo(14710, 3);
    expect(filtered.data.rows[0].runningBalance).toBeCloseTo(14880, 3);
    expect(filtered.data.rows[0].particulars).toContain('Test issue 1');
  });

  it('keeps running balances correct across server-side pagination', async () => {
    const fix = await createFixture();
    const byUserId = (await pool.query('SELECT id FROM users LIMIT 1')).rows[0].id;
    await postOpening(fix.tankId, fix.fuelTypeId, 1000, 100, new Date('2026-09-01T00:00:00+03:00'), byUserId);
    // 7 issues of 10L on successive days
    for (let i = 1; i <= 7; i++) {
      await withTransaction((c) =>
        postInventoryMovement(c, {
          transactionDate: new Date(`2026-09-0${i + 1}T10:00:00+03:00`),
          fuelTypeId: fix.fuelTypeId,
          tankId: fix.tankId,
          type: 'FUEL_ISSUE',
          particulars: `Issue ${i}`,
          qtyOut: 10,
          createdBy: byUserId,
        })
      );
    }
    const page1 = await api(api_.base, 'GET',
      `/api/reports/fuel-ledger?dateFrom=2026-09-01&dateTo=2026-09-30&tankId=${fix.tankId}&limit=3&page=1`,
      { token: manager });
    const page2 = await api(api_.base, 'GET',
      `/api/reports/fuel-ledger?dateFrom=2026-09-01&dateTo=2026-09-30&tankId=${fix.tankId}&limit=3&page=2`,
      { token: manager });
    expect(page1.data.totalPages).toBe(3);
    const b1 = page1.data.rows.map((r: any) => r.runningBalance);
    const b2 = page2.data.rows.map((r: any) => r.runningBalance);
    // page1: 1000, 990, 980 ; page2: 970, 960, 950
    expect(b1).toEqual([1000, 990, 980]);
    expect(b2).toEqual([970, 960, 950]);
    // summary must be independent of the page
    expect(page2.data.openingBalance).toBe(page1.data.openingBalance);
    expect(page2.data.closingBalance).toBeCloseTo(930, 3);
  });

  it('restricts sorting to chronological-safe fields', async () => {
    const fix = await createFixture();
    const bad = await api(api_.base, 'GET',
      `/api/reports/fuel-ledger?tankId=${fix.tankId}&sortBy=particulars`,
      { token: manager });
    expect(bad.status).toBe(400);
    expect(bad.data.error.code).toBe('INVALID_SORT');
    // desc on date is allowed (balance stays point-in-time correct)
    const ok = await api(api_.base, 'GET',
      `/api/reports/fuel-ledger?dateFrom=2026-09-01&dateTo=2026-09-30&tankId=${fix.tankId}&sortBy=transaction_date&sortDirection=desc&limit=50`,
      { token: manager });
    expect(ok.status).toBe(200);
  });

  it('computes weighted average cost on issues', async () => {
    const fix = await createFixture();
    const byUserId = (await pool.query('SELECT id FROM users LIMIT 1')).rows[0].id;
    // 1000L @ 180 then 500L @ 200 → avg (1000*180 + 500*200)/1500 = 186.6667
    await postOpening(fix.tankId, fix.fuelTypeId, 1000, 180, new Date('2026-09-01T00:00:00+03:00'), byUserId);
    await withTransaction((c) =>
      postInventoryMovement(c, {
        transactionDate: new Date('2026-09-02T10:00:00+03:00'),
        fuelTypeId: fix.fuelTypeId,
        tankId: fix.tankId,
        type: 'BULK_RECEIPT',
        particulars: 'Receipt @200',
        qtyIn: 500,
        unitCostIn: 200,
        createdBy: byUserId,
      })
    );
    const issue = await withTransaction((c) =>
      postInventoryMovement(c, {
        transactionDate: new Date('2026-09-03T10:00:00+03:00'),
        fuelTypeId: fix.fuelTypeId,
        tankId: fix.tankId,
        type: 'FUEL_ISSUE',
        particulars: 'Issue @WAC',
        qtyOut: 100,
        createdBy: byUserId,
      })
    );
    expect(issue.unitCost).toBeCloseTo(186.6667, 3);
    expect(issue.amount).toBeCloseTo(18666.67, 2);
    const stock = await getStock(fix.tankId);
    expect(stock.avg).toBeCloseTo(186.6667, 3);
  });

  it('distinguishes vehicle-scoped ledgers from the stock ledger', async () => {
    const fix = await createFixture({ odo: 100000, kmpl: 5.0 });
    const byUserId = (await pool.query('SELECT id FROM users LIMIT 1')).rows[0].id;
    await postOpening(fix.tankId, fix.fuelTypeId, 2000, 100, new Date('2026-09-01T00:00:00+03:00'), byUserId);

    // Fuel the vehicle through the real pipeline: 500km @5km/l → 100L authorized
    const reqRes = await api(api_.base, 'POST', '/api/fuel-requests', {
      token: manager,
      body: { vehicleId: fix.vehicleId, currentOdometer: 100500 },
    });
    expect(reqRes.status).toBe(201);
    expect(reqRes.data.calculatedLitres).toBeCloseTo(100, 3);
    expect(reqRes.data.distanceKm).toBeCloseTo(500, 1);
    const authRes = await api(api_.base, 'POST', `/api/fuel-requests/${reqRes.data.id}/authorize`, {
      token: manager,
      body: { quantity: 100, reason: 'test' },
    });
    expect(authRes.status).toBe(200);
    const txnRes = await api(api_.base, 'POST', '/api/fuel-transactions', {
      token: manager,
      body: {
        requestId: reqRes.data.id,
        pumpId: fix.pumpId,
        odometer: 100500,
        pumpStartMeter: 1000,
        pumpEndMeter: 1100,
        actualLitres: 100,
      },
    });
    expect(txnRes.status).toBe(201);

    // Vehicle ledger: only the issue appears; running issued qty = 100
    // (date window = today EAT, so the test stays valid on any day)
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Nairobi',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const veh = await api(api_.base, 'GET',
      `/api/reports/fuel-ledger?dateFrom=${today}&dateTo=${today}&vehicleId=${fix.vehicleId}&limit=50`,
      { token: manager });
    expect(veh.status).toBe(200);
    expect(veh.data.scope).toBe('VEHICLE');
    expect(veh.data.totalOut).toBeCloseTo(100, 3);
    expect(veh.data.closingBalance).toBeCloseTo(-100, 3); // net issued (negative out)
    expect(veh.data.rows.length).toBe(1);
    expect(veh.data.rows[0].reference).toBe(txnRes.data.transactionNumber);

    // Stock ledger for the same tank: opening 2000 → 1900
    // (today-only window: opening balance carries the Sep-1 OPENING forward)
    const stock = await api(api_.base, 'GET',
      `/api/reports/fuel-ledger?dateFrom=${today}&dateTo=${today}&tankId=${fix.tankId}&limit=50`,
      { token: manager });
    expect(stock.data.scope).toBe('STOCK');
    expect(stock.data.openingBalance).toBeCloseTo(2000, 3);
    expect(stock.data.closingBalance).toBeCloseTo(1900, 3);
    expect(stock.data.rows.length).toBe(1);
  });

  it('rejects negative stock and creates a NEGATIVE_STOCK exception', async () => {
    const fix = await createFixture();
    const byUserId = (await pool.query('SELECT id FROM users LIMIT 1')).rows[0].id;
    await postOpening(fix.tankId, fix.fuelTypeId, 100, 100, new Date('2026-09-01T00:00:00+03:00'), byUserId);
    let threw = false;
    try {
      await withTransaction((c) =>
        postInventoryMovement(c, {
          fuelTypeId: fix.fuelTypeId,
          tankId: fix.tankId,
          type: 'FUEL_ISSUE',
          particulars: 'Too big',
          qtyOut: 150,
          createdBy: byUserId,
        })
      );
    } catch (e) {
      threw = true;
      expect((e as Error).message).toContain('Negative stock');
    }
    expect(threw).toBe(true);
    // balance unchanged
    const stock = await getStock(fix.tankId);
    expect(stock.qty).toBeCloseTo(100, 3);
  });

  it('rejects tank overfill on receipt', async () => {
    const fix = await createFixture({ capacity: 1000 });
    const byUserId = (await pool.query('SELECT id FROM users LIMIT 1')).rows[0].id;
    await postOpening(fix.tankId, fix.fuelTypeId, 900, 100, new Date('2026-09-01T00:00:00+03:00'), byUserId);
    let threw = false;
    try {
      await withTransaction((c) =>
        postInventoryMovement(c, {
          fuelTypeId: fix.fuelTypeId,
          tankId: fix.tankId,
          type: 'BULK_RECEIPT',
          particulars: 'Overflow',
          qtyIn: 200,
          unitCostIn: 100,
          createdBy: byUserId,
        })
      );
    } catch (e) {
      threw = true;
      expect((e as Error).message).toContain('overfill');
    }
    expect(threw).toBe(true);
  });

  it('maintains ledger = inventory consistency (requirement 48)', async () => {
    const fix = await createFixture();
    const byUserId = (await pool.query('SELECT id FROM users LIMIT 1')).rows[0].id;
    await postOpening(fix.tankId, fix.fuelTypeId, 500, 100, new Date('2026-09-01T00:00:00+03:00'), byUserId);
    for (const n of [10, 25.5, 40]) {
      await withTransaction((c) =>
        postInventoryMovement(c, {
          fuelTypeId: fix.fuelTypeId,
          tankId: fix.tankId,
          type: 'FUEL_ISSUE',
          particulars: `Issue ${n}`,
          qtyOut: n,
          createdBy: byUserId,
        })
      );
    }
    const rows = await ledgerRows(fix.tankId);
    const last = rows[rows.length - 1];
    const stock = await getStock(fix.tankId);
    expect(Number(last.running_balance)).toBeCloseTo(stock.qty, 3);
    expect(stock.qty).toBeCloseTo(424.5, 3);
  });
});
