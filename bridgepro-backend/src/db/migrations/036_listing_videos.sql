-- Migration 036: Short video clips for Government & Public (sites, parks, etc.)
CREATE TABLE IF NOT EXISTS listing_videos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id    UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  country_code  VARCHAR(10) NOT NULL,
  video_url     TEXT NOT NULL,
  video_key     TEXT,
  uploaded_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  display_order INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_listing_videos_listing ON listing_videos(listing_id);
