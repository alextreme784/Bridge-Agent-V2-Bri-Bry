-- Photo gallery and item display features

-- Portfolio photos uploaded by providers
CREATE TABLE IF NOT EXISTS listing_photos (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id UUID REFERENCES listings(id) ON DELETE CASCADE,
  country_code VARCHAR(10) NOT NULL,
  uploaded_by UUID REFERENCES users(id),
  original_url TEXT NOT NULL,
  thumb_url TEXT NOT NULL,
  caption VARCHAR(255),
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_photos_listing ON listing_photos(listing_id);

-- Shop items (priced products/services on display)
CREATE TABLE IF NOT EXISTS listing_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id UUID REFERENCES listings(id) ON DELETE CASCADE,
  country_code VARCHAR(10) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  price DECIMAL(10,2),
  currency VARCHAR(10) DEFAULT 'XCD',
  image_url TEXT,
  thumb_url TEXT,
  is_available BOOLEAN DEFAULT true,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_items_listing ON listing_items(listing_id);

-- Addon subscriptions (photo_gallery, item_display)
CREATE TABLE IF NOT EXISTS listing_addons (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id UUID REFERENCES listings(id) ON DELETE CASCADE,
  country_code VARCHAR(10) NOT NULL,
  addon_type VARCHAR(50) NOT NULL,
  status VARCHAR(20) DEFAULT 'active',
  activated_at TIMESTAMP DEFAULT NOW(),
  cancelled_at TIMESTAMP,
  UNIQUE(listing_id, addon_type)
);

CREATE INDEX idx_addons_listing ON listing_addons(listing_id);
