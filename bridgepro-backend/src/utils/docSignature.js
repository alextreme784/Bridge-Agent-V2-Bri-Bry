const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const BASE_URL = process.env.API_PUBLIC_URL || 'https://api.bridgepro.a3tech.uk';

db.query(`
  CREATE TABLE IF NOT EXISTS document_signatures (
    token        UUID PRIMARY KEY,
    doc_type     TEXT NOT NULL,
    doc_ref      TEXT,
    provider_id  UUID,
    country_code TEXT,
    metadata     JSONB NOT NULL DEFAULT '{}',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`).catch(err => console.error('[doc_signatures] migration:', err.message));

async function signDocument({ docType, docRef, providerId, countryCode, metadata = {} }) {
  const token = uuidv4();
  await db.query(
    `INSERT INTO document_signatures (token, doc_type, doc_ref, provider_id, country_code, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [token, docType, docRef || null, providerId || null, countryCode || null, metadata]
  );
  return { token, verifyUrl: `${BASE_URL}/api/v1/verify/doc/${token}` };
}

async function lookupSignature(token) {
  const result = await db.query(
    'SELECT * FROM document_signatures WHERE token = $1',
    [token]
  );
  return result.rows[0] || null;
}

module.exports = { signDocument, lookupSignature };
