// ============================================================================
// 006 — Approvals engine support: payload column (adjustment details travel
// with the approval and are posted only when APPROVED — §53) + settings
// switches (self-approval override OFF by default — §27).
// ============================================================================
export const up = (pgm) => {
  pgm.addColumn('approvals', {
    payload: { type: 'jsonb' },
  });
  pgm.sql(`INSERT INTO settings (key, value) VALUES
             ('approvals.allow_self_approval_override', 'false'),
             ('approvals.adjustments_require_approval', 'true')
           ON CONFLICT (key) DO NOTHING`);
};

export const down = (pgm) => {
  pgm.dropColumn('approvals', 'payload');
};
