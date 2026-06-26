const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

const C = {
  dark:      '#111827',
  muted:     '#6B7280',
  border:    '#E5E7EB',
  surface:   '#F9FAFB',
  white:     '#FFFFFF',
  header_bg: '#1E1B4B',
  accent:    '#009E60',
  warn:      '#D97706',
  danger:    '#DC2626',
  primary:   '#7C3AED',
};

function money(val) { return `$${(+val || 0).toFixed(2)}`; }

async function generateStatutoryPdf(run, items, rates, verifyUrl) {
  rates = rates || { nis_employee: 0.065, nis_employer: 0.075, income_tax_rate: 0.10 };
  const qrBuf = verifyUrl ? await QRCode.toBuffer(verifyUrl, { type: 'png', width: 80, margin: 1 }) : null;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 45, size: 'A4' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const PAGE_W  = doc.page.width;
    const USE_W   = PAGE_W - 90;  // 45px margin each side
    const L       = 45;           // left edge

    const employer   = run.provider_name || 'Business';
    const period     = run.period_label  || `${run.period_start} — ${run.period_end}`;
    const totalStatutory = +(+run.total_nis_employee + +run.total_nis_employer + +run.total_income_tax).toFixed(2);

    // ── Header band ──────────────────────────────────────────────────────────
    doc.rect(0, 0, PAGE_W, 84).fill(C.header_bg);
    doc.fillColor(C.white).fontSize(20).font('Helvetica-Bold')
       .text('BridgePro Payroll', L, 18);
    doc.fontSize(10).font('Helvetica').fillColor('rgba(255,255,255,0.80)')
       .text('Statutory Compliance Report', L, 42);
    doc.fontSize(8.5).fillColor('rgba(255,255,255,0.55)')
       .text(`${employer}  ·  ${period}  ·  ${run.country_code || 'SVG'}`, L, 58);
    doc.fillColor('rgba(255,255,255,0.40)').fontSize(7.5)
       .text(`Generated ${new Date().toLocaleString('en-GB')}`, PAGE_W - 200, 58, { width: 155, align: 'right' });

    let y = 100;

    // ── Summary stat boxes ───────────────────────────────────────────────────
    const boxes = [
      { label: 'Employees',           value: String(run.employee_count),                  color: C.primary },
      { label: 'Total Gross Payroll', value: money(run.total_gross),                      color: C.dark },
      { label: 'Total Net Pay',       value: money(run.total_net),                        color: C.accent },
      { label: 'NIS (Employee)',      value: money(run.total_nis_employee),               color: C.warn },
      { label: 'NIS (Employer)',      value: money(run.total_nis_employer),               color: C.warn },
      { label: `Income Tax (${(rates.income_tax_rate*100).toFixed(0)}%)`, value: money(run.total_income_tax), color: C.danger },
    ];

    const boxW = (USE_W - 10) / 3;
    boxes.forEach((b, i) => {
      const col = i % 3, row = Math.floor(i / 3);
      const bx = L + col * (boxW + 5), by = y + row * 54;
      doc.roundedRect(bx, by, boxW, 46, 5).fill(C.surface);
      doc.fillColor(C.muted).fontSize(7).font('Helvetica')
         .text(b.label.toUpperCase(), bx + 8, by + 7, { width: boxW - 16 });
      doc.fillColor(b.color).fontSize(15).font('Helvetica-Bold')
         .text(b.value, bx + 8, by + 21, { width: boxW - 16 });
    });

    y += 116;

    // ── Statutory remittance alert ───────────────────────────────────────────
    doc.roundedRect(L, y, USE_W, 32, 5).fill('#FEF3C7');
    doc.fillColor(C.warn).fontSize(8.5).font('Helvetica-Bold')
       .text('STATUTORY REMITTANCE SUMMARY', L + 12, y + 6);
    doc.fillColor(C.dark).fontSize(8).font('Helvetica').text(
      `NIS Employee: ${money(run.total_nis_employee)}   |   ` +
      `NIS Employer: ${money(run.total_nis_employer)}   |   ` +
      `Income Tax: ${money(run.total_income_tax)}   |   ` +
      `TOTAL DUE: ${money(totalStatutory)}`,
      L + 12, y + 19
    );

    y += 44;

    // ── Table ────────────────────────────────────────────────────────────────
    const COLS = [
      { label: 'Employee',          x: L,    w: 130, align: 'left'  },
      { label: 'National ID',       x: 178,  w: 65,  align: 'left'  },
      { label: 'Gross Pay',         x: 246,  w: 58,  align: 'right' },
      { label: `NIS Emp`,           x: 307,  w: 52,  align: 'right' },
      { label: `NIS Emplr`,         x: 362,  w: 52,  align: 'right' },
      { label: 'Tax',               x: 417,  w: 46,  align: 'right' },
      { label: 'Net Pay',           x: 466,  w: 69,  align: 'right' },
    ];

    function drawTableHeader(yPos) {
      doc.rect(L, yPos, USE_W, 18).fill(C.header_bg);
      COLS.forEach(c => {
        doc.fillColor(C.white).fontSize(7).font('Helvetica-Bold')
           .text(c.label, c.x + 3, yPos + 5, { width: c.w - 6, align: c.align });
      });
      return yPos + 18;
    }

    y = drawTableHeader(y);

    const ROW_H = 24;
    items.forEach((item, idx) => {
      if (y + ROW_H > doc.page.height - 60) {
        doc.addPage();
        y = drawTableHeader(45);
      }
      if (idx % 2 === 1) doc.rect(L, y, USE_W, ROW_H).fill(C.surface);
      doc.rect(L, y, USE_W, ROW_H).strokeColor(C.border).lineWidth(0.5).stroke();

      doc.fillColor(C.dark).fontSize(8).font('Helvetica-Bold')
         .text((item.employee_name || '').slice(0, 24), L + 4, y + 4, { width: 122 });
      doc.fillColor(C.muted).fontSize(7).font('Helvetica')
         .text((item.position || '').slice(0, 22), L + 4, y + 14, { width: 122 });

      [
        { x: 178, w: 61, val: (item.national_id || '—').slice(0, 14), align: 'left' },
        { x: 246, w: 57, val: money(item.gross_pay),      align: 'right', bold: false },
        { x: 307, w: 51, val: money(item.nis_employee),   align: 'right', color: C.warn },
        { x: 362, w: 51, val: money(item.nis_employer),   align: 'right', color: C.warn },
        { x: 417, w: 45, val: money(item.income_tax),     align: 'right', color: C.danger },
        { x: 466, w: 65, val: money(item.net_pay),        align: 'right', bold: true, color: C.accent },
      ].forEach(cell => {
        doc.fillColor(cell.color || C.dark)
           .fontSize(8)
           .font(cell.bold ? 'Helvetica-Bold' : 'Helvetica')
           .text(cell.val, cell.x + 3, y + 8, { width: cell.w - 6, align: cell.align });
      });

      y += ROW_H;
    });

    // Totals row
    doc.rect(L, y, USE_W, 22).fill(C.header_bg);
    doc.fillColor(C.white).fontSize(8).font('Helvetica-Bold').text('TOTALS', L + 4, y + 7);
    [
      { x: 246, w: 57, val: money(run.total_gross) },
      { x: 307, w: 51, val: money(run.total_nis_employee) },
      { x: 362, w: 51, val: money(run.total_nis_employer) },
      { x: 417, w: 45, val: money(run.total_income_tax) },
      { x: 466, w: 65, val: money(run.total_net) },
    ].forEach(cell => {
      doc.fillColor(C.white).fontSize(8).font('Helvetica-Bold')
         .text(cell.val, cell.x + 3, y + 7, { width: cell.w - 6, align: 'right' });
    });

    y += 30;

    // ── Footer note ──────────────────────────────────────────────────────────
    if (y > doc.page.height - 70) { doc.addPage(); y = 45; }
    doc.fillColor(C.muted).fontSize(7).font('Helvetica')
       .text(
         `Rates applied: NIS Employee ${(rates.nis_employee*100).toFixed(1)}%  ·  NIS Employer ${(rates.nis_employer*100).toFixed(1)}%  ·  ` +
         `PAYE ${(rates.income_tax_rate*100).toFixed(0)}% on chargeable income (gross less NIS employee contribution and personal allowance)  ·  ` +
         `NIS contributions are capped at the statutory wage ceiling per period.  ·  ` +
         `This report is generated by BridgePro for informational and compliance-assistance purposes. ` +
         `Always verify statutory obligations with your local NIS and Inland Revenue authority.`,
         L, y, { width: qrBuf ? USE_W - 60 : USE_W, align: 'center' }
       );

    // QR code — bottom-right corner
    if (qrBuf) {
      const QR_SIZE = 48;
      doc.image(qrBuf, doc.page.width - L - QR_SIZE, y, { width: QR_SIZE, height: QR_SIZE });
      doc.save()
        .fontSize(5.5).font('Helvetica').fillColor(C.muted)
        .text('Verify', doc.page.width - L - QR_SIZE, y + QR_SIZE + 2, { width: QR_SIZE, align: 'center' })
        .restore();
    }

    doc.end();
  });
}

module.exports = { generateStatutoryPdf };
