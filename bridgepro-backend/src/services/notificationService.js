const { sendPush } = require('./pushService');
const db = require('../db');

async function notify(userId, type, title, body, data = {}) {
  // Always persist in DB so the in-app inbox catches what push misses
  db.query(
    `INSERT INTO notifications (user_id, type, title, body, data)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, type, title, body || null, JSON.stringify(data)]
  ).catch(() => {});

  // Best-effort push
  sendPush(userId, title, body, { url: '/dashboard', ...data }).catch(() => {});
}

module.exports = { notify };
