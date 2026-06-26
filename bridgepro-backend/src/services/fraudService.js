const db = require('../db');

/**
 * Run fraud checks on a transaction and flag it if suspicious.
 * Checks:
 *  1. Same provider+customer pair with >3 verified transactions in last 30 days
 *  2. Receipt uploaded within 60 seconds of transaction creation
 *  3. Provider and customer share the same last_login_ip
 */
async function flagSuspiciousTransaction(transactionId, providerId, customerId, countryCode) {
  const triggeredReasons = [];

  // Check 1: More than 3 verified transactions between same pair in last 30 days
  const pairCountResult = await db.query(
    `SELECT COUNT(*) AS count FROM transactions
     WHERE provider_id = $1 AND customer_id = $2
       AND is_verified = true
       AND created_at > NOW() - INTERVAL '30 days'`,
    [providerId, customerId]
  );
  const pairCount = parseInt(pairCountResult.rows[0].count, 10);
  if (pairCount > 3) {
    triggeredReasons.push('Repeated verified transactions between same pair');
  }

  // Check 2: Receipt uploaded within 60 seconds of transaction creation
  const timingResult = await db.query(
    'SELECT created_at, receipt_uploaded_at FROM transactions WHERE id = $1',
    [transactionId]
  );
  const timingRow = timingResult.rows[0];
  if (timingRow && timingRow.created_at && timingRow.receipt_uploaded_at) {
    const secondsDiff = parseFloat(
      await db.query(
        `SELECT EXTRACT(EPOCH FROM ($1::timestamp - $2::timestamp)) AS diff`,
        [timingRow.receipt_uploaded_at, timingRow.created_at]
      ).then((r) => r.rows[0].diff)
    );
    if (secondsDiff < 60) {
      triggeredReasons.push('Receipt uploaded within 60 seconds of transaction creation');
    }
  }

  // Check 3: Provider and customer share the same last_login_ip
  const ipResult = await db.query(
    'SELECT id, last_login_ip FROM users WHERE id IN ($1, $2)',
    [providerId, customerId]
  );
  const ips = ipResult.rows
    .map((r) => r.last_login_ip)
    .filter((ip) => ip !== null && ip !== undefined);
  if (ips.length === 2 && ips[0] === ips[1]) {
    triggeredReasons.push('Provider and customer share the same IP address');
  }

  // Flag the transaction if any check triggered
  if (triggeredReasons.length > 0) {
    await db.query(
      'UPDATE transactions SET fraud_flag = true WHERE id = $1',
      [transactionId]
    );
    for (const reason of triggeredReasons) {
      console.log(`[FRAUD FLAG] Transaction ${transactionId}: ${reason}`);
    }
  }
}

/**
 * Evaluate real-time velocity constraints for points redemption.
 * Checks if a user is attempting to redeem too many points or too frequently
 * within a 24-hour window.
 */
async function checkPointsRedemptionVelocity(userId, pointsToRedeem, countryCode) {
  // Get sum of points redeemed by this user in this country in the last 24 hours
  const result = await db.query(
    `SELECT COALESCE(SUM(points_redeemed), 0) AS total_points, COUNT(*) AS count
     FROM point_redemptions
     WHERE user_id = $1 AND country_code = $2
       AND created_at > NOW() - INTERVAL '24 hours'`,
    [userId, countryCode]
  );
  
  const dailyTotal = parseInt(result.rows[0].total_points, 10);
  const dailyCount = parseInt(result.rows[0].count, 10);

  // Velocity constraints:
  // - Max 2 redemptions per 24 hours
  // - Max 1000 points redeemed per 24 hours
  const MAX_DAILY_REDEMPTIONS = 2;
  const MAX_DAILY_POINTS = 1000;

  if (dailyCount >= MAX_DAILY_REDEMPTIONS) {
    return {
      allowed: false,
      reason: `Velocity limit exceeded: Maximum of ${MAX_DAILY_REDEMPTIONS} points redemptions per 24 hours.`,
      current_24h_count: dailyCount
    };
  }

  if (dailyTotal + pointsToRedeem > MAX_DAILY_POINTS) {
    return {
      allowed: false,
      reason: `Velocity limit exceeded: Maximum of ${MAX_DAILY_POINTS} points can be redeemed per 24 hours. Currently redeemed in last 24h: ${dailyTotal} points.`,
      current_24h_points: dailyTotal
    };
  }

  return { allowed: true };
}

module.exports = { flagSuspiciousTransaction, checkPointsRedemptionVelocity };
