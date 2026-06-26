const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { notify } = require('../services/notificationService');
const { uploadBuffer, deleteObject } = require('../services/storage');
const { awardPoints } = require('../services/points');
const { isPointsEnabled } = require('../services/platformSettings');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^image\/(jpeg|jpg|png|gif|webp)$/.test(file.mimetype)),
});

const router = express.Router();

// Ensure bs_reactions table exists (one reaction per user per topic)
db.query(`
  CREATE TABLE IF NOT EXISTS bs_reactions (
    topic_id   INTEGER NOT NULL REFERENCES bs_topics(id) ON DELETE CASCADE,
    user_id    UUID    NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
    reaction   VARCHAR(10) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (topic_id, user_id)
  )
`).catch(err => console.error('[social] bs_reactions init:', err.message));

db.query('ALTER TABLE bs_topics ADD COLUMN IF NOT EXISTS image_url TEXT')
  .catch(err => console.error('[social] image_url column:', err.message));

db.query(`
  CREATE TABLE IF NOT EXISTS bs_video_watches (
    video_id   INTEGER NOT NULL REFERENCES bs_videos(id) ON DELETE CASCADE,
    user_id    UUID    NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
    watched_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (video_id, user_id)
  )
`).catch(err => console.error('[social] bs_video_watches init:', err.message));

db.query(`ALTER TABLE bs_videos ADD COLUMN IF NOT EXISTS duration_tier VARCHAR(10) DEFAULT '15'`)
  .catch(err => console.error('[social] duration_tier column:', err.message));

db.query(`ALTER TABLE bs_videos ADD COLUMN IF NOT EXISTS likes INTEGER DEFAULT 0`)
  .catch(err => console.error('[social] bs_videos likes:', err.message));
db.query(`ALTER TABLE bs_videos ADD COLUMN IF NOT EXISTS comment_count INTEGER DEFAULT 0`)
  .catch(err => console.error('[social] bs_videos comment_count:', err.message));
db.query(`ALTER TABLE bs_videos ADD COLUMN IF NOT EXISTS view_count INTEGER DEFAULT 0`)
  .catch(err => console.error('[social] bs_videos view_count:', err.message));

db.query(`
  CREATE TABLE IF NOT EXISTS bs_video_likes (
    video_id   INTEGER NOT NULL REFERENCES bs_videos(id) ON DELETE CASCADE,
    user_id    UUID    NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (video_id, user_id)
  )
`).catch(err => console.error('[social] bs_video_likes init:', err.message));

db.query(`
  CREATE TABLE IF NOT EXISTS bs_video_comments (
    id         SERIAL PRIMARY KEY,
    video_id   INTEGER NOT NULL REFERENCES bs_videos(id) ON DELETE CASCADE,
    user_id    UUID    NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
    content    TEXT    NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(err => console.error('[social] bs_video_comments init:', err.message));

db.query(`
  CREATE TABLE IF NOT EXISTS bs_follows (
    id          SERIAL PRIMARY KEY,
    follower_id UUID REFERENCES users(id)    ON DELETE CASCADE,
    listing_id  UUID REFERENCES listings(id) ON DELETE CASCADE,
    created_at  TIMESTAMP DEFAULT NOW(),
    UNIQUE(follower_id, listing_id)
  )
`).catch(err => console.error('[social] bs_follows init:', err.message));

// Attach req.user if a valid token is present — never blocks the request
function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      req.user = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    } catch {}
  }
  next();
}

function isProvider(req) {
  return req.user?.role === 'provider' || req.user?.role === 'admin';
}

// GET /api/social/categories
router.get('/categories', optionalAuth, async (req, res, next) => {
  try {
    const result = await db.query(
      isProvider(req)
        ? 'SELECT * FROM bs_categories ORDER BY id ASC'
        : 'SELECT * FROM bs_categories WHERE provider_only = false ORDER BY id ASC'
    );
    res.json({ categories: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/social/topics/thread/:id — must be registered before /:categorySlug
router.get('/topics/thread/:id', optionalAuth, async (req, res, next) => {
  try {
    const topic = await db.query(
      `SELECT t.*, u.full_name AS author_name, u.is_verified AS author_verified, c.provider_only,
              (SELECT id FROM listings WHERE user_id = t.user_id AND is_active = true LIMIT 1) AS author_listing_id
       FROM bs_topics t
       JOIN users         u ON u.id = t.user_id
       JOIN bs_categories c ON c.id = t.category_id
       WHERE t.id = $1`,
      [req.params.id]
    );
    if (!topic.rows.length) return res.status(404).json({ error: 'Topic not found' });

    const t = topic.rows[0];
    if (t.provider_only && !isProvider(req)) {
      return res.status(403).json({ error: 'This section is for providers only' });
    }

    await db.query('UPDATE bs_topics SET views = views + 1 WHERE id = $1', [req.params.id]);

    const replies = await db.query(
      `SELECT r.*, u.full_name AS author_name
       FROM bs_replies r
       JOIN users u ON u.id = r.user_id
       WHERE r.topic_id = $1
       ORDER BY r.created_at ASC`,
      [req.params.id]
    );

    const reactionCounts = await db.query(
      `SELECT reaction, COUNT(*)::int AS count FROM bs_reactions WHERE topic_id = $1 GROUP BY reaction`,
      [req.params.id]
    );
    const reaction_counts = { like: 0, heart: 0, fire: 0 };
    for (const row of reactionCounts.rows) reaction_counts[row.reaction] = row.count;

    const userId = req.user?.id || null;
    let user_reaction = null;
    if (userId) {
      const userReact = await db.query(
        'SELECT reaction FROM bs_reactions WHERE topic_id = $1 AND user_id = $2',
        [req.params.id, userId]
      );
      user_reaction = userReact.rows[0]?.reaction || null;
    }

    res.json({ topic: { ...t, views: t.views + 1, reaction_counts, user_reaction }, replies: replies.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/social/topics — recent posts across all categories (home feed, deals filter)
router.get('/topics', optionalAuth, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 5, 50);
    const categorySlug = req.query.category || null;
    const listingId = req.query.listing_id || null;
    const trending = req.query.sort === 'trending';
    const userId = req.user?.id || '00000000-0000-0000-0000-000000000000';

    const params = [userId, limit];
    let filterClause = '';
    
    if (categorySlug) {
      const cat = await db.query('SELECT id FROM bs_categories WHERE slug = $1', [categorySlug]);
      if (!cat.rows.length) return res.json({ topics: [] });
      filterClause += ` AND t.category_id = $${params.length + 1}`;
      params.push(cat.rows[0].id);
    }

    if (listingId) {
      filterClause += ` AND t.user_id = (SELECT user_id FROM listings WHERE id = $${params.length + 1})`;
      params.push(listingId);
    }

    const result = await db.query(
      `SELECT t.*,
              u.full_name AS author_name,
              u.is_verified AS author_verified,
              COUNT(DISTINCT r.id)::int AS reply_count,
              COALESCE((SELECT COUNT(*)::int FROM bs_reactions br WHERE br.topic_id = t.id AND br.reaction = 'like'),0) AS like_count,
              COALESCE((SELECT COUNT(*)::int FROM bs_reactions br WHERE br.topic_id = t.id AND br.reaction = 'heart'),0) AS heart_count,
              COALESCE((SELECT COUNT(*)::int FROM bs_reactions br WHERE br.topic_id = t.id AND br.reaction = 'fire'),0) AS fire_count,
              (SELECT reaction FROM bs_reactions br WHERE br.topic_id = t.id AND br.user_id = $1) AS user_reaction,
              (SELECT id FROM listings WHERE user_id = t.user_id AND is_active = true LIMIT 1) AS author_listing_id,
              COALESCE((SELECT COUNT(*)::int FROM bs_reactions br WHERE br.topic_id = t.id AND br.created_at > NOW() - INTERVAL '48 hours'),0) +
              COALESCE((SELECT COUNT(*)::int FROM bs_reactions br WHERE br.topic_id = t.id AND br.created_at > NOW() - INTERVAL '48 hours'),0) * 0.5 + 
              COALESCE((SELECT COUNT(*)::int FROM bs_replies rr WHERE rr.topic_id = t.id AND rr.created_at > NOW() - INTERVAL '48 hours'),0) * 2 AS trend_score
       FROM bs_topics t
       JOIN users u ON u.id = t.user_id
       LEFT JOIN bs_replies r ON r.topic_id = t.id
       WHERE 1=1 ${filterClause}
       GROUP BY t.id, u.full_name, u.is_verified
       ORDER BY ${trending ? 'trend_score DESC,' : ''} t.created_at DESC
       LIMIT $2`,
      params
    );

    res.json({ topics: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/social/topics/:categorySlug
router.get('/topics/:categorySlug', optionalAuth, async (req, res, next) => {
  try {
    const cat = await db.query(
      'SELECT * FROM bs_categories WHERE slug = $1',
      [req.params.categorySlug]
    );
    if (!cat.rows.length) return res.status(404).json({ error: 'Category not found' });

    const category = cat.rows[0];
    if (category.provider_only && !isProvider(req)) {
      return res.status(403).json({ error: 'This section is for providers only' });
    }

    const trending = req.query.sort === 'trending';
    const userId = req.user?.id || '00000000-0000-0000-0000-000000000000';

    const result = await db.query(
      `SELECT t.*,
              u.full_name AS author_name,
              u.is_verified AS author_verified,
              COUNT(DISTINCT r.id)::int AS reply_count,
              COALESCE((SELECT COUNT(*)::int FROM bs_reactions br WHERE br.topic_id = t.id AND br.reaction = 'like'),0) AS like_count,
              COALESCE((SELECT COUNT(*)::int FROM bs_reactions br WHERE br.topic_id = t.id AND br.reaction = 'heart'),0) AS heart_count,
              COALESCE((SELECT COUNT(*)::int FROM bs_reactions br WHERE br.topic_id = t.id AND br.reaction = 'fire'),0) AS fire_count,
              (SELECT reaction FROM bs_reactions br WHERE br.topic_id = t.id AND br.user_id = $2) AS user_reaction,
              (SELECT id FROM listings WHERE user_id = t.user_id AND is_active = true LIMIT 1) AS author_listing_id,
              COALESCE((SELECT COUNT(*)::int FROM bs_reactions br WHERE br.topic_id = t.id AND br.created_at > NOW() - INTERVAL '48 hours'),0) +
              COALESCE((SELECT COUNT(*)::int FROM bs_replies rr WHERE rr.topic_id = t.id AND rr.created_at > NOW() - INTERVAL '48 hours'),0) * 2 AS trend_score
       FROM bs_topics t
       JOIN users u ON u.id = t.user_id
       LEFT JOIN bs_replies r ON r.topic_id = t.id
       WHERE t.category_id = $1
       GROUP BY t.id, u.full_name, u.is_verified
       ORDER BY ${trending ? 'trend_score DESC,' : ''} t.created_at DESC`,
      [category.id, userId]
    );

    res.json({ category, topics: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/social/topics
router.post('/topics', requireAuth, async (req, res, next) => {
  try {
    const { category_id, title, body } = req.body;
    if (!category_id) return res.status(400).json({ error: 'category_id is required' });
    if (!title?.trim()) return res.status(400).json({ error: 'title is required' });

    const cat = await db.query('SELECT * FROM bs_categories WHERE id = $1', [category_id]);
    if (!cat.rows.length) return res.status(404).json({ error: 'Category not found' });

    if (cat.rows[0].provider_only && !isProvider(req)) {
      return res.status(403).json({ error: 'This section is for providers only' });
    }

    const result = await db.query(
      `INSERT INTO bs_topics (category_id, user_id, title, body, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '90 days') RETURNING *`,
      [category_id, req.user.id, title.trim(), body?.trim() || null]
    );

    res.status(201).json({ topic: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/social/topics/:id/reply
router.post('/topics/:id/reply', requireAuth, async (req, res, next) => {
  try {
    const { body } = req.body;
    if (!body?.trim()) return res.status(400).json({ error: 'body is required' });
    if (body.trim().length < 10) return res.status(400).json({ error: 'Reply must be at least 10 characters' });

    const topic = await db.query(
      `SELECT t.*, c.provider_only FROM bs_topics t
       JOIN bs_categories c ON c.id = t.category_id
       WHERE t.id = $1`,
      [req.params.id]
    );
    if (!topic.rows.length) return res.status(404).json({ error: 'Topic not found' });

    const t = topic.rows[0];
    if (t.provider_only && !isProvider(req)) {
      return res.status(403).json({ error: 'This section is for providers only' });
    }

    const result = await db.query(
      `INSERT INTO bs_replies (topic_id, user_id, body, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '90 days') RETURNING *`,
      [req.params.id, req.user.id, body.trim()]
    );

    if (t.user_id && t.user_id !== req.user.id) {
      notify(
        t.user_id,
        'social_reply',
        'New reply on Bridge Social',
        `Someone replied to your topic: "${t.title}"`,
        { topic_id: t.id }
      );
    }

    if (await isPointsEnabled()) {
      const alreadyAwarded = await db.query(
        `SELECT id FROM bridge_points_log WHERE user_id = $1 AND event_type = 'social_comment' AND reference_id = $2`,
        [req.user.id, String(req.params.id)]
      );
      if (!alreadyAwarded.rows.length) {
        const ccRow = await db.query('SELECT country_code FROM users WHERE id = $1', [req.user.id]);
        await awardPoints(req.user.id, ccRow.rows[0]?.country_code || 'VC', 'social_comment', 4, String(req.params.id));
      }
    }

    res.status(201).json({ reply: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/social/topics/:id/vote
router.post('/topics/:id/vote', requireAuth, async (req, res, next) => {
  try {
    const value = parseInt(req.body.value);
    if (value !== 1 && value !== -1) {
      return res.status(400).json({ error: 'value must be 1 or -1' });
    }

    const topic = await db.query('SELECT id FROM bs_topics WHERE id = $1', [req.params.id]);
    if (!topic.rows.length) return res.status(404).json({ error: 'Topic not found' });

    const result = await db.query(
      `INSERT INTO bs_votes (topic_id, user_id, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (topic_id, user_id) DO UPDATE SET value = EXCLUDED.value
       RETURNING *`,
      [req.params.id, req.user.id, value]
    );

    const totals = await db.query(
      'SELECT COALESCE(SUM(value), 0)::int AS score FROM bs_votes WHERE topic_id = $1',
      [req.params.id]
    );

    res.json({ vote: result.rows[0], score: totals.rows[0].score });
  } catch (err) {
    next(err);
  }
});

// POST /api/social/topics/:id/react
router.post('/topics/:id/react', requireAuth, async (req, res, next) => {
  try {
    const { reaction } = req.body;
    if (!['like', 'heart', 'fire'].includes(reaction)) {
      return res.status(400).json({ error: 'reaction must be like, heart, or fire' });
    }
    const topicId = req.params.id;
    const userId = req.user.id;

    const existing = await db.query(
      'SELECT reaction FROM bs_reactions WHERE topic_id = $1 AND user_id = $2',
      [topicId, userId]
    );

    if (existing.rows.length && existing.rows[0].reaction === reaction) {
      await db.query(
        'DELETE FROM bs_reactions WHERE topic_id = $1 AND user_id = $2',
        [topicId, userId]
      );
    } else {
      await db.query(
        `INSERT INTO bs_reactions (topic_id, user_id, reaction)
         VALUES ($1, $2, $3)
         ON CONFLICT (topic_id, user_id) DO UPDATE SET reaction = EXCLUDED.reaction`,
        [topicId, userId, reaction]
      );

      if (existing.rows.length === 0 && await isPointsEnabled()) {
        const alreadyAwarded = await db.query(
          `SELECT id FROM bridge_points_log WHERE user_id = $1 AND event_type = 'social_reaction' AND reference_id = $2`,
          [userId, String(topicId)]
        );
        if (!alreadyAwarded.rows.length) {
          const ccRow = await db.query('SELECT country_code FROM users WHERE id = $1', [userId]);
          await awardPoints(userId, ccRow.rows[0]?.country_code || 'VC', 'social_reaction', 2, String(topicId));
        }
      }
    }

    const counts = await db.query(
      `SELECT reaction, COUNT(*)::int AS count FROM bs_reactions WHERE topic_id = $1 GROUP BY reaction`,
      [topicId]
    );
    const reaction_counts = { like: 0, heart: 0, fire: 0 };
    for (const row of counts.rows) reaction_counts[row.reaction] = row.count;

    const cur = await db.query(
      'SELECT reaction FROM bs_reactions WHERE topic_id = $1 AND user_id = $2',
      [topicId, userId]
    );

    res.json({ reaction_counts, user_reaction: cur.rows[0]?.reaction || null });
  } catch (err) {
    next(err);
  }
});

// POST /api/social/topics/:id/image — upload post image to R2
router.post('/topics/:id/image', requireAuth, upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    const topic = await db.query('SELECT id, user_id FROM bs_topics WHERE id = $1', [req.params.id]);
    if (!topic.rows.length) return res.status(404).json({ error: 'Topic not found' });
    if (topic.rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const ext = path.extname(req.file.originalname).toLowerCase() || '.jpg';
    const { url } = await uploadBuffer(req.file.buffer, 'social-images', ext, req.file.mimetype);
    await db.query('UPDATE bs_topics SET image_url = $1 WHERE id = $2', [url, req.params.id]);
    res.json({ image_url: url });
  } catch (err) {
    next(err);
  }
});

// POST /api/social/follow/:listing_id — toggle follow/unfollow a business
router.post('/follow/:listing_id', requireAuth, async (req, res, next) => {
  try {
    const listing = await db.query('SELECT id FROM listings WHERE id = $1 AND is_active = true', [req.params.listing_id]);
    if (!listing.rows.length) return res.status(404).json({ error: 'Listing not found' });

    const existing = await db.query(
      'SELECT id FROM bs_follows WHERE follower_id = $1 AND listing_id = $2',
      [req.user.id, req.params.listing_id]
    );
    if (existing.rows.length) {
      await db.query('DELETE FROM bs_follows WHERE follower_id = $1 AND listing_id = $2', [req.user.id, req.params.listing_id]);
      res.json({ following: false });
    } else {
      await db.query('INSERT INTO bs_follows (follower_id, listing_id) VALUES ($1, $2)', [req.user.id, req.params.listing_id]);
      res.json({ following: true });
    }
  } catch (err) {
    next(err);
  }
});

// GET /api/social/following — listing_ids the current user follows
router.get('/following', requireAuth, async (req, res, next) => {
  try {
    const result = await db.query(
      'SELECT listing_id FROM bs_follows WHERE follower_id = $1',
      [req.user.id]
    );
    res.json({ listing_ids: result.rows.map((r) => r.listing_id) });
  } catch (err) {
    next(err);
  }
});

// GET /api/social/videos — all approved videos
router.get('/videos', optionalAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id || null;
    const params = [];
    let likedExpr = 'false AS user_has_liked';
    if (userId) {
      params.push(userId);
      likedExpr = `EXISTS(SELECT 1 FROM bs_video_likes vl WHERE vl.video_id = v.id AND vl.user_id = $${params.length}) AS user_has_liked`;
    }
    const result = await db.query(
      `SELECT v.*, u.full_name AS author_name, ${likedExpr}
       FROM bs_videos v
       JOIN users u ON u.id = v.user_id
       WHERE v.status = 'approved'
       ORDER BY v.created_at DESC`,
      params
    );
    res.json({ videos: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/social/videos/submit — authenticated, submit video for review
router.post('/videos/submit', requireAuth, async (req, res, next) => {
  try {
    const { title, description, youtube_url, duration_tier } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'title is required' });
    if (!youtube_url?.trim()) return res.status(400).json({ error: 'youtube_url is required' });
    if (!['15', '30', '60'].includes(String(duration_tier))) {
      return res.status(400).json({ error: 'duration_tier must be 15, 30, or 60' });
    }

    const isAdmin = req.user.role === 'admin';
    const status = isAdmin ? 'approved' : 'pending';

    const result = await db.query(
      `INSERT INTO bs_videos (user_id, title, description, youtube_url, status, duration_tier)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.user.id, title.trim(), description?.trim() || null, youtube_url.trim(), status, String(duration_tier)]
    );

    if (!isAdmin) {
      const admins = await db.query(`SELECT id FROM users WHERE role = 'admin'`);
      admins.rows.forEach(({ id }) => {
        notify(
          id,
          'video_pending',
          'New Video Submission',
          `A new video "${title.trim()}" is pending approval`,
          { video_id: result.rows[0].id }
        );
      });
    }

    res.status(201).json({ video: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/social/videos/:id/approve — admin only
router.patch('/videos/:id/approve', ...requireRole('admin'), async (req, res, next) => {
  try {
    const result = await db.query(
      `UPDATE bs_videos SET status = 'approved' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Video not found' });
    res.json({ video: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/social/videos/:id/watch — first-watch tracking + 2 Bridge Points
router.post('/videos/:id/watch', requireAuth, async (req, res, next) => {
  try {
    const videoId = parseInt(req.params.id, 10);
    if (isNaN(videoId)) return res.status(400).json({ error: 'Invalid video ID' });
    const userId = req.user.id;

    const result = await db.query(
      `INSERT INTO bs_video_watches (video_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [videoId, userId]
    );

    if (result.rowCount > 0) {
      await db.query('UPDATE bs_videos SET view_count = view_count + 1 WHERE id = $1', [videoId]);
      if (await isPointsEnabled()) {
        const ccRow = await db.query('SELECT country_code FROM users WHERE id = $1', [userId]);
        await awardPoints(userId, ccRow.rows[0]?.country_code || 'VC', 'social_video_watch', 2, String(videoId));
      }
    }

    res.json({ watched: result.rowCount > 0 });
  } catch (err) {
    next(err);
  }
});

// POST /api/social/videos/:id/like — toggle like, award 2 pts first time
router.post('/videos/:id/like', requireAuth, async (req, res, next) => {
  try {
    const videoId = parseInt(req.params.id, 10);
    if (isNaN(videoId)) return res.status(400).json({ error: 'Invalid video ID' });
    const userId = req.user.id;

    const existing = await db.query(
      'SELECT 1 FROM bs_video_likes WHERE video_id = $1 AND user_id = $2',
      [videoId, userId]
    );

    let liked;
    if (existing.rows.length) {
      await db.query('DELETE FROM bs_video_likes WHERE video_id = $1 AND user_id = $2', [videoId, userId]);
      await db.query('UPDATE bs_videos SET likes = GREATEST(0, likes - 1) WHERE id = $1', [videoId]);
      liked = false;
    } else {
      await db.query('INSERT INTO bs_video_likes (video_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [videoId, userId]);
      await db.query('UPDATE bs_videos SET likes = likes + 1 WHERE id = $1', [videoId]);
      liked = true;
      if (await isPointsEnabled()) {
        const alreadyAwarded = await db.query(
          `SELECT id FROM bridge_points_log WHERE user_id = $1 AND event_type = 'video_like' AND reference_id = $2`,
          [userId, String(videoId)]
        );
        if (!alreadyAwarded.rows.length) {
          const ccRow = await db.query('SELECT country_code FROM users WHERE id = $1', [userId]);
          await awardPoints(userId, ccRow.rows[0]?.country_code || 'VC', 'video_like', 2, String(videoId));
        }
      }
    }

    const r = await db.query('SELECT likes FROM bs_videos WHERE id = $1', [videoId]);
    res.json({ liked, likes: r.rows[0]?.likes || 0 });
  } catch (err) { next(err); }
});

// POST /api/social/videos/:id/comment — min 10 chars, 4 pts once per user per video
router.post('/videos/:id/comment', requireAuth, async (req, res, next) => {
  try {
    const videoId = parseInt(req.params.id, 10);
    if (isNaN(videoId)) return res.status(400).json({ error: 'Invalid video ID' });
    const userId = req.user.id;
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'content is required' });
    if (content.trim().length < 10) return res.status(400).json({ error: 'Comment must be at least 10 characters' });

    const insert = await db.query(
      `INSERT INTO bs_video_comments (video_id, user_id, content) VALUES ($1, $2, $3) RETURNING *`,
      [videoId, userId, content.trim()]
    );
    await db.query('UPDATE bs_videos SET comment_count = comment_count + 1 WHERE id = $1', [videoId]);

    if (await isPointsEnabled()) {
      const alreadyAwarded = await db.query(
        `SELECT id FROM bridge_points_log WHERE user_id = $1 AND event_type = 'video_comment' AND reference_id = $2`,
        [userId, String(videoId)]
      );
      if (!alreadyAwarded.rows.length) {
        const ccRow = await db.query('SELECT country_code FROM users WHERE id = $1', [userId]);
        await awardPoints(userId, ccRow.rows[0]?.country_code || 'VC', 'video_comment', 4, String(videoId));
      }
    }

    const author = await db.query('SELECT full_name FROM users WHERE id = $1', [userId]);
    res.status(201).json({ comment: { ...insert.rows[0], author_name: author.rows[0]?.full_name } });
  } catch (err) { next(err); }
});

// GET /api/social/videos/comments/all — admin: list all comments newest first
router.get('/videos/comments/all', ...requireRole('admin'), async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT c.id, c.video_id, c.content, c.created_at,
              u.full_name AS author_name,
              v.title AS video_title
       FROM bs_video_comments c
       JOIN users u ON u.id = c.user_id
       JOIN bs_videos v ON v.id = c.video_id
       ORDER BY c.created_at DESC
       LIMIT 200`
    );
    res.json({ comments: result.rows });
  } catch (err) { next(err); }
});

// GET /api/social/videos/:id/comments
router.get('/videos/:id/comments', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT c.*, u.full_name AS author_name
       FROM bs_video_comments c
       JOIN users u ON u.id = c.user_id
       WHERE c.video_id = $1
       ORDER BY c.created_at ASC`,
      [parseInt(req.params.id)]
    );
    res.json({ comments: result.rows });
  } catch (err) { next(err); }
});

// DELETE /api/social/videos/:videoId/comments/:commentId — admin only
router.delete('/videos/:videoId/comments/:commentId', ...requireRole('admin'), async (req, res, next) => {
  try {
    const videoId = parseInt(req.params.videoId, 10);
    const commentId = parseInt(req.params.commentId, 10);
    if (isNaN(videoId) || isNaN(commentId)) return res.status(400).json({ error: 'Invalid ID' });
    const del = await db.query(
      'DELETE FROM bs_video_comments WHERE id = $1 AND video_id = $2 RETURNING id',
      [commentId, videoId]
    );
    if (!del.rows.length) return res.status(404).json({ error: 'Comment not found' });
    await db.query(
      'UPDATE bs_videos SET comment_count = GREATEST(0, comment_count - 1) WHERE id = $1',
      [videoId]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Bridge Gallery ────────────────────────────────────────────────────────────

db.query(`
  CREATE TABLE IF NOT EXISTS bs_photos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    listing_id UUID REFERENCES listings(id) ON DELETE SET NULL,
    media_url TEXT NOT NULL,
    thumbnail_url TEXT,
    caption TEXT,
    media_type VARCHAR(10) DEFAULT 'image',
    likes INTEGER DEFAULT 0,
    comments INTEGER DEFAULT 0,
    country_code VARCHAR(10) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )
`).catch(err => console.error('[social] bs_photos init:', err.message));

db.query('ALTER TABLE bs_photos ADD COLUMN IF NOT EXISTS comments INTEGER DEFAULT 0')
  .catch(err => console.error('[social] bs_photos comments col:', err.message));

db.query(`
  CREATE TABLE IF NOT EXISTS bs_photo_likes (
    user_id  UUID REFERENCES users(id)      ON DELETE CASCADE,
    photo_id UUID REFERENCES bs_photos(id)  ON DELETE CASCADE,
    PRIMARY KEY (user_id, photo_id)
  )
`).catch(err => console.error('[social] bs_photo_likes init:', err.message));

db.query(`
  CREATE TABLE IF NOT EXISTS bs_reports (
    id           SERIAL PRIMARY KEY,
    reporter_id  UUID REFERENCES users(id) ON DELETE SET NULL,
    content_type VARCHAR(20) NOT NULL,
    content_id   TEXT NOT NULL,
    reason       VARCHAR(50) NOT NULL,
    created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )
`).catch(err => console.error('[social] bs_reports init:', err.message));

const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^(image\/(jpeg|jpg|png|gif|webp)|video\/webm)$/.test(file.mimetype)),
});

// POST /api/social/photos
router.post('/photos', requireAuth, photoUpload.single('media'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { caption, listing_id } = req.body;
    // Fix: Force enforcement of normalized country codes into database inserts
    const country_code = req.countryCode || 'SVG';
    const media_type = req.file.mimetype.startsWith('video/') ? 'video' : 'image';
    const ext = path.extname(req.file.originalname).toLowerCase() || (media_type === 'video' ? '.webm' : '.jpg');

    const { url } = await uploadBuffer(req.file.buffer, 'social-photos', ext, req.file.mimetype);

    let resolvedListingId = listing_id || null;
    if (!resolvedListingId) {
      const lr = await db.query('SELECT id FROM listings WHERE user_id = $1 AND is_active = true LIMIT 1', [req.user.id]);
      resolvedListingId = lr.rows[0]?.id || null;
    }

    const result = await db.query(
      `INSERT INTO bs_photos (user_id, listing_id, media_url, thumbnail_url, caption, media_type, country_code)
       VALUES ($1, $2, $3, $3, $4, $5, $6) RETURNING *`,
      [req.user.id, resolvedListingId, url, caption?.trim() || null, media_type, country_code]
    );

    res.status(201).json({ photo: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/social/photos
router.get('/photos', optionalAuth, async (req, res, next) => {
  try {
    const filter = req.query.filter || 'all';
    const country_code = req.countryCode || null;
    const userId = req.user?.id || null;

    let timeClause = '';
    if (filter === 'today') timeClause = `AND p.created_at > NOW() - INTERVAL '24 hours'`;
    else if (filter === 'week') timeClause = `AND p.created_at > NOW() - INTERVAL '7 days'`;

    const params = [];
    let countryClause = '';
    if (country_code) {
      params.push(country_code);
      countryClause = `AND p.country_code = $${params.length}`;
    }

    let likedExpr = 'false AS user_has_liked';
    if (userId) {
      params.push(userId);
      likedExpr = `EXISTS(SELECT 1 FROM bs_photo_likes pl WHERE pl.photo_id = p.id AND pl.user_id = $${params.length}) AS user_has_liked`;
    }

    const result = await db.query(
      `SELECT p.*, u.full_name AS author_name, l.business_name AS listing_name, ${likedExpr}
       FROM bs_photos p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN listings l ON l.id = p.listing_id
       WHERE 1=1 ${timeClause} ${countryClause}
       ORDER BY (p.likes + p.comments) DESC, p.created_at DESC
       LIMIT 100`,
      params
    );

    res.json({ photos: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/social/photos/:id/like — toggle
router.post('/photos/:id/like', requireAuth, async (req, res, next) => {
  try {
    const photoId = req.params.id;
    const userId = req.user.id;

    const existing = await db.query(
      'SELECT 1 FROM bs_photo_likes WHERE user_id = $1 AND photo_id = $2',
      [userId, photoId]
    );

    let liked;
    if (existing.rows.length) {
      await db.query('DELETE FROM bs_photo_likes WHERE user_id = $1 AND photo_id = $2', [userId, photoId]);
      await db.query('UPDATE bs_photos SET likes = GREATEST(0, likes - 1) WHERE id = $1', [photoId]);
      liked = false;
    } else {
      await db.query('INSERT INTO bs_photo_likes (user_id, photo_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, photoId]);
      await db.query('UPDATE bs_photos SET likes = likes + 1 WHERE id = $1', [photoId]);
      liked = true;
    }

    const result = await db.query('SELECT likes FROM bs_photos WHERE id = $1', [photoId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Photo not found' });
    res.json({ liked, likes: result.rows[0].likes });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/social/photos/:id — owner or admin
router.delete('/photos/:id', requireAuth, async (req, res, next) => {
  try {
    const { id: userId, account_type } = req.user;
    const row = await db.query('SELECT user_id, media_url FROM bs_photos WHERE id = $1', [req.params.id]);
    if (!row.rows.length) return res.status(404).json({ error: 'Photo not found' });
    const photo = row.rows[0];
    if (photo.user_id !== userId && account_type !== 'admin') return res.status(403).json({ error: 'Not authorized' });
    try { await deleteObject(photo.media_url); } catch {}
    await db.query('DELETE FROM bs_photos WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// PATCH /api/social/photos/:id — owner only, edit caption
router.patch('/photos/:id', requireAuth, async (req, res, next) => {
  try {
    const row = await db.query('SELECT user_id FROM bs_photos WHERE id = $1', [req.params.id]);
    if (!row.rows.length) return res.status(404).json({ error: 'Photo not found' });
    if (row.rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
    const caption = req.body.caption?.trim() || null;
    const updated = await db.query('UPDATE bs_photos SET caption = $1 WHERE id = $2 RETURNING caption', [caption, req.params.id]);
    res.json({ caption: updated.rows[0].caption });
  } catch (err) { next(err); }
});

// DELETE /api/social/topics/:id — owner or admin
router.delete('/topics/:id', requireAuth, async (req, res, next) => {
  try {
    const { id: userId, account_type } = req.user;
    const topicId = parseInt(req.params.id);
    const row = await db.query('SELECT user_id FROM bs_topics WHERE id = $1', [topicId]);
    if (!row.rows.length) return res.status(404).json({ error: 'Topic not found' });
    if (row.rows[0].user_id !== userId && account_type !== 'admin') return res.status(403).json({ error: 'Not authorized' });
    await db.query('DELETE FROM bs_topics WHERE id = $1', [topicId]);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/social/report
router.post('/report', requireAuth, async (req, res, next) => {
  try {
    const { content_type, content_id, reason } = req.body;
    if (!content_type || !content_id || !reason) return res.status(400).json({ error: 'Missing fields' });
    if (!['photo', 'topic'].includes(content_type)) return res.status(400).json({ error: 'Invalid content_type' });
    await db.query(
      'INSERT INTO bs_reports (reporter_id, content_type, content_id, reason) VALUES ($1, $2, $3, $4)',
      [req.user.id, content_type, content_id, reason]
    );
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /api/social/reports — admin only
router.get('/reports', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT r.*, u.full_name AS reporter_name
       FROM bs_reports r
       LEFT JOIN users u ON u.id = r.reporter_id
       ORDER BY r.created_at DESC
       LIMIT 500`
    );
    res.json({ reports: result.rows });
  } catch (err) { next(err); }
});

module.exports = router;
