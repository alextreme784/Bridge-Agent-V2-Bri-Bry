const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { checkProviderAccess } = require('../middleware/subscription');
const { isFreePeriodActive, isFirstImpressionEnabled } = require('../services/platformSettings');
const slugify = require('../utils/slugify');
const { memoryUpload, videoUpload } = require('../middleware/upload');
const { processLogo } = require('../services/imageProcessor');
const { uploadBuffer, deleteObject, keyFromUrl } = require('../services/storage');

const router = express.Router();

db.query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS first_impression_url TEXT`)
  .catch(err => console.error('[listings] first_impression_url:', err.message));
db.query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS first_impression_tier VARCHAR(10) DEFAULT '15'`)
  .catch(err => console.error('[listings] first_impression_tier:', err.message));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUUID = (v) => UUID_RE.test(v);

function mapListing(l) {
  const isGovt = l.category_slug === 'government-public' || l.category_name === 'Government & Public' || l.category === 'Government & Public';
  return {
    ...l,
    is_verified: !!(l.is_verified || isGovt),
    is_featured: l.subscription_tier === 'level3',
    is_pro: l.subscription_tier === 'level2' || l.subscription_tier === 'level3',
    featured: l.subscription_tier === 'level3',
    pro: l.subscription_tier === 'level2',
    is_sponsored: !!l.is_sponsored,
  };
}

const SPONSORED_SUBQUERY = `
  EXISTS (
    SELECT 1 FROM listing_addons la
    WHERE la.listing_id = l.id AND la.addon_type = 'featured_listing' AND la.status = 'active'
  ) AS is_sponsored`;

async function getTierSubcategoryMax(tier) {
  const key = `TIER_${String(tier).toUpperCase().replace(/-/g, '_')}_MAX_SUBCATEGORIES`;
  const r = await db.query('SELECT value FROM platform_settings WHERE key = $1', [key]);
  return parseInt(r.rows[0]?.value || '1', 10);
}

// Core subcategory linking logic used by both POST /listings and POST /listings/:id/subcategories
async function linkSubcategory(client, listingId, sub, isPrimary, customDescription, userId, countryCode) {
  if (isPrimary) {
    await client.query('UPDATE listing_subcategories SET is_primary = false WHERE listing_id = $1', [listingId]);
  }

  if (sub.is_other) {
    if (!customDescription) {
      throw Object.assign(new Error('custom_description is required when selecting Other'), { status: 400 });
    }
    const desc = customDescription.trim();
    if (desc.length < 10) throw Object.assign(new Error('custom_description must be at least 10 characters'), { status: 400 });
    if (desc.length > 200) throw Object.assign(new Error('custom_description must not exceed 200 characters'), { status: 400 });

    // Check for an existing active subcategory with this name in same category
    const match = await client.query(
      `SELECT id FROM subcategories
       WHERE category_id = $1 AND status = 'active' AND is_active = true
         AND LOWER(TRIM(name)) = LOWER($2)
       LIMIT 1`,
      [sub.category_id, desc]
    );

    if (match.rows.length) {
      await client.query(
        `INSERT INTO listing_subcategories (id, listing_id, subcategory_id, is_primary)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (listing_id, subcategory_id) DO UPDATE SET is_primary = EXCLUDED.is_primary`,
        [uuidv4(), listingId, match.rows[0].id, isPrimary]
      );
      return { pending: false };
    }

    // No match — create pending custom subcategory
    const customId = uuidv4();
    const customSlug = `${slugify(desc)}-${Math.random().toString(16).slice(2, 6)}`;
    await client.query(
      `INSERT INTO subcategories
         (id, category_id, name, slug, is_other, status, submitted_by, country_code, display_order)
       VALUES ($1, $2, $3, $4, true, 'pending', $5, $6,
               (SELECT COALESCE(MAX(display_order), -1) + 1 FROM subcategories WHERE category_id = $2))`,
      [customId, sub.category_id, desc, customSlug, userId, countryCode]
    );

    await client.query(
      `INSERT INTO listing_subcategories
         (id, listing_id, subcategory_id, is_primary, pending_custom_subcategory_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (listing_id, subcategory_id) DO UPDATE
         SET is_primary = EXCLUDED.is_primary,
             pending_custom_subcategory_id = EXCLUDED.pending_custom_subcategory_id`,
      [uuidv4(), listingId, sub.id, isPrimary, customId]
    );

    const catResult = await client.query('SELECT name FROM categories WHERE id = $1', [sub.category_id]);
    const catName = catResult.rows[0]?.name || 'Unknown';
    console.log(`[SUBCATEGORY] New custom subcategory pending approval: "${desc}" under ${catName} submitted by provider ${userId}`);

    return { pending: true };
  }

  // Regular subcategory
  await client.query(
    `INSERT INTO listing_subcategories (id, listing_id, subcategory_id, is_primary)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (listing_id, subcategory_id) DO UPDATE SET is_primary = EXCLUDED.is_primary`,
    [uuidv4(), listingId, sub.id, isPrimary]
  );
  return { pending: false };
}

// Common SELECT fragments for listing queries
const SUBCATS_SUBQUERY = `
  COALESCE(
    (SELECT json_agg(t.obj ORDER BY t.is_primary DESC, t.display_order ASC)
     FROM (
       SELECT json_build_object('id', s.id, 'name', s.name, 'slug', s.slug) AS obj,
              ls2.is_primary, s.display_order
       FROM listing_subcategories ls2
       JOIN subcategories s ON s.id = ls2.subcategory_id
       WHERE ls2.listing_id = l.id AND s.status = 'active' AND s.is_active = true
       ORDER BY ls2.is_primary DESC, s.display_order ASC
       LIMIT 3
     ) t),
    '[]'::json
  ) AS subcategories`;

// GET /listings/mine — authenticated provider fetches their own active listing
router.get('/mine', ...requireRole('provider', 'admin'), async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT l.*, u.full_name, u.email, u.is_verified, u.bridge_points, u.subscription_tier,
              u.verified_transaction_count,
              cat.name AS category_name, cat.slug AS category_slug,
              COALESCE(AVG(r.rating), 0) AS avg_rating,
              COUNT(DISTINCT r.id) AS review_count,
              COALESCE(
                (SELECT json_agg(t.obj ORDER BY t.is_primary DESC, t.display_order ASC)
                 FROM (
                   SELECT json_build_object('id', s.id, 'name', s.name, 'slug', s.slug, 'is_other', s.is_other) AS obj,
                          ls2.is_primary, s.display_order
                   FROM listing_subcategories ls2
                   JOIN subcategories s ON s.id = ls2.subcategory_id
                   WHERE ls2.listing_id = l.id AND s.status = 'active' AND s.is_active = true
                 ) t),
                '[]'::json
              ) AS subcategories
       FROM listings l
       JOIN users u ON u.id = l.user_id
       LEFT JOIN reviews r ON r.listing_id = l.id
       LEFT JOIN categories cat ON cat.id = l.category_id
       WHERE l.user_id = $1 AND l.country_code = $2 AND l.is_active = true
       GROUP BY l.id, u.id, cat.id
       LIMIT 1`,
      [req.user.id, req.countryCode]
    );
    res.json({ listing: result.rows[0] ? mapListing(result.rows[0]) : null });
  } catch (err) { next(err); }
});

// GET /listings/featured — up to 6 level3 providers (public)
router.get('/featured', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT l.id, l.user_id, l.business_name, l.category, l.category_id, l.description, l.service_areas,
              l.subscription_status, l.verified_customers_only, l.created_at, l.logo_url,
              u.full_name, u.is_verified, u.bridge_points, u.subscription_tier,
              u.verified_transaction_count,
              cat.name AS category_name, cat.slug AS category_slug,
              sub_p.name AS primary_subcategory_name, sub_p.slug AS primary_subcategory_slug,
              COALESCE(AVG(r.rating), 0) AS avg_rating,
              COUNT(DISTINCT r.id) AS review_count,
              (SELECT COUNT(*) FROM customer_dispute_flags WHERE provider_id = u.id AND status = 'open') AS dispute_count,
              ${SUBCATS_SUBQUERY},
              ${SPONSORED_SUBQUERY}
       FROM listings l
       JOIN users u ON u.id = l.user_id
       LEFT JOIN reviews r ON r.listing_id = l.id
       LEFT JOIN categories cat ON cat.id = l.category_id
       LEFT JOIN listing_subcategories ls_p ON ls_p.listing_id = l.id AND ls_p.is_primary = true
       LEFT JOIN subcategories sub_p ON sub_p.id = ls_p.subcategory_id AND sub_p.status = 'active'
       WHERE l.country_code = $1 AND l.is_active = true
         AND u.subscription_tier = 'level3'
         AND u.subscription_status IN ('free_period', 'active')
       GROUP BY l.id, u.id, cat.id, sub_p.id
       ORDER BY is_sponsored DESC, avg_rating DESC, review_count DESC
       LIMIT 6`,
      [req.countryCode]
    );
    res.json({ listings: result.rows.map(mapListing) });
  } catch (err) {
    next(err);
  }
});

// GET /listings/top — up to 10 level2+level3 providers (public)
router.get('/top', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT l.id, l.user_id, l.business_name, l.category, l.category_id, l.description, l.service_areas,
              l.subscription_status, l.verified_customers_only, l.created_at, l.logo_url,
              u.full_name, u.is_verified, u.bridge_points, u.subscription_tier,
              u.verified_transaction_count,
              cat.name AS category_name, cat.slug AS category_slug,
              sub_p.name AS primary_subcategory_name, sub_p.slug AS primary_subcategory_slug,
              COALESCE(AVG(r.rating), 0) AS avg_rating,
              COUNT(DISTINCT r.id) AS review_count,
              (SELECT COUNT(*) FROM customer_dispute_flags WHERE provider_id = u.id AND status = 'open') AS dispute_count,
              ${SUBCATS_SUBQUERY},
              ${SPONSORED_SUBQUERY}
       FROM listings l
       JOIN users u ON u.id = l.user_id
       LEFT JOIN reviews r ON r.listing_id = l.id
       LEFT JOIN categories cat ON cat.id = l.category_id
       LEFT JOIN listing_subcategories ls_p ON ls_p.listing_id = l.id AND ls_p.is_primary = true
       LEFT JOIN subcategories sub_p ON sub_p.id = ls_p.subcategory_id AND sub_p.status = 'active'
       WHERE l.country_code = $1 AND l.is_active = true
         AND u.subscription_tier IN ('level2', 'level3')
         AND u.subscription_status IN ('free_period', 'active')
       GROUP BY l.id, u.id, cat.id, sub_p.id
       ORDER BY
         is_sponsored DESC,
         CASE u.subscription_tier WHEN 'level3' THEN 1 WHEN 'level2' THEN 2 ELSE 3 END,
         avg_rating DESC, review_count DESC
       LIMIT 10`,
      [req.countryCode]
    );
    res.json({ listings: result.rows.map(mapListing) });
  } catch (err) {
    next(err);
  }
});

// GET /listings/stats — total count of all active listings for the country (no subscription filter)
router.get('/stats', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT
         COUNT(*)                                                              AS total,
         COUNT(*) FILTER (WHERE is_claimed = true AND COALESCE(is_public,false) = false) AS providers,
         COUNT(*) FILTER (WHERE (is_claimed = false OR is_claimed IS NULL) AND COALESCE(is_public,false) = false) AS unclaimed,
         COUNT(*) FILTER (WHERE is_public = true)                             AS govt
       FROM listings
       WHERE country_code = $1 AND is_active = true AND (expires_at IS NULL OR expires_at > NOW())`,
      [req.countryCode]
    );
    const r = result.rows[0];
    res.json({
      total:     parseInt(r.total,     10),
      providers: parseInt(r.providers, 10),
      unclaimed: parseInt(r.unclaimed, 10),
      govt:      parseInt(r.govt,      10),
    });
  } catch (err) { next(err); }
});

// GET /listings — public search with tier ordering and new filters
router.get('/', async (req, res, next) => {
  try {
    const { category, subcategory, search, tier, verified_only, is_public, is_claimed, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    const params = [req.countryCode];
    const whereClauses = ['l.country_code = $1', 'l.is_active = true', '(l.expires_at IS NULL OR l.expires_at > NOW())'];

    const freePeriod = await isFreePeriodActive();
    if (!freePeriod) whereClauses.push(`(l.is_public = true OR u.subscription_status IN ('free_period', 'active'))`);

    if (is_public === 'true') {
      whereClauses.push(`(l.is_public = true OR cat.slug = 'government-public' OR cat.name = 'Government & Public')`);
    } else if (is_public === 'false') {
      whereClauses.push(`(COALESCE(l.is_public, false) = false AND COALESCE(cat.slug, '') != 'government-public' AND COALESCE(cat.name, '') != 'Government & Public')`);
    }
    // is_claimed filter: 'true' = provider accounts (claimed), 'false' = unclaimed/seeded listings
    if (is_claimed === 'true') {
      whereClauses.push(`l.is_claimed = true AND COALESCE(l.is_public, false) = false`);
    } else if (is_claimed === 'false') {
      whereClauses.push(`(l.is_claimed = false OR l.is_claimed IS NULL) AND COALESCE(l.is_public, false) = false`);
    }

    if (category) {
      params.push(category);
      whereClauses.push(isUUID(category)
        ? `l.category_id = $${params.length}`
        : `cat.slug = $${params.length}`);
    }

    if (subcategory) {
      params.push(subcategory);
      const col = isUUID(subcategory) ? 'ls_f.subcategory_id' : 'sf.slug';
      whereClauses.push(
        `EXISTS (
          SELECT 1 FROM listing_subcategories ls_f
          JOIN subcategories sf ON sf.id = ls_f.subcategory_id
          WHERE ls_f.listing_id = l.id AND ${col} = $${params.length}
            AND sf.status = 'active' AND sf.is_active = true
        )`
      );
    }

    if (tier && ['level1', 'level2', 'level3'].includes(tier)) {
      params.push(tier);
      whereClauses.push(`u.subscription_tier = $${params.length}`);
    }

    if (verified_only === 'true') whereClauses.push('u.is_verified = true');

    if (search) {
      params.push(`%${search}%`);
      const p = params.length;
      whereClauses.push(
        `(l.business_name ILIKE $${p} OR l.description ILIKE $${p}
          OR EXISTS (
            SELECT 1 FROM listing_subcategories ls_s
            JOIN subcategories ss ON ss.id = ls_s.subcategory_id
            WHERE ls_s.listing_id = l.id AND ss.name ILIKE $${p} AND ss.status = 'active'
          ))`
      );
    }

    // Count query uses same WHERE clauses but without pagination params
    const countResult = await db.query(
      `SELECT COUNT(DISTINCT l.id) AS total
       FROM listings l
       LEFT JOIN users u ON u.id = l.user_id
       LEFT JOIN categories cat ON cat.id = l.category_id
       WHERE ${whereClauses.join(' AND ')}`,
      params
    );
    const total = parseInt(countResult.rows[0]?.total || 0, 10);

    params.push(parseInt(limit), parseInt(offset));
    const limitParam = params.length - 1;
    const offsetParam = params.length;

    const result = await db.query(
      `SELECT l.id, l.user_id, l.business_name, l.category, l.category_id, l.description, l.service_areas,
              l.subscription_status, l.verified_customers_only, l.created_at, l.logo_url,
              l.phone, l.whatsapp, l.is_public,
              u.full_name, u.is_verified, u.bridge_points, u.subscription_tier,
              u.verified_transaction_count,
              cat.name AS category_name, cat.slug AS category_slug,
              sub_p.name AS primary_subcategory_name, sub_p.slug AS primary_subcategory_slug,
              COALESCE(AVG(r.rating), 0) AS avg_rating,
              COUNT(DISTINCT r.id) AS review_count,
              (SELECT COUNT(*) FROM customer_dispute_flags WHERE provider_id = u.id AND status = 'open') AS dispute_count,
              ${SUBCATS_SUBQUERY},
              ${SPONSORED_SUBQUERY}
       FROM listings l
       LEFT JOIN users u ON u.id = l.user_id
       LEFT JOIN reviews r ON r.listing_id = l.id
       LEFT JOIN categories cat ON cat.id = l.category_id
       LEFT JOIN listing_subcategories ls_p ON ls_p.listing_id = l.id AND ls_p.is_primary = true
       LEFT JOIN subcategories sub_p ON sub_p.id = ls_p.subcategory_id AND sub_p.status = 'active'
       WHERE ${whereClauses.join(' AND ')}
       GROUP BY l.id, u.id, cat.id, sub_p.id
       ORDER BY
         CASE WHEN l.is_public THEN 1 ELSE 0 END ASC,
         is_sponsored DESC,
         CASE WHEN l.is_claimed = true THEN 0 ELSE 1 END ASC,
         CASE u.subscription_tier WHEN 'level3' THEN 1 WHEN 'level2' THEN 2 WHEN 'level1' THEN 3 ELSE 4 END,
         avg_rating DESC, review_count DESC
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      params
    );

    res.json({ listings: result.rows.map(mapListing), page: parseInt(page), limit: parseInt(limit), total });
  } catch (err) {
    next(err);
  }
});

// GET /listings/:id — public, full detail with all subcategories
router.get('/:id', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT l.*, u.full_name, u.email, u.is_verified, u.bridge_points, u.subscription_tier,
              u.verified_transaction_count,
              cat.name AS category_name, cat.slug AS category_slug,
              COALESCE(AVG(r.rating), 0) AS avg_rating,
              COUNT(DISTINCT r.id) AS review_count,
              (SELECT COUNT(*) FROM customer_dispute_flags WHERE provider_id = u.id AND status = 'open') AS dispute_count,
              COALESCE(
                (SELECT json_agg(t.obj ORDER BY t.is_primary DESC, t.display_order ASC)
                 FROM (
                   SELECT json_build_object('id', s.id, 'name', s.name, 'slug', s.slug, 'is_other', s.is_other) AS obj,
                          ls2.is_primary, s.display_order
                   FROM listing_subcategories ls2
                   JOIN subcategories s ON s.id = ls2.subcategory_id
                   WHERE ls2.listing_id = l.id AND s.status = 'active' AND s.is_active = true
                   ORDER BY ls2.is_primary DESC, s.display_order ASC
                 ) t),
                '[]'::json
              ) AS subcategories,
              COALESCE(
                (SELECT json_agg(json_build_object('id', v.id, 'video_url', v.video_url) ORDER BY v.display_order)
                 FROM listing_videos v WHERE v.listing_id = l.id),
                '[]'::json
              ) AS videos
       FROM listings l
       LEFT JOIN users u ON u.id = l.user_id
       LEFT JOIN reviews r ON r.listing_id = l.id
       LEFT JOIN categories cat ON cat.id = l.category_id
       LEFT JOIN listing_subcategories ls_p ON ls_p.listing_id = l.id AND ls_p.is_primary = true
       LEFT JOIN subcategories sub_p ON sub_p.id = ls_p.subcategory_id AND sub_p.status = 'active'
       WHERE l.id = $1 AND l.country_code = $2
       GROUP BY l.id, u.id, cat.id, sub_p.id`,
      [req.params.id, req.countryCode]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Listing not found' });

    const [reviews, addonsResult, productsResult] = await Promise.all([
      db.query(
        `SELECT r.*, u.full_name AS reviewer_name
         FROM reviews r JOIN users u ON u.id = r.reviewer_id
         WHERE r.listing_id = $1
         ORDER BY r.created_at DESC`,
        [req.params.id]
      ),
      db.query(
        `SELECT addon_type FROM listing_addons WHERE listing_id = $1 AND status = 'active'`,
        [req.params.id]
      ),
      db.query(
        `SELECT name, description, price, unit, category, in_stock, deal_price, deal_expires
         FROM business_products WHERE listing_id = $1 ORDER BY category, name`,
        [req.params.id]
      ),
    ]);

    const listing = mapListing(result.rows[0]);
    listing.addons = addonsResult.rows.map((r) => r.addon_type);
    listing.products = productsResult.rows;
    listing.first_impression_enabled = await isFirstImpressionEnabled();
    res.json({ listing, reviews: reviews.rows });
  } catch (err) {
    next(err);
  }
});

// POST /listings — provider creates listing with mandatory category + subcategory
router.post('/', ...requireRole('provider', 'admin'), checkProviderAccess, async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const existing = await client.query('SELECT id FROM listings WHERE user_id = $1 AND is_active = true', [req.user.id]);
    if (existing.rows.length && req.user.role !== 'admin' && req.user.role !== 'manager') {
      return res.status(409).json({ error: 'You already have a listing. One listing per user.' });
    }

    const { business_name, category: categoryVarchar, category_id, subcategory_id,
            custom_description, description, service_areas, business_reg_no, expires_at } = req.body;

    if (!business_name) return res.status(400).json({ error: 'business_name is required' });
    if (!category_id) return res.status(400).json({ error: 'category_id is required' });
    if (!subcategory_id) return res.status(400).json({ error: 'subcategory_id is required' });

    const userRow = await client.query('SELECT account_type FROM users WHERE id = $1', [req.user.id]);
    if (false) {
      return res.status(400).json({ error: 'business_reg_no is required for small business accounts' });
    }

    const catResult = await client.query(
      'SELECT id, name FROM categories WHERE id = $1 AND country_code = $2 AND is_active = true',
      [category_id, req.countryCode]
    );
    if (!catResult.rows.length) return res.status(400).json({ error: 'Category not found or inactive' });
    const categoryName = catResult.rows[0].name;

    const subResult = await client.query(
      'SELECT id, is_other, category_id FROM subcategories WHERE id = $1 AND status = $2 AND is_active = true',
      [subcategory_id, 'active']
    );
    if (!subResult.rows.length) return res.status(400).json({ error: 'Subcategory not found' });
    const sub = subResult.rows[0];
    if (sub.category_id !== category_id) {
      return res.status(400).json({ error: 'Subcategory does not belong to the selected category' });
    }

    await client.query('BEGIN');

    const listingResult = await client.query(
      `INSERT INTO listings
         (id, user_id, country_code, business_name, category, category_id, description, service_areas, business_reg_no, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [uuidv4(), req.user.id, req.countryCode, business_name,
       categoryVarchar || categoryName, category_id, description, service_areas || [], business_reg_no?.trim() || null,
       expires_at || null]
    );
    let listing = listingResult.rows[0];

    const { pending } = await linkSubcategory(
      client, listing.id, sub, true, custom_description, req.user.id, req.countryCode
    );

    // Merge any pre-saved provider_profiles data into the new listing
    const profileResult = await client.query(
      'SELECT * FROM provider_profiles WHERE user_id = $1',
      [req.user.id]
    );
    if (profileResult.rows.length) {
      const p = profileResult.rows[0];
      const merged = await client.query(
        `UPDATE listings SET
          phone           = COALESCE($1,  phone),
          whatsapp        = COALESCE($2,  whatsapp),
          website_url     = COALESCE($3,  website_url),
          business_hours  = COALESCE($4,  business_hours),
          facebook_url    = COALESCE($5,  facebook_url),
          instagram_url   = COALESCE($6,  instagram_url),
          twitter_url     = COALESCE($7,  twitter_url),
          linkedin_url    = COALESCE($8,  linkedin_url),
          tiktok_url      = COALESCE($9,  tiktok_url),
          youtube_url     = COALESCE($10, youtube_url),
          service_areas   = CASE WHEN $11::text[] IS NOT NULL AND array_length($11::text[], 1) > 0
                                 THEN $11::text[] ELSE service_areas END,
          payment_methods = COALESCE($12::jsonb, payment_methods)
        WHERE id = $13
        RETURNING *`,
        [
          p.phone, p.whatsapp, p.website_url, p.business_hours,
          p.facebook_url, p.instagram_url, p.twitter_url, p.linkedin_url,
          p.tiktok_url, p.youtube_url, p.service_areas, p.payment_methods,
          listing.id,
        ]
      );
      listing = merged.rows[0];
    }

    await client.query('COMMIT');

    const response = { listing };
    if (pending) {
      response.message = 'Your custom service type has been submitted for review. Your listing will show as Other in the meantime. You will be notified once approved.';
      response.subcategory_status = 'pending';
    }
    res.status(201).json(response);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Business registration number already exists in this country' });
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally {
    client.release();
  }
});

// PUT /listings/:id — provider updates listing; changing category clears subcategories
router.put('/:id', ...requireRole('provider', 'admin'), checkProviderAccess, async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const isAdmin = req.user.role === 'admin';
    const existing = await client.query(
      isAdmin
        ? 'SELECT id, category_id FROM listings WHERE id = $1 AND country_code = $2'
        : 'SELECT id, category_id FROM listings WHERE id = $1 AND user_id = $2 AND country_code = $3',
      isAdmin ? [req.params.id, req.countryCode] : [req.params.id, req.user.id, req.countryCode]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Listing not found' });

    const { business_name, category: categoryVarchar, category_id, subcategory_id,
            custom_description, description, service_areas,
            phone, whatsapp, website_url, business_hours, payment_methods,
            facebook_url, instagram_url, twitter_url, linkedin_url, tiktok_url, youtube_url,
            expires_at } = req.body;

    await client.query('BEGIN');

    let categoryChanged = false;
    let newCategoryName = null;
    if (category_id && category_id !== existing.rows[0].category_id) {
      const catResult = await client.query(
        'SELECT id, name FROM categories WHERE id = $1 AND country_code = $2 AND is_active = true',
        [category_id, req.countryCode]
      );
      if (!catResult.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Category not found or inactive' });
      }
      newCategoryName = catResult.rows[0].name;
      await client.query('DELETE FROM listing_subcategories WHERE listing_id = $1', [req.params.id]);
      categoryChanged = true;
    }

    const updated = await client.query(
      `UPDATE listings SET
         business_name   = COALESCE($1, business_name),
         category        = COALESCE($2, category),
         category_id     = COALESCE($3, category_id),
         description     = COALESCE($4, description),
         service_areas   = COALESCE($5, service_areas),
         phone           = COALESCE($6, phone),
         whatsapp        = COALESCE($7, whatsapp),
         website_url     = COALESCE($8, website_url),
         business_hours  = COALESCE($9, business_hours),
         payment_methods = COALESCE($10::jsonb, payment_methods),
         facebook_url    = COALESCE($11, facebook_url),
         instagram_url   = COALESCE($12, instagram_url),
         twitter_url     = COALESCE($13, twitter_url),
         linkedin_url    = COALESCE($14, linkedin_url),
         tiktok_url      = COALESCE($15, tiktok_url),
         youtube_url     = COALESCE($16, youtube_url),
         expires_at      = $17
       WHERE id = $18 RETURNING *`,
      [business_name, categoryVarchar || newCategoryName, category_id, description, service_areas,
       phone, whatsapp, website_url, business_hours,
       payment_methods ? JSON.stringify(payment_methods) : null,
       facebook_url, instagram_url, twitter_url, linkedin_url, tiktok_url, youtube_url,
       expires_at || null,
       req.params.id]
    );

    // If category changed and a new subcategory is provided, link it as primary
    if (categoryChanged && subcategory_id) {
      const subResult = await client.query(
        'SELECT id, is_other, category_id FROM subcategories WHERE id = $1 AND status = $2 AND is_active = true',
        [subcategory_id, 'active']
      );
      if (subResult.rows.length && subResult.rows[0].category_id === (category_id || existing.rows[0].category_id)) {
        await linkSubcategory(client, req.params.id, subResult.rows[0], true, custom_description, req.user.id, req.countryCode);
      }
    }

    await client.query('COMMIT');

    const response = { listing: updated.rows[0] };
    if (categoryChanged) {
      response.warning = 'Changing category removed your previous subcategories. Please re-select your services.';
    }
    res.json(response);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally {
    client.release();
  }
});

// PUT /listings/:id/preferences — provider sets verified_customers_only
router.put('/:id/preferences', ...requireRole('provider', 'admin'), async (req, res, next) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const exists = await db.query(
      isAdmin
        ? 'SELECT id FROM listings WHERE id = $1 AND country_code = $2'
        : 'SELECT id FROM listings WHERE id = $1 AND user_id = $2 AND country_code = $3',
      isAdmin ? [req.params.id, req.countryCode] : [req.params.id, req.user.id, req.countryCode]
    );
    if (!exists.rows.length) return res.status(404).json({ error: 'Listing not found' });

    const { verified_customers_only } = req.body;
    if (typeof verified_customers_only !== 'boolean') {
      return res.status(400).json({ error: 'verified_customers_only must be a boolean' });
    }

    const updated = await db.query(
      'UPDATE listings SET verified_customers_only = $1 WHERE id = $2 RETURNING *',
      [verified_customers_only, req.params.id]
    );
    res.json({ listing: updated.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /listings/:id/subcategories — add subcategory (tier limit enforced, Other flow handled)
router.post('/:id/subcategories', ...requireRole('provider', 'admin'), async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const isAdmin = req.user.role === 'admin';
    const listingResult = await client.query(
      isAdmin
        ? 'SELECT l.id, l.category_id FROM listings l WHERE l.id = $1 AND l.country_code = $2'
        : 'SELECT l.id, l.category_id FROM listings l WHERE l.id = $1 AND l.user_id = $2 AND l.country_code = $3',
      isAdmin ? [req.params.id, req.countryCode] : [req.params.id, req.user.id, req.countryCode]
    );
    if (!listingResult.rows.length) return res.status(404).json({ error: 'Listing not found' });
    const listing = listingResult.rows[0];

    const { subcategory_id, is_primary = false, custom_description } = req.body;
    if (!subcategory_id) return res.status(400).json({ error: 'subcategory_id is required' });

    // Tier limit check — admin bypasses
    let maxAllowed = null;
    if (!isAdmin) {
      const userResult = await client.query(
        'SELECT subscription_tier FROM users WHERE id = $1',
        [req.user.id]
      );
      const tier = userResult.rows[0]?.subscription_tier || 'free_period';
      maxAllowed = await getTierSubcategoryMax(tier);

      const currentCount = await client.query(
        'SELECT COUNT(*) FROM listing_subcategories WHERE listing_id = $1',
        [listing.id]
      );
      const count = parseInt(currentCount.rows[0].count, 10);

      if (count >= maxAllowed) {
        return res.status(403).json({
          error: 'You have reached the maximum subcategories for your plan. Upgrade to add more service categories.',
        });
      }
    }

    // Validate subcategory
    const subResult = await client.query(
      'SELECT id, is_other, category_id FROM subcategories WHERE id = $1 AND status = $2 AND is_active = true',
      [subcategory_id, 'active']
    );
    if (!subResult.rows.length) return res.status(404).json({ error: 'Subcategory not found' });
    const sub = subResult.rows[0];

    if (listing.category_id && sub.category_id !== listing.category_id) {
      return res.status(400).json({ error: 'Subcategory does not belong to the listing\'s category' });
    }

    await client.query('BEGIN');

    if (maxAllowed !== null) {
      await client.query('UPDATE listings SET max_subcategories = $1 WHERE id = $2', [maxAllowed, listing.id]);
    }

    const { pending } = await linkSubcategory(
      client, listing.id, sub, is_primary, custom_description, req.user.id, req.countryCode
    );

    await client.query('COMMIT');

    if (pending) {
      return res.status(201).json({
        message: 'Your custom service type has been submitted for review. Your listing will show as Other in the meantime. You will be notified once approved.',
        status: 'pending',
      });
    }

    res.status(201).json({ message: 'Subcategory added' });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ error: err.message });
    if (err.code === '23505') return res.status(409).json({ error: 'This subcategory is already on your listing' });
    next(err);
  } finally {
    client.release();
  }
});

// DELETE /listings/:id/subcategories/:subcategoryId — remove subcategory
router.delete('/:id/subcategories/:subcategoryId', ...requireRole('provider', 'admin'), async (req, res, next) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const ls = await db.query(
      isAdmin
        ? `SELECT ls.id, ls.is_primary
           FROM listing_subcategories ls
           JOIN listings l ON l.id = ls.listing_id
           WHERE ls.listing_id = $1 AND ls.subcategory_id = $2 AND l.country_code = $3`
        : `SELECT ls.id, ls.is_primary
           FROM listing_subcategories ls
           JOIN listings l ON l.id = ls.listing_id
           WHERE ls.listing_id = $1 AND ls.subcategory_id = $2
             AND l.user_id = $3 AND l.country_code = $4`,
      isAdmin
        ? [req.params.id, req.params.subcategoryId, req.countryCode]
        : [req.params.id, req.params.subcategoryId, req.user.id, req.countryCode]
    );
    if (!ls.rows.length) return res.status(404).json({ error: 'Subcategory not on this listing' });

    const total = await db.query(
      'SELECT COUNT(*) FROM listing_subcategories WHERE listing_id = $1',
      [req.params.id]
    );
    if (parseInt(total.rows[0].count, 10) <= 1) {
      return res.status(400).json({ error: 'Cannot remove the only subcategory. Add another one first.' });
    }
    if (ls.rows[0].is_primary) {
      return res.status(400).json({ error: 'Cannot remove primary subcategory. Set a different subcategory as primary first.' });
    }

    await db.query(
      'DELETE FROM listing_subcategories WHERE listing_id = $1 AND subcategory_id = $2',
      [req.params.id, req.params.subcategoryId]
    );
    res.json({ message: 'Subcategory removed' });
  } catch (err) {
    next(err);
  }
});

// PUT /listings/:id/subcategories/:subcategoryId/set-primary
router.put('/:id/subcategories/:subcategoryId/set-primary', ...requireRole('provider', 'admin'), async (req, res, next) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const ls = await db.query(
      isAdmin
        ? `SELECT ls.id
           FROM listing_subcategories ls
           JOIN listings l ON l.id = ls.listing_id
           WHERE ls.listing_id = $1 AND ls.subcategory_id = $2 AND l.country_code = $3`
        : `SELECT ls.id
           FROM listing_subcategories ls
           JOIN listings l ON l.id = ls.listing_id
           WHERE ls.listing_id = $1 AND ls.subcategory_id = $2
             AND l.user_id = $3 AND l.country_code = $4`,
      isAdmin
        ? [req.params.id, req.params.subcategoryId, req.countryCode]
        : [req.params.id, req.params.subcategoryId, req.user.id, req.countryCode]
    );
    if (!ls.rows.length) return res.status(404).json({ error: 'Subcategory not on this listing' });

    await db.query('UPDATE listing_subcategories SET is_primary = false WHERE listing_id = $1', [req.params.id]);
    await db.query(
      'UPDATE listing_subcategories SET is_primary = true WHERE listing_id = $1 AND subcategory_id = $2',
      [req.params.id, req.params.subcategoryId]
    );
    res.json({ message: 'Primary subcategory updated' });
  } catch (err) {
    next(err);
  }
});

// DELETE /listings/:id — deactivate
router.delete('/:id', ...requireRole('provider', 'admin'), async (req, res, next) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const result = await db.query(
      isAdmin
        ? 'UPDATE listings SET is_active = false WHERE id = $1 AND country_code = $2 RETURNING id'
        : 'UPDATE listings SET is_active = false WHERE id = $1 AND user_id = $2 AND country_code = $3 RETURNING id',
      isAdmin ? [req.params.id, req.countryCode] : [req.params.id, req.user.id, req.countryCode]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Listing not found' });
    res.json({ message: 'Listing deactivated' });
  } catch (err) {
    next(err);
  }
});

// POST /listings/:id/logo — upload provider logo
router.post('/:id/logo', ...requireRole('provider', 'admin'), memoryUpload.single('logo'), async (req, res, next) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const listing = await db.query(
      isAdmin
        ? 'SELECT id, logo_key FROM listings WHERE id = $1 AND country_code = $2'
        : 'SELECT id, logo_key FROM listings WHERE id = $1 AND user_id = $2 AND country_code = $3',
      isAdmin ? [req.params.id, req.countryCode] : [req.params.id, req.user.id, req.countryCode]
    );
    if (!listing.rows.length) return res.status(404).json({ error: 'Listing not found' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // Delete old logo if exists
    if (listing.rows[0].logo_key) {
      deleteObject(listing.rows[0].logo_key).catch(() => {});
    }

    const logoBuffer = await processLogo(req.file.buffer);
    const { key, url } = await uploadBuffer(logoBuffer, 'logos', '.webp', 'image/webp');

    const updated = await db.query(
      'UPDATE listings SET logo_url = $1, logo_key = $2 WHERE id = $3 RETURNING logo_url',
      [url, key, req.params.id]
    );

    res.json({ logo_url: updated.rows[0].logo_url });
  } catch (err) {
    next(err);
  }
});

// PATCH /listings/:id/first-impression — set/clear first impression YouTube URL + tier
router.patch('/:id/first-impression', ...requireRole('provider', 'admin'), async (req, res, next) => {
  try {
    const { youtube_url, duration_tier } = req.body;
    if (duration_tier !== undefined && !['15', '30'].includes(String(duration_tier))) {
      return res.status(400).json({ error: 'duration_tier must be 15 or 30' });
    }

    const isAdmin = req.user.role === 'admin';
    const listingRow = await db.query(
      isAdmin
        ? 'SELECT id, first_impression_url FROM listings WHERE id = $1'
        : 'SELECT id, first_impression_url FROM listings WHERE id = $1 AND user_id = $2',
      isAdmin ? [req.params.id] : [req.params.id, req.user.id]
    );
    if (!listingRow.rows.length) return res.status(404).json({ error: 'Listing not found' });

    if (!isAdmin) {
      const addon = await db.query(
        `SELECT 1 FROM listing_addons WHERE listing_id = $1 AND addon_type = 'first_impression' AND status = 'active'`,
        [req.params.id]
      );
      if (!addon.rows.length) return res.status(403).json({ error: 'First Impression addon required' });
    }

    // Delete old R2 object when clearing
    if (!youtube_url?.trim()) {
      const oldKey = keyFromUrl(listingRow.rows[0].first_impression_url || '');
      if (oldKey) deleteObject(oldKey).catch(() => {});
    }

    const updated = await db.query(
      `UPDATE listings SET first_impression_url = $1, first_impression_tier = $2 WHERE id = $3
       RETURNING first_impression_url, first_impression_tier`,
      [youtube_url?.trim() || null, String(duration_tier || '15'), req.params.id]
    );
    res.json({ first_impression_url: updated.rows[0].first_impression_url, first_impression_tier: updated.rows[0].first_impression_tier });
  } catch (err) { next(err); }
});

// POST /listings/:id/first-impression/upload — R2 direct MP4 upload
router.post('/:id/first-impression/upload', ...requireRole('provider', 'admin'), videoUpload.single('video'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No video file provided' });
    if (req.file.size > 50 * 1024 * 1024) return res.status(400).json({ error: 'Video must be under 50MB' });

    const duration_tier = ['15', '30'].includes(String(req.body.duration_tier)) ? String(req.body.duration_tier) : '15';
    const isAdmin = req.user.role === 'admin';

    const listingRow = await db.query(
      isAdmin
        ? 'SELECT id, first_impression_url FROM listings WHERE id = $1'
        : 'SELECT id, first_impression_url FROM listings WHERE id = $1 AND user_id = $2',
      isAdmin ? [req.params.id] : [req.params.id, req.user.id]
    );
    if (!listingRow.rows.length) return res.status(404).json({ error: 'Listing not found' });

    if (!isAdmin) {
      const addon = await db.query(
        `SELECT 1 FROM listing_addons WHERE listing_id = $1 AND addon_type = 'first_impression' AND status = 'active'`,
        [req.params.id]
      );
      if (!addon.rows.length) return res.status(403).json({ error: 'First Impression addon required' });
    }

    // Delete previous R2 object (fire-and-forget; ignore if it was a YouTube URL or missing)
    const oldKey = keyFromUrl(listingRow.rows[0].first_impression_url || '');
    if (oldKey) deleteObject(oldKey).catch(() => {});

    const { url } = await uploadBuffer(req.file.buffer, 'first-impression', '.mp4', 'video/mp4');

    const updated = await db.query(
      `UPDATE listings SET first_impression_url = $1, first_impression_tier = $2 WHERE id = $3
       RETURNING first_impression_url, first_impression_tier`,
      [url, duration_tier, req.params.id]
    );
    res.json({
      first_impression_url: updated.rows[0].first_impression_url,
      first_impression_tier: updated.rows[0].first_impression_tier,
    });
  } catch (err) { next(err); }
});

// DELETE /listings/:id/logo — remove provider logo
router.delete('/:id/logo', ...requireRole('provider', 'admin'), async (req, res, next) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const listing = await db.query(
      isAdmin
        ? 'SELECT id, logo_key FROM listings WHERE id = $1 AND country_code = $2'
        : 'SELECT id, logo_key FROM listings WHERE id = $1 AND user_id = $2 AND country_code = $3',
      isAdmin ? [req.params.id, req.countryCode] : [req.params.id, req.user.id, req.countryCode]
    );
    if (!listing.rows.length) return res.status(404).json({ error: 'Listing not found' });

    if (listing.rows[0].logo_key) {
      deleteObject(listing.rows[0].logo_key).catch(() => {});
    }

    await db.query('UPDATE listings SET logo_url = NULL, logo_key = NULL WHERE id = $1', [req.params.id]);
    res.json({ message: 'Logo removed' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
