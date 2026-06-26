-- Allow Bridge Connect conversations to be linked to job listings instead of business listings
ALTER TABLE bc_conversations ADD COLUMN IF NOT EXISTS job_id UUID REFERENCES job_listings(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_bc_conversations_job ON bc_conversations(job_id);
