-- Provider response fields for item-interest enquiries
ALTER TABLE enquiries
  ADD COLUMN IF NOT EXISTS provider_phone        VARCHAR(50),
  ADD COLUMN IF NOT EXISTS provider_whatsapp     VARCHAR(50),
  ADD COLUMN IF NOT EXISTS provider_payment_methods TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS provider_note         TEXT,
  ADD COLUMN IF NOT EXISTS responded_at          TIMESTAMP WITH TIME ZONE;

-- Extend enquiry_status enum with item-specific states
-- IF NOT EXISTS requires PostgreSQL 9.6+
ALTER TYPE enquiry_status ADD VALUE IF NOT EXISTS 'contact_shared';
ALTER TYPE enquiry_status ADD VALUE IF NOT EXISTS 'item_unavailable';
