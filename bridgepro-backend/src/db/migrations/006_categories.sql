-- Migration 006: Category and Subcategory System

DO $$ BEGIN
  CREATE TYPE subcategory_status AS ENUM ('active', 'pending', 'rejected');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Categories
CREATE TABLE IF NOT EXISTS categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(100) NOT NULL,
  icon VARCHAR(50) NULL,
  country_code VARCHAR(10) NOT NULL,
  is_active BOOLEAN DEFAULT true,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_slug_country ON categories(slug, country_code);
CREATE INDEX IF NOT EXISTS idx_categories_country_active ON categories(country_code, is_active);

-- Subcategories
CREATE TABLE IF NOT EXISTS subcategories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  category_id UUID REFERENCES categories(id),
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(100) NOT NULL,
  description TEXT NULL,
  is_other BOOLEAN DEFAULT false,
  status subcategory_status DEFAULT 'active',
  submitted_by UUID REFERENCES users(id) NULL,
  reviewed_by UUID REFERENCES users(id) NULL,
  reviewed_at TIMESTAMP NULL,
  rejection_reason TEXT NULL,
  country_code VARCHAR(10) NOT NULL,
  is_active BOOLEAN DEFAULT true,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_subcategories_category ON subcategories(category_id);
CREATE INDEX IF NOT EXISTS idx_subcategories_status ON subcategories(status);
-- Slug unique per category only among active subcategories (pending may share slugs temporarily)
CREATE UNIQUE INDEX IF NOT EXISTS idx_subcategories_slug_category_active
  ON subcategories(slug, category_id) WHERE status = 'active';

-- Listing ↔ subcategory junction
CREATE TABLE IF NOT EXISTS listing_subcategories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id UUID REFERENCES listings(id) ON DELETE CASCADE,
  subcategory_id UUID REFERENCES subcategories(id),
  is_primary BOOLEAN DEFAULT false,
  pending_custom_subcategory_id UUID NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(listing_id, subcategory_id)
);
CREATE INDEX IF NOT EXISTS idx_listing_subcats_listing ON listing_subcategories(listing_id);
CREATE INDEX IF NOT EXISTS idx_listing_subcats_subcat ON listing_subcategories(subcategory_id);

-- New columns on listings
ALTER TABLE listings ADD COLUMN IF NOT EXISTS category_id UUID REFERENCES categories(id) NULL;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS max_subcategories INTEGER DEFAULT 1;

-- Tier subcategory limits
INSERT INTO platform_settings (key, value) VALUES ('TIER_FREE_PERIOD_MAX_SUBCATEGORIES', '1') ON CONFLICT (key) DO NOTHING;
INSERT INTO platform_settings (key, value) VALUES ('TIER_LEVEL1_MAX_SUBCATEGORIES', '1') ON CONFLICT (key) DO NOTHING;
INSERT INTO platform_settings (key, value) VALUES ('TIER_LEVEL2_MAX_SUBCATEGORIES', '3') ON CONFLICT (key) DO NOTHING;
INSERT INTO platform_settings (key, value) VALUES ('TIER_LEVEL3_MAX_SUBCATEGORIES', '999') ON CONFLICT (key) DO NOTHING;
