const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { requireRole } = require('../middleware/auth');

const adminOnly = requireRole('admin');

// GET /mini-apps/all  — admin, every row regardless of country/active state
router.get('/all', ...adminOnly, async (req, res, next) => {
  try {
    const result = await db.query(
      'SELECT * FROM mini_apps ORDER BY sort_order ASC, created_at ASC'
    );
    res.json({ mini_apps: result.rows });
  } catch (err) { next(err); }
});

// GET /mini-apps?country=SVG  — public, active rows for country OR 'ALL'
router.get('/', async (req, res, next) => {
  try {
    const country = (req.query.country || 'ALL').toUpperCase();
    const result  = await db.query(
      `SELECT id, name, icon, url, badge, country_code, sort_order
       FROM mini_apps
       WHERE is_active = true
         AND (country_code = 'ALL' OR country_code = $1)
       ORDER BY sort_order ASC, created_at ASC`,
      [country]
    );
    res.json({ mini_apps: result.rows });
  } catch (err) { next(err); }
});

// POST /mini-apps  — admin only
router.post('/', ...adminOnly, async (req, res, next) => {
  try {
    const {
      name, icon = '📱', url, badge = 'soon',
      country_code = 'ALL', sort_order = 0
    } = req.body;
    if (!name || !url) return res.status(400).json({ error: 'name and url are required' });

    const result = await db.query(
      `INSERT INTO mini_apps (name, icon, url, badge, country_code, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [name, icon, url, badge, country_code.toUpperCase(), sort_order]
    );
    res.status(201).json({ app: result.rows[0] });
  } catch (err) { next(err); }
});

// PATCH /mini-apps/:id  — admin only
router.patch('/:id', ...adminOnly, async (req, res, next) => {
  try {
    const allowed = ['name', 'icon', 'url', 'badge', 'country_code', 'sort_order', 'is_active'];
    const fields  = [];
    const vals    = [];
    let   i       = 1;
    for (const key of allowed) {
      if (key in req.body) { fields.push(`${key} = $${i++}`); vals.push(req.body[key]); }
    }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id);
    const result = await db.query(
      `UPDATE mini_apps SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      vals
    );
    if (!result.rows.length) return res.status(404).json({ error: 'App not found' });
    res.json({ app: result.rows[0] });
  } catch (err) { next(err); }
});

// DELETE /mini-apps/:id  — admin only
router.delete('/:id', ...adminOnly, async (req, res, next) => {
  try {
    const result = await db.query(
      'DELETE FROM mini_apps WHERE id = $1 RETURNING id', [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'App not found' });
    res.json({ deleted: result.rows[0].id });
  } catch (err) { next(err); }
});

module.exports = router;
