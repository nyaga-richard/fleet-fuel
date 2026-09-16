// Tiny declarative request-body validation (no extra dependency).
import { bad } from './errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

export function needUuid(body, field, { optional = false } = {}) {
  const v = body?.[field];
  if (v === undefined || v === null || v === '') {
    if (optional) return null;
    throw bad(`Field "${field}" is required`);
  }
  if (!isUuid(v)) throw bad(`Field "${field}" must be a UUID`);
  return v;
}

export function needStr(body, field, { min = 1, max = 500, optional = false } = {}) {
  const v = body?.[field];
  if (v === undefined || v === null || v === '') {
    if (optional) return null;
    throw bad(`Field "${field}" is required`);
  }
  if (typeof v !== 'string' || v.trim().length < min || v.trim().length > max) {
    throw bad(`Field "${field}" must be a string of ${min}–${max} characters`);
  }
  return v.trim();
}

export function needNum(body, field, { min, max, optional = false, signed = false } = {}) {
  const raw = body?.[field];
  if (raw === undefined || raw === null || raw === '') {
    if (optional) return null;
    throw bad(`Field "${field}" is required`);
  }
  const v = Number(raw);
  if (!Number.isFinite(v)) throw bad(`Field "${field}" must be a number`);
  if (!signed && v <= 0) throw bad(`Field "${field}" must be greater than 0`);
  if (signed && v === 0) throw bad(`Field "${field}" must not be zero`);
  if (min !== undefined && v < min) throw bad(`Field "${field}" must be ≥ ${min}`);
  if (max !== undefined && v > max) throw bad(`Field "${field}" must be ≤ ${max}`);
  return v;
}

export function needOneOf(body, field, allowed, { optional = false, fallback = null } = {}) {
  const v = body?.[field];
  if (v === undefined || v === null || v === '') {
    if (optional) return fallback;
    throw bad(`Field "${field}" is required (one of: ${allowed.join(', ')})`);
  }
  if (!allowed.includes(v)) throw bad(`Field "${field}" must be one of: ${allowed.join(', ')}`);
  return v;
}

export function optUuid(body, field) {
  const v = body?.[field];
  if (v === undefined || v === null || v === '') return null;
  if (!isUuid(v)) throw bad(`Field "${field}" must be a UUID`);
  return v;
}

export function optNum(body, field, { min, max } = {}) {
  const v = body?.[field];
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ApiError(400, `${field} must be a number`);
  if (min !== undefined && n < min) throw new ApiError(400, `${field} must be at least ${min}`);
  if (max !== undefined && n > max) throw new ApiError(400, `${field} must be at most ${max}`);
  return n;
}

export function optStr(body, field, { max = 500 } = {}) {
  const v = body?.[field];
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new ApiError(400, `${field} must be a string`);
  const t = v.trim();
  if (!t) return null;
  if (t.length > max) throw new ApiError(400, `${field} must be at most ${max} characters`);
  return t;
}
