// ============================================================================
// End-to-end API test — exercises the full fuel workflow against a LIVE
// server. Run:  ENV_FILE=../.env.dev-test npm test
// Requires the server to be running (npm start) and migrations applied.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
let TOKEN = null;
const h = () => ({ 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` });

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: h(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const uuid = () => crypto.randomUUID();

test('health endpoints respond', async () => {
  const live = await fetch(`${BASE}/api/health/live`);
  assert.equal(live.status, 200);
  const health = await api('GET', '/api/health');
  assert.equal(health.json.database, 'connected');
});

test('login works and bad login is rejected', async () => {
  const bad = await api('POST', '/api/auth/login', { email: 'admin@fleetfuel.local', password: 'wrong' });
  assert.equal(bad.status, 401);
  const good = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: process.env.TEST_ADMIN_EMAIL || 'admin@fleetfuel.local', password: process.env.TEST_ADMIN_PASSWORD || 'AdminPass123!' }),
  });
  assert.equal(good.status, 200);
  const body = await good.json();
  TOKEN = body.token;
  assert.equal(body.user.role, 'admin');
});

let diesel, petrol, tank, pump, vehicle, manager;

test('reference data exists', async () => {
  const fts = await api('GET', '/api/fuel-types');
  assert.equal(fts.status, 200);
  diesel = fts.json.fuel_types.find((f) => f.code === 'DIESEL');
  petrol = fts.json.fuel_types.find((f) => f.code === 'PETROL');
  assert.ok(diesel && petrol);
  const tanks = await api('GET', '/api/tanks');
  tank = tanks.json.tanks[0];
  assert.ok(tank, 'a tank must exist (seed)');
  const pumps = await api('GET', '/api/pumps');
  pump = pumps.json.pumps.find((p) => p.tank_id === tank.id);
  assert.ok(pump, 'a pump on the tank must exist (seed)');
  const vs = await api('GET', '/api/vehicles');
  vehicle = vs.json.vehicles[0];
  assert.ok(vehicle, 'a vehicle must exist (seed)');
});

test('bulk receipt posts ledger and increases stock', async () => {
  const stockBefore = (await api('GET', '/api/inventory/stock')).json.by_fuel_type.find((s) => s.id === diesel.id).balance;
  const r = await api('POST', '/api/inventory/receipts', {
    fuel_type_id: diesel.id, tank_id: tank.id, quantity: 5000, supplier: 'Total Kenya', invoice_no: 'INV-77', unit_price: 178.5,
    client_uuid: uuid(),
  });
  assert.equal(r.status, 201);
  assert.equal(Number(r.json.receipt.quantity), 5000);
  const stockAfter = (await api('GET', '/api/inventory/stock')).json.by_fuel_type.find((s) => s.id === diesel.id).balance;
  assert.equal(stockAfter - stockBefore, 5000);
});

test('request → authorize → issue → ledger flow', async () => {
  // create manager
  const mu = await api('POST', '/api/users', { name: 'Fleet Manager', email: `mgr-${uuid().slice(0, 8)}@test.local`, password: 'Manager123!', role: 'manager' });
  assert.equal(mu.status, 201);
  manager = mu.json.user;

  const req = await api('POST', '/api/requests', { vehicle_id: vehicle.id, fuel_type_id: diesel.id, quantity: 40, destination: 'Mombasa road' });
  assert.equal(req.status, 201);
  const requestId = req.json.request.id;
  assert.equal(req.json.request.status, 'pending');

  const app = await api('POST', `/api/requests/${requestId}/approve`, { comments: 'Approved for trip' });
  assert.equal(app.status, 200);
  assert.equal(app.json.request.status, 'approved');

  const issue = await api('POST', '/api/transactions/issue', {
    request_id: requestId, pump_id: pump.id, quantity: 40, unit_price: 180, odometer: 123456, pump_reading: 500.5,
  });
  assert.equal(issue.status, 201);
  assert.equal(issue.json.transaction.txn_no.slice(0, 4), 'TXN-');
  const balAfterIssue = Number(issue.json.transaction.balance_after);

  const stock = (await api('GET', '/api/inventory/stock')).json.by_fuel_type.find((s) => s.id === diesel.id).balance;
  assert.equal(stock, balAfterIssue, 'ledger balance_after must equal stock');

  // request cannot be issued twice
  const again = await api('POST', '/api/transactions/issue', { request_id: requestId, pump_id: pump.id, quantity: 10 });
  assert.equal(again.status, 409);

  // pending request cannot be issued
  const req2 = await api('POST', '/api/requests', { vehicle_id: vehicle.id, fuel_type_id: petrol.id, quantity: 20 });
  const issueBad = await api('POST', '/api/transactions/issue', { request_id: req2.json.request.id, tank_id: tank.id, quantity: 5 });
  assert.equal(issueBad.status, 409);

  // ledger endpoint shows entries
  const ledger = await api('GET', `/api/ledger?fuel_type_id=${diesel.id}`);
  assert.ok(ledger.json.entries.length >= 2);
  assert.ok(ledger.json.entries.every((e) => e.balance_after !== undefined));
});

test('reversal restores stock and keeps history', async () => {
  const stockBefore = (await api('GET', '/api/inventory/stock')).json.by_fuel_type.find((s) => s.id === diesel.id).balance;
  const req = await api('POST', '/api/requests', { vehicle_id: vehicle.id, fuel_type_id: diesel.id, quantity: 10 });
  await api('POST', `/api/requests/${req.json.request.id}/approve`, {});
  const issue = await api('POST', '/api/transactions/issue', { request_id: req.json.request.id, tank_id: tank.id, quantity: 10 });
  const txnId = issue.json.transaction.id;
  assert.equal(Number(issue.json.transaction.balance_after), stockBefore - 10);

  const rev = await api('POST', `/api/transactions/${txnId}/reverse`, { reason: 'Wrong pump test' });
  assert.equal(rev.status, 200);
  assert.equal(rev.json.original.status, 'reversed');

  const stock = (await api('GET', '/api/inventory/stock')).json.by_fuel_type.find((s) => s.id === diesel.id).balance;
  assert.equal(stock, stockBefore, 'reversal must restore the pre-issue balance');

  const ledger = await api('GET', `/api/ledger?entry_type=reversal`);
  assert.ok(ledger.json.entries.length >= 1);
});

test('insufficient stock is refused (tank cannot go negative)', async () => {
  const req = await api('POST', '/api/requests', { vehicle_id: vehicle.id, fuel_type_id: diesel.id, quantity: 999999 });
  await api('POST', `/api/requests/${req.json.request.id}/approve`, {});
  const issue = await api('POST', '/api/transactions/issue', { request_id: req.json.request.id, tank_id: tank.id, quantity: 999999 });
  assert.equal(issue.status, 409);
});

test('offline sync is idempotent — replaying ops never duplicates data', async () => {
  const opId = uuid();
  const batch = {
    device_id: 'test-device-001',
    ops: [
      { op_id: opId, type: 'fuel_request', payload: { vehicle_id: vehicle.id, fuel_type_id: diesel.id, quantity: 25, client_uuid: opId } },
    ],
  };
  const first = await api('POST', '/api/sync/batch', batch);
  assert.equal(first.status, 200);
  assert.equal(first.json.results[0].status, 'applied');
  const requestNo = first.json.results[0].ref.request_no;

  const replay = await api('POST', '/api/sync/batch', batch);
  assert.equal(replay.json.results[0].status, 'duplicate');
  assert.equal(replay.json.results[0].ref.id, first.json.results[0].ref.id, 'same client_uuid must map to same row');

  // approve the synced request by number, then issue via sync by request_no
  const list = await api('GET', `/api/requests?status=approved`);
  const mine = list.json.requests.length; // just to exercise endpoint
  assert.ok(mine >= 0);

  const approve = await fetch(BASE + '/api/requests?status=pending');
  // find the synced request id
  const pend = await api('GET', '/api/requests?status=pending');
  const target = pend.json.requests.find((r) => r.request_no === requestNo);
  assert.ok(target, 'synced request should be visible');
  await api('POST', `/api/requests/${target.id}/approve`, {});

  const txnOpId = uuid();
  const issueBatch = {
    device_id: 'test-device-001',
    ops: [{ op_id: txnOpId, type: 'fuel_transaction', payload: { request_no: requestNo, pump_id: pump.id, quantity: 25, client_uuid: txnOpId } }],
  };
  const issue1 = await api('POST', '/api/sync/batch', issueBatch);
  assert.equal(issue1.json.results[0].status, 'applied');
  const issue2 = await api('POST', '/api/sync/batch', issueBatch);
  assert.equal(issue2.json.results[0].status, 'duplicate');
});

test('sync pull returns reference data + stock', async () => {
  const pull = await api('GET', '/api/sync/pull');
  assert.equal(pull.status, 200);
  assert.ok(pull.json.reference.vehicles.length >= 1);
  assert.ok(pull.json.stock.by_fuel_type.length >= 1);
  assert.ok(pull.json.server_time);
});

test('role enforcement: attendant cannot approve or see users', async () => {
  const au = await api('POST', '/api/users', { name: 'Attendant', email: `att-${uuid().slice(0, 8)}@test.local`, password: 'Attendant123!', role: 'attendant' });
  const attToken = (await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: au.json.user.email, password: 'Attendant123!' }),
  })).body;
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: au.json.user.email, password: 'Attendant123!' }),
  });
  const token = (await login.json()).token;
  const pend = await api('GET', '/api/requests?status=pending');
  const target = pend.json.requests[0];
  const res = await fetch(`${BASE}/api/requests/${target.id}/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{}',
  });
  assert.equal(res.status, 403);
  const usersRes = await fetch(`${BASE}/api/users`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(usersRes.status, 403);
});

test('master data is never deleted', async () => {
  const res = await api('DELETE', `/api/vehicles/${vehicle.id}`);
  assert.equal(res.status, 400);
  const ft = await api('DELETE', `/api/fuel-types/${diesel.id}`);
  assert.equal(ft.status, 400);
});

test('system version endpoint reports build info', async () => {
  const v = await api('GET', '/api/system/version');
  assert.equal(v.status, 200);
  assert.ok(v.json.version);
  assert.ok(v.json.database.migrations.applied >= 4);
});
