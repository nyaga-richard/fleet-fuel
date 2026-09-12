// Design system tokens — one source of truth for every mobile screen.
export const C = {
  bg: '#0b1220',
  bgSoft: '#101a2e',
  panel: '#14203a',
  panel2: '#1a2947',
  border: '#24344f',
  text: '#e6ecf5',
  muted: '#8fa0b8',
  accent: '#3b82f6',
  accent2: '#60a5fa',
  green: '#22c55e',
  amber: '#f59e0b',
  red: '#ef4444',
  dangerBg: 'rgba(239,68,68,.12)',
  successBg: 'rgba(34,197,94,.12)',
  warnBg: 'rgba(245,158,11,.12)',
};

export const S = {
  xs: 4, sm: 8, md: 12, lg: 18, xl: 24,
};

export const R = { sm: 8, md: 10, lg: 14, pill: 20 };

export const STATUS_COLOR = {
  pending: C.amber,
  approved: C.green,
  authorized: C.green,
  issued: C.accent,
  rejected: C.red,
  cancelled: C.muted,
  completed: C.green,
  reversed: C.red,
  opening: '#a78bfa',
  receipt: C.green,
  issue: C.amber,
  adjustment: '#eab308',
  reversal: '#38bdf8',
};

// Minimum touch target (spec §13): keep interactive controls ≥ 44pt.
export const TAP = 50;
