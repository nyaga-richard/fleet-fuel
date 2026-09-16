// ============================================================================
// /api/suppliers — supplier/accounting module (§17–§30).
//
// SIGN CONVENTION (§18/§19, used consistently everywhere):
//   DEBIT  = increases supplier payable (purchases, debit adjustments,
//            payment reversals)
//   CREDIT = decreases supplier payable (payments, credit notes)
//   Balance = Σdebit − Σcredit  → the amount owed to the supplier.
//
// Ledger integrity (§20/§46/§48): every ledger row references its source
// document (source_table/source_id). No duplicate financial records are
// created for reporting. Running balance uses deterministic ordering
// (entry_date ASC, created_at ASC, id ASC); a date-filtered ledger computes
// its opening balance from ALL valid entries before Date From.
// Payments are never deleted — only reversed with an opposite entry (§26).
// ============================================================================
import { Router } from 'express';
import { pool, tx } from '../db/pool.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { asyncH, bad, notFound } from '../middleware/errors.js';
import { needStr, needUuid, needNum, optStr, optNum, optUuid, isUuid } from '../middleware/validate.js';
import { audit } from '../services/audit.js';
import { nextDocNumber } from '../services/numbering.js';

const router = Router();
router.use(requireAuth);

const ENTRY_TYPES = ['OPENING', 'PURCHASE', 'PAYMENT', 'CREDIT_NOTE', 'DEBIT_ADJUSTMENT', 'REVERSAL'];
export const PAYMENT_METHODS = ['CASH', 'BANK_TRANSFER', 'CHEQUE', 'MOBILE_MONEY', 'CARD', 'OTHER'];
const PURCHASE_SOURCES = ['FUEL', 'TIRE', 'RETREAD', 'PARTS', 'SERVICE', 'OTHER'];

const SELECT = `
  SELECT s.*,
         (SELECT COALESCE(SUM(debit - credit), 0)::float FROM supplier_ledger_entries l WHERE l.supplier_id = s.id) AS balance,
         (SELECT MAX(l.entry_date)::text FROM supplier_ledger_entries l WHERE l.supplier_id = s.id AND l.entry_type = 'PURCHASE') AS last_purchase_date,
         (SELECT MAX(p.payment_date)::text FROM supplier_payments p WHERE p.supplier_id = s.id AND p.status = 'COMPLETED') AS last_payment_date
    FROM suppliers s`;

async function supplierOrNull(client, id) {
  const { rows } = await (client ?? pool).query('SELECT * FROM suppliers WHERE id = $1', [id]);
  return rows[0] ?? null;
}

// ── Master data (§17) ────────────────────────────────────────────────────────
router.get('/', requirePerm('suppliers:view'), asyncH(async (req, res) => {
  const params = [];
  const where = [];
  if (req.query.q) {
    // §29 — searchable by name, code, phone or tax PIN.
    params.push(`%${String(req.query.q).trim()}%`);
    where.push(`(s.name ILIKE $${params.length} OR s.code ILIKE $${params.length} OR s.phone ILIKE $${params.length} OR s.tax_pin ILIKE $${params.length})`);
  }
  if (req.query.status) { params.push(String(req.query.status).toUpperCase()); where.push(`s.status = $${params.length}`); }
  const { rows } = await pool.query(
    `${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.name LIMIT 500`, params);
  res.json({ suppliers: rows });
}));

router.get('/:id', requirePerm('suppliers:view'), asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound('Supplier not found');
  const sup = await supplierOrNull(pool, req.params.id);
  if (!sup) throw notFound('Supplier not found');
  // §28 — account dashboard fields, computed from the ledger (never stored twice).
  const agg = await pool.query(`
    SELECT
      (SELECT COALESCE(SUM(debit - credit),0)::float FROM supplier_ledger_entries WHERE supplier_id = $1) AS balance,
      (SELECT COALESCE(SUM(debit),0)::float FROM supplier_ledger_entries WHERE supplier_id = $1 AND entry_type = 'PURCHASE') AS total_purchases,
      (SELECT COALESCE(SUM(credit),0)::float FROM supplier_ledger_entries WHERE supplier_id = $1 AND entry_type = 'PAYMENT') AS total_payments,
      (SELECT COALESCE(SUM(credit),0)::float FROM supplier_ledger_entries WHERE supplier_id = $1 AND entry_type = 'CREDIT_NOTE') AS total_credit_notes,
      (SELECT COALESCE(SUM(l.debit - COALESCE(a.allocated,0)),0)::float
         FROM supplier_ledger_entries l
         LEFT JOIN (SELECT ledger_entry_id, SUM(amount)::float AS allocated FROM supplier_payment_allocations GROUP BY ledger_entry_id) a
           ON a.ledger_entry_id = l.id
        WHERE l.supplier_id = $1 AND l.entry_type = 'PURCHASE') AS outstanding_invoices_amount,
      (SELECT COUNT(*)::int FROM supplier_ledger_entries l
         LEFT JOIN (SELECT ledger_entry_id, SUM(amount)::float AS allocated FROM supplier_payment_allocations GROUP BY ledger_entry_id) a
           ON a.ledger_entry_id = l.id
        WHERE l.supplier_id = $1 AND l.entry_type = 'PURCHASE' AND l.debit - COALESCE(a.allocated,0) > 0.005) AS outstanding_invoice_count,
      (SELECT MAX(p.created_at) FROM supplier_payments p WHERE p.supplier_id = $1 AND p.status = 'COMPLETED') AS last_payment_at,
      (SELECT MAX(l.created_at) FROM supplier_ledger_entries l WHERE l.supplier_id = $1 AND l.entry_type = 'PURCHASE') AS last_purchase_at`, [req.params.id]);
  const a = agg.rows[0];
  res.json({
    supplier: sup,
    account: {
      current_balance: Number(a.balance) || 0,
      credit_limit: Number(sup.credit_limit) || 0,
      available_credit: (Number(sup.credit_limit) || 0) - (Number(a.balance) || 0),
      outstanding_invoices: Number(a.outstanding_invoice_count) || 0,
      outstanding_amount: Number(a.outstanding_invoices_amount) || 0,
      total_purchases: Number(a.total_purchases) || 0,
      total_payments: Number(a.total_payments) || 0,
      total_credit_notes: Number(a.total_credit_notes) || 0,
      last_payment: a.last_payment_at, last_purchase: a.last_purchase_at,
    },
  });
}));

router.post('/', requirePerm('suppliers:create'), asyncH(async (req, res) => {
  const name = needStr(req.body, 'name', { max: 160 });
  const existing = req.body.client_uuid
    ? (await pool.query('SELECT * FROM suppliers WHERE client_uuid = $1', [req.body.client_uuid])).rows[0]
    : null;
  if (existing) return res.json({ supplier: existing, duplicate: true });
  const { rows } = await pool.query(
    `INSERT INTO suppliers (code, name, contact_person, phone, email, address, tax_pin,
                            payment_terms_days, credit_limit, currency, status, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [optStr(req.body, 'code', { max: 30 }) || null, name,
      optStr(req.body, 'contact_person', { max: 120 }), optStr(req.body, 'phone', { max: 40 }),
      optStr(req.body, 'email', { max: 160 }), optStr(req.body, 'address', { max: 300 }),
      optStr(req.body, 'tax_pin', { max: 40 }),
      req.body.payment_terms_days != null && req.body.payment_terms_days !== '' ? Number(req.body.payment_terms_days) : null,
      req.body.credit_limit != null && req.body.credit_limit !== '' ? Number(req.body.credit_limit) : 0,
      optStr(req.body, 'currency', { max: 8 }) || 'KES',
      (optStr(req.body, 'status', { max: 10 }) || 'ACTIVE').toUpperCase(),
      optStr(req.body, 'notes', { max: 500 })]);
  await audit(null, { userId: req.user.sub, action: 'supplier.created', entity: 'suppliers', entityId: rows[0].id, details: { name }, ip: req.ip });
  res.status(201).json({ supplier: rows[0] });
}));

router.patch('/:id', requirePerm('suppliers:update'), asyncH(async (req, res) => {
  const b = req.body ?? {};
  const sets = []; const params = [req.params.id];
  const push = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  for (const [col, key, max] of [['code', 'code', 30], ['name', 'name', 160], ['contact_person', 'contact_person', 120],
    ['phone', 'phone', 40], ['email', 'email', 160], ['address', 'address', 300], ['tax_pin', 'tax_pin', 40], ['notes', 'notes', 500]]) {
    if (b[key] !== undefined) push(col, needStr(b, key, { max, optional: true }));
  }
  if (b.payment_terms_days !== undefined) push('payment_terms_days', b.payment_terms_days === '' || b.payment_terms_days == null ? null : Number(b.payment_terms_days));
  if (b.credit_limit !== undefined) push('credit_limit', b.credit_limit === '' || b.credit_limit == null ? 0 : Number(b.credit_limit));
  if (b.status !== undefined) {
    const st = String(b.status).toUpperCase();
    if (!['ACTIVE', 'INACTIVE'].includes(st)) throw bad('Status must be ACTIVE or INACTIVE');
    push('status', st);
  }
  if (!sets.length) throw bad('Nothing to update');
  sets.push('updated_at = now()');
  const { rows } = await pool.query(`UPDATE suppliers SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  if (!rows.length) throw notFound('Supplier not found');
  await audit(null, { userId: req.user.sub, action: 'supplier.updated', entity: 'suppliers', entityId: req.params.id, details: b, ip: req.ip });
  res.json({ supplier: rows[0] });
}));

// ── Ledger (§19/§46/§47) ─────────────────────────────────────────────────────
router.get('/:id/ledger', requirePerm('supplier_ledger:view'), asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound('Supplier not found');
  const sup = await supplierOrNull(pool, req.params.id);
  if (!sup) throw notFound('Supplier not found');
  const params = [req.params.id];
  const periodWhere = [];
  if (req.query.from) { params.push(String(req.query.from)); periodWhere.push(`l.entry_date >= $${params.length}::date`); }
  if (req.query.to) { params.push(String(req.query.to)); periodWhere.push(`l.entry_date <= $${params.length}::date`); }
  if (req.query.type) {
    const t = String(req.query.type).toUpperCase();
    if (!ENTRY_TYPES.includes(t)) throw bad(`Invalid type — use one of ${ENTRY_TYPES.join(', ')}`);
    params.push(t); periodWhere.push(`l.entry_type = $${params.length}`);
  }

  // Opening balance (§46): all valid entries BEFORE Date From.
  let opening = 0;
  if (req.query.from) {
    const { rows: op } = await pool.query(
      `SELECT COALESCE(SUM(debit - credit),0)::float AS opening FROM supplier_ledger_entries
        WHERE supplier_id = $1 AND entry_date < $2::date`, [req.params.id, String(req.query.from)]);
    opening = Number(op[0].opening) || 0;
  }

  // Deterministic chronological order (§46) — running balance is stable.
  const { rows } = await pool.query(
    `SELECT l.*, COALESCE(a.allocated, 0)::float AS allocated
       FROM supplier_ledger_entries l
       LEFT JOIN (SELECT ledger_entry_id, SUM(amount)::float AS allocated FROM supplier_payment_allocations GROUP BY ledger_entry_id) a
         ON a.ledger_entry_id = l.id
      WHERE l.supplier_id = $1 ${periodWhere.length ? 'AND ' + periodWhere.join(' AND ') : ''}
      ORDER BY l.entry_date ASC, l.created_at ASC, l.id ASC`, params);

  let running = opening;
  const entries = rows.map((r) => {
    running += Number(r.debit) - Number(r.credit);
    return {
      ...r,
      debit: Number(r.debit), credit: Number(r.credit),
      allocated: Number(r.allocated) || 0,
      outstanding: r.entry_type === 'PURCHASE' ? Math.max(0, Number(r.debit) - (Number(r.allocated) || 0)) : null,
      balance: +running.toFixed(2),
    };
  });
  res.json({
    supplier: { id: sup.id, code: sup.code, name: sup.name, currency: sup.currency },
    opening_balance: +opening.toFixed(2),
    closing_balance: +running.toFixed(2),
    entries,
  });
}));

// ── Purchases (§20/§21) — one authoritative payable entry per invoice ────────
router.post('/:id/purchases', requirePerm('suppliers:update'), asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound('Supplier not found');
  const amount = needNum(req.body, 'amount', { min: 0.01 });
  const sourceType = (optStr(req.body, 'source_type', { max: 20 }) || 'OTHER').toUpperCase();
  if (!PURCHASE_SOURCES.includes(sourceType)) throw bad(`source_type must be one of ${PURCHASE_SOURCES.join(', ')}`);
  const { row } = await tx(async (client) => {
    const sup = await supplierOrNull(client, req.params.id);
    if (!sup) throw notFound('Supplier not found');
    const reference = optStr(req.body, 'reference', { max: 60 }) || await nextDocNumber(client, 'supplier_purchase');
    const { rows } = await client.query(
      `INSERT INTO supplier_ledger_entries
         (supplier_id, entry_type, entry_date, reference, description, debit, source_table, created_by)
       VALUES ($1,'PURCHASE', COALESCE($2::date, CURRENT_DATE), $3, $4, $5, 'manual', $6) RETURNING *`,
      [req.params.id, optStr(req.body, 'entry_date', { max: 20 }), reference,
        optStr(req.body, 'description', { max: 300 }) || `${sourceType} purchase`, amount, req.user.sub]);
    await audit(client, { userId: req.user.sub, action: 'supplier.purchase', entity: 'supplier_ledger_entries', entityId: rows[0].id,
      details: { supplier: sup.name, amount, reference, source_type: sourceType }, ip: req.ip });
    return { row: rows[0] };
  });
  res.status(201).json({ entry: row });
}));

// ── Adjustments (§18): opening balance, credit notes, debit adjustments ──────
router.post('/:id/adjustments', requirePerm('suppliers:update'), asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound('Supplier not found');
  const amount = needNum(req.body, 'amount', { min: 0.01 });
  const entryType = (optStr(req.body, 'entry_type', { max: 20 }) || 'CREDIT_NOTE').toUpperCase();
  if (!['OPENING', 'CREDIT_NOTE', 'DEBIT_ADJUSTMENT'].includes(entryType)) {
    throw bad('entry_type must be OPENING, CREDIT_NOTE or DEBIT_ADJUSTMENT');
  }
  const reason = needStr(req.body, 'reason', { max: 300 });
  const { row: adjustment, ledger: adjustmentLedger } = await tx(async (client) => {
    const sup = await supplierOrNull(client, req.params.id);
    if (!sup) throw notFound('Supplier not found');
    const adjustmentNo = await nextDocNumber(client, 'supplier_adjustment');
    const { rows } = await client.query(
      `INSERT INTO supplier_adjustments (adjustment_no, supplier_id, entry_type, amount, entry_date, reason, notes, created_by, client_uuid)
       VALUES ($1,$2,$3,$4, COALESCE($5::date, CURRENT_DATE),$6,$7,$8,$9) RETURNING *`,
      [adjustmentNo, req.params.id, entryType, amount, optStr(req.body, 'entry_date', { max: 20 }),
        reason, optStr(req.body, 'notes', { max: 300 }), req.user.sub, optUuid(req.body, 'client_uuid')]);
    // DEBIT increases payable (opening/debit adjustments); CREDIT decreases (credit notes).
    const side = entryType === 'CREDIT_NOTE' ? 'credit' : 'debit';
    const { rows: ledger } = await client.query(
      `INSERT INTO supplier_ledger_entries
         (supplier_id, entry_type, entry_date, reference, description, ${side}, source_table, source_id, created_by)
       VALUES ($1,$2, COALESCE($3::date, CURRENT_DATE),$4,$5,$6,'supplier_adjustments',$7,$8) RETURNING *`,
      [req.params.id, entryType, optStr(req.body, 'entry_date', { max: 20 }), adjustmentNo,
        `${entryType.replace('_', ' ')} — ${reason}`, amount, rows[0].id, req.user.sub]);
    await audit(client, { userId: req.user.sub, action: `supplier.adjustment.${entryType.toLowerCase()}`, entity: 'supplier_adjustments',
      entityId: rows[0].id, details: { supplier: sup.name, amount, reason }, ip: req.ip });
    return { row: rows[0], ledger: ledger[0] };
  });
  res.status(201).json({ adjustment, ledger: adjustmentLedger });
}));

// ── Payments (§22–§26) ───────────────────────────────────────────────────────
// Outstanding purchase invoices for the allocation UI (§24).
router.get('/:id/outstanding', requirePerm('supplier_payments:view'), asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound('Supplier not found');
  const { rows } = await pool.query(
    `SELECT l.id, l.entry_date, l.reference, l.description, l.debit::float AS amount,
            COALESCE(a.allocated, 0)::float AS allocated, (l.debit - COALESCE(a.allocated,0))::float AS outstanding
       FROM supplier_ledger_entries l
       LEFT JOIN (SELECT ledger_entry_id, SUM(amount)::float AS allocated FROM supplier_payment_allocations GROUP BY ledger_entry_id) a
         ON a.ledger_entry_id = l.id
      WHERE l.supplier_id = $1 AND l.entry_type = 'PURCHASE' AND l.debit - COALESCE(a.allocated, 0) > 0.005
      ORDER BY l.entry_date ASC, l.id ASC`, [req.params.id]);
  res.json({ outstanding: rows });
}));

router.get('/:id/payments', requirePerm('supplier_payments:view'), asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound('Supplier not found');
  const { rows } = await pool.query(
    `SELECT p.*, u.name AS created_by_name,
            (SELECT COALESCE(SUM(amount),0)::float FROM supplier_payment_allocations a WHERE a.payment_id = p.id) AS allocated_amount
       FROM supplier_payments p LEFT JOIN users u ON u.id = p.created_by
      WHERE p.supplier_id = $1 ORDER BY p.payment_date DESC, p.created_at DESC LIMIT 300`, [req.params.id]);
  res.json({ payments: rows.map((r) => ({ ...r, amount: Number(r.amount), allocated_amount: Number(r.allocated_amount), unallocated: +(Number(r.amount) - Number(r.allocated_amount)).toFixed(2) })) });
}));

router.post('/:id/payments', requirePerm('supplier_payments:create'), asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound('Supplier not found');
  const amount = needNum(req.body, 'amount', { min: 0.01 });
  const method = (optStr(req.body, 'payment_method', { max: 20 }) || 'CASH').toUpperCase();
  if (!PAYMENT_METHODS.includes(method)) throw bad(`payment_method must be one of ${PAYMENT_METHODS.join(', ')}`);
  const allocationsIn = Array.isArray(req.body.allocations) ? req.body.allocations : [];
  if (allocationsIn.length > 100) throw bad('Too many allocations');

  const { row, duplicate } = await tx(async (client) => {
    const sup = await supplierOrNull(client, req.params.id);
    if (!sup) throw notFound('Supplier not found');

    const existing = req.body.client_uuid
      ? (await client.query('SELECT * FROM supplier_payments WHERE client_uuid = $1', [req.body.client_uuid])).rows[0]
      : null;
    if (existing) return { row: existing, duplicate: true };

    const paymentNo = await nextDocNumber(client, 'supplier_payment');
    const { rows } = await client.query(
      `INSERT INTO supplier_payments
         (payment_no, supplier_id, payment_date, amount, payment_method, bank, reference, account, notes, created_by, client_uuid)
       VALUES ($1,$2, COALESCE($3::date, CURRENT_DATE),$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [paymentNo, req.params.id, optStr(req.body, 'payment_date', { max: 20 }), amount, method,
        optStr(req.body, 'bank', { max: 120 }), optStr(req.body, 'reference', { max: 80 }),
        optStr(req.body, 'account', { max: 80 }), optStr(req.body, 'notes', { max: 300 }),
        req.user.sub, optUuid(req.body, 'client_uuid')]);
    const payment = rows[0];

    // §24/§25 — allocations are optional; partial payments allowed; whatever
    // is not allocated simply stays Unallocated Supplier Credit.
    let allocated = 0;
    for (const al of allocationsIn) {
      const ledgerEntryId = String(al.ledger_entry_id || '');
      const alAmount = Number(al.amount);
      if (!isUuid(ledgerEntryId) || !Number.isFinite(alAmount) || alAmount <= 0) throw bad('Each allocation needs ledger_entry_id and a positive amount');
      const { rows: inv } = await client.query(
        `SELECT * FROM supplier_ledger_entries
          WHERE id = $1 AND supplier_id = $2 AND entry_type = 'PURCHASE' FOR UPDATE`, [ledgerEntryId, req.params.id]);
      if (!inv.length) throw bad('Allocation target is not a purchase invoice of this supplier');
      const { rows: already } = await client.query(
        'SELECT COALESCE(SUM(amount),0)::float AS n FROM supplier_payment_allocations WHERE ledger_entry_id = $1', [ledgerEntryId]);
      const outstanding = Number(inv[0].debit) - Number(already[0].n);
      if (alAmount > outstanding + 0.005) throw bad(`Allocation of ${alAmount} exceeds the outstanding ${outstanding.toFixed(2)} on ${inv[0].reference || 'invoice'}`);
      await client.query(
        `INSERT INTO supplier_payment_allocations (payment_id, ledger_entry_id, amount, created_by) VALUES ($1,$2,$3,$4)`,
        [payment.id, ledgerEntryId, alAmount, req.user.sub]);
      allocated += alAmount;
    }
    if (allocated > amount + 0.005) throw bad(`Allocated ${allocated.toFixed(2)} exceeds the payment amount ${amount.toFixed(2)}`);

    // §26/§48 — the payment itself is a ledger CREDIT entry. Balances never
    // change without a ledger row.
    const { rows: ledger } = await client.query(
      `INSERT INTO supplier_ledger_entries
         (supplier_id, entry_type, entry_date, reference, description, credit, source_table, source_id, created_by)
       VALUES ($1,'PAYMENT', COALESCE($2::date, CURRENT_DATE),$3,$4,$5,'supplier_payments',$6,$7) RETURNING *`,
      [req.params.id, optStr(req.body, 'payment_date', { max: 20 }), paymentNo,
        `Payment ${paymentNo}${method !== 'CASH' ? ` (${method})` : ''}`, amount, payment.id, req.user.sub]);

    await audit(client, { userId: req.user.sub, action: 'supplier.payment', entity: 'supplier_payments', entityId: payment.id,
      details: { supplier: sup.name, amount, method, reference: payment.reference, allocated: +allocated.toFixed(2), unallocated: +(amount - allocated).toFixed(2) }, ip: req.ip });
    return { row: { ...payment, ledger_entry_id: ledger[0].id, allocated_amount: +allocated.toFixed(2), unallocated: +(amount - allocated).toFixed(2) }, duplicate: false };
  });
  res.status(duplicate ? 200 : 201).json({ payment: row, duplicate });
}));

router.get('/payments/:paymentId', requirePerm('supplier_payments:view'), asyncH(async (req, res) => {
  if (!isUuid(req.params.paymentId)) throw notFound('Payment not found');
  const { rows } = await pool.query(
    `SELECT p.*, s.name AS supplier_name, u.name AS created_by_name, ru.name AS reversed_by_name,
            l.id AS ledger_entry_id
       FROM supplier_payments p
       JOIN suppliers s ON s.id = p.supplier_id
       LEFT JOIN users u ON u.id = p.created_by
       LEFT JOIN users ru ON ru.id = p.reversed_by
       LEFT JOIN supplier_ledger_entries l ON l.source_table = 'supplier_payments' AND l.source_id = p.id
      WHERE p.id = $1`, [req.params.paymentId]);
  if (!rows.length) throw notFound('Payment not found');
  const { rows: allocations } = await pool.query(
    `SELECT a.*, l.reference AS invoice_reference, l.entry_date AS invoice_date, l.debit::float AS invoice_amount
       FROM supplier_payment_allocations a JOIN supplier_ledger_entries l ON l.id = a.ledger_entry_id
      WHERE a.payment_id = $1 ORDER BY a.created_at`, [req.params.paymentId]);
  const p = rows[0];
  res.json({
    payment: { ...p, amount: Number(p.amount) },
    allocations,
    audit_hint: { action: 'supplier.payment', entity: 'supplier_payments', entity_id: p.id },
  });
}));

// §26 — reversal with reason/user/date/reference; auditable opposite entry.
router.post('/payments/:paymentId/reverse', requirePerm('supplier_payments:reverse'), asyncH(async (req, res) => {
  const reason = needStr(req.body, 'reason', { max: 300 });
  const { row } = await tx(async (client) => {
    const { rows } = await client.query('SELECT * FROM supplier_payments WHERE id = $1 FOR UPDATE', [req.params.paymentId]);
    if (!rows.length) throw notFound('Payment not found');
    const payment = rows[0];
    if (payment.status === 'REVERSED') throw bad('This payment is already reversed');
    const { rows: upd } = await client.query(
      `UPDATE supplier_payments SET status = 'REVERSED', reversed_at = now(), reversed_by = $2, reversal_reason = $3
        WHERE id = $1 RETURNING *`, [req.params.paymentId, req.user.sub, reason]);
    const { rows: ledger } = await client.query(
      `INSERT INTO supplier_ledger_entries
         (supplier_id, entry_type, entry_date, reference, description, debit, source_table, source_id, created_by)
       VALUES ($1,'REVERSAL', CURRENT_DATE,$2,$3,$4,'supplier_payments',$5,$6) RETURNING *`,
      [payment.supplier_id, `REV-${payment.payment_no}`,
        `Reversal of payment ${payment.payment_no} — ${reason}`, Number(payment.amount), payment.id, req.user.sub]);
    await audit(client, { userId: req.user.sub, action: 'supplier.payment.reversed', entity: 'supplier_payments', entityId: payment.id,
      details: { payment_no: payment.payment_no, reason }, ip: req.ip });
    return { row: { ...upd[0], reversal_ledger_entry_id: ledger[0].id } };
  });
  res.json({ payment: row });
}));

export default router;
