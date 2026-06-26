const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { redeemPoints, checkAndTriggerTierUpgrade, calculateHealthScore } = require('../services/pointsService');
const { getPointValueCents } = require('../services/platformSettings');

const router = express.Router();

// GET /points/balance — authenticated user
router.get('/balance', requireAuth, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT bridge_points, verified_transaction_count, verified_customer_transaction_count,
              subscription_tier, upgrade_available, consecutive_max_redemptions,
              customer_reputation_score, customer_verified, average_confirmation_speed_hours
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });

    const data = result.rows[0];

    const pointValueCents = await getPointValueCents();
    const ptsPerDollar = Math.round(100 / pointValueCents);

    if (req.user.role === 'customer') {
      return res.json({
        bridge_points: 0,
        points_paused: true,
        points_paused_message: 'Customer rewards are coming soon. We\'re designing something great for you.',
        verified_customer_transaction_count: parseInt(data.verified_customer_transaction_count, 10) || 0,
        customer_reputation_score: parseFloat(data.customer_reputation_score) || 0,
        customer_verified: data.customer_verified || false,
        average_confirmation_speed_hours: parseFloat(data.average_confirmation_speed_hours) || 0,
        redemption_available: false,
      });
    }

    res.json({ ...data, point_value_cents: pointValueCents, redemption_rate: ptsPerDollar });
  } catch (err) {
    next(err);
  }
});

// GET /points/log — paginated, authenticated
router.get('/log', requireAuth, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = 20;
    const offset = (page - 1) * limit;

    const result = await db.query(
      `SELECT id, event_type, points_awarded, reference_id, reference_type,
              expires_at, is_expired, created_at
       FROM bridge_points_log
       WHERE user_id = $1 AND country_code = $2
       ORDER BY created_at DESC
       LIMIT $3 OFFSET $4`,
      [req.user.id, req.countryCode, limit, offset]
    );

    const countResult = await db.query(
      'SELECT COUNT(*) FROM bridge_points_log WHERE user_id = $1 AND country_code = $2',
      [req.user.id, req.countryCode]
    );
    const total = parseInt(countResult.rows[0].count, 10);

    res.json({
      log: result.rows,
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit),
    });
  } catch (err) {
    next(err);
  }
});

// POST /points/redeem — provider only
router.post('/redeem', ...requireRole('provider', 'admin'), async (req, res, next) => {
  try {
    const { points_to_redeem, billing_month } = req.body;

    if (!points_to_redeem || typeof points_to_redeem !== 'number') {
      return res.status(400).json({ error: 'points_to_redeem must be a positive number' });
    }
    if (!billing_month || !/^\d{4}-\d{2}$/.test(billing_month)) {
      return res.status(400).json({ error: 'billing_month must be in YYYY-MM format' });
    }

    const outcome = await redeemPoints(
      req.user.id,
      points_to_redeem,
      billing_month,
      req.countryCode
    );

    if (outcome.error) {
      return res.status(outcome.status || 400).json({ error: outcome.error });
    }

    // Check whether a tier upgrade should now be offered
    const upgradeNotification = await checkAndTriggerTierUpgrade(req.user.id, req.countryCode);

    res.json({
      redemption: outcome.redemption,
      upgrade_notification: upgradeNotification || null,
    });
  } catch (err) {
    next(err);
  }
});

// GET /points/health-score — self-service Trust Score for authenticated provider
router.get('/health-score', requireAuth, async (req, res, next) => {
  try {
    const targetId = req.user.role === 'admin' && req.query.provider_id
      ? req.query.provider_id
      : req.user.id;

    const result = await calculateHealthScore(targetId);
    if (!result) return res.status(404).json({ error: 'Provider not found' });

    res.json({ trust_score: result });
  } catch (err) {
    next(err);
  }
});

// POST /points/redeem-health-benefit — idempotent tier benefit claim
router.post('/redeem-health-benefit', requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== 'provider' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Provider access required' });
    }

    const result = await calculateHealthScore(req.user.id);
    if (!result) return res.status(404).json({ error: 'Provider not found' });

    if (result.tier === 'Emerging') {
      return res.status(400).json({
        error: 'Your Trust Score is below 30. Keep transacting on-platform to unlock your first benefit.',
        current_score: result.score,
        next_tier: result.next_tier,
      });
    }

    // Idempotent: one claim record per tier
    const existing = await db.query(
      `SELECT id FROM bridge_points_log
       WHERE user_id = $1 AND event_type = 'health_benefit_claimed' AND reference_id = $2`,
      [req.user.id, result.tier]
    );

    if (existing.rows.length) {
      return res.json({
        already_claimed: true,
        tier:            result.tier,
        benefits:        result.benefits_unlocked,
        score:           result.score,
        message:         `You already claimed your ${result.tier} benefits. Keep growing to reach the next tier!`,
      });
    }

    await db.query(
      `INSERT INTO bridge_points_log
         (id, user_id, country_code, event_type, points_awarded, reference_id, expires_at, reference_type)
       VALUES (uuid_generate_v4(), $1, $2, 'health_benefit_claimed', 0, $3, '9999-12-31', 'health_tier')`,
      [req.user.id, req.countryCode, result.tier]
    );

    res.json({
      claimed:       true,
      tier:          result.tier,
      tier_color:    result.tier_color,
      benefits:      result.benefits_unlocked,
      score:         result.score,
      message:       `${result.tier} benefits activated! Your listing now reflects your Trust Score.`,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
