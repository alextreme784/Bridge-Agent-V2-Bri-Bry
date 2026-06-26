'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const { fetchFeed, refreshFeed } = require('../services/rssService');

/* ════════════════════════════════════════
   PUBLIC
════════════════════════════════════════ */

/* GET /api/news/articles?category=&country_code=&limit=20&offset=0 */
router.get('/articles', async (req, res) => {
  try {
    const limit     = Math.min(parseInt(req.query.limit)  || 60, 100);
    const offset    = Math.max(parseInt(req.query.offset) || 0,  0);
    const category  = req.query.category;
    const country   = (req.query.country_code || '').toUpperCase();

    const conditions = ['f.is_active = true'];
    const params     = [];

    if (category) {
      params.push(category.toLowerCase());
      conditions.push(`f.category = $${params.length}`);
    }
    if (country) {
      params.push(country);
      conditions.push(`(f.country_code = $${params.length} OR f.country_code = 'ALL')`);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    params.push(limit, offset);

    const { rows } = await db.query(
      `SELECT
         a.id, a.title, a.url, a.excerpt, a.image_url, a.published_at, a.fetched_at,
         f.name  AS feed_name,
         f.category,
         f.country_code
       FROM rss_articles a
       JOIN rss_feeds f ON f.id = a.feed_id
       ${where}
       ORDER BY a.published_at DESC NULLS LAST
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json(rows);
  } catch (err) {
    console.error('[news] GET /articles error:', err);
    res.status(500).json({ error: 'Failed to fetch articles' });
  }
});

/* ════════════════════════════════════════
   ADMIN — requireRole('admin','moderator')
════════════════════════════════════════ */

/* GET /api/news/feeds */
router.get('/feeds', requireRole('admin', 'moderator'), async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT f.*,
         COUNT(a.id)::int AS article_count
       FROM rss_feeds f
       LEFT JOIN rss_articles a ON a.feed_id = f.id
       GROUP BY f.id
       ORDER BY f.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch feeds' });
  }
});

/* POST /api/news/feeds — add a new feed */
router.post('/feeds', requireRole('admin', 'moderator'), async (req, res) => {
  const { name, url, category = 'caribbean', country_code = 'ALL' } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'name and url are required' });

  try {
    new URL(url); /* basic URL validation */
  } catch {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  /* Validate it's actually an RSS feed before saving */
  let preview = [];
  try {
    preview = await fetchFeed(url);
    if (!preview.length) return res.status(400).json({ error: 'Feed returned no articles — check the URL' });
  } catch (e) {
    return res.status(400).json({ error: `Could not fetch feed: ${e.message}` });
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO rss_feeds (name, url, category, country_code, added_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name.trim(), url.trim(), category.toLowerCase(), country_code.toUpperCase(), req.user.id]
    );
    const feed = rows[0];

    /* Immediately populate articles from the new feed */
    const inserted = await refreshFeed(feed);

    res.json({ success: true, feed, articles_fetched: inserted, preview: preview.slice(0, 3) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A feed with this URL already exists' });
    throw err;
  }
});

/* PUT /api/news/feeds/:id — update name, category, country_code, is_active */
router.put('/feeds/:id', requireRole('admin', 'moderator'), async (req, res) => {
  const { name, category, country_code, is_active } = req.body;
  try {
    const sets   = [];
    const params = [];

    if (name        !== undefined) { params.push(name.trim());              sets.push(`name = $${params.length}`); }
    if (category    !== undefined) { params.push(category.toLowerCase());   sets.push(`category = $${params.length}`); }
    if (country_code!== undefined) { params.push(country_code.toUpperCase()); sets.push(`country_code = $${params.length}`); }
    if (is_active   !== undefined) { params.push(Boolean(is_active));       sets.push(`is_active = $${params.length}`); }

    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(parseInt(req.params.id));
    const { rows } = await db.query(
      `UPDATE rss_feeds SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Feed not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Update failed' });
  }
});

/* DELETE /api/news/feeds/:id — soft-delete by setting is_active = false */
router.delete('/feeds/:id', requireRole('admin', 'moderator'), async (req, res) => {
  try {
    const { rows } = await db.query(
      'UPDATE rss_feeds SET is_active = false WHERE id = $1 RETURNING id',
      [parseInt(req.params.id)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Feed not found' });
    res.json({ success: true, id: rows[0].id });
  } catch (err) {
    res.status(500).json({ error: 'Delete failed' });
  }
});

/* POST /api/news/feeds/:id/refresh — manually trigger a fetch */
router.post('/feeds/:id/refresh', requireRole('admin', 'moderator'), async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM rss_feeds WHERE id = $1', [parseInt(req.params.id)]);
    if (!rows.length) return res.status(404).json({ error: 'Feed not found' });
    const inserted = await refreshFeed(rows[0]);
    res.json({ success: true, articles_fetched: inserted });
  } catch (err) {
    res.status(500).json({ error: `Refresh failed: ${err.message}` });
  }
});

module.exports = router;
