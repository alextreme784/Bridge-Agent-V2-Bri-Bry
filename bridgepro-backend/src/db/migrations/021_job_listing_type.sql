-- Job listing type: 'hiring' (someone wants to hire/post work) vs 'hire_me' (person available for work)
-- 'hire_me' listings are only visible to verified service providers, not regular customers

ALTER TABLE job_listings ADD COLUMN IF NOT EXISTS listing_type VARCHAR(20) NOT NULL DEFAULT 'hiring';

CREATE INDEX IF NOT EXISTS idx_job_listings_type ON job_listings(listing_type);

-- Track who expressed interest in a job listing (prevents duplicate interest submissions)
CREATE TABLE IF NOT EXISTS job_interests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id       UUID NOT NULL REFERENCES job_listings(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(job_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_job_interests_job ON job_interests(job_id);
