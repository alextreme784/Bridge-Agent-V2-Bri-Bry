/**
 * Expansion Engine — countries table migration + seed
 * Run once: node src/db/migrate_countries.js
 * Safe to re-run — uses ON CONFLICT DO UPDATE for all inserts.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const db = require('./index');

const ISLANDS = [
  { code: 'SVG', domain_slug: 'bridgepro-svg', display_name: 'St. Vincent & the Grenadines', is_live: true,  currency: 'XCD', flag: '🇻🇨', theme_color: '#009E60' },
  { code: 'BRB', domain_slug: 'bridgepro-brb', display_name: 'Barbados',                    is_live: false, currency: 'BBD', flag: '🇧🇧', theme_color: '#00267F' },
  { code: 'SLU', domain_slug: 'bridgepro-slu', display_name: 'St. Lucia',                   is_live: false, currency: 'XCD', flag: '🇱🇨', theme_color: '#65CFFF' },
  { code: 'GRD', domain_slug: 'bridgepro-grd', display_name: 'Grenada',                     is_live: false, currency: 'XCD', flag: '🇬🇩', theme_color: '#CE1126' },
  { code: 'DMA', domain_slug: 'bridgepro-dma', display_name: 'Dominica',                    is_live: false, currency: 'XCD', flag: '🇩🇲', theme_color: '#006B3F' },
  { code: 'ATG', domain_slug: 'bridgepro-atg', display_name: 'Antigua & Barbuda',           is_live: false, currency: 'XCD', flag: '🇦🇬', theme_color: '#CE1126' },
  { code: 'SKN', domain_slug: 'bridgepro-skn', display_name: 'St. Kitts & Nevis',           is_live: false, currency: 'XCD', flag: '🇰🇳', theme_color: '#009E60' },
  { code: 'TTO', domain_slug: 'bridgepro-tto', display_name: 'Trinidad & Tobago',           is_live: false, currency: 'TTD', flag: '🇹🇹', theme_color: '#CE1126' },
  { code: 'JAM', domain_slug: 'bridgepro-jam', display_name: 'Jamaica',                     is_live: false, currency: 'JMD', flag: '🇯🇲', theme_color: '#009B3A' },
  { code: 'GUY', domain_slug: 'bridgepro-guy', display_name: 'Guyana',                      is_live: false, currency: 'GYD', flag: '🇬🇾', theme_color: '#009E60' },
  { code: 'BLZ', domain_slug: 'bridgepro-blz', display_name: 'Belize',                      is_live: false, currency: 'BZD', flag: '🇧🇿', theme_color: '#003F87' },
  { code: 'BHS', domain_slug: 'bridgepro-bhs', display_name: 'Bahamas',                     is_live: false, currency: 'BSD', flag: '🇧🇸', theme_color: '#00778B' },
  { code: 'TCA', domain_slug: 'bridgepro-tca', display_name: 'Turks & Caicos',              is_live: false, currency: 'USD', flag: '🇹🇨', theme_color: '#003082' },
];

async function run() {
  // 1. Create table
  await db.query(`
    CREATE TABLE IF NOT EXISTS countries (
      code         VARCHAR(10)  PRIMARY KEY,
      domain_slug  VARCHAR(50)  NOT NULL UNIQUE,
      display_name VARCHAR(100) NOT NULL,
      is_live      BOOLEAN      NOT NULL DEFAULT false,
      currency     VARCHAR(10)  NOT NULL DEFAULT 'XCD',
      flag         VARCHAR(10),
      theme_color  VARCHAR(20),
      created_at   TIMESTAMP    DEFAULT NOW(),
      updated_at   TIMESTAMP    DEFAULT NOW()
    )
  `);
  console.log('  ✓ countries table ready');

  // 2. Seed all 13 islands — preserve existing is_live state on re-run (DO NOTHING for is_live)
  for (const island of ISLANDS) {
    await db.query(`
      INSERT INTO countries (code, domain_slug, display_name, is_live, currency, flag, theme_color)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (code) DO UPDATE SET
        domain_slug  = EXCLUDED.domain_slug,
        display_name = EXCLUDED.display_name,
        currency     = EXCLUDED.currency,
        flag         = EXCLUDED.flag,
        theme_color  = EXCLUDED.theme_color,
        updated_at   = NOW()
    `, [island.code, island.domain_slug, island.display_name, island.is_live, island.currency, island.flag, island.theme_color]);
  }
  console.log('  ✓ 13 islands seeded');

  // 3. Sync any existing platform_settings market_live_* values into the new table
  //    so previous toggles are preserved
  const { rows: existing } = await db.query(
    "SELECT key, value FROM platform_settings WHERE key LIKE 'market_live_%'"
  );
  for (const row of existing) {
    const code = row.key.replace('market_live_', '').toUpperCase();
    if (code === 'SVG') continue; // flagship always stays live
    await db.query(
      'UPDATE countries SET is_live = $1, updated_at = NOW() WHERE code = $2',
      [row.value === 'true', code]
    );
  }
  if (existing.length) console.log(`  ✓ Synced ${existing.length} existing platform_settings entries`);

  // 4. Flagship protection — SVG can never be false in the DB
  await db.query("UPDATE countries SET is_live = true, updated_at = NOW() WHERE code = 'SVG'");
  console.log('  ✓ SVG flagship protection enforced');

  console.log('\nExpansion Engine migration complete.');
  process.exit(0);
}

run().catch(err => { console.error('Migration failed:', err.message); process.exit(1); });
