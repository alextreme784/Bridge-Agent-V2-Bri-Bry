ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS guest_customer_name  VARCHAR(255),
  ADD COLUMN IF NOT EXISTS guest_customer_email VARCHAR(255);
