// ============================================================================
// /api/tires/import — safe multi-step bulk tire import (§9–§16).
//   parse → preview (validate, row-level errors) → commit (transactional,
//   duplicates SKIPPED by default, never overwritten) → summary.
// Every step is audited (§44); batches + per-row errors are stored so
// management can view import history (§16) and reports (§45).
// ============================================================================
import crypto from 'node:crypto';
import xlsx from 'xlsx';

/** Deterministic UUID for an imported tire (idempotent re-imports). */
function uuidImport(batchId, serial) {
  const h = crypto.createHash('md5').update(`tire-import:${batchId}:${serial}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
import { Router } from 'express';
import { pool, tx } from '../db/pool.js';
import { requireAuth, requirePerm, requireRole } from '../middleware/auth.js';
import { asyncH, bad, notFound } from '../middleware/errors.js';
import { needStr, optStr } from '../middleware/validate.js';
import { audit } from '../services/audit.js';

const router = Router();
router.use(requireAuth);

const SUPPLY_CONDITIONS = ['NEW', 'RETREAD'];
const TIRE_TYPES = ['TUBELESS', 'TUBE', 'RADIAL', 'BIAS'];
const TIRE_STATUSES = ['IN_STORE', 'USED_STORE', 'ON_VEHICLE', 'AWAITING_RETREAD', 'AT_RETREAD_SUPPLIER', 'DISPOSED'];
const SIZE_RE = /^[0-9]{2,4}(\.[0-9])?((\/|\s?[A-Z]{1,3})[0-9]{1,3}([A-Z]{0,2})?)?$/; // 11R22.5, 205/75R17.5, 295/80R22.5…

// Column aliases — headers are normalized (lowercase, underscores).
const ALIASES = {
  serial_number: 'serial_no', serial: 'serial_no', serialno: 'serial_no',
  brand: 'brand', manufacturer: 'brand', model: 'model', size: 'size', pattern: 'pattern',
  ply_rating: 'ply_rating', ply: 'ply_rating', type: 'tire_type', tire_type: 'tire_type',
  condition: 'supply_condition', supply_condition: 'supply_condition',
  purchase_date: 'purchase_date', purchase_cost: 'purchase_cost', cost: 'purchase_cost',
  supplier: 'supplier', invoice_number: 'invoice_no', invoice_no: 'invoice_no',
  retread_count: 'retread_count', retreads: 'retread_count',
  tread_depth: 'tread_depth_mm', tread_depth_mm: 'tread_depth_mm', tread: 'tread_depth_mm',
  status: 'status', notes: 'notes',
};
const norm = (h) => String(h || '').trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z_]/g, '');

/** Parse an uploaded CSV or XLSX file (base64) into normalized row objects. */
router.post('/parse', requirePerm('tire_imports:view'), requireRole('manager', 'admin'), asyncH(async (req, res) => {
  const b64 = needStr(req.body, 'file_b64', { max: 30_000_000 });
  const filename = String(req.body.filename || 'import');
  let rows;
  if (/\.csv$/i.test(filename) || /\.txt$/i.test(filename) || req.body.format === 'csv') {
    const text = Buffer.from(b64, 'base64').toString('utf8');
    const table = text.split(/\r?\n/).map((l) => l.split(',').map((c) => c.replace(/^"|"$/g, '').trim()));
    const clean = table.filter((r) => r.some((c) => c !== ''));
    if (!clean.length) throw bad('The file is empty');
    rows = clean.slice(1).map((cells) => {
      const o = {};
      clean[0].forEach((h, i) => { o[norm(ALIASES[norm(h)] || norm(h)) || `col${i}`] = (cells[i] ?? '').trim(); });
      return o;
    });
  } else {
    const wb = xlsx.read(Buffer.from(b64, 'base64'), { type: 'buffer', cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    rows = xlsx.utils.sheet_to_json(sheet, { defval: '', raw: false }).map((r) => {
      const o = {};
      for (const [k, v] of Object.entries(r)) o[norm(ALIASES[norm(k)] || norm(k)) || norm(k)] = String(v ?? '').trim();
      return o;
    });
  }
  res.json({ rows: rows.filter((r) => Object.values(r).some((v) => String(v).trim() !== '')), columns_detected: rows.length ? Object.keys(rows[0]) : [] });
}));

/** Validate one row; returns { ok, errors:[{field,message}], warnings, duplicate }. */
async function validateRow(row, index, seenSerials) {
  const errors = []; const warnings = [];
  const serial = String(row.serial_no || '').trim().toUpperCase();
  if (!serial) errors.push({ field: 'serial_no', message: 'Serial number is required (§13)' });
  else if (serial.length > 40) errors.push({ field: 'serial_no', message: 'Serial number is too long' });
  else if (seenSerials.has(serial)) errors.push({ field: 'serial_no', message: `Duplicate serial number within the file: ${serial}` });
  if (serial) seenSerials.add(serial);

  const size = String(row.size || '').trim();
  if (size && !SIZE_RE.test(size)) warnings.push({ field: 'size', message: `Size "${size}" does not look like a standard tire size` });

  const type = String(row.tire_type || '').trim().toUpperCase();
  if (type && !TIRE_TYPES.includes(type)) errors.push({ field: 'tire_type', message: `Type must be one of ${TIRE_TYPES.join(', ')}` });

  const cond = String(row.supply_condition || '').trim().toUpperCase();
  if (cond && !SUPPLY_CONDITIONS.includes(cond)) errors.push({ field: 'supply_condition', message: 'Condition must be NEW or RETREAD' });

  const status = String(row.status || '').trim().toUpperCase();
  if (status && !TIRE_STATUSES.includes(status)) errors.push({ field: 'status', message: `Status must be one of ${TIRE_STATUSES.join(', ')}` });
  if (status === 'ON_VEHICLE') errors.push({ field: 'status', message: 'Imported tires cannot arrive already ON_VEHICLE — fit them through the tire workflow' });

  const cost = row.purchase_cost;
  if (cost !== '' && cost != null) {
    const n = Number(cost);
    if (!Number.isFinite(n) || n < 0) errors.push({ field: 'purchase_cost', message: `Purchase cost "${cost}" must be a number ≥ 0` });
  }
  const tread = row.tread_depth_mm;
  if (tread !== '' && tread != null) {
    const n = Number(tread);
    if (!Number.isFinite(n) || n < 0 || n > 40) errors.push({ field: 'tread_depth_mm', message: `Tread depth "${tread}" must be 0–40 mm` });
  }
  const retreads = row.retread_count;
  if (retreads !== '' && retreads != null) {
    const n = Number(retreads);
    if (!Number.isInteger(n) || n < 0 || n > 10) errors.push({ field: 'retread_count', message: `Retread count "${retreads}" must be an integer 0–10` });
  }
  for (const f of ['purchase_date']) {
    const v = row[f];
    if (v && isNaN(new Date(String(v)).getTime())) errors.push({ field: f, message: `"${v}" is not a valid date` });
  }
  // Supplier existence (§13) — matched against supplier master data when provided.
  const supplierName = String(row.supplier || '').trim();
  if (supplierName) {
    const { rows } = await pool.query('SELECT id FROM suppliers WHERE LOWER(name) = LOWER($1)', [supplierName]);
    if (!rows.length) warnings.push({ field: 'supplier', message: `Supplier "${supplierName}" is not in the supplier register — recorded as free text` });
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** Step: preview — validate everything, change nothing (§10/§12). */
router.post('/preview', requirePerm('tire_imports:view'), requireRole('manager', 'admin'), asyncH(async (req, res) => {
  const rowsIn = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rowsIn.length) throw bad('No rows to preview');
  if (rowsIn.length > 5000) throw bad('Import is limited to 5,000 rows per batch');

  const { rows: existing } = await pool.query('SELECT serial_no FROM tires');
  const dbSerials = new Set(existing.map((r) => String(r.serial_no).toUpperCase()));
  const seenSerials = new Set();

  const results = [];
  const summary = { total: rowsIn.length, valid: 0, error: 0, duplicate: 0, warning: 0 };
  for (let i = 0; i < rowsIn.length; i++) {
    const row = rowsIn[i];
    const v = await validateRow(row, i, seenSerials);
    const serial = String(row.serial_no || '').trim().toUpperCase();
    const isDup = !!serial && dbSerials.has(serial) && !v.errors.some((e) => e.field === 'serial_no' && /within the file/.test(e.message));
    const errors = [...v.errors];
    if (isDup) errors.push({ field: 'serial_no', message: 'Serial number already exists (§14)' });
    const kind = errors.length ? (isDup ? 'duplicate' : 'error') : 'valid';
    if (kind === 'valid') summary.valid++;
    else if (kind === 'duplicate') summary.duplicate++;
    else summary.error++;
    if (v.warnings.length) summary.warning++;
    results.push({ row_number: i + 1, serial_no: serial, kind, errors, warnings: v.warnings, data: row });
  }
  res.json({ summary, results });
}));

/** Step: commit — transactional insert; duplicates SKIPPED (default, §14). */
router.post('/commit', requirePerm('tire_imports:view'), requireRole('manager', 'admin'), asyncH(async (req, res) => {
  const rowsIn = Array.isArray(req.body.rows) ? req.body.rows : [];
  const fileName = optStr(req.body, 'filename', { max: 200 }) || 'manual entry';
  if (!rowsIn.length) throw bad('No rows to import');
  if (rowsIn.length > 5000) throw bad('Import is limited to 5,000 rows per batch');
  const skipDuplicates = req.body.skip_duplicates !== false; // §14 — default Skip

  const { summary, batch } = await tx(async (client) => {
    const { rows: batchRows } = await client.query(
      `INSERT INTO tire_import_batches (file_name, imported_by, total_rows, status) VALUES ($1,$2,$3,'COMPLETED') RETURNING *`,
      [fileName, req.user.sub, rowsIn.length]);
    const batchId = batchRows[0].id;
    const out = { created: 0, skipped: 0, failed: 0 };
    const { rows: existing } = await client.query('SELECT serial_no FROM tires FOR UPDATE');
    const dbSerials = new Set(existing.map((r) => String(r.serial_no).toUpperCase()));
    const seenSerials = new Set();

    for (let i = 0; i < rowsIn.length; i++) {
      const row = rowsIn[i];
      const v = await validateRow(row, i, seenSerials);
      const serial = String(row.serial_no || '').trim().toUpperCase();
      if (!v.ok) {
        out.failed++;
        for (const e of v.errors) {
          await client.query(`INSERT INTO tire_import_errors (batch_id, row_number, serial_no, field, message) VALUES ($1,$2,$3,$4,$5)`,
            [batchId, i + 1, serial || null, e.field, e.message]);
        }
        continue;
      }
      if (dbSerials.has(serial)) {
        if (skipDuplicates) { out.skipped++; continue; }
        out.failed++;
        await client.query(`INSERT INTO tire_import_errors (batch_id, row_number, serial_no, field, message) VALUES ($1,$2,$3,'serial_no',$4)`,
          [batchId, i + 1, serial, 'Serial number already exists (skip_duplicates disabled)']);
        continue;
      }
      // Insert — never overwrites an existing tire (§14).
      try {
        // Columns match the existing tires table exactly (§11) — optional
        // file columns that have no home (model/invoice_no) are ignored.
        await client.query(
          `INSERT INTO tires (serial_no, brand, size, pattern, ply_rating, tire_type, supply_condition,
                              purchase_date, purchase_cost, supplier, retread_count, tread_depth_mm, status, notes, client_uuid)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [serial,
            String(row.brand || '').trim() || null,
            String(row.size || '').trim() || null, String(row.pattern || '').trim() || null,
            String(row.ply_rating || '').trim() || null,
            String(row.tire_type || '').trim().toUpperCase() || null,
            String(row.supply_condition || '').trim().toUpperCase() || 'NEW',
            row.purchase_date ? new Date(String(row.purchase_date)).toISOString().slice(0, 10) : null,
            row.purchase_cost !== '' && row.purchase_cost != null && Number.isFinite(Number(row.purchase_cost)) ? Number(row.purchase_cost) : null,
            String(row.supplier || '').trim() || null,
            row.retread_count !== '' && row.retread_count != null ? Number(row.retread_count) : 0,
            row.tread_depth_mm !== '' && row.tread_depth_mm != null ? Number(row.tread_depth_mm) : null,
            String(row.status || '').trim().toUpperCase() || 'IN_STORE',
            [String(row.notes || '').trim(), String(row.model || '').trim() ? `Model: ${String(row.model).trim()}` : '', String(row.invoice_no || '').trim() ? `Invoice: ${String(row.invoice_no).trim()}` : ''].filter(Boolean).join(' · ') || null,
            uuidImport(batchId, serial)]);
        dbSerials.add(serial);
        out.created++;
      } catch (err) {
        out.failed++;
        await client.query(`INSERT INTO tire_import_errors (batch_id, row_number, serial_no, field, message) VALUES ($1,$2,$3,'database',$4)`,
          [batchId, i + 1, serial, err.message]);
      }
    }
    await client.query(
      `UPDATE tire_import_batches SET created_count = $2, skipped_count = $3, failed_count = $4 WHERE id = $1`,
      [batchId, out.created, out.skipped, out.failed]);
    await audit(client, { userId: req.user.sub, action: 'tires.import', entity: 'tire_import_batches', entityId: batchId,
      details: { file: fileName, rows: rowsIn.length, ...out }, ip: req.ip });
    return { summary: out, batch: batchRows[0] };
  });
  res.status(201).json({ batch: { ...batch, ...summary,
    created_count: summary.created, skipped_count: summary.skipped, failed_count: summary.failed } });
}));

// §16 — import history for management.
// ── Template download (§12) ─────────────────────────────────────────────────
// Header matches the import ALIASES exactly; one example row the user
// overwrites. Only truly-required fields are mandatory (§11).
router.get('/template', requireAuth, requirePerm('tire_imports:view'), asyncH(async (req, res) => {
  const header = 'serial_number,brand,size,pattern,type,condition,purchase_cost,supplier,status,retread_count,tread_depth';
  const example = 'TR-000123,Bridgestone,11R22.5,R249,TUBELESS,NEW,28000,ABC Fuel Suppliers,IN_STORE,0,14';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="tire-import-template.csv"');
  res.send(header + '\n' + example + '\n');
}));

router.get('/batches', requirePerm('tire_imports:view'), asyncH(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.*, u.name AS imported_by_name
       FROM tire_import_batches b LEFT JOIN users u ON u.id = b.imported_by
      ORDER BY b.created_at DESC LIMIT 200`);
  res.json({ batches: rows });
}));

router.get('/batches/:id', requirePerm('tire_imports:view'), asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound('Import batch not found');
  const { rows } = await pool.query(
    `SELECT b.*, u.name AS imported_by_name FROM tire_import_batches b LEFT JOIN users u ON u.id = b.imported_by WHERE b.id = $1`, [req.params.id]);
  if (!rows.length) throw notFound('Import batch not found');
  const { rows: errors } = await pool.query(
    'SELECT row_number, serial_no, field, message FROM tire_import_errors WHERE batch_id = $1 ORDER BY row_number', [req.params.id]);
  res.json({ batch: rows[0], errors });
}));

export default router;
