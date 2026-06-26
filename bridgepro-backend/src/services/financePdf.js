const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

// Colour palette
const C = {
  navy:     '#0A2240',
  accent:   '#009E60',
  muted:    '#6B7280',
  border:   '#D1D5DB',
  light:    '#F9FAFB',
  white:    '#FFFFFF',
  danger:   '#DC2626',
  warn:     '#D97706',
  positive: '#009E60',
  warning:  '#D97706',
  neutral:  '#9CA3AF',
};

const DISCLAIMER =
  'BridgePro FOS is a data-readiness infrastructure provider and not a credit rating agency. ' +
  'This report is for information purposes and based on self-reported and platform-verified data. ' +
  'Independent verification is recommended prior to any credit decision.';

function px(pts) { return pts; }  // PDFKit works in pts natively

// Draw a filled rectangle helper
function rect(doc, x, y, w, h, color) {
  doc.save().rect(x, y, w, h).fill(color).restore();
}

// Horizontal rule
function rule(doc, y, margin = 50) {
  doc.save()
    .moveTo(margin, y).lineTo(doc.page.width - margin, y)
    .strokeColor(C.border).lineWidth(0.5).stroke()
    .restore();
}

// Section heading
function sectionHeading(doc, text, y) {
  doc.save()
    .fontSize(7).font('Helvetica-Bold')
    .fillColor(C.muted)
    .text(text.toUpperCase(), 50, y, { characterSpacing: 1 })
    .restore();
  return doc.y + 4;
}

// Two-column key/value row
function kvRow(doc, key, value, y, { valueColor = '#111827', bold = false } = {}) {
  const leftX = 50, midX = 200, rightEdge = doc.page.width - 50;
  doc.save()
    .fontSize(8.5).font('Helvetica').fillColor(C.muted)
    .text(key, leftX, y, { width: midX - leftX - 8, lineBreak: false })
    .font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(valueColor)
    .text(value, midX, y, { width: rightEdge - midX })
    .restore();
  return doc.y + 2;
}

// Metric box (used in the 2×2 grid)
function metricBox(doc, x, y, w, h, label, value, sub) {
  rect(doc, x, y, w, h, C.light);
  doc.save()
    .rect(x, y, w, h).strokeColor(C.border).lineWidth(0.5).stroke()
    .restore();
  doc.save()
    .fontSize(6.5).font('Helvetica').fillColor(C.muted)
    .text(label.toUpperCase(), x + 10, y + 10, { width: w - 20, characterSpacing: 0.5 })
    .fontSize(14).font('Helvetica-Bold').fillColor(C.navy)
    .text(value, x + 10, doc.y + 2, { width: w - 20 })
    .restore();
  if (sub) {
    doc.save()
      .fontSize(7).font('Helvetica').fillColor(C.muted)
      .text(sub, x + 10, y + h - 16, { width: w - 20 })
      .restore();
  }
}

// Signal pill row
function signalRow(doc, label, active, y) {
  const dot = active ? C.accent : C.border;
  const textColor = active ? C.accent : C.muted;
  doc.save()
    .circle(60, y + 4, 3.5).fill(dot)
    .fontSize(8.5).font(active ? 'Helvetica-Bold' : 'Helvetica').fillColor(textColor)
    .text(label, 70, y, { width: doc.page.width - 120 })
    .restore();
  return doc.y + 3;
}

// Underwriting reason row — coloured dot + bold label + regular detail
function reasonRow(doc, signal, label, detail, y) {
  const dotColor = C[signal] || C.neutral;
  const x = 68, w = doc.page.width - x - 50;
  doc.save()
    .circle(57, y + 5, 3.5).fill(dotColor)
    .font('Helvetica-Bold').fontSize(8.5).fillColor(C.navy)
    .text(label + ' — ', x, y, { continued: true, lineBreak: false })
    .font('Helvetica').fillColor(C.muted)
    .text(detail, { width: w })
    .restore();
  return doc.y + 3;
}

/**
 * Generate an MSME Credit Memo PDF.
 * @param {object} profile   — MSME_Credit_Profile object from finance.js
 * @param {string} verifyUrl — optional QR verification URL
 * @returns {Promise<Buffer>}
 */
async function generateCreditMemoPDF(profile, verifyUrl) {
  const qrBuf = verifyUrl ? await QRCode.toBuffer(verifyUrl, { type: 'png', width: 96, margin: 1 }) : null;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 50, bottom: 72, left: 50, right: 50 },
      bufferPages: true,
      info: {
        Title: 'BridgePro MSME Credit Profile',
        Author: 'BridgePro Marketplace',
        Subject: 'MSME Credit Applicant Profile',
      },
    });

    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const p   = profile;
    const fm  = p.financial_metrics;
    const sm  = p.service_metrics;
    const cs  = p.creditworthiness_signals;
    const prov = p.provider;

    const pageW  = doc.page.width;
    const margin = 50;
    const contentW = pageW - margin * 2;

    // ── HEADER BAND ───────────────────────────────────────────────────────────
    rect(doc, 0, 0, pageW, 72, C.navy);

    // Left: wordmark
    doc.save()
      .fontSize(18).font('Helvetica-Bold').fillColor(C.white)
      .text('BridgePro', margin, 22, { lineBreak: false })
      .fontSize(8).font('Helvetica').fillColor(C.accent)
      .text('  MARKETPLACE', margin + 80, 27, { lineBreak: false })
      .restore();

    // Right: document type
    doc.save()
      .fontSize(7).font('Helvetica-Bold').fillColor('rgba(255,255,255,0.55)')
      .text('CONFIDENTIAL DOCUMENT', 0, 18, { align: 'right', width: pageW - margin })
      .fontSize(10).font('Helvetica-Bold').fillColor(C.white)
      .text('MSME CREDIT APPLICANT PROFILE', 0, 30, { align: 'right', width: pageW - margin })
      .fontSize(7).font('Helvetica').fillColor(C.accent)
      .text(`Schema v${p.schema_version}`, 0, 46, { align: 'right', width: pageW - margin })
      .restore();

    // Accent stripe
    rect(doc, 0, 72, pageW, 4, C.accent);

    doc.y = 92;

    // ── ENTITY BLOCK ─────────────────────────────────────────────────────────
    const entityName = prov.business_name || prov.full_name;
    doc.save()
      .fontSize(16).font('Helvetica-Bold').fillColor(C.navy)
      .text(entityName, margin, doc.y)
      .restore();

    if (prov.business_name && prov.business_name !== prov.full_name) {
      doc.save()
        .fontSize(9).font('Helvetica').fillColor(C.muted)
        .text(`Principal: ${prov.full_name}`, margin, doc.y + 1)
        .restore();
    }

    doc.moveDown(0.4);
    rule(doc, doc.y);
    doc.moveDown(0.5);

    // ── PROVIDER DETAILS ──────────────────────────────────────────────────────
    let y = doc.y;
    y = sectionHeading(doc, 'Applicant Details', y);
    doc.moveDown(0.3);
    y = doc.y;

    const regDate  = prov.member_since
      ? new Date(prov.member_since).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
      : 'N/A';
    const jurisdiction = (() => {
      const m = { SVG:'Saint Vincent and the Grenadines', GRD:'Grenada', BRB:'Barbados',
        SLU:'Saint Lucia', JAM:'Jamaica', TTO:'Trinidad and Tobago', ATG:'Antigua and Barbuda',
        SKN:'Saint Kitts and Nevis', DMA:'Dominica', BLZ:'Belize', GUY:'Guyana',
        SUR:'Suriname', HTI:'Haiti' };
      return m[prov.country_code] || prov.country_code;
    })();

    const rows = [
      ['Entity / Business Name', entityName, { bold: true }],
      ['Principal / Operator',   prov.full_name],
      ['Category',               prov.category || 'Service Provider'],
      ['Jurisdiction',           `${jurisdiction} (${prov.country_code})`],
      ['Contact Email',          prov.email],
      ['Platform Registration',  `${regDate} — ${cs.platform_tenure_days} day${cs.platform_tenure_days !== 1 ? 's' : ''} active`],
      ['Provider ID',            prov.id],
    ];

    for (const [k, v, opts] of rows) {
      y = kvRow(doc, k, v, y, opts || {});
      y += 5;
    }

    doc.moveDown(0.8);
    rule(doc, doc.y);
    doc.moveDown(0.6);

    // ── FINANCIAL METRICS GRID ────────────────────────────────────────────────
    y = sectionHeading(doc, 'Financial Metrics (Verified Transactions)', doc.y);
    doc.moveDown(0.4);
    y = doc.y;

    const boxW = (contentW - 12) / 2;
    const boxH = 56;
    const gap  = 12;

    metricBox(doc, margin,          y, boxW, boxH,
      'Total Verified Revenue',
      `XCD $${fm.total_volume.value.toFixed(2)}`,
      fm.total_volume.label);
    metricBox(doc, margin + boxW + gap, y, boxW, boxH,
      'Verified Transactions',
      `${fm.job_count.value}`,
      fm.job_count.label);

    y += boxH + 8;

    metricBox(doc, margin,          y, boxW, boxH,
      'Average Ticket Value',
      `XCD $${fm.avg_ticket_size.value.toFixed(2)}`,
      fm.avg_ticket_size.label);
    metricBox(doc, margin + boxW + gap, y, boxW, boxH,
      'Transaction Success Rate',
      `${fm.success_rate.value}%`,
      fm.success_rate.label);

    y += boxH + 8;

    if (fm.first_transaction) {
      const fmtDate = (iso) => iso
        ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
        : 'N/A';
      doc.save()
        .fontSize(7.5).font('Helvetica').fillColor(C.muted)
        .text(
          `First transaction: ${fmtDate(fm.first_transaction)}   Last transaction: ${fmtDate(fm.last_transaction)}`,
          margin, y, { width: contentW }
        )
        .restore();
      y = doc.y + 6;
    }

    doc.y = y;
    doc.moveDown(0.6);
    rule(doc, doc.y);
    doc.moveDown(0.6);

    // ── SERVICE RECORD ────────────────────────────────────────────────────────
    y = sectionHeading(doc, 'Service Record', doc.y);
    doc.moveDown(0.4);
    y = doc.y;

    const sRows = [
      ['Confirmed Service Engagements', `${sm.total_service_engagements}`],
      ['Customer Reviews',              `${sm.total_reviews}`],
      ['Average Customer Rating',       sm.avg_customer_rating > 0 ? `${sm.avg_customer_rating.toFixed(2)} / 5.00` : 'No reviews recorded'],
      ['Positive Review Rate (≥4★)',     `${sm.positive_review_rate.value}%`],
    ];

    for (const [k, v] of sRows) {
      y = kvRow(doc, k, v, y);
      y += 5;
    }

    doc.y = y;
    doc.moveDown(0.8);
    rule(doc, doc.y);
    doc.moveDown(0.6);

    // ── CREDITWORTHINESS SIGNALS ──────────────────────────────────────────────
    y = sectionHeading(doc, 'Creditworthiness Signals', doc.y);
    doc.moveDown(0.4);
    y = doc.y;

    const wf = p.workforce || {};
    const signals = [
      ['Platform tenure: ' + cs.platform_tenure_days + ' days',                       cs.platform_tenure_days >= 30],
      ['Has verified revenue on-platform',                                              cs.has_verified_revenue],
      ['Consistent activity (5+ verified transactions)',                                cs.consistent_activity],
      ['Strong customer reputation (avg rating ≥ 4.0)',                                cs.strong_reputation],
      ['Low dispute risk (transaction success rate ≥ 80%)',                             cs.low_dispute_risk],
      ['Employee stability' + (wf.active_employees ? ` (${wf.active_employees} staff)` : ''), cs.employee_stability],
      ['Consistent payroll history (4+ months)',                                        cs.consistent_payroll_history],
    ];

    for (const [label, active] of signals) {
      y = signalRow(doc, label, active, y);
    }

    doc.y = y;
    doc.moveDown(0.8);
    rule(doc, doc.y);
    doc.moveDown(0.6);

    // ── UNDERWRITING INSIGHTS ─────────────────────────────────────────────────
    if (p.underwriting_reasons && p.underwriting_reasons.length > 0) {
      y = sectionHeading(doc, 'Underwriting Insights', doc.y);
      doc.moveDown(0.3);
      y = doc.y;

      for (const r of p.underwriting_reasons) {
        y = reasonRow(doc, r.signal, r.label, r.detail, y);
      }

      doc.y = y;
      doc.moveDown(0.8);
      rule(doc, doc.y);
      doc.moveDown(0.6);
    }

    // ── LENDER SUMMARY ────────────────────────────────────────────────────────
    const summaryText = p.lender_summary;
    const FOOTER_RESERVE = 80;

    // Measure how tall the summary box will be before placing it
    const textHeight = doc.heightOfString(summaryText, {
      width: contentW - 24,
      fontSize: 9,
      lineGap: 3,
    });
    const summaryBoxH = textHeight + 28;

    // Force a new page if heading + box won't fit above the footer reserve
    if (doc.y + 24 + summaryBoxH > doc.page.height - doc.page.margins.bottom - FOOTER_RESERVE) {
      doc.addPage();
    }

    y = sectionHeading(doc, 'Lender Summary', doc.y);
    doc.moveDown(0.4);

    const summaryStartY = doc.y;

    rect(doc, margin, summaryStartY - 4, contentW, summaryBoxH, C.light);
    doc.save()
      .rect(margin, summaryStartY - 4, contentW, summaryBoxH)
      .strokeColor(C.accent).lineWidth(0.75).stroke()
      .restore();

    // Left accent bar
    rect(doc, margin, summaryStartY - 4, 3, summaryBoxH, C.accent);

    doc.save()
      .fontSize(9).font('Helvetica').fillColor(C.navy)
      .text(summaryText, margin + 12, summaryStartY + 6, {
        width: contentW - 24,
        lineGap: 3,
      })
      .restore();

    doc.y = summaryStartY + summaryBoxH;
    doc.moveDown(0.4);

    // ── FOOTER (all pages) — navy band with disclaimer + QR verification ────
    const FOOTER_H  = 68;
    const QR_SIZE   = 48;
    const pageCount = doc.bufferedPageRange().count;
    for (let i = 0; i < pageCount; i++) {
      doc.switchToPage(i);
      const footerY = doc.page.height - FOOTER_H;
      rect(doc, 0, footerY, pageW, FOOTER_H, C.navy);

      // QR code — right side of footer (only if verifyUrl provided)
      const textWidth = qrBuf ? pageW - margin - QR_SIZE - 12 : pageW - margin * 2;
      if (qrBuf) {
        doc.image(qrBuf, pageW - margin - QR_SIZE, footerY + (FOOTER_H - QR_SIZE) / 2, { width: QR_SIZE, height: QR_SIZE });
        doc.save()
          .fontSize(5.5).font('Helvetica').fillColor('rgba(255,255,255,0.40)')
          .text('VERIFY', pageW - margin - QR_SIZE, footerY + FOOTER_H - 10, { width: QR_SIZE, align: 'center' })
          .restore();
      }

      doc.save()
        .fontSize(7).font('Helvetica').fillColor('rgba(255,255,255,0.5)')
        .text('BridgePro Marketplace · Confidential', margin, footerY + 8, { lineBreak: false })
        .text(`Page ${i + 1} of ${pageCount}`, 0, footerY + 8, { align: 'right', width: textWidth })
        .fontSize(8).font('Helvetica').fillColor('rgba(255,255,255,0.32)')
        .text(DISCLAIMER, margin, footerY + 24, { width: textWidth })
        .restore();
    }

    doc.end();
  });
}

module.exports = { generateCreditMemoPDF };
