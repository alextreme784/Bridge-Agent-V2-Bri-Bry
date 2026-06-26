const express = require('express');
const crypto  = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');
const { generateCreditMemoPDF } = require('../services/financePdf');
const generateReceiptPdf = require('../utils/generateReceiptPdf');
const { awardPointsForTransaction } = require('../services/pointsService');
const { signDocument } = require('../utils/docSignature');
const Anthropic = require('@anthropic-ai/sdk');
const { notify } = require('../services/notificationService');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const router = express.Router();

// Schema migrations
db.query(`
  CREATE TABLE IF NOT EXISTS provider_documents (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type        VARCHAR(30) NOT NULL,
    label       TEXT NOT NULL,
    download_url TEXT NOT NULL,
    meta        JSONB DEFAULT '{}',
    created_at  TIMESTAMP DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_pdocs_user_created
    ON provider_documents(user_id, created_at DESC);
`).catch(err => console.error('[finance] provider_documents migration:', err.message));

db.query(`
  ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_flagged       BOOLEAN DEFAULT false;
  ALTER TABLE transactions ADD COLUMN IF NOT EXISTS review_required  BOOLEAN DEFAULT false;
`).catch(err => console.error('[finance] transactions flag columns:', err.message));

db.query(`
  CREATE TABLE IF NOT EXISTS transaction_risk_assessments (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_id     UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    risk_score         INT NOT NULL,
    reasoning          TEXT,
    category           TEXT,
    recommended_action TEXT,
    model_used         TEXT,
    created_at         TIMESTAMP DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_tra_transaction_id
    ON transaction_risk_assessments(transaction_id);
`).catch(err => console.error('[finance] transaction_risk_assessments migration:', err.message));

db.query(`
  ALTER TABLE transaction_risk_assessments ADD COLUMN IF NOT EXISTS tools_used TEXT;
`).catch(err => console.error('[finance] transaction_risk_assessments tools_used migration:', err.message));

const DISCLAIMER =
  'BridgePro FOS is a data-readiness infrastructure provider and not a credit rating agency. ' +
  'This report is for information purposes and based on self-reported and platform-verified data. ' +
  'Independent verification is recommended prior to any credit decision.';

const COUNTRY_NAMES = {
  SVG: 'Saint Vincent and the Grenadines',
  GRD: 'Grenada',
  BRB: 'Barbados',
  SLU: 'Saint Lucia',
  JAM: 'Jamaica',
  TTO: 'Trinidad and Tobago',
  ATG: 'Antigua and Barbuda',
  SKN: 'Saint Kitts and Nevis',
  DMA: 'Dominica',
  BLZ: 'Belize',
  GUY: 'Guyana',
  SUR: 'Suriname',
  HTI: 'Haiti',
};

function buildLenderSummary({ businessName, principal, category, countryCode, tenureDays,
  verifiedCount, totalVolume, avgTicket, successRate, avgRating, reviewCount, engagements, memberSince }) {

  const jurisdiction = COUNTRY_NAMES[countryCode] || countryCode;
  const regDate = memberSince
    ? new Date(memberSince).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : 'N/A';
  const entity = businessName !== principal ? `${businessName} (Principal: ${principal})` : principal;

  const hasRevenue    = totalVolume > 0;
  const hasActivity   = engagements > 0 || reviewCount > 0;
  const hasReputation = reviewCount >= 3;

  let financialNarrative;
  if (!hasRevenue && !hasActivity) {
    financialNarrative =
      `The applicant is an early-stage service provider registered on the BridgePro marketplace platform ` +
      `as of ${regDate}. No verified transaction history has been recorded to date. The platform profile ` +
      `has been formally established; the entity is positioned to commence verified transaction activity ` +
      `upon first client engagement. Lenders are advised to supplement this report with external income ` +
      `verification, business registration documents, and collateral assessment as applicable under ` +
      `ECCU credit guidelines.`;
  } else if (!hasRevenue && hasActivity) {
    financialNarrative =
      `The applicant has recorded ${engagements} confirmed service engagement${engagements !== 1 ? 's' : ''} ` +
      `on the BridgePro platform since registration on ${regDate}. Verified payment transactions are pending ` +
      `or in progress. ${hasReputation
        ? `Customer satisfaction is rated ${avgRating.toFixed(1)}/5.0 across ${reviewCount} verified ` +
          `review${reviewCount !== 1 ? 's' : ''}, with ${successRate}% positive feedback — indicating ` +
          `demonstrated service delivery capability.`
        : ''}`;
  } else {
    const activityNote = engagements > 0
      ? ` The applicant has recorded ${engagements} confirmed service engagement${engagements !== 1 ? 's' : ''} across the review period.`
      : '';
    const reputationNote = hasReputation
      ? ` Customer satisfaction is rated ${avgRating.toFixed(1)}/5.0 across ${reviewCount} verified review${reviewCount !== 1 ? 's' : ''} (${Math.round((reviewCount > 0 ? (avgRating >= 4 ? 1 : 0) : 0) * 100)}% positive).`
      : reviewCount > 0
        ? ` Platform reviews: ${reviewCount} rating${reviewCount !== 1 ? 's' : ''} averaging ${avgRating.toFixed(1)}/5.0.`
        : '';
    const riskNote = successRate >= 80
      ? ' No material dispute flags have been recorded.'
      : successRate > 0
        ? ` Transaction dispute rate is ${100 - successRate}%; lenders may wish to request additional documentation.`
        : '';

    financialNarrative =
      `${entity} has maintained an active service presence on the BridgePro marketplace for ${tenureDays} day${tenureDays !== 1 ? 's' : ''} ` +
      `(registered ${regDate}), operating within the ${category || 'services'} sector in ${jurisdiction}. ` +
      `Over this period, the applicant has completed ${verifiedCount} platform-verified transaction${verifiedCount !== 1 ? 's' : ''}, ` +
      `generating aggregate verified revenue of XCD $${totalVolume.toFixed(2)} at an average ticket value of ` +
      `XCD $${avgTicket.toFixed(2)}. The platform-recorded transaction success rate stands at ${successRate}%.` +
      activityNote + reputationNote + riskNote;
  }

  return (
    `MSME CREDIT APPLICANT PROFILE — CONFIDENTIAL\n\n` +
    `Entity: ${entity}\n` +
    `Category: ${category || 'Service Provider'} | Jurisdiction: ${jurisdiction} (${countryCode})\n` +
    `Platform Registration: ${regDate} (${tenureDays} day${tenureDays !== 1 ? 's' : ''} active)\n\n` +
    `Financial Summary:\n${financialNarrative}\n\n` +
    `Data Source: BridgePro Digital Marketplace — verified peer-to-peer transaction ledger. ` +
    `This profile is system-generated and reflects platform-recorded activity only. ` +
    `Independent verification recommended prior to credit decision.`
  );
}

// ── Underwriting reasons ──────────────────────────────────────────────────────
function buildUnderwritingReasons({
  tenureDays, verifiedCount, totalVolume, avgTicket,
  avgRating, reviewCount, positiveRate, successRate,
  totalCount, flaggedCount, isVerified,
  employeeCount, payrollRunCount, payrollConsistencyMonths,
}) {
  const reasons = [];

  // Tenure
  if (tenureDays < 30) {
    reasons.push({ signal: 'warning', label: 'New Business',
      detail: 'Platform registration is less than 30 days old. Platform history is insufficient for independent tenure assessment.' });
  } else if (tenureDays < 90) {
    reasons.push({ signal: 'neutral', label: 'Early Stage',
      detail: `Business has ${tenureDays} days of verified platform history. Short track record; trending to develop.` });
  } else if (tenureDays < 365) {
    reasons.push({ signal: 'neutral', label: 'Developing History',
      detail: `Business has ${Math.floor(tenureDays / 30)} months of platform history. Consistent activity will strengthen this signal.` });
  } else {
    const yrs = Math.floor(tenureDays / 365);
    reasons.push({ signal: 'positive', label: 'Established Presence',
      detail: `Business has maintained an active platform presence for over ${yrs} year${yrs > 1 ? 's' : ''}. Long-term stability indicator.` });
  }

  // Transaction volume
  if (verifiedCount === 0) {
    reasons.push({ signal: 'warning', label: 'No Verified Revenue',
      detail: 'No completed and verified transactions are on record. Revenue cannot be substantiated from platform data alone.' });
  } else if (verifiedCount < 5) {
    reasons.push({ signal: 'neutral', label: 'Limited Transaction History',
      detail: `${verifiedCount} verified transaction${verifiedCount > 1 ? 's' : ''} recorded (XCD $${totalVolume.toFixed(2)} total). A stronger credit signal requires 5+ completed jobs.` });
  } else if (verifiedCount < 15) {
    reasons.push({ signal: 'positive', label: 'Active Transaction Record',
      detail: `${verifiedCount} verified transactions totalling XCD $${totalVolume.toFixed(2)} at an average of XCD $${avgTicket.toFixed(2)} per job.` });
  } else {
    reasons.push({ signal: 'positive', label: 'High Transaction Consistency',
      detail: `${verifiedCount} verified transactions across the platform totalling XCD $${totalVolume.toFixed(2)} in verified revenue. Strong commercial activity.` });
  }

  // Customer reputation
  if (reviewCount === 0) {
    reasons.push({ signal: 'neutral', label: 'No Customer Reviews',
      detail: 'No platform reviews submitted. Customer satisfaction cannot be assessed from on-platform data.' });
  } else if (avgRating < 3.5) {
    reasons.push({ signal: 'warning', label: 'Below-Average Rating',
      detail: `Customer satisfaction score is ${avgRating.toFixed(1)}/5.0 across ${reviewCount} review${reviewCount > 1 ? 's' : ''}. Suggests potential service delivery concerns.` });
  } else if (avgRating < 4.0) {
    reasons.push({ signal: 'neutral', label: 'Satisfactory Reputation',
      detail: `Customer rating is ${avgRating.toFixed(1)}/5.0 across ${reviewCount} review${reviewCount > 1 ? 's' : ''}.` });
  } else {
    reasons.push({ signal: 'positive', label: 'Strong Customer Reputation',
      detail: `Customer rating is ${avgRating.toFixed(1)}/5.0 across ${reviewCount} review${reviewCount > 1 ? 's' : ''} with ${positiveRate}% positive feedback.` });
  }

  // Dispute / success rate
  if (totalCount > 0) {
    if (successRate >= 90) {
      reasons.push({ signal: 'positive', label: 'Excellent Transaction Record',
        detail: `${successRate}% of recorded transactions are verified and completed. Negligible dispute risk.` });
    } else if (successRate >= 80) {
      reasons.push({ signal: 'positive', label: 'Clean Transaction Record',
        detail: `${successRate}% transaction success rate. Low dispute history on record.` });
    } else {
      reasons.push({ signal: 'warning', label: 'Elevated Dispute Rate',
        detail: `Transaction success rate is ${successRate}%. ${100 - successRate}% of transactions remain unverified or disputed. Independent review recommended.` });
    }
  }

  // Identity verification
  if (isVerified) {
    reasons.push({ signal: 'positive', label: 'Identity Verified',
      detail: 'Provider identity has been confirmed through the BridgePro verification process.' });
  } else {
    reasons.push({ signal: 'neutral', label: 'Identity Unverified',
      detail: 'Platform identity not yet confirmed. Lenders should verify independently before proceeding.' });
  }

  // Flagged anomalies
  if (flaggedCount > 0) {
    reasons.push({ signal: 'warning', label: `${flaggedCount} Transaction${flaggedCount > 1 ? 's' : ''} Under Anomaly Review`,
      detail: `${flaggedCount} manual transaction${flaggedCount > 1 ? 's' : ''} flagged by velocity-detection and excluded from verified revenue figures.` });
  }

  // Employee stability
  if (employeeCount !== undefined) {
    if (employeeCount === 0) {
      reasons.push({ signal: 'neutral', label: 'No Payroll Records',
        detail: 'No employee or payroll data on record. Sole trader or payroll not yet connected to BridgePro Ledger.' });
    } else if (employeeCount < 3) {
      reasons.push({ signal: 'positive', label: `${employeeCount} Active Employee${employeeCount > 1 ? 's' : ''} on Record`,
        detail: `Employer record indicates ${employeeCount} employee${employeeCount > 1 ? 's' : ''}. Payroll commitments substantiated on-platform.` });
    } else {
      reasons.push({ signal: 'positive', label: `Established Workforce (${employeeCount} Employees)`,
        detail: `${employeeCount} active employees on payroll ledger. Demonstrates sustained business scale and employer responsibility.` });
    }
  }

  // Consistent payroll history
  if (payrollRunCount !== undefined) {
    if (payrollRunCount === 0) {
      // no signal — already covered by employee stability
    } else if (payrollConsistencyMonths >= 4) {
      reasons.push({ signal: 'positive', label: 'Consistent Payroll History',
        detail: `${payrollRunCount} payroll run${payrollRunCount > 1 ? 's' : ''} recorded with consistent monthly cadence over the past 6 months. Strong indicator of ongoing business operations and cash-flow management.` });
    } else if (payrollRunCount >= 1) {
      reasons.push({ signal: 'neutral', label: `${payrollRunCount} Payroll Run${payrollRunCount > 1 ? 's' : ''} Recorded`,
        detail: `${payrollRunCount} payroll run${payrollRunCount > 1 ? 's' : ''} on ledger. Consistent monthly payroll over 4+ months will strengthen this signal significantly.` });
    }
  }

  return reasons;
}

// ── Shared data-fetching helper ───────────────────────────────────────────────
async function fetchProfileData(provider_id, fallbackCountryCode) {
  const [txRow, apptRow, revRow, provRows, payrollRow] = await Promise.all([
    db.query(`
      SELECT
        COUNT(*)  FILTER (WHERE is_verified = true  AND (is_flagged IS NOT TRUE)) AS verified_count,
        COUNT(*)  FILTER (WHERE                          is_flagged IS NOT TRUE)  AS total_count,
        COUNT(*)  FILTER (WHERE                          is_flagged IS TRUE)      AS flagged_count,
        COALESCE(SUM(amount) FILTER (WHERE is_verified = true AND (is_flagged IS NOT TRUE)), 0) AS total_volume,
        COALESCE(AVG(amount) FILTER (WHERE is_verified = true AND (is_flagged IS NOT TRUE)), 0) AS avg_ticket,
        MIN(created_at) FILTER (WHERE is_verified = true AND (is_flagged IS NOT TRUE)) AS first_transaction,
        MAX(created_at) FILTER (WHERE is_verified = true AND (is_flagged IS NOT TRUE)) AS last_transaction
      FROM transactions WHERE provider_id = $1`, [provider_id]),

    db.query(`
      SELECT COUNT(*) AS engagement_count FROM appointments
      WHERE provider_id = $1
        AND status IN ('scheduled','confirmed','pending_approval','completed')`, [provider_id]),

    db.query(`
      SELECT COUNT(*) AS review_count,
             COALESCE(AVG(r.rating), 0) AS avg_rating,
             COUNT(*) FILTER (WHERE r.rating >= 4) AS positive_count
      FROM reviews r JOIN listings l ON l.id = r.listing_id
      WHERE l.user_id = $1`, [provider_id]),

    db.query(`
      SELECT u.full_name, u.email, u.created_at AS member_since,
             u.is_verified,
             l.business_name, l.category, l.country_code
      FROM users u
      LEFT JOIN listings l ON l.user_id = u.id
      WHERE u.id = $1
      ORDER BY l.is_active DESC NULLS LAST, l.created_at DESC
      LIMIT 1`, [provider_id]),

    db.query(`
      SELECT
        (SELECT COUNT(*) FROM employees WHERE provider_id = $1 AND is_active = true) AS employee_count,
        (SELECT COUNT(*) FROM payroll_runs WHERE provider_id = $1)                   AS payroll_run_count,
        (SELECT COUNT(DISTINCT DATE_TRUNC('month', period_start))
         FROM payroll_runs
         WHERE provider_id = $1
           AND period_start >= NOW() - INTERVAL '6 months')                          AS payroll_consistency_months
    `, [provider_id]).catch(() => ({ rows: [{ employee_count: 0, payroll_run_count: 0, payroll_consistency_months: 0 }] })),
  ]);

  if (!provRows.rows.length) return null;

  const prov          = provRows.rows[0];
  const tx            = txRow.rows[0];
  const appt          = apptRow.rows[0];
  const rev           = revRow.rows[0];
  const pr            = payrollRow.rows[0] || {};
  const employeeCount       = parseInt(pr.employee_count,            10) || 0;
  const payrollRunCount     = parseInt(pr.payroll_run_count,         10) || 0;
  const payrollConsistencyMonths = parseInt(pr.payroll_consistency_months, 10) || 0;
  const verifiedCount = parseInt(tx.verified_count, 10)     || 0;
  const totalCount    = parseInt(tx.total_count,    10)     || 0;
  const flaggedCount  = parseInt(tx.flagged_count,  10)     || 0;
  const totalVolume   = parseFloat(tx.total_volume)          || 0;
  const avgTicket     = parseFloat(tx.avg_ticket)            || 0;
  const engagements   = parseInt(appt.engagement_count, 10) || 0;
  const reviewCount   = parseInt(rev.review_count,  10)     || 0;
  const avgRating     = parseFloat(rev.avg_rating)           || 0;
  const positiveCount = parseInt(rev.positive_count, 10)    || 0;
  const successRate   = totalCount > 0 ? Math.round((verifiedCount / totalCount) * 100) : 0;
  const positiveRate  = reviewCount > 0 ? Math.round((positiveCount / reviewCount) * 100) : 0;
  const tenureDays    = prov.member_since
    ? Math.floor((Date.now() - new Date(prov.member_since).getTime()) / 86_400_000) : 0;
  const countryCode   = prov.country_code || fallbackCountryCode;
  const isVerified    = !!prov.is_verified;

  const underwritingReasons = buildUnderwritingReasons({
    tenureDays, verifiedCount, totalVolume, avgTicket,
    avgRating, reviewCount, positiveRate, successRate,
    totalCount, flaggedCount, isVerified,
    employeeCount, payrollRunCount, payrollConsistencyMonths,
  });

  return {
    generated_at:   new Date().toISOString(),
    schema_version: '1.1',
    disclaimer:     DISCLAIMER,
    provider: {
      id:            provider_id,
      full_name:     prov.full_name,
      business_name: prov.business_name || null,
      category:      prov.category      || null,
      country_code:  countryCode,
      email:         prov.email,
      member_since:  prov.member_since,
      is_verified:   isVerified,
    },
    financial_metrics: {
      total_volume:    { value: +totalVolume.toFixed(2), currency: 'XCD', label: 'Total Verified Revenue' },
      job_count:       { value: verifiedCount,           label: 'Completed & Verified Transactions' },
      avg_ticket_size: { value: +avgTicket.toFixed(2),   currency: 'XCD', label: 'Average Transaction Value' },
      success_rate:    { value: successRate,             unit: '%', label: 'Transaction Success Rate' },
      first_transaction:           tx.first_transaction || null,
      last_transaction:            tx.last_transaction  || null,
      flagged_transactions_excluded: flaggedCount,
    },
    service_metrics: {
      total_service_engagements: engagements,
      total_reviews:             reviewCount,
      avg_customer_rating:       +avgRating.toFixed(2),
      positive_review_rate:      { value: positiveRate, unit: '%' },
    },
    creditworthiness_signals: {
      platform_tenure_days:      tenureDays,
      has_verified_revenue:      totalVolume > 0,
      consistent_activity:       verifiedCount >= 5,
      strong_reputation:         avgRating >= 4.0,
      low_dispute_risk:          successRate >= 80,
      identity_verified:         isVerified,
      employee_stability:        employeeCount > 0,
      consistent_payroll_history: payrollConsistencyMonths >= 4,
    },
    workforce: {
      active_employees:          employeeCount,
      payroll_runs_total:        payrollRunCount,
      payroll_consistency_months: payrollConsistencyMonths,
    },
    underwriting_reasons: underwritingReasons,
    lender_summary: buildLenderSummary({
      businessName: prov.business_name || prov.full_name,
      principal:    prov.full_name,
      category:     prov.category,
      countryCode,
      tenureDays,
      verifiedCount,
      totalVolume,
      avgTicket,
      successRate,
      avgRating,
      reviewCount,
      engagements,
      memberSince: prov.member_since,
    }),
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /finance/msme-credit-profile/:provider_id
 * Access: admin or partner role.
 */
router.get('/msme-credit-profile/:provider_id', requireAuth, async (req, res, next) => {
  try {
    const { role } = req.user;
    if (role !== 'admin' && role !== 'partner') {
      return res.status(403).json({ error: 'Admin or lender-partner access required.' });
    }
    const data = await fetchProfileData(req.params.provider_id, req.countryCode);
    if (!data) return res.status(404).json({ error: 'Provider not found.' });
    res.json({ MSME_Credit_Profile: data });
  } catch (err) { next(err); }
});

/**
 * GET /finance/my-credit-profile
 * Self-service — authenticated provider views their own profile.
 */
router.get('/my-credit-profile', requireAuth, async (req, res, next) => {
  try {
    const { role, id } = req.user;
    if (role !== 'provider' && role !== 'admin') {
      return res.status(403).json({ error: 'Provider access required.' });
    }
    const data = await fetchProfileData(id, req.countryCode);
    if (!data) return res.status(404).json({ error: 'Provider not found.' });
    res.json({ MSME_Credit_Profile: data });
  } catch (err) { next(err); }
});

/**
 * GET /finance/export-pdf/mine
 * Provider self-service PDF download.
 */
router.get('/export-pdf/mine', requireAuth, async (req, res, next) => {
  try {
    const { role, id } = req.user;
    if (role !== 'provider' && role !== 'admin') {
      return res.status(403).json({ error: 'Provider access required.' });
    }
    const data = await fetchProfileData(id, req.countryCode);
    if (!data) return res.status(404).json({ error: 'Provider not found.' });

    const { verifyUrl } = await signDocument({
      docType: 'credit_memo', docRef: `credit-${id}`, providerId: id,
      countryCode: req.countryCode,
      metadata: { issued_by: 'BridgePro Marketplace', issued_to: data.provider.business_name || data.provider.full_name },
    });
    const pdfBuffer = await generateCreditMemoPDF(data, verifyUrl);
    const slug = (data.provider.business_name || data.provider.full_name)
      .replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').toLowerCase();
    const filename = `bridgepro-credit-profile-${slug}.pdf`;

    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length':      pdfBuffer.length,
      'Cache-Control':       'no-store',
    });
    res.end(pdfBuffer);
  } catch (err) { next(err); }
});

/**
 * GET /finance/export-pdf/:provider_id
 * Admin / partner PDF download for any provider.
 */
router.get('/export-pdf/:provider_id', requireAuth, async (req, res, next) => {
  try {
    const { role } = req.user;
    if (role !== 'admin' && role !== 'partner') {
      return res.status(403).json({ error: 'Admin or lender-partner access required.' });
    }
    const data = await fetchProfileData(req.params.provider_id, req.countryCode);
    if (!data) return res.status(404).json({ error: 'Provider not found.' });

    const { verifyUrl } = await signDocument({
      docType: 'credit_memo', docRef: `credit-${req.params.provider_id}`, providerId: req.params.provider_id,
      countryCode: req.countryCode,
      metadata: { issued_by: 'BridgePro Marketplace', issued_to: data.provider.business_name || data.provider.full_name },
    });
    const pdfBuffer = await generateCreditMemoPDF(data, verifyUrl);
    const slug = (data.provider.business_name || data.provider.full_name)
      .replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').toLowerCase();
    const filename = `bridgepro-credit-profile-${slug}.pdf`;

    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length':      pdfBuffer.length,
      'Cache-Control':       'no-store',
    });
    res.end(pdfBuffer);
  } catch (err) { next(err); }
});

// ── API Key Management ────────────────────────────────────────────────────────

/**
 * GET /finance/api-keys — list the authenticated provider's API keys
 */
router.get('/api-keys', requireAuth, async (req, res, next) => {
  try {
    const { role, id } = req.user;
    if (role !== 'provider' && role !== 'admin') {
      return res.status(403).json({ error: 'Provider access required.' });
    }
    const { rows } = await db.query(
      `SELECT id, label, api_key, is_active, last_used_at, created_at
       FROM provider_api_keys
       WHERE provider_id = $1
       ORDER BY created_at DESC`,
      [id]
    );
    res.json({ api_keys: rows });
  } catch (err) { next(err); }
});

/**
 * POST /finance/api-keys — generate a new API key for the authenticated provider
 */
router.post('/api-keys', requireAuth, async (req, res, next) => {
  try {
    const { role, id } = req.user;
    if (role !== 'provider') {
      return res.status(403).json({ error: 'Provider access required.' });
    }
    const label   = (req.body.label || 'Default').toString().slice(0, 100);
    const apiKey  = `bpk_${crypto.randomBytes(28).toString('hex')}`; // bpk_ + 56 hex chars
    const { rows } = await db.query(
      `INSERT INTO provider_api_keys (provider_id, api_key, label)
       VALUES ($1, $2, $3) RETURNING id, label, api_key, is_active, created_at`,
      [id, apiKey, label]
    );
    res.status(201).json({ api_key: rows[0] });
  } catch (err) { next(err); }
});

/**
 * DELETE /finance/api-keys/:keyId — revoke an API key (soft-delete)
 */
router.delete('/api-keys/:keyId', requireAuth, async (req, res, next) => {
  try {
    const { role, id } = req.user;
    if (role !== 'provider' && role !== 'admin') {
      return res.status(403).json({ error: 'Provider access required.' });
    }
    const result = await db.query(
      `UPDATE provider_api_keys SET is_active = false
       WHERE id = $1 AND provider_id = $2 RETURNING id`,
      [req.params.keyId, id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Key not found.' });
    res.json({ success: true, message: 'API key revoked.' });
  } catch (err) { next(err); }
});

/**
 * GET /finance/documents/mine
 * List all documents generated for the authenticated provider.
 */
router.get('/documents/mine', requireAuth, async (req, res, next) => {
  try {
    const { role, id } = req.user;
    if (role !== 'provider' && role !== 'admin') {
      return res.status(403).json({ error: 'Provider access required.' });
    }
    console.log('[documents/mine] user id:', id, 'role:', role);
    const { rows } = await db.query(
      `(
        SELECT id::text, type, label, download_url, meta::text, created_at
        FROM provider_documents
        WHERE user_id = $1
       )
       UNION ALL
       (
        SELECT id::text,
               'receipt' AS type,
               'Receipt – ' || COALESCE(NULLIF(guest_customer_name,''), 'Customer') || ' – ' ||
                 TO_CHAR(created_at AT TIME ZONE 'UTC', 'DD Mon YYYY') AS label,
               '/api/v1/transactions/' || id || '/download-doc?type=receipt' AS download_url,
               NULL AS meta,
               created_at
        FROM transactions
        WHERE provider_id = $1 AND receipt_doc_url IS NOT NULL
       )
       UNION ALL
       (
        SELECT id::text,
               'invoice' AS type,
               'Invoice – ' || COALESCE(NULLIF(guest_customer_name,''), 'Customer') || ' – ' ||
                 TO_CHAR(created_at AT TIME ZONE 'UTC', 'DD Mon YYYY') AS label,
               '/api/v1/transactions/' || id || '/download-doc?type=invoice' AS download_url,
               NULL AS meta,
               created_at
        FROM transactions
        WHERE provider_id = $1 AND invoice_doc_url IS NOT NULL
       )
       ORDER BY created_at DESC
       LIMIT 200`,
      [id]
    );
    console.log('[documents/mine] returned', rows.length, 'rows');
    res.json({ documents: rows });
  } catch (err) { next(err); }
});

// ── Anomaly detection helpers ─────────────────────────────────────────────────

async function getProviderDisputeHistory(providerId) {
  const { rows } = await db.query(`
    SELECT
      COUNT(*)                                     AS total,
      MAX(created_at)                              AS most_recent,
      COUNT(*) FILTER (WHERE status = 'resolved')  AS upheld,
      COUNT(*) FILTER (WHERE status = 'dismissed') AS dismissed
    FROM customer_dispute_flags
    WHERE provider_id = $1
  `, [providerId]);
  const r = rows[0];
  return {
    total_disputes:      parseInt(r.total, 10),
    most_recent_dispute: r.most_recent || null,
    upheld_count:        parseInt(r.upheld, 10),
    dismissed_count:     parseInt(r.dismissed, 10),
  };
}

async function checkAppointmentCorrelation(transactionId, providerId, timestamp) {
  const { rows } = await db.query(`
    SELECT id, title, appointment_at, status
    FROM appointments
    WHERE provider_id = $1
      AND appointment_at BETWEEN $2::timestamptz - INTERVAL '4 hours'
                              AND $2::timestamptz + INTERVAL '4 hours'
    ORDER BY ABS(EXTRACT(EPOCH FROM (appointment_at - $2::timestamptz)))
    LIMIT 1
  `, [providerId, timestamp]);
  if (rows.length === 0) return { match_found: false };
  return {
    match_found: true,
    appointment: {
      id:             rows[0].id,
      title:          rows[0].title,
      appointment_at: rows[0].appointment_at,
      status:         rows[0].status,
    },
  };
}

const RISK_TOOLS = [
  {
    name: 'getProviderDisputeHistory',
    description:
      'Returns dispute history for a provider: total disputes, most recent date, ' +
      'upheld count (resolved against provider) and dismissed count (found in provider\'s favour). ' +
      'CALL THIS when any of: prior_flagged_transactions > 0 in context; velocity_60min_count ≥ 1; ' +
      'or amount is ≥ 30% above avg_amount_xcd. ' +
      'This is a fast enrichment call — even a clean result is useful: it confirms a 20-pt downward adjustment is safe. ' +
      'High upheld disputes (≥ 2) push the score up 15–25 pts; zero upheld disputes allows a 10–20 pt reduction.',
    input_schema: {
      type: 'object',
      properties: {
        provider_id: { type: 'string', description: 'From provider.id in the context JSON' },
      },
      required: ['provider_id'],
    },
  },
  {
    name: 'checkAppointmentCorrelation',
    description:
      'Checks whether the provider had a scheduled appointment within ±4 hours of this transaction. ' +
      'CALL THIS when velocity_60min_count ≥ 1 AND this_tx_vs_avg_pct > 30 (amount is 30%+ above average). ' +
      'A confirmed scheduled appointment is the strongest possible legitimacy signal — it reduces the score by up to 20 pts. ' +
      'Call this after getProviderDisputeHistory, especially when dispute history is clean.',
    input_schema: {
      type: 'object',
      properties: {
        transaction_id: { type: 'string', description: 'From transaction.id in the context JSON' },
        provider_id:    { type: 'string', description: 'From provider.id in the context JSON' },
        timestamp:      { type: 'string', description: 'From transaction.timestamp in the context JSON' },
      },
      required: ['transaction_id', 'provider_id', 'timestamp'],
    },
  },
];

const RISK_SYSTEM_PROMPT =
  'You are a fraud-detection engine for BridgePro, a Caribbean service marketplace. ' +
  'The context JSON always includes transaction.id, transaction.timestamp, and provider.id — pass these verbatim as tool arguments. ' +
  'Tool call protocol: ' +
  '(1) Call getProviderDisputeHistory when prior_flagged_transactions > 0 OR velocity_60min_count ≥ 1 OR amount ≥ 1.3× avg — this enrichment costs nothing and can shift the score ±20 pts. ' +
  '(2) After getProviderDisputeHistory, if dispute record is clean (upheld_count = 0) AND velocity_60min_count ≥ 1 AND this_tx_vs_avg_pct > 30, call checkAppointmentCorrelation — a matching appointment is the strongest legitimacy signal available. ' +
  '(3) Skip ALL tools only when: velocity = 0 AND prior_flagged = 0 AND amount is within 20% of avg. Otherwise, enrich first. ' +
  'Use at most 2 tool calls total. ' +
  'After tools, return ONLY valid JSON — no markdown, no prose — with exactly these keys: ' +
  '{ "risk_score": <int 0-100>, "reasoning": <string ≤200 chars>, ' +
  '"category": <"velocity_spike"|"seasonal_pattern"|"new_provider_burst"|"inconsistent_with_history"|"none">, ' +
  '"recommended_action": <"auto_clear"|"flag_for_review"|"escalate"> }. ' +
  'Score bands: 0–15 = fully consistent; 16–39 = minor anomaly; 40–59 = moderate concern; 60–79 = strong anomaly; 80–100 = systematic fraud. ' +
  'Mandatory scoring conditions — MUST produce risk_score ≥ 40: ' +
  '(A) amount ≥ 2× the 30-day average AND velocity_60min_count ≥ 1; ' +
  '(B) velocity_60min_count ≥ 3; ' +
  '(C) tenure < 7 days AND ≥ 2 txns in 60 min; ' +
  '(D) prior_flagged_transactions ≥ 3. ' +
  'Tools adjust score within bands: upheld disputes (≥2) push toward 65–79; confirmed appointment reduces by up to 20 pts; clean disputes with matching appointment keeps score near 40–50 even when rule A/B applies. ' +
  'Emergency Services / HVAC providers may score up to 20 pts lower than a comparable non-emergency provider for the same pattern. ' +
  'Use "escalate" for ≥ 80. Use "flag_for_review" for 40–79. Use "auto_clear" for 0–39.';

/**
 * POST /finance/log-manual-transaction
 * Provider logs an off-platform (cash / offline) transaction.
 * Creates a verified transaction, runs agentic anomaly detection, generates a receipt PDF, awards BridgePoints.
 */
router.post('/log-manual-transaction', requireAuth, async (req, res, next) => {
  try {
    const { role, id: providerId, full_name: providerName } = req.user;
    if (role !== 'provider') {
      return res.status(403).json({ error: 'Provider access required.' });
    }

    const { customerName, amount, description, contactInfo } = req.body;
    if (!customerName || !amount || !description) {
      return res.status(400).json({ error: 'customerName, amount, and description are required.' });
    }
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number.' });
    }

    const transactionId = uuidv4();
    const receiptNumber = `MAN-${Date.now()}`;
    const countryCode   = req.countryCode || 'SVG';
    const txDow         = new Date().getDay();
    const txHour        = new Date().getHours();

    // Insert transaction with is_flagged = false; anomaly assessment updates it below
    await db.query(
      `INSERT INTO transactions
         (id, country_code, provider_id, amount, is_verified,
          provider_confirmed, customer_confirmed,
          verification_method, source,
          guest_customer_name, guest_customer_email,
          job_notes, is_flagged, review_required, created_at)
       VALUES ($1,$2,$3,$4,true,true,true,'manual_verified','manual_verified',$5,$6,$7,false,false,NOW())`,
      [transactionId, countryCode, providerId, parsedAmount,
       customerName, contactInfo || null, description]
    );

    // ── Gather anomaly context ────────────────────────────────────────────────
    const [ctx30d, ctxProvider, ctxHistory, ctxReviews30d, ctxFlagged, ctxVelocity] = await Promise.all([
      // 30-day trailing manual tx count + volume (excludes current)
      db.query(`
        SELECT COUNT(*)                         AS tx_count_30d,
               COALESCE(SUM(amount), 0)         AS volume_30d,
               COALESCE(AVG(amount), 0)         AS avg_30d
        FROM transactions
        WHERE provider_id = $1 AND source = 'manual_verified'
          AND created_at > NOW() - INTERVAL '30 days' AND id != $2`,
        [providerId, transactionId]),

      // Provider category, tenure, listing presence
      db.query(`
        SELECT l.category, u.created_at AS member_since, u.is_verified,
               (SELECT COUNT(*) FROM listings WHERE user_id = u.id AND is_active = true) AS active_listing_count
        FROM users u
        LEFT JOIN listings l ON l.user_id = u.id AND l.is_active = true
        WHERE u.id = $1 ORDER BY l.created_at DESC LIMIT 1`,
        [providerId]),

      // Historical DOW/hour pattern from last 90 days
      db.query(`
        SELECT EXTRACT(DOW  FROM created_at)::int AS dow,
               EXTRACT(HOUR FROM created_at)::int AS hour,
               COUNT(*)                           AS cnt
        FROM transactions
        WHERE provider_id = $1 AND source = 'manual_verified'
          AND created_at > NOW() - INTERVAL '90 days' AND id != $2
        GROUP BY 1, 2 ORDER BY cnt DESC LIMIT 10`,
        [providerId, transactionId]),

      // Reviews in last 30 days
      db.query(`
        SELECT COUNT(*)                      AS review_count_30d,
               COALESCE(AVG(r.rating), 0)   AS avg_rating_30d
        FROM reviews r JOIN listings l ON l.id = r.listing_id
        WHERE l.user_id = $1 AND r.created_at > NOW() - INTERVAL '30 days'`,
        [providerId]),

      // Prior flagged transaction count
      db.query(`
        SELECT COUNT(*) AS flagged_count
        FROM transactions
        WHERE provider_id = $1 AND is_flagged = true AND id != $2`,
        [providerId, transactionId]),

      // 60-minute velocity count (the fallback rule threshold)
      db.query(`
        SELECT COUNT(*) AS cnt FROM transactions
        WHERE provider_id = $1 AND source = 'manual_verified'
          AND created_at > NOW() - INTERVAL '60 minutes' AND id != $2`,
        [providerId, transactionId]),
    ]);

    const p30d         = ctx30d.rows[0];
    const pInfo        = ctxProvider.rows[0] || {};
    const history      = ctxHistory.rows;
    const rev30d       = ctxReviews30d.rows[0];
    const flagInfo     = ctxFlagged.rows[0];
    const velocityCount = parseInt(ctxVelocity.rows[0].cnt, 10) || 0;
    const tenureDays   = pInfo.member_since
      ? Math.floor((Date.now() - new Date(pInfo.member_since).getTime()) / 86_400_000) : 0;

    const contextMsg = JSON.stringify({
      transaction: {
        id:          transactionId,
        amount:      parsedAmount,
        description,
        day_of_week: txDow,
        hour_of_day: txHour,
        timestamp:   new Date().toISOString(),
      },
      provider: {
        id:                 providerId,
        category:           pInfo.category || 'unknown',
        tenure_days:        tenureDays,
        is_verified:        !!pInfo.is_verified,
        has_active_listing: parseInt(pInfo.active_listing_count, 10) > 0,
      },
      trailing_30d: {
        manual_tx_count:   parseInt(p30d.tx_count_30d, 10) || 0,
        manual_volume_xcd: parseFloat(p30d.volume_30d) || 0,
        avg_amount_xcd:    parseFloat(p30d.avg_30d) || 0,
      },
      this_tx_vs_avg_pct: parseFloat(p30d.avg_30d) > 0
        ? Math.round(((parsedAmount - parseFloat(p30d.avg_30d)) / parseFloat(p30d.avg_30d)) * 100)
        : null,
      historical_patterns_90d: history.map(h => ({
        dow: h.dow, hour: h.hour, count: parseInt(h.cnt, 10),
      })),
      current_tx_matches_historical_pattern: history.some(
        h => h.dow === txDow && Math.abs(h.hour - txHour) <= 2
      ),
      reviews_last_30d: {
        count:      parseInt(rev30d.review_count_30d, 10) || 0,
        avg_rating: parseFloat(rev30d.avg_rating_30d) || 0,
      },
      prior_flagged_transactions: parseInt(flagInfo.flagged_count, 10) || 0,
      velocity_60min_count: velocityCount,
    });

    // ── Agentic risk assessment (8 s hard timeout; fallback to rule-based) ───
    let riskScore         = 0;
    let reasoning         = '';
    let riskCategory      = 'none';
    let recommendedAction = 'auto_clear';
    let modelUsed         = 'claude-haiku-4-5-20251001';
    let toolsUsedList     = [];

    try {
      const { finalText, toolsUsedArr } = await Promise.race([
        (async () => {
          const messages   = [{ role: 'user', content: contextMsg }];
          const toolsUsed  = [];
          let   finalText  = null;
          let   rounds     = 0;
          const MAX_ROUNDS = 2;

          while (true) {
            const resp = await anthropic.messages.create({
              model:      'claude-haiku-4-5-20251001',
              max_tokens: 1024,
              system:     RISK_SYSTEM_PROMPT,
              tools:      RISK_TOOLS,
              messages,
            });

            messages.push({ role: 'assistant', content: resp.content });

            if (resp.stop_reason !== 'tool_use') {
              finalText = resp.content.find(b => b.type === 'text')?.text?.trim() || null;
              break;
            }

            const limitReached      = rounds >= MAX_ROUNDS;
            const toolResultContent = [];

            for (const block of resp.content) {
              if (block.type !== 'tool_use') continue;

              let resultStr;
              if (limitReached) {
                resultStr = JSON.stringify({ error: 'Tool call limit reached' });
              } else {
                toolsUsed.push(block.name);
                try {
                  let result;
                  if (block.name === 'getProviderDisputeHistory') {
                    result = await getProviderDisputeHistory(block.input.provider_id);
                  } else if (block.name === 'checkAppointmentCorrelation') {
                    result = await checkAppointmentCorrelation(
                      block.input.transaction_id,
                      block.input.provider_id,
                      block.input.timestamp
                    );
                  } else {
                    result = { error: 'Unknown tool' };
                  }
                  resultStr = JSON.stringify(result);
                } catch (toolErr) {
                  resultStr = JSON.stringify({ error: toolErr.message });
                }
              }

              toolResultContent.push({
                type:        'tool_result',
                tool_use_id: block.id,
                content:     resultStr,
              });
            }

            if (limitReached) {
              messages.push({
                role: 'user',
                content: [
                  ...toolResultContent,
                  { type: 'text', text: 'Tool call limit reached. Return your final JSON verdict now.' },
                ],
              });
              const finalResp = await anthropic.messages.create({
                model:      'claude-haiku-4-5-20251001',
                max_tokens: 256,
                system:     RISK_SYSTEM_PROMPT,
                messages,
              });
              finalText = finalResp.content.find(b => b.type === 'text')?.text?.trim() || null;
              break;
            }

            messages.push({
              role: 'user',
              content: [
                ...toolResultContent,
                { type: 'text', text: 'Return ONLY your final JSON verdict now — no prose, no explanation, just the JSON object.' },
              ],
            });
            rounds++;
          }

          return { finalText, toolsUsedArr: toolsUsed };
        })(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('LLM assessment timeout')), 8000)
        ),
      ]);

      const raw = finalText || '';
      // Strip markdown fences first; if prose remains, extract the embedded JSON object
      let clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      if (!clean.startsWith('{')) {
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) clean = m[0];
      }
      const parsed = JSON.parse(clean);

      const VALID_CATS    = ['velocity_spike','seasonal_pattern','new_provider_burst','inconsistent_with_history','none'];
      const VALID_ACTIONS = ['auto_clear','flag_for_review','escalate'];

      riskScore         = Math.max(0, Math.min(100, parseInt(parsed.risk_score, 10) || 0));
      reasoning         = String(parsed.reasoning || '').slice(0, 500);
      riskCategory      = VALID_CATS.includes(parsed.category)              ? parsed.category           : 'none';
      recommendedAction = VALID_ACTIONS.includes(parsed.recommended_action) ? parsed.recommended_action : 'auto_clear';
      toolsUsedList     = toolsUsedArr;
    } catch (llmErr) {
      // Fallback: rule-based velocity check (>3 manual txns within 60 min)
      console.warn('[finance] LLM risk assessment failed, using fallback rule:', llmErr.message);
      if (velocityCount >= 3) {
        riskScore         = 60;
        reasoning         = `Fallback rule: ${velocityCount + 1} manual transactions within 60 minutes.`;
        riskCategory      = 'velocity_spike';
        recommendedAction = 'flag_for_review';
      }
      modelUsed = 'fallback_rule';
    }

    const isFlagged = recommendedAction === 'flag_for_review' || recommendedAction === 'escalate';

    // Persist the flag state decided by the assessment
    await db.query(
      `UPDATE transactions SET is_flagged = $1, review_required = $1 WHERE id = $2`,
      [isFlagged, transactionId]
    );

    // Award points and increment tx count only for clean transactions (consistent with prior behaviour)
    if (!isFlagged) {
      await db.query(
        `UPDATE users SET verified_transaction_count = COALESCE(verified_transaction_count, 0) + 1
         WHERE id = $1`,
        [providerId]
      );
      await awardPointsForTransaction(transactionId, providerId, null, countryCode);
    }

    // Persist risk assessment row (non-fatal)
    await db.query(
      `INSERT INTO transaction_risk_assessments
         (transaction_id, risk_score, reasoning, category, recommended_action, model_used, tools_used)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [transactionId, riskScore, reasoning, riskCategory, recommendedAction, modelUsed,
       toolsUsedList.length > 0 ? JSON.stringify(toolsUsedList) : null]
    ).catch(err => console.error('[finance] risk assessment insert:', err.message));

    // Notify all admins immediately when the assessment says escalate
    if (recommendedAction === 'escalate') {
      const admins = await db.query(
        `SELECT id FROM users WHERE role = 'admin' AND country_code = $1`,
        [countryCode]
      ).catch(() => ({ rows: [] }));
      for (const admin of admins.rows) {
        notify(
          admin.id,
          'escalation',
          '🚨 Transaction Escalated — Fraud Risk',
          `Risk score ${riskScore}: ${reasoning.slice(0, 120)}`,
          { url: '/#/admin', transaction_id: transactionId }
        );
      }
    }

    // Generate receipt PDF
    const { verifyUrl: receiptVerifyUrl } = await signDocument({
      docType: 'receipt', docRef: receiptNumber, providerId,
      countryCode,
      metadata: { issued_by: providerName || 'Provider', issued_to: customerName, amount: parsedAmount, currency: 'XCD', description },
    });
    await generateReceiptPdf({
      receipt_number: receiptNumber,
      issued_by:      providerName || 'Provider',
      issued_to:      customerName,
      date:           new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
      description,
      amount:         parsedAmount.toFixed(2),
      currency:       'XCD',
      status:         'PAID',
      verify_url:     receiptVerifyUrl,
    });

    const receiptUrl = `/api/ai/receipt/pdf/${receiptNumber}`;
    await db.query(
      `UPDATE transactions SET receipt_doc_url = $1 WHERE id = $2`,
      [receiptUrl, transactionId]
    );

    await db.query(
      `INSERT INTO provider_documents (user_id, type, label, download_url, meta)
       VALUES ($1, 'receipt', $2, $3, $4)`,
      [providerId,
       `Receipt — ${customerName} (XCD $${parsedAmount.toFixed(2)})`,
       receiptUrl,
       JSON.stringify({ customer_name: customerName, amount: parsedAmount, transaction_id: transactionId })]
    ).catch(() => {});

    res.json({
      success:             true,
      transaction_id:      transactionId,
      receipt_number:      receiptNumber,
      receipt_url:         receiptUrl,
      amount:              parsedAmount,
      currency:            'XCD',
      is_flagged:          isFlagged,
      risk_score:          riskScore,
      trust_score_updated: !isFlagged,
      message: isFlagged
        ? `Transaction recorded for ${customerName} — flagged for review (risk score: ${riskScore}). Receipt generated.`
        : `Transaction recorded and receipt generated for ${customerName}.`,
    });
  } catch (err) { next(err); }
});

module.exports = router;
