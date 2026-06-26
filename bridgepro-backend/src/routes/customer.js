const express = require('express');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { calculateReputationScore, getClientLabel } = require('../services/customerReputationService');

const router = express.Router();

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'application/pdf'];
const MAX_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '5');

const customerVerifyUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const dir = path.join(
        process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads'),
        'customer_verifications',
        req.user.id
      );
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(req, file, cb) {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  fileFilter(req, file, cb) {
    if (ALLOWED_MIME.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, and PDF allowed.'));
    }
  },
  limits: { fileSize: MAX_MB * 1024 * 1024 },
});

// POST /customer/verify/id — submit ID for verification
router.post('/verify/id', ...requireRole('customer'), customerVerifyUpload.single('id_doc'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const existing = await db.query(
      `SELECT id, status FROM customer_id_verifications
       WHERE user_id = $1 AND country_code = $2
       ORDER BY created_at DESC LIMIT 1`,
      [req.user.id, req.countryCode]
    );

    if (existing.rows.length && existing.rows[0].status === 'pending') {
      return res.status(409).json({ error: 'You already have a pending ID verification' });
    }

    await db.query(
      `INSERT INTO customer_id_verifications (id, user_id, country_code, id_doc_url)
       VALUES ($1, $2, $3, $4)`,
      [uuidv4(), req.user.id, req.countryCode, req.file.path]
    );

    res.status(201).json({ message: 'ID submitted for review. You will be notified once approved.' });
  } catch (err) {
    next(err);
  }
});

// GET /customer/verify/status — current verification status
router.get('/verify/status', ...requireRole('customer'), async (req, res, next) => {
  try {
    const verif = await db.query(
      `SELECT status, rejection_reason FROM customer_id_verifications
       WHERE user_id = $1 AND country_code = $2
       ORDER BY created_at DESC LIMIT 1`,
      [req.user.id, req.countryCode]
    );

    const user = await db.query(
      'SELECT customer_verified FROM users WHERE id = $1',
      [req.user.id]
    );

    res.json({
      status: verif.rows[0]?.status || null,
      rejection_reason: verif.rows[0]?.rejection_reason || null,
      customer_verified: user.rows[0]?.customer_verified || false,
    });
  } catch (err) {
    next(err);
  }
});

// GET /customer/profile/:userId — provider views customer reputation profile
router.get('/profile/:userId', ...requireRole('provider', 'admin'), async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT customer_verified, customer_reputation_score,
              verified_customer_transaction_count, average_confirmation_speed_hours,
              created_at AS member_since
       FROM users
       WHERE id = $1 AND country_code = $2 AND role = 'customer'`,
      [req.params.userId, req.countryCode]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Customer not found' });

    const c = result.rows[0];
    const score = parseFloat(c.customer_reputation_score) || 0;

    res.json({
      customer_verified: c.customer_verified,
      customer_reputation_score: score,
      verified_customer_transaction_count: parseInt(c.verified_customer_transaction_count, 10) || 0,
      average_confirmation_speed_hours: parseFloat(c.average_confirmation_speed_hours) || 0,
      member_since: c.member_since,
      client_label: getClientLabel(score),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
