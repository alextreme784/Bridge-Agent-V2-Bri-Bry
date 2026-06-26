const express = require('express');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db');
const { requireRole, requireAuth } = require('../middleware/auth');
const { sendEmail } = require('../services/emailService');
const { getMarketConfig } = require('../config/countries');

const router = express.Router();
const SALT_ROUNDS = 12;

function signAccess(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRY || '30d' });
}

function signRefresh(payload) {
  return jwt.sign(payload, process.env.JWT_REFRESH_SECRET, { expiresIn: process.env.JWT_REFRESH_EXPIRY || '90d' });
}

function generateReferralCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

// Map 3-letter country codes to their frontend domain.
// SVG_SITE_URL etc. can be overridden via env; fallback pattern uses domain_slug from DB.
const SITE_DOMAIN_OVERRIDES = {
  SVG: process.env.SVG_SITE_URL,
  SLU: process.env.SLU_SITE_URL,
  BRB: process.env.BRB_SITE_URL,
  GRD: process.env.GRD_SITE_URL,
};
const SITE_BASE_DOMAIN = process.env.SITE_BASE_DOMAIN || 'a3tech.uk';

async function buildClaimUrl(countryCode, token) {
  const override = SITE_DOMAIN_OVERRIDES[countryCode];
  if (override) return `${override}/#/claim?token=${token}`;
  try {
    const market = await getMarketConfig(countryCode);
    const slug = market?.domainSlug || `bridgepro-${countryCode.toLowerCase()}`;
    return `https://${slug}.${SITE_BASE_DOMAIN}/#/claim?token=${token}`;
  } catch {
    return `https://bridgepro.${SITE_BASE_DOMAIN}/#/claim?token=${token}`;
  }
}

// POST /claim/generate-token — admin generates a claim link (no email sent)
router.post('/generate-token', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { listing_id, contact_email, contact_phone, business_name } = req.body;
    if (!listing_id) return res.status(400).json({ error: 'listing_id is required' });

    const listing = await db.query(
      'SELECT id, business_name, country_code, claim_token FROM listings WHERE id = $1',
      [listing_id]
    );
    if (!listing.rows.length) return res.status(404).json({ error: 'Listing not found' });

    const row = listing.rows[0];
    const bName = business_name || row.business_name;

    // Reuse existing token if present, otherwise generate new
    const claim_token = row.claim_token || (uuidv4().replace(/-/g, '') + crypto.randomBytes(8).toString('hex'));

    await db.query(
      `UPDATE listings SET
         is_claimed = false,
         claim_token = $1,
         contact_email = COALESCE($2, contact_email),
         contact_phone = COALESCE($3, contact_phone)
       WHERE id = $4`,
      [claim_token, contact_email || null, contact_phone || null, listing_id]
    );

    const countryCode = row.country_code || 'SVG';
    const claimUrl = await buildClaimUrl(countryCode, claim_token);

    res.json({ success: true, token: claim_token, claim_url: claimUrl, business_name: bName });
  } catch (err) { next(err); }
});

// POST /claim/send-invite — admin sends a claim invite to a business
router.post('/send-invite', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { listing_id, contact_email, contact_phone, business_name, reply_to, from_name } = req.body;
    if (!listing_id) return res.status(400).json({ error: 'listing_id is required' });
    if (!contact_email && !contact_phone) return res.status(400).json({ error: 'contact_email or contact_phone is required' });

    const listing = await db.query(
      'SELECT id, business_name, country_code, claim_token FROM listings WHERE id = $1',
      [listing_id]
    );
    if (!listing.rows.length) return res.status(404).json({ error: 'Listing not found' });

    const row = listing.rows[0];
    const bName = business_name || row.business_name;

    // Reuse existing token if present so invite links stay stable
    const claim_token = row.claim_token || (uuidv4().replace(/-/g, '') + crypto.randomBytes(8).toString('hex'));

    await db.query(
      `UPDATE listings SET
         is_claimed = false,
         claim_token = $1,
         contact_email = COALESCE($2, contact_email),
         contact_phone = COALESCE($3, contact_phone)
       WHERE id = $4`,
      [claim_token, contact_email || null, contact_phone || null, listing_id]
    );

    const countryCode = row.country_code || 'SVG';
    const claimUrl = await buildClaimUrl(countryCode, claim_token);

    if (contact_email) {
      const senderLabel = from_name || 'BridgePro Team';
      const html = `
        <h2 style="color:#009E60;margin:0 0 16px">Your business is on BridgePro! 🎉</h2>
        <p>Hi! We found <strong>${bName}</strong> and created a free listing for you on BridgePro — the Caribbean service marketplace.</p>
        <p>Customers are already finding you!</p>
        <p>Click below to claim your listing and start receiving enquiries directly.</p>
        <div style="text-align:center;margin:28px 0">
          <a href="${claimUrl}" style="background:#009E60;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:1rem;display:inline-block">
            ✅ Claim My Free Listing
          </a>
        </div>
        <p style="font-size:0.85rem;color:#666">This link is unique to you. If you didn't expect this email, you can safely ignore it.</p>
        ${reply_to ? `<p style="font-size:0.85rem;color:#666">Questions? Reply to this email and ${senderLabel} will get back to you.</p>` : ''}
      `;
      await sendEmail({
        to: contact_email,
        subject: `Your business is on BridgePro! Claim ${bName}`,
        html,
        fromName: senderLabel,
        replyTo: reply_to || undefined,
      });
    }

    res.json({ success: true, token: claim_token, claim_url: claimUrl });
  } catch (err) { next(err); }
});

// GET /claim/verify?token=TOKEN — public, check token validity
router.get('/verify', async (req, res, next) => {
  try {
    const { token } = req.query;
    if (!token) return res.json({ valid: false, reason: 'No token provided' });

    const result = await db.query(
      `SELECT id, business_name, description, category, logo_url, is_claimed, country_code
       FROM listings WHERE claim_token = $1`,
      [token]
    );
    if (!result.rows.length) return res.json({ valid: false, reason: 'Token not found' });

    const l = result.rows[0];
    if (l.is_claimed) return res.json({ valid: false, reason: 'This listing has already been claimed' });

    res.json({
      valid: true,
      listing_id: l.id,
      business_name: l.business_name,
      description: l.description,
      category: l.category,
      logo_url: l.logo_url,
      country_code: l.country_code,
    });
  } catch (err) { next(err); }
});

// POST /claim/complete — public, create account and claim listing
router.post('/complete', async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const { token, name, email, password, phone } = req.body;
    if (!token)    return res.status(400).json({ error: 'token is required' });
    if (!name)     return res.status(400).json({ error: 'name is required' });
    if (!email)    return res.status(400).json({ error: 'email is required' });
    if (!password) return res.status(400).json({ error: 'password is required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const listingRes = await client.query(
      'SELECT id, business_name, country_code FROM listings WHERE claim_token = $1 AND is_claimed = false',
      [token]
    );
    if (!listingRes.rows.length) {
      return res.status(400).json({ error: 'This claim link is invalid or has already been used' });
    }
    const listing = listingRes.rows[0];
    const countryCode = listing.country_code || 'VC';

    // Check email not already registered in this country
    const existing = await client.query(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND country_code = $2',
      [email.trim(), countryCode]
    );
    if (existing.rows.length) {
      return res.status(409).json({ error: 'An account with this email already exists. Please log in instead.' });
    }

    await client.query('BEGIN');

    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
    const userId = uuidv4();
    const referralCode = generateReferralCode();

    const userRes = await client.query(
      `INSERT INTO users (id, country_code, email, password_hash, full_name, phone, account_type, role, subscription_status, referral_code, is_verified)
       VALUES ($1, $2, $3, $4, $5, $6, 'sole_trader', 'provider', 'free', $7, true)
       RETURNING id, email, full_name, role, account_type, is_verified, bridge_points, subscription_status`,
      [userId, countryCode, email.trim(), password_hash, name.trim(), phone?.trim() || null, referralCode]
    );
    const user = userRes.rows[0];

    await client.query(
      `UPDATE listings SET
         user_id = $1,
         is_claimed = true,
         claimed_at = NOW(),
         claim_token = NULL
       WHERE id = $2`,
      [userId, listing.id]
    );

    await client.query('COMMIT');

    const tokenPayload = { id: user.id, role: user.role, country_code: countryCode };
    const access_token = signAccess(tokenPayload);
    const refresh_token = signRefresh(tokenPayload);

    res.json({
      success: true,
      access_token,
      refresh_token,
      user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role, is_verified: user.is_verified },
      listing_id: listing.id,
      business_name: listing.business_name,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// POST /claim/link — authenticated user links an unclaimed listing to their existing account
router.post('/link', requireAuth, async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'token is required' });

    const listingRes = await client.query(
      'SELECT id, business_name, country_code FROM listings WHERE claim_token = $1 AND is_claimed = false',
      [token]
    );
    if (!listingRes.rows.length) {
      return res.status(400).json({ error: 'This claim link is invalid or has already been used' });
    }
    const listing = listingRes.rows[0];

    // Block if user already owns a listing (platform enforces one per provider)
    const existingListing = await client.query(
      'SELECT id, business_name FROM listings WHERE user_id = $1 AND is_active = true LIMIT 1',
      [req.user.id]
    );
    if (existingListing.rows.length) {
      return res.status(409).json({
        error: `You already have a listing (${existingListing.rows[0].business_name}). Only one listing per account is allowed.`,
      });
    }

    await client.query('BEGIN');

    await client.query(
      `UPDATE listings SET
         user_id = $1,
         is_claimed = true,
         claimed_at = NOW(),
         claim_token = NULL
       WHERE id = $2`,
      [req.user.id, listing.id]
    );

    // Upgrade customer → provider if needed so the dashboard shows correctly
    await client.query(
      `UPDATE users SET role = 'provider' WHERE id = $1 AND role NOT IN ('provider', 'admin')`,
      [req.user.id]
    );

    await client.query('COMMIT');

    // Re-fetch user so the returned token reflects any role upgrade
    const userRes = await client.query(
      `SELECT id, email, full_name, role, account_type, is_verified, bridge_points, is_partner
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    const user = userRes.rows[0];

    const tokenPayload = { id: user.id, role: user.role, country_code: req.user.country_code, is_partner: !!user.is_partner };
    const access_token  = signAccess(tokenPayload);
    const refresh_token = signRefresh(tokenPayload);

    await db.query('UPDATE users SET refresh_token = $1 WHERE id = $2', [refresh_token, user.id]);

    res.json({
      success: true,
      listing_id: listing.id,
      business_name: listing.business_name,
      access_token,
      refresh_token,
      user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role, is_verified: user.is_verified },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
