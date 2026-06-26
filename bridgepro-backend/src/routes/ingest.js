const express = require('express');
const crypto  = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { updateCreditProfile } = require('../services/pointsService');

const router = express.Router();

// ── Schema bootstrap ─────────────────────────────────────────────────────────
db.query(`
  CREATE TABLE IF NOT EXISTS provider_api_keys (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    provider_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    api_key      VARCHAR(80)  NOT NULL UNIQUE,
    label        VARCHAR(100) NOT NULL DEFAULT 'Default',
    is_active    BOOLEAN DEFAULT true,
    last_used_at TIMESTAMP,
    created_at   TIMESTAMP DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_pak_api_key  ON provider_api_keys(api_key);
  CREATE INDEX IF NOT EXISTS idx_pak_provider ON provider_api_keys(provider_id);
  ALTER TABLE transactions ADD COLUMN IF NOT EXISTS pos_reference_id VARCHAR(100);
`).catch(err => console.error('[ingest] migration:', err.message));

// Idempotency index — ignore if already exists
db.query(`CREATE UNIQUE INDEX idx_tx_pos_ref ON transactions(provider_id, pos_reference_id)
          WHERE pos_reference_id IS NOT NULL`)
  .catch(() => {});

// ── Payload normaliser ────────────────────────────────────────────────────────
function normalizePosPayload(raw) {
  const pick = (...keys) => {
    for (const k of keys) {
      const v = raw[k];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return null;
  };

  const amount = parseFloat(
    pick('amount','sale_total','total','total_amount','price',
         'subtotal','sale_amount','net_amount','grand_total','transaction_amount')
  );

  const description = String(
    pick('description','item_name','service','notes','memo',
         'product_name','item','service_name','sale_description') || 'POS Sale'
  ).slice(0, 500);

  const customerName = String(
    pick('customer_name','customer','client_name','buyer_name',
         'guest_name','client','name','customer_full_name') || 'POS Customer'
  ).slice(0, 255);

  const customerContact = String(
    pick('customer_email','email','contact_email','buyer_email','contact','phone') || ''
  ).slice(0, 255) || null;

  const posRefId = String(
    pick('reference_id','pos_id','receipt_id','external_id',
         'order_id','transaction_id','receipt_number','pos_ref','order_number','id') || ''
  ).slice(0, 100) || null;

  const currency = String(pick('currency','currency_code') || 'XCD').toUpperCase().slice(0, 10);

  return { amount, description, customerName, customerContact, posRefId, currency };
}

// ── POST /api/ingest/pos-data ─────────────────────────────────────────────────
router.post('/pos-data', async (req, res, next) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) {
      return res.status(401).json({ error: 'x-api-key header required.' });
    }

    // Validate key → resolve provider
    const keyRes = await db.query(
      `SELECT pak.id AS key_id, pak.provider_id, pak.is_active,
              u.full_name,
              COALESCE(l.country_code, 'SVG') AS country_code
       FROM provider_api_keys pak
       JOIN users u ON u.id = pak.provider_id
       LEFT JOIN LATERAL (
         SELECT country_code FROM listings
         WHERE user_id = pak.provider_id
         ORDER BY is_active DESC NULLS LAST, created_at DESC LIMIT 1
       ) l ON true
       WHERE pak.api_key = $1`,
      [apiKey]
    );
    if (!keyRes.rows.length) return res.status(401).json({ error: 'Invalid API key.' });
    const { key_id, provider_id, is_active, country_code } = keyRes.rows[0];
    if (!is_active) return res.status(403).json({ error: 'API key has been revoked.' });

    const norm = normalizePosPayload(req.body);

    if (isNaN(norm.amount) || norm.amount <= 0) {
      return res.status(400).json({
        error: 'Invalid or missing amount.',
        hint:  'Send one of: amount, sale_total, total, total_amount, price, subtotal',
      });
    }

    // Idempotency — same reference_id for same provider is a no-op
    if (norm.posRefId) {
      const dup = await db.query(
        `SELECT id FROM transactions WHERE provider_id = $1 AND pos_reference_id = $2 LIMIT 1`,
        [provider_id, norm.posRefId]
      );
      if (dup.rows.length) {
        return res.status(409).json({
          success: true,
          duplicate: true,
          transaction_id: dup.rows[0].id,
          message: `Transaction with reference "${norm.posRefId}" already recorded.`,
        });
      }
    }

    const transactionId = uuidv4();

    await db.query(
      `INSERT INTO transactions
         (id, country_code, provider_id, amount, is_verified,
          provider_confirmed, customer_confirmed,
          verification_method, source,
          guest_customer_name, guest_customer_email,
          job_notes, pos_reference_id, created_at)
       VALUES ($1,$2,$3,$4,true,true,true,'pos_integration','pos_integration',$5,$6,$7,$8,NOW())`,
      [transactionId, country_code, provider_id, norm.amount,
       norm.customerName, norm.customerContact, norm.description, norm.posRefId]
    );

    // Update credit profile (verified_transaction_count + BridgePoints + Trust Score)
    await updateCreditProfile(transactionId, provider_id, country_code);

    // Record last-used timestamp on the key
    db.query(`UPDATE provider_api_keys SET last_used_at = NOW() WHERE id = $1`, [key_id])
      .catch(() => {});

    res.json({
      success:             true,
      transaction_id:      transactionId,
      amount:              norm.amount,
      currency:            norm.currency,
      description:         norm.description,
      customer:            norm.customerName,
      pos_reference_id:    norm.posRefId,
      trust_score_updated: true,
      message:             'POS transaction ingested and credit profile updated.',
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Duplicate transaction reference.' });
    }
    next(err);
  }
});

module.exports = router;
