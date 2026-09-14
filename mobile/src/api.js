// HTTP client for the Fleet Fuel API.
// Base URL comes from EXPO_PUBLIC_API_URL (build-time env, see .env.example).
// Never hard-code localhost or LAN IPs in production builds.
//
// ── Centralized authentication failure handling (spec §5/§6) ────────────────
// EVERY request goes through request() here. A 401 from any authenticated
// endpoint clears the local session exactly once and fires the single
// unauthorized handler registered by AuthProvider — no screen implements its
// own expiry logic, and no redirect loop can occur (the session is cleared
// BEFORE the handler runs; the handler only updates UI state).
import { kvGet, kvRemove, kvSet } from './db';

export const API_URL = (process.env.EXPO_PUBLIC_API_URL || '').replace(/\/+$/, '');

export function apiUrl(path) {
  return API_URL + path;
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

let unauthorizedHandler = null;
export function setUnauthorizedHandler(fn) { unauthorizedHandler = fn; }

async function request(path, { method = 'GET', body, token } = {}) {
  if (!API_URL) throw new ApiError('EXPO_PUBLIC_API_URL is not configured (mobile/.env)', 0);
  const t = token ?? (await kvGet('token'));
  let res;
  try {
    res = await fetch(apiUrl(path), {
      method,
      headers: {
        'content-type': 'application/json',
        ...(t ? { authorization: `Bearer ${t}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError('Network unreachable — working offline', 0);
  }
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    // Session expired/invalid → clear locally and let AuthProvider route to
    // sign-in with a clear message. Never triggered for the login endpoint
    // itself (a wrong password must not look like an expired session), and
    // never for explicit anonymous calls (token === null).
    if (res.status === 401 && t && path !== '/api/auth/login') {
      await kvRemove('token');
      await kvRemove('user');
      try {
        await kvSet('session_notice', 'Your session has expired. Please sign in again.');
      } catch { /* non-fatal */ }
      if (unauthorizedHandler) unauthorizedHandler();
    }
    throw new ApiError(data?.error?.message || `Request failed (${res.status})`, res.status);
  }
  return data;
}


export const api = {
  login: (email, password) =>
    request('/api/auth/login', { method: 'POST', body: { email, password }, token: null }),
  me: () => request('/api/auth/me'),
  pull: (since) => request(`/api/sync/pull${since ? `?since=${encodeURIComponent(since)}` : ''}`),
  pushBatch: (deviceId, ops) =>
    request('/api/sync/batch', { method: 'POST', body: { device_id: deviceId, ops } }),
  stock: () => request('/api/inventory/stock'),
  notifications: (limit = 100) => request(`/api/notifications?limit=${limit}`),
  markNotificationRead: (id) => request(`/api/notifications/${id}/read`, { method: 'PATCH', body: {} }),
  markAllNotificationsRead: () => request('/api/notifications/read-all', { method: 'PATCH', body: {} }),
  approvals: (status = 'PENDING') => request(`/api/approvals?status=${status}`),
  decideApproval: (id, decision, reason) =>
    request(`/api/approvals/${id}/${decision.toLowerCase()}`, { method: 'POST', body: reason ? { reason } : {} }),
};
