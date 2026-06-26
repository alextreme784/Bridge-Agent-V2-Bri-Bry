const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { requireAddon } = require('../middleware/addon');
const { memoryUpload } = require('../middleware/upload');
const { processItemImage } = require('../services/imageProcessor');
const { uploadBuffer, deleteObject, keyFromUrl } = require('../services/storage');

const router = express.Router();
const ITEMS_BASIC = 10;
const ITEMS_PRO   = 25;

// GET /items/listing/:listingId — public
router.get('/listing/:listingId', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT id, name, description, price, currency, image_url, thumb_url, is_available, display_order, points_redeemable
       FROM listing_items
       WHERE listing_id = $1 AND country_code = $2
       ORDER BY display_order ASC, created_at ASC`,
      [req.params.listingId, req.countryCode]
    );
    res.json({ items: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /items — create item (with optional image)
router.post(
  '/',
  ...requireRole('provider', 'admin'),
  requireAddon(['item_display', 'item_display_pro']),
  memoryUpload.single('image'),
  async (req, res, next) => {
    try {
      const { name, description, price, currency, points_redeemable } = req.body;
      if (!name) return res.status(400).json({ error: 'Item name is required' });
      const isPartner = req.user.is_partner || req.user.role === 'admin';
      const pointsRedeemableVal = (isPartner && points_redeemable !== undefined)
        ? (points_redeemable === 'true' || points_redeemable === true)
        : false;

      const [count, proAddon] = await Promise.all([
        db.query('SELECT COUNT(*) FROM listing_items WHERE listing_id = $1', [req.listingId]),
        db.query(`SELECT id FROM listing_addons WHERE listing_id = $1 AND addon_type = 'item_display_pro' AND status = 'active'`, [req.listingId]),
      ]);
      const maxItems = proAddon.rows.length ? ITEMS_PRO : ITEMS_BASIC;
      if (parseInt(count.rows[0].count) >= maxItems) {
        return res.status(400).json({ error: `Maximum ${maxItems} items allowed` });
      }

      let image_url = null;
      let thumb_url = null;

      if (req.file) {
        const { thumb, optimized } = await processItemImage(req.file.buffer);
        const [thumbRes, imgRes] = await Promise.all([
          uploadBuffer(thumb, `items/${req.listingId}/thumbs`, '.webp', 'image/webp'),
          uploadBuffer(optimized, `items/${req.listingId}/full`, '.webp', 'image/webp'),
        ]);
        image_url = imgRes.url;
        thumb_url = thumbRes.url;
      }

      const result = await db.query(
        `INSERT INTO listing_items
           (id, listing_id, country_code, name, description, price, currency, image_url, thumb_url, display_order, points_redeemable)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
           (SELECT COALESCE(MAX(display_order), 0) + 1 FROM listing_items WHERE listing_id = $2), $10)
         RETURNING *`,
        [uuidv4(), req.listingId, req.countryCode, name, description || null,
          price ? parseFloat(price) : null, currency || 'XCD', image_url, thumb_url, pointsRedeemableVal]
      );

      res.status(201).json({ item: result.rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /items/:id — update item details or toggle availability
router.put(
  '/:id',
  ...requireRole('provider', 'admin'),
  requireAddon(['item_display', 'item_display_pro']),
  memoryUpload.single('image'),
  async (req, res, next) => {
    try {
      const existing = await db.query(
        'SELECT * FROM listing_items WHERE id = $1 AND listing_id = $2',
        [req.params.id, req.listingId]
      );
      if (!existing.rows.length) return res.status(404).json({ error: 'Item not found' });

      const item = existing.rows[0];
      let { image_url, thumb_url } = item;

      if (req.file) {
        // Delete old images
        if (item.image_url) deleteObject(keyFromUrl(item.image_url)).catch(() => {});
        if (item.thumb_url) deleteObject(keyFromUrl(item.thumb_url)).catch(() => {});

        const { thumb, optimized } = await processItemImage(req.file.buffer);
        const [thumbRes, imgRes] = await Promise.all([
          uploadBuffer(thumb, `items/${req.listingId}/thumbs`, '.webp', 'image/webp'),
          uploadBuffer(optimized, `items/${req.listingId}/full`, '.webp', 'image/webp'),
        ]);
        image_url = imgRes.url;
        thumb_url = thumbRes.url;
      }

      const { name, description, price, currency, is_available, points_redeemable } = req.body;

      const isPartner = req.user.is_partner || req.user.role === 'admin';
      const pointsRedeemableVal = (isPartner && points_redeemable !== undefined)
        ? (points_redeemable === 'true' || points_redeemable === true)
        : null;

      const result = await db.query(
        `UPDATE listing_items SET
           name = COALESCE($1, name),
           description = COALESCE($2, description),
           price = COALESCE($3::numeric, price),
           currency = COALESCE($4, currency),
           image_url = $5,
           thumb_url = $6,
           is_available = COALESCE($7::boolean, is_available),
           points_redeemable = COALESCE($9::boolean, points_redeemable)
         WHERE id = $8 RETURNING *`,
        [name || null, description || null, price ? parseFloat(price) : null,
          currency || null, image_url, thumb_url,
          is_available !== undefined ? is_available === 'true' || is_available === true : null,
          req.params.id, pointsRedeemableVal]
      );

      res.json({ item: result.rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /items/:id
router.delete(
  '/:id',
  ...requireRole('provider', 'admin'),
  requireAddon(['item_display', 'item_display_pro']),
  async (req, res, next) => {
    try {
      const item = await db.query(
        'SELECT * FROM listing_items WHERE id = $1 AND listing_id = $2',
        [req.params.id, req.listingId]
      );
      if (!item.rows.length) return res.status(404).json({ error: 'Item not found' });

      const i = item.rows[0];
      await Promise.all([
        i.image_url ? deleteObject(keyFromUrl(i.image_url)).catch(() => {}) : Promise.resolve(),
        i.thumb_url ? deleteObject(keyFromUrl(i.thumb_url)).catch(() => {}) : Promise.resolve(),
      ]);

      await db.query('DELETE FROM listing_items WHERE id = $1', [i.id]);
      res.json({ message: 'Item deleted' });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
