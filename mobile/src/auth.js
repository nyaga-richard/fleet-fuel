// ─────────────────────────────────────────────────────────────────────────────
// Auth — shared provider for the mobile app.
// Stores the JWT + profile in on-device SQLite (survives restarts), exposes
// { ready, user, login, logout }. `logout` wipes cached server data via
// logoutWipe() but NEVER deletes queued offline operations that belong to
// the device outbox… wipeLocalData clears the outbox too — by design: the
// ops were created under the signed-in account, and re-syncing them under
// a different account would be wrong. The server's idempotency ledger keeps
// everything auditable.
// ─────────────────────────────────────────────────────────────────────────────
import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from './api';
import { kvGet, kvSet, kvRemove } from './db';
import { fullSync, logoutWipe } from './sync';

const AuthCtx = createContext({ ready: false, user: null, login: async () => {}, logout: async () => {} });

export function AuthProvider({ children }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const token = await kvGet('token');
        const raw = await kvGet('user');
        const parsed = raw ? JSON.parse(raw) : null;
        if (token && parsed && parsed.id && parsed.role) setUser(parsed);
        else if (token || parsed) await logoutWipe();
      } catch { /* fresh install */ }
      setReady(true);
    })();
  }, []);

  const login = useCallback(async (email, password) => {
    const res = await api.login(email, password); // throws readable errors
    await kvSet('token', res.token);
    await kvSet('user', JSON.stringify(res.user));
    setUser(res.user);
    fullSync().catch(() => {}); // background refresh, never blocks sign-in
    return res.user;
  }, []);

  const logout = useCallback(async () => {
    await logoutWipe();
    await kvRemove('token');
    await kvRemove('user');
    setUser(null);
  }, []);

  return <AuthCtx.Provider value={{ ready, user, login, logout }}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  return useContext(AuthCtx);
}
