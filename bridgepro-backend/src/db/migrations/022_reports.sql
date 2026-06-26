-- 022_reports: user-submitted reports for listings and job postings
CREATE TABLE IF NOT EXISTS reports (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  country_code CHAR(2) NOT NULL,
  target_type  VARCHAR(20) NOT NULL CHECK (target_type IN ('listing', 'job')),
  target_id    UUID NOT NULL,
  reason       VARCHAR(50) NOT NULL,
  details      TEXT,
  status       VARCHAR(20) NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'reviewed', 'resolved', 'dismissed')),
  admin_note   TEXT,
  reviewed_by  UUID REFERENCES users(id),
  reviewed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reports_country ON reports(country_code);
CREATE INDEX IF NOT EXISTS idx_reports_status  ON reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_target  ON reports(target_type, target_id);
