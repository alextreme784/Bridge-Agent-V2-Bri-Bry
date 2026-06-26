-- Customer intent type: customer, seeking, part_time, full_time, hustle
ALTER TABLE users ADD COLUMN IF NOT EXISTS customer_type VARCHAR(20) DEFAULT 'customer';

-- CV profile fields stored directly on user row
ALTER TABLE users ADD COLUMN IF NOT EXISTS cv_skills TEXT[] DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS cv_experience TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS cv_availability VARCHAR(20);

-- Job listings posted by businesses / providers / customers hiring
CREATE TABLE IF NOT EXISTS job_listings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  country_code VARCHAR(10) NOT NULL,
  title        VARCHAR(200) NOT NULL,
  description  TEXT NOT NULL,
  category_id  UUID REFERENCES categories(id),
  job_type     VARCHAR(20) NOT NULL DEFAULT 'one_off',
  location     VARCHAR(200),
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_listings_country ON job_listings(country_code, is_active);
CREATE INDEX IF NOT EXISTS idx_job_listings_user    ON job_listings(user_id);
