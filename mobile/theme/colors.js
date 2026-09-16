import { Appearance } from 'react-native';

// ─────────────────────────────────────────────────────────────────────────────
// Color system (§31–§40) — LIGHT + DARK palettes with SYSTEM following the OS.
//
// • One mutable `C` singleton: screens read C.text/C.panel at render time and
//   keep working unchanged. `applyAppearance` mutates C in place and notifies
//   listeners (the root layout remounts the tree so module-scope styles —
//   rebuilt in components.js — pick the new palette up too).
// • Preference is persisted in the existing SQLite kv store ('appearance') and
//   mirrored best-effort to the server (PUT /api/me/theme) for cross-device
//   consistency with the web app.
// • Semantic values match the web globals.css tokens (same palette both apps).
// • Dark theme is layered deep navy — never pure black (§36).
// ─────────────────────────────────────────────────────────────────────────────

export const LIGHT = {
  bg: '#eef1f6',
  bgSoft: '#e4e9f1',
  panel: '#ffffff',
  panel2: '#f2f5fa',
  border: '#d8dfeb',
  borderSoft: '#e3e9f2',
  text: '#1a2537',
  muted: '#5d6c85',
  accent: '#2563eb',
  accent2: '#1d4ed8',
  accentSoft: 'rgba(37, 99, 235, .12)',
  green: '#16a34a',
  amber: '#d97706',
  red: '#dc2626',
  dangerBg: 'rgba(220, 38, 38, .1)',
  successBg: 'rgba(22, 163, 74, .12)',
  warnBg: 'rgba(217, 119, 6, .12)',
};

export const DARK = {
  bg: '#0b1220',
  bgSoft: '#101a2e',
  panel: '#14203a',
  panel2: '#1a2947',
  border: '#24344f',
  borderSoft: '#20304c',
  text: '#e6ecf5',
  muted: '#8fa0b8',
  accent: '#3b82f6',
  accent2: '#60a5fa',
  accentSoft: '#1d3a6e',
  green: '#22c55e',
  amber: '#f59e0b',
  red: '#ef4444',
  dangerBg: 'rgba(239, 68, 68, .12)',
  successBg: 'rgba(34, 197, 94, .12)',
  warnBg: 'rgba(245, 158, 11, .12)',
};

// Live palette — starts DARK (legacy look) until the stored preference loads.
export const C = { ...DARK };

let pref = 'DARK';     // LIGHT | DARK | SYSTEM
let resolved = 'DARK'; // what C currently holds

const listeners = new Set();
export function onThemeApplied(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function currentAppearance() { return pref; }
export function resolvedTheme() { return resolved; }

function systemIsDark() { return Appearance.getColorScheme() === 'dark'; }

/** Applies LIGHT/DARK/SYSTEM to the shared C palette and notifies listeners. */
export function applyAppearance(next) {
  pref = String(next || 'SYSTEM').toUpperCase();
  if (!['LIGHT', 'DARK', 'SYSTEM'].includes(pref)) pref = 'SYSTEM';
  resolved = pref === 'SYSTEM' ? (systemIsDark() ? 'DARK' : 'LIGHT') : pref;
  Object.assign(C, resolved === 'DARK' ? DARK : LIGHT);
  for (const fn of listeners) { try { fn(); } catch { /* listener error never breaks theme */ } }
  return resolved;
}

/** Live OS tracking while preference is SYSTEM (§35). Returns a cleanup fn. */
export function watchSystemTheme(getPreference) {
  const sub = Appearance.addChangeListener(() => {
    if ((getPreference?.() ?? pref) === 'SYSTEM') applyAppearance('SYSTEM');
  });
  return () => sub.remove();
}
