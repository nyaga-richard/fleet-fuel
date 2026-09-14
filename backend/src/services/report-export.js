// ============================================================================
// Export engine (§3–§8): turn a DATASET (see services/reports.js) into
// CSV, a real XLSX (exceljs) or a professionally formatted PDF (pdfkit).
// Same dataset as the screen → filters and data always match (§44).
// ============================================================================
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

const two = (n) => String(n).padStart(2, '0');
/** DD/MM/YYYY HH:mm in the server's configured TZ (Africa/Nairobi). */
export function fmtDateTime(d) {
  const dt = new Date(d);
  return `${two(dt.getDate())}/${two(dt.getMonth() + 1)}/${dt.getFullYear()} ${two(dt.getHours())}:${two(dt.getMinutes())}`;
}
const fmtDate = (d) => fmtDateTime(d).split(' ')[0];
const money = (v, cur) => `${cur} ${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (v) => Number(v).toLocaleString(undefined, { maximumFractionDigits: 3 });

function cellText(col, row, cur) {
  const v = row[col.key];
  if (v == null || v === '') return '';
  if (col.type === 'datetime') return fmtDateTime(v);
  if (col.type === 'date') return fmtDate(v);
  if (col.type === 'money') return money(v, cur);
  if (col.type === 'number') return num(v);
  return String(v);
}

// ── CSV (§8 "where appropriate") ─────────────────────────────────────────────
export function toCSV(ds) {
  const esc = (s) => /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  const lines = [];
  lines.push(esc(`${ds.meta.org.orgName} — ${ds.title}`));
  lines.push(...ds.meta.filters.map(esc));
  lines.push('');
  lines.push(ds.columns.map((c) => esc(c.label)).join(','));
  for (const r of ds.rows) lines.push(ds.columns.map((c) => esc(cellText(c, r, ds.meta.org.currency))).join(','));
  if (ds.totals) {
    lines.push(ds.columns.map((c) => {
      if (c.key === ds.columns[0].key) return esc('TOTAL');
      const v = ds.totals[c.key];
      if (v == null) return '';
      return esc(c.type === 'money' ? money(v, ds.meta.org.currency) : num(v));
    }).join(','));
  }
  return lines.join('\n');
}

// ── XLSX (§6/§7) — real workbook, typed cells, freeze, autofilter, totals ────
export async function toXLSX(ds) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Fleet Fuel Management System';
  wb.created = new Date();
  const ws = wb.addWorksheet(ds.title.replace(/[\\/*?:[\]]/g, '').slice(0, 31) || 'Report');
  const cur = ds.meta.org.currency;

  let r = 1;
  ws.getCell(`A${r}`).value = ds.meta.org.orgName;
  ws.getCell(`A${r}`).font = { bold: true, size: 13 };
  r += 1;
  ws.getCell(`A${r}`).value = ds.meta.org.reportLine;
  ws.getCell(`A${r}`).font = { size: 10, color: { argb: 'FF666666' } };
  r += 2;
  ws.getCell(`A${r}`).value = ds.title.toUpperCase();
  ws.getCell(`A${r}`).font = { bold: true, size: 12 };
  r += 1;
  for (const f of ds.meta.filters) { ws.getCell(`A${r}`).value = f; ws.getCell(`A${r}`).font = { size: 9, color: { argb: 'FF444444' } }; r += 1; }
  ws.getCell(`A${r}`).value = `Generated: ${fmtDateTime(new Date())}`;
  ws.getCell(`A${r}`).font = { size: 9, color: { argb: 'FF444444' } };
  r += 2;
  const headerRow = r;

  // Summary block (separate section, right side, §7)
  if (ds.summary?.length) {
    ds.summary.forEach((s, i) => {
      ws.getCell(`H${headerRow + i}`).value = s.label;
      ws.getCell(`H${headerRow + i}`).font = { bold: true, size: 9 };
      ws.getCell(`I${headerRow + i}`).value = s.value;
      ws.getCell(`I${headerRow + i}`).font = { size: 9 };
    });
  }

  const header = ws.getRow(headerRow);
  header.values = ds.columns.map((c) => c.label);
  header.font = { bold: true, size: 10 };
  header.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
    c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    c.alignment = { vertical: 'middle', wrapText: true };
  });

  for (const row of ds.rows) {
    const xr = ws.getRow(r);
    xr.values = ds.columns.map((c) => {
      const v = row[c.key];
      if (v == null || v === '') return '';
      if (c.type === 'datetime' || c.type === 'date') return new Date(v);
      return Number.isFinite(Number(v)) && c.type ? Number(v) : v;
    });
    xr.eachCell((c, colNumber) => {
      const col = ds.columns[colNumber - 1];
      if (!col) return;
      if (col.type === 'money') c.numFmt = `"${cur}" #,##0.00`;
      else if (col.type === 'number') c.numFmt = '#,##0.00';
      else if (col.type === 'datetime') c.numFmt = 'dd/mm/yyyy hh:mm';
      else if (col.type === 'date') c.numFmt = 'dd/mm/yyyy';
    });
    r += 1;
  }

  if (ds.totals) {
    const tr = ws.getRow(r);
    tr.values = ds.columns.map((c, i) => (i === 0 ? 'TOTAL' : (ds.totals[c.key] != null ? Number(ds.totals[c.key]) : '')));
    tr.font = { bold: true };
    tr.eachCell((c, colNumber) => {
      const col = ds.columns[colNumber - 1];
      if (col?.type === 'money') c.numFmt = `"${cur}" #,##0.00`;
      if (col?.type === 'number') c.numFmt = '#,##0.00';
    });
    r += 1;
  }

  ds.columns.forEach((c, i) => {
    ws.getColumn(i + 1).width = Math.max(c.label.length + 2, Math.min(c.width || 16, 44));
  });
  ws.views = [{ state: 'frozen', ySplit: headerRow }];                 // §7 freeze
  ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow, column: ds.columns.length } }; // §7
  return wb.xlsx.writeBuffer();
}

// ── PDF (§3–§5) — header block, repeating column headers, totals, page X of Y.
// Two-pass render for "of Y" (pdfkit streams are compressed, not patchable).
export function toPDF(ds, { generatedBy }) {
  return new Promise((resolve) => {
    const render = (totalPages) => new Promise((done) => {
      const landscape = ds.orientation === 'landscape';
      const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: 36, bufferPages: true });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      let pageCount = 0;
      doc.on('pageAdded', () => { pageCount += 1; });

      const org = ds.meta.org;
      const cur = org.currency;
      const left = 36, top = 36;
      const W = doc.page.width - 72;

      // Header block (§3)
      doc.font('Helvetica-Bold').fontSize(13).fillColor('#111').text(org.orgName, left, top);
      doc.font('Helvetica').fontSize(9).fillColor('#555').text(org.reportLine, left, doc.y + 1);
      doc.moveTo(left, doc.y + 4).lineTo(left + W, doc.y + 4).strokeColor('#cccccc').stroke();
      doc.font('Helvetica-Bold').fontSize(11.5).fillColor('#111').text(ds.title.toUpperCase(), left, doc.y + 8);
      doc.font('Helvetica').fontSize(8.5).fillColor('#444');
      for (const f of ds.meta.filters) doc.text(f, left, doc.y + 2);
      if (ds.summary?.length) doc.text(ds.summary.map((s) => `${s.label}: ${s.value}`).join('    ·    '), left, doc.y + 2);
      doc.fontSize(8).fillColor('#666').text(`Generated: ${fmtDateTime(new Date())}   ·   Generated By: ${generatedBy || '—'}`, left, doc.y + 2);
      const tableTop = doc.y + 14;

      // Column layout — width weights → absolute columns
      const totalW = ds.columns.reduce((a, c) => a + (c.width || 12), 0);
      const cols = ds.columns.map((c) => ({ ...c, w: (W * (c.width || 12)) / totalW }));
      let x = left;
      for (const c of cols) { c.x = x; x += c.w; }
      const rowFont = 7.4;

      function drawHeader(y) {
        doc.rect(left, y, W, 16).fill('#1F3A5F');
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7.6);
        for (const c of cols) {
          const label = c.label.length > 26 ? c.label.slice(0, 25) + '…' : c.label;
          doc.text(label, c.x + 2, y + 4, { width: c.w - 4, lines: 1, ellipsis: true });
        }
        return y + 16;
      }
      let y = drawHeader(tableTop);

      const bottom = doc.page.height - 46;
      for (const row of ds.rows) {
        const cells = cols.map((c) => cellText(c, row, cur));
        doc.font('Helvetica').fontSize(rowFont);
        const lineHs = cells.map((t, i) => doc.heightOfString(t, { width: cols[i].w - 4 }) || rowFont + 1);
        const rowH = Math.max(...lineHs, rowFont + 2) + 4;
        if (y + rowH > bottom) {
          doc.addPage();
          y = drawHeader(top);
        }
        if ((ds.rows.indexOf(row) % 2) === 1) doc.rect(left, y, W, rowH).fill('#f4f6fa');
        doc.fillColor('#111');
        cols.forEach((c, i) => {
          doc.text(cells[i], c.x + 2, y + 2, { width: c.w - 4 });
        });
        doc.moveTo(left, y + rowH).lineTo(left + W, y + rowH).strokeColor('#e3e7ee').lineWidth(0.4).stroke();
        y += rowH;
      }

      if (ds.totals) {
        y += 2;
        if (y > bottom - 18) { doc.addPage(); y = drawHeader(top); }
        doc.moveTo(left, y).lineTo(left + W, y).strokeColor('#1F3A5F').lineWidth(1).stroke();
        doc.font('Helvetica-Bold').fontSize(rowFont + 0.4).fillColor('#111');
        cols.forEach((c, i) => {
          const v = ds.totals[c.key];
          const label = i === 0 ? 'TOTAL' : v == null ? '' : c.type === 'money' ? money(v, cur) : num(v);
          doc.text(label, c.x + 2, y + 3, { width: c.w - 4 });
        });
        y += 16;
      }

      // Footers on every rendered page (§4)
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i += 1) {
        doc.switchToPage(i);
        doc.font('Helvetica').fontSize(7.5).fillColor('#666')
          .text(`${ds.title} — Generated by Fleet Fuel Management System`, left, doc.page.height - 34, { width: W / 2, lineBreak: false });
        doc.text(`Generated: ${fmtDateTime(new Date())}`, left + W / 2, doc.page.height - 34, { width: W / 2 - 70, align: 'right', lineBreak: false });
        const pageLabel = totalPages ? `Page ${i - range.start + 1} of ${totalPages}` : `Page ${i - range.start + 1}`;
        doc.text(pageLabel, left + W - 60, doc.page.height - 34, { width: 60, align: 'right', lineBreak: false });
      }

      doc.end();
      doc.on('end', () => done({ buffer: Buffer.concat(chunks), pages: pageCount }));
    });

    (async () => {
      const first = await render(null);           // pass 1 — count pages
      if (first.pages === 1) return resolve(first.buffer);
      const second = await render(first.pages);   // pass 2 — "Page X of Y"
      resolve(second.buffer);
    })();
  });
}
