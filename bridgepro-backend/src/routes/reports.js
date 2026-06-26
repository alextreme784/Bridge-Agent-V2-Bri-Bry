const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { notify } = require('../services/notificationService');

const router = express.Router();

const VALID_REASONS = ['spam', 'offensive', 'misleading', 'duplicate', 'other'];

// POST /reports — submit a user report against a listing or job post
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { target_type, target_id, reason, details } = req.body;

    if (!['listing', 'job'].includes(target_type)) {
      return res.status(400).json({ error: 'target_type must be listing or job' });
    }
    if (!target_id) return res.status(400).json({ error: 'target_id is required' });
    if (!VALID_REASONS.includes(reason)) {
      return res.status(400).json({ error: 'Invalid reason' });
    }

    // Block duplicate pending reports from the same user for the same target
    const existing = await db.query(
      `SELECT id FROM reports
       WHERE reporter_id = $1 AND target_type = $2 AND target_id = $3 AND status = 'pending'`,
      [req.user.id, target_type, target_id]
    );
    if (existing.rows.length) {
      return res.status(409).json({ error: 'You already submitted a report for this item' });
    }

    await db.query(
      `INSERT INTO reports (id, reporter_id, country_code, target_type, target_id, reason, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [uuidv4(), req.user.id, req.countryCode, target_type, target_id, reason, details?.trim() || null]
    );

    res.status(201).json({ message: 'Report submitted. Thank you for helping keep the marketplace safe.' });
  } catch (err) { next(err); }
});

// POST /reports/bug — send a bug report or complaint to all admins (works with or without login)
router.post('/bug', async (req, res, next) => {
  try {
    const { type = 'bug', message, name, email } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'message is required' });
    if (message.trim().length > 1000) return res.status(400).json({ error: 'message too long (max 1000 characters)' });

    // Try to identify the sender — logged-in user takes priority
    let sender = name?.trim() || email?.trim() || 'Anonymous';
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
        const userRow = await db.query('SELECT email, full_name FROM users WHERE id = $1', [decoded.id]);
        sender = userRow.rows[0]?.full_name || userRow.rows[0]?.email || sender;
      } catch {}
    }

    const label = type === 'complaint' ? 'Complaint' : 'Bug Report';
    const admins = await db.query(
      `SELECT id FROM users WHERE role = 'admin' AND country_code = $1`,
      [req.countryCode]
    );

    for (const admin of admins.rows) {
      notify(admin.id, 'bug_report', `${label} from ${sender}`, message.trim().slice(0, 200), { url: '/admin' });
    }

    res.json({ message: 'Thank you — your report has been sent to the team.' });
  } catch (err) { next(err); }
});

module.exports = router;
