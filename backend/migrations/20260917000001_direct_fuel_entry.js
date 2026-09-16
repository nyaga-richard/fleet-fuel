// ============================================================================
// 008 — §28–§36 Direct Fuel Entry: fuel recorded WITHOUT the request/
// approval workflow (manager/admin only, permission-gated). Additive only;
// existing rows default to the APPROVED_REQUEST source so history and
// reports are unchanged.
// ============================================================================
export const up = (pgm) => {
  pgm.addColumn('fuel_transactions', {
    source: { type: 'text', notNull: true, default: 'APPROVED_REQUEST',
      check: "source IN ('APPROVED_REQUEST','DIRECT_ENTRY')" },
    destination: { type: 'text' },
    purpose: { type: 'text' },
    remarks: { type: 'text' },
    // §35 — cost and fueling price stay SEPARATE: unit_price is the applied
    // fueling price, unit_cost is the inventory cost at posting time.
    unit_cost: { type: 'numeric(12,2)', check: 'unit_cost >= 0' },
    pump_start: { type: 'numeric(14,2)', check: 'pump_start >= 0' },
    pump_end: { type: 'numeric(14,2)', check: 'pump_end >= 0' },
  });
  pgm.createIndex('fuel_transactions', 'source');
};
export const down = (pgm) => {
  pgm.dropColumns('fuel_transactions', ['source', 'destination', 'purpose', 'remarks', 'unit_cost', 'pump_start', 'pump_end']);
};
