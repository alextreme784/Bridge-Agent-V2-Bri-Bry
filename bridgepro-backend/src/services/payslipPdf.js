const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

const C = {
  navy:    '#0A2240',
  accent:  '#009E60',
  muted:   '#6B7280',
  border:  '#D1D5DB',
  light:   '#F9FAFB',
  white:   '#FFFFFF',
  red:     '#DC2626',
};

function rect(doc, x, y, w, h, color) {
  doc.save().rect(x, y, w, h).fill(color).restore();
}

function fmt(n) { return `$${(+n || 0).toFixed(2)}`; }

/**
 * Generate a single-page payslip PDF for one employee.
 * @param {object} run         — payroll_runs row
 * @param {object} item        — payroll_run_items row
 * @param {object} rates       — country rate object
 * @param {string} employerName — from users.full_name
 * @returns {Promise<Buffer>}
 */
async function generatePayslip(run, item, rates, employerName, verifyUrl) {
  const qrBuf = verifyUrl ? await QRCode.toBuffer(verifyUrl, { type: 'png', width: 80, margin: 1 }) : null;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 50, bottom: 60, left: 50, right: 50 },
      bufferPages: true,
    });

    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageW   = doc.page.width;
    const margin  = 50;
    const cW      = pageW - margin * 2;

    // ── HEADER BAND ───────────────────────────────────────────────────────────
    rect(doc, 0, 0, pageW, 68, C.navy);
    doc.save()
      .fontSize(17).font('Helvetica-Bold').fillColor(C.white)
      .text('BridgePro', margin, 20, { lineBreak: false })
      .fontSize(8).font('Helvetica').fillColor(C.accent)
      .text('  MARKETPLACE', margin + 80, 25, { lineBreak: false })
      .restore();
    doc.save()
      .fontSize(9).font('Helvetica-Bold').fillColor(C.white)
      .text('PAY SLIP', 0, 20, { align: 'right', width: pageW - margin })
      .fontSize(7.5).font('Helvetica').fillColor('rgba(255,255,255,0.55)')
      .text(run.period_label || '', 0, 33, { align: 'right', width: pageW - margin })
      .text(`Pay Date: ${run.pay_date ? new Date(run.pay_date).toLocaleDateString('en-GB', { day:'numeric',month:'long',year:'numeric' }) : ''}`, 0, 44, { align: 'right', width: pageW - margin })
      .restore();
    rect(doc, 0, 68, pageW, 3, C.accent);

    doc.y = 82;

    // ── EMPLOYER / EMPLOYEE BLOCK ─────────────────────────────────────────────
    const halfW = (cW - 16) / 2;

    // Employer box
    rect(doc, margin, doc.y, halfW, 72, C.light);
    doc.save()
      .rect(margin, doc.y, halfW, 72).strokeColor(C.border).lineWidth(0.5).stroke()
      .restore();
    const empBoxY = doc.y;
    doc.save()
      .fontSize(6.5).font('Helvetica-Bold').fillColor(C.muted)
      .text('EMPLOYER', margin + 10, empBoxY + 10, { characterSpacing: 1 })
      .fontSize(9.5).font('Helvetica-Bold').fillColor(C.navy)
      .text(employerName || 'Employer', margin + 10, empBoxY + 22, { width: halfW - 20 })
      .restore();

    // Employee box
    const empX = margin + halfW + 16;
    rect(doc, empX, empBoxY, halfW, 72, C.light);
    doc.save()
      .rect(empX, empBoxY, halfW, 72).strokeColor(C.border).lineWidth(0.5).stroke()
      .restore();
    doc.save()
      .fontSize(6.5).font('Helvetica-Bold').fillColor(C.muted)
      .text('EMPLOYEE', empX + 10, empBoxY + 10, { characterSpacing: 1 })
      .fontSize(9.5).font('Helvetica-Bold').fillColor(C.navy)
      .text(item.employee_name || '', empX + 10, empBoxY + 22, { width: halfW - 20, lineBreak: false })
      .restore();
    if (item.position) {
      doc.save()
        .fontSize(8).font('Helvetica').fillColor(C.muted)
        .text(item.position, empX + 10, empBoxY + 38, { width: halfW - 20 })
        .restore();
    }
    if (item.national_id) {
      doc.save()
        .fontSize(7.5).font('Helvetica').fillColor(C.muted)
        .text(`ID: ${item.national_id}`, empX + 10, empBoxY + 52, { width: halfW - 20 })
        .restore();
    }

    doc.y = empBoxY + 72 + 20;

    // ── EARNINGS ──────────────────────────────────────────────────────────────
    const rowH  = 22;
    const valX  = margin + cW - 90;
    const lineW = 0.4;

    function tableHeader(label) {
      const y = doc.y;
      rect(doc, margin, y, cW, 18, C.navy);
      doc.save()
        .fontSize(7).font('Helvetica-Bold').fillColor(C.white)
        .text(label, margin + 10, y + 5, { characterSpacing: 0.8 })
        .restore();
      doc.y = y + 18;
    }

    function tableRow(label, value, bold = false, valueColor = '#111827') {
      const y = doc.y;
      doc.save()
        .moveTo(margin, y + rowH).lineTo(margin + cW, y + rowH)
        .strokeColor(C.border).lineWidth(lineW).stroke()
        .restore();
      doc.save()
        .fontSize(9).font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(bold ? C.navy : C.muted)
        .text(label, margin + 10, y + 5, { width: valX - margin - 14, lineBreak: false })
        .font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(valueColor)
        .text(value, valX, y + 5, { width: 80, align: 'right' })
        .restore();
      doc.y = y + rowH;
    }

    tableHeader('EARNINGS');
    tableRow('Gross Pay', fmt(item.gross_pay), true, C.navy);

    doc.y += 8;
    tableHeader('DEDUCTIONS');
    tableRow(`NIS Employee Contribution (${(rates.nis_employee * 100).toFixed(1)}%)`, fmt(item.nis_employee));
    tableRow(`Income Tax – PAYE (${(rates.income_tax_rate * 100).toFixed(0)}%)`, fmt(item.income_tax));
    if (+item.other_deductions > 0) {
      tableRow('Other Deductions', fmt(item.other_deductions));
    }
    const totalDed = +(+item.nis_employee + +item.income_tax + +item.other_deductions).toFixed(2);
    tableRow('Total Deductions', fmt(totalDed), true, C.red);

    // ── NET PAY BOX ───────────────────────────────────────────────────────────
    doc.y += 16;
    const netBoxY = doc.y;
    const netBoxH = 52;
    rect(doc, margin, netBoxY, cW, netBoxH, C.navy);
    doc.save()
      .fontSize(8).font('Helvetica').fillColor('rgba(255,255,255,0.55)')
      .text('NET PAY', margin + 16, netBoxY + 10)
      .fontSize(22).font('Helvetica-Bold').fillColor(C.white)
      .text(fmt(item.net_pay), margin + 16, netBoxY + 20, { lineBreak: false })
      .restore();
    doc.save()
      .fontSize(7.5).font('Helvetica').fillColor(C.accent)
      .text(`Period: ${run.period_label || ''}`, 0, netBoxY + 12, { align: 'right', width: pageW - margin })
      .fontSize(7.5).font('Helvetica').fillColor('rgba(255,255,255,0.45)')
      .text(`Country Code: ${run.country_code || ''}`, 0, netBoxY + 26, { align: 'right', width: pageW - margin })
      .restore();

    // ── EMPLOYER NIS NOTE ─────────────────────────────────────────────────────
    doc.y = netBoxY + netBoxH + 14;
    doc.save()
      .fontSize(7.5).font('Helvetica').fillColor(C.muted)
      .text(
        `Employer NIS Contribution (${(rates.nis_employer * 100).toFixed(1)}%): ${fmt(item.nis_employer)}  —  This amount is paid by your employer and does not affect your net pay.`,
        margin, doc.y, { width: cW, lineGap: 2 }
      )
      .restore();

    // ── FOOTER ────────────────────────────────────────────────────────────────
    const FOOTER_H = 56;
    const QR_SIZE  = 38;
    const footerY  = doc.page.height - FOOTER_H;
    rect(doc, 0, footerY, pageW, FOOTER_H, C.navy);

    if (qrBuf) {
      doc.image(qrBuf, pageW - margin - QR_SIZE, footerY + (FOOTER_H - QR_SIZE) / 2, { width: QR_SIZE, height: QR_SIZE });
      doc.save()
        .fontSize(5).font('Helvetica').fillColor('rgba(255,255,255,0.40)')
        .text('VERIFY', pageW - margin - QR_SIZE, footerY + FOOTER_H - 9, { width: QR_SIZE, align: 'center' })
        .restore();
    }

    const footerTextW = qrBuf ? cW - QR_SIZE - 12 : cW;
    doc.save()
      .fontSize(7).font('Helvetica').fillColor('rgba(255,255,255,0.5)')
      .text('BridgePro Marketplace · Payroll Pay Slip', margin, footerY + 8, { lineBreak: false })
      .text('Confidential — For employee use only', 0, footerY + 8, { align: 'right', width: pageW - margin - (qrBuf ? QR_SIZE + 16 : 0) })
      .fontSize(7).fillColor('rgba(255,255,255,0.3)')
      .text(
        `NIS contributions are capped at the statutory wage ceiling. PAYE calculated on chargeable income above the personal allowance.`,
        margin, footerY + 22, { width: footerTextW }
      )
      .restore();

    doc.end();
  });
}

module.exports = { generatePayslip };
