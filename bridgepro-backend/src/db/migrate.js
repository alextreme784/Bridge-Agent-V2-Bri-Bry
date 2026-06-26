require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./index');

// Each migration declares one SQL check that returns a row if it was already applied.
// Used to backfill the tracking table on first run against an existing DB.
const APPLIED_IF = {
  '001_initial_schema.sql':    `SELECT 1 FROM pg_type WHERE typname = 'user_role'`,
  '002_photos_and_items.sql':  `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='listing_photos'`,
  '003_subscriptions.sql':     `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='subscription_status'`,
  '004_tiers_and_points.sql':  `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='subscription_tier'`,
  '005_customer_incentives.sql': `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='customer_verified'`,
  '006_categories.sql': `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='categories'`,
  '007_category_nullable.sql': `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='listings' AND column_name='category' AND is_nullable='YES'`,
  '013_notifications.sql': `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='notifications'`,
  '014_user_suspension.sql': `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='is_suspended'`,
  '015_enquiries.sql': `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='enquiries'`,
  '016_user_flags.sql': `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='is_flagged'`,
  '017_job_marketplace.sql': `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='customer_type'`,
  '018_partner_redemption.sql': `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='partner_stores'`,
  '019_account_security.sql': `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='failed_login_attempts'`,
  '020_missing_columns.sql': `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='transactions' AND column_name='document_expires_at'`,
  '021_job_listing_type.sql': `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='job_listings' AND column_name='listing_type'`,
};

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT NOW()
    )
  `);

  const applied = await pool.query('SELECT filename FROM schema_migrations');
  const done = new Set(applied.rows.map((r) => r.filename));

  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

  let ran = 0;
  for (const file of files) {
    if (done.has(file)) {
      console.log(`  skip  ${file} (already applied)`);
      continue;
    }

    // Detect if this migration was applied before we added the tracking table
    const marker = APPLIED_IF[file];
    if (marker) {
      const check = await pool.query(marker);
      if (check.rows.length > 0) {
        await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
        console.log(`  skip  ${file} (backfilled — objects already exist)`);
        continue;
      }
    }

    console.log(`Running migration: ${file}`);
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`  ✓ ${file}`);
      ran++;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  if (ran === 0) {
    console.log('Nothing new to migrate — all migrations already applied.');
  } else {
    console.log(`Done. ${ran} migration(s) applied.`);
  }

  await pool.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
