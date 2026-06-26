const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

// GET /wallet/balance
router.get('/balance', requireAuth, async (req, res, next) => {
  try {
    const result = await db.query(
      'SELECT bridge_points FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });

    res.json({
      balance:  result.rows[0].bridge_points || 0,
      pending:  0,
      lifetime: result.rows[0].bridge_points || 0,
      currency: { code: 'BP', symbol: '₿' }
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
