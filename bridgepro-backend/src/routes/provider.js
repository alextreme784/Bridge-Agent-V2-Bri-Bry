const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const TIER_BENEFITS = {
  level1: [
    'Active listing visible to all users',
    'Up to 250 Bridge Points redeemable per month',
    'Standard search placement',
  ],
  level2: [
    'Pro badge on your listing',
    'Priority placement in search results',
    'Up to 500 Bridge Points redeemable per month',
    'Featured in /listings/top results',
  ],
  level3: [
    'Featured badge on your listing',
    'Top placement in all search results',
    'Up to 1000 Bridge Points redeemable per month',
    'Featured in /listings/featured carousel',
    'Premium support',
  ],
};

// Valid upgrade paths
const UPGRADE_PATHS = {
  free_period: 'level2',
  level1: 'level2',
  level2: 'level3',
};

const PROFILE_FIELDS = [
  'phone', 'whatsapp', 'website_url', 'business_hours', 'description',
  'service_areas', 'payment_methods', 'facebook_url', 'instagram_url',
  'twitter_url', 'linkedin_url', 'tiktok_url', 'youtube_url',
];

async function ensureProfileTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS provider_profiles (
      user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      phone         VARCHAR(50),
      whatsapp      VARCHAR(50),
      website_url   TEXT,
      business_hours TEXT,
      description   TEXT,
      service_areas TEXT[],
      payment_methods JSONB,
      facebook_url  TEXT,
      instagram_url TEXT,
      twitter_url   TEXT,
      linkedin_url  TEXT,
      tiktok_url    TEXT,
      youtube_url   TEXT,
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// GET /provider/profile
router.get('/profile', ...requireRole('provider'), async (req, res, next) => {
  try {
    await ensureProfileTable();
    const result = await db.query('SELECT * FROM provider_profiles WHERE user_id = $1', [req.user.id]);
    res.json({ profile: result.rows[0] || null });
  } catch (err) {
    next(err);
  }
});

// PUT /provider/profile — upsert profile for providers without a listing
router.put('/profile', ...requireRole('provider'), async (req, res, next) => {
  try {
    await ensureProfileTable();
    const {
      phone, whatsapp, website_url, business_hours, description,
      service_areas, payment_methods, facebook_url, instagram_url,
      twitter_url, linkedin_url, tiktok_url, youtube_url,
    } = req.body;

    await db.query(
      `INSERT INTO provider_profiles
         (user_id, phone, whatsapp, website_url, business_hours, description,
          service_areas, payment_methods, facebook_url, instagram_url,
          twitter_url, linkedin_url, tiktok_url, youtube_url, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         phone           = EXCLUDED.phone,
         whatsapp        = EXCLUDED.whatsapp,
         website_url     = EXCLUDED.website_url,
         business_hours  = EXCLUDED.business_hours,
         description     = EXCLUDED.description,
         service_areas   = EXCLUDED.service_areas,
         payment_methods = EXCLUDED.payment_methods,
         facebook_url    = EXCLUDED.facebook_url,
         instagram_url   = EXCLUDED.instagram_url,
         twitter_url     = EXCLUDED.twitter_url,
         linkedin_url    = EXCLUDED.linkedin_url,
         tiktok_url      = EXCLUDED.tiktok_url,
         youtube_url     = EXCLUDED.youtube_url,
         updated_at      = NOW()`,
      [
        req.user.id,
        phone || null, whatsapp || null, website_url || null, business_hours || null,
        description || null, service_areas || null,
        payment_methods ? JSON.stringify(payment_methods) : null,
        facebook_url || null, instagram_url || null, twitter_url || null,
        linkedin_url || null, tiktok_url || null, youtube_url || null,
      ]
    );

    res.json({ message: 'Profile saved' });
  } catch (err) {
    next(err);
  }
});

// POST /provider/upgrade-tier — provider self-service tier upgrade
router.post('/upgrade-tier', ...requireRole('provider'), async (req, res, next) => {
  try {
    const { target_tier } = req.body;

    if (!target_tier) {
      return res.status(400).json({ error: 'target_tier is required' });
    }

    const userResult = await db.query(
      'SELECT id, subscription_tier, upgrade_available FROM users WHERE id = $1',
      [req.user.id]
    );
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Must have upgrade available flag
    if (!user.upgrade_available) {
      return res.status(403).json({
        error: 'No tier upgrade is currently available. Reach the redemption cap for 2 consecutive months to unlock an upgrade.',
      });
    }

    const currentTier = user.subscription_tier || 'free_period';
    const allowedNextTier = UPGRADE_PATHS[currentTier];

    if (!allowedNextTier) {
      return res.status(400).json({ error: 'You are already at the maximum tier (level3)' });
    }

    if (target_tier !== allowedNextTier) {
      return res.status(400).json({
        error: `Invalid upgrade path. From ${currentTier} you can only upgrade to ${allowedNextTier}`,
      });
    }

    // Record tier history
    await db.query(
      `INSERT INTO provider_tier_history (id, user_id, previous_tier, new_tier, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [uuidv4(), user.id, currentTier, target_tier, 'provider_initiated']
    );

    // Update user
    await db.query(
      `UPDATE users
       SET subscription_tier = $1,
           tier_upgraded_at = NOW(),
           consecutive_max_redemptions = 0,
           upgrade_available = false
       WHERE id = $2`,
      [target_tier, user.id]
    );

    const benefits = TIER_BENEFITS[target_tier] || [];

    res.json({
      message: `Successfully upgraded to ${target_tier}`,
      new_tier: target_tier,
      benefits,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
