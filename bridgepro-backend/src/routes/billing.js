const express = require('express');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── Schema bootstrap ──────────────────────────────────────────────────────────
db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS founder_status BOOLEAN DEFAULT true`).catch(() => {});
db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tier VARCHAR(20) DEFAULT 'PRO'`).catch(() => {});

// Seed default tier pricing per country (won't overwrite if already set)
const DEFAULT_PRICING = {
  SVG: { currency: 'XCD', pro_price: 49, premium_price: 99 },
  GRD: { currency: 'XCD', pro_price: 49, premium_price: 99 },
  SLU: { currency: 'XCD', pro_price: 49, premium_price: 99 },
  BRB: { currency: 'BBD', pro_price: 49, premium_price: 99 },
};

db.query(
  `INSERT INTO platform_settings (key, value, updated_at)
   VALUES ('tier_pricing', $1, NOW())
   ON CONFLICT (key) DO NOTHING`,
  [JSON.stringify(DEFAULT_PRICING)]
).catch(() => {});

// ── Module definitions ────────────────────────────────────────────────────────
const PRO_MODULES = [
  'core_ledger',
  'trust_score',
  'business_health',
  'marketing_tools',
  'ai_assistant',
  'documents',
  'pos_single_key',
  'gallery_or_store',
];

const PREMIUM_MODULES = [
  ...PRO_MODULES,
  'payroll_ledger',
  'first_impression',
  'store_pro',
  'bridgepro_plus',
  'gallery_and_store',
  'pos_unlimited_keys',
];

function getModules(user) {
  if (user.founder_status || user.tier === 'PREMIUM') return PREMIUM_MODULES;
  return PRO_MODULES;
}

// ── GET /api/v1/billing/status ────────────────────────────────────────────────
router.get('/status', requireAuth, async (req, res, next) => {
  try {
    const cc = req.countryCode || req.headers['x-country-code'] || 'SVG';
    const r = await db.query(
      `SELECT founder_status, tier, subscription_tier, subscription_status
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    const u = r.rows[0];

    const pr = await db.query(
      `SELECT value FROM platform_settings WHERE key = 'tier_pricing'`
    );
    let pricing = {};
    try { pricing = JSON.parse(pr.rows[0]?.value || '{}'); } catch {}
    const countryPricing = pricing[cc] || { currency: 'XCD', pro_price: 49, premium_price: 99 };

    res.json({
      founder_status: u.founder_status !== false,  // default true
      tier: u.tier || 'PRO',
      subscription_tier: u.subscription_tier,
      subscription_status: u.subscription_status,
      modules: getModules(u),
      pricing: countryPricing,
      has_full_access: u.founder_status !== false || u.tier === 'PREMIUM',
    });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/v1/billing/upgrade ────────────────────────────────────────────
router.patch('/upgrade', requireAuth, async (req, res, next) => {
  try {
    const { target_tier } = req.body;
    if (!['PRO', 'PREMIUM'].includes(target_tier)) {
      return res.status(400).json({ error: 'Invalid tier. Must be PRO or PREMIUM.' });
    }
    await db.query(
      `UPDATE users SET tier = $1 WHERE id = $2`,
      [target_tier, req.user.id]
    );
    res.json({ ok: true, tier: target_tier });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, getModules, PRO_MODULES, PREMIUM_MODULES };
