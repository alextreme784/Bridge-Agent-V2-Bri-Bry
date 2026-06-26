const PDFDocument = require('pdfkit');
const sharp = require('sharp');
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');

const ACCENT    = '#2563eb';
const ACCENT_DK = '#1d4ed8';
const LIGHT_ROW = '#f8fafc';
const DARK      = '#111827';
const MUTED     = '#64748b';

const LABELS = {
  invoice:        'INVOICE',
  receipt:        'RECEIPT',
  purchase_order: 'PURCHASE ORDER',
};

const ASSETS_DIR = process.env.ASSETS_DIR || path.join(__dirname, '../assets');

function loadAsset(filename) {
  try {
    const p = path.join(ASSETS_DIR, filename);
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  } catch { return null; }
}

// Loaded once at startup
const TITANIUM_BUF = loadAsset('titanium-logo.png');
const BRIDGE_BUF   = loadAsset('bridge-logo.png');

async function fetchImageBuffer(url) {
  if (!url) return null;
  if (!url.startsWith('http')) {
    try { return fs.readFileSync(url); } catch { return null; }
  }
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 4000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
      const bufs = [];
      res.on('data', c => bufs.push(c));
      res.on('end',  () => resolve(Buffer.concat(bufs)));
      res.on('error', () => resolve(null));
    });
    req.on('error',   () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// PDFKit does not support WebP — convert any format to JPEG before passing
async function toPdfJpeg(buffer) {
  if (!buffer) return null;
  try {
    return await sharp(buffer).jpeg({ quality: 88 }).toBuffer();
  } catch { return null; }
}

async function generateDoc({
  doc_type = 'invoice',
  doc_number,
  doc_date,
  provider = {},
  customer = {},
  items = [],
  notes,
  currency = 'XCD',
  transaction_id,
  logo_base64,
}) {
  const label  = LABELS[doc_type] || 'INVOICE';
  const docNum = doc_number ||
    `BRG-${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}-${(transaction_id || '').slice(-6).toUpperCase()}`;
  const docDate = doc_date ||
    new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const fmt   = (n) => `$${parseFloat(n || 0).toFixed(2)} ${currency}`;
  const total = items.reduce((s, i) => s + parseFloat(i.unit_price || 0) * parseInt(i.quantity || 1), 0);

  // Resolve provider logo — local base64 takes priority over stored URL
  let logoBuffer = null;
  if (logo_base64) {
    try {
      const raw = Buffer.from(logo_base64, 'base64');
      logoBuffer = await toPdfJpeg(raw);
    } catch {}
  } else if (provider.logo_url) {
    const raw = await fetchImageBuffer(provider.logo_url);
    logoBuffer = await toPdfJpeg(raw);
  }

  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data',  c  => chunks.push(c));
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const PW = doc.page.width;   // 595
    const PH = doc.page.height;  // 842
    const ML = 50;
    const UW = PW - ML * 2;      // 495

    // ── Background watermark ──────────────────────────────────────────────────
    if (BRIDGE_BUF) {
      try {
        doc.save();
        doc.opacity(0.05);
        const wSize = 240;
        doc.image(BRIDGE_BUF, (PW - wSize) / 2, (PH - wSize) / 2, { fit: [wSize, wSize] });
        doc.restore();
      } catch {}
    } else {
      // Text watermark fallback
      doc.save();
      doc.opacity(0.04);
      doc.translate(PW / 2, PH / 2);
      doc.rotate(-45);
      doc.fontSize(64).font('Helvetica-Bold').fillColor(ACCENT);
      doc.text('BridgePro', -180, -32, { width: 360, align: 'center', lineBreak: false });
      doc.restore();
    }

    // ── Top accent bar ────────────────────────────────────────────────────────
    doc.rect(0, 0, PW, 6).fill(ACCENT);

    // ── Provider logo (top-left) ──────────────────────────────────────────────
    let logoBottom = 20;
    if (logoBuffer) {
      try {
        doc.image(logoBuffer, ML, 20, { fit: [90, 65] });
        logoBottom = 90;
      } catch { logoBottom = 20; }
    }

    // ── Document type title (top-right) ──────────────────────────────────────
    doc.fontSize(26).font('Helvetica-Bold').fillColor(ACCENT)
       .text(label, ML, 20, { align: 'right', width: UW });
    doc.fontSize(9).font('Helvetica').fillColor(MUTED)
       .text(`No: ${docNum}`, ML, 52, { align: 'right', width: UW })
       .text(`Date: ${docDate}`, ML, 64, { align: 'right', width: UW });

    // ── Provider info (top-left, below logo) ──────────────────────────────────
    const provY = logoBottom + 8;
    doc.fontSize(11).font('Helvetica-Bold').fillColor(DARK)
       .text(provider.business_name || provider.full_name || '', ML, provY);
    let py = provY + 14;
    doc.fontSize(8.5).font('Helvetica').fillColor(MUTED);
    if (provider.phone)    { doc.text(`Tel: ${provider.phone}`, ML, py);           py += 11; }
    if (provider.whatsapp) { doc.text(`WA: ${provider.whatsapp}`, ML, py);         py += 11; }
    if (provider.email)    { doc.text(provider.email, ML, py);                     py += 11; }

    // ── Divider ───────────────────────────────────────────────────────────────
    const divY = Math.max(py + 6, 100);
    doc.moveTo(ML, divY).lineTo(ML + UW, divY).lineWidth(0.5).strokeColor('#e2e8f0').stroke();

    // ── Bill To / From ────────────────────────────────────────────────────────
    const bY = divY + 12;
    const cW = UW / 2 - 10;

    doc.fontSize(7.5).font('Helvetica-Bold').fillColor(ACCENT)
       .text('BILL TO', ML,           bY)
       .text('FROM',    ML + cW + 20, bY);

    doc.fontSize(10).font('Helvetica-Bold').fillColor(DARK)
       .text(customer.full_name || '', ML,           bY + 12)
       .text(provider.business_name || provider.full_name || '', ML + cW + 20, bY + 12);

    doc.fontSize(8.5).font('Helvetica').fillColor(MUTED);
    let cy = bY + 24;
    if (customer.email) { doc.text(customer.email, ML, cy); cy += 11; }
    if (customer.phone) { doc.text(customer.phone, ML, cy); cy += 11; }

    let fy = bY + 24;
    if (provider.email)    { doc.text(provider.email,             ML + cW + 20, fy); fy += 11; }
    if (provider.whatsapp) { doc.text(`WA: ${provider.whatsapp}`, ML + cW + 20, fy); }

    // ── Items table ───────────────────────────────────────────────────────────
    const tY = Math.max(cy, fy, bY + 55) + 20;
    const C  = { d: ML, q: ML + 265, p: ML + 340, a: ML + 420 };
    const RH = 20;

    doc.rect(ML, tY, UW, 22).fill(ACCENT_DK);
    doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#ffffff')
       .text('DESCRIPTION', C.d + 4, tY + 7, { width: 256, lineBreak: false })
       .text('QTY',         C.q,     tY + 7, { width: 65,  lineBreak: false })
       .text('UNIT PRICE',  C.p,     tY + 7, { width: 75,  lineBreak: false })
       .text('AMOUNT',      C.a,     tY + 7, { width: 75,  lineBreak: false });

    let ry = tY + 22;
    const rows = items.length ? items : [{ description: 'Service', quantity: 1, unit_price: total || 0 }];
    rows.forEach((item, i) => {
      const qty   = parseInt(item.quantity || 1);
      const price = parseFloat(item.unit_price || 0);
      const amt   = qty * price;
      if (i % 2 === 0) doc.rect(ML, ry, UW, RH).fill(LIGHT_ROW);
      doc.fontSize(8.5).font('Helvetica').fillColor(DARK)
         .text(item.description || '', C.d + 4, ry + 6, { width: 256, lineBreak: false, ellipsis: true })
         .text(String(qty),            C.q,     ry + 6, { width: 65,  lineBreak: false })
         .text(fmt(price),             C.p,     ry + 6, { width: 75,  lineBreak: false })
         .text(fmt(amt),               C.a,     ry + 6, { width: 75,  lineBreak: false });
      ry += RH;
    });

    doc.rect(ML, ry, UW, 24).fill(ACCENT);
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#ffffff')
       .text('TOTAL', C.d + 4, ry + 7, { width: 356, lineBreak: false })
       .text(fmt(total), C.a,  ry + 7, { width: 75,  lineBreak: false });
    ry += 30;

    // ── Notes ─────────────────────────────────────────────────────────────────
    if (notes?.trim()) {
      doc.fontSize(8).font('Helvetica-Bold').fillColor(MUTED).text('NOTES', ML, ry);
      ry += 11;
      doc.fontSize(8.5).font('Helvetica').fillColor(DARK).text(notes.trim(), ML, ry, { width: UW });
      ry = doc.y + 8;
    }

    // ── Transaction reference ──────────────────────────────────────────────────
    if (transaction_id) {
      doc.fontSize(7.5).font('Helvetica').fillColor(MUTED)
         .text(`BridgePro Ref: ${transaction_id.slice(0, 8).toUpperCase()}`, ML, ry + 6, { width: UW });
    }

    // ── Footer ────────────────────────────────────────────────────────────────
    const footerY = PH - 44;
    doc.moveTo(0, footerY).lineTo(PW, footerY).lineWidth(0.5).strokeColor('#e2e8f0').stroke();

    // Titanium logo (bottom-left)
    let titaniumRight = ML;
    if (TITANIUM_BUF) {
      try {
        doc.image(TITANIUM_BUF, ML, footerY + 6, { height: 20 });
        titaniumRight = ML + 28;
      } catch {}
    }

    // Left footer text — omit the word "Titanium" when the logo image is shown
    const leftFooterText = TITANIUM_BUF
      ? 'by A3Tech  ·  contact@a3tech.uk'
      : 'Titanium by A3Tech  ·  contact@a3tech.uk';
    doc.fontSize(6.5).font('Helvetica').fillColor(MUTED)
       .text(leftFooterText, titaniumRight, footerY + 10, { lineBreak: false });

    // Right footer text: "Powered by Logetek · BridgePro"
    doc.fontSize(6.5).font('Helvetica').fillColor(MUTED)
       .text('Powered by Logetek  ·  BridgePro', ML, footerY + 10, {
         align: 'right',
         width: UW,
         lineBreak: false,
       });

    doc.end();
  });
}

module.exports = { generateDoc };
