const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { loginRateLimit } = require('../middleware/rateLimit');
const { sendPasswordReset, sendWelcome, sendVerificationEmail, sendAdminNewUserNotification } = require('../services/emailService');
// awardReferralPoints intentionally not imported — referral bonus now fires on first transaction, not signup

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MINUTES    = 15;

function generateReferralCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

const router = express.Router();
const SALT_ROUNDS = 12;

function signAccess(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRY || '30d' });
}

function signRefresh(payload) {
  return jwt.sign(payload, process.env.JWT_REFRESH_SECRET, { expiresIn: process.env.JWT_REFRESH_EXPIRY || '90d' });
}

// POST /auth/register
router.post('/register', async (req, res, next) => {
  try {
    const { email, password, full_name, phone, account_type, role, ref_code, customer_type, visiting_country, visit_duration } = req.body;
    if (!email || !password || !full_name) {
      return res.status(400).json({ error: 'email, password, and full_name are required' });
    }

    const isVisitor = role === 'visitor';
    const userRole = role === 'provider' ? 'provider' : role === 'ad_merchant' ? 'ad_merchant' : 'customer';
    const subStatus = userRole === 'provider' ? 'free_period' : 'active';

    const existing = await db.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND country_code = $2', [email.trim(), req.countryCode]);
    if (existing.rows.length) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Generate unique referral code for this new user
    let referralCode;
    for (let i = 0; i < 5; i++) {
      const candidate = generateReferralCode();
      const clash = await db.query('SELECT id FROM users WHERE referral_code = $1', [candidate]);
      if (!clash.rows.length) { referralCode = candidate; break; }
    }
    if (!referralCode) referralCode = generateReferralCode(); // accept the tiny collision risk after 5 tries

    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = await db.query(
      `INSERT INTO users (id, country_code, email, password_hash, full_name, phone, account_type, role, subscription_status, referral_code, customer_type, is_visitor, is_verified, visiting_country, visit_duration)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id, email, full_name, role, account_type, is_verified, bridge_points, subscription_status, referral_code, customer_type, is_visitor, visiting_country, visit_duration`,
      [uuidv4(), req.countryCode, email, password_hash, full_name, phone || null, account_type || 'sole_trader', userRole, subStatus, referralCode,
       userRole === 'customer' ? (customer_type || 'customer') : null,
       isVisitor, isVisitor ? true : false,
       isVisitor ? (visiting_country || null) : null,
       isVisitor ? (visit_duration || null) : null]
    );

    const user = result.rows[0];
    const accessToken = signAccess({ id: user.id, role: user.role, country_code: req.countryCode, is_partner: false });
    const refreshToken = signRefresh({ id: user.id });

    await db.query('UPDATE users SET refresh_token = $1 WHERE id = $2', [refreshToken, user.id]);

    // Credit referrer if a valid ref_code was supplied
    if (ref_code) {
      const referrer = await db.query(
        'SELECT id, country_code FROM users WHERE referral_code = $1',
        [ref_code.toString().toUpperCase()]
      );
      if (referrer.rows.length && referrer.rows[0].id !== user.id) {
        await db.query('UPDATE users SET referred_by = $1 WHERE id = $2', [referrer.rows[0].id, user.id]);
        // Points awarded to referrer when this user completes their first transaction (not on signup)
      }
    }

    // Generate email verification token
    const verificationToken = uuidv4();
    const verificationExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await db.query(
      'UPDATE users SET verification_token = $1, verification_token_expires = $2 WHERE id = $3',
      [verificationToken, verificationExpires, user.id]
    );

    // Send verification + admin notification emails (non-blocking)
    sendVerificationEmail(user.email, user.full_name, verificationToken).catch(() => {});
    sendAdminNewUserNotification(user).catch(() => {});

    res.status(201).json({ user, access_token: accessToken, refresh_token: refreshToken });
  } catch (err) {
    next(err);
  }
});

// POST /auth/login
router.post('/login', loginRateLimit, async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const result = await db.query(
      `SELECT id, email, password_hash, full_name, role, account_type, is_verified, bridge_points,
              is_partner, is_visitor, visiting_country, visit_duration, failed_login_attempts, locked_until, created_at
       FROM users WHERE LOWER(email) = LOWER($1) AND country_code = $2`,
      [email.trim(), req.countryCode]
    );

    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    // Check account lockout
    if (user.locked_until && new Date() < new Date(user.locked_until)) {
      const mins = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      return res.status(429).json({ error: `Account locked due to too many failed attempts. Try again in ${mins} minute${mins !== 1 ? 's' : ''}.` });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      const attempts = (user.failed_login_attempts || 0) + 1;
      const lockout  = attempts >= MAX_LOGIN_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MINUTES * 60000) : null;
      await db.query(
        'UPDATE users SET failed_login_attempts = $1, locked_until = $2 WHERE id = $3',
        [attempts, lockout, user.id]
      );
      const remaining = MAX_LOGIN_ATTEMPTS - attempts;
      return res.status(401).json({
        error: remaining > 0
          ? `Invalid credentials. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`
          : `Too many failed attempts. Account locked for ${LOCKOUT_MINUTES} minutes.`,
      });
    }

    // Block unverified accounts older than 24 hours
    if (!user.is_verified && new Date(user.created_at) < new Date(Date.now() - 24 * 60 * 60 * 1000)) {
      return res.status(403).json({
        error: 'Please verify your email. Check your inbox or request a new link.',
        unverified: true,
      });
    }

    // Successful login — clear lockout
    const { password_hash, failed_login_attempts, locked_until, ...safeUser } = user;
    const accessToken  = signAccess({ id: user.id, role: user.role, country_code: req.countryCode, is_partner: !!user.is_partner });
    const refreshToken = signRefresh({ id: user.id });

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null;
    await db.query(
      'UPDATE users SET refresh_token = $1, last_login_ip = $2, failed_login_attempts = 0, locked_until = NULL WHERE id = $3',
      [refreshToken, ip, user.id]
    );

    res.json({ user: safeUser, access_token: accessToken, refresh_token: refreshToken });
  } catch (err) {
    next(err);
  }
});

// POST /auth/refresh
router.post('/refresh', async (req, res, next) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: 'refresh_token required' });

    let payload;
    try {
      payload = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const result = await db.query(
      `SELECT id, role, country_code, refresh_token,
              full_name, email, is_partner, is_suspended, is_verified,
              account_type, referral_code
       FROM users WHERE id = $1`,
      [payload.id]
    );
    const user = result.rows[0];

    if (!user || user.refresh_token !== refresh_token) {
      return res.status(401).json({ error: 'Token reuse detected' });
    }

    const newAccess = signAccess({ id: user.id, role: user.role, country_code: user.country_code, is_partner: !!user.is_partner });
    const newRefresh = signRefresh({ id: user.id });

    await db.query('UPDATE users SET refresh_token = $1 WHERE id = $2', [newRefresh, user.id]);

    const { refresh_token: _rt, password_hash: _ph, ...safeUser } = user;
    res.json({ access_token: newAccess, refresh_token: newRefresh, user: safeUser });
  } catch (err) {
    next(err);
  }
});

// POST /auth/change-password
router.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'current_password and new_password are required' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    const result = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const match = await bcrypt.compare(current_password, result.rows[0].password_hash);
    if (!match) return res.status(401).json({ error: 'Current password is incorrect' });
    const hash = await bcrypt.hash(new_password, SALT_ROUNDS);
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
    res.json({ message: 'Password updated successfully' });
  } catch (err) { next(err); }
});

// GET /auth/referral — referral code + stats for the authenticated user
router.get('/referral', requireAuth, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT referral_code,
        (SELECT COUNT(*) FROM users WHERE referred_by = $1) AS referral_count,
        (SELECT COALESCE(SUM(points_awarded), 0) FROM bridge_points_log
         WHERE user_id = $1 AND event_type IN ('referral_signup', 'referral_first_transaction')) AS points_from_referrals
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    const row = result.rows[0];
    res.json({
      referral_code: row.referral_code,
      referral_count: parseInt(row.referral_count, 10),
      points_from_referrals: parseInt(row.points_from_referrals, 10),
    });
  } catch (err) {
    next(err);
  }
});

// POST /auth/logout
router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    await db.query(
      'UPDATE users SET refresh_token = NULL, connek_refresh_token = NULL WHERE id = $1',
      [req.user.id]
    );
    res.json({ message: 'Logged out' });
  } catch (err) {
    next(err);
  }
});

// POST /auth/forgot-password
router.post('/forgot-password', async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });

    const result = await db.query(
      'SELECT id, full_name, email FROM users WHERE LOWER(email) = LOWER($1) AND country_code = $2',
      [email.trim(), req.countryCode]
    );

    // Always return success so attackers can't enumerate emails
    if (!result.rows.length) {
      return res.json({ message: 'If that email exists you will receive a reset link shortly.' });
    }

    const user = result.rows[0];
    const token    = crypto.randomBytes(32).toString('hex');
    const expires  = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await db.query(
      'UPDATE users SET password_reset_token = $1, password_reset_expires = $2 WHERE id = $3',
      [token, expires, user.id]
    );

    sendPasswordReset(user.email, user.full_name, token).catch(() => {});

    res.json({ message: 'If that email exists you will receive a reset link shortly.' });
  } catch (err) { next(err); }
});

// POST /auth/reset-password
router.post('/reset-password', async (req, res, next) => {
  try {
    const { token, new_password } = req.body;
    if (!token || !new_password) {
      return res.status(400).json({ error: 'token and new_password are required' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const result = await db.query(
      `SELECT id FROM users
       WHERE password_reset_token = $1 AND password_reset_expires > NOW()`,
      [token]
    );
    if (!result.rows.length) {
      return res.status(400).json({ error: 'Reset link is invalid or has expired. Please request a new one.' });
    }

    const hash = await bcrypt.hash(new_password, SALT_ROUNDS);
    await db.query(
      `UPDATE users SET password_hash = $1, password_reset_token = NULL,
         password_reset_expires = NULL, failed_login_attempts = 0, locked_until = NULL
       WHERE id = $2`,
      [hash, result.rows[0].id]
    );

    res.json({ message: 'Password reset successfully. You can now log in.' });
  } catch (err) { next(err); }
});

// GET /auth/verify-email?token=TOKEN
router.get('/verify-email', async (req, res, next) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'token is required' });

    const result = await db.query(
      `SELECT id FROM users
       WHERE verification_token = $1 AND verification_token_expires > NOW()`,
      [token]
    );

    if (!result.rows.length) {
      return res.status(400).json({ error: 'Verification link is invalid or has expired. Please request a new one.' });
    }

    await db.query(
      `UPDATE users
       SET is_verified = true, verification_token = NULL, verification_token_expires = NULL
       WHERE id = $1`,
      [result.rows[0].id]
    );

    return res.redirect('https://bridgepro.a3tech.uk/#/verified');
  } catch (err) { next(err); }
});

// POST /auth/resend-verification
router.post('/resend-verification', async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });

    const result = await db.query(
      `SELECT id, full_name, email, is_verified
       FROM users WHERE LOWER(email) = LOWER($1) AND country_code = $2`,
      [email.trim(), req.countryCode]
    );

    // Always return success to avoid enumeration
    if (!result.rows.length || result.rows[0].is_verified) {
      return res.json({ message: 'If your account exists and is unverified, a new link has been sent.' });
    }

    const user = result.rows[0];
    const verificationToken = uuidv4();
    const verificationExpires = new Date(Date.now() + 60 * 60 * 1000);

    await db.query(
      'UPDATE users SET verification_token = $1, verification_token_expires = $2 WHERE id = $3',
      [verificationToken, verificationExpires, user.id]
    );

    sendVerificationEmail(user.email, user.full_name, verificationToken).catch(() => {});

    res.json({ message: 'If your account exists and is unverified, a new link has been sent.' });
  } catch (err) { next(err); }
});

// POST /auth/connek-login
// Email exists  → log in normally.
// Email missing → auto-register as customer, then log in. One step, no redirect.
router.post('/connek-login', loginRateLimit, async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

    const existing = await db.query(
      `SELECT id, email, password_hash, full_name, role, account_type, is_verified, bridge_points,
              is_partner, failed_login_attempts, locked_until, created_at
       FROM users WHERE LOWER(email) = LOWER($1) AND country_code = $2`,
      [email.trim(), req.countryCode]
    );

    // ── Auto-register new user as customer ──────────────────────────────────
    if (!existing.rows.length) {
      const full_name = email.split('@')[0]
        .replace(/[._-]+/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase())
        .trim();

      let referralCode;
      for (let i = 0; i < 5; i++) {
        const candidate = generateReferralCode();
        const clash = await db.query('SELECT id FROM users WHERE referral_code = $1', [candidate]);
        if (!clash.rows.length) { referralCode = candidate; break; }
      }
      if (!referralCode) referralCode = generateReferralCode();

      const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
      const newUser = await db.query(
        `INSERT INTO users (id, country_code, email, password_hash, full_name, role, subscription_status, referral_code, customer_type)
         VALUES ($1, $2, $3, $4, $5, 'customer', 'active', $6, 'customer')
         RETURNING id, email, full_name, role, account_type, is_verified, bridge_points, subscription_status, referral_code, customer_type`,
        [uuidv4(), req.countryCode, email.trim(), password_hash, full_name, referralCode]
      );

      const user = newUser.rows[0];
      const accessToken  = signAccess({ id: user.id, role: user.role, country_code: req.countryCode, is_partner: false });
      const refreshToken = signRefresh({ id: user.id });
      await db.query('UPDATE users SET connek_refresh_token = $1 WHERE id = $2', [refreshToken, user.id]);

      const verificationToken   = uuidv4();
      const verificationExpires = new Date(Date.now() + 60 * 60 * 1000);
      await db.query(
        'UPDATE users SET verification_token = $1, verification_token_expires = $2 WHERE id = $3',
        [verificationToken, verificationExpires, user.id]
      );
      sendVerificationEmail(user.email, user.full_name, verificationToken).catch(() => {});
      sendAdminNewUserNotification(user).catch(() => {});

      return res.status(201).json({ user, access_token: accessToken, refresh_token: refreshToken });
    }

    // ── Existing user — normal login ─────────────────────────────────────────
    const user = existing.rows[0];

    if (user.locked_until && new Date() < new Date(user.locked_until)) {
      const mins = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      return res.status(429).json({ error: `Account locked. Try again in ${mins} minute${mins !== 1 ? 's' : ''}.` });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      const attempts = (user.failed_login_attempts || 0) + 1;
      const lockout  = attempts >= MAX_LOGIN_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MINUTES * 60000) : null;
      await db.query(
        'UPDATE users SET failed_login_attempts = $1, locked_until = $2 WHERE id = $3',
        [attempts, lockout, user.id]
      );
      const remaining = MAX_LOGIN_ATTEMPTS - attempts;
      return res.status(401).json({
        error: remaining > 0
          ? `Invalid credentials. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`
          : `Too many failed attempts. Account locked for ${LOCKOUT_MINUTES} minutes.`,
      });
    }

    if (!user.is_verified && new Date(user.created_at) < new Date(Date.now() - 24 * 60 * 60 * 1000)) {
      return res.status(403).json({ error: 'Please verify your email to continue.', unverified: true });
    }

    const { password_hash, failed_login_attempts, locked_until, ...safeUser } = user;
    const accessToken  = signAccess({ id: user.id, role: user.role, country_code: req.countryCode, is_partner: !!user.is_partner });
    const refreshToken = signRefresh({ id: user.id });

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null;
    await db.query(
      'UPDATE users SET connek_refresh_token = $1, last_login_ip = $2, failed_login_attempts = 0, locked_until = NULL WHERE id = $3',
      [refreshToken, ip, user.id]
    );

    res.json({ user: safeUser, access_token: accessToken, refresh_token: refreshToken });
  } catch (err) {
    next(err);
  }
});

// POST /auth/connek-sso
// Called by Connek when it finds a connek_session cookie set by the BridgePro frontend.
// Verifies the existing access token and returns a fresh access + refresh token pair so
// Connek can store them locally without the user re-entering credentials.
router.post('/connek-sso', requireAuth, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT id, email, full_name, role, country_code, is_partner, is_verified,
              bridge_points, account_type, referral_code
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!result.rows.length) return res.status(401).json({ error: 'User not found' });

    const user = result.rows[0];
    const newAccess  = signAccess({ id: user.id, role: user.role, country_code: user.country_code, is_partner: !!user.is_partner });
    const newRefresh = signRefresh({ id: user.id });
    await db.query('UPDATE users SET connek_refresh_token = $1 WHERE id = $2', [newRefresh, user.id]);

    res.json({ user, access_token: newAccess, refresh_token: newRefresh });
  } catch (err) {
    next(err);
  }
});

// POST /auth/connek-refresh
// Separate refresh rotation for Connek — uses connek_refresh_token column so it never
// clobbers the BridgePro refresh_token used by the main frontend.
router.post('/connek-refresh', async (req, res, next) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: 'refresh_token required' });

    let payload;
    try {
      payload = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const result = await db.query(
      `SELECT id, role, country_code, connek_refresh_token,
              full_name, email, is_partner, is_suspended, is_verified,
              account_type, referral_code
       FROM users WHERE id = $1`,
      [payload.id]
    );
    const user = result.rows[0];

    if (!user || user.connek_refresh_token !== refresh_token) {
      return res.status(401).json({ error: 'Token reuse detected' });
    }

    const newAccess  = signAccess({ id: user.id, role: user.role, country_code: user.country_code, is_partner: !!user.is_partner });
    const newRefresh = signRefresh({ id: user.id });

    await db.query('UPDATE users SET connek_refresh_token = $1 WHERE id = $2', [newRefresh, user.id]);

    const { connek_refresh_token: _cr, password_hash: _ph, ...safeUser } = user;
    res.json({ access_token: newAccess, refresh_token: newRefresh, user: safeUser });
  } catch (err) {
    next(err);
  }
});

// GET /auth/verify — check Bearer token and return current user (used by Connek WPAs)
router.get('/verify', requireAuth, async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT id, full_name, email, role, country_code, is_partner, bridge_points, account_type, referral_code, is_visitor, visiting_country, visit_duration
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'User not found' });
    res.json({ user: r.rows[0] });
  } catch (err) { next(err); }
});

// POST /auth/ott — issue a one-time token for WPA auth (returns current access token)
router.post('/ott', requireAuth, (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '') || '';
  res.json({ token });
});

// POST /auth/verify-ott — verify OTT and return user session (OTT == access token for now)
router.post('/verify-ott', async (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ valid: false, error: 'token required' });
    let payload;
    try { payload = jwt.verify(token, process.env.JWT_SECRET); } catch {
      return res.status(401).json({ valid: false, error: 'Invalid or expired token' });
    }
    const r = await db.query(
      `SELECT id, full_name, email, role, country_code, is_partner, bridge_points, account_type, referral_code, is_visitor, visiting_country, visit_duration
       FROM users WHERE id = $1`,
      [payload.id]
    );
    if (!r.rows.length) return res.status(401).json({ valid: false, error: 'User not found' });
    res.json({ valid: true, user: r.rows[0], session_token: token });
  } catch (err) { next(err); }
});

module.exports = router;
