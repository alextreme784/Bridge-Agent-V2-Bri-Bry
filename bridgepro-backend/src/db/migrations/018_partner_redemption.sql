-- Partner flag on users (admin grants this)
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_partner BOOLEAN NOT NULL DEFAULT false;

-- Partner stores directory
CREATE TABLE IF NOT EXISTS partner_stores (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code      VARCHAR(10) NOT NULL,
  name              VARCHAR(200) NOT NULL,
  description       TEXT,
  location          VARCHAR(200),
  points_per_dollar INTEGER NOT NULL DEFAULT 100,
  min_redemption    INTEGER NOT NULL DEFAULT 100,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at        TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_partner_stores_country ON partner_stores(country_code, is_active);

-- Short-code redemption tokens
CREATE TABLE IF NOT EXISTS point_redemption_tokens (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code             VARCHAR(8) NOT NULL UNIQUE,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store_id         UUID NOT NULL REFERENCES partner_stores(id),
  country_code     VARCHAR(10) NOT NULL,
  points_to_redeem INTEGER NOT NULL,
  dollar_value     NUMERIC(10,2) NOT NULL,
  status           VARCHAR(20) NOT NULL DEFAULT 'pending',
  redeemed_by      UUID REFERENCES users(id),
  created_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at       TIMESTAMP WITH TIME ZONE NOT NULL,
  used_at          TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_redeem_tokens_code   ON point_redemption_tokens(code, status);
CREATE INDEX IF NOT EXISTS idx_redeem_tokens_user   ON point_redemption_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_redeem_tokens_expiry ON point_redemption_tokens(expires_at, status);
