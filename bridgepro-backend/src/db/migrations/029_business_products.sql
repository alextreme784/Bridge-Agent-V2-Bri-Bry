CREATE TABLE IF NOT EXISTS business_products (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id   UUID        NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  country_code TEXT        NOT NULL,
  name         TEXT        NOT NULL,
  description  TEXT,
  price        NUMERIC(10,2),
  currency     TEXT        NOT NULL DEFAULT 'XCD',
  unit         TEXT,
  category     TEXT,
  in_stock     BOOLEAN     NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS business_products_listing_id_idx  ON business_products(listing_id);
CREATE INDEX IF NOT EXISTS business_products_country_code_idx ON business_products(country_code);
CREATE INDEX IF NOT EXISTS business_products_name_idx         ON business_products USING gin(to_tsvector('english', name));
