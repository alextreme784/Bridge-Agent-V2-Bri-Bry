const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { isPointsEnabled, getPointValueCents } = require('./platformSettings');

const POINTS_CAP_PER_TX = 10;
const REFERRAL_TRANSACTION_POINTS = 10; // awarded to referrer when referred customer completes first transaction

// Set to true when a customer reward programme is ready to launch
const CUSTOMER_POINTS_ENABLED = false;

// Minimum transaction amount (in local currency) before any points are awarded.
// Prevents splitting one large purchase into many tiny transactions to farm points.
const MIN_AMOUNT_FOR_POINTS = parseFloat(process.env.MIN_TRANSACTION_AMOUNT_FOR_POINTS || '5');

// Max transactions per provider-customer pair per calendar day that earn points.
// Extra transactions still confirm fine — they just don't earn points.
const MAX_POINT_EARNING_TX_PER_DAY_PER_PAIR = 2;

const TIER_MAX_REDEMPTION = { free_period: 250, level1: 250, level2: 500, level3: 1000 };
const TIER_SUBSCRIPTION_PRICE = { free_period: 5, level1: 5, level2: 10, level3: 20 };
const TIER_MIN_PAYMENT = { free_period: 0, level1: 0, level2: 5, level3: 10 };
const CONSECUTIVE_THRESHOLD = 2;

const VALID_TIERS = ['free_period', 'level1', 'level2', 'level3'];

/**
 * Award points to provider (and optionally customer) for a verified transaction.
 * Idempotent: checks existing awards against the 10-point cap before inserting.
 */
async function awardPointsForTransaction(transactionId, providerId, customerId, countryCode) {
  if (!(await isPointsEnabled())) return;

  // Step 1: Check how many points have already been awarded for this transaction+provider
  const existingResult = await db.query(
    `SELECT COALESCE(SUM(points_awarded), 0) AS total_awarded
     FROM bridge_points_log
     WHERE reference_id = $1 AND user_id = $2 AND points_awarded > 0`,
    [transactionId, providerId]
  );
  const alreadyAwarded = parseInt(existingResult.rows[0].total_awarded, 10);
  if (alreadyAwarded >= POINTS_CAP_PER_TX) {
    return;
  }

  // Step 2: Fetch review, provider, and transaction data
  const reviewResult = await db.query(
    'SELECT rating FROM reviews WHERE transaction_id = $1 LIMIT 1',
    [transactionId]
  );
  const review = reviewResult.rows[0] || null;

  const providerResult = await db.query(
    'SELECT is_verified FROM users WHERE id = $1',
    [providerId]
  );
  const provider = providerResult.rows[0];
  if (!provider) return;

  const txResult = await db.query(
    'SELECT verification_method, receipt_doc_url, amount, provider_id, customer_id, country_code FROM transactions WHERE id = $1',
    [transactionId]
  );
  const tx = txResult.rows[0];
  if (!tx) return;

  // Skip points if transaction amount is below the minimum threshold
  if (tx.amount !== null && parseFloat(tx.amount) < MIN_AMOUNT_FOR_POINTS) {
    console.log(`[POINTS] Skipping tx ${transactionId}: amount $${tx.amount} below minimum $${MIN_AMOUNT_FOR_POINTS}`);
    return;
  }

  // Skip points if this provider-customer pair already had MAX earning transactions today
  const todayCount = await db.query(
    `SELECT COUNT(*) FROM bridge_points_log
     WHERE reference_type = 'transaction'
       AND event_type = 'transaction_verified'
       AND created_at::date = CURRENT_DATE
       AND reference_id IN (
         SELECT id::text FROM transactions
         WHERE provider_id = $1 AND customer_id = $2 AND country_code = $3
       )`,
    [tx.provider_id, tx.customer_id, tx.country_code]
  );
  if (parseInt(todayCount.rows[0].count, 10) >= MAX_POINT_EARNING_TX_PER_DAY_PER_PAIR) {
    console.log(`[POINTS] Skipping tx ${transactionId}: pair hit daily limit of ${MAX_POINT_EARNING_TX_PER_DAY_PER_PAIR}`);
    return;
  }

  // Step 3: Build awards array with running total capped at POINTS_CAP_PER_TX
  const awards = [];
  let runningTotal = alreadyAwarded;

  // star_rating bonus: points equal to the review rating
  if (review && review.rating > 0) {
    const ratingPts = Math.min(review.rating, POINTS_CAP_PER_TX - runningTotal);
    if (ratingPts > 0) {
      awards.push({ event_type: 'star_rating', points: ratingPts });
      runningTotal += ratingPts;
    }
  }

  // verified_provider_bonus: 3 pts if provider is verified
  if (provider.is_verified && runningTotal + 3 <= POINTS_CAP_PER_TX) {
    awards.push({ event_type: 'verified_provider_bonus', points: 3 });
    runningTotal += 3;
  }

  // document_bonus: 2 pts for all verified transactions (provider uses in-house docs/receipts)
  if (runningTotal + 2 <= POINTS_CAP_PER_TX) {
    awards.push({ event_type: 'document_bonus', points: 2 });
    runningTotal += 2;
  }

  if (awards.length === 0) return;

  // Step 4: Insert each award and update provider bridge_points
  const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000); // 60 days from now
  let totalAwarded = 0;

  for (const award of awards) {
    await db.query(
      `INSERT INTO bridge_points_log
         (id, user_id, country_code, event_type, points_awarded, reference_id, expires_at, reference_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        uuidv4(),
        providerId,
        countryCode,
        award.event_type,
        award.points,
        transactionId,
        expiresAt,
        'transaction',
      ]
    );
    totalAwarded += award.points;
  }

  await db.query(
    'UPDATE users SET bridge_points = GREATEST(0, bridge_points + $1) WHERE id = $2',
    [totalAwarded, providerId]
  );

  // Step 5: Customer first_transaction bonus — disabled until customer reward programme launches.
  if (!CUSTOMER_POINTS_ENABLED) return;

  const customerResult = await db.query(
    'SELECT customer_verified FROM users WHERE id = $1',
    [customerId]
  );
  const customer = customerResult.rows[0];

  if (customer && customer.customer_verified) {
    const firstTxExisting = await db.query(
      `SELECT id FROM bridge_points_log WHERE user_id = $1 AND event_type = 'first_transaction'`,
      [customerId]
    );
    if (firstTxExisting.rows.length === 0) {
      await db.query(
        `INSERT INTO bridge_points_log
           (id, user_id, country_code, event_type, points_awarded, reference_id, expires_at, reference_type)
         VALUES ($1, $2, $3, 'first_transaction', 25, $4, $5, 'transaction')`,
        [uuidv4(), customerId, countryCode, transactionId, expiresAt]
      );
      await db.query(
        'UPDATE users SET bridge_points = GREATEST(0, bridge_points + 25) WHERE id = $1',
        [customerId]
      );
    }
  }

}

/**
 * Expire points that have passed their expires_at date.
 * Marks records as is_expired=true and deducts from user bridge_points.
 */
async function expirePoints() {
  const result = await db.query(
    `UPDATE bridge_points_log
     SET is_expired = true
     WHERE is_expired = false
       AND expires_at < NOW()
       AND points_awarded > 0
     RETURNING user_id, points_awarded`
  );

  if (result.rows.length === 0) {
    return { expired_count: 0, total_points_removed: 0 };
  }

  // Group by user_id
  const byUser = {};
  for (const row of result.rows) {
    byUser[row.user_id] = (byUser[row.user_id] || 0) + parseInt(row.points_awarded, 10);
  }

  let total_points_removed = 0;
  for (const [userId, pts] of Object.entries(byUser)) {
    await db.query(
      'UPDATE users SET bridge_points = GREATEST(0, bridge_points - $1) WHERE id = $2',
      [pts, userId]
    );
    total_points_removed += pts;
  }

  return { expired_count: result.rows.length, total_points_removed };
}

/**
 * Redeem points for a provider for a given billing month.
 * Returns { error, status } on validation failure or { redemption } on success.
 */
async function redeemPoints(userId, pointsToRedeem, billingMonth, countryCode) {
  if (!(await isPointsEnabled())) {
    return { error: 'The points system is currently disabled', status: 403 };
  }

  // Get user
  const userResult = await db.query(
    'SELECT role, bridge_points, subscription_tier, verified_transaction_count FROM users WHERE id = $1',
    [userId]
  );
  const user = userResult.rows[0];
  if (!user) return { error: 'User not found', status: 404 };

  // Role check
  if (user.role !== 'provider') {
    return { error: 'Only providers can redeem points', status: 403 };
  }

  // Transaction count check
  if (user.verified_transaction_count < 5) {
    return {
      error: `You need at least 5 verified transactions to redeem points. You have ${user.verified_transaction_count}.`,
      status: 400,
    };
  }

  // Minimum redemption
  if (pointsToRedeem < 50) {
    return { error: 'Minimum redemption is 50 points', status: 400 };
  }

  // Must be multiple of 50
  if (pointsToRedeem % 50 !== 0) {
    return { error: 'Points to redeem must be a multiple of 50', status: 400 };
  }

  // Balance check
  if (user.bridge_points < pointsToRedeem) {
    return {
      error: `Insufficient points. Balance: ${user.bridge_points}`,
      status: 400,
    };
  }

  const tier = user.subscription_tier || 'free_period';

  // Tier max check
  const tierMax = TIER_MAX_REDEMPTION[tier] || 250;
  if (pointsToRedeem > tierMax) {
    return {
      error: `Your ${tier} tier allows a maximum redemption of ${tierMax} points per month`,
      status: 400,
    };
  }

  // Minimum payment check: dollar value of redemption must not exceed (tier price - min payment)
  const pointValueCents = await getPointValueCents();
  const dollarValue = (pointsToRedeem * pointValueCents) / 100;
  const tierPrice = TIER_SUBSCRIPTION_PRICE[tier] || 5;
  const minPayment = TIER_MIN_PAYMENT[tier] || 0;
  const maxDollarCredit = tierPrice - minPayment;
  if (dollarValue > maxDollarCredit) {
    return {
      error: `Redemption would exceed the maximum credit of $${maxDollarCredit.toFixed(2)} for your ${tier} tier`,
      status: 400,
    };
  }

  // Check for existing redemption this billing month
  const existingRedemption = await db.query(
    'SELECT id FROM point_redemptions WHERE user_id = $1 AND billing_month = $2',
    [userId, billingMonth]
  );
  if (existingRedemption.rows.length) {
    return {
      error: `You have already redeemed points for billing month ${billingMonth}`,
      status: 409,
    };
  }

  // All validations passed — perform redemption
  const farFuture = '9999-12-31 00:00:00';

  // Insert negative entry to bridge_points_log
  await db.query(
    `INSERT INTO bridge_points_log
       (id, user_id, country_code, event_type, points_awarded, reference_id, expires_at, reference_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      uuidv4(),
      userId,
      countryCode,
      'redemption',
      -pointsToRedeem,
      null,
      farFuture,
      'redemption',
    ]
  );

  // Deduct points from user
  await db.query(
    'UPDATE users SET bridge_points = GREATEST(0, bridge_points - $1) WHERE id = $2',
    [pointsToRedeem, userId]
  );

  // Create redemption record
  const dollarValueFixed = dollarValue.toFixed(2);
  const redemptionResult = await db.query(
    `INSERT INTO point_redemptions
       (id, user_id, country_code, points_redeemed, dollar_value, billing_month)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [uuidv4(), userId, countryCode, pointsToRedeem, dollarValueFixed, billingMonth]
  );

  return { redemption: redemptionResult.rows[0] };
}

/**
 * Check whether the user has hit consecutive max redemptions and should be offered a tier upgrade.
 * Returns an upgrade notification object if triggered, or null.
 */
async function checkAndTriggerTierUpgrade(userId, countryCode) {
  const userResult = await db.query(
    'SELECT subscription_tier, consecutive_max_redemptions FROM users WHERE id = $1',
    [userId]
  );
  const user = userResult.rows[0];
  if (!user) return null;

  const tier = user.subscription_tier || 'free_period';
  const billingMonth = new Date().toISOString().slice(0, 7); // YYYY-MM

  // Get this month's redemption
  const redemptionResult = await db.query(
    'SELECT points_redeemed FROM point_redemptions WHERE user_id = $1 AND billing_month = $2',
    [userId, billingMonth]
  );
  const thisMonthRedemption = redemptionResult.rows[0];
  const thisMonthRedeemed = thisMonthRedemption ? parseInt(thisMonthRedemption.points_redeemed, 10) : 0;

  const tierMax = TIER_MAX_REDEMPTION[tier] || 250;
  const currentConsecutive = parseInt(user.consecutive_max_redemptions, 10) || 0;

  let newConsecutive;
  if (thisMonthRedeemed >= tierMax) {
    newConsecutive = currentConsecutive + 1;
  } else {
    newConsecutive = 0;
  }

  await db.query(
    'UPDATE users SET consecutive_max_redemptions = $1 WHERE id = $2',
    [newConsecutive, userId]
  );

  // Tier upgrade ladder
  const tierOrder = ['free_period', 'level1', 'level2', 'level3'];
  const currentIndex = tierOrder.indexOf(tier);
  const isMaxTier = tier === 'level3';

  if (newConsecutive >= CONSECUTIVE_THRESHOLD && !isMaxTier) {
    // Mark upgrade available
    await db.query(
      'UPDATE users SET upgrade_available = true WHERE id = $1',
      [userId]
    );

    const suggestedTier = currentIndex >= 0 && currentIndex < tierOrder.length - 1
      ? tierOrder[currentIndex + 1]
      : null;

    const message = `You have reached the maximum redemption for your ${tier} tier for ${CONSECUTIVE_THRESHOLD} consecutive months. You are eligible to upgrade to ${suggestedTier}.`;
    console.log(`[TIER UPGRADE] User ${userId}: ${message}`);

    return {
      upgrade_available: true,
      current_tier: tier,
      suggested_tier: suggestedTier,
      message,
    };
  }

  return null;
}

const REFERRAL_POINTS = 5;

/**
 * Award Bridge Points to a referrer when a user they invited successfully registers.
 * Idempotent: safe to call multiple times for the same referredUserId.
 */
async function awardReferralPoints(referrerId, referredUserId, countryCode) {
  if (!(await isPointsEnabled())) return;

  const referrerCheck = await db.query(
    'SELECT is_verified, customer_verified, role FROM users WHERE id = $1',
    [referrerId]
  );
  const referrer = referrerCheck.rows[0];
  if (!referrer) return;

  // Customer referral points disabled until customer reward programme launches
  if (referrer.role === 'customer' && !CUSTOMER_POINTS_ENABLED) return;

  const referrerVerified = referrer.role === 'customer' ? !!referrer.customer_verified : !!referrer.is_verified;
  if (!referrerVerified) return;

  const existing = await db.query(
    `SELECT id FROM bridge_points_log
     WHERE user_id = $1 AND event_type = 'referral_signup' AND reference_id = $2`,
    [referrerId, referredUserId]
  );
  if (existing.rows.length) return;

  const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
  await db.query(
    `INSERT INTO bridge_points_log
       (id, user_id, country_code, event_type, points_awarded, reference_id, expires_at, reference_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [uuidv4(), referrerId, countryCode, 'referral_signup', REFERRAL_POINTS, referredUserId, expiresAt, 'referral']
  );
  await db.query(
    'UPDATE users SET bridge_points = GREATEST(0, bridge_points + $1) WHERE id = $2',
    [REFERRAL_POINTS, referrerId]
  );
}

/**
 * Award 10 pts to the referrer when a referred customer completes their first transaction.
 * Idempotent — fires at most once per referred customer.
 */
async function awardReferralTransactionBonus(customerId, countryCode) {
  if (!(await isPointsEnabled())) return;

  const referrerResult = await db.query(
    'SELECT referred_by FROM users WHERE id = $1',
    [customerId]
  );
  const referrerId = referrerResult.rows[0]?.referred_by;
  if (!referrerId) return;

  // Unverified customers do not earn referral transaction bonuses
  const referrerCheck = await db.query(
    'SELECT is_verified, customer_verified, role FROM users WHERE id = $1',
    [referrerId]
  );
  const referrer = referrerCheck.rows[0];
  if (!referrer) return;

  // Customer referral transaction bonus disabled until customer reward programme launches
  if (referrer.role === 'customer' && !CUSTOMER_POINTS_ENABLED) return;

  const referrerVerified = referrer.role === 'customer' ? !!referrer.customer_verified : !!referrer.is_verified;
  if (!referrerVerified) return;

  const existing = await db.query(
    `SELECT id FROM bridge_points_log
     WHERE user_id = $1 AND event_type = 'referral_first_transaction' AND reference_id = $2`,
    [referrerId, customerId]
  );
  if (existing.rows.length) return;

  const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
  await db.query(
    `INSERT INTO bridge_points_log
       (id, user_id, country_code, event_type, points_awarded, reference_id, expires_at, reference_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [uuidv4(), referrerId, countryCode, 'referral_first_transaction', REFERRAL_TRANSACTION_POINTS, customerId, expiresAt, 'referral']
  );
  await db.query(
    'UPDATE users SET bridge_points = GREATEST(0, bridge_points + $1) WHERE id = $2',
    [REFERRAL_TRANSACTION_POINTS, referrerId]
  );
}

// ── Health Score ──────────────────────────────────────────────────────────────

const HEALTH_TIERS = [
  { name: 'Platinum', min: 90, color: '#7C3AED', benefits: ['MSME credit profile shareable with lenders', 'Premium search placement', 'Verified Business badge', 'Priority support'] },
  { name: 'Gold',     min: 70, color: '#D97706', benefits: ['Verified Business badge', 'Priority support queue', 'Boosted search ranking'] },
  { name: 'Silver',   min: 50, color: '#6B7280', benefits: ['Boosted search ranking', 'BridgePro Silver badge'] },
  { name: 'Bronze',   min: 30, color: '#92400E', benefits: ['BridgePro Bronze badge on listing'] },
  { name: 'Emerging', min: 0,  color: '#374151', benefits: [] },
];

function getHealthTier(score) {
  return HEALTH_TIERS.find(t => score >= t.min) || HEALTH_TIERS[HEALTH_TIERS.length - 1];
}

/**
 * Compute a 0–100 BridgePro Trust Score for a provider.
 * Weights: transactions 40 | avg_rating 30 | tenure 20 | KYC verified 10
 */
async function calculateHealthScore(providerId) {
  const [userRow, ratingRow] = await Promise.all([
    db.query(
      'SELECT verified_transaction_count, is_verified, created_at FROM users WHERE id = $1',
      [providerId]
    ),
    db.query(
      `SELECT COALESCE(AVG(r.rating), 0) AS avg_rating, COUNT(r.id) AS review_count
       FROM reviews r
       JOIN listings l ON l.id = r.listing_id
       WHERE l.user_id = $1`,
      [providerId]
    ),
  ]);

  const user = userRow.rows[0];
  if (!user) return null;

  const verifiedTxCount = parseInt(user.verified_transaction_count, 10) || 0;
  const avgRating       = parseFloat(ratingRow.rows[0].avg_rating) || 0;
  const reviewCount     = parseInt(ratingRow.rows[0].review_count, 10) || 0;
  const tenureDays      = user.created_at
    ? Math.floor((Date.now() - new Date(user.created_at).getTime()) / 86_400_000)
    : 0;
  const isVerified      = !!user.is_verified;

  const txScore       = Math.min(verifiedTxCount / 20, 1) * 40;
  const ratingScore   = reviewCount > 0 ? (avgRating / 5) * 30 : 0;
  const tenureScore   = Math.min(tenureDays / 180, 1) * 20;
  const verifiedBonus = isVerified ? 10 : 0;

  const score = Math.round(txScore + ratingScore + tenureScore + verifiedBonus);
  const tier  = getHealthTier(score);

  return {
    score,
    tier: tier.name,
    tier_color: tier.color,
    benefits_unlocked: tier.benefits,
    breakdown: {
      transaction_score: Math.round(txScore),
      rating_score:      Math.round(ratingScore),
      tenure_score:      Math.round(tenureScore),
      verified_bonus:    verifiedBonus,
    },
    inputs: {
      verified_transactions: verifiedTxCount,
      avg_rating:            +avgRating.toFixed(2),
      review_count:          reviewCount,
      tenure_days:           tenureDays,
      is_verified:           isVerified,
    },
    next_tier: (() => {
      const idx = HEALTH_TIERS.findIndex(t => t.name === tier.name);
      if (idx <= 0) return null;
      const next = HEALTH_TIERS[idx - 1];
      return { name: next.name, min_score: next.min, points_needed: next.min - score };
    })(),
  };
}

/**
 * Convenience wrapper: increment verified_transaction_count and trigger
 * BridgePoints + Trust Score update for a freshly-created transaction.
 */
async function updateCreditProfile(transactionId, providerId, countryCode) {
  await db.query(
    `UPDATE users SET verified_transaction_count = COALESCE(verified_transaction_count, 0) + 1
     WHERE id = $1`,
    [providerId]
  );
  await awardPointsForTransaction(transactionId, providerId, null, countryCode);
}

module.exports = {
  updateCreditProfile,
  awardPointsForTransaction,
  awardReferralPoints,
  awardReferralTransactionBonus,
  expirePoints,
  redeemPoints,
  checkAndTriggerTierUpgrade,
  calculateHealthScore,
  HEALTH_TIERS,
  TIER_MAX_REDEMPTION,
  TIER_SUBSCRIPTION_PRICE,
  VALID_TIERS,
};
