CREATE TABLE IF NOT EXISTS platform_settings (
  country_code CHAR(3)      NOT NULL,
  key          VARCHAR(100) NOT NULL,
  value        JSONB        NOT NULL DEFAULT '{}',
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (country_code, key)
);

CREATE TABLE IF NOT EXISTS announcements (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code CHAR(3)      NOT NULL,
  title        VARCHAR(200) NOT NULL,
  message      TEXT         NOT NULL,
  cta_text     VARCHAR(100),
  cta_url      VARCHAR(500),
  bg_color     VARCHAR(20)  NOT NULL DEFAULT '#1a1a2e',
  text_color   VARCHAR(20)  NOT NULL DEFAULT '#ffffff',
  is_active    BOOLEAN      NOT NULL DEFAULT true,
  expires_at   TIMESTAMPTZ,
  created_by   UUID         REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_announcements_country_active
  ON announcements (country_code, is_active, expires_at);
