// API client — all browser → backend communication goes through here.
// The backend base URL is baked at build time via NEXT_PUBLIC_API_URL.
export function apiUrl(path) {
  const base = (process.env.NEXT_PUBLIC_API_URL || '').replace(/\/+$/, '');
  return base + path;
}

export function getToken() {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('ff_token');
}

export async function api(path, { method = 'GET', body } = {}) {
  const token = getToken();
  const res = await fetch(apiUrl(path), {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}
