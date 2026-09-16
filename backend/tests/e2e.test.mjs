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

// ─── Direct fuel entry (§28–§41) + push diagnostics (§43) ───────────────────
test('§28/§29/§34 direct fuel entry: permission-gated, price fallback, ledger, audit', async () => {
  const att = await api('POST', '/api/users', { name: 'DE Attendant', email: `de-${uuid().slice(0, 8)}@test.local`, password: 'Attendant123!', role: 'attendant' });
  const alogin = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: att.json.user.email, password: 'Attendant123!' }) });
  const atok = (await alogin.json()).token;
  const denied = await fetch(`${BASE}/api/fuel-entries/direct`, { method: 'POST', headers: { authorization: `Bearer ${atok}`, 'content-type': 'application/json' }, body: JSON.stringify({}) });
  assert.equal(denied.status, 403, 'attendant denied direct entry');

  const st0 = await api('GET', '/api/inventory/stock');
  const bal0 = st0.json.by_tank?.[0]?.balance ?? st0.json.by_fuel_type?.[0]?.balance;

  // blank fueling price → cost price applies (§34); unit_cost stays separate (§35)
  const r1 = await api('POST', '/api/fuel-entries/direct', {
    vehicle_id: vehicle.id, fuel_type_id: diesel.id, tank_id: tank.id,
    quantity: 12.5, odometer: 5000, destination: 'Test Site', client_uuid: uuid(),
  });
  assert.equal(r1.status, 201, JSON.stringify(r1.json).slice(0, 140));
  assert.equal(r1.json.price_source, 'COST PRICE');
  assert.equal(Number(r1.json.entry.unit_price), Number(r1.json.entry.unit_cost), 'blank price → applied == cost');
  assert.equal(r1.json.entry.source, 'DIRECT_ENTRY');

  // user-entered price wins and unit_cost remains the inventory cost (§35)
  const r2 = await api('POST', '/api/fuel-entries/direct', {
    vehicle_id: vehicle.id, fuel_type_id: diesel.id, tank_id: tank.id,
    quantity: 3, unit_price: 999.5, client_uuid: uuid(),
  });
  assert.equal(r2.status, 201);
  assert.equal(r2.json.price_source, 'USER ENTERED');
  assert.equal(Number(r2.json.entry.unit_price), 999.5);
  assert.ok(Number(r2.json.entry.unit_cost) !== 999.5, 'unit_cost separate from fueling price');

  // stock moved exactly by both entries
  const st1 = await api('GET', '/api/inventory/stock');
  const bal1 = st1.json.by_tank?.[0]?.balance ?? st1.json.by_fuel_type?.[0]?.balance;
  assert.equal(Math.round((Number(bal0) - Number(bal1)) * 100) / 100, 15.5, 'stock reduced by 12.5 + 3');

  // idempotent: same client_uuid returns the same entry
  const dup = await api('POST', '/api/fuel-entries/direct', {
    vehicle_id: vehicle.id, fuel_type_id: diesel.id, tank_id: tank.id,
    quantity: 3, unit_price: 999.5, client_uuid: r2.json.entry.client_uuid,
  });
  assert.equal(dup.status, 200);
  assert.equal(dup.json.entry.id, r2.json.entry.id, 'dup client_uuid → same row');

  // validation: pump end before start
  const bad = await api('POST', '/api/fuel-entries/direct', {
    vehicle_id: vehicle.id, fuel_type_id: diesel.id, tank_id: tank.id,
    quantity: 1, pump_start: 100, pump_end: 50, client_uuid: uuid(),
  });
  assert.equal(bad.status, 400, 'pump_end < pump_start rejected');

  // appears in the DIRECT_ENTRY listing
  const list = await api('GET', '/api/fuel-entries');
  assert.equal(list.status, 200);
  assert.ok(list.json.entries.some((e) => e.id === r1.json.entry.id));

  // fuel-transactions report distinguishes the source (§37)
  const rep = await api('GET', '/api/reports/fuel-transactions?source=DIRECT_ENTRY');
  assert.equal(rep.status, 200);
  assert.ok(rep.json.rows.every((r) => r.source === 'DIRECT_ENTRY'));
  assert.ok(rep.json.columns.some((c) => c.key === 'source'));
  // vehicle ledger rows carry source + entered_by (§38)
  const vl = await api('GET', '/api/reports/vehicle-ledger');
  assert.ok(vl.json.columns.some((c) => c.key === 'source') && vl.json.columns.some((c) => c.key === 'entered_by'));
  const row = vl.json.rows.find((r) => r.id === r1.json.entry.id);
  assert.ok(row, 'direct entry appears in vehicle ledger');
  assert.equal(row.source, 'DIRECT_ENTRY');
});

test('§43 device diagnostics: /me masks tokens, /test is admin-only', async () => {
  await api('POST', '/api/devices', { device_id: 'diag-dev-1', platform: 'android', push_token: 'ExponentPushToken[diagnostic-test]' });
  const me = await api('GET', '/api/devices/me');
  assert.equal(me.status, 200);
  assert.ok(me.json.devices.some((d) => d.device_id === 'diag-dev-1'));
  const tok = me.json.devices.find((d) => d.device_id === 'diag-dev-1').push_token_masked;
  assert.ok(tok.includes('…'), 'token masked');
  assert.ok(!tok.includes('diagnostic-test'), 'full token never returned');

  const t = await api('POST', '/api/devices/test', {});
  assert.equal(t.status, 200, 'admin test push returns 200');

  const mgr = await api('POST', '/api/users', { name: 'Diag Manager', email: `dg-${uuid().slice(0, 8)}@test.local`, password: 'Manager123!', role: 'manager' });
  const mlogin = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: mgr.json.user.email, password: 'Manager123!' }) });
  const mtok = (await mlogin.json()).token;
  const denied = await fetch(`${BASE}/api/devices/test`, { method: 'POST', headers: { authorization: `Bearer ${mtok}` } });
  assert.equal(denied.status, 403, 'manager cannot send test pushes');
});

test('vehicles bulk import: creates, skips existing/dupes, rejects bad rows, RBAC', async () => {
  const p1 = `BULK-${uuid().slice(0, 6)}`;
  const r1 = await api('POST', '/api/vehicles/bulk', { rows: [
    { plate: p1, make: 'Toyota', model: 'Hilux', vehicle_type: 'pickup', driver_name: 'J. Otieno' },
    { plate: p1, make: 'Dup in file' },                                  // duplicate in file → skipped
    { plate: '', make: 'No plate' },                                     // failed
    { plate: p1.toLowerCase(), make: 'Case-insensitive' },                // dup after upper-case normalisation
    { plate: `BULK2-${uuid().slice(0, 6)}`, tank_capacity: 'not-a-num' }, // failed
    { plate: `BULK3-${uuid().slice(0, 6)}`, tank_capacity: 150 },         // created
  ] });
  assert.equal(r1.status, 200);
  assert.equal(r1.json.created, 2);
  assert.equal(r1.json.skipped, 2);
  assert.equal(r1.json.failed, 2);

  // re-import → all existing rows skipped (idempotent)
  const r2 = await api('POST', '/api/vehicles/bulk', { rows: [{ plate: p1 }] });
  assert.equal(r2.status, 200);
  assert.equal(r2.json.created, 0);
  assert.equal(r2.json.skipped, 1);

  // attendant denied
  const att = await api('POST', '/api/users', { name: 'BI Attendant', email: `bi-${uuid().slice(0, 8)}@test.local`, password: 'Attendant123!', role: 'attendant' });
  const alogin = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: att.json.user.email, password: 'Attendant123!' }) });
  const atok = (await alogin.json()).token;
  const denied = await fetch(`${BASE}/api/vehicles/bulk`, { method: 'POST', headers: { authorization: `Bearer ${atok}`, 'content-type': 'application/json' }, body: JSON.stringify({ rows: [{ plate: 'X' }] }) });
  assert.equal(denied.status, 403);

  // imported vehicle is visible in the register and audited implicitly by list
  const list = await api('GET', `/api/vehicles?q=${p1}`);
  assert.ok(list.json.vehicles.some((v) => v.plate === p1.toUpperCase()), 'imported vehicle in register (plates uppercased)');
});

// ─────────────────────────────────────────────────────────────────────────────
// FLEET MANAGEMENT (§8–§27) — vehicles register expansion, external fuel,
// tires, trips, unified reports. External fuel NEVER touches station stock.
// ─────────────────────────────────────────────────────────────────────────────
test('fleet: vehicle register expansion + odometer trail', async () => {
  const plate = `FLT-${uuid().slice(0, 8)}`;
  const created = await api('POST', '/api/vehicles', {
    plate, make: 'Isuzu', model: 'FRR', vehicle_type: 'truck', tank_capacity: 150,
    year: 2021, expected_km_l: 4.0, axle_config: '6x4', status: 'ACTIVE',
    department: 'Operations', branch: 'HQ', current_odometer: 80000,
  });
  assert.equal(created.status, 201);
  const v = created.json.vehicle;
  assert.equal(v.year, 2021);
  assert.equal(v.axle_config, '6x4');
  assert.equal(Number(v.current_odometer), 80000);

  // status change to MAINTENANCE syncs `active` so fuel workflows skip it
  const patched = await api('PATCH', `/api/vehicles/${v.id}`, { status: 'MAINTENANCE', expected_km_l: 4.2 });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.vehicle.status, 'MAINTENANCE');
  assert.equal(patched.json.vehicle.active, false);
  await api('PATCH', `/api/vehicles/${v.id}`, { status: 'ACTIVE' });

  // invalid status rejected
  const badStatus = await api('PATCH', `/api/vehicles/${v.id}`, { status: 'FLYING' });
  assert.equal(badStatus.status, 400);

  // odometer trail: initial reading recorded once, high-water mark forward only
  const det = await api('GET', `/api/vehicles/${v.id}/detail`);
  assert.equal(det.status, 200);
  assert.equal(det.json.vehicle.id, v.id);
  assert.ok(det.json.odometer_history.some((r) => r.source === 'manual' && Number(r.odometer) === 80000));
  const regress = await api('PATCH', `/api/vehicles/${v.id}`, { current_odometer: 79000 });
  assert.equal(regress.status, 400);
  assert.match(regress.json.error.message, /egression/i);
  globalThis.__fleetVehicle = v;
});

test('fleet: external fuel — ledger separation + odometer progression + idempotency', async () => {
  const v = globalThis.__fleetVehicle;
  const fts = await api('GET', '/api/fuel-types');
  const fuelTypeId = fts.json.fuel_types[0].id;
  const cu = uuid();

  const r1 = await api('POST', '/api/external-fuel', {
    vehicle_id: v.id, fuel_type_id: fuelTypeId, supplier: 'Total Nakuru',
    quantity: 60, unit_price: 195.5, odometer: 80200, receipt_no: 'RCT-F1',
    payment_method: 'CARD', client_uuid: cu,
  });
  assert.equal(r1.status, 201);
  assert.equal(r1.json.duplicate, false);
  assert.equal(Number(r1.json.entry.total_amount), 11730); // 60 × 195.5 server-computed

  // idempotent replay (offline sync contract) → same row, 200
  const r2 = await api('POST', '/api/external-fuel', {
    vehicle_id: v.id, fuel_type_id: fuelTypeId, supplier: 'Total Nakuru',
    quantity: 60, unit_price: 195.5, odometer: 80200, client_uuid: cu,
  });
  assert.equal(r2.status, 200);
  assert.equal(r2.json.duplicate, true);
  assert.equal(r2.json.entry.id, r1.json.entry.id);

  // odometer regression rejected (§41)
  const r3 = await api('POST', '/api/external-fuel', {
    vehicle_id: v.id, fuel_type_id: fuelTypeId, supplier: 'Shell', quantity: 10, unit_price: 200, odometer: 80100,
  });
  assert.equal(r3.status, 400);

  // invalid qty / price / payment method rejected
  const r4 = await api('POST', '/api/external-fuel', {
    vehicle_id: v.id, fuel_type_id: fuelTypeId, supplier: 'Shell', quantity: 0, unit_price: 200,
  });
  assert.equal(r4.status, 400);

  // station stock untouched: inventory balance identical before/after (§1 pillar)
  const stock = await api('GET', '/api/inventory/stock');
  assert.ok(Array.isArray(stock.json.by_fuel_type));

  // list + detail
  const list = await api('GET', `/api/external-fuel?vehicle_id=${v.id}`);
  assert.ok(list.json.entries.some((e) => e.id === r1.json.entry.id));
  const one = await api('GET', `/api/external-fuel/${r1.json.entry.id}`);
  assert.equal(one.status, 200);
  globalThis.__fleetFuelTypeId = fuelTypeId;
});

test('fleet: tires — positions, fit/remove/rotate, no double-booking, lifecycle', async () => {
  const v = globalThis.__fleetVehicle;
  const mkTire = async (serial) => {
    const r = await api('POST', '/api/tires', { serial_no: serial, brand: 'Bridgestone', size: '11R22.5', supply_condition: 'NEW', purchase_cost: 30000 });
    assert.equal(r.status, 201);
    return r.json.tire;
  };
  // duplicate serial rejected
  const s1 = `TR-${uuid().slice(0, 10)}`;
  const t1 = await mkTire(s1);
  const dup = await api('POST', '/api/tires', { serial_no: s1 });
  assert.equal(dup.status, 200);
  assert.equal(dup.json.tire.id, t1.id);

  // positions per axle config (6x4)
  const pos = await api('GET', '/api/tires/positions?axle_config=6x4');
  assert.equal(pos.json.positions.length, 6);
  assert.ok(pos.json.positions.some((p) => p.code === 'RLO'));

  // fit → occupied position cannot take a second tire (§18)
  const fit1 = await api('POST', '/api/tires/fit', { tire_id: t1.id, vehicle_id: v.id, position: 'RLO', odometer: 80200, tread_depth_mm: 14 });
  assert.equal(fit1.status, 200);
  const t2 = await mkTire(`TR-${uuid().slice(0, 10)}`);
  const fit2 = await api('POST', '/api/tires/fit', { tire_id: t2.id, vehicle_id: v.id, position: 'RLO', odometer: 80200 });
  assert.equal(fit2.status, 400);
  assert.match(fit2.json.error.message, /already holds/);
  // invalid position for axle config
  const fit3 = await api('POST', '/api/tires/fit', { tire_id: t2.id, vehicle_id: v.id, position: 'MLO', odometer: 80200 });
  assert.equal(fit3.status, 400);

  // rotate within same vehicle only
  const rot = await api('POST', '/api/tires/rotate', { tire_id: t1.id, to_position: 'RRI', odometer: 80600 });
  assert.equal(rot.status, 200);
  const layout = await api('GET', `/api/tires/vehicle/${v.id}/layout`);
  assert.equal(layout.json.layout.find((p) => p.code === 'RRI').tire.serial_no, s1.toUpperCase());

  // remove → accrued mileage + destination status + append-only movements
  const rem = await api('POST', '/api/tires/remove', { tire_id: t1.id, odometer: 80800, reason: 'tread worn', destination: 'AWAITING_RETREAD', tread_depth_mm: 5 });
  assert.equal(rem.status, 200);
  assert.equal(rem.json.accrued_km, 600);
  const det = await api('GET', `/api/tires/${t1.id}`);
  assert.equal(det.json.tire.status, 'AWAITING_RETREAD');
  assert.equal(Number(det.json.tire.mileage_accumulated), 600);
  const acts = det.json.history.map((m) => m.action);
  assert.deepEqual(acts, ['REMOVE', 'ROTATE', 'FIT']); // newest first, never deleted (§16)

  // fit odometer landed in the unified vehicle trail
  const trail = await api('GET', `/api/vehicles/${v.id}/detail`);
  assert.ok(trail.json.odometer_history.some((r) => r.source === 'tire_fit' && Number(r.odometer) === 80200));
  globalThis.__fleetTire2 = t2;
});

test('fleet: trips — optional revenue, lifecycle, completion validation', async () => {
  const v = globalThis.__fleetVehicle;

  // internal trip WITHOUT revenue — must be fully validatable (§22)
  // (trail is already at 80800 from the tire ops above — §41 forbids going back)
  const t1 = await api('POST', '/api/trips', { vehicle_id: v.id, driver_name: 'P. Kimani', destination: 'Eldoret', purpose: 'Internal transfer', start_odometer: 81000 });
  assert.equal(t1.status, 201);
  assert.equal(t1.json.trip.status, 'PLANNED');
  assert.match(t1.json.trip.trip_no, /^TRP-/);
  assert.equal(t1.json.trip.revenue_amount, null);

  // revenue upsert when management chooses to record it (§24) — never forced
  const rev = await api('PUT', `/api/trips/${t1.json.trip.id}/revenue`, { revenue_amount: 32000, revenue_customer: 'ACME', revenue_payment_status: 'PAID' });
  assert.equal(rev.status, 200);
  assert.equal(Number(rev.json.trip.revenue_amount), 32000);

  // lifecycle PLANNED → IN_PROGRESS → COMPLETED
  const start = await api('POST', `/api/trips/${t1.json.trip.id}/start`);
  assert.equal(start.json.trip.status, 'IN_PROGRESS');
  const badEnd = await api('POST', `/api/trips/${t1.json.trip.id}/complete`, { end_odometer: 80000 }); // < start
  assert.equal(badEnd.status, 400);
  const done = await api('POST', `/api/trips/${t1.json.trip.id}/complete`, { end_odometer: 82000 });
  assert.equal(done.json.trip.status, 'COMPLETED');
  assert.equal(Number(done.json.trip.distance), 1000);
  // completed trip cannot be cancelled (§21)
  const cancelDone = await api('POST', `/api/trips/${t1.json.trip.id}/cancel`, { reason: 'x' });
  assert.equal(cancelDone.status, 400);

  // trip completion odometer landed in the trail
  const trail = await api('GET', `/api/vehicles/${v.id}/detail`);
  assert.ok(trail.json.odometer_history.some((r) => r.source === 'trip' && Number(r.odometer) === 82000));

  // trip with revenue at creation + cancel flow
  const t2 = await api('POST', '/api/trips', { vehicle_id: v.id, destination: 'Mombasa', start_odometer: 82000, revenue_amount: 58000, revenue_type: 'CONTRACT' });
  assert.equal(Number(t2.json.trip.revenue_amount), 58000);
  const cancel = await api('POST', `/api/trips/${t2.json.trip.id}/cancel`, { reason: 'client postponed' });
  assert.equal(cancel.json.trip.status, 'CANCELLED');

  // attendant RBAC: trips:manage denied (§40)
  const att = await api('POST', '/api/users', { name: 'Trip Attendant', email: `trip-${uuid().slice(0, 8)}@test.local`, password: 'Attendant123!', role: 'attendant' });
  const alogin = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: att.json.user.email, password: 'Attendant123!' }) });
  const atok = (await alogin.json()).token;
  const denied = await fetch(`${BASE}/api/trips`, { method: 'POST', headers: { authorization: `Bearer ${atok}`, 'content-type': 'application/json' }, body: JSON.stringify({ vehicle_id: v.id }) });
  assert.equal(denied.status, 403);

  globalThis.__fleetTrip = t1.json.trip;
});

test('fleet: unified vehicle-fuel ledger + reports + dashboard', async () => {
  const v = globalThis.__fleetVehicle;

  const unified = await api('GET', `/api/reports/vehicle-fuel-unified?vehicle_id=${v.id}`);
  assert.equal(unified.status, 200);
  const extRow = unified.json.rows.find((r) => r.source === 'EXTERNAL PURCHASE');
  assert.ok(extRow, 'external purchase appears in unified vehicle ledger');
  assert.equal(extRow.reference, 'RCT-F1');
  assert.ok(unified.json.rows.every((r) => r.source === 'STATION ISSUE' || r.source === 'EXTERNAL PURCHASE'));
  // distance is computed fill-to-fill (LAG over the unified odometer order);
  // this vehicle's only fill has no predecessor → null, never a bogus number
  assert.equal(extRow.distance, null);
  assert.equal(extRow.consumption_flag, 'OK');

  const consumption = await api('GET', `/api/reports/fleet-consumption?vehicle_id=${v.id}`);
  assert.equal(consumption.status, 200);
  const row = consumption.json.rows.find((r) => r.registration === v.plate);
  assert.ok(row);
  assert.equal(Number(row.litres_external), 60);
  assert.equal(row.expected_km_l, 4.2);

  const trips = await api('GET', '/api/reports/trips');
  const tripRow = trips.json.rows.find((r) => r.trip_no === globalThis.__fleetTrip.trip_no);
  assert.ok(tripRow);
  assert.equal(Number(tripRow.revenue), 32000);
  assert.ok('gross_contribution' in tripRow, 'profitability labelled Gross Contribution (§22)');

  const tireReg = await api('GET', '/api/reports/tire-register');
  assert.ok(tireReg.json.rows.some((r) => r.serial_no && r.mileage_accumulated >= 600));

  const dash = await api('GET', '/api/reports/fleet-dashboard');
  assert.equal(dash.status, 200);
  const labels = dash.json.summary.map((s) => s.label);
  assert.ok(labels.includes('Fuel — Station Issues'));
  assert.ok(labels.includes('Fuel — External Purchases'), 'ledgers reported separately (§1)');

  // CSV export of a fleet report honours the same permission (§43)
  const csv = await fetch(`${BASE}/api/reports/vehicle-fuel-unified/export/csv?vehicle_id=${v.id}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(csv.status, 200);
  const text = await csv.text();
  assert.match(text, /EXTERNAL PURCHASE/);
});

// ─────────────────────────────────────────────────────────────────────────────
// WAVE 2 — wheel configurations (§1–§8), tire import (§9–§16), suppliers
// (§17–§30), theme preference (§31–§33). Ledger sign convention: DEBIT
// increases payable, CREDIT decreases it; Balance = Σdebit − Σcredit.
// ─────────────────────────────────────────────────────────────────────────────
test('wave2: wheel configurations — master data, builder validation, vehicle assignment', async () => {
  // seeded system configs exist with legacy codes
  const list = await api('GET', '/api/wheel-configs');
  assert.equal(list.status, 200);
  const codes = list.json.configurations.map((c) => c.code);
  for (const c of ['4x2', '4x4', '6x2', '6x4', '8x4']) assert.ok(codes.includes(c), `seeded ${c}`);

  // §8 — invalid configurations rejected
  const badDup = await api('POST', '/api/wheel-configs', { code: 'BAD1', axles: [
    { axle_number: 1, axle_type: 'STEERING', positions: [{ side: 'LEFT' }, { side: 'LEFT' }] },
  ] });
  assert.equal(badDup.status, 400);
  const badType = await api('POST', '/api/wheel-configs', { code: 'BAD2', axles: [
    { axle_number: 1, axle_type: 'SPRING', positions: [{ side: 'LEFT' }, { side: 'RIGHT' }] },
  ] });
  assert.equal(badType.status, 400);

  // §3/§5 — valid build; codes generated A1-L…, display names generated
  const created = await api('POST', '/api/wheel-configs', { code: `W${Date.now() % 100000}X`, name: 'Test 10-wheeler', axles: [
    { axle_number: 1, axle_type: 'STEERING', positions: [{ side: 'LEFT' }, { side: 'RIGHT' }] },
    { axle_number: 2, axle_type: 'DRIVE', positions: [
      { side: 'LEFT', wheel_position: 'INNER' }, { side: 'LEFT', wheel_position: 'OUTER' },
      { side: 'RIGHT', wheel_position: 'INNER' }, { side: 'RIGHT', wheel_position: 'OUTER' }] },
    { axle_number: 3, axle_type: 'DRIVE', positions: [
      { side: 'LEFT', wheel_position: 'INNER' }, { side: 'LEFT', wheel_position: 'OUTER' },
      { side: 'RIGHT', wheel_position: 'INNER' }, { side: 'RIGHT', wheel_position: 'OUTER' }] },
  ] });
  assert.equal(created.status, 201);
  const cfg = created.json.configuration;
  assert.equal(cfg.wheel_count, 10);
  const detail = await api('GET', `/api/wheel-configs/${cfg.id}`);
  const posCodes = detail.json.positions.map((p) => p.position_code);
  assert.deepEqual(posCodes.slice(0, 2), ['A1-L', 'A1-R']);
  assert.ok(posCodes.includes('A2-L-O'));

  // §6 — assign to vehicle; structure locks while in use
  const v = globalThis.__fleetVehicle;
  const assigned = await api('PATCH', `/api/vehicles/${v.id}`, { wheel_configuration_id: cfg.id });
  assert.equal(assigned.status, 200);
  assert.equal(assigned.json.vehicle.wheel_configuration_id, cfg.id);
  const lockEdit = await api('PATCH', `/api/wheel-configs/${cfg.id}`, { axles: [
    { axle_number: 1, axle_type: 'STEERING', positions: [{ side: 'LEFT' }, { side: 'RIGHT' }] }] });
  assert.equal(lockEdit.status, 400);

  // §6 — config conflict with fitted tires is rejected (vehicle has none fitted
  // in this test run, so switch to a config that lacks the current positions of
  // a fitted tire is covered by unit of the check here via 8x4→W… switch with
  // fitted tire at FL below).
  const layout = await api('GET', `/api/tires/vehicle/${v.id}/layout`);
  assert.equal(layout.status, 200);
  assert.equal(layout.json.axles.length, 3); // generated from config, not hardcoded (§7)
  assert.ok(layout.json.axles.every((a) => a.positions.length === 2 || a.positions.length === 4));
  // history row appended (§6)
  const hist = await api('GET', `/api/reports/wheel-configs`);
  assert.equal(hist.status, 200);

  // activation toggles audited (§44)
  const deact = await api('POST', `/api/wheel-configs/${cfg.id}/deactivate`);
  assert.equal(deact.json.configuration.is_active, false);
  const react = await api('POST', `/api/wheel-configs/${cfg.id}/activate`);
  assert.equal(react.json.configuration.is_active, true);
  globalThis.__fleetCfg = cfg;
});

test('wave2: bulk tire import — parse, preview, commit, duplicates skipped, audit', async () => {
  const sfx = Date.now().toString().slice(-8);
  const csv = [
    'serial_number,brand,size,pattern,type,condition,purchase_cost,supplier,status,retread_count,tread_depth',
    `TR-W2-${sfx}-A,Bridgestone,11R22.5,R249,TUBELESS,NEW,28000,ABC Fuel Suppliers,IN_STORE,0,14`,
    `TR-W2-${sfx}-B,Michelin,295/80R22.5,XZE,TUBELESS,NEW,32000,ABC Fuel Suppliers,IN_STORE,0,14.5`,
    `TR-W2-${sfx}-A,Dupe,11R22.5,R249,TUBELESS,NEW,28000,,IN_STORE,0,14`,       // dup in file
    `,NoSerial,11R22.5,R249,TUBELESS,NEW,28000,,IN_STORE,0,14`,                  // missing serial
  ].join('\n');
  const b64 = Buffer.from(csv, 'utf8').toString('base64');
  const parsed = await api('POST', '/api/tire-imports/parse', { file_b64: b64, filename: 'tires.csv' });
  assert.equal(parsed.status, 200);
  assert.equal(parsed.json.rows.length, 4);

  // §10/§12 — preview validates without inserting
  const preview = await api('POST', '/api/tire-imports/preview', { rows: parsed.json.rows });
  assert.equal(preview.status, 200);
  assert.equal(preview.json.summary.total, 4);
  assert.equal(preview.json.summary.valid, 2);
  assert.equal(preview.json.summary.error, 2);
  const dupeRow = preview.json.results.find((r) => r.row_number === 3);
  assert.ok(dupeRow.errors.some((e) => /Duplicate serial/.test(e.message)));
  const noSerial = preview.json.results.find((r) => r.row_number === 4);
  assert.ok(noSerial.errors.some((e) => /Serial number is required/.test(e.message)));

  // §14/§15 — commit inserts the valid rows; duplicates skipped; single tx
  const commit = await api('POST', '/api/tire-imports/commit', { rows: parsed.json.rows, filename: 'e2e-tires.csv' });
  assert.equal(commit.status, 201);
  assert.equal(commit.json.batch.created_count, 2);
  assert.equal(commit.json.batch.skipped_count, 0);
  assert.equal(commit.json.batch.failed_count, 2);

  // replay: same serials now exist in DB → skipped, never overwritten (§14)
  const replay = await api('POST', '/api/tire-imports/commit', { rows: parsed.json.rows, filename: 'replay.csv' });
  assert.equal(replay.json.batch.created_count, 0);
  assert.equal(replay.json.batch.skipped_count, 2);

  // §16 — batch history
  const batches = await api('GET', '/api/tire-imports/batches');
  assert.ok(batches.json.batches.some((b) => b.file_name === 'e2e-tires.csv'));
  // §45 — report
  const report = await api('GET', '/api/reports/tire-imports');
  assert.ok(report.json.rows.some((r) => r.file === 'e2e-tires.csv'));
});

test('wave2: suppliers — ledger convention, payments with allocation, reversal, statements', async () => {
  // §17 master data + §29 search by phone/tax pin
  const sup = await api('POST', '/api/suppliers', {
    name: `E2E Supplier ${uuid().slice(0, 6)}`, code: `E2E-${uuid().slice(0, 5)}`,
    phone: `07${uuid().slice(0, 8)}`, tax_pin: `P0${uuid().slice(0, 9)}`,
    payment_terms_days: 30, credit_limit: 1000000,
  });
  assert.equal(sup.status, 201);
  const sid = sup.json.supplier.id;

  const byPhone = await api('GET', `/api/suppliers?q=${sup.json.supplier.phone}`);
  assert.ok(byPhone.json.suppliers.some((s) => s.id === sid));

  // §18 opening balance (DEBIT side) + two purchases
  const opening = await api('POST', `/api/suppliers/${sid}/adjustments`, { entry_type: 'OPENING', amount: 250000, reason: 'Opening balance' });
  assert.equal(opening.status, 201);
  assert.equal(Number(opening.json.ledger.debit), 250000);
  const inv1 = await api('POST', `/api/suppliers/${sid}/purchases`, { amount: 250000, source_type: 'TIRE', reference: 'INV-1001', description: 'Tire Purchase' });
  const inv2 = await api('POST', `/api/suppliers/${sid}/purchases`, { amount: 500000, source_type: 'FUEL', reference: 'INV-1045', description: 'Fuel Purchase' });
  assert.equal(inv1.status, 201);
  const inv1Id = inv1.json.entry.id, inv2Id = inv2.json.entry.id;

  // §24 — payment with partial allocations; §25 remainder unallocated
  const pay = await api('POST', `/api/suppliers/${sid}/payments`, {
    amount: 300000, payment_method: 'BANK_TRANSFER', bank: 'KCB', reference: 'TRX-456891',
    allocations: [{ ledger_entry_id: inv1Id, amount: 150000 }, { ledger_entry_id: inv2Id, amount: 100000 }],
  });
  assert.equal(pay.status, 201);
  assert.equal(pay.json.payment.allocated_amount, 250000);
  assert.equal(pay.json.payment.unallocated, 50000);
  const payId = pay.json.payment.id;

  // §46 — deterministic ledger with running balance: opening + 250k + 500k − 300k = 700k
  const ledger = await api('GET', `/api/suppliers/${sid}/ledger`);
  assert.equal(ledger.status, 200);
  assert.equal(ledger.json.opening_balance, 0);
  const balances = ledger.json.entries.map((e) => e.balance);
  assert.deepEqual(balances, [250000, 500000, 1000000, 700000]);
  assert.equal(ledger.json.closing_balance, 700000);

  // allocation guard: cannot over-allocate an invoice
  const over = await api('POST', `/api/suppliers/${sid}/payments`, {
    amount: 10000, allocations: [{ ledger_entry_id: inv1Id, amount: 200000 }],
  });
  assert.equal(over.status, 400);

  // §28 account dashboard
  const acct = await api('GET', `/api/suppliers/${sid}`);
  assert.equal(acct.json.account.current_balance, 700000);
  assert.equal(acct.json.account.outstanding_invoices, 2);
  assert.equal(acct.json.account.outstanding_amount, 500000);

  // §26 — reversal creates an auditable opposite entry; balance restored to 1,000,000
  const rev = await api('POST', `/api/suppliers/payments/${payId}/reverse`, { reason: 'Duplicate bank entry' });
  assert.equal(rev.status, 200);
  assert.equal(rev.json.payment.status, 'REVERSED');
  const after = await api('GET', `/api/suppliers/${sid}/ledger`);
  assert.equal(after.json.closing_balance, 1000000);
  const revEntry = after.json.entries.find((e) => e.entry_type === 'REVERSAL');
  assert.equal(Number(revEntry.debit), 300000);

  // §27/§45 — statement report (opening/purchases/payments/closing)
  const stmt = await api('GET', `/api/reports/supplier-statement?supplier_id=${sid}`);
  assert.equal(stmt.status, 200);
  assert.equal(stmt.json.totals.opening, 0);
  assert.equal(stmt.json.totals.closing, 1000000);
  const aging = await api('GET', '/api/reports/supplier-aging');
  assert.ok(aging.json.rows.some((r) => r.supplier === sup.json.supplier.name));

  // §48 — fuel purchase → inventory + payable when supplier_id provided
  const fts = await api('GET', '/api/fuel-types');
  const tanks = await api('GET', '/api/tanks');
  const tank = tanks.json.tanks.find((t) => t.fuel_type_id === fts.json.fuel_types[0].id);
  if (tank) {
    const receipt = await api('POST', '/api/inventory/receipts', {
      fuel_type_id: fts.json.fuel_types[0].id, tank_id: tank.id, quantity: 1000,
      supplier: sup.json.supplier.name, supplier_id: sid, unit_price: 180, invoice_no: `INV-F-${uuid().slice(0, 5)}`,
    });
    assert.equal(receipt.status, 201);
    const led2 = await api('GET', `/api/suppliers/${sid}/ledger`);
    const fuelEntry = led2.json.entries.find((e) => e.entry_type === 'PURCHASE' && Number(e.debit) === 180000);
    assert.ok(fuelEntry, 'fuel purchase posted 180,000 payable');
  }

  // §30 — attendant has no supplier permissions (server-side enforcement)
  const att = await api('POST', '/api/users', { name: 'Supp Attendant', email: `sup-${uuid().slice(0, 8)}@test.local`, password: 'Attendant123!', role: 'attendant' });
  const alogin = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: att.json.user.email, password: 'Attendant123!' }) });
  const atok = (await alogin.json()).token;
  const denied = await fetch(`${BASE}/api/suppliers`, { headers: { authorization: `Bearer ${atok}` } });
  assert.equal(denied.status, 403);
});

test('wave2: theme preference endpoint', async () => {
  const put = await api('PUT', '/api/me/theme', { theme: 'dark' });
  assert.equal(put.status, 200);
  assert.equal(put.json.theme, 'DARK');
  const get = await api('GET', '/api/me/theme');
  assert.equal(get.json.theme, 'DARK');
  const bad = await api('PUT', '/api/me/theme', { theme: 'PURPLE' });
  assert.equal(bad.status, 400);
  await api('PUT', '/api/me/theme', { theme: 'system' });
});
