const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { requireRole, requireAuth } = require('../middleware/auth');
const { memoryUpload } = require('../middleware/upload');
const { processItemImage } = require('../services/imageProcessor');
const { uploadBuffer } = require('../services/storage');

const router = express.Router();

const AGENT_UPLOAD_DIR = '/tmp/agent-uploads';
fs.mkdirSync(AGENT_UPLOAD_DIR, { recursive: true });

// POST /products/upload-temp — agent image analysis temp upload
router.post('/upload-temp', requireAuth, memoryUpload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });
    const ext = req.file.mimetype === 'image/png' ? '.png' : req.file.mimetype === 'image/webp' ? '.webp' : '.jpg';
    const filename = uuidv4() + ext;
    const dest = path.join(AGENT_UPLOAD_DIR, filename);
    fs.writeFileSync(dest, req.file.buffer);
    const url = 'https://api.bridgesvg.a3tech.uk/uploads/agent-temp/' + filename;
    res.json({ url });
  } catch (err) { next(err); }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter(req, file, cb) {
    const ok = /\.(csv|xlsx|xls)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only CSV or Excel files are accepted'), ok);
  },
});

function parseBoolean(val, def = true) {
  if (val === undefined || val === null || val === '') return def;
  const s = String(val).trim().toLowerCase();
  return !['false', 'no', '0'].includes(s);
}

function parseRows(workbook) {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  const products = [];

  for (const row of rows) {
    // Normalise keys to lowercase with underscores
    const r = {};
    for (const k of Object.keys(row)) r[k.toLowerCase().trim().replace(/\s+/g, '_')] = row[k];

    const name = String(r.name || r.product_name || r.item || '').trim();
    if (!name) continue;

    const rawPrice = String(r.price || r.cost || r.amount || '').replace(/[^0-9.]/g, '');
    const price = rawPrice ? parseFloat(rawPrice) : null;

    products.push({
      name,
      description: String(r.description || r.desc || r.details || '').trim() || null,
      price: price !== null && !isNaN(price) ? price : null,
      unit: String(r.unit || r.uom || '').trim() || null,
      category: String(r.category || r.type || r.group || '').trim() || null,
      in_stock: parseBoolean(r.in_stock ?? r.instock ?? r.stock ?? r.available),
    });
  }

  return products;
}

// POST /products/upload — provider uploads CSV or Excel
router.post('/upload', ...requireRole('provider', 'admin'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const listing = await db.query(
      'SELECT id FROM listings WHERE user_id = $1 AND country_code = $2 LIMIT 1',
      [req.user.id, req.countryCode]
    );
    if (!listing.rows.length) return res.status(404).json({ error: 'No listing found for your account' });
    const listingId = listing.rows[0].id;

    let workbook;
    try {
      workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    } catch {
      return res.status(400).json({ error: 'Could not parse file. Ensure it is a valid CSV or Excel file.' });
    }

    const products = parseRows(workbook);
    if (!products.length) {
      return res.status(400).json({ error: 'No valid rows found. Ensure your file has a "name" column.' });
    }
    if (products.length > 500) {
      return res.status(400).json({ error: 'Maximum 500 products per upload.' });
    }

    const replace = req.query.replace !== 'false';

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      if (replace) {
        await client.query(
          'DELETE FROM business_products WHERE listing_id = $1',
          [listingId]
        );
      }

      for (const p of products) {
        await client.query(
          `INSERT INTO business_products (id, listing_id, country_code, name, description, price, unit, category, in_stock)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [uuidv4(), listingId, req.countryCode, p.name, p.description, p.price, p.unit, p.category, p.in_stock]
        );
      }

      await client.query('COMMIT');
      res.json({ imported: products.length, replaced: replace });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
});

// GET /products — provider's own products
router.get('/', ...requireRole('provider', 'admin'), async (req, res, next) => {
  try {
    const listing = await db.query(
      'SELECT id FROM listings WHERE user_id = $1 AND country_code = $2 LIMIT 1',
      [req.user.id, req.countryCode]
    );
    if (!listing.rows.length) return res.json({ products: [] });

    const result = await db.query(
      `SELECT id, name, description, price, currency, unit, category, in_stock, deal_price, deal_expires, image_url, thumb_url, store_item_id, created_at
       FROM business_products
       WHERE listing_id = $1
       ORDER BY category NULLS LAST, name ASC`,
      [listing.rows[0].id]
    );
    res.json({ products: result.rows });
  } catch (err) { next(err); }
});

// GET /products/listing/:listing_id — public, get products for a listing
router.get('/listing/:listing_id', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT id, name, description, price, currency, unit, category, in_stock, deal_price, deal_expires, image_url, thumb_url, store_item_id
       FROM business_products
       WHERE listing_id = $1 AND country_code = $2
       ORDER BY category NULLS LAST, name ASC`,
      [req.params.listing_id, req.countryCode]
    );
    res.json({ products: result.rows });
  } catch (err) { next(err); }
});

// POST /products/:id/deal — set a deal price and expiry
router.post('/:id/deal', ...requireRole('provider', 'admin'), async (req, res, next) => {
  try {
    const { deal_price, deal_expires } = req.body;
    const existing = await db.query(
      `SELECT bp.id FROM business_products bp
       JOIN listings l ON l.id = bp.listing_id
       WHERE bp.id = $1 AND l.user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Product not found' });
    const result = await db.query(
      `UPDATE business_products SET deal_price=$1, deal_expires=$2, updated_at=NOW() WHERE id=$3 RETURNING *`,
      [deal_price, deal_expires || null, req.params.id]
    );
    res.json({ product: result.rows[0] });
  } catch (err) { next(err); }
});

// DELETE /products/:id/deal — clear deal price and expiry
router.delete('/:id/deal', ...requireRole('provider', 'admin'), async (req, res, next) => {
  try {
    const existing = await db.query(
      `SELECT bp.id FROM business_products bp
       JOIN listings l ON l.id = bp.listing_id
       WHERE bp.id = $1 AND l.user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Product not found' });
    await db.query(
      `UPDATE business_products SET deal_price=NULL, deal_expires=NULL, updated_at=NOW() WHERE id=$1`,
      [req.params.id]
    );
    res.json({ cleared: true });
  } catch (err) { next(err); }
});

// POST /products/:id/image — upload product photo
router.post('/:id/image', requireAuth, memoryUpload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });

    const productRes = await db.query(
      `SELECT bp.id, l.id AS listing_id
       FROM business_products bp
       JOIN listings l ON l.id = bp.listing_id
       WHERE bp.id = $1 AND l.user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!productRes.rows.length) return res.status(404).json({ error: 'Product not found' });
    const { listing_id } = productRes.rows[0];

    const { thumb, optimized } = await processItemImage(req.file.buffer);
    const [thumbRes, imgRes] = await Promise.all([
      uploadBuffer(thumb, `products/${listing_id}/thumbs`, '.webp', 'image/webp'),
      uploadBuffer(optimized, `products/${listing_id}/full`, '.webp', 'image/webp'),
    ]);

    await db.query(
      'UPDATE business_products SET image_url = $1, thumb_url = $2, updated_at = NOW() WHERE id = $3',
      [imgRes.url, thumbRes.url, req.params.id]
    );

    res.json({ success: true, image_url: imgRes.url, thumb_url: thumbRes.url });
  } catch (err) { next(err); }
});

// POST /products/:id/add-to-store — push product into listing_items (virtual store)
router.post('/:id/add-to-store', requireAuth, async (req, res, next) => {
  try {
    const productRes = await db.query(
      `SELECT bp.*, l.id AS listing_id, l.country_code AS lcc
       FROM business_products bp
       JOIN listings l ON l.id = bp.listing_id
       WHERE bp.id = $1 AND l.user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!productRes.rows.length) return res.status(404).json({ error: 'Product not found' });
    const product = productRes.rows[0];

    if (!product.image_url) {
      return res.status(400).json({ error: 'Upload a photo first before adding to store' });
    }

    const addonRes = await db.query(
      `SELECT addon_type FROM listing_addons
       WHERE listing_id = $1 AND addon_type = ANY($2) AND status = 'active'`,
      [product.listing_id, ['item_display', 'item_display_pro']]
    );
    if (!addonRes.rows.length) {
      return res.status(400).json({ error: 'Virtual store addon required' });
    }
    const isPro = addonRes.rows.some(r => r.addon_type === 'item_display_pro');
    const cap = isPro ? 25 : 10;

    const countRes = await db.query(
      'SELECT COUNT(*) FROM listing_items WHERE listing_id = $1',
      [product.listing_id]
    );
    if (parseInt(countRes.rows[0].count) >= cap) {
      return res.status(400).json({ error: 'Store item limit reached. Upgrade to add more items.' });
    }

    const existingRes = await db.query(
      'SELECT id FROM listing_items WHERE listing_id = $1 AND name = $2 LIMIT 1',
      [product.listing_id, product.name]
    );
    if (existingRes.rows.length) {
      return res.status(400).json({ error: 'This product is already in your virtual store' });
    }

    const itemRes = await db.query(
      `INSERT INTO listing_items
         (id, listing_id, country_code, name, description, price, currency, image_url, thumb_url, display_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
         (SELECT COALESCE(MAX(display_order), 0) + 1 FROM listing_items WHERE listing_id = $2))
       RETURNING id`,
      [uuidv4(), product.listing_id, product.lcc, product.name, product.description,
       product.price, product.currency || 'XCD', product.image_url, product.thumb_url]
    );
    const storeItemId = itemRes.rows[0].id;

    await db.query(
      'UPDATE business_products SET store_item_id = $1, updated_at = NOW() WHERE id = $2',
      [storeItemId, product.id]
    );

    res.json({ success: true, store_item_id: storeItemId });
  } catch (err) { next(err); }
});

// PUT /products/:id — provider updates own product
router.put('/:id', ...requireRole('provider', 'admin'), async (req, res, next) => {
  try {
    const { name, description, price, unit, category, in_stock } = req.body;

    const existing = await db.query(
      `SELECT bp.id FROM business_products bp
       JOIN listings l ON l.id = bp.listing_id
       WHERE bp.id = $1 AND l.user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Product not found' });

    const result = await db.query(
      `UPDATE business_products
       SET name=$1, description=$2, price=$3, unit=$4, category=$5, in_stock=$6, updated_at=NOW()
       WHERE id=$7
       RETURNING *`,
      [name, description || null, price ?? null, unit || null, category || null, in_stock ?? true, req.params.id]
    );
    res.json({ product: result.rows[0] });
  } catch (err) { next(err); }
});

// DELETE /products/:id — provider deletes own product
router.delete('/:id', ...requireRole('provider', 'admin'), async (req, res, next) => {
  try {
    const result = await db.query(
      `DELETE FROM business_products bp
       USING listings l
       WHERE bp.listing_id = l.id AND bp.id = $1 AND l.user_id = $2
       RETURNING bp.id`,
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Product not found' });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// DELETE /products — provider clears all their products
router.delete('/', ...requireRole('provider', 'admin'), async (req, res, next) => {
  try {
    const listing = await db.query(
      'SELECT id FROM listings WHERE user_id = $1 AND country_code = $2 LIMIT 1',
      [req.user.id, req.countryCode]
    );
    if (!listing.rows.length) return res.json({ deleted: 0 });

    const result = await db.query(
      'DELETE FROM business_products WHERE listing_id = $1 RETURNING id',
      [listing.rows[0].id]
    );
    res.json({ deleted: result.rows.length });
  } catch (err) { next(err); }
});

module.exports = router;
