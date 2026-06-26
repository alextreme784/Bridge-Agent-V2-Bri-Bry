const express = require('express');
const db = require('../db');
const { v4: uuidv4 } = require('uuid');
const { sendVapidPush } = require('../services/pushService');
const { sendEmail } = require('../services/emailService');

const router = express.Router();

// Helper to seed provider's starter Bridge Points based on registered business tier
async function allocateInitialPoints(userId, countryCode) {
  const userRes = await db.query(
    'SELECT subscription_tier FROM users WHERE id = $1',
    [userId]
  );
  const tier = userRes.rows[0]?.subscription_tier || 'free_period';
  
  const pointsMap = {
    'free_period': 50,
    'level1': 50,
    'level2': 100,
    'level3': 200
  };
  const initialPoints = pointsMap[tier] || 50;

  const logId = uuidv4();
  await db.query(
    `INSERT INTO bridge_points_log (id, user_id, country_code, event_type, points_awarded, expires_at, reference_type)
     VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '1 year', $6)`,
    [logId, userId, countryCode, 'starter_bonus', initialPoints, 'onboarding']
  );

  await db.query(
    'UPDATE users SET bridge_points = bridge_points + $1 WHERE id = $2',
    [initialPoints, userId]
  );

  console.log(`[Webhooks] Allocated ${initialPoints} initial points to user ${userId} in ${countryCode} (tier: ${tier})`);
  return initialPoints;
}

// POST /webhooks - Incoming event handler
router.post('/', async (req, res, next) => {
  const { event, data } = req.body;

  if (event === 'merchant.onboarded') {
    const { userId, email, businessName, countryCode } = data;

    try {
      // 1. Trigger VAPID Web Push notification
      await sendVapidPush(
        userId,
        'Merchant Activation 🚀',
        'Welcome to the BridgePro network! Your shop is now live.',
        { url: '/dashboard' }
      );

      // 2. Send transactional SMTP confirmation
      await sendEmail({
        to: email,
        subject: `Welcome to the BridgePro Network! 🚀`,
        html: `
          <h2>Hello, ${businessName}!</h2>
          <p>We are excited to let you know that your shop is now active and live on BridgePro!</p>
          <p>Your business profile has been initialized, and customers can now see your listings.</p>
          <p><a href="https://bridgepro.a3tech.uk/#/dashboard">Access your Provider Dashboard here</a> to manage listings and products.</p>
        `
      });

      // 3. Allocate initial starter points
      await allocateInitialPoints(userId, countryCode);

      return res.json({ success: true, message: 'Merchant onboarding event processed successfully.' });
    } catch (err) {
      console.error('[Webhooks] Error processing merchant.onboarded:', err.message);
      return res.status(500).json({ error: 'Failed to process webhook event.' });
    }
  }

  res.status(400).json({ error: 'Unsupported webhook event.' });
});

module.exports = router;
