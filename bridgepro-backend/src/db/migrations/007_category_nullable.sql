-- Migration 007: Make legacy category varchar nullable now that category_id is the source of truth

ALTER TABLE listings ALTER COLUMN category DROP NOT NULL;
