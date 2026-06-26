-- Referral system: each user gets a unique referral code; referred_by tracks who invited them
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(12) UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by UUID REFERENCES users(id);

-- Backfill existing users with referral codes
UPDATE users
SET referral_code = UPPER(SUBSTRING(REPLACE(uuid_generate_v4()::TEXT, '-', ''), 1, 8))
WHERE referral_code IS NULL;

CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);
CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by);
