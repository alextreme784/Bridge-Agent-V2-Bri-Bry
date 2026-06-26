const { getMarketConfig, getCountryBySlug } = require('../config/countries');

// Paths (relative to the /api mount) that bypass the guard so admins can
// always log in, toggle markets, and fetch config on any island.
const EXEMPT = ['/v1/admin', '/v1/auth', '/v1/config/market', '/auth'];

module.exports = async function marketGuard(req, res, next) {
  if (EXEMPT.some(p => req.path.startsWith(p))) return next();

  // URL-slug fallback: if the X-Country-Code header wasn't sent, try to
  // infer the country from the first path segment (e.g. /grd/listing/uuid).
  if (!req.countryCode) {
    const match = req.path.match(/^\/([a-z]{2,10})(\/|$)/i);
    if (match) {
      const code = await getCountryBySlug(match[1]);
      if (code) req.countryCode = code;
    }
  }

  const countryCode = req.countryCode;
  if (!countryCode) return next();

  try {
    const market = await getMarketConfig(countryCode);
    if (!market || !market.isLive) {
      return res.status(403).json({
        error:       'MARKET_COMING_SOON',
        message:     `Bridge is not yet live in ${market?.name || countryCode}. Stay tuned!`,
        countryCode,
        name:        market?.name        || countryCode,
        flag:        market?.flag        || '',
        domainSlug:  market?.domainSlug  || `bridgepro-${countryCode.toLowerCase()}`,
      });
    }
    next();
  } catch {
    next(); // fail open — never block a live market due to a guard error
  }
};
