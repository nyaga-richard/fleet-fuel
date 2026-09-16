// ============================================================================
// Permission registry (§26) — granular keys mapped onto the existing RBAC
// roles. requirePerm() enforces the KEY, never a display name; a future
// per-user override table can extend can() without touching call sites.
// ============================================================================

const ALL = [
  // reporting / exports (§43 — same gate as viewing)
  'reports:view', 'reports:export', 'audit_logs:view',
  // fuel requests
  'fuel_requests:view', 'fuel_requests:create', 'fuel_requests:approve', 'fuel_requests:reject',
  // direct fuel entry (§28/§29) — bypasses the request workflow entirely
  'fuel_entries:view', 'fuel_entries:create',
  // fleet expansion (§40) — external fuel, tires, trips
  'external_fuel:view', 'external_fuel:record',
  'tires:view', 'tires:manage',
  'trips:view', 'trips:manage',
  // excess fuel
  'fuel_excess:approve', 'fuel_excess:reject',
  // inventory
  'inventory_adjustments:approve', 'inventory_adjustments:reject',
  'fuel_receipts:approve', 'fuel_receipts:reject',
  'pump_variances:approve', 'pump_variances:reject',
  'tank_variances:approve', 'tank_variances:reject',
];

export const ROLE_PERMS = {
  admin: Object.fromEntries(ALL.map((p) => [p, true])),
  manager: Object.fromEntries(ALL.filter((p) => p !== 'audit_logs:view').map((p) => [p, true])),
  attendant: {
    'reports:view': false,
    'reports:export': false,
    'audit_logs:view': false,
    'fuel_requests:view': true,
    'fuel_requests:create': true,
  },
};

/** Does this role hold the permission key? */
export function can(role, perm) {
  const entry = ROLE_PERMS[role];
  if (!entry) return false;
  return entry[perm] === true;
}
