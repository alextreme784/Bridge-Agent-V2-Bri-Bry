-- Add tier and tracking columns to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_transaction_count INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_tier VARCHAR(20) DEFAULT 'free_period';
ALTER TABLE users ADD COLUMN IF NOT EXISTS tier_upgraded_at TIMESTAMP NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS consecutive_max_redemptions INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS upgrade_available BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ip VARCHAR(45) NULL;

-- Extend bridge_points_log with expiry tracking
ALTER TABLE bridge_points_log ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP NOT NULL DEFAULT '9999-12-31 00:00:00';
ALTER TABLE bridge_points_log ADD COLUMN IF NOT EXISTS is_expired BOOLEAN DEFAULT false;
ALTER TABLE bridge_points_log ADD COLUMN IF NOT EXISTS reference_type VARCHAR(50) NULL;

-- Fraud detection on transactions
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS fraud_flag BOOLEAN DEFAULT false;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS receipt_uploaded_at TIMESTAMP NULL;

-- Redemption records (one per user per billing month, never deleted)
CREATE TABLE IF NOT EXISTS point_redemptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id),
  country_code VARCHAR(10) NOT NULL,
  points_redeemed INTEGER NOT NULL,
  dollar_value DECIMAL(10,2) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  billing_month VARCHAR(7) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  applied_at TIMESTAMP NULL,
  UNIQUE(user_id, billing_month)
);
CREATE INDEX IF NOT EXISTS idx_redemptions_user ON point_redemptions(user_id);
CREATE INDEX IF NOT EXISTS idx_redemptions_status ON point_redemptions(status);

-- Tier change audit trail (never deleted)
CREATE TABLE IF NOT EXISTS provider_tier_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id),
  previous_tier VARCHAR(20) NOT NULL,
  new_tier VARCHAR(20) NOT NULL,
  reason VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tier_history_user ON provider_tier_history(user_id);

-- Platform settings rows (safe to run again)
INSERT INTO platform_settings (key, value) VALUES ('POINTS_PER_DOLLAR', '50') ON CONFLICT (key) DO NOTHING;
INSERT INTO platform_settings (key, value) VALUES ('LEVEL1_PRICE', '5') ON CONFLICT (key) DO NOTHING;
INSERT INTO platform_settings (key, value) VALUES ('LEVEL2_PRICE', '10') ON CONFLICT (key) DO NOTHING;
INSERT INTO platform_settings (key, value) VALUES ('LEVEL3_PRICE', '20') ON CONFLICT (key) DO NOTHING;
INSERT INTO platform_settings (key, value) VALUES ('LEVEL1_MAX_REDEMPTION_POINTS', '250') ON CONFLICT (key) DO NOTHING;
INSERT INTO platform_settings (key, value) VALUES ('LEVEL2_MAX_REDEMPTION_POINTS', '500') ON CONFLICT (key) DO NOTHING;
INSERT INTO platform_settings (key, value) VALUES ('LEVEL3_MAX_REDEMPTION_POINTS', '1000') ON CONFLICT (key) DO NOTHING;
INSERT INTO platform_settings (key, value) VALUES ('CONSECUTIVE_MONTHS_FOR_TIER_UPGRADE', '2') ON CONFLICT (key) DO NOTHING;
