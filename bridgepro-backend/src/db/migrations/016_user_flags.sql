-- Migration 016: Account flagging for admin review

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_flagged BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS flag_reason TEXT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS flagged_at TIMESTAMP NULL;

CREATE INDEX IF NOT EXISTS idx_users_flagged ON users(is_flagged) WHERE is_flagged = true;
