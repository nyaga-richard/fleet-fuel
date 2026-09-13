// Auth context — token + user persisted in local SQLite (survives restarts).
import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from './api';
import { kvGet, kvSet, dbReady } from './db';
import { fullSync, logoutWipe } from './sync';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState(null);

  useEffect(() => {
    (async () => {
      await dbReady();
      const token = await kvGet('token');
      const raw = await kvGet('user');
      if (token && raw) {
        try { setUser(JSON.parse(raw)); } catch { /* corrupt — ignore */ }
      }
      setReady(true);
    })();
  }, []);

  const login = useCallback(async (email, password) => {
    const res = await api.login(email, password);
    await kvSet('token', res.token);
    await kvSet('user', JSON.stringify(res.user));
    setUser(res.user);
    fullSync(); // initial pull (reference data) — non-blocking
    return res.user;
  }, []);

  const logout = useCallback(async () => {
    await logoutWipe();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ ready, user, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
