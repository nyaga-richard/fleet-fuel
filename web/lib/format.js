// Formatting helpers shared by all pages.
// Locale conventions (Kenya): KES currency, DD/MM/YYYY dates, 24-hour time,
// Africa/Nairobi timezone, thousands separators, sensible decimal precision.

const TZ = 'Africa/Nairobi';
const LOCALE = 'en-GB'; // gives DD/MM/YYYY + 24h clock

export function fmtQty(v, unit = 'L') {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (Number.isNaN(n)) return '—';
  return `${n.toLocaleString(LOCALE, { maximumFractionDigits: 2 })} ${unit}`;
}

export function fmtNum(v, decimals = 0) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (Number.isNaN(n)) return '—';
  return n.toLocaleString(LOCALE, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function fmtKES(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (Number.isNaN(n)) return '—';
  return `KES ${n.toLocaleString(LOCALE, { maximumFractionDigits: 2 })}`;
}

export function fmtDateTime(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(LOCALE, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ,
  });
}

export function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(LOCALE, { year: 'numeric', month: 'short', day: 'numeric', timeZone: TZ });
}

export function fmtDateInput(s) {
  // value for <input type="date"> in Africa/Nairobi
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return parts; // en-CA → YYYY-MM-DD
}

export function fmtRel(s) {
  if (!s) return '—';
  const then = new Date(s).getTime();
  if (Number.isNaN(then)) return '—';
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} h ago`;
  return `${Math.floor(secs / 86400)} d ago`;
}

export const STATUS_COLORS = {
  pending: '#f59e0b',
  approved: '#22c55e',
  authorized: '#22c55e',
  rejected: '#ef4444',
  issued: '#3b82f6',
  cancelled: '#9ca3af',
  completed: '#22c55e',
  reversed: '#ef4444',
  opening: '#a78bfa',
  receipt: '#22c55e',
  issue: '#f59e0b',
  adjustment: '#eab308',
  reversal: '#38bdf8',
  // fleet expansion (§8/§20/§13) — statuses arrive UPPERCASE from the API
  ACTIVE: '#22c55e', INACTIVE: '#9ca3af', MAINTENANCE: '#f59e0b', ACCIDENT: '#ef4444',
  RETIRED: '#9ca3af', SOLD: '#a78bfa', DISPOSED: '#ef4444',
  PLANNED: '#a78bfa', AUTHORIZED: '#22c55e', IN_PROGRESS: '#3b82f6', CANCELLED: '#9ca3af',
  IN_STORE: '#22c55e', USED_STORE: '#60a5fa', ON_VEHICLE: '#2563eb',
  AWAITING_RETREAD: '#f59e0b', AT_RETREAD_SUPPLIER: '#eab308',
  FIT: '#22c55e', REMOVE: '#f59e0b', ROTATE: '#3b82f6',
  UNPAID: '#ef4444', PARTPAID: '#f59e0b', PAID: '#22c55e',
  CASH: '#60a5fa', CARD: '#a78bfa', ACCOUNT: '#f59e0b', OTHER: '#9ca3af',
};
