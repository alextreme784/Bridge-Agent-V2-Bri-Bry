-- Fix missing columns that application code already references but no migration added

-- Transactions: invoice URL and document expiry (used in every transaction creation)
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS invoice_url TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS document_expires_at TIMESTAMPTZ;

-- Listings: logo storage (logo upload endpoint references both)
ALTER TABLE listings ADD COLUMN IF NOT EXISTS logo_url TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS logo_key TEXT;

-- Listings: contact and profile fields (used in PUT /listings/:id)
ALTER TABLE listings ADD COLUMN IF NOT EXISTS phone VARCHAR(30);
ALTER TABLE listings ADD COLUMN IF NOT EXISTS whatsapp VARCHAR(30);
ALTER TABLE listings ADD COLUMN IF NOT EXISTS website_url TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS business_hours TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS payment_methods JSONB;
