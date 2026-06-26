const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { handleReviewCreated } = require('../services/points');
const { notify } = require('../services/notificationService');

const router = express.Router();

// GET /reviews — reviews given or received by the current user
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT r.*, u.full_name AS reviewer_name
       FROM reviews r
       JOIN users u ON u.id = r.reviewer_id
       WHERE r.reviewer_id = $1 OR r.listing_id IN (
         SELECT id FROM listings WHERE user_id = $1
       )
       ORDER BY r.created_at DESC`,
      [req.user.id]
    );
    res.json({ reviews: result.rows });
  } catch (err) { next(err); }
});

// POST /reviews — verified customer only
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { transaction_id, rating, customer_care, quality, body } = req.body;

    if (!transaction_id || !rating) {
      return res.status(400).json({ error: 'transaction_id and rating are required' });
    }
    if (rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'rating must be between 1 and 5' });
    }

    // Customers must have completed ID verification to leave a review
    // is_verified is set by the standard /verify/id flow; customer_verified by the customer-specific flow
    if (req.user.role === 'customer') {
      const reviewer = await db.query('SELECT is_verified, customer_verified FROM users WHERE id = $1', [req.user.id]);
      const r = reviewer.rows[0];
      if (!r?.is_verified && !r?.customer_verified) {
        return res.status(403).json({ error: 'You must verify your ID before leaving a review' });
      }
    }

    // Transaction must be verified; reviewer must be either party
    const tx = await db.query(
      `SELECT * FROM transactions
       WHERE id = $1 AND is_verified = true
         AND (customer_id = $2 OR provider_id = $2)`,
      [transaction_id, req.user.id]
    );
    if (!tx.rows.length) {
      return res.status(403).json({ error: 'No verified transaction found. Reviews require a verified transaction.' });
    }

    const t = tx.rows[0];

    // Determine which listing is being reviewed (always the other party's listing)
    const reviewedUserId = t.customer_id === req.user.id ? t.provider_id : t.customer_id;

    // One review per transaction per reviewer
    const existing = await db.query(
      'SELECT id FROM reviews WHERE transaction_id = $1 AND reviewer_id = $2',
      [transaction_id, req.user.id]
    );
    if (existing.rows.length) {
      return res.status(409).json({ error: 'Review already submitted for this transaction' });
    }

    // Get reviewed party's listing
    const listing = await db.query(
      'SELECT id, is_claimed FROM listings WHERE user_id = $1 AND country_code = $2 AND is_active = true',
      [reviewedUserId, req.countryCode]
    );
    if (!listing.rows.length) return res.status(404).json({ error: 'The other party does not have an active listing to review' });
    if (listing.rows[0].is_claimed === false) {
      return res.status(403).json({ error: 'Reviews are disabled for unclaimed listings. The business must claim their listing first.' });
    }

    const review = {
      id: uuidv4(),
      transaction_id,
      reviewer_id: req.user.id,
      listing_id: listing.rows[0].id,
      country_code: req.countryCode,
      rating,
      customer_care: customer_care || false,
      quality: quality || false,
      body: body || null,
    };

    const result = await db.query(
      `INSERT INTO reviews (id, transaction_id, reviewer_id, listing_id, country_code, rating, customer_care, quality, body)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      Object.values(review)
    );

    await handleReviewCreated(result.rows[0], reviewedUserId, req.countryCode);

    const reviewer = await db.query('SELECT full_name FROM users WHERE id = $1', [req.user.id]);
    notify(reviewedUserId, 'review', '⭐ New Review', `${reviewer.rows[0]?.full_name} left you a ${rating}-star review`, { url: '/dashboard' }).catch(() => {});

    res.status(201).json({ review: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /reviews/listing/:id — public
router.get('/listing/:id', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT r.*, u.full_name AS reviewer_name
       FROM reviews r JOIN users u ON u.id = r.reviewer_id
       WHERE r.listing_id = $1 AND r.country_code = $2
       ORDER BY r.created_at DESC`,
      [req.params.id, req.countryCode]
    );
    res.json({ reviews: result.rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
