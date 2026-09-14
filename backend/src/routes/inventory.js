// Inventory operations: bulk receipts (purchases), adjustments, stock levels,
// pump/tank readings, and persistent file uploads.
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pool, tx } from '../db/pool.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncH, notFound, bad } from '../middleware/errors.js';
import { needUuid, needNum, needStr, needOneOf, optUuid, isUuid } from '../middleware/validate.js';
import { createReceipt, createAdjustment, createReading } from '../services/ops.js';
import { stockByFuelType, stockByTank, ledgerSummary } from '../services/ledger.js';
import { config } from '../config.js';
import { createApproval } from '../services/approvals.js';

const router = Router();
router.use(requireAuth);

// ── Stock ────────────────────────────────────────────────────────────────────
router.get('/stock', asyncH(async (_req, res) => {
  const [byType, byTank] = await Promise.all([stockByFuelType(), stockByTank()]);
  res.json({ by_fuel_type: byType, by_tank: byTank });
}));

router.get('/summary', asyncH(async (req, res) => {
  const fuelTypeId = String(req.query.fuel_type_id || '');
  if (!isUuid(fuelTypeId)) throw bad('fuel_type_id query parameter must be a UUID');
  const to = req.query.to ? new Date(String(req.query.to)) : new Date();
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(to.getTime() - 30 * 864e5);
  res.json({ summary: await ledgerSummary(fuelTypeId, from, to) });
}));

// ── Bulk receipts / purchases ────────────────────────────────────────────────
router.get('/receipts', asyncH(async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 200), 500);
  const { rows } = await pool.query(
    `SELECT p.*, ft.name AS fuel_type_name, t.name AS tank_name, u.name AS received_by_name
       FROM purchases p
       JOIN fuel_types ft ON ft.id = p.fuel_type_id
       JOIN tanks t ON t.id = p.tank_id
       LEFT JOIN users u ON u.id = p.received_by
      ORDER BY p.created_at DESC LIMIT $1`, [limit]);
  res.json({ receipts: rows });
}));

router.post('/receipts', requireRole('manager', 'admin'), asyncH(async (req, res) => {
  const payload = {
    fuel_type_id: needUuid(req.body, 'fuel_type_id'),
    tank_id: needUuid(req.body, 'tank_id'),
    quantity: needNum(req.body, 'quantity', { max: 10_000_000 }),
    supplier: needStr(req.body, 'supplier', { max: 200 }),
    invoice_no: needStr(req.body, 'invoice_no', { max: 80, optional: true }),
    unit_price: needNum(req.body, 'unit_price', { min: 0, optional: true }),
    delivery_note: needStr(req.body, 'delivery_note', { max: 200, optional: true }),
    client_uuid: optUuid(req.body, 'client_uuid'),
  };
  const { row, duplicate } = await tx((client) => createReceipt(client, { payload, userId: req.user.sub }));
  res.status(duplicate ? 200 : 201).json({ receipt: row, duplicate });
}));

// ── Adjustments (signed, reason mandatory, always audited) ──────────────────
router.post('/adjustments', requireRole('manager', 'admin'), asyncH(async (req, res) => {
  const payload = {
    fuel_type_id: needUuid(req.body, 'fuel_type_id'),
    tank_id: needUuid(req.body, 'tank_id'),
    quantity: needNum(req.body, 'quantity', { signed: true, max: 1_000_000 }),
    reason: needStr(req.body, 'reason', { max: 300 }),
  };
  // §20/§53 — adjustments route through approval by default: the fuel-ledger
  // entry is posted ONLY when the approval is APPROVED (same transaction),
  // so a pending/rejected adjustment can never alter finalized stock.
  const { rows: cfg } = await pool.query(`SELECT value FROM settings WHERE key = 'approvals.adjustments_require_approval'`);
  const requireApproval = cfg.length ? cfg[0].value !== false : true;
  if (requireApproval) {
    const { id, existing } = await createApproval(pool, {
      entityType: 'inventory_adjustment',
      entityId: isUuid(String(req.body.client_uuid || '')) ? String(req.body.client_uuid) : (isUuid(String(req.body.entity_id || '')) ? String(req.body.entity_id) : crypto.randomUUID()),
      requestedBy: req.user.sub,
      quantity: payload.quantity,
      payload,
      clientUuid: isUuid(String(req.body.client_uuid || '')) ? String(req.body.client_uuid) : null,
      notifyTitle: 'Inventory adjustment requires approval',
      notifyMessage: `${payload.quantity > 0 ? '+' : ''}${payload.quantity} L — ${payload.reason}`,
      severity: 'WARNING',
    });
    return res.status(existing ? 200 : 202).json({ approval_id: id, pending: true, existing });
  }
  const { row } = await tx((client) => createAdjustment(client, { payload, userId: req.user.sub }));
  res.status(201).json({ adjustment: row });
}));

// ── Readings (pump meter / tank dip) ─────────────────────────────────────────
router.get('/readings', asyncH(async (req, res) => {
  const type = needOneOf(req.query, 'type', ['pump', 'tank'], { optional: true, fallback: 'pump' });
  const limit = Math.min(Number(req.query.limit || 200), 500);
  if (type === 'pump') {
    const params = [];
    let where = '';
    if (req.query.pump_id) { params.push(String(req.query.pump_id)); where = `WHERE r.pump_id = $1`; }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT r.*, p.name AS pump_name, u.name AS recorded_by_name
         FROM pump_readings r JOIN pumps p ON p.id = r.pump_id
         LEFT JOIN users u ON u.id = r.recorded_by
         ${where} ORDER BY r.created_at DESC LIMIT $${params.length}`, params);
    return res.json({ readings: rows });
  }
  const params = [];
  let where = '';
  if (req.query.tank_id) { params.push(String(req.query.tank_id)); where = `WHERE r.tank_id = $1`; }
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT r.*, t.name AS tank_name, u.name AS recorded_by_name
       FROM tank_readings r JOIN tanks t ON t.id = r.tank_id
       LEFT JOIN users u ON u.id = r.recorded_by
       ${where} ORDER BY r.created_at DESC LIMIT $${params.length}`, params);
  res.json({ readings: rows });
}));

router.post('/readings', asyncH(async (req, res) => {
  const payload = {
    type: needOneOf(req.body, 'type', ['pump', 'tank']),
    pump_id: optUuid(req.body, 'pump_id'),
    tank_id: optUuid(req.body, 'tank_id'),
    reading: needNum(req.body, 'reading', { min: 0, optional: true }),
    dip: needNum(req.body, 'dip', { min: 0, optional: true }),
    quantity_estimate: needNum(req.body, 'quantity_estimate', { min: 0, optional: true }),
    client_uuid: optUuid(req.body, 'client_uuid'),
  };
  const { row, kind } = await tx((client) => createReading(client, { payload, userId: req.user.sub }));
  res.status(201).json({ [kind === 'pump' ? 'pump_reading' : 'tank_reading']: row });
}));

// ── Persistent uploads (documents, invoices, receipts, images) ──────────────
// Files are stored in the persistent `fleetfuel_uploads` Docker volume, so
// they survive every deployment, rebuild and restart. Metadata lives in DB.
router.get('/uploads', asyncH(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.filename, u.mime, u.size_bytes, u.entity_type, u.entity_id, u.created_at,
            us.name AS uploaded_by_name
       FROM uploads u LEFT JOIN users us ON us.id = u.uploaded_by
      ORDER BY u.created_at DESC LIMIT 500`);
  res.json({ uploads: rows });
}));

router.post('/uploads', asyncH(async (req, res) => {
  const filename = needStr(req.body, 'filename', { max: 200 });
  const data = needStr(req.body, 'data', { max: Math.ceil((config.maxUploadBytes * 4) / 3) + 1000 });
  const mime = needStr(req.body, 'mime', { max: 100, optional: true }) || 'application/octet-stream';
  const entityType = needStr(req.body, 'entity_type', { max: 40, optional: true });
  const entityId = optUuid(req.body, 'entity_id');

  const buf = Buffer.from(data, 'base64');
  if (!buf.length) throw bad('Empty file');
  if (buf.length > config.maxUploadBytes) throw bad(`File exceeds ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB limit`);

  const id = crypto.randomUUID();
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'file';
  const storageName = `${id}-${safeName}`;
  const dir = path.join(config.uploadsDir, new Date().toISOString().slice(0, 7)); // YYYY-MM folders
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, storageName), buf);

  const { rows } = await pool.query(
    `INSERT INTO uploads (id, filename, mime, size_bytes, storage_path, entity_type, entity_id, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, filename, mime, size_bytes, created_at`,
    [id, safeName, mime, buf.length, path.join(path.basename(dir), storageName), entityType, entityId, req.user.sub]);
  res.status(201).json({ upload: rows[0] });
}));

router.get('/uploads/:id/download', asyncH(async (req, res, next) => {
  if (!isUuid(req.params.id)) throw notFound('File not found');
  const { rows } = await pool.query(`SELECT * FROM uploads WHERE id = $1`, [req.params.id]);
  if (!rows.length) throw notFound('File not found');
  const full = path.join(config.uploadsDir, rows[0].storage_path);
  if (!fs.existsSync(full)) return next(notFound('File missing from storage volume'));
  res.setHeader('Content-Type', rows[0].mime);
  res.setHeader('Content-Disposition', `attachment; filename="${rows[0].filename}"`);
  fs.createReadStream(full).pipe(res);
}));

export default router;
