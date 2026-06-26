const express = require('express');
const fs = require('fs');
const path = require('path');
const { requireAuth } = require('../middleware/auth');
const generateReceiptPdf = require('../utils/generateReceiptPdf');
const { signDocument } = require('../utils/docSignature');

const RECEIPTS_DIR = path.join(__dirname, '../../uploads/receipts');

const router = express.Router();

// POST /api/ai/receipt/pdf — generate and stream a PDF receipt
router.post('/pdf', requireAuth, async (req, res) => {
  const { receipt_number, issued_by, amount } = req.body;
  if (!receipt_number || !issued_by || !amount) {
    return res.status(400).json({ error: 'receipt_number, issued_by, and amount are required' });
  }

  try {
    const { verifyUrl } = await signDocument({
      docType: 'receipt', docRef: receipt_number, providerId: req.user?.id || null,
      countryCode: req.countryCode || null,
      metadata: { issued_by, issued_to: req.body.issued_to, amount: req.body.amount, currency: req.body.currency || 'XCD', description: req.body.description },
    });
    const filePath = await generateReceiptPdf({ ...req.body, verify_url: verifyUrl });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="receipt-${receipt_number}.pdf"`);
    const readStream = fs.createReadStream(filePath);
    readStream.pipe(res);
    // Keep the file so GET /:receipt_number can serve it later
  } catch (err) {
    console.error('Receipt PDF error:', err);
    res.status(500).json({ error: 'Failed to generate receipt' });
  }
});

// GET /api/ai/receipt/pdf/:receipt_number — serve a previously generated PDF
router.get('/pdf/:receipt_number', async (req, res) => {
  const { receipt_number } = req.params;
  // Basic sanity-check the receipt_number to avoid path traversal
  if (!/^[\w-]+$/.test(receipt_number)) {
    return res.status(400).json({ error: 'Invalid receipt number' });
  }

  // Check permanent store first, then fall back to /tmp for legacy receipts
  const permPath = path.join(RECEIPTS_DIR, `receipt-${receipt_number}.pdf`);
  const tmpPath  = `/tmp/receipt-${receipt_number}.pdf`;
  const filePath = fs.existsSync(permPath) ? permPath
                 : fs.existsSync(tmpPath)  ? tmpPath
                 : null;

  if (!filePath) {
    return res.status(404).json({ error: 'Receipt not found' });
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="receipt-${receipt_number}.pdf"`);
  fs.createReadStream(filePath).pipe(res);
});

module.exports = router;
