const db = require('../db');
const { isFreePeriodActive } = require('../services/platformSettings');

async function checkProviderAccess(req, res, next) {
  if (req.user.role !== 'provider') return next();

  // Global Founder Early Access — all providers pass through
  if (await isFreePeriodActive()) return next();

  try {
    const r = await db.query(
      'SELECT subscription_status, founder_status, tier FROM users WHERE id = $1',
      [req.user.id]
    );
    const u = r.rows[0];
    // Individual founder access overrides everything
    if (u?.founder_status === true) return next();
    // Active subscription or PREMIUM tier
    if (u?.subscription_status === 'active') return next();
    // Legacy free_period status still honoured
    if (u?.subscription_status === 'free_period') return next();
    return res.status(403).json({
      error: 'Your listing is inactive. Please subscribe to reactivate.',
      subscription_required: true,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { checkProviderAccess };
