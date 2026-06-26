-- Migration 034: Government & Public listing support
-- Adds address and listing_email fields to listings table
-- Also adds the Government & Public category

ALTER TABLE listings ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS listing_email VARCHAR(255);

-- Insert Government & Public category for all active country codes
-- (ON CONFLICT is safe — slug+country_code is unique)
INSERT INTO categories (id, name, slug, icon, country_code, display_order)
SELECT
  gen_random_uuid(), 'Government & Public', 'government-public', '🏛️', country_code, 99
FROM (
  SELECT DISTINCT country_code FROM listings
  UNION
  SELECT 'SVG'
) cc
ON CONFLICT (slug, country_code) DO NOTHING;
