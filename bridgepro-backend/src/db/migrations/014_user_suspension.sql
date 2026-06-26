-- Migration 014: User suspension flag

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMP NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_reason TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_users_suspended ON users(is_suspended) WHERE is_suspended = true;
