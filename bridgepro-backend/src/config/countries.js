const db = require('../db');

// Static branding registry — never changes at runtime (colors, flags, currencies).
// The countries table is the authoritative source for is_live and domain_slug.
const REGISTRY = {
  SVG: { countryCode: 'SVG', name: 'St. Vincent & the Grenadines', currency: 'XCD', flag: '🇻🇨', themeColor: '#009E60' },
  BRB: { countryCode: 'BRB', name: 'Barbados',                    currency: 'BBD', flag: '🇧🇧', themeColor: '#00267F' },
  SLU: { countryCode: 'SLU', name: 'St. Lucia',                   currency: 'XCD', flag: '🇱🇨', themeColor: '#65CFFF' },
  GRD: { countryCode: 'GRD', name: 'Grenada',                     currency: 'XCD', flag: '🇬🇩', themeColor: '#CE1126' },
  DMA: { countryCode: 'DMA', name: 'Dominica',                    currency: 'XCD', flag: '🇩🇲', themeColor: '#006B3F' },
  ATG: { countryCode: 'ATG', name: 'Antigua & Barbuda',           currency: 'XCD', flag: '🇦🇬', themeColor: '#CE1126' },
  SKN: { countryCode: 'SKN', name: 'St. Kitts & Nevis',           currency: 'XCD', flag: '🇰🇳', themeColor: '#009E60' },
  TTO: { countryCode: 'TTO', name: 'Trinidad & Tobago',           currency: 'TTD', flag: '🇹🇹', themeColor: '#CE1126' },
  JAM: { countryCode: 'JAM', name: 'Jamaica',                     currency: 'JMD', flag: '🇯🇲', themeColor: '#009B3A' },
  GUY: { countryCode: 'GUY', name: 'Guyana',                      currency: 'GYD', flag: '🇬🇾', themeColor: '#009E60' },
  BLZ: { countryCode: 'BLZ', name: 'Belize',                      currency: 'BZD', flag: '🇧🇿', themeColor: '#003F87' },
  BHS: { countryCode: 'BHS', name: 'Bahamas',                     currency: 'BSD', flag: '🇧🇸', themeColor: '#00778B' },
  TCA: { countryCode: 'TCA', name: 'Turks & Caicos',              currency: 'USD', flag: '🇹🇨', themeColor: '#003082' },
};

// Per-code cache entry: { isLive, domainSlug, expiresAt }
const _cache = {};
const CACHE_TTL = 60_000; // 1 minute

function invalidateMarketCache() {
  Object.keys(_cache).forEach(k => delete _cache[k]);
}

/**
 * Returns full market config for a country code, merging static branding
 * with live DB state. SVG is always isLive=true regardless of DB.
 */
async function getMarketConfig(countryCode) {
  const base = REGISTRY[countryCode];
  if (!base) return null;

  // Flagship protection — SVG can never be offline
  if (countryCode === 'SVG') {
    return { ...base, isLive: true, domainSlug: 'bridgepro-svg' };
  }

  const cached = _cache[countryCode];
  if (cached && cached.expiresAt > Date.now()) {
    return { ...base, isLive: cached.isLive, domainSlug: cached.domainSlug };
  }

  try {
    const { rows } = await db.query(
      'SELECT is_live, domain_slug FROM countries WHERE code = $1',
      [countryCode]
    );
    const isLive     = rows[0]?.is_live  === true;
    const domainSlug = rows[0]?.domain_slug || `bridgepro-${countryCode.toLowerCase()}`;
    _cache[countryCode] = { isLive, domainSlug, expiresAt: Date.now() + CACHE_TTL };
    return { ...base, isLive, domainSlug };
  } catch {
    return { ...base, isLive: false, domainSlug: `bridgepro-${countryCode.toLowerCase()}` };
  }
}

/**
 * Returns all 13 markets with live DB state merged in.
 */
async function getAllMarketConfigs() {
  try {
    const { rows } = await db.query('SELECT code, is_live, domain_slug FROM countries ORDER BY code');
    return rows.map(row => {
      const base = REGISTRY[row.code] || {};
      const isLive = row.code === 'SVG' ? true : row.is_live; // flagship always live
      return { ...base, isLive, domainSlug: row.domain_slug };
    });
  } catch {
    // Fall back to static registry if DB unreachable
    return Object.values(REGISTRY).map(r => ({
      ...r,
      isLive: r.countryCode === 'SVG',
      domainSlug: `bridgepro-${r.countryCode.toLowerCase()}`,
    }));
  }
}

/**
 * Looks up a country code from a URL slug or domain slug.
 * Handles both 'grd' (path prefix) and 'bridgepro-grd' (domain_slug).
 */
async function getCountryBySlug(slug) {
  if (!slug) return null;
  const lower = slug.toLowerCase();
  try {
    const { rows } = await db.query(
      'SELECT code FROM countries WHERE domain_slug = $1 OR LOWER(code) = $1 LIMIT 1',
      [lower]
    );
    return rows[0]?.code || null;
  } catch {
    // Fallback: match against REGISTRY by lowercase code
    const match = Object.keys(REGISTRY).find(c => c.toLowerCase() === lower);
    return match || null;
  }
}

/**
 * BridgePro+ Linker — generates the correct path-based URL for a listing
 * in any target country, enabling inter-island marketing deep links.
 * Example: getRegionalLink('abc-123', 'GRD') → '/grd/listing/abc-123'
 */
function getRegionalLink(listingId, targetCountryCode) {
  const slug = targetCountryCode.toLowerCase();
  return `/${slug}/listing/${listingId}`;
}

module.exports = {
  REGISTRY,
  getMarketConfig,
  getAllMarketConfigs,
  getCountryBySlug,
  getRegionalLink,
  invalidateMarketCache,
};
