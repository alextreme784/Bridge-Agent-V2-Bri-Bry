-- Migration 035: is_public flag for Government & Public listings
ALTER TABLE listings ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT false;
