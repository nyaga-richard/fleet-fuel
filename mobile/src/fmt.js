// Formatting — Kenya conventions: KES, DD/MM/YYYY, 24-hour, Africa/Nairobi.
const TZ = 'Africa/Nairobi';
const LOCALE = 'en-GB';

export function fmtQty(v, unit = 'L') {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (Number.isNaN(n)) return '—';
  return `${n.toLocaleString(LOCALE, { maximumFractionDigits: 2 })} ${unit}`;
}

export function fmtNum(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (Number.isNaN(n)) return '—';
  return n.toLocaleString(LOCALE);
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

export function fmtRel(s) {
  if (!s) return 'never';
  const then = new Date(s).getTime();
  if (Number.isNaN(then)) return 'never';
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} h ago`;
  return `${Math.floor(secs / 86400)} d ago`;
}

export function todayKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}
