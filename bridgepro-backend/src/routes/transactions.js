const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const { downloadInvoicePdf } = require('../services/invoiceNinja');
const { generateDoc } = require('../services/docGenerator');
const { handleTransactionVerified, handleReceiptUploaded } = require('../services/points');
const { flagSuspiciousTransaction } = require('../services/fraudService');
const { notify } = require('../services/notificationService');
const { updateConfirmationSpeed, calculateReputationScore, getClientLabel } = require('../services/customerReputationService');

const router = express.Router();

// POST /transactions — provider creates
router.post('/', ...requireRole('provider', 'admin'), async (req, res, next) => {
  try {
    const { customer_id, customer_email, customer_country, amount, use_invoice_ninja, guest_name } = req.body;
    const customerCountry = (customer_country || req.countryCode).toUpperCase();

    let resolvedId = customer_id;
    let guestCustomerName = null;
    let guestCustomerEmail = null;

    if (!resolvedId && customer_email) {
      const found = await db.query(
        'SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND country_code = $2',
        [customer_email, customerCountry]
      );
      if (found.rows.length) {
        resolvedId = found.rows[0].id;
      } else {
        // Customer not on platform — create as guest receipt
        guestCustomerName = guest_name?.trim() || null;
        guestCustomerEmail = customer_email;
      }
    } else if (!resolvedId) {
      if (guest_name?.trim()) {
        guestCustomerName = guest_name.trim();
      } else {
        return res.status(400).json({ error: 'Customer email or name is required' });
      }
    }

    const isGuest = !resolvedId;
    const isCrossCountry = customerCountry !== req.countryCode;

    // BridgePro+ cross-country check — only for linked accounts
    if (!isGuest && isCrossCountry) {
      const plusAddon = await db.query(
        `SELECT la.status FROM listing_addons la
         JOIN listings l ON l.id = la.listing_id
         WHERE l.user_id = $1 AND l.is_active = true
           AND la.addon_type = 'bridgepro_plus' AND la.status = 'active'`,
        [req.user.id]
      );
      if (!plusAddon.rows.length) {
        return res.status(403).json({
          error: 'BridgePro+ is required to create cross-country transactions. Upgrade in your dashboard.',
          requires_addon: 'bridgepro_plus',
        });
      }
    }

    const baseAmount = amount ? parseFloat(amount) : null;
    const crossCountryFee = isCrossCountry && baseAmount ? baseAmount : null;
    const totalAmount = isCrossCountry && baseAmount ? baseAmount * 2 : baseAmount;

    // verified_customers_only check — skip for guest transactions
    if (!isGuest) {
      const customer = await db.query(
        'SELECT id, email, full_name, role, customer_verified FROM users WHERE id = $1 AND country_code = $2',
        [resolvedId, customerCountry]
      );
      if (!customer.rows.length) return res.status(404).json({ error: 'Customer not found' });

      const listingResult = await db.query(
        'SELECT verified_customers_only FROM listings WHERE user_id = $1 AND is_active = true',
        [req.user.id]
      );
      if (listingResult.rows.length && listingResult.rows[0].verified_customers_only) {
        const isProviderCustomer = ['provider', 'admin'].includes(customer.rows[0].role);
        if (!isProviderCustomer && !customer.rows[0].customer_verified) {
          return res.status(403).json({
            error: 'This provider only accepts enquiries from verified customers. Please verify your ID to proceed.',
          });
        }
      }
    }

    const provider = await db.query(
      `SELECT u.full_name, l.business_name FROM users u
       LEFT JOIN listings l ON l.user_id = u.id AND l.is_active = true
       WHERE u.id = $1`,
      [req.user.id]
    );

    const invoice_ninja_id = null;
    const invoice_url = null;
    const verification_method = 'single_doc';
    const document_expires_at = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

    // Guest transactions are immediately completed — no customer account to confirm
    const customerConfirmed = isGuest;
    const isVerified = isGuest;

    const result = await db.query(
      `INSERT INTO transactions
         (id, country_code, provider_id, customer_id, invoice_ninja_id, invoice_url,
          verification_method, amount, base_amount, cross_country_fee, is_cross_country,
          customer_country_code, document_expires_at, provider_confirmed, customer_confirmed,
          is_verified, guest_customer_name, guest_customer_email)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,$14,$15,$16,$17) RETURNING *`,
      [uuidv4(), req.countryCode, req.user.id, resolvedId, invoice_ninja_id, invoice_url,
       verification_method, totalAmount, baseAmount, crossCountryFee, isCrossCountry,
       isCrossCountry ? customerCountry : null, document_expires_at,
       customerConfirmed, isVerified, guestCustomerName, guestCustomerEmail]
    );

    // Notify linked customer only
    if (!isGuest) {
      const providerName = provider.rows[0]?.business_name || provider.rows[0]?.full_name || 'A provider';
      const amtLabel = totalAmount ? ` · $${parseFloat(totalAmount).toFixed(2)}` : '';
      notify(resolvedId, 'tx_created', '📋 Transaction Created', `${providerName} has logged a transaction with you${amtLabel} — open BridgePro to confirm`, { transaction_id: result.rows[0].id, url: '/dashboard' });

      // Soft duplicate warning
      const dupCheck = await db.query(
        `SELECT COUNT(*) FROM transactions
         WHERE provider_id = $1 AND customer_id = $2 AND country_code = $3
           AND is_verified = false AND id != $4
           AND created_at > NOW() - INTERVAL '4 hours'`,
        [req.user.id, resolvedId, req.countryCode, result.rows[0].id]
      );
      const dupCount = parseInt(dupCheck.rows[0].count, 10);
      const warning = dupCount > 0
        ? `Note: you already have ${dupCount} unconfirmed transaction(s) with this customer from the last 4 hours. Transactions under $${process.env.MIN_TRANSACTION_AMOUNT_FOR_POINTS || 5} do not earn Bridge Points.`
        : null;
      return res.status(201).json({ transaction: result.rows[0], warning });
    }

    res.status(201).json({ transaction: result.rows[0], warning: null });
  } catch (err) {
    next(err);
  }
});

// GET /transactions/customer-search?q= — search customers by name, email, or exact ID
router.get('/customer-search', ...requireRole('provider', 'admin'), async (req, res, next) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) return res.json({ customers: [] });

    const term = q.trim();
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    let result;
    if (UUID_RE.test(term)) {
      result = await db.query(
        `SELECT id, full_name, email, country_code FROM users WHERE id = $1 LIMIT 1`,
        [term]
      );
    } else {
      result = await db.query(
        `SELECT id, full_name, email, country_code FROM users
         WHERE (LOWER(full_name) LIKE LOWER($1) OR LOWER(email) LIKE LOWER($1))
           AND role IN ('customer', 'provider')
           AND is_suspended = false
         ORDER BY full_name ASC LIMIT 8`,
        [`%${term}%`]
      );
    }
    res.json({ customers: result.rows });
  } catch (err) { next(err); }
});

// GET /transactions/recent-customers — unique customers this provider has worked with
router.get('/recent-customers', ...requireRole('provider', 'admin'), async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT DISTINCT ON (u.id)
              u.id, u.full_name, u.email, u.country_code,
              MAX(t.created_at) AS last_transaction
       FROM transactions t
       JOIN users u ON u.id = t.customer_id
       WHERE t.provider_id = $1
       GROUP BY u.id, u.full_name, u.email, u.country_code
       ORDER BY u.id, MAX(t.created_at) DESC
       LIMIT 20`,
      [req.user.id]
    );
    res.json({ customers: result.rows });
  } catch (err) { next(err); }
});

// POST /transactions/:id/confirm — provider or customer confirms
router.post('/:id/confirm', requireAuth, async (req, res, next) => {
  try {
    const tx = await db.query(
      'SELECT * FROM transactions WHERE id = $1 AND (provider_id = $2 OR customer_id = $2)',
      [req.params.id, req.user.id]
    );
    if (!tx.rows.length) return res.status(404).json({ error: 'Transaction not found' });

    const t = tx.rows[0];
    const isProvider = t.provider_id === req.user.id;
    const isCustomer = t.customer_id === req.user.id;

    const field = isProvider ? 'provider_confirmed' : 'customer_confirmed';
    await db.query(`UPDATE transactions SET ${field} = true WHERE id = $1`, [t.id]);

    // Reload and check both confirmed
    const updated = await db.query('SELECT * FROM transactions WHERE id = $1', [t.id]);
    const u = updated.rows[0];

    if (u.provider_confirmed && u.customer_confirmed && !u.is_verified) {
      await db.query('UPDATE transactions SET is_verified = true WHERE id = $1', [t.id]);
      await handleTransactionVerified(t.id, req.countryCode, t.provider_id, t.customer_id, u.verification_method);
      flagSuspiciousTransaction(t.id, t.provider_id, t.customer_id, req.countryCode).catch((err) =>
        console.error('[FRAUD]', err.message)
      );
      // Notify both parties transaction is fully verified
      const amtLabel = u.amount ? ` · $${parseFloat(u.amount).toFixed(2)}` : '';
      notify(t.provider_id, 'tx_verified', '🎉 Transaction Verified', `Confirmed by both parties${amtLabel}`, { transaction_id: t.id, url: '/dashboard' });
      notify(t.customer_id, 'tx_verified', '🎉 Transaction Verified', `Confirmed by both parties${amtLabel}`, { transaction_id: t.id, url: '/dashboard' });
    } else {
      const otherPartyId = isProvider ? t.customer_id : t.provider_id;
      const label = isProvider ? 'Provider confirmed' : 'Customer confirmed';
      notify(otherPartyId, 'tx_confirm', `${label} — your turn`, 'Open BridgePro to confirm the transaction', { transaction_id: t.id, url: '/dashboard' });
    }

    // Track customer confirmation speed and refresh reputation score
    if (isCustomer) {
      updateConfirmationSpeed(t.customer_id, t.id).catch((err) =>
        console.error('[REPUTATION]', err.message)
      );
    }

    res.json({ transaction: updated.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /transactions/:id/upload — invoice or receipt (provider/admin only)
router.post('/:id/upload', ...requireRole('provider', 'admin'), upload('transactions').single('file'), async (req, res, next) => {
  try {
    const { doc_type } = req.body;
    if (!['invoice', 'receipt'].includes(doc_type)) {
      return res.status(400).json({ error: 'doc_type must be "invoice" or "receipt"' });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const tx = await db.query(
      'SELECT * FROM transactions WHERE id = $1 AND (provider_id = $2 OR customer_id = $2)',
      [req.params.id, req.user.id]
    );
    if (!tx.rows.length) return res.status(404).json({ error: 'Transaction not found' });

    const t = tx.rows[0];

    const docUrl = `/uploads/transactions/${req.file.filename}`;

    if (doc_type === 'receipt') {
      await db.query(
        `UPDATE transactions SET receipt_doc_url = $1, receipt_uploaded_at = NOW(), verification_method = 'document_upload' WHERE id = $2`,
        [docUrl, t.id]
      );
      await handleReceiptUploaded(t.id, t.country_code, req.user.id);
    } else {
      await db.query(
        `UPDATE transactions SET invoice_doc_url = $1, verification_method = 'document_upload' WHERE id = $2`,
        [docUrl, t.id]
      );
    }

    // Verify if both parties have confirmed — docs are evidence, not the trigger
    const updated = await db.query('SELECT * FROM transactions WHERE id = $1', [t.id]);
    const u = updated.rows[0];

    if (u.provider_confirmed && u.customer_confirmed && !u.is_verified) {
      await db.query('UPDATE transactions SET is_verified = true WHERE id = $1', [t.id]);
      await handleTransactionVerified(t.id, t.country_code, t.provider_id, t.customer_id, u.verification_method);
      flagSuspiciousTransaction(t.id, t.provider_id, t.customer_id, t.country_code).catch((err) =>
        console.error('[FRAUD]', err.message)
      );
    }

    res.json({ transaction: updated.rows[0] });
  } catch (err) {
    next(err);
  }
});

function expireDocFields(tx) {
  if (tx.document_expires_at && new Date(tx.document_expires_at) < new Date()) {
    tx.invoice_url = null;
    tx.invoice_ninja_id = null;
    tx.invoice_doc_url = null;
    tx.receipt_doc_url = null;
  }
  return tx;
}

// GET /transactions/reviewable/:providerUserId — verified tx between current user and a provider (for listing review button)
router.get('/reviewable/:providerUserId', requireAuth, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT id FROM transactions
       WHERE country_code = $1 AND is_verified = true
         AND (
           (provider_id = $2 AND customer_id = $3)
           OR (provider_id = $3 AND customer_id = $2)
         )
       ORDER BY created_at DESC
       LIMIT 1`,
      [req.countryCode, req.params.providerUserId, req.user.id]
    );
    res.json({ transaction_id: result.rows[0]?.id || null });
  } catch (err) {
    next(err);
  }
});

// GET /transactions — own transactions
router.get('/', requireAuth, async (req, res, next) => {
  try {
    // No country_code filter here — customers must be able to see cross-country
    // transactions where the provider's country differs from their own.
    const result = await db.query(
      `SELECT t.*,
              COALESCE(cu.full_name, t.guest_customer_name) AS customer_name,
              COALESCE(cu.email, t.guest_customer_email) AS customer_email,
              pr.full_name AS provider_name,
              EXISTS(
                SELECT 1 FROM reviews r
                WHERE r.transaction_id = t.id AND r.reviewer_id = $1
              ) AS reviewed
       FROM transactions t
       LEFT JOIN users cu ON cu.id = t.customer_id
       LEFT JOIN users pr ON pr.id = t.provider_id
       WHERE t.provider_id = $1 OR t.customer_id = $1
       ORDER BY t.created_at DESC`,
      [req.user.id]
    );
    const transactions = result.rows.map((t) => {
      if (t.document_expires_at && new Date(t.document_expires_at) < new Date()) {
        db.query(
          `UPDATE transactions SET invoice_url = NULL, invoice_ninja_id = NULL,
           invoice_doc_url = NULL, receipt_doc_url = NULL WHERE id = $1`,
          [t.id]
        ).catch(() => {});
      }
      return expireDocFields(t);
    });
    res.json({ transactions });
  } catch (err) {
    next(err);
  }
});

// GET /transactions/summary — provider earnings summary
router.get('/summary', ...requireRole('provider', 'admin'), async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE is_verified AND date_trunc('month', created_at) = date_trunc('month', NOW())), 0) AS this_month,
         COALESCE(SUM(amount) FILTER (WHERE is_verified AND date_trunc('month', created_at) = date_trunc('month', NOW() - INTERVAL '1 month')), 0) AS last_month,
         COALESCE(SUM(amount) FILTER (WHERE is_verified AND date_trunc('year', created_at) = date_trunc('year', NOW())), 0) AS this_year,
         COUNT(*) FILTER (WHERE is_verified AND date_trunc('year', created_at) = date_trunc('year', NOW())) AS jobs_this_year,
         COALESCE(SUM(amount) FILTER (WHERE NOT is_verified AND amount IS NOT NULL), 0) AS outstanding_amount,
         COUNT(*) FILTER (WHERE NOT is_verified) AS outstanding_count
       FROM transactions
       WHERE provider_id = $1 AND country_code = $2`,
      [req.user.id, req.countryCode]
    );
    res.json({ summary: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /transactions/export — CSV download of all provider transactions
router.get('/export', ...requireRole('provider', 'admin'), async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT t.created_at, t.amount, t.is_verified, t.verification_method,
              t.invoice_ninja_id, t.invoice_url, t.id,
              COALESCE(u.full_name, t.guest_customer_name) AS customer_name,
              COALESCE(u.email, t.guest_customer_email) AS customer_email
       FROM transactions t
       LEFT JOIN users u ON u.id = t.customer_id
       WHERE t.provider_id = $1 AND t.country_code = $2
       ORDER BY t.created_at DESC`,
      [req.user.id, req.countryCode]
    );

    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const currency = req.countryCode === 'SVG' ? 'XCD' : req.countryCode === 'BRB' ? 'BBD' : 'XCD';

    const rows = result.rows.map((t) => [
      esc(new Date(t.created_at).toLocaleDateString('en-GB')),
      esc(t.customer_name || ''),
      esc(t.customer_email || ''),
      esc(t.amount != null ? parseFloat(t.amount).toFixed(2) : ''),
      esc(currency),
      esc(t.is_verified ? 'Completed' : 'Pending'),
      esc(t.verification_method || ''),
      esc(t.invoice_ninja_id || ''),
      esc(t.id),
    ].join(','));

    const header = '"Date","Customer","Email","Amount","Currency","Status","Method","Invoice ID","Transaction ID"';
    const csv = [header, ...rows].join('\r\n');

    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', `attachment; filename="bridgepro-transactions-${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

// GET /transactions/:id — with customer reputation fields for providers
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const result = await db.query(
      'SELECT * FROM transactions WHERE id = $1 AND (provider_id = $2 OR customer_id = $2)',
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Transaction not found' });

    const transaction = result.rows[0];

    // Providers see customer reputation info on the transaction
    if (req.user.role === 'provider' || req.user.role === 'admin') {
      const custResult = await db.query(
        `SELECT customer_verified, customer_reputation_score,
                verified_customer_transaction_count, average_confirmation_speed_hours
         FROM users WHERE id = $1`,
        [transaction.customer_id]
      );
      if (custResult.rows.length) {
        const c = custResult.rows[0];
        const score = parseFloat(c.customer_reputation_score) || 0;
        transaction.customer_reputation = {
          customer_verified: c.customer_verified,
          customer_reputation_score: score,
          verified_customer_transaction_count: parseInt(c.verified_customer_transaction_count, 10) || 0,
          average_confirmation_speed_hours: parseFloat(c.average_confirmation_speed_hours) || 0,
          client_label: getClientLabel(score),
        };
      }
    }

    res.json({ transaction });
  } catch (err) {
    next(err);
  }
});

// PUT /transactions/:id/job — provider logs hours, tasks, notes
router.put('/:id/job', ...requireRole('provider', 'admin'), async (req, res, next) => {
  try {
    const { job_hours, job_tasks, job_notes } = req.body;

    const existing = await db.query(
      'SELECT id, provider_id FROM transactions WHERE id = $1 AND country_code = $2',
      [req.params.id, req.countryCode]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Transaction not found' });
    if (existing.rows[0].provider_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const result = await db.query(
      `UPDATE transactions SET
         job_hours = $1,
         job_tasks = $2,
         job_notes = $3
       WHERE id = $4
       RETURNING id, job_hours, job_tasks, job_notes`,
      [
        job_hours != null ? parseFloat(job_hours) : null,
        JSON.stringify(Array.isArray(job_tasks) ? job_tasks : []),
        job_notes || null,
        req.params.id,
      ]
    );

    res.json({ transaction: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /transactions/:id/dispute — customer opens a dispute
router.post('/:id/dispute', ...requireRole('customer'), async (req, res, next) => {
  try {
    const { reason } = req.body;
    if (!reason || reason.trim().length < 20) {
      return res.status(400).json({ error: 'reason must be at least 20 characters' });
    }

    const tx = await db.query(
      'SELECT * FROM transactions WHERE id = $1 AND customer_id = $2',
      [req.params.id, req.user.id]
    );
    if (!tx.rows.length) return res.status(404).json({ error: 'Transaction not found' });

    const t = tx.rows[0];

    if (!t.is_verified) {
      return res.status(400).json({ error: 'Only confirmed transactions can be disputed' });
    }

    // Customer must be is_verified (provider-verified) OR customer_verified
    const custResult = await db.query(
      'SELECT is_verified, customer_verified FROM users WHERE id = $1',
      [req.user.id]
    );
    const cust = custResult.rows[0];
    if (!cust || (!cust.is_verified && !cust.customer_verified)) {
      return res.status(403).json({ error: 'You must be a verified user to raise a dispute' });
    }

    await db.query(
      `INSERT INTO customer_dispute_flags
         (id, transaction_id, customer_id, provider_id, country_code, reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [uuidv4(), t.id, req.user.id, t.provider_id, req.countryCode, reason.trim()]
    );

    await db.query('UPDATE transactions SET dispute_flagged = true WHERE id = $1', [t.id]);

    // Refresh customer reputation (dispute affects score)
    calculateReputationScore(req.user.id).catch((err) => console.error('[REPUTATION]', err.message));

    console.log(`[DISPUTE] Transaction ${t.id}: provider ${t.provider_id} notified of dispute by customer ${req.user.id}`);

    res.status(201).json({
      message: 'Dispute logged. The provider has been notified and has 7 days to respond.',
    });
  } catch (err) {
    next(err);
  }
});

// POST /transactions/:id/dispute/respond — provider responds to dispute
router.post('/:id/dispute/respond', ...requireRole('provider'), async (req, res, next) => {
  try {
    const { response } = req.body;
    if (!response || !response.trim()) {
      return res.status(400).json({ error: 'response is required' });
    }

    const tx = await db.query(
      'SELECT * FROM transactions WHERE id = $1 AND country_code = $2 AND provider_id = $3',
      [req.params.id, req.countryCode, req.user.id]
    );
    if (!tx.rows.length) return res.status(404).json({ error: 'Transaction not found' });

    const dispute = await db.query(
      `SELECT id, customer_id FROM customer_dispute_flags
       WHERE transaction_id = $1 AND status = 'open'
       ORDER BY created_at DESC LIMIT 1`,
      [req.params.id]
    );
    if (!dispute.rows.length) return res.status(404).json({ error: 'No open dispute found for this transaction' });

    const d = dispute.rows[0];
    await db.query(
      'UPDATE customer_dispute_flags SET provider_response = $1 WHERE id = $2',
      [response.trim(), d.id]
    );

    console.log(`[DISPUTE] Dispute ${d.id}: customer ${d.customer_id} notified of provider response`);

    res.json({ message: 'Response submitted. The customer has been notified.' });
  } catch (err) {
    next(err);
  }
});

// GET /transactions/:id/invoice-pdf — proxy Invoice Ninja PDF download
router.get('/:id/invoice-pdf', requireAuth, async (req, res, next) => {
  try {
    const tx = await db.query(
      'SELECT * FROM transactions WHERE id = $1 AND country_code = $2 AND (provider_id = $3 OR customer_id = $3)',
      [req.params.id, req.countryCode, req.user.id]
    );
    if (!tx.rows.length) return res.status(404).json({ error: 'Transaction not found' });

    const t = tx.rows[0];
    if (!t.invoice_ninja_id) return res.status(404).json({ error: 'No invoice for this transaction' });
    if (t.document_expires_at && new Date(t.document_expires_at) < new Date()) {
      return res.status(410).json({ error: 'Invoice documents have expired (90-day limit)' });
    }

    const { buffer, contentType } = await downloadInvoicePdf(t.invoice_ninja_id);
    res.set('Content-Type', contentType);
    res.set('Content-Disposition', `attachment; filename="invoice-${t.id.slice(0, 8)}.pdf"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

// GET /transactions/:id/download-doc?type=invoice|receipt — customer or provider downloads uploaded doc
router.get('/:id/download-doc', requireAuth, async (req, res, next) => {
  try {
    const { type } = req.query;
    if (!['invoice', 'receipt'].includes(type)) {
      return res.status(400).json({ error: 'type must be "invoice" or "receipt"' });
    }

    const tx = await db.query(
      'SELECT * FROM transactions WHERE id = $1 AND (provider_id = $2 OR customer_id = $2)',
      [req.params.id, req.user.id]
    );
    if (!tx.rows.length) return res.status(404).json({ error: 'Transaction not found' });

    const t = tx.rows[0];

    if (t.document_expires_at && new Date(t.document_expires_at) < new Date()) {
      return res.status(410).json({ error: 'Documents have expired (90-day limit)' });
    }

    const docUrl = type === 'receipt' ? t.receipt_doc_url : t.invoice_doc_url;
    if (!docUrl) return res.status(404).json({ error: `No ${type} document found for this transaction` });

    // For R2/remote URLs, redirect; for local paths, serve the file
    if (docUrl.startsWith('http')) {
      return res.redirect(docUrl);
    }

    const fs = require('fs');
    const path = require('path');
    const uploadsRoot = process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads');
    const filePath = docUrl.startsWith('/uploads/')
      ? path.join(uploadsRoot, docUrl.slice('/uploads/'.length))
      : path.join(uploadsRoot, docUrl);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Document file not found' });
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = ext === '.pdf' ? 'application/pdf'
      : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
      : ext === '.png' ? 'image/png'
      : 'application/octet-stream';

    res.set('Content-Type', contentType);
    res.set('Content-Disposition', `attachment; filename="${type}-${t.id.slice(0, 8)}${ext}"`);
    fs.createReadStream(filePath).pipe(res);
  } catch (err) { next(err); }
});

// POST /transactions/:id/generate-doc — in-house PDF (provider/admin only)
router.post('/:id/generate-doc', ...requireRole('provider', 'admin'), async (req, res, next) => {
  try {
    const tx = await db.query(
      'SELECT * FROM transactions WHERE id = $1 AND (provider_id = $2 OR customer_id = $2)',
      [req.params.id, req.user.id]
    );
    if (!tx.rows.length) return res.status(404).json({ error: 'Transaction not found' });
    const t = tx.rows[0];

    const provListing = await db.query(
      `SELECT l.business_name, l.phone, l.whatsapp, l.logo_url, u.email
       FROM listings l JOIN users u ON u.id = l.user_id
       WHERE l.user_id = $1
       ORDER BY l.is_active DESC LIMIT 1`,
      [t.provider_id]
    );
    const provUser = await db.query('SELECT full_name, email FROM users WHERE id = $1', [t.provider_id]);
    let provider = provListing.rows[0]
      ? { ...provListing.rows[0], full_name: provUser.rows[0]?.full_name }
      : { full_name: provUser.rows[0]?.full_name, email: provUser.rows[0]?.email };

    const custRow = await db.query('SELECT full_name, email, phone FROM users WHERE id = $1', [t.customer_id]);
    let customer = custRow.rows[0] || {};

    const { doc_type = 'invoice', doc_number, items = [], notes, logo_base64, customer_name, provider_name } = req.body;
    if (customer_name?.trim()) customer = { ...customer, full_name: customer_name.trim() };
    if (provider_name?.trim()) provider = { ...provider, business_name: provider_name.trim() };
    const currency = req.countryCode === 'BRB' ? 'BBD' : 'XCD';

    const defaultItems = items.length
      ? items
      : (t.amount ? [{ description: 'Service', quantity: 1, unit_price: t.amount }] : []);

    const pdfBuffer = await generateDoc({
      doc_type, doc_number, provider, customer,
      items: defaultItems, notes, currency,
      transaction_id: t.id,
      logo_base64: logo_base64 || null,
    });

    const typeSlug = doc_type === 'purchase_order' ? 'purchase-order' : doc_type;
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="bridgepro-${typeSlug}-${t.id.slice(0, 8)}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) { next(err); }
});

// POST /transactions/:id/escrow-intent — Phase 3 placeholder
router.post('/:id/escrow-intent', ...requireRole('customer'), async (req, res, next) => {
  try {
    const tx = await db.query(
      'SELECT * FROM transactions WHERE id = $1 AND country_code = $2 AND customer_id = $3',
      [req.params.id, req.countryCode, req.user.id]
    );
    if (!tx.rows.length) return res.status(404).json({ error: 'Transaction not found' });

    await db.query('UPDATE transactions SET escrow_intent = true WHERE id = $1', [req.params.id]);

    console.log(`[ESCROW] Escrow intent registered for transaction ${req.params.id} by customer ${req.user.id} — Phase 3 feature`);

    res.json({
      message: 'Escrow payment option coming soon. Your intent has been noted.',
      escrow_status: 'not_applicable',
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
