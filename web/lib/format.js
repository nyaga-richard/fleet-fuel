// Small formatting helpers shared by pages.
export function fmtQty(v, unit = 'L') {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unit}`;
}

export function fmtDateTime(s) {
  if (!s) return '—';
  return new Date(s).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export function fmtDate(s) {
  if (!s) return '—';
  return new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export const STATUS_COLORS = {
  pending: '#f59e0b',
  approved: '#22c55e',
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
};
