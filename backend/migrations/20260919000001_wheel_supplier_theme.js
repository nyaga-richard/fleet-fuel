// ============================================================================
// Migration 010 — Fleet expansion wave 2 (§43):
//   • wheel_configurations / _axles / _positions — configurable wheel master
//     data (§1–§8). Seeded system configurations replicate the legacy
//     position codes (FL/FR/RL/RR/RLO/…) so existing tires/vehicles map 1:1.
//   • vehicles.wheel_configuration_id + append-only assignment history (§6).
//   • tire_import_batches / tire_import_errors (§9–§16).
//   • suppliers / supplier_ledger_entries / supplier_payments /
//     supplier_payment_allocations / supplier_adjustments (§17–§30).
//   • user_theme_preferences (§31–§33).
// Additive only; no existing data is modified beyond the documented backfill.
// Sign convention (§18/§19): DEBIT increases supplier payable, CREDIT
// decreases it. Balance = Σdebit − Σcredit.
// ============================================================================
const LEGACY = {
  '4x2': [
    { axle: 1, type: 'STEERING', positions: [['FL', 'LEFT', 'SINGLE', 'Front Left'], ['FR', 'RIGHT', 'SINGLE', 'Front Right']] },
    { axle: 2, type: 'DRIVE', positions: [['RL', 'LEFT', 'SINGLE', 'Rear Left'], ['RR', 'RIGHT', 'SINGLE', 'Rear Right']] },
  ],
  '4x4': [
    { axle: 1, type: 'STEERING', positions: [['FL', 'LEFT', 'SINGLE', 'Front Left'], ['FR', 'RIGHT', 'SINGLE', 'Front Right']] },
    { axle: 2, type: 'DRIVE', positions: [['RL', 'LEFT', 'SINGLE', 'Rear Left'], ['RR', 'RIGHT', 'SINGLE', 'Rear Right']] },
  ],
  '6x2': [
    { axle: 1, type: 'STEERING', positions: [['FL', 'LEFT', 'SINGLE', 'Front Left'], ['FR', 'RIGHT', 'SINGLE', 'Front Right']] },
    { axle: 2, type: 'DRIVE', positions: [['RLO', 'LEFT', 'OUTER', 'Rear Left Outer'], ['RLI', 'LEFT', 'INNER', 'Rear Left Inner'], ['RRO', 'RIGHT', 'OUTER', 'Rear Right Outer'], ['RRI', 'RIGHT', 'INNER', 'Rear Right Inner']] },
  ],
  '6x4': [
    { axle: 1, type: 'STEERING', positions: [['FL', 'LEFT', 'SINGLE', 'Front Left'], ['FR', 'RIGHT', 'SINGLE', 'Front Right']] },
    { axle: 2, type: 'DRIVE', positions: [['RLO', 'LEFT', 'OUTER', 'Rear Left Outer'], ['RLI', 'LEFT', 'INNER', 'Rear Left Inner'], ['RRO', 'RIGHT', 'OUTER', 'Rear Right Outer'], ['RRI', 'RIGHT', 'INNER', 'Rear Right Inner']] },
  ],
  '8x4': [
    { axle: 1, type: 'STEERING', positions: [['FL', 'LEFT', 'SINGLE', 'Front Left'], ['FR', 'RIGHT', 'SINGLE', 'Front Right']] },
    { axle: 2, type: 'DRIVE', positions: [['MLO', 'LEFT', 'OUTER', 'Mid Left Outer'], ['MLI', 'LEFT', 'INNER', 'Mid Left Inner'], ['MRO', 'RIGHT', 'OUTER', 'Mid Right Outer'], ['MRI', 'RIGHT', 'INNER', 'Mid Right Inner']] },
    { axle: 3, type: 'DRIVE', positions: [['RLO', 'LEFT', 'OUTER', 'Rear Left Outer'], ['RLI', 'LEFT', 'INNER', 'Rear Left Inner'], ['RRO', 'RIGHT', 'OUTER', 'Rear Right Outer'], ['RRI', 'RIGHT', 'INNER', 'Rear Right Inner']] },
  ],
};

const CFG_IDS = {
  '4x2': 'c0000000-0000-4000-8000-000000000001',
  '4x4': 'c0000000-0000-4000-8000-000000000002',
  '6x2': 'c0000000-0000-4000-8000-000000000003',
  '6x4': 'c0000000-0000-4000-8000-000000000004',
  '8x4': 'c0000000-0000-4000-8000-000000000005',
};

export const up = (pgm) => {
  pgm.sql(`
      CREATE TABLE wheel_configurations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        code TEXT UNIQUE NOT NULL,
        name TEXT,
        axles INT NOT NULL CHECK (axles > 0),
        wheel_count INT NOT NULL CHECK (wheel_count > 0),
        is_active BOOLEAN NOT NULL DEFAULT true,
        is_system BOOLEAN NOT NULL DEFAULT false,
        notes TEXT,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE wheel_configuration_axles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        configuration_id UUID NOT NULL REFERENCES wheel_configurations(id) ON DELETE CASCADE,
        axle_number INT NOT NULL CHECK (axle_number > 0),
        axle_type TEXT NOT NULL CHECK (axle_type IN ('STEERING','DRIVE','TRAILING','TAG')),
        UNIQUE (configuration_id, axle_number)
      );

      CREATE TABLE wheel_configuration_positions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        configuration_id UUID NOT NULL REFERENCES wheel_configurations(id) ON DELETE CASCADE,
        axle_number INT NOT NULL CHECK (axle_number > 0),
        axle_type TEXT NOT NULL CHECK (axle_type IN ('STEERING','DRIVE','TRAILING','TAG')),
        side TEXT NOT NULL CHECK (side IN ('LEFT','RIGHT')),
        wheel_position TEXT NOT NULL DEFAULT 'SINGLE' CHECK (wheel_position IN ('INNER','OUTER','SINGLE')),
        position_code TEXT NOT NULL,
        display_name TEXT NOT NULL,
        is_required BOOLEAN NOT NULL DEFAULT true,
        sort_order INT NOT NULL DEFAULT 0,
        UNIQUE (configuration_id, position_code),
        UNIQUE (configuration_id, axle_number, side, wheel_position)
      );
      CREATE INDEX idx_wcp_config ON wheel_configuration_positions(configuration_id, sort_order);

      ALTER TABLE vehicles ADD COLUMN wheel_configuration_id UUID REFERENCES wheel_configurations(id);

      CREATE TABLE vehicle_wheel_config_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
        configuration_id UUID REFERENCES wheel_configurations(id),
        started_at timestamptz NOT NULL DEFAULT now(),
        ended_at timestamptz,
        changed_by UUID REFERENCES users(id)
      );

      CREATE TABLE tire_import_batches (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        file_name TEXT,
        imported_by UUID REFERENCES users(id),
        total_rows INT NOT NULL DEFAULT 0,
        created_count INT NOT NULL DEFAULT 0,
        skipped_count INT NOT NULL DEFAULT 0,
        failed_count INT NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED','FAILED','CANCELLED')),
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE tire_import_errors (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        batch_id UUID NOT NULL REFERENCES tire_import_batches(id) ON DELETE CASCADE,
        row_number INT NOT NULL,
        serial_no TEXT,
        field TEXT,
        message TEXT NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX idx_tie_batch ON tire_import_errors(batch_id, row_number);

      CREATE TABLE suppliers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        code TEXT UNIQUE,
        name TEXT NOT NULL,
        contact_person TEXT,
        phone TEXT,
        email TEXT,
        address TEXT,
        tax_pin TEXT,
        payment_terms_days INT,
        credit_limit NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
        currency TEXT NOT NULL DEFAULT 'KES',
        status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
        notes TEXT,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE supplier_ledger_entries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        supplier_id UUID NOT NULL REFERENCES suppliers(id),
        entry_type TEXT NOT NULL CHECK (entry_type IN ('OPENING','PURCHASE','PAYMENT','CREDIT_NOTE','DEBIT_ADJUSTMENT','REVERSAL')),
        entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
        reference TEXT,
        description TEXT,
        debit NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
        credit NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
        source_table TEXT,
        source_id UUID,
        created_by UUID REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT now(),
        CHECK (debit = 0 OR credit = 0) -- every entry is one-sided (§19)
      );
      CREATE INDEX idx_sle_supplier ON supplier_ledger_entries(supplier_id, entry_date, created_at, id);

      CREATE TABLE supplier_payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        payment_no TEXT UNIQUE,
        supplier_id UUID NOT NULL REFERENCES suppliers(id),
        payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
        amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
        payment_method TEXT NOT NULL,
        bank TEXT,
        reference TEXT,
        account TEXT,
        notes TEXT,
        status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED','REVERSED')),
        reversed_at timestamptz,
        reversed_by UUID REFERENCES users(id),
        reversal_reason TEXT,
        created_by UUID REFERENCES users(id),
        client_uuid UUID UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX idx_spayments_supplier ON supplier_payments(supplier_id, payment_date);

      CREATE TABLE supplier_payment_allocations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        payment_id UUID NOT NULL REFERENCES supplier_payments(id) ON DELETE CASCADE,
        ledger_entry_id UUID NOT NULL REFERENCES supplier_ledger_entries(id),
        amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
        created_by UUID REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (payment_id, ledger_entry_id)
      );

      CREATE TABLE supplier_adjustments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        adjustment_no TEXT UNIQUE,
        supplier_id UUID NOT NULL REFERENCES suppliers(id),
        entry_type TEXT NOT NULL CHECK (entry_type IN ('OPENING','CREDIT_NOTE','DEBIT_ADJUSTMENT')),
        amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
        entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
        reason TEXT,
        notes TEXT,
        status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED','REVERSED')),
        reversed_at timestamptz,
        reversed_by UUID REFERENCES users(id),
        reversal_reason TEXT,
        created_by UUID REFERENCES users(id),
        client_uuid UUID UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE user_theme_preferences (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        theme TEXT NOT NULL DEFAULT 'SYSTEM' CHECK (theme IN ('LIGHT','DARK','SYSTEM')),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);

  // Seed the five system configurations with FIXED ids — exact legacy
  // codes/counts so existing tire assignments keep validating (§1: the UI
  // reads these master-data tables, never hardcoded position maps).
  const seeds = [];
  for (const [code, axles] of Object.entries(LEGACY)) {
    const id = CFG_IDS[code];
    const wheels = axles.reduce((a, x) => a + x.positions.length, 0);
    seeds.push(`INSERT INTO wheel_configurations (id, code, name, axles, wheel_count, is_active, is_system) VALUES ('${id}', '${code}', '${code} — ${wheels} Wheel', ${axles.length}, ${wheels}, true, true);`);
    for (const a of axles) {
      seeds.push(`INSERT INTO wheel_configuration_axles (configuration_id, axle_number, axle_type) VALUES ('${id}', ${a.axle}, '${a.type}');`);
      let sort = 0;
      for (const [posCode, side, wheelPos, display] of a.positions) {
        seeds.push(`INSERT INTO wheel_configuration_positions (configuration_id, axle_number, axle_type, side, wheel_position, position_code, display_name, sort_order) VALUES ('${id}', ${a.axle}, '${a.type}', '${side}', '${wheelPos}', '${posCode}', '${display}', ${sort++});`);
      }
    }
  }
  pgm.sql(seeds.join('\n'));

  // Backfill: link existing vehicles to the configuration matching their
  // legacy axle_config code; record it as the first history entry (§6).
  pgm.sql(`
    UPDATE vehicles v SET wheel_configuration_id = w.id
      FROM wheel_configurations w
     WHERE w.code = v.axle_config AND v.wheel_configuration_id IS NULL`);
  pgm.sql(`
    INSERT INTO vehicle_wheel_config_history (vehicle_id, configuration_id, started_at)
    SELECT id, wheel_configuration_id, created_at FROM vehicles WHERE wheel_configuration_id IS NOT NULL`);
  // axle_config was a legacy enum while configurations are now master data
  // with free-form codes (§5) — the CHECK no longer applies.
  pgm.sql(`ALTER TABLE vehicles DROP CONSTRAINT IF EXISTS vehicles_axle_config_check`);
  pgm.sql(`
      CREATE SEQUENCE IF NOT EXISTS supplier_payment_no_seq START 1;
      CREATE SEQUENCE IF NOT EXISTS supplier_adjustment_no_seq START 1;
      CREATE SEQUENCE IF NOT EXISTS supplier_purchase_no_seq START 1;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
      DROP TABLE IF EXISTS user_theme_preferences CASCADE;
      DROP TABLE IF EXISTS supplier_payment_allocations CASCADE;
      DROP TABLE IF EXISTS supplier_payments CASCADE;
      DROP TABLE IF EXISTS supplier_adjustments CASCADE;
      DROP TABLE IF EXISTS supplier_ledger_entries CASCADE;
      DROP TABLE IF EXISTS suppliers CASCADE;
      DROP TABLE IF EXISTS tire_import_errors CASCADE;
      DROP TABLE IF EXISTS tire_import_batches CASCADE;
      DROP TABLE IF EXISTS vehicle_wheel_config_history CASCADE;
      ALTER TABLE vehicles DROP COLUMN IF EXISTS wheel_configuration_id;
      DROP TABLE IF EXISTS wheel_configuration_positions CASCADE;
      DROP TABLE IF EXISTS wheel_configuration_axles CASCADE;
      DROP TABLE IF EXISTS wheel_configurations CASCADE;
    
  `);
};
