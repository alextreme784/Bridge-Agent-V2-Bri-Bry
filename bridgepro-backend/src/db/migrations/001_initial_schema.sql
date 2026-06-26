-- BridgePro initial schema

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TYPE user_role AS ENUM ('provider', 'customer', 'admin');
CREATE TYPE account_type AS ENUM ('sole_trader', 'small_business', 'corporate');
CREATE TYPE subscription_status AS ENUM ('active', 'lapsed', 'cancelled');
CREATE TYPE verification_method AS ENUM ('invoice_ninja', 'document_upload', 'single_doc');
CREATE TYPE id_verification_status AS ENUM ('pending', 'approved', 'rejected');

-- Users
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  country_code VARCHAR(10) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  phone VARCHAR(30),
  role user_role NOT NULL DEFAULT 'customer',
  account_type account_type NOT NULL DEFAULT 'sole_trader',
  is_verified BOOLEAN DEFAULT false,
  verified_at TIMESTAMP,
  bridge_points INTEGER DEFAULT 0,
  refresh_token TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_users_country ON users(country_code);
CREATE INDEX idx_users_email ON users(email);

-- Listings (one per user enforced by unique user_id)
CREATE TABLE IF NOT EXISTS listings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  country_code VARCHAR(10) NOT NULL,
  business_name VARCHAR(255) NOT NULL,
  category VARCHAR(100) NOT NULL,
  description TEXT,
  service_areas TEXT[],
  is_active BOOLEAN DEFAULT true,
  subscription_status subscription_status DEFAULT 'active',
  business_reg_no VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW()
);

-- business_reg_no unique per country
CREATE UNIQUE INDEX idx_listings_brn_country ON listings(country_code, business_reg_no) WHERE business_reg_no IS NOT NULL;
CREATE INDEX idx_listings_country_category ON listings(country_code, category);
CREATE INDEX idx_listings_country_active ON listings(country_code, is_active);

-- Transactions
CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  country_code VARCHAR(10) NOT NULL,
  provider_id UUID REFERENCES users(id),
  customer_id UUID REFERENCES users(id),
  invoice_ninja_id VARCHAR(100),
  verification_method verification_method,
  provider_confirmed BOOLEAN DEFAULT false,
  customer_confirmed BOOLEAN DEFAULT false,
  is_verified BOOLEAN DEFAULT false,
  invoice_doc_url TEXT,
  receipt_doc_url TEXT,
  amount DECIMAL(10,2),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_transactions_country ON transactions(country_code);
CREATE INDEX idx_transactions_provider ON transactions(provider_id);
CREATE INDEX idx_transactions_customer ON transactions(customer_id);

-- Reviews
CREATE TABLE IF NOT EXISTS reviews (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id UUID REFERENCES transactions(id) UNIQUE,
  reviewer_id UUID REFERENCES users(id),
  listing_id UUID REFERENCES listings(id),
  country_code VARCHAR(10) NOT NULL,
  rating SMALLINT CHECK (rating >= 1 AND rating <= 5),
  customer_care BOOLEAN DEFAULT false,
  quality BOOLEAN DEFAULT false,
  body TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_reviews_listing ON reviews(listing_id);
CREATE INDEX idx_reviews_country ON reviews(country_code);

-- Bridge Points Log
CREATE TABLE IF NOT EXISTS bridge_points_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id),
  country_code VARCHAR(10) NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  points_awarded INTEGER NOT NULL,
  reference_id UUID,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_points_log_user ON bridge_points_log(user_id);

-- ID Verifications
CREATE TABLE IF NOT EXISTS id_verifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id),
  country_code VARCHAR(10) NOT NULL,
  id_doc_url TEXT NOT NULL,
  status id_verification_status DEFAULT 'pending',
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMP,
  rejection_reason TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_id_verif_status ON id_verifications(status);
CREATE INDEX idx_id_verif_user ON id_verifications(user_id);

-- Admin audit log
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_id UUID REFERENCES users(id),
  action VARCHAR(100) NOT NULL,
  target_id UUID,
  detail TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
