// ============================================================================
// SYNC ENGINE — bridges the offline SQLite store and the central PostgreSQL
// authority. Safe to call at any time (offline → clean failure, no data loss).
//
//   PUSH: replay queued operations (idempotent on the server — replaying a
//         batch can never duplicate transactions).
//   PULL: refresh cached reference data, stock, requests and transactions.
//
// Full syncs run: at login, when connectivity returns, on app foreground,
// every 5 minutes while the app is open, and manually from the Sync tab.
// ============================================================================
import * as NetInfo from '@react-native-community/netinfo';
import { api } from './api';
import {
  kvGet, kvSet, deviceId, opsNeedingPush, removeOp, failOp, replaceReferenceData, wipeLocalData,
} from './db';

let syncing = false;
let lastResult = null;
const listeners = new Set();

export function onSyncChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify() {
  lastResult = { ...lastResult, syncing, at: new Date().toISOString() };
  for (const fn of listeners) fn(lastResult);
}
export function getSyncState() {
  return { ...(lastResult || {}), syncing };
}

export async function fullSync() {
  if (syncing) return lastResult;
  const net = await NetInfo.fetch();
  if (!net.isConnected) {
    lastResult = { ok: false, offline: true, message: 'Offline — changes stay queued in SQLite' };
    notify();
    return lastResult;
  }
  syncing = true;
  notify();
  try {
    const pushSummary = await pushQueue();
    const pullSummary = await pullServer();
    lastResult = {
      ok: true,
      pushed: pushSummary.pushed,
      failed: pushSummary.failed,
      held: pushSummary.held || false,
      pulled: pullSummary,
      message: pushSummary.held
        ? pushSummary.message
        : `Synced — ${pushSummary.pushed} pushed${pushSummary.failed ? `, ${pushSummary.failed} REJECTED (see Sync tab)` : ''}, reference data refreshed`,
    };
  } catch (err) {
    lastResult = { ok: false, message: err.message };
  } finally {
    syncing = false;
    notify();
  }
  return lastResult;
}

// ── PUSH: replay the outbox exactly once per op (server-side idempotency) ────
async function pushQueue() {
  // Safety: ops were created under a specific account. If a different
  // account is now signed in, HOLD them (never push, never delete) — they
  // sync when the original account signs back in. Survives session expiry.
  const owner = await kvGet('outbox_owner');
  const userRaw = await kvGet('user');
  const uid = userRaw ? (() => { try { return JSON.parse(userRaw).id; } catch { return null; } })() : null;
  if (owner && uid && owner !== uid) {
    return { pushed: 0, failed: 0, held: true,
      message: 'Pending operations were created under a different account — they are kept safely and will sync when that account signs in.' };
  }
  const ops = await opsNeedingPush(200);
  let pushed = 0;
  let failed = 0;
  if (ops.length > 0) {
    const id = await deviceId();
    const batch = ops.map((o) => ({
      op_id: o.op_id,
      type: o.type,
      payload: JSON.parse(o.payload),
      created_at: o.created_at,
    }));
    const res = await api.pushBatch(id, batch);
    for (const result of res.results || []) {
      if (result.status === 'applied' || result.status === 'duplicate') {
        await removeOp(result.op_id); // applied (or already applied) → done
        pushed += 1;
      } else {
        await failOp(result.op_id, result.message || 'rejected by server');
        failed += 1;
      }
    }
  }
  return { pushed, failed };
}

// Stock caches, written from one normalized shape:
//   stock_snapshot → per fuel type (Home "Current stock" cards)
//   stock_tanks    → per tank (fueling flow pump picker + low-stock warnings).
// Both come from the server-side ledger, so a receipt made anywhere (web or
// another device) is reflected on every device after its next pull/refresh.
async function writeStockCaches(data) {
  const byTank = (data.stock?.by_tank || []).map((t) => ({
    id: t.id,
    name: t.tank,
    code: t.code,
    balance: Number(t.balance || 0),
    capacity: Number(t.capacity || 0),
    fuel_type: t.fuel_type,
    pct_full: t.pct_full,
  }));
  await kvSet('stock_tanks', JSON.stringify(byTank));
  await kvSet('stock_snapshot', JSON.stringify(
    (data.stock?.by_fuel_type || []).map((s) => ({
      ...s,
      capacity: byTank.filter((t) => t.code === s.code).reduce((a, t) => a + t.capacity, 0),
    })),
  ));
}

// Fresh stock straight from the server for screens that must not show a stale
// snapshot (e.g. the fueling flow). Offline/unauthenticated → throws; callers
// keep the last cached values. Also refreshes both stock caches above.
export async function refreshStock() {
  const data = await api.stock(); // { by_fuel_type, by_tank }
  await writeStockCaches({ stock: data });
  return data;
}


// ── PULL: authoritative snapshot / delta ─────────────────────────────────────
async function pullServer() {
  const since = await kvGet('last_pull');
  const data = await api.pull(since || undefined);
  await replaceReferenceData(data);
  await writeStockCaches(data);
  await kvSet('last_pull', data.server_time);
  await kvSet('last_sync_success', new Date().toISOString());
  return {
    vehicles: data.reference.vehicles.length,
    requests: (data.requests || []).length,
    transactions: (data.transactions || []).length,
  };
}

export async function logoutWipe() {
  await wipeLocalData();
  lastResult = null;
}

// ── Auto-sync triggers (wired once from the root layout) ─────────────────────
export function startAutoSync() {
  // When connectivity returns after being offline.
  NetInfo.addEventListener((state) => {
    if (state.isConnected) fullSync();
  });
  // Every 5 minutes while the app is open.
  setInterval(() => fullSync(), 5 * 60 * 1000);
  // Kick off an initial sync shortly after launch.
  setTimeout(() => fullSync(), 1500);
}
