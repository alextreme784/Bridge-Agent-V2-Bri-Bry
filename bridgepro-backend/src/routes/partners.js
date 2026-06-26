const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid confusion
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ── Customer: browse stores ──────────────────────────────────────────────────

router.get('/stores', requireAuth, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT id, name, description, location, points_per_dollar, min_redemption
       FROM partner_stores
       WHERE country_code = $1 AND is_active = true
       ORDER BY name ASC`,
      [req.countryCode]
    );
    res.json({ stores: result.rows });
  } catch (err) { next(err); }
});

// ── Customer: generate redemption code ──────────────────────────────────────

router.post('/redeem/generate', requireAuth, async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const { store_id, points_to_redeem } = req.body;
    if (!store_id) return res.status(400).json({ error: 'store_id is required' });

    const points = parseInt(points_to_redeem);
    if (!points || points <= 0) return res.status(400).json({ error: 'Invalid points amount' });

    const storeResult = await client.query(
      `SELECT id, name, points_per_dollar, min_redemption
       FROM partner_stores WHERE id = $1 AND country_code = $2 AND is_active = true`,
      [store_id, req.countryCode]
    );
    if (!storeResult.rows.length) return res.status(404).json({ error: 'Partner store not found' });
    const store = storeResult.rows[0];

    if (points < store.min_redemption) {
      return res.status(400).json({ error: `Minimum redemption at ${store.name} is ${store.min_redemption} points` });
    }

    const userResult = await client.query('SELECT bridge_points FROM users WHERE id = $1', [req.user.id]);
    const balance = parseInt(userResult.rows[0]?.bridge_points || 0);
    if (balance < points) {
      return res.status(400).json({ error: `Not enough points. You have ${balance}.` });
    }

    // Expire any open tokens for this user first
    await client.query(
      `UPDATE point_redemption_tokens SET status = 'expired'
       WHERE user_id = $1 AND status = 'pending' AND country_code = $2`,
      [req.user.id, req.countryCode]
    );

    const dollarValue = parseFloat((points / store.points_per_dollar).toFixed(2));

    let code;
    for (let i = 0; i < 10; i++) {
      const candidate = generateCode();
      const clash = await client.query(
        `SELECT id FROM point_redemption_tokens WHERE code = $1`, [candidate]
      );
      if (!clash.rows.length) { code = candidate; break; }
    }
    if (!code) return res.status(500).json({ error: 'Could not generate code. Try again.' });

    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    const result = await client.query(
      `INSERT INTO point_redemption_tokens
         (id, code, user_id, store_id, country_code, points_to_redeem, dollar_value, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING code, points_to_redeem, dollar_value, expires_at`,
      [uuidv4(), code, req.user.id, store_id, req.countryCode, points, dollarValue, expiresAt]
    );

    res.status(201).json({ ...result.rows[0], store_name: store.name });
  } catch (err) { next(err); }
  finally { client.release(); }
});

// ── Customer: poll status ────────────────────────────────────────────────────

router.get('/redeem/:code/status', requireAuth, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT t.status, t.used_at, t.dollar_value, t.points_to_redeem, t.expires_at,
              s.name AS store_name
       FROM point_redemption_tokens t
       JOIN partner_stores s ON s.id = t.store_id
       WHERE t.code = $1 AND t.user_id = $2`,
      [req.params.code.toUpperCase(), req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Code not found' });

    const token = result.rows[0];
    if (token.status === 'pending' && new Date() > new Date(token.expires_at)) {
      await db.query(
        `UPDATE point_redemption_tokens SET status = 'expired' WHERE code = $1`,
        [req.params.code.toUpperCase()]
      );
      token.status = 'expired';
    }
    res.json(token);
  } catch (err) { next(err); }
});

// ── Partner: preview code before confirming ──────────────────────────────────

router.get('/redeem/:code/preview', requireAuth, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT t.code, t.points_to_redeem, t.dollar_value, t.status, t.expires_at,
              s.name AS store_name,
              u.full_name AS customer_name, u.bridge_points AS customer_balance
       FROM point_redemption_tokens t
       JOIN partner_stores s ON s.id = t.store_id
       JOIN users u ON u.id = t.user_id
       WHERE t.code = $1 AND t.country_code = $2`,
      [req.params.code.toUpperCase(), req.countryCode]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Invalid code' });

    const token = result.rows[0];
    if (token.status === 'used')    return res.status(409).json({ error: 'Code already used' });
    if (token.status === 'expired' || new Date() > new Date(token.expires_at)) {
      return res.status(410).json({ error: 'Code has expired' });
    }
    res.json(token);
  } catch (err) { next(err); }
});

// ── Partner: confirm redemption ───────────────────────────────────────────────

router.post('/redeem/:code/use', requireAuth, async (req, res, next) => {
  if (!req.user.is_partner && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Partner access required to confirm redemptions' });
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `SELECT t.*, s.name AS store_name, u.full_name AS customer_name, u.bridge_points AS balance
       FROM point_redemption_tokens t
       JOIN partner_stores s ON s.id = t.store_id
       JOIN users u ON u.id = t.user_id
       WHERE t.code = $1 AND t.country_code = $2
       FOR UPDATE`,
      [req.params.code.toUpperCase(), req.countryCode]
    );

    if (!result.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Invalid code' });
    }

    const token = result.rows[0];
    if (token.status === 'used') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Code already used' });
    }
    if (token.status === 'expired' || new Date() > new Date(token.expires_at)) {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'Code has expired' });
    }
    if (token.balance < token.points_to_redeem) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Customer has insufficient points' });
    }

    await client.query(
      `UPDATE point_redemption_tokens SET status='used', redeemed_by=$1, used_at=NOW() WHERE id=$2`,
      [req.user.id, token.id]
    );
    await client.query(
      `UPDATE users SET bridge_points = bridge_points - $1 WHERE id = $2`,
      [token.points_to_redeem, token.user_id]
    );
    await client.query(
      `INSERT INTO bridge_points_log
         (id, user_id, country_code, event_type, points_awarded, reference_id, expires_at, reference_type)
       VALUES ($1,$2,$3,'partner_redemption',$4,$5,'9999-12-31','partner_token')`,
      [uuidv4(), token.user_id, req.countryCode, -token.points_to_redeem, token.id]
    );

    await client.query('COMMIT');
    res.json({
      message: 'Points redeemed',
      customer_name: token.customer_name,
      points_redeemed: token.points_to_redeem,
      dollar_value: token.dollar_value,
      store_name: token.store_name,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

// ── Partner: my store ────────────────────────────────────────────────────────

router.get('/my/store', requireAuth, async (req, res, next) => {
  if (!req.user.is_partner && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Partner access required' });
  }
  try {
    const result = await db.query(
      `SELECT id, name, description, location, points_per_dollar, min_redemption, is_active
       FROM partner_stores
       WHERE owner_user_id = $1 AND country_code = $2
       LIMIT 1`,
      [req.user.id, req.countryCode]
    );
    res.json({ store: result.rows[0] || null });
  } catch (err) { next(err); }
});

// ── Partner: my redemption stats + history ───────────────────────────────────

router.get('/my/redemptions', requireAuth, async (req, res, next) => {
  if (!req.user.is_partner && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Partner access required' });
  }
  try {
    const [statsResult, recentResult] = await Promise.all([
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE used_at >= CURRENT_DATE)                                        AS today_count,
          COALESCE(SUM(dollar_value) FILTER (WHERE used_at >= CURRENT_DATE), 0)                  AS today_value,
          COUNT(*) FILTER (WHERE used_at >= DATE_TRUNC('month', NOW()))                          AS month_count,
          COALESCE(SUM(dollar_value) FILTER (WHERE used_at >= DATE_TRUNC('month', NOW())), 0)    AS month_value,
          COUNT(*)                                                                                 AS total_count,
          COALESCE(SUM(dollar_value), 0)                                                          AS total_value
        FROM point_redemption_tokens
        WHERE redeemed_by = $1 AND status = 'used' AND country_code = $2
      `, [req.user.id, req.countryCode]),
      db.query(`
        SELECT t.code, t.points_to_redeem, t.dollar_value, t.used_at,
               s.name AS store_name,
               u.full_name AS customer_name
        FROM point_redemption_tokens t
        JOIN partner_stores s ON s.id = t.store_id
        JOIN users u ON u.id = t.user_id
        WHERE t.redeemed_by = $1 AND t.status = 'used' AND t.country_code = $2
        ORDER BY t.used_at DESC
        LIMIT 20
      `, [req.user.id, req.countryCode]),
    ]);
    res.json({ stats: statsResult.rows[0], recent: recentResult.rows });
  } catch (err) { next(err); }
});

// ── Partner: update own store settings ───────────────────────────────────────

router.put('/my/store', requireAuth, async (req, res, next) => {
  if (!req.user.is_partner && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Partner access required' });
  }
  try {
    const { name, description, location, points_per_dollar, min_redemption } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Store name is required' });

    const ppd = points_per_dollar ? parseInt(points_per_dollar) : null;
    if (ppd !== null && (isNaN(ppd) || ppd < 1)) {
      return res.status(400).json({ error: 'Conversion rate must be a positive number' });
    }
    const minR = min_redemption ? parseInt(min_redemption) : null;
    if (minR !== null && (isNaN(minR) || minR < 1)) {
      return res.status(400).json({ error: 'Minimum redemption must be a positive number' });
    }

    const result = await db.query(
      `UPDATE partner_stores SET
         name              = $1,
         description       = $2,
         location          = $3,
         points_per_dollar = COALESCE($4, points_per_dollar),
         min_redemption    = COALESCE($5, min_redemption),
         updated_at        = NOW()
       WHERE owner_user_id = $6 AND country_code = $7
       RETURNING *`,
      [name.trim(), description?.trim() || null, location?.trim() || null,
       ppd, minR, req.user.id, req.countryCode]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'No store found. Contact your administrator.' });
    res.json({ store: result.rows[0] });
  } catch (err) { next(err); }
});

// ── Admin: manage partner stores ─────────────────────────────────────────────

router.get('/admin/stores', ...requireRole('admin'), async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT ps.*, u.full_name AS owner_name, u.email AS owner_email
       FROM partner_stores ps
       LEFT JOIN users u ON u.id = ps.owner_user_id
       WHERE ps.country_code = $1 ORDER BY ps.name ASC`,
      [req.countryCode]
    );
    res.json({ stores: result.rows });
  } catch (err) { next(err); }
});

router.post('/admin/stores', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { name, description, location, points_per_dollar, min_redemption, owner_user_id } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
    const result = await db.query(
      `INSERT INTO partner_stores (id, country_code, name, description, location, points_per_dollar, min_redemption, owner_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [uuidv4(), req.countryCode, name.trim(), description?.trim() || null,
       location?.trim() || null, parseInt(points_per_dollar) || 100, parseInt(min_redemption) || 100,
       owner_user_id || null]
    );
    res.status(201).json({ store: result.rows[0] });
  } catch (err) { next(err); }
});

router.put('/admin/stores/:id', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { name, description, location, points_per_dollar, min_redemption, is_active } = req.body;

    const params = [
      name?.trim() || null, description?.trim() || null, location?.trim() || null,
      points_per_dollar ? parseInt(points_per_dollar) : null,
      min_redemption ? parseInt(min_redemption) : null,
      is_active ?? null, req.params.id, req.countryCode,
    ];

    // Only include owner_user_id in the SET clause when the field is explicitly sent
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let ownerClause = '';
    if ('owner_user_id' in req.body) {
      const oid = req.body.owner_user_id;
      if (oid && !UUID_RE.test(oid)) return res.status(400).json({ error: 'Invalid owner_user_id' });
      params.push(oid || null);
      ownerClause = `, owner_user_id = $${params.length}`;
    }

    const result = await db.query(
      `UPDATE partner_stores SET
         name              = COALESCE($1, name),
         description       = COALESCE($2, description),
         location          = COALESCE($3, location),
         points_per_dollar = COALESCE($4, points_per_dollar),
         min_redemption    = COALESCE($5, min_redemption),
         is_active         = COALESCE($6, is_active)${ownerClause},
         updated_at        = NOW()
       WHERE id = $7 AND country_code = $8 RETURNING *`,
      params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Store not found' });
    res.json({ store: result.rows[0] });
  } catch (err) { next(err); }
});

router.delete('/admin/stores/:id', ...requireRole('admin'), async (req, res, next) => {
  try {
    await db.query(
      'DELETE FROM point_redemption_tokens WHERE store_id = $1',
      [req.params.id]
    );
    const result = await db.query(
      'DELETE FROM partner_stores WHERE id = $1 AND country_code = $2 RETURNING id',
      [req.params.id, req.countryCode]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Store not found' });
    res.json({ message: 'Partner store deleted' });
  } catch (err) { next(err); }
});

module.exports = router;
