const db = require('../db');

async function calculateReputationScore(customerId) {
  const userResult = await db.query(
    `SELECT customer_verified, verified_customer_transaction_count,
            average_confirmation_speed_hours
     FROM users WHERE id = $1`,
    [customerId]
  );
  const user = userResult.rows[0];
  if (!user) return 0;

  let rawScore = 0;

  // a) Verified status: +2.0 if verified
  if (user.customer_verified) rawScore += 2.0;

  // b) Transaction count
  const txCount = parseInt(user.verified_customer_transaction_count, 10) || 0;
  if (txCount >= 20) rawScore += 4.0;
  else if (txCount >= 10) rawScore += 3.0;
  else if (txCount >= 5) rawScore += 2.0;
  else if (txCount >= 1) rawScore += 1.0;

  // c) Confirmation speed (only meaningful if they have transactions)
  if (txCount > 0) {
    const avgSpeed = parseFloat(user.average_confirmation_speed_hours) || 0;
    if (avgSpeed <= 24) rawScore += 2.0;
    else if (avgSpeed <= 48) rawScore += 1.5;
    else if (avgSpeed <= 72) rawScore += 1.0;
  }

  // d) Open dispute penalty: -1.0 per open dispute (floor 0)
  const disputeResult = await db.query(
    `SELECT COUNT(*) FROM customer_dispute_flags WHERE customer_id = $1 AND status = 'open'`,
    [customerId]
  );
  const openDisputes = parseInt(disputeResult.rows[0].count, 10) || 0;
  rawScore = Math.max(0, rawScore - openDisputes);

  // Normalise to 5.0 scale, round to 1 decimal
  const normalised = Math.round(Math.min(5.0, (rawScore / 8.0) * 5.0) * 10) / 10;

  await db.query('UPDATE users SET customer_reputation_score = $1 WHERE id = $2', [normalised, customerId]);

  return normalised;
}

async function updateConfirmationSpeed(customerId, transactionId) {
  const txResult = await db.query(
    'SELECT created_at FROM transactions WHERE id = $1',
    [transactionId]
  );
  if (!txResult.rows.length) return;

  const hoursElapsed = (Date.now() - new Date(txResult.rows[0].created_at).getTime()) / 3_600_000;
  const hoursRounded = parseFloat(hoursElapsed.toFixed(2));

  await db.query(
    'UPDATE transactions SET customer_confirmation_speed_hours = $1 WHERE id = $2',
    [hoursRounded, transactionId]
  );

  const avgResult = await db.query(
    `SELECT AVG(customer_confirmation_speed_hours) AS avg_speed
     FROM transactions
     WHERE customer_id = $1 AND customer_confirmation_speed_hours IS NOT NULL`,
    [customerId]
  );

  const avgSpeed = parseFloat(parseFloat(avgResult.rows[0].avg_speed || 0).toFixed(2));

  await db.query(
    'UPDATE users SET average_confirmation_speed_hours = $1 WHERE id = $2',
    [avgSpeed, customerId]
  );

  return calculateReputationScore(customerId);
}

function getClientLabel(score) {
  const s = parseFloat(score) || 0;
  if (s >= 4.5) return 'Excellent Client';
  if (s >= 3.5) return 'Good Client';
  if (s >= 2.5) return 'Average Client';
  return 'New Client';
}

module.exports = { calculateReputationScore, updateConfirmationSpeed, getClientLabel };
