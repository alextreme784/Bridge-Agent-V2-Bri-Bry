const db = require('../db');

const _cache = {};
const _cacheTs = {};
const TTL_MS = 60_000;

async function _get(key, defaultValue) {
  const now = Date.now();
  if (_cache[key] !== undefined && now - (_cacheTs[key] || 0) < TTL_MS) return _cache[key];
  try {
    const r = await db.query('SELECT value FROM platform_settings WHERE key = $1', [key]);
    _cache[key] = r.rows.length ? r.rows[0].value : defaultValue;
  } catch {
    _cache[key] = defaultValue;
  }
  _cacheTs[key] = now;
  return _cache[key];
}

async function isFreePeriodActive() {
  const val = await _get('free_period_active', process.env.FREE_PERIOD_ACTIVE !== 'false' ? 'true' : 'false');
  return val === 'true';
}

async function isPointsEnabled() {
  const val = await _get('points_enabled', 'true');
  return val === 'true';
}

// Returns how many cents each point is worth (e.g. 1.0 = 100 pts per $1, 0.5 = 200 pts per $1)
async function getPointValueCents() {
  const val = await _get('point_value_cents', '1.0');
  return parseFloat(val) || 1.0;
}

async function isSponsoredEnabled() {
  const val = await _get('sponsored_listings_enabled', 'false');
  return val === 'true';
}

async function isAdsEnabled() {
  const val = await _get('ads_enabled', process.env.ADS_ENABLED === 'true' ? 'true' : 'false');
  return val === 'true';
}

async function isFirstImpressionEnabled() {
  const val = await _get('first_impression_enabled', 'true');
  return val === 'true';
}

async function isConnekEnabled() {
  const val = await _get('connek_enabled', 'false');
  return val === 'true';
}

function invalidate() {
  Object.keys(_cache).forEach((k) => delete _cache[k]);
  Object.keys(_cacheTs).forEach((k) => delete _cacheTs[k]);
}

async function getSubscriptionPrice(accountType, tier) {
  const key = `${(tier || 'level1').toUpperCase()}_PRICE`;
  const r = await db.query('SELECT value FROM platform_settings WHERE key = $1', [key]);
  const base = parseFloat(r.rows[0]?.value || '5');
  return accountType === 'small_business' ? base * 2 : base;
}

module.exports = { isFreePeriodActive, isPointsEnabled, getPointValueCents, isSponsoredEnabled, isAdsEnabled, isFirstImpressionEnabled, isConnekEnabled, invalidate, getSubscriptionPrice };
