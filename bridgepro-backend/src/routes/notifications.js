const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /notifications — recent notifications for logged-in user
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    const unreadCount = result.rows.filter((n) => !n.is_read).length;
    res.json({ notifications: result.rows, unread_count: unreadCount });
  } catch (err) { next(err); }
});

// POST /notifications/read-all
router.post('/read-all', requireAuth, async (req, res, next) => {
  try {
    await db.query('UPDATE notifications SET is_read = true WHERE user_id = $1', [req.user.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /notifications/:id
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    await db.query('DELETE FROM notifications WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
