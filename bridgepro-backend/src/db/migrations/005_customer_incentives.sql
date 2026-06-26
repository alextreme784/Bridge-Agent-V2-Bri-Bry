-- Customer incentives, reputation, verified badge, escrow placeholder

-- Users table: customer reputation and verification fields
ALTER TABLE users ADD COLUMN IF NOT EXISTS customer_verified BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS customer_verified_at TIMESTAMP NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS customer_reputation_score DECIMAL(3,1) DEFAULT 0.0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_customer_transaction_count INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS average_confirmation_speed_hours DECIMAL(5,2) DEFAULT 0.0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS customer_upgrade_available BOOLEAN DEFAULT false;
-- last_login_ip already added in 004

-- Transactions table: escrow placeholder, dispute, fraud detail, speed tracking
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS escrow_intent BOOLEAN DEFAULT false;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS escrow_status VARCHAR(20) DEFAULT 'not_applicable';
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS customer_confirmation_speed_hours DECIMAL(5,2) NULL;
-- fraud_flag already added in 004
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS fraud_flag_reason TEXT NULL;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS dispute_flagged BOOLEAN DEFAULT false;

-- Listings table: provider preference
ALTER TABLE listings ADD COLUMN IF NOT EXISTS verified_customers_only BOOLEAN DEFAULT false;

-- Customer ID verifications (reuses id_verification_status enum from migration 001)
CREATE TABLE IF NOT EXISTS customer_id_verifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id),
  country_code VARCHAR(10) NOT NULL,
  id_doc_url TEXT NOT NULL,
  status id_verification_status DEFAULT 'pending',
  reviewed_by UUID REFERENCES users(id) NULL,
  reviewed_at TIMESTAMP NULL,
  rejection_reason TEXT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cust_verif_status ON customer_id_verifications(status);
CREATE INDEX IF NOT EXISTS idx_cust_verif_user ON customer_id_verifications(user_id);

-- Dispute status enum
CREATE TYPE dispute_status AS ENUM ('open', 'resolved', 'dismissed');

-- Customer dispute flags (full audit trail — never deleted)
CREATE TABLE IF NOT EXISTS customer_dispute_flags (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id UUID REFERENCES transactions(id),
  customer_id UUID REFERENCES users(id),
  provider_id UUID REFERENCES users(id),
  country_code VARCHAR(10) NOT NULL,
  reason TEXT NOT NULL,
  status dispute_status DEFAULT 'open',
  provider_response TEXT NULL,
  resolved_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_disputes_transaction ON customer_dispute_flags(transaction_id);
CREATE INDEX IF NOT EXISTS idx_disputes_customer ON customer_dispute_flags(customer_id);
CREATE INDEX IF NOT EXISTS idx_disputes_provider ON customer_dispute_flags(provider_id);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON customer_dispute_flags(status);

-- Escrow platform settings (dormant until ESCROW_ENABLED = 'true' in Phase 3)
INSERT INTO platform_settings (key, value) VALUES ('ESCROW_ENABLED', 'false') ON CONFLICT (key) DO NOTHING;
INSERT INTO platform_settings (key, value) VALUES ('ESCROW_FEE_PERCENT', '5') ON CONFLICT (key) DO NOTHING;
INSERT INTO platform_settings (key, value) VALUES ('ESCROW_CUSTOMER_FEE_SPLIT', '2.5') ON CONFLICT (key) DO NOTHING;
INSERT INTO platform_settings (key, value) VALUES ('ESCROW_PROVIDER_FEE_SPLIT', '2.5') ON CONFLICT (key) DO NOTHING;
