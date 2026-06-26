const { analyzeProductImage, analyzeListingImage, moderateImage, extractText } = require('../services/geminiService');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('../db');
const { requireRole, requireAuth } = require('../middleware/auth');

const productUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ok = /\.(csv|xlsx|xls)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only CSV or Excel files are accepted'), ok);
  },
});

function parseProductRows(workbook) {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  const products = [];
  for (const row of rows) {
    const r = {};
    for (const k of Object.keys(row)) r[k.toLowerCase().trim().replace(/\s+/g, '_')] = row[k];
    const name = String(r.name || r.product_name || r.item || '').trim();
    if (!name) continue;
    const rawPrice = String(r.price || r.cost || r.amount || '').replace(/[^0-9.]/g, '');
    const price = rawPrice ? parseFloat(rawPrice) : null;
    const inStockRaw = r.in_stock ?? r.instock ?? r.stock ?? r.available;
    const inStock = inStockRaw === undefined || inStockRaw === null || inStockRaw === ''
      ? true
      : !['false', 'no', '0'].includes(String(inStockRaw).trim().toLowerCase());
    products.push({
      name,
      description: String(r.description || r.desc || r.details || '').trim() || null,
      price: price !== null && !isNaN(price) ? price : null,
      unit: String(r.unit || r.uom || '').trim() || null,
      category: String(r.category || r.type || r.group || '').trim() || null,
      in_stock: inStock,
    });
  }
  return products;
}
const { invalidate: invalidateSettings, getSubscriptionPrice } = require('../services/platformSettings');
const { calculateReputationScore } = require('../services/customerReputationService');
const { awardValidReportPoints, wipeUserPoints } = require('../services/points');
const { notify } = require('../services/notificationService');
const { sendVerificationResult, sendSuspensionNotice } = require('../services/emailService');
const slugify = require('../utils/slugify');
const { REGISTRY, invalidateMarketCache } = require('../config/countries');

const router = express.Router();

// ── Platform settings schema + seed ──────────────────────────────────────────
db.query('ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS updated_by UUID')
  .catch(() => {});

db.query(`
  INSERT INTO platform_settings (key, value, updated_at)
  VALUES
    ('ads_enabled',               'false', NOW()),
    ('sponsored_listings_enabled','false', NOW()),
    ('points_enabled',            'true',  NOW()),
    ('free_period_active',        'true',  NOW()),
    ('first_impression_enabled',  'true',  NOW()),
    ('connek_enabled',            'false', NOW())
  ON CONFLICT (key) DO NOTHING
`).catch(() => {});

const TOGGLE_SETTINGS_KEYS = ['ads_enabled', 'sponsored_listings_enabled', 'points_enabled', 'free_period_active', 'first_impression_enabled', 'connek_enabled'];

async function auditLog(adminId, action, targetId, detail) {
  await db.query(
    'INSERT INTO admin_audit_log (id, admin_id, action, target_id, detail) VALUES ($1,$2,$3,$4,$5)',
    [uuidv4(), adminId, action, targetId || null, detail || null]
  );
}

// GET /admin/verifications/:id/document — serve ID document securely (admin only)
router.get('/verifications/:id/document', ...requireRole('admin'), async (req, res, next) => {
  try {
    const result = await db.query(
      'SELECT id_doc_url FROM id_verifications WHERE id = $1',
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });

    const docUrl = result.rows[0].id_doc_url;
    const filePath = path.join('/var/www/bridgepro', docUrl);

    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

    res.sendFile(filePath);
  } catch (err) { next(err); }
});

// GET /admin/verifications — pending queue
router.get('/verifications', ...requireRole('admin'), async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT v.*, u.email, u.full_name, u.phone
       FROM id_verifications v JOIN users u ON u.id = v.user_id
       WHERE v.country_code = $1 AND v.status = 'pending'
       ORDER BY v.created_at ASC`,
      [req.countryCode]
    );
    res.json({ verifications: result.rows });
  } catch (err) {
    next(err);
  }
});

// PUT /admin/verifications/:id — approve or reject
router.put('/verifications/:id', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { status, rejection_reason } = req.body;
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'status must be "approved" or "rejected"' });
    }

    const verif = await db.query(
      'SELECT * FROM id_verifications WHERE id = $1 AND country_code = $2',
      [req.params.id, req.countryCode]
    );
    if (!verif.rows.length) return res.status(404).json({ error: 'Verification not found' });

    const v = verif.rows[0];

    await db.query(
      `UPDATE id_verifications SET status = $1, reviewed_by = $2, reviewed_at = NOW(), rejection_reason = $3
       WHERE id = $4`,
      [status, req.user.id, rejection_reason || null, v.id]
    );

    if (status === 'approved') {
      await db.query('UPDATE users SET is_verified = true, verified_at = NOW() WHERE id = $1', [v.user_id]);
      notify(v.user_id, 'verify_approved', '✅ ID Verified', 'Your identity has been verified. Your listing now shows a Verified badge.', { url: '/dashboard' });
      const uRow = await db.query('SELECT email, full_name FROM users WHERE id = $1', [v.user_id]);
      if (uRow.rows[0]) sendVerificationResult(uRow.rows[0].email, uRow.rows[0].full_name, true, null).catch(() => {});
    } else {
      notify(v.user_id, 'verify_rejected', '❌ ID Verification Failed', rejection_reason ? `Reason: ${rejection_reason}` : 'Your ID could not be verified. Please re-submit with a clear photo.', { url: '/verify' });
      const uRow = await db.query('SELECT email, full_name FROM users WHERE id = $1', [v.user_id]);
      if (uRow.rows[0]) sendVerificationResult(uRow.rows[0].email, uRow.rows[0].full_name, false, rejection_reason).catch(() => {});
    }

    await auditLog(req.user.id, `id_verification_${status}`, v.id, rejection_reason || null);

    res.json({ message: `Verification ${status}` });
  } catch (err) {
    next(err);
  }
});

// GET /admin/flagged — accounts sharing address/phone/business_reg_no
router.get('/flagged', ...requireRole('admin'), async (req, res, next) => {
  try {
    const phoneCluster = await db.query(
      `SELECT phone, array_agg(id) AS user_ids, array_agg(email) AS emails, COUNT(*) AS count
       FROM users WHERE country_code = $1 AND phone IS NOT NULL
       GROUP BY phone HAVING COUNT(*) > 1`,
      [req.countryCode]
    );

    const brnCluster = await db.query(
      `SELECT business_reg_no, array_agg(user_id) AS user_ids, COUNT(*) AS count
       FROM listings WHERE country_code = $1 AND business_reg_no IS NOT NULL
       GROUP BY business_reg_no HAVING COUNT(*) > 1`,
      [req.countryCode]
    );

    res.json({
      shared_phone: phoneCluster.rows,
      shared_business_reg: brnCluster.rows,
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/users — list all users in country
router.get('/users', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    const result = await db.query(
      `SELECT u.id, u.email, u.full_name, u.phone, u.role, u.account_type, u.is_verified, u.bridge_points,
              u.subscription_status, u.subscription_tier, u.verified_transaction_count, u.created_at,
              u.is_suspended, u.suspended_reason, u.is_flagged, u.flag_reason, u.is_partner,
              u.subscription_end_date, u.last_seen_at,
              COALESCE(u.founder_status, true) AS founder_status,
              COALESCE(u.tier, 'PRO') AS tier,
              (u.is_online AND u.last_seen_at > NOW() - INTERVAL '3 minutes') AS is_online,
              l.id AS listing_id, l.business_name, l.is_active AS listing_is_active, l.subscription_tier AS listing_tier
       FROM users u
       LEFT JOIN listings l ON l.user_id = u.id AND l.country_code = u.country_code
       WHERE u.country_code = $1
       ORDER BY u.is_flagged DESC, u.is_suspended DESC, u.created_at DESC LIMIT $2 OFFSET $3`,
      [req.countryCode, parseInt(limit), parseInt(offset)]
    );
    res.json({ users: result.rows });
  } catch (err) {
    next(err);
  }
});

// PUT /admin/users/:id/role — promote/demote with full cascade
router.put('/users/:id/role', ...requireRole('admin'), async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const { role } = req.body;
    if (!['provider', 'customer', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const current = await client.query(
      'SELECT role FROM users WHERE id = $1 AND country_code = $2',
      [req.params.id, req.countryCode]
    );
    if (!current.rows.length) return res.status(404).json({ error: 'User not found' });
    const previousRole = current.rows[0].role;

    await client.query('BEGIN');

    if (role === 'provider') {
      // Customer/admin → provider: enter free period, reactivate listing if one exists
      await client.query(
        `UPDATE users SET role = $1,
           subscription_status = 'free_period',
           subscription_tier   = 'free_period',
           subscription_start_date = NULL,
           subscription_end_date   = NULL
         WHERE id = $2`,
        [role, req.params.id]
      );
      // Reactivate their listing if it was deactivated by a prior demotion
      await client.query(
        `UPDATE listings SET is_active = true
         WHERE user_id = $1 AND is_active = false`,
        [req.params.id]
      );
    } else {
      // Provider/admin → customer: hide listing, cancel addons, clear subscription
      await client.query(
        `UPDATE users SET role = $1,
           subscription_status     = 'active',
           subscription_tier       = 'free_period',
           subscription_start_date = NULL,
           subscription_end_date   = NULL
         WHERE id = $2`,
        [role, req.params.id]
      );
      // Deactivate their listing so it disappears from search
      await client.query(
        `UPDATE listings SET is_active = false WHERE user_id = $1`,
        [req.params.id]
      );
      // Cancel all active addons on that listing
      await client.query(
        `UPDATE listing_addons SET status = 'cancelled', cancelled_at = NOW()
         WHERE listing_id IN (SELECT id FROM listings WHERE user_id = $1)
           AND status = 'active'`,
        [req.params.id]
      );
    }

    await client.query('COMMIT');
    await auditLog(req.user.id, 'user_role_change', req.params.id, `${previousRole} → ${role}`);
    res.json({ message: `Role changed from ${previousRole} to ${role}` });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// PATCH /admin/users/:id/role — simple role assignment (customer/provider/partner), no cascade
router.patch('/users/:id/role', ...requireRole('admin'), async (req, res, next) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(403).json({ error: 'You cannot change your own role' });
    }

    const { role } = req.body;
    if (!['customer', 'provider', 'partner'].includes(role)) {
      return res.status(400).json({ error: 'Role must be one of: customer, provider, partner' });
    }

    const current = await db.query(
      'SELECT id, full_name, role, is_partner FROM users WHERE id = $1 AND country_code = $2',
      [req.params.id, req.countryCode]
    );
    if (!current.rows.length) return res.status(404).json({ error: 'User not found' });

    let result;
    if (role === 'partner') {
      result = await db.query(
        'UPDATE users SET is_partner = true WHERE id = $1 RETURNING id, full_name, role, is_partner',
        [req.params.id]
      );
    } else {
      result = await db.query(
        'UPDATE users SET role = $1 WHERE id = $2 RETURNING id, full_name, role, is_partner',
        [role, req.params.id]
      );
    }

    const u = result.rows[0];
    await auditLog(req.user.id, 'user_role_change', req.params.id, `${current.rows[0].role} → ${role}`);
    res.json({ message: `${u.full_name} updated to ${role}`, user: u });
  } catch (err) {
    next(err);
  }
});

// PUT /admin/users/:id/suspend — suspend or unsuspend a user
router.put('/users/:id/suspend', ...requireRole('admin'), async (req, res, next) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'Cannot suspend your own account' });
    }

    const { suspended, reason } = req.body;
    const newState = suspended === true;

    const userResult = await db.query(
      'SELECT id, email, full_name, role, subscription_status FROM users WHERE id = $1 AND country_code = $2',
      [req.params.id, req.countryCode]
    );
    if (!userResult.rows.length) return res.status(404).json({ error: 'User not found' });
    const u = userResult.rows[0];

    await db.query(
      `UPDATE users SET is_suspended = $1, suspended_at = $2, suspended_reason = $3 WHERE id = $4`,
      [newState, newState ? new Date() : null, newState ? (reason || null) : null, req.params.id]
    );

    if (newState) {
      await db.query('UPDATE listings SET is_active = false WHERE user_id = $1', [req.params.id]);
    } else if (u.role === 'provider' && ['active', 'free_period'].includes(u.subscription_status)) {
      await db.query('UPDATE listings SET is_active = true WHERE user_id = $1', [req.params.id]);
    }

    if (newState) sendSuspensionNotice(u.email, u.full_name, reason).catch(() => {});
    await auditLog(req.user.id, newState ? 'user_suspended' : 'user_unsuspended', req.params.id, reason || null);
    res.json({ message: newState ? `${u.full_name} suspended` : `${u.full_name} unsuspended`, suspended: newState });
  } catch (err) { next(err); }
});

// PUT /admin/users/:id/flag — flag or unflag an account for review
router.put('/users/:id/flag', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { flagged, reason } = req.body;
    const newState = flagged === true;

    const userResult = await db.query(
      'SELECT id, email, full_name FROM users WHERE id = $1 AND country_code = $2',
      [req.params.id, req.countryCode]
    );
    if (!userResult.rows.length) return res.status(404).json({ error: 'User not found' });
    const u = userResult.rows[0];

    await db.query(
      `UPDATE users SET is_flagged = $1, flag_reason = $2, flagged_at = $3 WHERE id = $4`,
      [newState, newState ? (reason || null) : null, newState ? new Date() : null, req.params.id]
    );

    if (newState) {
      notify(
        req.params.id,
        'verify_rejected',
        '⚠️ Account Notice',
        reason
          ? `Your account has been flagged: ${reason}. Please contact support to resolve this.`
          : 'Your account requires attention. Please contact support.',
        { url: '/dashboard' }
      );
    }

    await auditLog(req.user.id, newState ? 'user_flagged' : 'user_unflagged', req.params.id, reason || null);
    res.json({ message: newState ? `${u.full_name} flagged` : `${u.full_name} flag cleared`, flagged: newState });
  } catch (err) { next(err); }
});

// DELETE /admin/users/:id — permanently delete a user account
router.delete('/users/:id', ...requireRole('admin'), async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    const userResult = await client.query(
      'SELECT id, email, full_name, role FROM users WHERE id = $1 AND country_code = $2',
      [req.params.id, req.countryCode]
    );
    if (!userResult.rows.length) return res.status(404).json({ error: 'User not found' });
    const u = userResult.rows[0];

    if (u.role === 'admin') {
      return res.status(400).json({ error: 'Cannot delete admin accounts' });
    }

    await client.query('BEGIN');

    // Nullify non-cascade FK references pointing at this user
    await client.query('UPDATE transactions SET provider_id = NULL WHERE provider_id = $1', [req.params.id]);
    await client.query('UPDATE transactions SET customer_id = NULL WHERE customer_id = $1', [req.params.id]);
    await client.query('UPDATE reviews SET reviewer_id = NULL WHERE reviewer_id = $1', [req.params.id]);
    await client.query('UPDATE id_verifications SET reviewed_by = NULL WHERE reviewed_by = $1', [req.params.id]);
    await client.query('UPDATE admin_audit_log SET admin_id = NULL WHERE admin_id = $1', [req.params.id]);
    await client.query('UPDATE enquiries SET customer_id = NULL WHERE customer_id = $1', [req.params.id]);
    await client.query('UPDATE enquiries SET provider_id = NULL WHERE provider_id = $1', [req.params.id]);
    await client.query('UPDATE reports SET reviewed_by = NULL WHERE reviewed_by = $1', [req.params.id]);
    await client.query('UPDATE customer_id_verifications SET reviewed_by = NULL WHERE reviewed_by = $1', [req.params.id]);
    await client.query('UPDATE customer_dispute_flags SET customer_id = NULL WHERE customer_id = $1', [req.params.id]);
    await client.query('UPDATE customer_dispute_flags SET provider_id = NULL WHERE provider_id = $1', [req.params.id]);
    await client.query('UPDATE listing_photos SET uploaded_by = NULL WHERE uploaded_by = $1', [req.params.id]);
    await client.query('UPDATE subcategories SET submitted_by = NULL WHERE submitted_by = $1', [req.params.id]);
    await client.query('UPDATE subcategories SET reviewed_by = NULL WHERE reviewed_by = $1', [req.params.id]);
    await client.query('UPDATE users SET referred_by = NULL WHERE referred_by = $1', [req.params.id]);
    await client.query('UPDATE point_redemption_tokens SET redeemed_by = NULL WHERE redeemed_by = $1', [req.params.id]);
    await client.query('UPDATE reviews SET listing_id = NULL WHERE listing_id IN (SELECT id FROM listings WHERE user_id = $1)', [req.params.id]);

    // Delete records owned solely by this user (no cascade on these FKs)
    await client.query('DELETE FROM bridge_points_log WHERE user_id = $1', [req.params.id]);
    await client.query('DELETE FROM id_verifications WHERE user_id = $1', [req.params.id]);
    await client.query('DELETE FROM customer_id_verifications WHERE user_id = $1', [req.params.id]);
    await client.query('DELETE FROM point_redemptions WHERE user_id = $1', [req.params.id]);
    await client.query('DELETE FROM provider_tier_history WHERE user_id = $1', [req.params.id]);

    // Delete the user — cascades to listings, notifications, job_listings, job_interests,
    // point_redemption_tokens, reports (reporter_id)
    await client.query('DELETE FROM users WHERE id = $1', [req.params.id]);

    await client.query('COMMIT');
    await auditLog(req.user.id, 'user_deleted', req.params.id, `${u.email} (${u.role})`);
    res.json({ message: `${u.full_name} (${u.email}) deleted` });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// GET /admin/settings — all platform feature flags
router.get('/settings', ...requireRole('admin'), async (req, res, next) => {
  try {
    const result = await db.query(
      'SELECT key, value, updated_at, updated_by FROM platform_settings ORDER BY key'
    );
    res.json({ settings: result.rows });
  } catch (err) { next(err); }
});

// PATCH /admin/settings/:key — update a feature flag (boolean only)
router.patch('/settings/:key', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { key } = req.params;
    if (!TOGGLE_SETTINGS_KEYS.includes(key)) {
      return res.status(400).json({ error: `Unknown or non-editable setting: ${key}` });
    }
    const { value } = req.body;
    if (value !== 'true' && value !== 'false') {
      return res.status(400).json({ error: 'value must be "true" or "false"' });
    }
    await db.query(
      `INSERT INTO platform_settings (key, value, updated_at, updated_by)
       VALUES ($1, $2, NOW(), $3)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW(), updated_by = $3`,
      [key, value, req.user.id]
    );
    invalidateSettings();
    await auditLog(req.user.id, 'setting_changed', null, `${key} → ${value}`);
    res.json({ key, value });
  } catch (err) { next(err); }
});

// GET /admin/settings/public — connek_enabled flag for any authenticated user
router.get('/settings/public', requireAuth, async (req, res, next) => {
  try {
    const r = await db.query("SELECT value FROM platform_settings WHERE key = 'connek_enabled'");
    res.json({ connek_enabled: r.rows[0]?.value === 'true' });
  } catch (err) { next(err); }
});

// GET /admin/platform-status — free period state + key platform stats
router.get('/platform-status', ...requireRole('admin'), async (req, res, next) => {
  try {
    const [settingsRes, statsRes] = await Promise.all([
      db.query("SELECT key, value FROM platform_settings WHERE key IN ('free_period_active', 'points_enabled', 'point_value_cents', 'sponsored_listings_enabled')"),
      db.query(
        `SELECT
           COUNT(*) FILTER (WHERE role = 'provider') AS total_providers,
           COUNT(*) FILTER (WHERE role = 'customer') AS total_customers,
           COUNT(*) FILTER (WHERE role = 'provider' AND subscription_status = 'active') AS active_providers,
           COUNT(*) FILTER (WHERE role = 'provider' AND subscription_status = 'free_period') AS free_period_providers,
           COUNT(*) FILTER (WHERE is_verified = true) AS verified_users,
           COALESCE(SUM(bridge_points), 0) AS total_points_in_circulation
         FROM users WHERE country_code = $1`,
        [req.countryCode]
      ),
    ]);

    const txRes = await db.query(
      `SELECT
         COUNT(*) AS total_transactions,
         COUNT(*) FILTER (WHERE is_verified = true) AS verified_transactions,
         COUNT(DISTINCT provider_id) FILTER (WHERE is_verified = true) AS providers_with_verified_tx,
         COUNT(DISTINCT customer_id) FILTER (WHERE is_verified = true) AS customers_with_verified_tx
       FROM transactions WHERE country_code = $1`,
      [req.countryCode]
    );

    const byKey = {};
    settingsRes.rows.forEach((r) => { byKey[r.key] = r.value; });

    const freePeriodActive = byKey.free_period_active !== undefined
      ? byKey.free_period_active === 'true'
      : process.env.FREE_PERIOD_ACTIVE !== 'false';
    const pointsEnabled = byKey.points_enabled !== undefined ? byKey.points_enabled === 'true' : true;
    const pointValueCents = parseFloat(byKey.point_value_cents) || 1.0;
    const sponsoredEnabled = byKey.sponsored_listings_enabled === 'true';

    res.json({
      free_period_active: freePeriodActive,
      points_enabled: pointsEnabled,
      point_value_cents: pointValueCents,
      sponsored_listings_enabled: sponsoredEnabled,
      stats: { ...statsRes.rows[0], ...txRes.rows[0] },
    });
  } catch (err) {
    next(err);
  }
});

// POST /admin/end-free-period — flip global free period off and close unpaid addons
router.post('/end-free-period', ...requireRole('admin'), async (req, res, next) => {
  try {
    await db.query(
      `INSERT INTO platform_settings (key, value, updated_at) VALUES ('free_period_active', 'false', NOW())
       ON CONFLICT (key) DO UPDATE SET value = 'false', updated_at = NOW()`
    );
    invalidateSettings();

    // Cancel photo_gallery and item_display for all providers who never paid (still on free_period tier)
    const cancelled = await db.query(
      `UPDATE listing_addons SET status = 'cancelled', cancelled_at = NOW()
       WHERE addon_type IN ('photo_gallery', 'item_display')
         AND status = 'active'
         AND listing_id IN (
           SELECT l.id FROM listings l
           JOIN users u ON u.id = l.user_id
           WHERE u.subscription_tier = 'free_period'
             AND l.country_code = $1
         )`,
      [req.countryCode]
    );
    const addondsClosed = cancelled.rowCount || 0;

    const count = await db.query(
      `SELECT COUNT(*) FROM users WHERE role = 'provider' AND subscription_status = 'free_period' AND country_code = $1`,
      [req.countryCode]
    );
    const total = parseInt(count.rows[0].count);

    await auditLog(req.user.id, 'end_free_period', null, `${total} providers still on free_period; ${addondsClosed} addons closed`);
    res.json({ message: 'Free period ended globally', providers_on_free_period: total, addons_closed: addondsClosed });
  } catch (err) {
    next(err);
  }
});

// POST /admin/start-free-period — re-enable the global free period
router.post('/start-free-period', ...requireRole('admin'), async (req, res, next) => {
  try {
    await db.query(
      `INSERT INTO platform_settings (key, value, updated_at) VALUES ('free_period_active', 'true', NOW())
       ON CONFLICT (key) DO UPDATE SET value = 'true', updated_at = NOW()`
    );
    invalidateSettings();
    await auditLog(req.user.id, 'start_free_period', null, 'Free period re-enabled by admin');
    res.json({ message: 'Free period re-enabled globally' });
  } catch (err) {
    next(err);
  }
});

// POST /admin/toggle-points — enable or disable the points system globally
router.post('/toggle-points', ...requireRole('admin'), async (req, res, next) => {
  try {
    const current = await db.query("SELECT value FROM platform_settings WHERE key = 'points_enabled'");
    const currentlyEnabled = current.rows.length ? current.rows[0].value === 'true' : true;
    const newValue = !currentlyEnabled;

    await db.query(
      `INSERT INTO platform_settings (key, value, updated_at) VALUES ('points_enabled', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [newValue ? 'true' : 'false']
    );
    invalidateSettings();
    await auditLog(req.user.id, newValue ? 'points_enabled' : 'points_disabled', null, null);
    res.json({ points_enabled: newValue, message: `Points system ${newValue ? 'enabled' : 'disabled'}` });
  } catch (err) {
    next(err);
  }
});

// POST /admin/toggle-sponsored — enable or disable self-serve sponsored listings
router.post('/toggle-sponsored', ...requireRole('admin'), async (req, res, next) => {
  try {
    const current = await db.query("SELECT value FROM platform_settings WHERE key = 'sponsored_listings_enabled'");
    const currentlyEnabled = current.rows.length ? current.rows[0].value === 'true' : false;
    const newValue = !currentlyEnabled;

    await db.query(
      `INSERT INTO platform_settings (key, value, updated_at) VALUES ('sponsored_listings_enabled', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [newValue ? 'true' : 'false']
    );
    invalidateSettings();
    await auditLog(req.user.id, newValue ? 'sponsored_enabled' : 'sponsored_disabled', null, null);
    res.json({ sponsored_listings_enabled: newValue, message: `Sponsored listings ${newValue ? 'enabled' : 'disabled'}` });
  } catch (err) {
    next(err);
  }
});

// GET /admin/expansion-config — list all 13 islands with live status
router.get('/expansion-config', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT code, domain_slug, display_name, is_live, currency, flag, theme_color, updated_at FROM countries ORDER BY is_live DESC, code ASC'
    );
    res.json({ countries: rows });
  } catch (err) { next(err); }
});

// POST /admin/set-island-status — explicitly set a country live or offline
router.post('/set-island-status', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { code, is_live } = req.body;
    if (!code || typeof is_live !== 'boolean') {
      return res.status(400).json({ error: 'code (string) and is_live (boolean) are required' });
    }
    const upper = code.toUpperCase();
    if (upper === 'SVG') {
      return res.status(400).json({ error: 'SVG is permanently live — flagship protection is active' });
    }
    if (!REGISTRY[upper]) {
      return res.status(400).json({ error: `Unknown country code: ${upper}` });
    }
    const { rows } = await db.query(
      'UPDATE countries SET is_live = $1, updated_at = NOW() WHERE code = $2 RETURNING *',
      [is_live, upper]
    );
    if (!rows.length) return res.status(404).json({ error: 'Country not found in expansion table' });
    invalidateMarketCache();
    await auditLog(req.user.id, is_live ? 'market_launched' : 'market_offline', null, `${upper} → ${is_live ? 'LIVE' : 'OFFLINE'} via expansion engine`);
    res.json({
      code: upper,
      name: rows[0].display_name,
      domain_slug: rows[0].domain_slug,
      is_live,
      message: `${rows[0].display_name} is now ${is_live ? 'LIVE 🚀' : 'OFFLINE'}`,
    });
  } catch (err) { next(err); }
});

// POST /admin/toggle-market — bring a country market live or take it offline
// (kept for backward compatibility — now writes to countries table)
router.post('/toggle-market', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { countryCode, isLive } = req.body;
    if (!countryCode || typeof isLive !== 'boolean') {
      return res.status(400).json({ error: 'countryCode (string) and isLive (boolean) are required' });
    }
    const upper = countryCode.toUpperCase();
    if (upper === 'SVG') {
      return res.status(400).json({ error: 'SVG market is permanently live — flagship protection is active' });
    }
    if (!REGISTRY[upper]) {
      return res.status(400).json({ error: `Unknown country code: ${upper}` });
    }
    const { rows } = await db.query(
      'UPDATE countries SET is_live = $1, updated_at = NOW() WHERE code = $2 RETURNING display_name, domain_slug',
      [isLive, upper]
    );
    if (!rows.length) return res.status(404).json({ error: 'Country not found — run the migration script first' });
    invalidateMarketCache();
    await auditLog(req.user.id, isLive ? 'market_launched' : 'market_offline', null, `${upper} → ${isLive ? 'LIVE' : 'OFFLINE'}`);
    res.json({
      countryCode: upper,
      name: rows[0].display_name,
      domainSlug: rows[0].domain_slug,
      isLive,
      message: `${rows[0].display_name} is now ${isLive ? 'LIVE 🚀' : 'OFFLINE'}`,
    });
  } catch (err) { next(err); }
});

// POST /admin/set-point-value — set how many cents each point is worth (e.g. 2.0 = 50 pts/$1, 1.0 = 100 pts/$1)
router.post('/set-point-value', ...requireRole('admin'), async (req, res, next) => {
  try {
    const cents = parseFloat(req.body.point_value_cents);
    if (!cents || cents <= 0 || cents > 100) {
      return res.status(400).json({ error: 'point_value_cents must be a positive number between 0.01 and 100' });
    }

    await db.query(
      `INSERT INTO platform_settings (key, value, updated_at) VALUES ('point_value_cents', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [cents.toString()]
    );
    invalidateSettings();
    const ptsPerDollar = Math.round(100 / cents);
    await auditLog(req.user.id, 'point_value_changed', null, `${cents} cents/pt (${ptsPerDollar} pts = $1)`);
    res.json({ point_value_cents: cents, pts_per_dollar: ptsPerDollar });
  } catch (err) {
    next(err);
  }
});

// POST /admin/notify-providers — set 30-day countdown for all free_period providers
router.post('/notify-providers', ...requireRole('admin'), async (req, res, next) => {
  try {
    const result = await db.query(
      `UPDATE users
       SET subscription_end_date = NOW() + INTERVAL '30 days',
           free_period_active = false
       WHERE role = 'provider'
         AND subscription_status = 'free_period'
         AND country_code = $1
       RETURNING id, email, full_name`,
      [req.countryCode]
    );

    result.rows.forEach((p) => {
      console.log(
        `[NOTIFY] ${p.email} — BridgePro free period is ending. ` +
        `Subscribe for $5/month to keep your listing active. You have 30 days.`
      );
    });

    await auditLog(req.user.id, 'notify_providers', null, `Notified ${result.rows.length} providers`);
    res.json({
      message: `${result.rows.length} providers notified`,
      providers: result.rows.map((p) => ({ id: p.id, email: p.email, name: p.full_name })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /admin/activate-provider/:userId — manual activation after payment confirmed
router.post('/activate-provider/:userId', ...requireRole('admin'), async (req, res, next) => {
  try {
    const userCheck = await db.query(
      'SELECT id, account_type, subscription_tier FROM users WHERE id = $1 AND country_code = $2',
      [req.params.userId, req.countryCode]
    );
    if (!userCheck.rows.length) return res.status(404).json({ error: 'Provider not found' });

    const { account_type, subscription_tier } = userCheck.rows[0];
    const expectedMonthlyPrice = await getSubscriptionPrice(account_type, subscription_tier);

    const result = await db.query(
      `UPDATE users
       SET subscription_status = 'active',
           subscription_start_date = NOW(),
           subscription_end_date = NOW() + INTERVAL '30 days',
           free_period_active = false
       WHERE id = $1 AND country_code = $2
       RETURNING id, email, full_name, account_type, subscription_status, subscription_tier,
                 subscription_start_date, subscription_end_date`,
      [req.params.userId, req.countryCode]
    );

    await auditLog(
      req.user.id,
      'activate_provider',
      req.params.userId,
      `Manual activation after payment. account_type=${account_type}, expected_monthly_price=$${expectedMonthlyPrice}`
    );
    res.json({ message: 'Provider activated', user: result.rows[0], expected_monthly_price: expectedMonthlyPrice });
  } catch (err) {
    next(err);
  }
});

// GET /admin/redemptions — list all point redemptions with user details
router.get('/redemptions', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    const params = [req.countryCode];
    let where = 'WHERE pr.country_code = $1';

    if (status) {
      params.push(status);
      where += ` AND pr.status = $${params.length}`;
    }

    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(
      `SELECT pr.id, pr.points_redeemed, pr.dollar_value, pr.status, pr.billing_month,
              pr.created_at, pr.applied_at,
              u.email, u.full_name, u.subscription_tier
       FROM point_redemptions pr
       JOIN users u ON u.id = pr.user_id
       ${where}
       ORDER BY pr.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const countParams = [req.countryCode];
    let countWhere = 'WHERE pr.country_code = $1';
    if (status) {
      countParams.push(status);
      countWhere += ` AND pr.status = $${countParams.length}`;
    }
    const countResult = await db.query(
      `SELECT COUNT(*) FROM point_redemptions pr ${countWhere}`,
      countParams
    );

    res.json({
      redemptions: result.rows,
      page: parseInt(page),
      limit: parseInt(limit),
      total: parseInt(countResult.rows[0].count, 10),
    });
  } catch (err) {
    next(err);
  }
});

// PUT /admin/redemptions/:id — apply or reject a redemption
router.put('/redemptions/:id', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!['applied', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'status must be "applied" or "rejected"' });
    }

    const redemptionResult = await db.query(
      'SELECT * FROM point_redemptions WHERE id = $1 AND country_code = $2',
      [req.params.id, req.countryCode]
    );
    if (!redemptionResult.rows.length) {
      return res.status(404).json({ error: 'Redemption not found' });
    }

    const redemption = redemptionResult.rows[0];

    if (status === 'applied') {
      await db.query(
        `UPDATE point_redemptions SET status = 'applied', applied_at = NOW() WHERE id = $1`,
        [redemption.id]
      );
    } else if (status === 'rejected') {
      await db.query(
        `UPDATE point_redemptions SET status = 'rejected' WHERE id = $1`,
        [redemption.id]
      );

      // Reverse the deduction: insert a positive log entry and restore points
      const farFuture = '9999-12-31 00:00:00';
      await db.query(
        `INSERT INTO bridge_points_log
           (id, user_id, country_code, event_type, points_awarded, reference_id, expires_at, reference_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          uuidv4(),
          redemption.user_id,
          redemption.country_code,
          'redemption_reversed',
          redemption.points_redeemed,
          redemption.id,
          farFuture,
          'redemption',
        ]
      );

      await db.query(
        'UPDATE users SET bridge_points = GREATEST(0, bridge_points + $1) WHERE id = $2',
        [redemption.points_redeemed, redemption.user_id]
      );
    }

    await auditLog(
      req.user.id,
      `redemption_${status}`,
      redemption.id,
      `${status} redemption of ${redemption.points_redeemed} pts for billing month ${redemption.billing_month}`
    );

    res.json({ message: `Redemption ${status}`, redemption_id: redemption.id });
  } catch (err) {
    next(err);
  }
});

// POST /admin/provider/set-tier/:userId — manually set a provider's subscription tier
router.post('/provider/set-tier/:userId', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { tier, reason } = req.body;
    const validTiers = ['level1', 'level2', 'level3'];
    if (!validTiers.includes(tier)) {
      return res.status(400).json({ error: `tier must be one of: ${validTiers.join(', ')}` });
    }

    const userResult = await db.query(
      'SELECT id, subscription_tier, role FROM users WHERE id = $1 AND country_code = $2',
      [req.params.userId, req.countryCode]
    );
    if (!userResult.rows.length) {
      return res.status(404).json({ error: 'Provider not found' });
    }

    const user = userResult.rows[0];
    const previousTier = user.subscription_tier || 'free_period';

    // Record tier history
    await db.query(
      `INSERT INTO provider_tier_history (id, user_id, previous_tier, new_tier, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [uuidv4(), user.id, previousTier, tier, reason || 'admin_set']
    );

    // Update user tier
    const updated = await db.query(
      `UPDATE users
       SET subscription_tier = $1, tier_upgraded_at = NOW()
       WHERE id = $2
       RETURNING id, email, full_name, subscription_tier, tier_upgraded_at`,
      [tier, user.id]
    );

    await auditLog(
      req.user.id,
      'provider_tier_set',
      user.id,
      `Tier changed from ${previousTier} to ${tier}. Reason: ${reason || 'none'}`
    );

    res.json({ message: `Provider tier set to ${tier}`, user: updated.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /admin/customer-verifications — pending customer ID verification queue
router.get('/customer-verifications', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { status = 'pending' } = req.query;
    const validStatuses = ['pending', 'approved', 'rejected'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'status must be pending, approved, or rejected' });
    }

    const result = await db.query(
      `SELECT v.*, u.email, u.full_name, u.phone, u.customer_verified
       FROM customer_id_verifications v JOIN users u ON u.id = v.user_id
       WHERE v.country_code = $1 AND v.status = $2
       ORDER BY v.created_at ASC`,
      [req.countryCode, status]
    );
    res.json({ verifications: result.rows });
  } catch (err) {
    next(err);
  }
});

// PUT /admin/customer-verifications/:id — approve or reject
router.put('/customer-verifications/:id', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { status, rejection_reason } = req.body;
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'status must be "approved" or "rejected"' });
    }

    const verif = await db.query(
      'SELECT * FROM customer_id_verifications WHERE id = $1 AND country_code = $2',
      [req.params.id, req.countryCode]
    );
    if (!verif.rows.length) return res.status(404).json({ error: 'Verification not found' });

    const v = verif.rows[0];

    await db.query(
      `UPDATE customer_id_verifications
       SET status = $1, reviewed_by = $2, reviewed_at = NOW(), rejection_reason = $3
       WHERE id = $4`,
      [status, req.user.id, rejection_reason || null, v.id]
    );

    if (status === 'approved') {
      await db.query(
        'UPDATE users SET customer_verified = true, customer_verified_at = NOW() WHERE id = $1',
        [v.user_id]
      );
      calculateReputationScore(v.user_id).catch((err) => console.error('[REPUTATION]', err.message));

      // id_verified_bonus: 10 pts one-time for completing customer ID verification
      const bonusExisting = await db.query(
        `SELECT id FROM bridge_points_log WHERE user_id = $1 AND event_type = 'id_verified_bonus'`,
        [v.user_id]
      );
      if (!bonusExisting.rows.length) {
        await db.query(
          `INSERT INTO bridge_points_log
             (id, user_id, country_code, event_type, points_awarded, reference_id, expires_at, reference_type)
           VALUES ($1, $2, $3, $4, $5, $6, '9999-12-31', $7)`,
          [uuidv4(), v.user_id, req.countryCode, 'id_verified_bonus', 10, v.id, 'verification']
        );
        await db.query(
          'UPDATE users SET bridge_points = GREATEST(0, bridge_points + 10) WHERE id = $1',
          [v.user_id]
        );
      }

      notify(v.user_id, 'verify_approved', '✅ ID Verified', 'Your identity has been verified — you earned 10 Bridge Points! Providers can now see your Verified badge.', { url: '/dashboard' });
    } else {
      notify(v.user_id, 'verify_rejected', '❌ ID Verification Failed', rejection_reason ? `Reason: ${rejection_reason}` : 'Your ID could not be verified. Please re-submit with a clear photo.', { url: '/verify' });
    }

    await auditLog(req.user.id, `customer_verification_${status}`, v.id, rejection_reason || null);

    res.json({ message: `Verification ${status}` });
  } catch (err) {
    next(err);
  }
});

// GET /admin/disputes — all disputes with full details
router.get('/disputes', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { status } = req.query;
    const params = [req.countryCode];
    let where = 'WHERE d.country_code = $1';

    if (status) {
      params.push(status);
      where += ` AND d.status = $${params.length}`;
    }

    const result = await db.query(
      `SELECT d.*,
              t.amount, t.is_verified AS transaction_verified, t.created_at AS transaction_created_at,
              c.full_name AS customer_name, c.email AS customer_email, c.customer_verified,
              p.full_name AS provider_name, p.email AS provider_email
       FROM customer_dispute_flags d
       JOIN transactions t ON t.id = d.transaction_id
       JOIN users c ON c.id = d.customer_id
       JOIN users p ON p.id = d.provider_id
       ${where}
       ORDER BY d.created_at DESC`,
      params
    );

    res.json({ disputes: result.rows });
  } catch (err) {
    next(err);
  }
});

// PUT /admin/disputes/:id — resolve or dismiss
router.put('/disputes/:id', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { status, notes } = req.body;
    if (!['resolved', 'dismissed'].includes(status)) {
      return res.status(400).json({ error: 'status must be "resolved" or "dismissed"' });
    }

    const dispute = await db.query(
      'SELECT * FROM customer_dispute_flags WHERE id = $1 AND country_code = $2',
      [req.params.id, req.countryCode]
    );
    if (!dispute.rows.length) return res.status(404).json({ error: 'Dispute not found' });

    const d = dispute.rows[0];

    await db.query(
      `UPDATE customer_dispute_flags
       SET status = $1, resolved_at = NOW()
       WHERE id = $2`,
      [status, d.id]
    );

    if (status === 'dismissed') {
      // Dismissed = no fault found, clear dispute_flagged
      await db.query('UPDATE transactions SET dispute_flagged = false WHERE id = $1', [d.transaction_id]);
    }

    // Recalculate customer reputation on any resolution
    calculateReputationScore(d.customer_id).catch((err) => console.error('[REPUTATION]', err.message));

    await auditLog(req.user.id, `dispute_${status}`, d.id, notes || null);

    res.json({ message: `Dispute ${status}` });
  } catch (err) {
    next(err);
  }
});

// GET /admin/flagged-transactions — transactions flagged for fraud
router.get('/flagged-transactions', ...requireRole('admin'), async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT t.id, t.amount, t.verification_method, t.created_at, t.receipt_uploaded_at,
              p.id AS provider_id, p.full_name AS provider_name, p.email AS provider_email,
              c.id AS customer_id, c.full_name AS customer_name, c.email AS customer_email
       FROM transactions t
       JOIN users p ON p.id = t.provider_id
       JOIN users c ON c.id = t.customer_id
       WHERE t.fraud_flag = true AND t.country_code = $1
       ORDER BY t.created_at DESC`,
      [req.countryCode]
    );

    res.json({ flagged_transactions: result.rows });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════
// CATEGORY MANAGEMENT
// ═══════════════════════════════════════

// GET /admin/categories — all categories including inactive, with subcategory counts
router.get('/categories', ...requireRole('admin'), async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT c.id, c.name, c.slug, c.icon, c.is_active, c.display_order, c.created_at,
              COUNT(s.id) FILTER (WHERE s.status = 'active') AS active_subcategory_count,
              COUNT(s.id) FILTER (WHERE s.status = 'pending') AS pending_subcategory_count,
              COUNT(s.id) FILTER (WHERE s.status = 'rejected') AS rejected_subcategory_count
       FROM categories c
       LEFT JOIN subcategories s ON s.category_id = c.id
       WHERE c.country_code = $1
       GROUP BY c.id
       ORDER BY c.display_order ASC`,
      [req.countryCode]
    );
    res.json({ categories: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /admin/categories — create new category (auto-creates 'Other' subcategory)
router.post('/categories', ...requireRole('admin'), async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const { name, icon, country_code, display_order } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const countryCode = country_code || req.countryCode;
    const slug = slugify(name);

    const nextOrder = display_order != null ? display_order : (
      await client.query('SELECT COALESCE(MAX(display_order), -1) + 1 AS next FROM categories WHERE country_code = $1', [countryCode])
    ).rows[0].next;

    await client.query('BEGIN');

    const catResult = await client.query(
      `INSERT INTO categories (id, name, slug, icon, country_code, display_order)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [uuidv4(), name, slug, icon || null, countryCode, nextOrder]
    );
    const cat = catResult.rows[0];

    // Auto-create 'Other' subcategory for the new category
    await client.query(
      `INSERT INTO subcategories (id, category_id, name, slug, is_other, status, country_code, display_order)
       VALUES ($1, $2, 'Other', 'other', true, 'active', $3, 999)`,
      [uuidv4(), cat.id, countryCode]
    );

    await client.query('COMMIT');
    await auditLog(req.user.id, 'category_created', cat.id, name);
    res.status(201).json({ category: cat });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'A category with this slug already exists for this country' });
    next(err);
  } finally {
    client.release();
  }
});

// PUT /admin/categories/:id — update category
router.put('/categories/:id', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { name, icon, display_order, is_active } = req.body;

    const existing = await db.query(
      'SELECT id FROM categories WHERE id = $1 AND country_code = $2',
      [req.params.id, req.countryCode]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Category not found' });

    const updated = await db.query(
      `UPDATE categories SET
         name = COALESCE($1, name),
         icon = COALESCE($2, icon),
         display_order = COALESCE($3, display_order),
         is_active = COALESCE($4, is_active),
         updated_at = NOW()
       WHERE id = $5 RETURNING *`,
      [name, icon, display_order, is_active, req.params.id]
    );

    await auditLog(req.user.id, 'category_updated', req.params.id, JSON.stringify({ name, is_active }));
    res.json({ category: updated.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /admin/categories/:id — soft delete (cannot delete if listings exist)
router.delete('/categories/:id', ...requireRole('admin'), async (req, res, next) => {
  try {
    const existing = await db.query(
      'SELECT id FROM categories WHERE id = $1 AND country_code = $2',
      [req.params.id, req.countryCode]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Category not found' });

    const listingCount = await db.query(
      'SELECT COUNT(*) FROM listings WHERE category_id = $1 AND is_active = true',
      [req.params.id]
    );
    const count = parseInt(listingCount.rows[0].count, 10);
    if (count > 0) {
      return res.status(400).json({
        error: `Cannot deactivate category with ${count} active listing(s). Reassign them first.`,
        active_listing_count: count,
      });
    }

    await db.query(
      'UPDATE categories SET is_active = false, updated_at = NOW() WHERE id = $1',
      [req.params.id]
    );
    await auditLog(req.user.id, 'category_deactivated', req.params.id, null);
    res.json({ message: 'Category deactivated' });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════
// SUBCATEGORY MANAGEMENT
// ═══════════════════════════════════════

// GET /admin/subcategories/pending — pending custom submissions (must be before /:id)
router.get('/subcategories/pending', ...requireRole('admin'), async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT s.id, s.name, s.slug, s.created_at, s.category_id,
              c.name AS category_name,
              u.full_name AS submitted_by_name, u.email AS submitted_by_email,
              COUNT(ls.id) AS listings_waiting
       FROM subcategories s
       JOIN categories c ON c.id = s.category_id
       LEFT JOIN users u ON u.id = s.submitted_by
       LEFT JOIN listing_subcategories ls ON ls.pending_custom_subcategory_id = s.id
       WHERE s.status = 'pending' AND s.country_code = $1
       GROUP BY s.id, c.name, u.full_name, u.email
       ORDER BY s.created_at ASC`,
      [req.countryCode]
    );
    res.json({ pending: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /admin/subcategories — all subcategories with optional filters
router.get('/subcategories', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { status, category_id } = req.query;
    const params = [req.countryCode];
    let where = 's.country_code = $1';

    if (status) {
      params.push(status);
      where += ` AND s.status = $${params.length}`;
    }
    if (category_id) {
      params.push(category_id);
      where += ` AND s.category_id = $${params.length}`;
    }

    const result = await db.query(
      `SELECT s.*, c.name AS category_name,
              u.full_name AS submitted_by_name
       FROM subcategories s
       JOIN categories c ON c.id = s.category_id
       LEFT JOIN users u ON u.id = s.submitted_by
       WHERE ${where}
       ORDER BY s.status ASC, s.display_order ASC`,
      params
    );
    res.json({ subcategories: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /admin/subcategories — manually create a subcategory
router.post('/subcategories', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { category_id, name, display_order, country_code } = req.body;
    if (!category_id || !name) return res.status(400).json({ error: 'category_id and name are required' });

    const countryCode = country_code || req.countryCode;
    const catResult = await db.query(
      'SELECT id FROM categories WHERE id = $1 AND country_code = $2',
      [category_id, countryCode]
    );
    if (!catResult.rows.length) return res.status(404).json({ error: 'Category not found' });

    const slug = slugify(name);
    const nextOrder = display_order != null ? display_order : (
      await db.query('SELECT COALESCE(MAX(display_order), -1) + 1 AS next FROM subcategories WHERE category_id = $1', [category_id])
    ).rows[0].next;

    const result = await db.query(
      `INSERT INTO subcategories (id, category_id, name, slug, status, country_code, display_order)
       VALUES ($1, $2, $3, $4, 'active', $5, $6) RETURNING *`,
      [uuidv4(), category_id, name, slug, countryCode, nextOrder]
    );

    await auditLog(req.user.id, 'subcategory_created', result.rows[0].id, name);
    res.status(201).json({ subcategory: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A subcategory with this name/slug already exists in this category' });
    next(err);
  }
});

// PUT /admin/subcategories/:id — update subcategory (name, display_order, is_active)
router.put('/subcategories/:id', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { name, display_order, is_active } = req.body;

    const existing = await db.query('SELECT id FROM subcategories WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Subcategory not found' });

    const updated = await db.query(
      `UPDATE subcategories SET
         name = COALESCE($1, name),
         display_order = COALESCE($2, display_order),
         is_active = COALESCE($3, is_active),
         updated_at = NOW()
       WHERE id = $4 RETURNING *`,
      [name, display_order, is_active, req.params.id]
    );

    await auditLog(req.user.id, 'subcategory_updated', req.params.id, JSON.stringify({ name, is_active }));
    res.json({ subcategory: updated.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PUT /admin/subcategories/:id/review — approve or reject a pending custom submission
router.put('/subcategories/:id/review', ...requireRole('admin'), async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const { status, rejection_reason } = req.body;
    if (!['active', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'status must be "active" or "rejected"' });
    }

    const subResult = await client.query(
      'SELECT * FROM subcategories WHERE id = $1 AND status = $2',
      [req.params.id, 'pending']
    );
    if (!subResult.rows.length) return res.status(404).json({ error: 'Pending subcategory not found' });
    const sub = subResult.rows[0];

    await client.query('BEGIN');

    if (status === 'active') {
      await client.query(
        `UPDATE subcategories
         SET status = 'active', reviewed_by = $1, reviewed_at = NOW(), updated_at = NOW()
         WHERE id = $2`,
        [req.user.id, sub.id]
      );

      // Update all listing_subcategories that were waiting on this custom submission
      const affected = await client.query(
        `SELECT ls.id, ls.listing_id
         FROM listing_subcategories ls
         WHERE ls.pending_custom_subcategory_id = $1`,
        [sub.id]
      );

      for (const row of affected.rows) {
        // Check if this listing already has the approved subcategory (edge case)
        const dup = await client.query(
          'SELECT id FROM listing_subcategories WHERE listing_id = $1 AND subcategory_id = $2',
          [row.listing_id, sub.id]
        );
        if (!dup.rows.length) {
          await client.query(
            `UPDATE listing_subcategories
             SET subcategory_id = $1, pending_custom_subcategory_id = NULL
             WHERE id = $2`,
            [sub.id, row.id]
          );
        } else {
          // Duplicate would exist — just clear the pending reference
          await client.query(
            'DELETE FROM listing_subcategories WHERE id = $1',
            [row.id]
          );
        }
        console.log(`[SUBCATEGORY] Custom subcategory "${sub.name}" approved. Listing ${row.listing_id} updated.`);
      }

      // Notify provider (log for now)
      const providerResult = await client.query(
        'SELECT submitted_by FROM subcategories WHERE id = $1',
        [sub.id]
      );
      if (providerResult.rows[0]?.submitted_by) {
        console.log(`[SUBCATEGORY] Provider ${providerResult.rows[0].submitted_by}: Your custom service category "${sub.name}" has been approved. Your listing has been updated.`);
      }
    } else {
      // Rejected
      await client.query(
        `UPDATE subcategories
         SET status = 'rejected', reviewed_by = $1, reviewed_at = NOW(),
             rejection_reason = $2, updated_at = NOW()
         WHERE id = $3`,
        [req.user.id, rejection_reason || null, sub.id]
      );

      // Clear pending references — listings keep the base 'Other' subcategory
      await client.query(
        'UPDATE listing_subcategories SET pending_custom_subcategory_id = NULL WHERE pending_custom_subcategory_id = $1',
        [sub.id]
      );

      if (sub.submitted_by) {
        console.log(`[SUBCATEGORY] Provider ${sub.submitted_by}: Your custom service category "${sub.name}" was not approved. Reason: ${rejection_reason || 'none'}. Your listing remains under Other.`);
      }
    }

    await client.query('COMMIT');
    await auditLog(req.user.id, `subcategory_review_${status}`, sub.id, rejection_reason || null);
    res.json({ message: `Subcategory ${status === 'active' ? 'approved' : 'rejected'}` });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// PUT /admin/users/:id/partner — grant or revoke partner account status
router.put('/users/:id/partner', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { is_partner } = req.body;
    const newState = is_partner === true;

    const userResult = await db.query(
      'SELECT id, full_name FROM users WHERE id = $1 AND country_code = $2',
      [req.params.id, req.countryCode]
    );
    if (!userResult.rows.length) return res.status(404).json({ error: 'User not found' });

    const u = userResult.rows[0];
    await db.query('UPDATE users SET is_partner = $1 WHERE id = $2', [newState, req.params.id]);
    await auditLog(req.user.id, newState ? 'partner_granted' : 'partner_revoked', req.params.id, null);

    // Auto-create a draft store so the partner immediately shows up in the store directory
    if (newState) {
      const existing = await db.query(
        'SELECT id FROM partner_stores WHERE owner_user_id = $1 AND country_code = $2',
        [req.params.id, req.countryCode]
      );
      if (!existing.rows.length) {
        await db.query(
          `INSERT INTO partner_stores (id, country_code, name, points_per_dollar, min_redemption, owner_user_id, is_active)
           VALUES ($1, $2, $3, 100, 100, $4, false)`,
          [uuidv4(), req.countryCode, u.full_name, req.params.id]
        );
      }
    }

    res.json({ message: newState ? `${u.full_name} granted partner access` : `${u.full_name} partner access revoked`, is_partner: newState });
  } catch (err) { next(err); }
});

// GET /admin/jobs — all job listings (all types, all statuses) for admin oversight
router.get('/jobs', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { type, active } = req.query;
    const params = [req.countryCode];
    let where = 'j.country_code = $1';

    if (type === 'hire_me' || type === 'hiring') {
      params.push(type);
      where += ` AND j.listing_type = $${params.length}`;
    }
    if (active === 'true')       where += ' AND j.is_active = true';
    else if (active === 'false') where += ' AND j.is_active = false';

    const result = await db.query(
      `SELECT j.*, u.full_name, u.email, u.role,
              c.name AS category_name, c.icon AS category_icon,
              (SELECT COUNT(*) FROM job_interests ji WHERE ji.job_id = j.id) AS interest_count
       FROM job_listings j
       JOIN users u ON u.id = j.user_id
       LEFT JOIN categories c ON c.id = j.category_id
       WHERE ${where}
       ORDER BY j.created_at DESC
       LIMIT 200`,
      params
    );

    const summary = {
      total:    result.rows.length,
      hiring:   result.rows.filter(j => j.listing_type !== 'hire_me').length,
      hire_me:  result.rows.filter(j => j.listing_type === 'hire_me').length,
      active:   result.rows.filter(j => j.is_active).length,
      inactive: result.rows.filter(j => !j.is_active).length,
    };

    res.json({ jobs: result.rows, summary });
  } catch (err) { next(err); }
});

// DELETE /admin/jobs/:id — remove a job listing
router.delete('/jobs/:id', ...requireRole('admin'), async (req, res, next) => {
  try {
    const result = await db.query(
      'DELETE FROM job_listings WHERE id = $1 AND country_code = $2 RETURNING id, title',
      [req.params.id, req.countryCode]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Job listing not found' });
    await auditLog(req.user.id, 'job_deleted', req.params.id, result.rows[0].title);
    res.json({ message: 'Job listing removed' });
  } catch (err) { next(err); }
});

// DELETE /admin/listings/:id — deactivate a service listing
// POST /admin/users/:id/grant-addon — grant any addon to a provider by user_id
router.post('/users/:id/grant-addon', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { addon_type } = req.body;
    if (!addon_type) return res.status(400).json({ error: 'addon_type is required' });
    const listing = await db.query(
      'SELECT id FROM listings WHERE user_id = $1 AND country_code = $2',
      [req.params.id, req.countryCode]
    );
    if (!listing.rows.length) return res.status(404).json({ error: 'No listing found for this user' });
    await db.query(
      `INSERT INTO listing_addons (id, listing_id, country_code, addon_type, status)
       VALUES ($1, $2, $3, $4, 'active')
       ON CONFLICT (listing_id, addon_type)
       DO UPDATE SET status = 'active', activated_at = NOW(), cancelled_at = NULL`,
      [uuidv4(), listing.rows[0].id, req.countryCode, addon_type]
    );
    await auditLog(req.user.id, 'addon_granted', req.params.id, addon_type);
    res.json({ message: `${addon_type} granted` });
  } catch (err) { next(err); }
});

router.delete('/listings/:id', ...requireRole('admin'), async (req, res, next) => {
  try {
    const result = await db.query(
      `UPDATE listings SET is_active = false
       WHERE id = $1 AND country_code = $2
       RETURNING id, business_name, user_id`,
      [req.params.id, req.countryCode]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Listing not found' });
    const l = result.rows[0];
    notify(l.user_id, 'listing_removed', '&#128683; Listing Removed',
      `Your listing "${l.business_name}" was removed by a platform administrator.`,
      { url: '/dashboard' });
    await auditLog(req.user.id, 'listing_removed', l.id, l.business_name);
    res.json({ message: 'Listing removed' });
  } catch (err) { next(err); }
});

// GET /admin/reports — view submitted reports
router.get('/reports', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { status = 'pending' } = req.query;
    const result = await db.query(
      `SELECT r.*,
              u.full_name AS reporter_name, u.email AS reporter_email,
              CASE r.target_type
                WHEN 'listing' THEN (SELECT l.business_name FROM listings l WHERE l.id = r.target_id)
                WHEN 'job'     THEN (SELECT j.title FROM job_listings j WHERE j.id = r.target_id)
              END AS target_name,
              CASE r.target_type
                WHEN 'listing' THEN (SELECT u2.full_name FROM listings l JOIN users u2 ON u2.id = l.user_id WHERE l.id = r.target_id)
                WHEN 'job'     THEN (SELECT u2.full_name FROM job_listings j JOIN users u2 ON u2.id = j.user_id WHERE j.id = r.target_id)
              END AS target_owner
       FROM reports r
       JOIN users u ON u.id = r.reporter_id
       WHERE r.country_code = $1 AND r.status = $2
       ORDER BY r.created_at DESC
       LIMIT 100`,
      [req.countryCode, status]
    );
    res.json({ reports: result.rows });
  } catch (err) { next(err); }
});

// PUT /admin/reports/:id — resolve or dismiss a report
router.put('/reports/:id', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { action, admin_note } = req.body;
    if (!['resolved', 'dismissed'].includes(action)) {
      return res.status(400).json({ error: 'action must be resolved or dismissed' });
    }
    const result = await db.query(
      `UPDATE reports SET status = $1, admin_note = $2, reviewed_by = $3, reviewed_at = NOW()
       WHERE id = $4 AND country_code = $5 RETURNING *`,
      [action, admin_note || null, req.user.id, req.params.id, req.countryCode]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Report not found' });
    await auditLog(req.user.id, `report_${action}`, req.params.id, admin_note || null);

    // Award reporter 5 pts when report is confirmed valid
    if (action === 'resolved') {
      const report = result.rows[0];
      awardValidReportPoints(report.id, report.reporter_id, req.countryCode).catch(() => {});
    }

    res.json({ message: `Report ${action}` });
  } catch (err) { next(err); }
});

// POST /admin/users/:id/reset-password — set user password to temp "1234"
router.post('/users/:id/reset-password', ...requireRole('admin'), async (req, res, next) => {
  try {
    const hash = await bcrypt.hash('1234', 12);
    const result = await db.query(
      `UPDATE users SET password_hash = $1, failed_login_attempts = 0, locked_until = NULL,
         password_reset_token = NULL, password_reset_expires = NULL
       WHERE id = $2 RETURNING full_name`,
      [hash, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    await auditLog(req.user.id, 'password_reset', req.params.id, 'Admin reset password to temp');
    res.json({ message: `Password reset to 1234 for ${result.rows[0].full_name}` });
  } catch (err) { next(err); }
});

// POST /admin/users/:id/wipe-points — silently zero a user's points as a penalty
router.post('/users/:id/wipe-points', ...requireRole('admin'), async (req, res, next) => {
  try {
    await wipeUserPoints(req.params.id);
    await auditLog(req.user.id, 'points_wiped', req.params.id, 'Admin penalty: points wiped');
    res.json({ message: 'Points wiped' });
  } catch (err) { next(err); }
});

// POST /admin/users/:id/set-points — manually correct a user's point balance
router.post('/users/:id/set-points', ...requireRole('admin'), async (req, res, next) => {
  try {
    const points = parseInt(req.body.points, 10);
    if (isNaN(points) || points < 0) {
      return res.status(400).json({ error: 'points must be a non-negative integer' });
    }

    const userResult = await db.query(
      'SELECT id, full_name, bridge_points FROM users WHERE id = $1 AND country_code = $2',
      [req.params.id, req.countryCode]
    );
    if (!userResult.rows.length) return res.status(404).json({ error: 'User not found' });
    const u = userResult.rows[0];

    await db.query('UPDATE users SET bridge_points = $1 WHERE id = $2', [points, req.params.id]);
    await db.query(
      `INSERT INTO bridge_points_log (id, user_id, country_code, event_type, points_awarded, expires_at)
       VALUES ($1, $2, $3, 'admin_adjustment', $4, '9999-12-31')`,
      [uuidv4(), req.params.id, req.countryCode, points - u.bridge_points]
    );
    await auditLog(req.user.id, 'points_adjusted', req.params.id, `${u.bridge_points} → ${points}`);
    res.json({ message: `${u.full_name}'s points set to ${points}`, bridge_points: points });
  } catch (err) { next(err); }
});

// PUT /admin/listings/:id/tier — set subscription tier on a listing
router.put('/listings/:id/tier', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { tier } = req.body;
    const valid = ['free_period', 'level1', 'level2', 'level3'];
    if (!valid.includes(tier)) return res.status(400).json({ error: 'Invalid tier' });
    const result = await db.query(
      'UPDATE listings SET subscription_tier = $1 WHERE id = $2 AND country_code = $3 RETURNING id',
      [tier, req.params.id, req.countryCode]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Listing not found' });
    res.json({ message: 'Subscription tier updated' });
  } catch (err) {
    next(err);
  }
});

// GET /admin/listings/pending — retrieve all listings pending approval
router.get('/listings/pending', ...requireRole('admin'), async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT l.id, l.business_name, l.description, l.created_at,
              c.name AS category_name, u.full_name AS provider_name
       FROM listings l
       LEFT JOIN categories c ON c.id = l.category_id
       JOIN users u ON u.id = l.user_id
       WHERE l.is_active = false AND l.country_code = $1
       ORDER BY l.created_at DESC`,
      [req.countryCode]
    );
    res.json({ listings: result.rows });
  } catch (err) { next(err); }
});

// PUT /admin/listings/:id/status — approve or reject a pending listing
router.put('/listings/:id/status', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { is_active, reason } = req.body;
    if (typeof is_active !== 'boolean') return res.status(400).json({ error: 'is_active (boolean) is required' });
    const listing = await db.query(
      'SELECT id, user_id, business_name FROM listings WHERE id = $1',
      [req.params.id]
    );
    if (!listing.rows.length) return res.status(404).json({ error: 'Listing not found' });
    await db.query('UPDATE listings SET is_active = $1, updated_at = NOW() WHERE id = $2', [is_active, req.params.id]);
    const { user_id, business_name } = listing.rows[0];
    const msg = is_active
      ? `Your listing "${business_name}" has been approved and is now live.`
      : `Your listing "${business_name}" was not approved${reason ? ': ' + reason : ''}. Please update your details and resubmit.`;
    notify(user_id, is_active ? 'listing_approved' : 'listing_rejected',
      is_active ? '✅ Listing Approved' : '❌ Listing Not Approved', msg, { url: '/dashboard' }).catch(() => {});
    await auditLog(req.user.id, is_active ? 'listing_approved' : 'listing_rejected', req.params.id, reason || '');
    res.json({ success: true, listing_id: req.params.id, is_active });
  } catch (err) { next(err); }
});

// GET /admin/listings/search?q= — search listings by business name for admin product management
router.get('/listings/search', ...requireRole('admin'), async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ listings: [] });
    const result = await db.query(
      `SELECT l.id, l.business_name, l.phone,
              c.name AS category_name,
              u.email,
              (SELECT COUNT(*) FROM business_products bp WHERE bp.listing_id = l.id) AS product_count
       FROM listings l
       LEFT JOIN categories c ON c.id = l.category_id
       JOIN users u ON u.id = l.user_id
       WHERE l.country_code = $1
         AND l.business_name ILIKE $2
       ORDER BY l.business_name ASC
       LIMIT 20`,
      [req.countryCode, `%${q}%`]
    );
    res.json({ listings: result.rows });
  } catch (err) { next(err); }
});

// GET /admin/listings/:id/products — get products for any listing
router.get('/listings/:id/products', ...requireRole('admin'), async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT id, name, description, price, currency, unit, category, in_stock, created_at
       FROM business_products
       WHERE listing_id = $1
       ORDER BY category NULLS LAST, name ASC`,
      [req.params.id]
    );
    res.json({ products: result.rows });
  } catch (err) { next(err); }
});

// POST /admin/listings/:id/products/upload — upload products on behalf of a listing
router.post('/listings/:id/products/upload', ...requireRole('admin'), productUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const listing = await db.query(
      'SELECT id, business_name FROM listings WHERE id = $1 AND country_code = $2',
      [req.params.id, req.countryCode]
    );
    if (!listing.rows.length) return res.status(404).json({ error: 'Listing not found' });

    let workbook;
    try {
      workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    } catch {
      return res.status(400).json({ error: 'Could not parse file. Ensure it is a valid CSV or Excel file.' });
    }

    const products = parseProductRows(workbook);
    if (!products.length) return res.status(400).json({ error: 'No valid rows found. Ensure your file has a "name" column.' });
    if (products.length > 500) return res.status(400).json({ error: 'Maximum 500 products per upload.' });

    const replace = req.query.replace !== 'false';
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      if (replace) await client.query('DELETE FROM business_products WHERE listing_id = $1', [req.params.id]);
      for (const p of products) {
        await client.query(
          `INSERT INTO business_products (id, listing_id, country_code, name, description, price, unit, category, in_stock)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [uuidv4(), req.params.id, req.countryCode, p.name, p.description, p.price, p.unit, p.category, p.in_stock]
        );
      }
      await client.query('COMMIT');
      await auditLog(req.user.id, 'products_uploaded', req.params.id, `${products.length} products for ${listing.rows[0].business_name}`);
      res.json({ imported: products.length, replaced: replace });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
});

// DELETE /admin/listings/:id/products — clear all products for a listing
router.delete('/listings/:id/products', ...requireRole('admin'), async (req, res, next) => {
  try {
    const listing = await db.query(
      'SELECT id, business_name FROM listings WHERE id = $1 AND country_code = $2',
      [req.params.id, req.countryCode]
    );
    if (!listing.rows.length) return res.status(404).json({ error: 'Listing not found' });
    const result = await db.query(
      'DELETE FROM business_products WHERE listing_id = $1 RETURNING id',
      [req.params.id]
    );
    await auditLog(req.user.id, 'products_cleared', req.params.id, `${result.rows.length} products cleared for ${listing.rows[0].business_name}`);
    res.json({ deleted: result.rows.length });
  } catch (err) { next(err); }
});

// ── Government & Public listing management ────────────────────────────────────

const { memoryUpload } = require('../middleware/upload');
const { processPhoto } = require('../services/imageProcessor');
const { uploadBuffer } = require('../services/storage');

// GET /admin/listings/government — list all govt/public listings
router.get('/listings/government', ...requireRole('admin'), async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT l.id, l.business_name, l.description, l.phone, l.whatsapp,
              l.listing_email, l.website_url, l.address, l.business_hours,
              l.category_id, l.is_active, l.created_at,
              cat.name AS category_name, cat.slug AS category_slug,
              ARRAY_AGG(DISTINCT s.name) FILTER (WHERE s.id IS NOT NULL) AS subcategories
         FROM listings l
         LEFT JOIN categories cat ON cat.id = l.category_id
         LEFT JOIN listing_subcategories ls ON ls.listing_id = l.id
         LEFT JOIN subcategories s ON s.id = ls.subcategory_id AND s.status = 'active'
        WHERE (l.is_public = true OR cat.slug = 'government-public' OR cat.name = 'Government & Public' OR l.category = 'Government & Public') AND l.country_code = $1
        GROUP BY l.id, cat.name, cat.slug
        ORDER BY l.created_at DESC`,
      [req.countryCode]
    );
    res.json({ listings: result.rows });
  } catch (err) { next(err); }
});

// POST /admin/listings/government/ai-prefill — fetch URL and return AI-extracted govt listings array
router.post('/listings/government/ai-prefill', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) return res.status(500).json({ error: 'Gemini API key not configured' });

    let html;
    try {
      const pageRes = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
      if (!pageRes.ok) throw new Error('HTTP ' + pageRes.status);
      html = await pageRes.text();
    } catch (e) {
      return res.status(400).json({ error: 'Could not fetch URL: ' + e.message });
    }
    const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000);

    const prompt = `Extract government office listings from the content below.
Return ONLY a raw JSON array — no markdown, no code fences, no explanation.
Each item must have exactly these keys (use null for missing fields):
organisation_name, department_name, description, phone, whatsapp, listing_email, website_url, address, business_hours

IMPORTANT:
- description: max 1 sentence (keep short)
- organisation_name is required; skip entries that have no name
- If only one office is described, return a single-item array

Content:
${text}`;

    const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    let rawText;
    try {
      const geminiRes = await fetchWithRetry(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, maxOutputTokens: 8192 } }),
      }, 2, 2000);
      if (!geminiRes) throw new Error('Gemini unavailable after retries');
      const geminiData = await geminiRes.json();
      rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) throw new Error('Gemini returned no content');
    } catch (geminiErr) {
      console.warn('[ai-prefill] Gemini failed, falling back to Groq:', geminiErr.message);
      if (!process.env.GROQ_API_KEY) {
        return res.status(502).json({ error: 'AI service error: ' + geminiErr.message });
      }
      try {
        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.1,
            max_tokens: 8192,
          }),
          signal: AbortSignal.timeout(60000),
        });
        if (!groqRes.ok) {
          const e = await groqRes.json().catch(() => ({}));
          throw new Error('Groq error: ' + (e.error?.message || groqRes.statusText));
        }
        const groqData = await groqRes.json();
        rawText = groqData.choices?.[0]?.message?.content;
        if (!rawText) throw new Error('Groq returned no content');
      } catch (groqErr) {
        console.error('[ai-prefill] Groq also failed:', groqErr.message);
        return res.status(502).json({ error: 'AI service unavailable: ' + groqErr.message });
      }
    }

    let listings;
    try {
      listings = parseLLMJSON(rawText);
      if (!Array.isArray(listings)) listings = listings ? [listings] : [];
    } catch {
      // parseLLMJSON failed — salvage any complete JSON objects from the raw text
      const salvaged = [];
      const objRx = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)?\}/g;
      let m;
      while ((m = objRx.exec(rawText)) !== null) {
        try {
          const obj = JSON.parse(m[0]);
          if (obj && obj.organisation_name) salvaged.push(obj);
        } catch { /* skip malformed */ }
      }
      if (salvaged.length) {
        console.warn('[ai-prefill] Used salvage fallback, got', salvaged.length, 'items');
        listings = salvaged;
      } else {
        console.error('[ai-prefill] JSON parse failed, raw:', rawText.slice(0, 300));
        return res.status(500).json({ error: 'AI returned invalid JSON', raw: rawText.slice(0, 300) });
      }
    }

    const now = new Date().toISOString();
    const enriched = listings
      .filter(l => l && l.organisation_name)
      .map(l => ({ ...l, source_url: url, last_verified_at: now }));

    res.json({ listings: enriched, count: enriched.length });
  } catch (err) { next(err); }
});

// POST /admin/listings/government — create a govt/public listing
router.post('/listings/government', ...requireRole('admin'), async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const {
      organisation_name, department_name, subcategory_id,
      description, phone, alt_phone, whatsapp,
      listing_email, website_url, address, business_hours,
      source_url,
    } = req.body;

    if (!organisation_name || !organisation_name.trim()) {
      return res.status(400).json({ error: 'organisation_name is required' });
    }

    const catResult = await db.query(
      "SELECT id, name FROM categories WHERE slug = 'government-public' AND country_code = $1 AND is_active = true",
      [req.countryCode]
    );
    if (!catResult.rows.length) {
      return res.status(400).json({ error: 'Government & Public category not found for this country' });
    }
    const cat = catResult.rows[0];

    const businessName = department_name && department_name.trim()
      ? `${organisation_name.trim()} — ${department_name.trim()}`
      : organisation_name.trim();

    // Use alt_phone as whatsapp if no dedicated whatsapp number given
    const waNumber = whatsapp || alt_phone || null;
    const phoneNumber = phone || null;

    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO listings
         (id, user_id, country_code, business_name, category, category_id,
          description, phone, whatsapp, listing_email, website_url, address,
          business_hours, is_active, is_public, subscription_tier, is_claimed, source_url, last_verified_at)
       VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true, true, 'govt', false, $13, NOW())
       RETURNING *`,
      [
        uuidv4(), req.countryCode, businessName, cat.name, cat.id,
        description || null, phoneNumber, waNumber,
        listing_email || null, website_url || null, address || null, business_hours || null,
        source_url || null,
      ]
    );
    const listing = result.rows[0];

    if (subcategory_id) {
      const subCheck = await client.query(
        'SELECT id FROM subcategories WHERE id = $1 AND category_id = $2 AND status = $3',
        [subcategory_id, cat.id, 'active']
      );
      if (subCheck.rows.length) {
        await client.query(
          `INSERT INTO listing_subcategories (id, listing_id, subcategory_id, is_primary)
           VALUES ($1, $2, $3, true) ON CONFLICT (listing_id, subcategory_id) DO NOTHING`,
          [uuidv4(), listing.id, subcategory_id]
        );
      }
    }

    await client.query('COMMIT');
    await auditLog(req.user.id, 'govt_listing_created', listing.id, `Created govt listing: ${businessName}`);
    res.status(201).json({ listing });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  }
});

// PUT /admin/listings/government/:id — update a govt/public listing
router.put('/listings/government/:id', ...requireRole('admin'), async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const {
      organisation_name, department_name, subcategory_id,
      description, phone, alt_phone, whatsapp,
      listing_email, website_url, address, business_hours, is_active,
    } = req.body;

    const existing = await db.query(
      "SELECT id, business_name FROM listings WHERE id = $1 AND country_code = $2 AND (is_public = true OR category = 'Government & Public')",
      [req.params.id, req.countryCode]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Government listing not found' });

    const businessName = organisation_name
      ? (department_name && department_name.trim()
          ? `${organisation_name.trim()} — ${department_name.trim()}`
          : organisation_name.trim())
      : existing.rows[0].business_name;

    const waNumber = whatsapp !== undefined ? (whatsapp || null)
      : (alt_phone !== undefined ? (alt_phone || null) : undefined);

    await client.query('BEGIN');

    const result = await client.query(
      `UPDATE listings SET
         business_name  = $1,
         description    = $2,
         phone          = $3,
         whatsapp       = COALESCE($4, whatsapp),
         listing_email  = $5,
         website_url    = $6,
         address        = $7,
         business_hours = $8,
         is_active      = COALESCE($9, is_active),
         is_public      = true
       WHERE id = $10
       RETURNING *`,
      [
        businessName, description || null, phone || null,
        waNumber, listing_email || null, website_url || null,
        address || null, business_hours || null,
        is_active !== undefined ? is_active : null,
        req.params.id,
      ]
    );

    if (subcategory_id) {
      await client.query('DELETE FROM listing_subcategories WHERE listing_id = $1', [req.params.id]);
      await client.query(
        `INSERT INTO listing_subcategories (id, listing_id, subcategory_id, is_primary)
         VALUES ($1, $2, $3, true) ON CONFLICT (listing_id, subcategory_id) DO NOTHING`,
        [uuidv4(), req.params.id, subcategory_id]
      );
    }

    await client.query('COMMIT');
    await auditLog(req.user.id, 'govt_listing_updated', req.params.id, `Updated: ${businessName}`);
    res.json({ listing: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  }
});

// POST /admin/listings/government/:id/photos — upload photo for a govt listing (no addon required)
router.post('/listings/government/:id/photos', ...requireRole('admin'), memoryUpload.single('photo'), async (req, res, next) => {
  try {
    const listingRes = await db.query(
      "SELECT id, logo_url FROM listings WHERE id = $1 AND country_code = $2 AND (is_public = true OR category = 'Government & Public')",
      [req.params.id, req.countryCode]
    );
    if (!listingRes.rows.length) return res.status(404).json({ error: 'Government listing not found' });
    if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });

    const { thumb, optimized } = await processPhoto(req.file.buffer);
    const [thumbResult, origResult] = await Promise.all([
      uploadBuffer(thumb, `photos/${req.params.id}/thumbs`, '.webp', 'image/webp'),
      uploadBuffer(optimized, `photos/${req.params.id}/full`, '.webp', 'image/webp'),
    ]);

    const result = await db.query(
      `INSERT INTO listing_photos (id, listing_id, country_code, uploaded_by, original_url, thumb_url, display_order)
       VALUES ($1, $2, $3, $4, $5, $6,
         (SELECT COALESCE(MAX(display_order), 0) + 1 FROM listing_photos WHERE listing_id = $2))
       RETURNING *`,
      [uuidv4(), req.params.id, req.countryCode, req.user.id, origResult.url, thumbResult.url]
    );

    // Auto-promote first photo to listing logo so it shows on browse cards
    if (!listingRes.rows[0].logo_url) {
      await db.query('UPDATE listings SET logo_url = $1 WHERE id = $2', [thumbResult.url, req.params.id]);
    }

    res.status(201).json({ photo: result.rows[0], logo_set: !listingRes.rows[0].logo_url });
  } catch (err) { next(err); }
});

// multer for WebM video uploads (max 50 MB)
const videoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ok = file.mimetype === 'video/webm' || file.originalname.toLowerCase().endsWith('.webm');
    cb(ok ? null : new Error('Only WebM video files are accepted'), ok);
  },
});

// GET /admin/listings/government/:id/videos — list videos for a govt listing
router.get('/listings/government/:id/videos', ...requireRole('admin'), async (req, res, next) => {
  try {
    const result = await db.query(
      'SELECT id, video_url, display_order, created_at FROM listing_videos WHERE listing_id = $1 ORDER BY display_order',
      [req.params.id]
    );
    res.json({ videos: result.rows });
  } catch (err) { next(err); }
});

// POST /admin/listings/government/:id/videos — upload a WebM video clip (max 2 per listing)
router.post('/listings/government/:id/videos', ...requireRole('admin'), videoUpload.single('video'), async (req, res, next) => {
  try {
    const listingRes = await db.query(
      "SELECT id FROM listings WHERE id = $1 AND country_code = $2 AND (is_public = true OR category = 'Government & Public')",
      [req.params.id, req.countryCode]
    );
    if (!listingRes.rows.length) return res.status(404).json({ error: 'Government listing not found' });
    if (!req.file) return res.status(400).json({ error: 'No video file uploaded' });

    const countRes = await db.query('SELECT COUNT(*) FROM listing_videos WHERE listing_id = $1', [req.params.id]);
    if (parseInt(countRes.rows[0].count) >= 2) {
      return res.status(400).json({ error: 'Maximum 2 videos allowed per listing. Delete one first.' });
    }

    const videoResult = await uploadBuffer(
      req.file.buffer,
      `videos/${req.params.id}`,
      '.webm',
      'video/webm'
    );

    const result = await db.query(
      `INSERT INTO listing_videos (id, listing_id, country_code, video_url, video_key, uploaded_by, display_order)
       VALUES ($1, $2, $3, $4, $5, $6,
         (SELECT COALESCE(MAX(display_order), 0) + 1 FROM listing_videos WHERE listing_id = $2))
       RETURNING *`,
      [uuidv4(), req.params.id, req.countryCode, videoResult.url, videoResult.key || null, req.user.id]
    );
    res.status(201).json({ video: result.rows[0] });
  } catch (err) { next(err); }
});

// DELETE /admin/listings/government/videos/:videoId — remove a video
router.delete('/listings/government/videos/:videoId', ...requireRole('admin'), async (req, res, next) => {
  try {
    const result = await db.query(
      'DELETE FROM listing_videos WHERE id = $1 RETURNING id, video_key',
      [req.params.videoId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Video not found' });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// ── Government & Public listing management end ────────────────────────────────

// GET /admin/audit-log — newest 200 entries joined with admin name
router.get('/audit-log', ...requireRole('admin'), async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT a.id, a.action, a.detail, a.target_id, a.created_at,
              COALESCE(u.full_name, 'deleted admin') AS admin_name
       FROM admin_audit_log a
       LEFT JOIN users u ON u.id = a.admin_id
       ORDER BY a.created_at DESC
       LIMIT 200`
    );
    res.json({ logs: result.rows });
  } catch (err) { next(err); }
});

// GET /admin/users/:id/status — presence status for a single user (admin only)
router.get('/users/:id/status', ...requireRole('admin'), async (req, res, next) => {
  try {
    const result = await db.query(
      'SELECT is_online, last_seen_at FROM users WHERE id = $1',
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });

    const { is_online, last_seen_at } = result.rows[0];

    /* Consider online if last_seen_at within last 3 minutes */
    const onlineThreshold = 3 * 60 * 1000;
    const recentlyActive = last_seen_at
      && (Date.now() - new Date(last_seen_at).getTime()) < onlineThreshold;
    const online = is_online && recentlyActive;

    const label = (() => {
      if (!last_seen_at) return 'Never seen';
      if (online) return 'Online now';
      const diff = Math.floor((Date.now() - new Date(last_seen_at).getTime()) / 1000);
      if (diff < 60)   return `${diff} second${diff !== 1 ? 's' : ''} ago`;
      if (diff < 3600) { const m = Math.floor(diff / 60); return `${m} minute${m !== 1 ? 's' : ''} ago`; }
      if (diff < 86400){ const h = Math.floor(diff / 3600); return `${h} hour${h !== 1 ? 's' : ''} ago`; }
      const d = Math.floor(diff / 86400);
      return `${d} day${d !== 1 ? 's' : ''} ago`;
    })();

    res.json({ is_online: online, last_seen_at, last_seen_label: label });
  } catch (err) { next(err); }
});

// GET /admin/listings/unclaimed?q= — search unclaimed non-govt listings for sending claim invites
router.get('/listings/unclaimed', ...requireRole('admin'), async (req, res, next) => {
  try {
    const q           = String(req.query.q || '').trim();
    const noContact   = req.query.no_contact === 'true';

    const conditions = [
      `l.country_code = $1`,
      `(l.is_claimed = false OR l.is_claimed IS NULL)`,
      `COALESCE(l.is_public, false) = false`,
    ];
    const params = [req.countryCode];

    if (q) {
      params.push(`%${q}%`);
      conditions.push(`l.business_name ILIKE $${params.length}`);
    }
    if (noContact) {
      conditions.push(`(l.phone        IS NULL OR l.phone        = '')
                   AND (l.whatsapp     IS NULL OR l.whatsapp     = '')
                   AND (l.listing_email IS NULL OR l.listing_email = '')
                   AND (l.contact_email IS NULL OR l.contact_email = '')
                   AND (l.contact_phone IS NULL OR l.contact_phone = '')
                   AND (l.website_url  IS NULL OR l.website_url  = '')`);
    }

    const result = await db.query(
      `SELECT l.id, l.business_name, l.phone, l.whatsapp, l.listing_email,
              l.website_url, l.contact_email, l.contact_phone,
              l.category, l.is_claimed, l.claim_token, l.created_at,
              cat.name AS category_name
         FROM listings l
         LEFT JOIN categories cat ON cat.id = l.category_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY l.created_at DESC
        LIMIT 100`,
      params
    );
    res.json({ listings: result.rows });
  } catch (err) { next(err); }
});

// GET /admin/listings/admin-created — listings created by this admin (user_id = current admin)
router.get('/listings/admin-created', ...requireRole('admin'), async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT l.id, l.business_name, l.description, l.phone, l.whatsapp, l.listing_email,
              l.website_url, l.address, l.business_hours, l.category, l.category_id,
              l.is_active, l.is_public, l.subscription_tier, l.is_claimed, l.created_at,
              cat.name AS category_name
         FROM listings l
         LEFT JOIN categories cat ON cat.id = l.category_id
        WHERE l.user_id = $1 AND l.country_code = $2
        ORDER BY l.created_at DESC
        LIMIT 100`,
      [req.user.id, req.countryCode]
    );
    res.json({ listings: result.rows });
  } catch (err) { next(err); }
});

// PATCH /admin/listings/:id — admin updates any listing (edit fields or convert to govt)
router.patch('/listings/:id', ...requireRole('admin'), async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const { id } = req.params;
    const {
      business_name, description, phone, whatsapp, website_url,
      address, listing_email, business_hours, service_areas,
      is_active, category_id, convert_to_govt,
    } = req.body;

    const existing = await client.query(
      'SELECT id, business_name, user_id FROM listings WHERE id = $1 AND country_code = $2',
      [id, req.countryCode]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Listing not found' });

    let catName = null;
    let resolvedCategoryId = category_id;
    if (category_id) {
      const catRes = await client.query('SELECT name FROM categories WHERE id = $1 AND is_active = true', [category_id]);
      if (!catRes.rows.length) return res.status(400).json({ error: 'Category not found' });
      catName = catRes.rows[0].name;
    }

    const isConvertingToGovt = convert_to_govt === true || catName === 'Government & Public';

    const setClauses = [];
    const params = [];
    let pi = 1;

    if (business_name !== undefined) { setClauses.push(`business_name = $${pi++}`); params.push(business_name); }
    if (description !== undefined)   { setClauses.push(`description = $${pi++}`);   params.push(description); }
    if (phone !== undefined)         { setClauses.push(`phone = $${pi++}`);          params.push(phone || null); }
    if (whatsapp !== undefined)      { setClauses.push(`whatsapp = $${pi++}`);       params.push(whatsapp || null); }
    if (website_url !== undefined)   { setClauses.push(`website_url = $${pi++}`);   params.push(website_url || null); }
    if (address !== undefined)       { setClauses.push(`address = $${pi++}`);        params.push(address || null); }
    if (listing_email !== undefined) { setClauses.push(`listing_email = $${pi++}`); params.push(listing_email || null); }
    if (business_hours !== undefined){ setClauses.push(`business_hours = $${pi++}`);params.push(business_hours || null); }
    if (service_areas !== undefined) { setClauses.push(`service_areas = $${pi++}`); params.push(service_areas || []); }
    if (is_active !== undefined)     { setClauses.push(`is_active = $${pi++}`);      params.push(is_active); }
    if (catName) {
      setClauses.push(`category_id = $${pi++}`); params.push(resolvedCategoryId);
      setClauses.push(`category = $${pi++}`);    params.push(catName);
    }
    if (isConvertingToGovt) {
      setClauses.push(`is_public = true`);
      setClauses.push(`user_id = NULL`);
      setClauses.push(`subscription_tier = 'govt'`);
      setClauses.push(`is_claimed = false`);
    }

    if (!setClauses.length) return res.status(400).json({ error: 'No fields to update' });

    params.push(id, req.countryCode);
    await client.query(
      `UPDATE listings SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $${pi++} AND country_code = $${pi++}`,
      params
    );

    await auditLog(req.user.id, 'listing_patched_admin', id, business_name || existing.rows[0].business_name);
    res.json({ success: true });
  } catch (err) { next(err); }
  finally { client.release(); }
});

// POST /admin/listings/generate — create a listing on behalf of any user (admin-seeded)
router.post('/listings/generate', ...requireRole('admin'), async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const { business_name, description, category_id, subcategory_id, phone, whatsapp,
            website_url, service_areas, logo_url, is_verified, country_code,
            address, listing_email, business_hours, is_public_entity, source_url } = req.body;
    if (!business_name) return res.status(400).json({ error: 'business_name is required' });
    if (!category_id)   return res.status(400).json({ error: 'category_id is required' });

    const cc = country_code || req.countryCode || 'VC';

    const catResult = await client.query(
      'SELECT id, name FROM categories WHERE id = $1 AND is_active = true',
      [category_id]
    );
    if (!catResult.rows.length) return res.status(400).json({ error: 'Category not found' });
    const categoryName = catResult.rows[0].name;

    if (subcategory_id) {
      const subResult = await client.query(
        'SELECT id FROM subcategories WHERE id = $1 AND status = $2 AND is_active = true',
        [subcategory_id, 'active']
      );
      if (!subResult.rows.length) return res.status(400).json({ error: 'Subcategory not found' });
    }

    // Government & Public category OR admin explicitly marks it as a public sector entity
    const isGovt = categoryName === 'Government & Public' || is_public_entity === true || is_verified === true;
    const userId = null;  // admin-created listings are never owned by the admin — they're unclaimed until a business claims them
    const isPublic = isGovt;

    await client.query('BEGIN');

    const listingId = uuidv4();
    await client.query(
      `INSERT INTO listings (id, user_id, country_code, business_name, category, category_id, description, phone, whatsapp, website_url, service_areas, logo_url, is_active, is_public, subscription_tier, address, listing_email, business_hours, is_claimed, source_url, last_verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true, $13, $14, $15, $16, $17, $18, $19, $20)`,
      [listingId, userId, cc, business_name, categoryName, category_id,
       description || null, phone || null, whatsapp || null, website_url || null,
       service_areas || [], logo_url || null, isPublic, isGovt ? 'govt' : null,
       address || null, listing_email || null, business_hours || null,
       false, source_url || null, source_url ? new Date() : null]
    );

    if (subcategory_id) {
      await client.query(
        `INSERT INTO listing_subcategories (id, listing_id, subcategory_id, is_primary)
         VALUES ($1, $2, $3, true)`,
        [uuidv4(), listingId, subcategory_id]
      );
    }

    await client.query('COMMIT');
    await auditLog(req.user.id, 'listing_generated', listingId, business_name);
    res.json({ success: true, listing_id: listingId, business_name });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});
async function fetchWithRetry(url, options, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      const text = await res.text();
      let errData;
      try { errData = JSON.parse(text); } catch { errData = { error: text }; }
      console.warn(`[API Attempt ${i + 1} Failed]: status=${res.status}, error=${JSON.stringify(errData)}`);
      if (res.status === 503 || res.status === 429 || res.status === 502 || res.status === 504) {
        await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, i)));
        continue;
      }
      const error = new Error(errData.error?.message || errData.error || `API error ${res.status}`);
      error.status = res.status;
      throw error;
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, i)));
    }
  }
}

function tryRepairTruncatedJSON(jsonStr) {
  let cleaned = jsonStr.trim();
  
  if (cleaned.startsWith('[')) {
    let lastCurly = cleaned.lastIndexOf('}');
    while (lastCurly !== -1) {
      const candidate = cleaned.slice(0, lastCurly + 1) + ']';
      try {
        return JSON.parse(candidate);
      } catch {
        const cleanedCandidate = candidate.replace(/,\s*([}\]])/g, '$1');
        try {
          return JSON.parse(cleanedCandidate);
        } catch {
          lastCurly = cleaned.lastIndexOf('}', lastCurly - 1);
        }
      }
    }
  } else if (cleaned.startsWith('{')) {
    let lastCurly = cleaned.lastIndexOf('}');
    while (lastCurly !== -1) {
      const candidate = cleaned.slice(0, lastCurly + 1);
      try {
        return JSON.parse(candidate);
      } catch {
        const cleanedCandidate = candidate.replace(/,\s*([}\]])/g, '$1');
        try {
          return JSON.parse(cleanedCandidate);
        } catch {
          lastCurly = cleaned.lastIndexOf('}', lastCurly - 1);
        }
      }
    }
  }
  
  throw new Error('Could not repair truncated JSON');
}

function parseLLMJSON(rawText) {
  let cleaned = rawText.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '');
  cleaned = cleaned.replace(/\s*```$/, '');
  cleaned = cleaned.trim();

  const firstArray = cleaned.indexOf('[');
  const lastArray = cleaned.lastIndexOf(']');
  const firstObject = cleaned.indexOf('{');
  const lastObject = cleaned.lastIndexOf('}');

  let jsonStr = cleaned;
  if (firstArray !== -1 && lastArray !== -1 && (firstObject === -1 || firstArray < firstObject)) {
    jsonStr = cleaned.slice(firstArray, lastArray + 1);
  } else if (firstObject !== -1 && lastObject !== -1) {
    jsonStr = cleaned.slice(firstObject, lastObject + 1);
  } else if (firstArray !== -1 && lastArray === -1) {
    jsonStr = cleaned.slice(firstArray);
  } else if (firstObject !== -1 && lastObject === -1) {
    jsonStr = cleaned.slice(firstObject);
  }

  try {
    return JSON.parse(jsonStr);
  } catch (parseErr) {
    // Attempt standard trailing comma cleanup:
    const fallbackStr = jsonStr.replace(/,\s*([}\]])/g, '$1');
    try {
      return JSON.parse(fallbackStr);
    } catch {
      try {
        return tryRepairTruncatedJSON(jsonStr);
      } catch (repairErr) {
        console.error('Failed to parse LLM JSON. Raw:', rawText);
        throw parseErr;
      }
    }
  }
}

// POST /admin/generate-listings — AI listing generator via Gemini
router.post('/generate-listings', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { source_type = 'text', content, country_code = 'VC' } = req.body;
    if (!content) return res.status(400).json({ error: 'content is required' });

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) return res.status(500).json({ error: 'Gemini API key not configured' });
    const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    const { processLogo } = require('../services/imageProcessor');

    // Fetch categories so Gemini uses real names
    const catResult = await db.query(
      'SELECT id, name FROM categories WHERE is_active = true ORDER BY name'
    );
    // Always include Government & Public explicitly
    const categoryNames = catResult.rows.map(r => r.name).join(', ');

    let inputText = content;
    let sourceUrl = null;

    if (source_type === 'url') {
      sourceUrl = content;
      try {
        const res = await fetch(content, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error('Could not fetch URL: ' + res.status);
        const html = await res.text();
        inputText = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000);
      } catch (fetchErr) {
        return res.status(400).json({ error: 'Could not fetch URL: ' + fetchErr.message });
      }
    }

    const prompt = `You are a business listing assistant for BridgePro Caribbean marketplace. Analyze the following content and extract ALL business/service listings you can find.

Return ONLY a JSON array of listing objects with these fields:
{ business_name: string, description: string (1 sentence max), category: string, phone: string|null, whatsapp: string|null, website_url: string|null, service_areas: string[], logo_url: string|null, address: string|null, listing_email: string|null, business_hours: string|null, is_active: true, is_verified: false }

Category MUST be one of these exact names: ${categoryNames}

GOVERNMENT RULE: Any government department, ministry, statutory body, public authority, or state-owned enterprise MUST use category "Government & Public". Set is_verified to true automatically for all government listings.

LOGO RULE: Look for any logo or favicon URL in the content (og:image meta tag, favicon link, any logo image src attribute). Set logo_url to the absolute URL if found, otherwise null.

DETAILS RULE: Extract any physical address, email address, or opening/hours information from the content and populate address, listing_email, and business_hours fields respectively. If not found, set them to null.

Pick the closest matching category for each business. Extract as many distinct listings as possible. If only one business is described, return an array with one item.

Return ONLY the raw JSON array. No markdown, no explanation, no code fences.

Content to analyze:
${inputText.slice(0, 6000)}`;

    let rawText;
    try {
      const geminiRes = await fetchWithRetry(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 8192 }
        }),
        signal: AbortSignal.timeout(40000),
      }, 2, 1500);

      if (!geminiRes) throw new Error('Gemini unavailable after retries');
      const geminiData = await geminiRes.json();
      rawText = geminiData.candidates[0].content.parts[0].text;
      console.log('GEMINI RAW:', rawText?.slice(0, 200));
    } catch (geminiErr) {
      console.error('Gemini failed, falling back to Groq:', geminiErr.message);
      if (process.env.GROQ_API_KEY) {
        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [
              { role: 'user', content: prompt }
            ],
            temperature: 0.2,
            max_tokens: 8192
          }),
        });

        if (groqRes.ok) {
          const groqData = await groqRes.json();
          rawText = groqData.choices[0].message.content;
          console.log('GROQ FALLBACK RAW:', rawText?.slice(0, 200));
        } else {
          const groqErrData = await groqRes.json().catch(() => ({}));
          throw new Error('LLM Service Unavailable: ' + (groqErrData.error?.message || groqRes.statusText));
        }
      } else {
        throw geminiErr;
      }
    }

    let listings;
    try {
      listings = parseLLMJSON(rawText);
      if (!Array.isArray(listings)) listings = listings ? [listings] : [];
    } catch (parseErr) {
      // Salvage any complete JSON objects from a truncated array
      const salvaged = [];
      const objRx = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)?\}/g;
      let m;
      while ((m = objRx.exec(rawText)) !== null) {
        try {
          const obj = JSON.parse(m[0]);
          if (obj && obj.business_name) salvaged.push(obj);
        } catch { /* skip */ }
      }
      if (salvaged.length) {
        console.warn('[generate-listings] Used salvage fallback, got', salvaged.length, 'items');
        listings = salvaged;
      } else {
        return res.status(500).json({ error: 'LLM returned invalid JSON', details: parseErr.message, raw: rawText.slice(0, 500) });
      }
    }

    // Enrich with category_id — process in batches of 5 to avoid logo-fetch pile-up
    const catMap = Object.fromEntries(catResult.rows.map(r => [r.name.toLowerCase(), r]));
    const govtCategory = catMap['government & public'] || null;
    const GOVT_KEYWORDS = ['government', 'ministry', 'department', 'statutory', 'public authority', 'public sector', 'state-owned', 'municipality', 'municipal'];

    async function enrichOne(l) {
      const catLower = l.category?.toLowerCase() || '';
      const match = catMap[catLower] || null;
      // Fuzzy govt detection: exact match OR keyword match → force to Government & Public category
      const isGovtByCategory = match?.name === 'Government & Public';
      const isGovtByKeyword = !isGovtByCategory && GOVT_KEYWORDS.some(kw => catLower.includes(kw));
      const isGovt = isGovtByCategory || isGovtByKeyword || l.is_verified === true;
      const resolvedMatch = isGovt ? (govtCategory || match) : match;

      // Attempt to fetch and upload logo
      let resolvedLogoUrl = null;
      const logoSrc = l.logo_url || null;
      if (logoSrc) {
        try {
          const imgRes = await fetch(logoSrc, { signal: AbortSignal.timeout(5000) });
          if (imgRes.ok) {
            const imgBuf = Buffer.from(await imgRes.arrayBuffer());
            const processed = await processLogo(imgBuf);
            const slug = (l.business_name || 'listing').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
            const uploaded = await uploadBuffer(processed, `listings/logos/${slug}`, '.webp', 'image/webp');
            resolvedLogoUrl = uploaded.url;
          }
        } catch { /* logo fetch failed — admin adds manually */ }
      }

      return {
        ...l,
        category_id: resolvedMatch?.id || null,
        category: resolvedMatch?.name || l.category || null,
        country_code,
        service_areas: Array.isArray(l.service_areas) ? l.service_areas : [],
        is_verified: isGovt ? true : (l.is_verified || false),
        is_public_entity: isGovt,
        logo_url: resolvedLogoUrl,
        logo_source: logoSrc,
        address: l.address || null,
        listing_email: l.listing_email || null,
        business_hours: l.business_hours || null,
      };
    }

    // Process in batches of 5 to limit concurrent logo fetches
    const enriched = [];
    for (let i = 0; i < listings.length; i += 5) {
      const batch = await Promise.all(listings.slice(i, i + 5).map(enrichOne));
      enriched.push(...batch);
    }

    // Duplicate detection: find existing listings with similar names
    if (enriched.length > 0) {
      const conditions = enriched.map((_, i) => `LOWER(business_name) LIKE $${i + 2}`);
      const namePatterns = enriched.map(l =>
        `%${l.business_name.toLowerCase().replace(/[%_\\]/g, '\\$&')}%`
      );
      const dupResult = await db.query(
        `SELECT id, business_name, is_claimed, is_public, category_id, contact_email
         FROM listings
         WHERE country_code = $1 AND is_active = true
         AND (${conditions.join(' OR ')})`,
        [country_code, ...namePatterns]
      );

      enriched.forEach(l => {
        const lName = l.business_name.toLowerCase();
        l.duplicates = dupResult.rows.filter(r => {
          const rName = r.business_name.toLowerCase();
          return rName.includes(lName) || lName.includes(rName);
        });
      });
    } else {
      enriched.forEach(l => { l.duplicates = []; });
    }

    res.json({ listings: enriched, count: enriched.length });
  } catch (err) { next(err); }
});

// POST /admin/listings/:id/merge — merge AI-extracted data into an existing listing
router.post('/listings/:id/merge', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { business_name, description, phone, whatsapp, website_url, logo_url, address, listing_email, business_hours, category_id } = req.body;

    const existing = await db.query('SELECT id, business_name FROM listings WHERE id = $1', [id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Listing not found' });

    await db.query(
      `UPDATE listings SET
         business_name    = COALESCE($2,  business_name),
         description      = COALESCE($3,  description),
         phone            = COALESCE($4,  phone),
         whatsapp         = COALESCE($5,  whatsapp),
         website_url      = COALESCE($6,  website_url),
         logo_url         = COALESCE($7,  logo_url),
         address          = COALESCE($8,  address),
         listing_email    = COALESCE($9,  listing_email),
         business_hours   = COALESCE($10, business_hours),
         category_id      = COALESCE($11, category_id)
       WHERE id = $1`,
      [id,
       business_name  || null, description   || null, phone         || null,
       whatsapp       || null, website_url   || null, logo_url      || null,
       address        || null, listing_email || null, business_hours|| null,
       category_id    || null]
    );

    await auditLog(req.user.id, 'listing_merged', id, `Merged AI data into listing: ${existing.rows[0].business_name}`);
    res.json({ success: true, listing_id: id });
  } catch (err) { next(err); }
});

// POST /admin/extract-from-image — Gemini vision text/data extractor

router.post('/extract-from-image', requireAuth, memoryUpload.single('image'), async (req, res, next) => {
  try {
    let base64Image, mimeType;

    if (req.file) {
      base64Image = req.file.buffer.toString('base64');
      mimeType = req.file.mimetype || 'image/jpeg';
    } else if (req.body.image_url) {
      const imgRes = await fetch(req.body.image_url, { signal: AbortSignal.timeout(10000) });
      if (!imgRes.ok) return res.status(400).json({ error: 'Could not fetch image from URL' });
      const buf = Buffer.from(await imgRes.arrayBuffer());
      base64Image = buf.toString('base64');
      const ct = imgRes.headers.get('content-type') || 'image/jpeg';
      mimeType = ct.split(';')[0].trim();
    } else {
      return res.status(400).json({ error: 'Provide an image file or image_url' });
    }

    const result = await extractText(base64Image, mimeType);
    res.json(result);
  } catch (err) { next(err); }
});
/**
 * GET /admin/providers/credit-summary
 * Returns all providers with pre-computed Trust Score inputs so the admin
 * Finance tab can render a full credit-readiness audit table without N+1 queries.
 */
router.get('/providers/credit-summary', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT
        u.id,
        u.full_name,
        u.email,
        u.is_verified,
        u.created_at          AS member_since,
        u.verified_transaction_count,
        u.country_code,
        l.business_name,
        l.category,

        -- verified revenue + transaction counts
        COALESCE(tx.verified_count, 0)  AS verified_tx_count,
        COALESCE(tx.total_count,    0)  AS total_tx_count,
        COALESCE(tx.total_volume,   0)  AS total_volume,
        COALESCE(tx.avg_ticket,     0)  AS avg_ticket,
        tx.last_transaction,

        -- review reputation
        COALESCE(rv.review_count,    0) AS review_count,
        COALESCE(rv.avg_rating,      0) AS avg_rating,
        COALESCE(rv.positive_count,  0) AS positive_count,

        -- claimed benefit tier (most recent)
        bpl.reference_id AS claimed_tier

      FROM users u
      LEFT JOIN LATERAL (
        SELECT business_name, category
        FROM listings
        WHERE user_id = u.id
        ORDER BY is_active DESC NULLS LAST, created_at DESC
        LIMIT 1
      ) l ON true
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (WHERE is_verified = true)            AS verified_count,
          COUNT(*)                                               AS total_count,
          COALESCE(SUM(amount) FILTER (WHERE is_verified=true), 0) AS total_volume,
          COALESCE(AVG(amount) FILTER (WHERE is_verified=true), 0) AS avg_ticket,
          MAX(created_at) FILTER (WHERE is_verified=true)       AS last_transaction
        FROM transactions
        WHERE provider_id = u.id
      ) tx ON true
      LEFT JOIN LATERAL (
        SELECT
          COUNT(r.id)                              AS review_count,
          COALESCE(AVG(r.rating), 0)               AS avg_rating,
          COUNT(r.id) FILTER (WHERE r.rating >= 4) AS positive_count
        FROM reviews r
        JOIN listings lv ON lv.id = r.listing_id AND lv.user_id = u.id
      ) rv ON true
      LEFT JOIN LATERAL (
        SELECT reference_id
        FROM bridge_points_log
        WHERE user_id = u.id AND event_type = 'health_benefit_claimed'
        ORDER BY created_at DESC
        LIMIT 1
      ) bpl ON true

      WHERE u.role = 'provider'
      ORDER BY tx.total_volume DESC NULLS LAST, u.created_at DESC
    `);

    // Compute Trust Score server-side (mirrors calculateHealthScore formula)
    const TIER_THRESHOLDS = [
      { name: 'Platinum', min: 90 },
      { name: 'Gold',     min: 70 },
      { name: 'Silver',   min: 50 },
      { name: 'Bronze',   min: 30 },
      { name: 'Emerging', min: 0  },
    ];

    const providers = rows.map(r => {
      const verifiedTx  = parseInt(r.verified_tx_count, 10) || 0;
      const avgRating   = parseFloat(r.avg_rating)          || 0;
      const reviewCount = parseInt(r.review_count, 10)       || 0;
      const tenure      = r.member_since
        ? Math.floor((Date.now() - new Date(r.member_since).getTime()) / 86_400_000) : 0;
      const isVerified  = !!r.is_verified;
      const totalVol    = parseFloat(r.total_volume)         || 0;
      const totalTx     = parseInt(r.total_tx_count, 10)     || 0;
      const successRate = totalTx > 0 ? Math.round((verifiedTx / totalTx) * 100) : 0;

      const txScore       = Math.min(verifiedTx / 20, 1) * 40;
      const ratingScore   = reviewCount > 0 ? (avgRating / 5) * 30 : 0;
      const tenureScore   = Math.min(tenure / 180, 1) * 20;
      const verifiedBonus = isVerified ? 10 : 0;
      const score         = Math.round(txScore + ratingScore + tenureScore + verifiedBonus);
      const tier          = (TIER_THRESHOLDS.find(t => score >= t.min) || TIER_THRESHOLDS[4]).name;

      return {
        id:             r.id,
        full_name:      r.full_name,
        email:          r.email,
        business_name:  r.business_name || null,
        category:       r.category      || null,
        country_code:   r.country_code,
        is_verified:    isVerified,
        member_since:   r.member_since,
        tenure_days:    tenure,
        trust_score:    score,
        trust_tier:     tier,
        claimed_tier:   r.claimed_tier   || null,
        verified_tx_count: verifiedTx,
        total_volume:   +parseFloat(r.total_volume).toFixed(2),
        avg_ticket:     +parseFloat(r.avg_ticket).toFixed(2),
        success_rate:   successRate,
        avg_rating:     +avgRating.toFixed(2),
        review_count:   reviewCount,
        last_transaction: r.last_transaction || null,
      };
    });

    res.json({ providers, total: providers.length });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin: Integration Management — POS API Keys & Flagged Transaction Review
// These routes allow non-technical admins to manage POS connections and review
// velocity-flagged transactions without touching the database.
// ─────────────────────────────────────────────────────────────────────────────

router.get('/integrations/overview', ...requireRole('admin'), async (req, res, next) => {
  try {
    const [keysRes, flaggedRes, posRes] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM provider_api_keys WHERE is_active = true`),
      db.query(`SELECT COUNT(*) FROM transactions WHERE review_required = true`),
      db.query(`SELECT COUNT(*) FROM transactions WHERE source = 'pos_integration'`),
    ]);
    res.json({
      active_keys:            parseInt(keysRes.rows[0].count, 10),
      pending_flags:          parseInt(flaggedRes.rows[0].count, 10),
      total_pos_transactions: parseInt(posRes.rows[0].count, 10),
    });
  } catch (err) { next(err); }
});

router.get('/integrations/keys', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT
        pak.id, pak.api_key, pak.label, pak.is_active,
        pak.last_used_at, pak.created_at, pak.provider_id,
        u.full_name, u.email, u.country_code,
        COALESCE(l.business_name, u.full_name) AS business_name,
        COUNT(t.id) FILTER (WHERE t.source = 'pos_integration') AS pos_tx_count
      FROM provider_api_keys pak
      JOIN users u ON u.id = pak.provider_id
      LEFT JOIN listings l ON l.user_id = pak.provider_id AND l.country_code = u.country_code
      LEFT JOIN transactions t ON t.provider_id = pak.provider_id AND t.source = 'pos_integration'
      GROUP BY pak.id, u.full_name, u.email, u.country_code, l.business_name
      ORDER BY pak.is_active DESC, pak.last_used_at DESC NULLS LAST, pak.created_at DESC
    `);
    res.json({ keys: rows });
  } catch (err) { next(err); }
});

router.post('/integrations/keys/:provider_id', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { provider_id } = req.params;
    const label = ((req.body && req.body.label) || 'Admin Generated').slice(0, 100);
    const { rows: userRows } = await db.query(
      `SELECT id FROM users WHERE id = $1 AND role = 'provider'`, [provider_id]
    );
    if (!userRows.length) return res.status(404).json({ error: 'Provider not found' });
    const apiKey = `bpk_${require('crypto').randomBytes(28).toString('hex')}`;
    const { rows } = await db.query(
      `INSERT INTO provider_api_keys (provider_id, api_key, label)
       VALUES ($1, $2, $3) RETURNING id, label, api_key, is_active, created_at`,
      [provider_id, apiKey, label]
    );
    res.status(201).json({ api_key: rows[0] });
  } catch (err) { next(err); }
});

router.delete('/integrations/keys/:key_id', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE provider_api_keys SET is_active = false WHERE id = $1 RETURNING id`,
      [req.params.key_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Key not found' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.get('/integrations/flagged', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT
        t.id, t.amount,
        COALESCE(t.job_notes, t.pos_reference_id, '') AS description,
        COALESCE(t.guest_customer_name, cu.full_name, '') AS customer_name,
        t.source, t.verification_method, t.is_flagged, t.review_required,
        t.created_at, t.country_code,
        u.full_name, u.email, u.id AS provider_id,
        COALESCE(l.business_name, u.full_name) AS business_name,
        tra.risk_score, tra.reasoning, tra.category AS risk_category,
        tra.recommended_action, tra.model_used, tra.tools_used
      FROM transactions t
      JOIN users u ON u.id = t.provider_id
      LEFT JOIN users cu ON cu.id = t.customer_id
      LEFT JOIN listings l ON l.user_id = t.provider_id AND l.country_code = t.country_code
      LEFT JOIN transaction_risk_assessments tra ON tra.transaction_id = t.id
      WHERE t.review_required = true
      ORDER BY COALESCE(tra.risk_score, 0) DESC, t.created_at DESC
    `);
    res.json({ flagged: rows });
  } catch (err) { next(err); }
});

router.patch('/integrations/clear-flag/:id', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE transactions SET is_flagged = false, review_required = false
       WHERE id = $1 RETURNING id, provider_id, country_code`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Transaction not found' });
    const t = rows[0];
    const { updateCreditProfile } = require('../services/pointsService');
    updateCreditProfile(t.id, t.provider_id, t.country_code || 'SVG').catch(console.error);
    res.json({ success: true, message: 'Flag cleared — transaction now included in credit score' });
  } catch (err) { next(err); }
});

router.patch('/integrations/dismiss-flag/:id', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE transactions SET review_required = false WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Transaction not found' });
    res.json({ success: true, message: 'Transaction permanently excluded from credit calculations' });
  } catch (err) { next(err); }
});

// ── Founder Access & Tier Management ─────────────────────────────────────────

// PATCH /admin/users/:id/founder-access — set/revoke founder status for a user
router.patch('/users/:id/founder-access', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { founder_status } = req.body;
    if (typeof founder_status !== 'boolean') {
      return res.status(400).json({ error: 'founder_status must be a boolean' });
    }
    const { rows } = await db.query(
      `UPDATE users SET founder_status = $1 WHERE id = $2 RETURNING id, full_name, founder_status`,
      [founder_status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true, user: rows[0] });
  } catch (err) { next(err); }
});

// PATCH /admin/users/:id/tier — set PRO or PREMIUM tier
router.patch('/users/:id/tier', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { tier } = req.body;
    if (!['PRO', 'PREMIUM'].includes(tier)) {
      return res.status(400).json({ error: 'tier must be PRO or PREMIUM' });
    }
    const { rows } = await db.query(
      `UPDATE users SET tier = $1 WHERE id = $2 RETURNING id, full_name, tier`,
      [tier, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true, user: rows[0] });
  } catch (err) { next(err); }
});

// GET /admin/tier-pricing — get per-country tier pricing
router.get('/tier-pricing', ...requireRole('admin'), async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT value FROM platform_settings WHERE key = 'tier_pricing'`
    );
    let pricing = {};
    try { pricing = JSON.parse(r.rows[0]?.value || '{}'); } catch {}
    res.json({ pricing });
  } catch (err) { next(err); }
});

// PATCH /admin/tier-pricing — update per-country tier pricing
router.patch('/tier-pricing', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { pricing } = req.body;
    if (!pricing || typeof pricing !== 'object') {
      return res.status(400).json({ error: 'pricing object required' });
    }
    // Validate each country entry
    const ALLOWED_CC = ['SVG', 'GRD', 'SLU', 'BRB'];
    for (const [cc, val] of Object.entries(pricing)) {
      if (!ALLOWED_CC.includes(cc)) return res.status(400).json({ error: `Unknown country code: ${cc}` });
      if (typeof val.pro_price !== 'number' || typeof val.premium_price !== 'number') {
        return res.status(400).json({ error: `Invalid pricing for ${cc}` });
      }
    }
    await db.query(
      `INSERT INTO platform_settings (key, value, updated_at, updated_by)
       VALUES ('tier_pricing', $1, NOW(), $2)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW(), updated_by = $2`,
      [JSON.stringify(pricing), req.user.id]
    );
    const { invalidate } = require('../services/platformSettings');
    invalidate();
    res.json({ ok: true, pricing });
  } catch (err) { next(err); }
});

module.exports = router;
