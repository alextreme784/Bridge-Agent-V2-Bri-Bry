-- Add provider subscription tracking to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(20) NOT NULL DEFAULT 'free_period';
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_start_date TIMESTAMP NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_end_date TIMESTAMP NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS free_period_active BOOLEAN DEFAULT true;

-- Existing customers get 'active' (they never pay)
UPDATE users SET subscription_status = 'active' WHERE role = 'customer';

-- Global platform flags (admin-controlled at runtime)
CREATE TABLE IF NOT EXISTS platform_settings (
  key VARCHAR(100) PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO platform_settings (key, value)
VALUES ('free_period_active', 'true')
ON CONFLICT (key) DO NOTHING;
