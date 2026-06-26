const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');

// GET /activity
router.get('/', requireAuth, async (req, res) => {
  res.json({ activities: [] });
});

module.exports = router;
