-- Email uniqueness should be per country, not global.
-- The same person can have an account on Bridge SVG and Bridge Barbados.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;
ALTER TABLE users ADD CONSTRAINT users_email_country_key UNIQUE (email, country_code);

DROP INDEX IF EXISTS idx_users_email;
CREATE INDEX idx_users_email ON users (LOWER(email), country_code);
