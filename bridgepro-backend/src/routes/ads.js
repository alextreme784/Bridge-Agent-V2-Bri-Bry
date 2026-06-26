const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { awardPoints } = require('../services/points');
const { isPointsEnabled, isAdsEnabled } = require('../services/platformSettings');
const { notify } = require('../services/notificationService');

const router = express.Router();

// ── Feature flag — reads from platform_settings table, no restart needed ──────
const adsEnabled = async (req, res, next) => {
  try {
    if (!(await isAdsEnabled())) {
      return res.status(503).json({ error: 'Ads system not yet available', code: 'ADS_DISABLED' });
    }
    next();
  } catch (err) { next(err); }
};

// ── Schema init ───────────────────────────────────────────────────────────────
db.query(`ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'ad_merchant'`)
  .catch(err => { if (!err.message.includes('already exists')) console.error('[ads] user_role enum:', err.message); });

db.query(`
  CREATE TABLE IF NOT EXISTS ad_campaigns (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
    title         VARCHAR(255) NOT NULL,
    youtube_url   VARCHAR(512) NOT NULL,
    thumbnail_url TEXT,
    status        VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'rejected')),
    push_count    INTEGER DEFAULT 0,
    view_count    INTEGER DEFAULT 0,
    created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )
`).catch(err => console.error('[ads] ad_campaigns init:', err.message));

db.query(`
  CREATE TABLE IF NOT EXISTS ad_watches (
    ad_id      UUID NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users(id)        ON DELETE CASCADE,
    watched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (ad_id, user_id)
  )
`).catch(err => console.error('[ads] ad_watches init:', err.message));

// ── Helper ────────────────────────────────────────────────────────────────────
async function requireAdMerchant(req, res, next) {
  if (req.user.role !== 'ad_merchant') {
    return res.status(403).json({ error: 'Ad merchant account required' });
  }
  const row = await db.query('SELECT is_verified FROM users WHERE id = $1', [req.user.id]);
  if (!row.rows[0]?.is_verified) {
    return res.status(403).json({ error: 'Account pending admin approval' });
  }
  next();
}

// ── Merchant account management (admin) ──────────────────────────────────────

// GET /ads/merchants — admin: pending ad_merchant accounts
router.get('/merchants', adsEnabled, ...requireRole('admin'), async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT id, email, full_name, is_verified, created_at
       FROM users WHERE role = 'ad_merchant' ORDER BY created_at DESC`
    );
    res.json({ merchants: result.rows });
  } catch (err) { next(err); }
});

// PATCH /ads/merchants/:userId/approve — admin approves an ad_merchant account
router.patch('/merchants/:userId/approve', adsEnabled, ...requireRole('admin'), async (req, res, next) => {
  try {
    const result = await db.query(
      `UPDATE users SET is_verified = true WHERE id = $1 AND role = 'ad_merchant' RETURNING id, full_name, email`,
      [req.params.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Ad merchant not found' });
    notify(result.rows[0].id, 'ad_account_approved', 'Account Approved', 'Your ad merchant account has been approved. You can now submit campaigns.', {});
    res.json({ message: 'Account approved', user: result.rows[0] });
  } catch (err) { next(err); }
});

// ── Campaign endpoints ────────────────────────────────────────────────────────

// POST /ads/submit — ad_merchant submits a video
router.post('/submit', adsEnabled, requireAuth, requireAdMerchant, async (req, res, next) => {
  try {
    const { title, youtube_url, thumbnail_url } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'title is required' });
    if (!youtube_url?.trim()) return res.status(400).json({ error: 'youtube_url is required' });

    const result = await db.query(
      `INSERT INTO ad_campaigns (id, user_id, title, youtube_url, thumbnail_url, status)
       VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING *`,
      [uuidv4(), req.user.id, title.trim(), youtube_url.trim(), thumbnail_url?.trim() || null]
    );

    const admins = await db.query(`SELECT id FROM users WHERE role = 'admin'`);
    admins.rows.forEach(({ id }) => {
      notify(id, 'ad_pending', 'New Ad Campaign', `"${title.trim()}" is pending review`, { ad_id: result.rows[0].id });
    });

    res.status(201).json({ campaign: result.rows[0] });
  } catch (err) { next(err); }
});

// GET /ads/pending — admin: pending campaigns
router.get('/pending', adsEnabled, ...requireRole('admin'), async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT a.*, u.full_name AS merchant_name, u.email AS merchant_email
       FROM ad_campaigns a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.status = 'pending' ORDER BY a.created_at ASC`
    );
    res.json({ campaigns: result.rows });
  } catch (err) { next(err); }
});

// GET /ads/active — public: active campaigns for feed
router.get('/active', adsEnabled, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT a.*, u.full_name AS merchant_name
       FROM ad_campaigns a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.status = 'active' ORDER BY a.created_at DESC`
    );
    res.json({ campaigns: result.rows });
  } catch (err) { next(err); }
});

// PATCH /ads/:id/approve — admin approves a campaign
router.patch('/:id/approve', adsEnabled, ...requireRole('admin'), async (req, res, next) => {
  try {
    const result = await db.query(
      `UPDATE ad_campaigns SET status = 'active' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ campaign: result.rows[0] });
  } catch (err) { next(err); }
});

// PATCH /ads/:id/reject — admin rejects a campaign
router.patch('/:id/reject', adsEnabled, ...requireRole('admin'), async (req, res, next) => {
  try {
    const result = await db.query(
      `UPDATE ad_campaigns SET status = 'rejected' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ campaign: result.rows[0] });
  } catch (err) { next(err); }
});

// POST /ads/:id/watch — log first watch, award 2 Bridge Points
router.post('/:id/watch', adsEnabled, requireAuth, async (req, res, next) => {
  try {
    const adId = req.params.id;
    const userId = req.user.id;

    const result = await db.query(
      `INSERT INTO ad_watches (ad_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [adId, userId]
    );

    if (result.rowCount > 0) {
      await db.query('UPDATE ad_campaigns SET view_count = view_count + 1 WHERE id = $1', [adId]);
      if (await isPointsEnabled()) {
        const ccRow = await db.query('SELECT country_code FROM users WHERE id = $1', [userId]);
        await awardPoints(userId, ccRow.rows[0]?.country_code || 'VC', 'ad_video_watch', 2, adId);
      }
    }

    res.json({ watched: result.rowCount > 0 });
  } catch (err) { next(err); }
});

// POST /ads/:id/push — admin pushes active ad to all users
router.post('/:id/push', adsEnabled, ...requireRole('admin'), async (req, res, next) => {
  try {
    const ad = await db.query(
      `SELECT * FROM ad_campaigns WHERE id = $1 AND status = 'active'`,
      [req.params.id]
    );
    if (!ad.rows.length) return res.status(404).json({ error: 'Active campaign not found' });
    const campaign = ad.rows[0];

    await db.query('UPDATE ad_campaigns SET push_count = push_count + 1 WHERE id = $1', [req.params.id]);

    const users = await db.query(
      `SELECT id FROM users WHERE role IN ('customer', 'provider') AND is_suspended = false LIMIT 2000`
    );
    users.rows.forEach(({ id }) => {
      notify(id, 'ad_push', 'Sponsored Video', campaign.title, { ad_id: campaign.id });
    });

    res.json({ pushed: true, user_count: users.rows.length });
  } catch (err) { next(err); }
});

module.exports = router;
