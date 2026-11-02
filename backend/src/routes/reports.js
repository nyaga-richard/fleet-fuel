// ============================================================================
// /api/reports — JSON datasets + PDF/XLSX/CSV exports (§1–§9, §42–§45).
// Export endpoints enforce the SAME permission as viewing (§43), run the SAME
// server-side filters as the screen (§44) and audit every generation (§45).
// ============================================================================
import { Router } from 'express';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { asyncH, bad } from '../middleware/errors.js';
import { REPORTS } from '../services/reports.js';
import { toCSV, toPDF, toXLSX } from '../services/report-export.js';
import { audit } from '../services/audit.js';
import { can } from '../services/permissions.js';

const router = Router();
router.use(requireAuth);

router.get('/:report', asyncH(async (req, res) => {
  const spec = REPORTS[req.params.report];
  if (!spec) throw bad(`Unknown report: ${req.params.report}`);
  if (!canView(req, spec)) return res.status(403).json({ error: `Requires permission: ${spec.perm}` });
  const ds = await spec.build(req.query, { page: req.query.page, pageSize: req.query.pageSize });
  res.json(ds);
}));

router.get('/:report/export/:format', asyncH(async (req, res) => {
  const spec = REPORTS[req.params.report];
  if (!spec) throw bad(`Unknown report: ${req.params.report}`);
  // §43: exports need the export permission AND the report's view permission.
  if (!canView(req, spec)) return res.status(403).json({ error: `Requires permission: ${spec.perm}` });

  const format = String(req.params.format).toLowerCase();
  if (!['pdf', 'excel', 'csv'].includes(format)) throw bad('Format must be pdf, excel or csv');

  const ds = await spec.build(req.query, { page: req.query.page, pageSize: req.query.pageSize });
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const base = `fleet-fuel-${req.params.report}-${stamp}`;
  const genBy = req.user.name || req.user.email || req.user.sub;

  let body, type;
  if (format === 'csv') {
    body = toCSV(ds); type = 'text/csv; charset=utf-8';
  } else if (format === 'excel') {
    body = await toXLSX(ds); type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  } else {
    body = await toPDF(ds, { generatedBy: genBy }); type = 'application/pdf';
  }

  // §45 — audit every export: user, report, format, filters, records, IP.
  await audit(null, {
    userId: req.user.sub,
    action: `report.export.${format}`,
    entity: 'report',
    entityId: req.params.report,
    details: { report: req.params.report, format, filters: req.query, records: ds.rows.length, title: ds.title },
    ip: req.ip,
  });

  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${base}.${format === 'excel' ? 'xlsx' : format}"`);
  if (typeof body === 'string') res.send(body); else res.send(Buffer.from(body));
}));

function canView(req, spec) {
  return can(req.user.role, spec.perm);
}

export default router;
