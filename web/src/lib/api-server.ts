/**
 * Server-side API helper (Server Components, Server Actions, Route Handlers).
 *
 * Calls the backend directly with the user's JWT from the httpOnly session
 * cookie; transparently refreshes the access token once on 401 and updates
 * the cookie so subsequent requests (including the client proxy) use the
 * fresh token.
 */
import 'server-only';
import { cookies } from 'next/headers';
import { backendUrl, SESSION_COOKIE, setSessionCookie, refreshTokenValue } from './auth';
import { ApiError } from './errors';

export { ApiError };

export interface ApiOpts {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  revalidate?: number | 0;
}

export async function api<T = any>(path: string, opts: ApiOpts = {}): Promise<T> {
  const raw = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!raw) throw new ApiError(401, 'Not authenticated');
  let session: { accessToken: string; refreshToken?: string; user: unknown };
  try {
    session = JSON.parse(decodeURIComponent(raw));
  } catch {
    throw new ApiError(401, 'Not authenticated');
  }

  const url = new URL(`${backendUrl()}/api${path}`);
  const method = opts.method ?? 'GET';
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
  }

  const doFetch = (token: string) =>
    fetch(url.toString(), {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      cache: 'no-store',
      ...(typeof opts.revalidate === 'number' && opts.revalidate > 0 ? { next: { revalidate: opts.revalidate } } : {}),
    });

  let accessToken = session.accessToken;
  let res = await doFetch(accessToken);
  if (res.status === 401 && session.refreshToken) {
    const refreshed = await refreshTokenValue(session.refreshToken);
    if (refreshed) {
      // Next 16 only allows cookie writes from Route Handlers / Server
      // Actions — during Server Component rendering this throws. If we
      // can't persist, keep the fresh token in memory for this request;
      // the cookie gets rewritten on the next call through the
      // /api/backend proxy (a Route Handler), so the session self-heals.
      try {
        await setSessionCookie(refreshed.accessToken, session.refreshToken, refreshed.user as any);
      } catch {
        /* expected during page render — safe to skip */
      }
      accessToken = refreshed.accessToken;
      res = await doFetch(accessToken);
    }
  }

  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(
      res.status,
      data?.error?.message ?? `Request failed (${res.status})`,
      data?.error?.code
    );
  }
  return (await res.json()) as T;
}
