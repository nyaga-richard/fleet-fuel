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

export async function api(path, { method = 'GET', body, optional = false } = {}) {
  const token = getToken();
  let res;
  try {
    res = await fetch(apiUrl(path), {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    // Network/TLS/DNS failure (e.g. unreachable API domain) — never let this
    // become an unhandled client-side crash.
    throw new Error('Cannot reach the API — check your connection or try again shortly.');
  }

  let data = {};
  try { data = await res.json(); } catch { /* non-JSON body */ }

  if (!res.ok) {
    // Expired/invalid session (e.g. server secret rotated or token older than
    // JWT_EXPIRES_IN): clear stale credentials and return to sign-in instead
    // of surfacing "Authentication required" on every page.
    if (res.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('ff_token');
      localStorage.removeItem('ff_user');
      if (!window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
    }
    const err = new Error(data?.error?.message || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}
