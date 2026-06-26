-- Migration 015: Enquiries (service request messages from customers to providers)

CREATE TYPE enquiry_status AS ENUM ('pending', 'accepted', 'declined');

CREATE TABLE IF NOT EXISTS enquiries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  country_code VARCHAR(10) NOT NULL,
  listing_id UUID REFERENCES listings(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES users(id),
  provider_id UUID REFERENCES users(id),
  message TEXT NOT NULL,
  item_id UUID REFERENCES listing_items(id) ON DELETE SET NULL NULL,
  status enquiry_status DEFAULT 'pending',
  decline_reason TEXT NULL,
  transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_enquiries_provider ON enquiries(provider_id);
CREATE INDEX IF NOT EXISTS idx_enquiries_customer ON enquiries(customer_id);
CREATE INDEX IF NOT EXISTS idx_enquiries_listing ON enquiries(listing_id);
CREATE INDEX IF NOT EXISTS idx_enquiries_status ON enquiries(status);
