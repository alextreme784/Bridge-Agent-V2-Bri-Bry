-- Link partner stores to the partner user who manages them
ALTER TABLE partner_stores
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_partner_stores_owner ON partner_stores(owner_user_id);
