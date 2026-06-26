const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { awardPointsForTransaction, awardReferralTransactionBonus } = require('./pointsService');
const { isPointsEnabled } = require('./platformSettings');

/**
 * Low-level point award — used by admin-driven or manual point events.
 * Uses a far-future expires_at since these are admin-driven.
 */
async function awardPoints(userId, countryCode, eventType, points, referenceId) {
  if (points === 0) return;

  const farFuture = '9999-12-31 00:00:00';

  await db.query(
    `INSERT INTO bridge_points_log
       (id, user_id, country_code, event_type, points_awarded, reference_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [uuidv4(), userId, countryCode, eventType, points, referenceId || null, farFuture]
  );

  await db.query(
    'UPDATE users SET bridge_points = GREATEST(0, bridge_points + $1) WHERE id = $2',
    [points, userId]
  );
}

/**
 * Called when a transaction is verified (both parties confirmed).
 * Delegates to the comprehensive awardPointsForTransaction in pointsService.
 */
async function handleTransactionVerified(transactionId, countryCode, providerId, customerId, verificationMethod) {
  await awardPointsForTransaction(transactionId, providerId, customerId, countryCode);

  // Check if this is the customer's first transaction before incrementing the counter
  const countResult = await db.query(
    'SELECT verified_customer_transaction_count FROM users WHERE id = $1',
    [customerId]
  );
  const isFirstTransaction = (parseInt(countResult.rows[0]?.verified_customer_transaction_count, 10) || 0) === 0;

  await db.query(
    'UPDATE users SET verified_transaction_count = verified_transaction_count + 1 WHERE id = $1',
    [providerId]
  );
  await db.query(
    'UPDATE users SET verified_customer_transaction_count = verified_customer_transaction_count + 1 WHERE id = $1',
    [customerId]
  );

  if (isFirstTransaction) {
    awardReferralTransactionBonus(customerId, countryCode).catch((err) =>
      console.error('[REFERRAL BONUS]', err.message)
    );
  }
}

/**
 * Called when a receipt is uploaded to a transaction.
 * Receipt-based customer bonus is now handled inside awardPointsForTransaction
 * (checked via receipt_doc_url on the transaction row), so this is a no-op.
 */
async function handleReceiptUploaded(transactionId, countryCode, customerId) {
  // No-op: receipt bonus is awarded inside awardPointsForTransaction
  // when the transaction is fully verified and receipt_doc_url is present.
}

/**
 * Called when a review is created for a verified transaction.
 * Delegates to awardPointsForTransaction (idempotent cap check prevents double-awarding).
 */
async function handleReviewCreated(review, providerId, countryCode) {
  if (!review.transaction_id) return;
  if (!(await isPointsEnabled())) return;

  const txResult = await db.query(
    'SELECT customer_id FROM transactions WHERE id = $1',
    [review.transaction_id]
  );
  if (!txResult.rows.length) return;

  const customerId = txResult.rows[0].customer_id;
  await awardPointsForTransaction(review.transaction_id, providerId, customerId, countryCode);

  // Award reviewer 5 pts for leaving a review — only if they are verified
  const reviewerCheck = await db.query(
    'SELECT is_verified, customer_verified, role FROM users WHERE id = $1',
    [review.reviewer_id]
  );
  const reviewer = reviewerCheck.rows[0];
  const reviewerVerified = reviewer?.role === 'customer' ? !!reviewer?.customer_verified : !!reviewer?.is_verified;

  if (reviewer && reviewerVerified) {
    const reviewerExisting = await db.query(
      `SELECT id FROM bridge_points_log
       WHERE user_id = $1 AND event_type = 'review_left' AND reference_id = $2`,
      [review.reviewer_id, review.id]
    );
    if (!reviewerExisting.rows.length) {
      const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
      await db.query(
        `INSERT INTO bridge_points_log
           (id, user_id, country_code, event_type, points_awarded, reference_id, expires_at, reference_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [uuidv4(), review.reviewer_id, countryCode, 'review_left', 5, review.id, expiresAt, 'review']
      );
      await db.query(
        'UPDATE users SET bridge_points = GREATEST(0, bridge_points + 5) WHERE id = $1',
        [review.reviewer_id]
      );
    }
  }
}

/**
 * Award 5 pts to a reporter when admin confirms their report as valid (resolved).
 * Idempotent — fires at most once per report.
 */
async function awardValidReportPoints(reportId, reporterId, countryCode) {
  if (!(await isPointsEnabled())) return;

  // Only verified users earn report points
  const reporterCheck = await db.query(
    'SELECT is_verified, customer_verified, role FROM users WHERE id = $1',
    [reporterId]
  );
  const reporter = reporterCheck.rows[0];
  const reporterVerified = reporter?.role === 'customer' ? !!reporter?.customer_verified : !!reporter?.is_verified;
  if (!reporter || !reporterVerified) return;

  const existing = await db.query(
    `SELECT id FROM bridge_points_log WHERE user_id = $1 AND event_type = 'valid_report' AND reference_id = $2`,
    [reporterId, reportId]
  );
  if (existing.rows.length) return;

  const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
  await db.query(
    `INSERT INTO bridge_points_log
       (id, user_id, country_code, event_type, points_awarded, reference_id, expires_at, reference_type)
     VALUES ($1, $2, $3, 'valid_report', 5, $4, $5, 'report')`,
    [uuidv4(), reporterId, countryCode, reportId, expiresAt]
  );
  await db.query(
    'UPDATE users SET bridge_points = GREATEST(0, bridge_points + 5) WHERE id = $1',
    [reporterId]
  );
}

/**
 * Wipe all points from a user — used as a penalty for serious violations.
 * Marks all active log entries as expired and zeros the balance.
 */
async function wipeUserPoints(userId) {
  await db.query(
    `UPDATE bridge_points_log SET is_expired = true
     WHERE user_id = $1 AND is_expired = false AND points_awarded > 0`,
    [userId]
  );
  await db.query('UPDATE users SET bridge_points = 0 WHERE id = $1', [userId]);
}

module.exports = { awardPoints, handleTransactionVerified, handleReceiptUploaded, handleReviewCreated, awardValidReportPoints, wipeUserPoints };
