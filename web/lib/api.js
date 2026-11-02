// API client — all browser → backend communication goes through here.
// The backend base URL is baked at build time via NEXT_PUBLIC_API_URL.
export function apiUrl(path) {
  const base = (process.env.NEXT_PUBLIC_API_URL || '').replace(/\/+$/, '');
  return base + path;
}

// Authenticated file download (reports/exports §43): same token as api(),
// returns a Blob plus the server-suggested filename.
export async function apiBlob(path) {
  const token = getToken();
  const res = await fetch(apiUrl(path), {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    let msg = `Export failed (${res.status})`;
    try { const j = await res.json(); if (j.error) msg = j.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const cd = res.headers.get('content-disposition') || '';
  const m = /filename="?([^";]+)"?/.exec(cd);
  return { blob: await res.blob(), filename: m ? m[1] : 'download' };
}

export function downloadBlob(blob, filename) {
  // Guard: apiBlob() returns { blob, filename } — accept both shapes but never
  // hand a non-Blob to URL.createObjectURL (it throws "Overload resolution
  // failed" with no hint about the cause).
  if (blob && typeof blob === 'object' && typeof blob.blob !== 'function' && blob.blob instanceof Blob) {
    blob = blob.blob;
  }
  if (!(blob instanceof Blob)) {
    throw new Error('Download failed — the server response was not a file.');
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
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
