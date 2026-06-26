const db = require('../db');

// Checks that the authenticated user's listing has at least one of the named addons active.
// addonType can be a string or an array of strings (OR logic).
function requireAddon(addonType) {
  const types = Array.isArray(addonType) ? addonType : [addonType];
  return async (req, res, next) => {
    try {
      const listingRes = await db.query(
        'SELECT id FROM listings WHERE user_id = $1 AND country_code = $2',
        [req.user.id, req.countryCode]
      );
      if (!listingRes.rows.length) {
        return res.status(404).json({ error: 'You do not have a listing' });
      }

      req.listingId = listingRes.rows[0].id;

      const addonRes = await db.query(
        `SELECT id FROM listing_addons WHERE listing_id = $1 AND addon_type = ANY($2) AND status = 'active'`,
        [req.listingId, types]
      );
      if (!addonRes.rows.length) {
        return res.status(403).json({
          error: `The "${types[0]}" addon is required. Upgrade your subscription to access this feature.`,
          addon_required: types[0],
        });
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireAddon };
