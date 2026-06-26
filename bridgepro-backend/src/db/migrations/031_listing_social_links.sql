-- Migration 031: Add social media links to listings

ALTER TABLE listings ADD COLUMN IF NOT EXISTS facebook_url TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS instagram_url TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS twitter_url TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS linkedin_url TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS tiktok_url TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS youtube_url TEXT;
