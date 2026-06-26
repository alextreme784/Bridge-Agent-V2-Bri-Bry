const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { requireAddon } = require('../middleware/addon');
const { memoryUpload } = require('../middleware/upload');
const { processPhoto } = require('../services/imageProcessor');
const { uploadBuffer, deleteObject, keyFromUrl } = require('../services/storage');

const router = express.Router();
const MAX_PHOTOS = 10;

// GET /photos/listing/:listingId — public
router.get('/listing/:listingId', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT id, thumb_url, original_url, caption, display_order, created_at
       FROM listing_photos
       WHERE listing_id = $1 AND country_code = $2
       ORDER BY display_order ASC, created_at ASC`,
      [req.params.listingId, req.countryCode]
    );
    res.json({ photos: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /photos — provider with photo_gallery addon
router.post(
  '/',
  ...requireRole('provider', 'admin'),
  requireAddon('photo_gallery'),
  memoryUpload.single('photo'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });

      // Enforce limit
      const count = await db.query(
        'SELECT COUNT(*) FROM listing_photos WHERE listing_id = $1',
        [req.listingId]
      );
      if (parseInt(count.rows[0].count) >= MAX_PHOTOS) {
        return res.status(400).json({ error: `Maximum ${MAX_PHOTOS} photos allowed` });
      }

      const { thumb, optimized } = await processPhoto(req.file.buffer);

      const [thumbResult, origResult] = await Promise.all([
        uploadBuffer(thumb, `photos/${req.listingId}/thumbs`, '.webp', 'image/webp'),
        uploadBuffer(optimized, `photos/${req.listingId}/full`, '.webp', 'image/webp'),
      ]);

      const result = await db.query(
        `INSERT INTO listing_photos (id, listing_id, country_code, uploaded_by, original_url, thumb_url, caption, display_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7,
           (SELECT COALESCE(MAX(display_order), 0) + 1 FROM listing_photos WHERE listing_id = $2))
         RETURNING *`,
        [uuidv4(), req.listingId, req.countryCode, req.user.id, origResult.url, thumbResult.url, req.body.caption || null]
      );

      res.status(201).json({ photo: result.rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /photos/:id/caption — update caption on existing photo
router.post(
  '/:id/caption',
  ...requireRole('provider', 'admin'),
  requireAddon('photo_gallery'),
  async (req, res, next) => {
    try {
      const photo = await db.query(
        `SELECT p.id FROM listing_photos p
         JOIN listings l ON l.id = p.listing_id
         WHERE p.id = $1 AND l.user_id = $2 AND p.country_code = $3`,
        [req.params.id, req.user.id, req.countryCode]
      );
      if (!photo.rows.length) return res.status(404).json({ error: 'Photo not found' });
      const result = await db.query(
        'UPDATE listing_photos SET caption = $1 WHERE id = $2 RETURNING *',
        [req.body.caption || null, req.params.id]
      );
      res.json({ photo: result.rows[0] });
    } catch (err) { next(err); }
  }
);

// DELETE /photos/:id — provider (own listing only)
router.delete(
  '/:id',
  ...requireRole('provider', 'admin'),
  requireAddon('photo_gallery'),
  async (req, res, next) => {
    try {
      const photo = await db.query(
        `SELECT p.* FROM listing_photos p
         JOIN listings l ON l.id = p.listing_id
         WHERE p.id = $1 AND l.user_id = $2 AND p.country_code = $3`,
        [req.params.id, req.user.id, req.countryCode]
      );
      if (!photo.rows.length) return res.status(404).json({ error: 'Photo not found' });

      const p = photo.rows[0];
      await Promise.all([
        deleteObject(keyFromUrl(p.original_url)).catch(() => {}),
        deleteObject(keyFromUrl(p.thumb_url)).catch(() => {}),
      ]);

      await db.query('DELETE FROM listing_photos WHERE id = $1', [p.id]);
      res.json({ message: 'Photo deleted' });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /photos/reorder — update display_order
router.put(
  '/reorder',
  ...requireRole('provider', 'admin'),
  requireAddon('photo_gallery'),
  async (req, res, next) => {
    try {
      const { order } = req.body; // [{ id, display_order }]
      if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array' });

      await Promise.all(
        order.map(({ id, display_order }) =>
          db.query(
            `UPDATE listing_photos SET display_order = $1
             WHERE id = $2 AND listing_id = $3`,
            [display_order, id, req.listingId]
          )
        )
      );
      res.json({ message: 'Order updated' });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
