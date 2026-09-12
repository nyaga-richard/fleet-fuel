'use client';
// ─────────────────────────────────────────────────────────────────────────────
// Authentication — a SINGLE shared React context for the whole app.
//
// Root fix for "Cannot read properties of null (reading 'role')": useAuth used
// to be a per-component hook, so every page instance re-read localStorage in
// its own effect and rendered with `user = null` for the first paint. Any page
// that read user.role crashed. Now the provider resolves the session once,
// every consumer shares the same value, and pages only render inside Shell,
// which gates on `ready && user`.
// ─────────────────────────────────────────────────────────────────────────────
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

const AuthCtx = createContext({ user: null, ready: false, login: () => {}, logout: () => {} });

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const token = localStorage.getItem('ff_token');
    let parsed = null;
    try { parsed = JSON.parse(localStorage.getItem('ff_user') || 'null'); } catch { parsed = null; }
    if (!token || !parsed || !parsed.id || !parsed.role) {
      // Missing/corrupt/stale-schema profile → clean slate and re-sign-in.
      localStorage.removeItem('ff_token');
      localStorage.removeItem('ff_user');
      router.replace('/login');
      return;
    }
    setUser(parsed);
    setReady(true);
  }, [router]);

  const login = useCallback((token, profile) => {
    localStorage.setItem('ff_token', token);
    localStorage.setItem('ff_user', JSON.stringify(profile));
    setUser(profile);
    setReady(true);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('ff_token');
    localStorage.removeItem('ff_user');
    setUser(null);
    router.replace('/login');
  }, [router]);

  return <AuthCtx.Provider value={{ user, ready, login, logout }}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  return useContext(AuthCtx);
}
