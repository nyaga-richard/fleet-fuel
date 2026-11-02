'use client';
// ─────────────────────────────────────────────────────────────────────────────
// Theme (§31–§40) — LIGHT / DARK / SYSTEM with SYSTEM default.
//
// • Single source of tokens: globals.css `:root` (light) + [data-theme=dark]
// • Preference persisted in localStorage ('ff_theme'), mirrored to the server
//   (PUT /api/me/theme) so the mobile app shows the same choice
// • SYSTEM tracks the OS live via matchMedia — no reload needed (§35)
// • layout.js runs a tiny no-flash script before hydration with the same key
// ─────────────────────────────────────────────────────────────────────────────
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';

export const THEMES = ['LIGHT', 'DARK', 'SYSTEM'];
export const DEFAULT_THEME = 'SYSTEM';
const KEY = 'ff_theme';

function normalize(p) {
  const t = String(p || '').toUpperCase();
  return THEMES.includes(t) ? t : DEFAULT_THEME;
}

function resolve(pref) {
  if (pref !== 'SYSTEM') return pref;
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'DARK' : 'LIGHT';
}

export function getStoredTheme() {
  if (typeof window === 'undefined') return DEFAULT_THEME;
  try { return normalize(window.localStorage.getItem(KEY)); } catch { return DEFAULT_THEME; }
}

export function storeTheme(pref) {
  try { window.localStorage.setItem(KEY, normalize(pref)); } catch { /* private mode */ }
}

/** Applies the resolved theme to <html data-theme> and returns the resolver. */
export function applyTheme(pref) {
  const r = resolve(normalize(pref));
  document.documentElement.dataset.theme = r.toLowerCase();
  return r;
}

const ThemeCtx = createContext({ theme: DEFAULT_THEME, resolved: 'LIGHT', setTheme: () => {} });

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(DEFAULT_THEME);
  const [resolved, setResolved] = useState('LIGHT');

  useEffect(() => {
    const stored = getStoredTheme();
    setThemeState(stored);
    setResolved(applyTheme(stored));
    // §35 — live system preference changes
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setThemeState((cur) => { const r = applyTheme(cur); setResolved(r); return cur; });
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  const setTheme = useCallback((pref) => {
    const p = normalize(pref);
    storeTheme(p);
    setThemeState(p);
    setResolved(applyTheme(p));
    // Server mirror is best-effort — theme must work offline/unauthenticated.
    api('/api/me/theme', { method: 'PUT', body: JSON.stringify({ theme: p }) }).catch(() => {});
  }, []);

  const value = useMemo(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme]);
  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

export function useTheme() { return useContext(ThemeCtx); }
