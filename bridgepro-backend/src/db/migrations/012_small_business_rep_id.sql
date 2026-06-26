-- Small business ID verification: representative name and ID document
ALTER TABLE id_verifications
  ADD COLUMN IF NOT EXISTS rep_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS rep_id_doc_url TEXT;
