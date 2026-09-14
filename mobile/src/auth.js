// ─────────────────────────────────────────────────────────────────────────────
// Auth — THE single centralized session manager for the mobile app (spec §6).
//
//   • JWT + profile live in on-device SQLite (survive restarts)
//   • 401 anywhere → api.js clears the session and calls the handler
//     registered here → user state clears → root layout routes to sign-in.
//     No screen implements expiry logic itself.
//   • logout() NEVER deletes queued offline operations (spec §30): pending
//     fuel transactions survive both explicit logout AND session expiry.
//     The outbox owner check in sync.js prevents cross-account misuse: ops
//     created under account A are held (not pushed) while account B is
//     signed in.
// ─────────────────────────────────────────────────────────────────────────────
import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useRouter } from 'expo-router';
import { api, setUnauthorizedHandler } from './api';
import { kvGet, kvSet, kvRemove } from './db';
import { fullSync } from './sync';
import { registerPushToken } from './push';

const AuthCtx = createContext({ ready: false, user: null, login: async () => {}, logout: async () => {} });

export function AuthProvider({ children }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState(null);
  const router = useRouter();

  // ── Startup session check (spec §7): restore session BEFORE any screen
  // renders — the root layout shows a "Checking session…" splash until then.
  useEffect(() => {
    (async () => {
      try {
        const token = await kvGet('token');
        const raw = await kvGet('user');
        const parsed = raw ? JSON.parse(raw) : null;
        if (token && parsed && parsed.id && parsed.role) {
          setUser(parsed);
        } else if (token || parsed) {
          // Corrupt/half session: clear credentials, KEEP the outbox.
          await kvRemove('token');
          await kvRemove('user');
        }
      } catch { /* fresh install */ }
      registerPushToken(); // session restored — keep this device registered (§40)
      setReady(true);
    })();
  }, []);

  // ── Central 401 routing (spec §4/§5/§6): one handler for the whole app.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  // Route whenever auth state changes; replace() keeps no history, so the
  // Android back button can never return to protected screens after logout.
  useEffect(() => {
    if (!ready) return;
    router.replace(user ? '/(tabs)' : '/login');
  }, [ready, user, router]);

  const login = useCallback(async (email, password) => {
    const res = await api.login(email, password); // throws readable errors
    await kvSet('token', res.token);
    await kvSet('user', JSON.stringify(res.user));
    await kvSet('outbox_owner', res.user.id); // ops created under THIS account
    await kvRemove('session_notice');
    setUser(res.user);
    fullSync().catch(() => {}); // background refresh, never blocks sign-in
    registerPushToken(); // §40 — best effort; a build (not Expo Go) is required for real delivery
    return res.user;
  }, []);

  // Explicit logout: clear credentials + cached auth state. The offline queue
  // and cached reference data are deliberately KEPT (spec §30).
  const logout = useCallback(async () => {
    await kvRemove('token');
    await kvRemove('user');
    setUser(null);
  }, []);

  return <AuthCtx.Provider value={{ ready, user, login, logout }}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  return useContext(AuthCtx);
}
