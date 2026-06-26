-- Extends enquiries so customers can submit a formal purchase/service order
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS po_items       JSONB    DEFAULT '[]';
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS po_delivery_date DATE;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS po_notes       TEXT;
