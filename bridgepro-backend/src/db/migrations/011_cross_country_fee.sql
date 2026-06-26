ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS is_cross_country     BOOLEAN        NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS customer_country_code VARCHAR(10)   NULL,
  ADD COLUMN IF NOT EXISTS base_amount          NUMERIC(10,2)  NULL,
  ADD COLUMN IF NOT EXISTS cross_country_fee    NUMERIC(10,2)  NULL;
