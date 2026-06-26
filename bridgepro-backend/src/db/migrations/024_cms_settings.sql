-- platform_settings already existed without country_code — use a dedicated CMS table instead
CREATE TABLE IF NOT EXISTS cms_settings (
  key        VARCHAR(150) PRIMARY KEY,
  value      JSONB        NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
