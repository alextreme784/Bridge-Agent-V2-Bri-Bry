require('dotenv').config();
const { pool } = require('./index');

async function migrateBridgeSocial() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── Bridge Social ─────────────────────────────────────────────────────────

    await client.query(`
      CREATE TABLE IF NOT EXISTS bs_categories (
        id           SERIAL PRIMARY KEY,
        name         VARCHAR(255) NOT NULL,
        slug         VARCHAR(255) UNIQUE NOT NULL,
        provider_only BOOLEAN DEFAULT false,
        created_at   TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('  ✓ bs_categories');

    await client.query(`
      INSERT INTO bs_categories (id, name, slug, provider_only) VALUES
        (1, 'General Discussion',    'general',       false),
        (2, 'Provider Lounge',       'provider-lounge', true),
        (3, 'Jobs and Opportunities','jobs',           false),
        (4, 'Business Tips',         'business-tips',  true),
        (5, 'Announcements',         'announcements',  false)
      ON CONFLICT (id) DO NOTHING
    `);
    console.log('  ✓ bs_categories seeded');

    await client.query(`
      CREATE TABLE IF NOT EXISTS bs_topics (
        id          SERIAL PRIMARY KEY,
        category_id INTEGER REFERENCES bs_categories(id) ON DELETE CASCADE,
        user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
        title       VARCHAR(255) NOT NULL,
        body        TEXT,
        views       INTEGER DEFAULT 0,
        created_at  TIMESTAMP DEFAULT NOW(),
        expires_at  TIMESTAMP DEFAULT (NOW() + INTERVAL '90 days')
      )
    `);
    console.log('  ✓ bs_topics');

    await client.query(`
      CREATE TABLE IF NOT EXISTS bs_replies (
        id         SERIAL PRIMARY KEY,
        topic_id   INTEGER REFERENCES bs_topics(id) ON DELETE CASCADE,
        user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
        body       TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        expires_at TIMESTAMP DEFAULT (NOW() + INTERVAL '90 days')
      )
    `);
    console.log('  ✓ bs_replies');

    await client.query(`
      CREATE TABLE IF NOT EXISTS bs_votes (
        id         SERIAL PRIMARY KEY,
        topic_id   INTEGER REFERENCES bs_topics(id) ON DELETE CASCADE,
        user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
        value      INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (topic_id, user_id)
      )
    `);
    console.log('  ✓ bs_votes');

    await client.query(`
      CREATE TABLE IF NOT EXISTS bs_videos (
        id          SERIAL PRIMARY KEY,
        user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
        title       VARCHAR(255) NOT NULL,
        description TEXT,
        youtube_url VARCHAR(512),
        status      VARCHAR(50) DEFAULT 'pending',
        created_at  TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('  ✓ bs_videos');

    // ── Bridge Connect ────────────────────────────────────────────────────────

    await client.query(`
      CREATE TABLE IF NOT EXISTS bc_conversations (
        id          SERIAL PRIMARY KEY,
        listing_id  UUID REFERENCES listings(id) ON DELETE SET NULL,
        customer_id UUID REFERENCES users(id) ON DELETE SET NULL,
        provider_id UUID REFERENCES users(id) ON DELETE SET NULL,
        status      VARCHAR(50) DEFAULT 'open',
        created_at  TIMESTAMP DEFAULT NOW(),
        expires_at  TIMESTAMP DEFAULT (NOW() + INTERVAL '90 days'),
        closed_at   TIMESTAMP
      )
    `);
    console.log('  ✓ bc_conversations');

    await client.query(`
      CREATE TABLE IF NOT EXISTS bc_messages (
        id              SERIAL PRIMARY KEY,
        conversation_id INTEGER REFERENCES bc_conversations(id) ON DELETE CASCADE,
        sender_id       UUID REFERENCES users(id) ON DELETE SET NULL,
        body            TEXT,
        message_type    VARCHAR(50) DEFAULT 'text',
        file_url        VARCHAR(512),
        created_at      TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('  ✓ bc_messages');

    await client.query(`ALTER TABLE bc_messages ADD COLUMN IF NOT EXISTS file_name TEXT`);
    console.log('  ✓ bc_messages.file_name');

    await client.query(`ALTER TABLE bc_messages ADD COLUMN IF NOT EXISTS file_type TEXT`);
    console.log('  ✓ bc_messages.file_type');

    await client.query('COMMIT');
    console.log('\nBridge Social & Bridge Connect tables created successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrateBridgeSocial().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
