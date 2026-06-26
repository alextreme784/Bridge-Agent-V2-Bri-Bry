const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');

// GET /vclean/feed
router.get('/feed', requireAuth, async (req, res) => {
  res.json({ submissions: [] });
});

module.exports = router;
