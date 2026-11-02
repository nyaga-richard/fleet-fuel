// ─────────────────────────────────────────────────────────────────────────────
// 011 — Supplier purchase invoices with line items (§17/§20/§21).
//
// "Fuel must be an invoice": a delivery/receipt can now be captured as ONE
// supplier invoice with multiple items (diesel 5,000 L + petrol 2,000 L …),
// posting a single payable ledger entry for the invoice total. FUEL items may
// simultaneously receive into a tank (inventory) — one authoritative record
// per real-world event; the ledger entry references this invoice.
// Additive only (§43).
// ─────────────────────────────────────────────────────────────────────────────
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS supplier_invoices (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      supplier_id   uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      invoice_no    text NOT NULL,
      invoice_date  date NOT NULL DEFAULT CURRENT_DATE,
      due_date      date,
      total         numeric(14,2) NOT NULL CHECK (total > 0),
      status        text NOT NULL DEFAULT 'POSTED',
      notes         text,
      source        text NOT NULL DEFAULT 'MANUAL',
      client_uuid   uuid UNIQUE,
      created_by    uuid REFERENCES users(id),
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_supplier_invoices_supplier
      ON supplier_invoices (supplier_id, invoice_date DESC);

    CREATE TABLE IF NOT EXISTS supplier_invoice_items (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      invoice_id    uuid NOT NULL REFERENCES supplier_invoices(id) ON DELETE CASCADE,
      item_type     text NOT NULL DEFAULT 'OTHER'
                    CHECK (item_type IN ('FUEL','TIRE','PARTS','SERVICE','OTHER')),
      fuel_type_id  uuid REFERENCES fuel_types(id),
      tank_id       uuid REFERENCES tanks(id),
      description   text,
      quantity      numeric(14,3) NOT NULL CHECK (quantity > 0),
      unit_price    numeric(14,2) NOT NULL CHECK (unit_price >= 0),
      amount        numeric(14,2) NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_supplier_invoice_items_invoice
      ON supplier_invoice_items (invoice_id);

    CREATE SEQUENCE IF NOT EXISTS supplier_invoice_no_seq START 1;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS supplier_invoice_items CASCADE;
    DROP TABLE IF EXISTS supplier_invoices CASCADE;
  `);
};
