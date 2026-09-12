// HTTP client for the Fleet Fuel API.
// Base URL comes from EXPO_PUBLIC_API_URL (build-time env, see .env.example).
// Never hard-code localhost or LAN IPs in production builds.
import { kvGet } from './db';

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
  if (!res.ok) throw new ApiError(data?.error?.message || `Request failed (${res.status})`, res.status);
  return data;
}

export const api = {
  login: (email, password) =>
    request('/api/auth/login', { method: 'POST', body: { email, password }, token: null }),
  me: () => request('/api/auth/me'),
  pull: (since) => request(`/api/sync/pull${since ? `?since=${encodeURIComponent(since)}` : ''}`),
  pushBatch: (deviceId, ops) =>
    request('/api/sync/batch', { method: 'POST', body: { device_id: deviceId, ops } }),
};
