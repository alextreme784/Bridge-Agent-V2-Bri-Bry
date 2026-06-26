const express = require('express');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const socketService = require('../services/socketService');
const { notifyNewMessage } = require('../services/pushService');
const { uploadBuffer } = require('../services/storage');
const { awardPoints } = require('../services/points');

const memUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const allowed = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'audio/webm', 'audio/ogg'];
    cb(null, allowed.includes(file.mimetype));
  },
});

const router = express.Router();

// ── BridgeMeet tables ─────────────────────────────────────────────────────────
db.query(`
  CREATE TABLE IF NOT EXISTS bridgemeet_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user1_id UUID REFERENCES users(id) ON DELETE SET NULL,
    user2_id UUID REFERENCES users(id) ON DELETE SET NULL,
    scope VARCHAR(20) DEFAULT 'local',
    country_code VARCHAR(10),
    status VARCHAR(20) DEFAULT 'active',
    started_at TIMESTAMPTZ DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    both_revealed BOOLEAN DEFAULT false,
    user1_revealed BOOLEAN DEFAULT false,
    user2_revealed BOOLEAN DEFAULT false
  )
`).catch(() => {});

db.query(`
  CREATE TABLE IF NOT EXISTS bridgemeet_pool (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    scope VARCHAR(20) DEFAULT 'local',
    country_code VARCHAR(10),
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    shake_at TIMESTAMPTZ
  )
`).catch(() => {});

const CARIBBEAN_COUNTRIES = ['VC','BB','LC','GD','AG','DM','KN','MS','TT','JM'];

// POST /api/connect/start — start a new conversation with a provider (business listing)
router.post('/start', requireAuth, async (req, res, next) => {
  try {
    const { listing_id } = req.body;
    if (!listing_id) return res.status(400).json({ error: 'listing_id is required' });

    const listing = await db.query(
      'SELECT id, user_id, business_name FROM listings WHERE id = $1 AND is_active = true',
      [listing_id]
    );
    if (!listing.rows.length) return res.status(404).json({ error: 'Listing not found' });

    const provider_id = listing.rows[0].user_id;
    if (provider_id === req.user.id) {
      return res.status(400).json({ error: 'You cannot start a conversation with your own listing' });
    }

    const existing = await db.query(
      `SELECT * FROM bc_conversations
       WHERE listing_id = $1 AND customer_id = $2 AND status = 'open'
       ORDER BY created_at DESC LIMIT 1`,
      [listing_id, req.user.id]
    );
    if (existing.rows.length) {
      return res.json({ conversation: existing.rows[0] });
    }

    const result = await db.query(
      `INSERT INTO bc_conversations (listing_id, customer_id, provider_id)
       VALUES ($1, $2, $3) RETURNING *`,
      [listing_id, req.user.id, provider_id]
    );

    res.status(201).json({ conversation: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/connect/start-job — start a new conversation from a job listing
router.post('/start-job', requireAuth, async (req, res, next) => {
  try {
    const { job_id } = req.body;
    if (!job_id) return res.status(400).json({ error: 'job_id is required' });

    const job = await db.query(
      'SELECT id, user_id, title FROM job_listings WHERE id = $1 AND is_active = true',
      [job_id]
    );
    if (!job.rows.length) return res.status(404).json({ error: 'Job listing not found' });

    const provider_id = job.rows[0].user_id;
    if (provider_id === req.user.id) {
      return res.status(400).json({ error: 'You cannot start a conversation with your own listing' });
    }

    const existing = await db.query(
      `SELECT * FROM bc_conversations
       WHERE job_id = $1 AND customer_id = $2 AND status = 'open'
       ORDER BY created_at DESC LIMIT 1`,
      [job_id, req.user.id]
    );
    if (existing.rows.length) {
      return res.json({ conversation: existing.rows[0] });
    }

    const result = await db.query(
      `INSERT INTO bc_conversations (job_id, customer_id, provider_id)
       VALUES ($1, $2, $3) RETURNING *`,
      [job_id, req.user.id, provider_id]
    );

    res.status(201).json({ conversation: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/connect/conversations — all conversations for the logged-in user
router.get('/conversations', requireAuth, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT
         c.id, c.status, c.created_at, c.expires_at, c.closed_at,
         COALESCE(l.business_name, jl.title, 'Conversation') AS listing_title,
         cu.full_name    AS customer_name,
         pr.full_name    AS provider_name,
         CASE
           WHEN c.customer_id = $1 THEN pr.full_name
           ELSE cu.full_name
         END AS other_party_name,
         (SELECT id FROM bc_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message_id,
         (SELECT body FROM bc_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message_body,
         (SELECT sender_id FROM bc_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message_sender_id,
         (SELECT COUNT(*)::int FROM bc_messages WHERE conversation_id = c.id AND is_read = false AND sender_id != $1) AS unread_count
       FROM bc_conversations c
       LEFT JOIN listings     l  ON l.id  = c.listing_id
       LEFT JOIN job_listings jl ON jl.id = c.job_id
       JOIN users    cu ON cu.id = c.customer_id
       JOIN users    pr ON pr.id = c.provider_id
       WHERE c.customer_id = $1 OR c.provider_id = $1
       ORDER BY c.created_at DESC`,
      [req.user.id]
    );

    res.json({ conversations: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/connect/conversations/:id — full message history for a conversation
router.get('/conversations/:id', requireAuth, async (req, res, next) => {
  try {
    const conv = await db.query(
      `SELECT c.*,
              COALESCE(l.business_name, jl.title, 'Conversation') AS listing_title,
              cu.full_name    AS customer_name,
              pr.full_name    AS provider_name
       FROM bc_conversations c
       LEFT JOIN listings     l  ON l.id  = c.listing_id
       LEFT JOIN job_listings jl ON jl.id = c.job_id
       JOIN users    cu ON cu.id = c.customer_id
       JOIN users    pr ON pr.id = c.provider_id
       WHERE c.id = $1`,
      [req.params.id]
    );
    if (!conv.rows.length) return res.status(404).json({ error: 'Conversation not found' });

    const c = conv.rows[0];
    if (c.customer_id !== req.user.id && c.provider_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Mark messages from other sender as read
    await db.query(
      `UPDATE bc_messages
       SET is_read = true
       WHERE conversation_id = $1 AND sender_id != $2 AND is_read = false`,
      [req.params.id, req.user.id]
    );

    const messages = await db.query(
      `SELECT m.*, u.full_name AS sender_name
       FROM bc_messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = $1
       ORDER BY m.created_at ASC`,
      [req.params.id]
    );

    res.json({ conversation: c, messages: messages.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/connect/conversations/:id/upload — upload a file attachment
router.post('/conversations/:id/upload', requireAuth, upload('connect').single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const conv = await db.query(
      'SELECT customer_id, provider_id, status FROM bc_conversations WHERE id = $1',
      [req.params.id]
    );
    if (!conv.rows.length) return res.status(404).json({ error: 'Conversation not found' });

    const c = conv.rows[0];
    if (c.customer_id !== req.user.id && c.provider_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (c.status === 'closed') {
      return res.status(400).json({ error: 'Conversation is closed' });
    }

    const file_url  = `/uploads/connect/${req.file.filename}`;
    const isImage   = req.file.mimetype.startsWith('image/');

    res.json({
      file_url,
      file_name:  req.file.originalname,
      file_type:  isImage ? 'image' : 'file',
      mime_type:  req.file.mimetype,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/connect/conversations/:id/files — upload a file and save as message
router.post('/conversations/:id/files', requireAuth, memUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided or unsupported file type' });

    const conv = await db.query(
      'SELECT customer_id, provider_id, status FROM bc_conversations WHERE id = $1',
      [req.params.id]
    );
    if (!conv.rows.length) return res.status(404).json({ error: 'Conversation not found' });

    const c = conv.rows[0];
    if (c.customer_id !== req.user.id && c.provider_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (c.status === 'closed') {
      return res.status(400).json({ error: 'Conversation is closed' });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    const { url } = await uploadBuffer(req.file.buffer, 'connect-files', ext, req.file.mimetype);

    const result = await db.query(
      `INSERT INTO bc_messages (conversation_id, sender_id, body, message_type, file_name, file_type)
       VALUES ($1, $2, $3, 'file', $4, $5) RETURNING *`,
      [req.params.id, req.user.id, url, req.file.originalname, req.file.mimetype]
    );

    const saved = result.rows[0];
    const userRow = await db.query('SELECT full_name FROM users WHERE id = $1', [req.user.id]);
    saved.sender_name = userRow.rows[0]?.full_name || '';

    try { socketService.getIO().to(String(req.params.id)).emit('receive_message', saved); } catch {}
    const recipientId = req.user.id === c.customer_id ? c.provider_id : c.customer_id;
    notifyNewMessage(recipientId, saved.sender_name, req.params.id, saved).catch(() => {});

    res.status(201).json({ message: saved });
  } catch (err) {
    next(err);
  }
});

// POST /api/connect/conversations/:id/message — send a message
router.post('/conversations/:id/message', requireAuth, async (req, res, next) => {
  try {
    const { body, message_type, file_url } = req.body;
    if (!body && !file_url) return res.status(400).json({ error: 'body or file_url is required' });

    const conv = await db.query(
      'SELECT customer_id, provider_id, status FROM bc_conversations WHERE id = $1',
      [req.params.id]
    );
    if (!conv.rows.length) return res.status(404).json({ error: 'Conversation not found' });

    const c = conv.rows[0];
    if (c.customer_id !== req.user.id && c.provider_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (c.status === 'closed') {
      return res.status(400).json({ error: 'Conversation is closed' });
    }

    const result = await db.query(
      `INSERT INTO bc_messages (conversation_id, sender_id, body, message_type, file_url)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.params.id, req.user.id, body?.trim() || null, message_type || 'text', file_url || null]
    );

    const saved = result.rows[0];

    const userRow = await db.query('SELECT full_name FROM users WHERE id = $1', [req.user.id]);
    saved.sender_name = userRow.rows[0]?.full_name || '';

    try {
      socketService.getIO().to(String(req.params.id)).emit('receive_message', saved);
    } catch {}

    const recipientId = req.user.id === c.customer_id ? c.provider_id : c.customer_id;
    notifyNewMessage(recipientId, saved.sender_name, req.params.id, saved).catch(() => {});

    res.status(201).json({ message: saved });
  } catch (err) {
    next(err);
  }
});

// POST /api/connect/conversations/:id/close — close a conversation
router.post('/conversations/:id/close', requireAuth, async (req, res, next) => {
  try {
    const conv = await db.query(
      'SELECT customer_id, provider_id, status FROM bc_conversations WHERE id = $1',
      [req.params.id]
    );
    if (!conv.rows.length) return res.status(404).json({ error: 'Conversation not found' });

    const c = conv.rows[0];
    if (c.customer_id !== req.user.id && c.provider_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (c.status === 'closed') {
      return res.status(400).json({ error: 'Conversation is already closed' });
    }

    const result = await db.query(
      `UPDATE bc_conversations
       SET status = 'closed', closed_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    res.json({ conversation: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ── BridgeMeet ────────────────────────────────────────────────────────────────

// POST /api/connect/bridgemeet/join
router.post('/bridgemeet/join', requireAuth, async (req, res, next) => {
  try {
    const { scope = 'local' } = req.body;
    if (!['local', 'regional', 'international'].includes(scope)) {
      return res.status(400).json({ error: 'scope must be local, regional, or international' });
    }

    // Auto-cleanup stale sessions older than 10 minutes
    await db.query(
      `UPDATE bridgemeet_sessions SET status='expired', ended_at=NOW()
       WHERE status='active' AND started_at < NOW() - INTERVAL '10 minutes'`
    ).catch(() => {});

    // If already in an active session, return it (don't error — let frontend resume)
    const active = await db.query(
      `SELECT * FROM bridgemeet_sessions WHERE (user1_id=$1 OR user2_id=$1) AND status='active'`,
      [req.user.id]
    );
    if (active.rows.length) {
      const session = active.rows[0];
      return res.json({
        status: 'already_matched',
        session,
        room_id: 'bridgemeet_' + session.id,
      });
    }

    // Fix: Check authenticated model first, fall back safely to parsed middleware code
    const countryCode = req.user?.country_code || req.countryCode || 'SVG';
    await db.query(
      `INSERT INTO bridgemeet_pool (user_id, scope, country_code)
       VALUES ($1,$2,$3)
       ON CONFLICT (user_id) DO UPDATE SET scope=$2, country_code=$3, joined_at=NOW(), shake_at=NULL`,
      [req.user.id, scope, countryCode]
    );
    res.json({ status: 'in_pool', scope, country_code: countryCode });
  } catch (err) { next(err); }
});

// POST /api/connect/bridgemeet/leave
router.post('/bridgemeet/leave', requireAuth, async (req, res, next) => {
  try {
    await db.query('DELETE FROM bridgemeet_pool WHERE user_id=$1', [req.user.id]);
    res.json({ status: 'left' });
  } catch (err) { next(err); }
});

// POST /api/connect/bridgemeet/shake
router.post('/bridgemeet/shake', requireAuth, async (req, res, next) => {
  try {
    const pool = await db.query('SELECT * FROM bridgemeet_pool WHERE user_id=$1', [req.user.id]);
    if (!pool.rows.length) return res.status(400).json({ error: 'Not in BridgeMeet pool — join first' });

    const { scope, country_code } = pool.rows[0];
    await db.query('UPDATE bridgemeet_pool SET shake_at=NOW() WHERE user_id=$1', [req.user.id]);

    // Never match same user twice in a row
    const lastMatch = await db.query(
      `SELECT CASE WHEN user1_id=$1 THEN user2_id ELSE user1_id END AS other_id
       FROM bridgemeet_sessions WHERE (user1_id=$1 OR user2_id=$1) ORDER BY started_at DESC LIMIT 1`,
      [req.user.id]
    );
    const lastMatchId = lastMatch.rows[0]?.other_id || null;

    const params = [req.user.id];
    let where = `user_id!=$1 AND shake_at > NOW() - INTERVAL '30 seconds'`;

    if (scope === 'local') {
      params.push(country_code);
      where += ` AND country_code=$${params.length}`;
    } else if (scope === 'regional') {
      params.push(CARIBBEAN_COUNTRIES);
      where += ` AND country_code=ANY($${params.length})`;
    }
    if (lastMatchId) {
      params.push(lastMatchId);
      where += ` AND user_id!=$${params.length}`;
    }

    const match = await db.query(
      `SELECT user_id, country_code FROM bridgemeet_pool WHERE ${where} ORDER BY shake_at ASC LIMIT 1`,
      params
    );
    if (!match.rows.length) return res.json({ status: 'searching' });

    const matchedUserId = match.rows[0].user_id;
    const sessionCC = scope === 'local' ? country_code : match.rows[0].country_code;

    const sess = await db.query(
      `INSERT INTO bridgemeet_sessions (user1_id,user2_id,scope,country_code) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.user.id, matchedUserId, scope, sessionCC]
    );
    const session = sess.rows[0];

    await db.query('DELETE FROM bridgemeet_pool WHERE user_id=ANY($1)', [[req.user.id, matchedUserId]]);

    // Award 2 points each for shake match
    const userRows = await db.query('SELECT id,country_code FROM users WHERE id=ANY($1)', [[req.user.id, matchedUserId]]);
    const ccMap = {};
    userRows.rows.forEach(u => { ccMap[u.id] = u.country_code || 'VC'; });

    await Promise.all([
      awardPoints(req.user.id, ccMap[req.user.id], 'bridgemeet_shake', 2, session.id),
      awardPoints(matchedUserId, ccMap[matchedUserId], 'bridgemeet_shake', 2, session.id),
    ]).catch(() => {});

    const io = socketService.getIO();
    const roomId = 'bridgemeet_' + session.id;
    const payload = {
      session_id: session.id,
      room_id: roomId,
      scope,
      country_code: sessionCC,
      duration: 300,
    };
    io.to('user_' + req.user.id).emit('bridgemeet_matched', payload);
    io.to('user_' + matchedUserId).emit('bridgemeet_matched', payload);

    res.json({ status: 'matched', session_id: session.id, room_id: roomId });
  } catch (err) { next(err); }
});

// POST /api/connect/bridgemeet/reveal
router.post('/bridgemeet/reveal', requireAuth, async (req, res, next) => {
  try {
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ error: 'session_id is required' });

    const sr = await db.query(
      `SELECT * FROM bridgemeet_sessions WHERE id=$1 AND status='active'`,
      [session_id]
    );
    if (!sr.rows.length) return res.status(404).json({ error: 'Session not found or ended' });
    const s = sr.rows[0];

    const isUser1 = s.user1_id === req.user.id;
    const isUser2 = s.user2_id === req.user.id;
    if (!isUser1 && !isUser2) return res.status(403).json({ error: 'Not in this session' });

    // Check and deduct 10 Bridge Points before revealing
    const balRow = await db.query('SELECT bridge_points FROM users WHERE id = $1', [req.user.id]);
    const balance = parseInt(balRow.rows[0]?.bridge_points, 10) || 0;
    if (balance < 10) {
      return res.status(402).json({ error: 'Not enough Bridge Points to reveal. Earn more by chatting!', code: 'insufficient_points' });
    }
    // Fix: Check authenticated model first, fall back safely to parsed middleware code
    const countryCode = req.user?.country_code || req.countryCode || 'SVG';
    await awardPoints(req.user.id, countryCode, 'bridgemeet_reveal', -10, session_id);

    const myField    = isUser1 ? 'user1_revealed' : 'user2_revealed';
    const otherField = isUser1 ? 'user2_revealed' : 'user1_revealed';
    const otherId    = isUser1 ? s.user2_id : s.user1_id;

    await db.query(`UPDATE bridgemeet_sessions SET ${myField}=true WHERE id=$1`, [session_id]);

    const io = socketService.getIO();
    if (s[otherField]) {
      // Both revealed
      await db.query('UPDATE bridgemeet_sessions SET both_revealed=true WHERE id=$1', [session_id]);
      const users = await db.query('SELECT id,full_name FROM users WHERE id=ANY($1)', [[s.user1_id, s.user2_id]]);
      const names = {};
      users.rows.forEach(u => { names[u.id] = u.full_name; });
      const payload = { session_id, user1: { id: s.user1_id, name: names[s.user1_id] }, user2: { id: s.user2_id, name: names[s.user2_id] } };
      io.to('bridgemeet_' + session_id).emit('bridgemeet_reveal_accepted', payload);
      return res.json({ status: 'both_revealed', ...payload });
    }

    // Only one side — notify other via their user room (works across PM2 instances)
    io.to('user_' + otherId).emit('bridgemeet_reveal_request', { session_id });
    res.json({ status: 'reveal_requested' });
  } catch (err) { next(err); }
});

// POST /api/connect/bridgemeet/end
router.post('/bridgemeet/end', requireAuth, async (req, res, next) => {
  try {
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ error: 'session_id is required' });

    const sr = await db.query(
      `SELECT * FROM bridgemeet_sessions WHERE id=$1 AND status='active'`,
      [session_id]
    );
    if (!sr.rows.length) return res.status(404).json({ error: 'Session not found or already ended' });
    const s = sr.rows[0];
    if (s.user1_id !== req.user.id && s.user2_id !== req.user.id) {
      return res.status(403).json({ error: 'Not in this session' });
    }

    const upd = await db.query(
      `UPDATE bridgemeet_sessions SET status='ended', ended_at=NOW() WHERE id=$1 RETURNING *`,
      [session_id]
    );
    const ended = upd.rows[0];
    const durationMs = new Date(ended.ended_at) - new Date(ended.started_at);
    const lasted3min = durationMs >= 3 * 60 * 1000;
    const otherId = ended.user1_id === req.user.id ? ended.user2_id : ended.user1_id;

    if (lasted3min) {
      const userRows = await db.query('SELECT id,country_code FROM users WHERE id=ANY($1)', [[req.user.id, otherId]]);
      const ccMap = {};
      userRows.rows.forEach(u => { ccMap[u.id] = u.country_code || 'VC'; });
      await Promise.all([
        awardPoints(req.user.id, ccMap[req.user.id], 'bridgemeet_session', 5, session_id),
        awardPoints(otherId, ccMap[otherId], 'bridgemeet_session', 5, session_id),
      ]).catch(() => {});
    }

    const io = socketService.getIO();
    const endPayload = { session_id, duration_ms: durationMs, points_awarded: lasted3min ? 5 : 0 };
    io.to('bridgemeet_' + session_id).emit('bridgemeet_ended', endPayload);
    // Also notify via user rooms (cross-process fallback)
    io.to('user_' + req.user.id).emit('bridgemeet_ended', endPayload);
    io.to('user_' + otherId).emit('bridgemeet_ended', endPayload);
    res.json({ status: 'ended', duration_ms: durationMs, points_awarded: lasted3min ? 5 : 0 });
  } catch (err) { next(err); }
});

// GET /api/connect/bridgemeet/status
router.get('/bridgemeet/status', requireAuth, async (req, res, next) => {
  try {
    const sess = await db.query(
      `SELECT * FROM bridgemeet_sessions WHERE (user1_id=$1 OR user2_id=$1) AND status='active'`,
      [req.user.id]
    );
    if (sess.rows.length) return res.json({ status: 'in_session', session: sess.rows[0] });

    const pool = await db.query('SELECT * FROM bridgemeet_pool WHERE user_id=$1', [req.user.id]);
    if (pool.rows.length) return res.json({ status: 'in_pool', pool: pool.rows[0] });

    res.json({ status: 'idle' });
  } catch (err) { next(err); }
});

module.exports = router;
