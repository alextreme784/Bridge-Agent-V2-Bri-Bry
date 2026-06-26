const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');

// GET /user/profile
router.get('/profile', requireAuth, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT id, email, full_name, role, bridge_points, account_type,
              subscription_status, referral_code, is_verified, is_partner,
              country_code, created_at
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
