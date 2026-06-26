const webPush = require('web-push');
const db = require('../db');

webPush.setVapidDetails(
  `mailto:${process.env.VAPID_EMAIL}`,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ── Firebase Admin (FCM) — initialised only when credentials are present ──────

let _fcmApp = null;

function getFcmApp() {
  if (_fcmApp) return _fcmApp;
  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) return null;
  try {
    const admin = require('firebase-admin');
    if (admin.apps.length) {
      _fcmApp = admin.apps[0];
    } else {
      _fcmApp = admin.initializeApp({
        credential: admin.credential.cert({
          projectId: FIREBASE_PROJECT_ID,
          clientEmail: FIREBASE_CLIENT_EMAIL,
          privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }),
      });
    }
    return _fcmApp;
  } catch (err) {
    console.error('[FCM] init error:', err.message);
    return null;
  }
}

// ── VAPID web-push ─────────────────────────────────────────────────────────────

async function sendVapidPush(userId, title, body, data = {}) {
  const result = await db.query(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
    [userId]
  );
  if (!result.rows.length) return;

  const payload = JSON.stringify({ title, body, data });

  // Dynamic VAPID headers for high delivery urgency & collapsing topics
  const options = {
    TTL: data.ttl !== undefined ? data.ttl : 12 * 60 * 60, // 12-hour shelf life
    urgency: data.urgency || 'high',
    headers: {}
  };

  if (data.conversationId) {
    options.headers['Topic'] = `chat_conv_${data.conversationId}`;
  } else if (data.topic) {
    options.headers['Topic'] = data.topic;
  }

  await Promise.allSettled(
    result.rows.map(async (sub) => {
      try {
        await webPush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          options
        );
      } catch (err) {
        // Evict subscription if expired (410), not registered (404), or invalid parameters (400)
        if (err.statusCode === 410 || err.statusCode === 404 || err.statusCode === 400) {
          await db.query(
            'DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2',
            [userId, sub.endpoint]
          ).catch(() => {});
        }
      }
    })
  );
}

// ── FCM push ───────────────────────────────────────────────────────────────────

async function sendFcmPush(userId, title, body, data = {}) {
  const app = getFcmApp();
  if (!app) return;

  const row = await db.query('SELECT fcm_token FROM users WHERE id = $1', [userId]);
  const token = row.rows[0]?.fcm_token;
  if (!token) return;

  try {
    const admin = require('firebase-admin');
    const stringData = Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, String(v)])
    );
    await admin.messaging(app).send({
      token,
      notification: { title, body },
      webpush: {
        notification: {
          title,
          body,
          icon: '/icons/icon-192.png',
        },
        fcmOptions: { link: data.url || '/#/connect' },
      },
      data: stringData,
    });
    console.log('[FCM] sent to user', userId);
  } catch (err) {
    console.error('[FCM] send error for user', userId, ':', err.message);
    // Token invalid — clear it so we don't retry
    if (err.code === 'messaging/invalid-registration-token' ||
        err.code === 'messaging/registration-token-not-registered') {
      await db.query('UPDATE users SET fcm_token = NULL WHERE id = $1', [userId]).catch(() => {});
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

async function sendPush(userId, title, body, data = {}) {
  await Promise.allSettled([
    sendVapidPush(userId, title, body, data),
    sendFcmPush(userId, title, body, data),
  ]);
}

function buildMessageBody(message) {
  if (!message) return '';
  const body = message.body || '';
  if (body.endsWith('.webm') || body.includes('.webm?')) return 'Sent a voice note';
  return body.slice(0, 80);
}

async function notifyNewMessage(recipientUserId, senderName, conversationId, message) {
  const body = message ? buildMessageBody(message) : `${senderName} sent you a message`;
  const url = `/#/connect?cid=${conversationId}`;

  // Persist to notifications table so the in-app drop-down menu gets updated
  try {
    await db.query(
      `INSERT INTO notifications (user_id, type, title, body, data)
       VALUES ($1, 'social', $2, $3, $4)`,
      [recipientUserId, `New message from ${senderName}`, body, JSON.stringify({ url, conversationId: String(conversationId) })]
    );
  } catch (err) {
    console.error('Failed to insert chat notification:', err.message);
  }

  await sendPush(
    recipientUserId,
    `New message from ${senderName}`,
    body,
    { url, conversationId: String(conversationId) }
  );
}

async function notifyBridgeClosed(recipientUserId, conversationId) {
  const url = `/#/connect?cid=${conversationId}`;

  // Persist to notifications table so the in-app drop-down menu gets updated
  try {
    await db.query(
      `INSERT INTO notifications (user_id, type, title, body, data)
       VALUES ($1, 'social', $2, 'A conversation has been closed', $3)`,
      [recipientUserId, 'Bridge Closed', JSON.stringify({ url, conversationId: String(conversationId) })]
    );
  } catch (err) {
    console.error('Failed to insert bridge close notification:', err.message);
  }

  await sendPush(
    recipientUserId,
    'Bridge Closed',
    'A conversation has been closed',
    { url, conversationId: String(conversationId) }
  );
}

module.exports = { sendPush, sendVapidPush, sendFcmPush, notifyNewMessage, notifyBridgeClosed };
