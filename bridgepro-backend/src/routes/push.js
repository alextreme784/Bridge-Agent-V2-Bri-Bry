const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /push/vapid-public-key — public, used by frontend to subscribe
router.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// POST /push/subscribe — store subscription for logged-in user
router.post('/subscribe', requireAuth, async (req, res, next) => {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'Invalid subscription object' });
    }
    await db.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [req.user.id, endpoint, keys.p256dh, keys.auth]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /push/fcm-token — store FCM token for logged-in user
router.post('/fcm-token', requireAuth, async (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'token is required' });
    await db.query('UPDATE users SET fcm_token = $1 WHERE id = $2', [token, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /push/unsubscribe
router.delete('/unsubscribe', requireAuth, async (req, res, next) => {
  try {
    const { endpoint } = req.body;
    if (endpoint) {
      await db.query(
        'DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2',
        [req.user.id, endpoint]
      );
    } else {
      await db.query('DELETE FROM push_subscriptions WHERE user_id = $1', [req.user.id]);
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
