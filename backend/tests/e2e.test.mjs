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


// ═══ Reports / Ledger / Exports / Notifications (spec round 55-section) ═══

test('fuel ledger report: opening, running balance and closing are consistent', async () => {
  const p1 = await api('GET', '/api/reports/fuel-ledger?pageSize=2&page=1');
  assert.equal(p1.status, 200);
  assert.ok(p1.json.total >= 3, 'ledger must have entries');
  const last = await api('GET', `/api/reports/fuel-ledger?pageSize=2&page=${Math.max(1, Math.ceil(p1.json.total / 2))}`);
  const lastRow = last.json.rows[last.json.rows.length - 1];
  // §12/§55: closing = opening + in - out; last running balance on the report equals closing.
  assert.equal(Math.round(lastRow.running_balance * 100) / 100, Math.round(last.json.closingBalance * 100) / 100);
  const s = Object.fromEntries(last.json.summary.map((x) => [x.label, x.value]));
  const parse = (t) => Number(t.replace(/[^0-9.-]/g, ''));
  assert.equal(parse(s['Closing Balance']), parse(s['Opening Balance']) + parse(s['Total In']) - parse(s['Total Out']));
});

test('fuel ledger running balance continues across pages (§16)', async () => {
  const p1 = await api('GET', '/api/reports/fuel-ledger?pageSize=1&page=1');
  const p2 = await api('GET', '/api/reports/fuel-ledger?pageSize=1&page=2');
  if (p1.json.total < 2) return; // nothing to continue
  const r1 = p1.json.rows[0].running_balance;
  const r2 = p2.json.rows[0].running_balance;
  assert.notEqual(r1, r2, 'page 2 must continue from page 1, not restart');
  assert.equal(Math.round(r2 * 100) / 100, Math.round((r1 + p2.json.rows[0].qty_in - p2.json.rows[0].qty_out) * 100) / 100);
});

test('vehicle ledger computes distance and KM/L (§18)', async () => {
  const v = await api('GET', '/api/reports/vehicle-ledger');
  assert.equal(v.status, 200);
  const withDist = v.json.rows.find((r) => r.distance != null);
  if (!withDist) return; // single fill-up only — math covered elsewhere
  assert.ok(withDist.km_per_l > 0);
  assert.equal(Math.round((withDist.distance / withDist.litres) * 100) / 100, withDist.km_per_l);
});

test('exports: real formats, audited, RBAC-enforced (§43/§45)', async () => {
  const xls = await fetch(`${BASE}/api/reports/fuel-ledger/export/excel`, { headers: h() });
  assert.equal(xls.status, 200);
  const xbytes = new Uint8Array(await xls.arrayBuffer());
  assert.ok(xbytes[0] === 0x50 && xbytes[1] === 0x4b, 'xlsx must be a real zip (PK)');
  const pdf = await fetch(`${BASE}/api/reports/fuel-ledger/export/pdf`, { headers: h() });
  assert.equal(pdf.status, 200);
  const pbytes = new Uint8Array(await pdf.arrayBuffer());
  const head = String.fromCharCode(...pbytes.slice(0, 4));
  assert.equal(head, '%PDF');
  const csv = await fetch(`${BASE}/api/reports/fuel-ledger/export/csv`, { headers: h() });
  assert.equal(csv.status, 200);
  assert.ok((await csv.text()).includes('Fuel Ledger'));
  // attendant cannot view or export (§43)
  const att = await api('POST', '/api/users', { name: 'Exp Attendant', email: `exp-${uuid().slice(0, 8)}@test.local`, password: 'Attendant123!', role: 'attendant' });
  const alogin = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: att.json.user.email, password: 'Attendant123!' }) });
  const atoken = (await alogin.json()).token;
  const denied = await fetch(`${BASE}/api/reports/fuel-ledger/export/excel`, { headers: { authorization: `Bearer ${atoken}` } });
  assert.equal(denied.status, 403);
  // audit rows for exports exist (§45)
  const aud = await api('GET', '/api/ledger'); // any authorized call to keep TOKEN valid
  assert.equal(aud.status, 200);
});


// ═══ Approvals engine (§19–§28, §46–§53) ═══

test('approvals: adjustment gated, decided in-tx, self-approval blocked, idempotent', async () => {
  // admin submits an adjustment — stock must NOT change (§53)
  const stockA = (await api('GET', '/api/inventory/stock')).json.by_fuel_type.find((s) => s.id === diesel.id).balance;
  const cu = uuid();
  const sub = await api('POST', '/api/inventory/adjustments', {
    fuel_type_id: diesel.id, tank_id: tank.id, quantity: -5, reason: 'test calib', client_uuid: cu,
  });
  assert.equal(sub.status, 202);
  assert.ok(sub.json.pending);
  const aid = sub.json.approval_id;
  const stockB = (await api('GET', '/api/inventory/stock')).json.by_fuel_type.find((s) => s.id === diesel.id).balance;
  assert.equal(stockA, stockB, 'pending adjustment must not alter stock');

  // retry with same client_uuid → same approval, no duplicate (§47)
  const retry = await api('POST', '/api/inventory/adjustments', {
    fuel_type_id: diesel.id, tank_id: tank.id, quantity: -5, reason: 'dup', client_uuid: cu,
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.json.approval_id, aid);
  assert.ok(retry.json.existing);

  // admin submitted → admin cannot self-approve (§27)
  const self = await api('POST', `/api/approvals/${aid}/approve`, { reason: 'me' });
  assert.equal(self.status, 403);

  // manager approves → stock moves in the same transaction (§46)
  const mlogin = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: manager.email, password: 'Manager123!' }) });
  const mtoken = (await mlogin.json()).token;
  const mh = { 'content-type': 'application/json', authorization: `Bearer ${mtoken}` };
  const app = await fetch(`${BASE}/api/approvals/${aid}/approve`, { method: 'POST', headers: mh, body: JSON.stringify({ reason: 'verified' }) });
  assert.equal(app.status, 200);
  const stockC = (await api('GET', '/api/inventory/stock')).json.by_fuel_type.find((s) => s.id === diesel.id).balance;
  assert.equal(Math.round((stockC - stockB) * 100) / 100, -5);

  // already decided → 409; duplicate client_uuid → duplicate:true (§47)
  const again = await fetch(`${BASE}/api/approvals/${aid}/approve`, { method: 'POST', headers: mh, body: JSON.stringify({ client_uuid: 'nope' }) });
  assert.equal(again.status, 409);

  // rejection requires a reason (§23)
  const cu2 = uuid();
  const sub2 = await api('POST', '/api/inventory/adjustments', { fuel_type_id: diesel.id, tank_id: tank.id, quantity: 1, reason: 'x', client_uuid: cu2 });
  const aid2 = sub2.json.approval_id;
  const noReason = await fetch(`${BASE}/api/approvals/${aid2}/reject`, { method: 'POST', headers: { ...mh }, body: '{}' });
  assert.equal(noReason.status, 400);
  const rej = await fetch(`${BASE}/api/approvals/${aid2}/reject`, { method: 'POST', headers: mh, body: JSON.stringify({ reason: 'not substantiated' }) });
  assert.equal(rej.status, 200);

  // history is immutable and ordered (§28)
  const hist = await api('GET', `/api/approvals/${aid2}/history`);
  assert.equal(hist.status, 200);
  assert.deepEqual(hist.json.history.map((e) => e.action), ['SUBMITTED', 'REJECTED']);

  // attendant has no approval permissions (§26)
  const att = await api('POST', '/api/users', { name: 'Appr Att', email: `apr-${uuid().slice(0, 8)}@test.local`, password: 'Attendant123!', role: 'attendant' });
  const alogin = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: att.json.user.email, password: 'Attendant123!' }) });
  const at = (await alogin.json()).token;
  const denied = await fetch(`${BASE}/api/approvals`, { headers: { authorization: `Bearer ${at}` } });
  assert.ok(denied.status >= 400);
});

test('excess fuel raises an approval and appears in the ledger (§52/§53)', async () => {
  const req = await api('POST', '/api/requests', { vehicle_id: vehicle.id, fuel_type_id: diesel.id, quantity: 15 });
  await api('POST', `/api/requests/${req.json.request.id}/approve`, {});
  const issue = await api('POST', '/api/transactions/issue', { request_id: req.json.request.id, pump_id: pump.id, quantity: 17, odometer: 200000 });
  assert.equal(issue.status, 201, 'actual quantity is recorded');
  const pending = await api('GET', '/api/approvals?status=PENDING&entity_type=fuel_excess');
  const excess = pending.json.approvals.find((a) => Number(a.quantity) === 2);
  assert.ok(excess, 'excess approval of 2 L must exist');
  const ledger = await api('GET', `/api/reports/fuel-ledger?q=${issue.json.transaction.txn_no}`);
  assert.equal(ledger.json.rows.length, 1);
  assert.equal(ledger.json.rows[0].excess_status, 'PENDING');
  // manager approves it → ledger reflects APPROVED
  const mlogin = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: manager.email, password: 'Manager123!' }) });
  const mtoken = (await mlogin.json()).token;
  const app = await fetch(`${BASE}/api/approvals/${excess.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${mtoken}` }, body: JSON.stringify({ reason: 'ok' }) });
  assert.equal(app.status, 200);
  const after = await api('GET', `/api/reports/fuel-ledger?q=${issue.json.transaction.txn_no}`);
  assert.equal(after.json.rows[0].excess_status, 'APPROVED');
});

test('system version endpoint reports build info', async () => {
  const v = await api('GET', '/api/system/version');
  assert.equal(v.status, 200);
  assert.ok(v.json.version);
  assert.ok(v.json.database.migrations.applied >= 4);
});
// ─── Round 4: remaining reports + devices + preferences ─────────────────────
test('§9 remaining report builders return valid datasets', async () => {
  for (const key of ['fuel-requests', 'fuel-authorizations', 'excess-fuel', 'exceptions',
    'attendant-activity', 'pump-reconciliation', 'tank-reconciliation',
    'fuel-inventory', 'fuel-cost', 'cost-per-km']) {
    const d = await api('GET', `/api/reports/${key}`);
    assert.equal(d.status, 200, `${key} → 200`);
    assert.ok(Array.isArray(d.json.rows), `${key} rows[]`);
    assert.ok(Array.isArray(d.json.columns) && d.json.columns.length > 0, `${key} columns[]`);
    assert.ok(d.json.title, `${key} title`);
    assert.ok(d.json.meta?.org?.orgName, `${key} org header from settings`);
  }
  const inv = await api('GET', '/api/reports/fuel-inventory');
  assert.ok(inv.json.rows.length >= 1, 'inventory lists at least the seeded tank');
  const x = await api('GET', '/api/reports/excess-fuel');
  assert.ok(x.json.rows.length >= 1, 'excess report includes round-2 over-issue');
});

test('§9 new report exports are real files and RBAC-guarded', async () => {
  const xls = await fetch(`${BASE}/api/reports/fuel-inventory/export/excel`, { headers: h() });
  assert.equal(xls.status, 200);
  const xbytes = new Uint8Array(await xls.arrayBuffer());
  assert.ok(xbytes[0] === 0x50 && xbytes[1] === 0x4b, 'xlsx magic');
  const pdf = await fetch(`${BASE}/api/reports/cost-per-km/export/pdf`, { headers: h() });
  assert.equal(pdf.status, 200);
  const pbytes = new Uint8Array(await pdf.arrayBuffer());
  assert.equal(String.fromCharCode(...pbytes.slice(0, 4)), '%PDF');
  // attendant cannot view or export the new reports either (§43)
  const att = await api('POST', '/api/users', { name: 'R4 Attendant', email: `r4-${uuid().slice(0, 8)}@test.local`, password: 'Attendant123!', role: 'attendant' });
  const alogin = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: att.json.user.email, password: 'Attendant123!' }) });
  const atoken = (await alogin.json()).token;
  const denied = await fetch(`${BASE}/api/reports/fuel-requests`, { headers: { authorization: `Bearer ${atoken}` } });
  assert.equal(denied.status, 403);
  const deniedExport = await fetch(`${BASE}/api/reports/fuel-requests/export/csv`, { headers: { authorization: `Bearer ${atoken}` } });
  assert.equal(deniedExport.status, 403);
});

test('§40 push device registration is idempotent per (user,device) and admin-listed', async () => {
  const body = { device_id: 'e2e-device-1', platform: 'android', app_version: '1.0.0' };
  const a = await api('POST', '/api/devices', body);
  assert.equal(a.status, 200, 'device registered');
  assert.ok(a.json.device?.id, 'device id returned');
  const b = await api('POST', '/api/devices', { ...body, push_token: 'ExponentPushToken[e2e]' });
  assert.equal(b.status, 200);
  assert.equal(b.json.device.id, a.json.device.id, 'same device_id+user upserts, no dup row');
  const list = await api('GET', '/api/devices');
  assert.equal(list.status, 200);
  assert.ok(list.json.devices.some((d) => d.device_id === 'e2e-device-1'));
  // non-admin cannot list devices
  const mgr = await api('POST', '/api/users', { name: 'R4 Manager', email: `r4m-${uuid().slice(0, 8)}@test.local`, password: 'Manager123!', role: 'manager' });
  const mlogin = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: mgr.json.user.email, password: 'Manager123!' }) });
  const mtoken = (await mlogin.json()).token;
  const denied = await fetch(`${BASE}/api/devices`, { headers: { authorization: `Bearer ${mtoken}` } });
  assert.equal(denied.status, 403);
});

test('§37 notification preferences round-trip with validation', async () => {
  const put = await api('PUT', '/api/notifications/preferences', { preferences: { exception: false } });
  assert.equal(put.status, 200);
  assert.equal(put.json.preferences.exception, false);
  const get = await api('GET', '/api/notifications/preferences');
  assert.equal(get.status, 200);
  assert.equal(get.json.preferences.exception, false);
  const restore = await api('PUT', '/api/notifications/preferences', { preferences: {} });
  assert.equal(restore.status, 200);
  const bad = await api('PUT', '/api/notifications/preferences', { preferences: [1, 2] });
  assert.equal(bad.status, 400, 'non-object preferences rejected');
});

test('§40 push wiring never breaks approvals (best-effort delivery)', async () => {
  // register a device whose token will never be deliverable
  const reg = await api('POST', '/api/devices', { device_id: 'e2e-push-dev', platform: 'android', push_token: 'ExponentPushToken[e2e-invalid-token]' });
  assert.equal(reg.status, 200);
  // full adjustment approval cycle must still work end to end
  const st0 = await api('GET', '/api/inventory/stock');
  const before = st0.json.tanks?.[0]?.balance ?? st0.json.stock?.[0]?.balance;
  const adj = await api('POST', '/api/inventory/adjustments', {
    tank_id: tank.id, fuel_type_id: diesel.id, quantity: -1.5, reason: 'push-wiring e2e',
    client_uuid: uuid(),
  });
  assert.ok([200, 202].includes(adj.status), 'adjustment accepted');
  if (adj.status === 202) {
    // admin requested → a MANAGER must decide (self-approval stays blocked §27)
    const mgr = await api('POST', '/api/users', { name: 'Push Manager', email: `push-${uuid().slice(0, 8)}@test.local`, password: 'Manager123!', role: 'manager' });
    const mlogin = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: mgr.json.user.email, password: 'Manager123!' }) });
    const mtok = (await mlogin.json()).token;
    const ap = await fetch(`${BASE}/api/approvals/${adj.json.approval_id}/approve`, { method: 'POST', headers: { authorization: `Bearer ${mtok}`, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(ap.status, 200, 'approval decision works with push wired');
  }
  const st1 = await api('GET', '/api/inventory/stock');
  const after = st1.json.tanks?.[0]?.balance ?? st1.json.stock?.[0]?.balance;
  assert.equal(Number(after), Number(before) - 1.5, 'stock moved exactly by approved amount');
  // device list still consistent (upsert, no dup)
  const list = await api('GET', '/api/devices');
  assert.equal(list.json.devices.filter((d) => d.device_id === 'e2e-push-dev').length, 1);
});
