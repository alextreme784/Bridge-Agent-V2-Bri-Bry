const jwt = require('jsonwebtoken');
const db = require('../db');

async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }

  const token = header.slice(7);
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const result = await db.query('SELECT is_suspended FROM users WHERE id = $1', [decoded.id]);
    if (result.rows[0]?.is_suspended) {
      return res.status(403).json({ error: 'Your account has been suspended. Please contact support.' });
    }
    req.user = decoded;
    /* Fire-and-forget: update presence columns without blocking the request */
    db.query(
      'UPDATE users SET last_seen_at = NOW(), is_online = true WHERE id = $1',
      [decoded.id]
    ).catch(() => {});
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    next(err);
  }
}

function requireRole(...roles) {
  return [
    requireAuth,
    (req, res, next) => {
      if (!roles.includes(req.user.role)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      next();
    },
  ];
}

module.exports = { requireAuth, requireRole };
