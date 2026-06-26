const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { requireRole } = require('../middleware/auth');

const adminOnly = requireRole('admin');

// GET /admin/apps?country=SVG
router.get('/', adminOnly, async (req, res, next) => {
  try {
    const country = (req.query.country || 'SVG').toUpperCase();
    const result  = await db.query(
      `SELECT * FROM mini_apps WHERE country_code = $1 ORDER BY slot, sort_order, created_at`,
      [country]
    );
    res.json({ apps: result.rows });
  } catch (err) { next(err); }
});

// POST /admin/apps
router.post('/', adminOnly, async (req, res, next) => {
  try {
    const {
      country_code, slot = 'grid', title, subtitle = null,
      url, icon_emoji = '🔗', color = '#009E60',
      badge_text = 'Live', badge_type = 'default', sort_order = 0
    } = req.body;

    if (!country_code || !title || !url) {
      return res.status(400).json({ error: 'country_code, title and url are required' });
    }

    const result = await db.query(
      `INSERT INTO mini_apps
         (country_code, slot, title, subtitle, url, icon_emoji, color, badge_text, badge_type, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [country_code.toUpperCase(), slot, title, subtitle, url,
       icon_emoji, color, badge_text, badge_type, sort_order]
    );
    res.status(201).json({ app: result.rows[0] });
  } catch (err) { next(err); }
});

// PATCH /admin/apps/:id
router.patch('/:id', adminOnly, async (req, res, next) => {
  try {
    const allowed = ['title','subtitle','url','icon_emoji','color',
                     'badge_text','badge_type','sort_order','is_active','slot'];
    const fields  = [];
    const vals    = [];
    let   i       = 1;

    for (const key of allowed) {
      if (key in req.body) {
        fields.push(`${key} = $${i++}`);
        vals.push(req.body[key]);
      }
    }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });

    fields.push(`updated_at = NOW()`);
    vals.push(req.params.id);

    const result = await db.query(
      `UPDATE mini_apps SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      vals
    );
    if (!result.rows.length) return res.status(404).json({ error: 'App not found' });
    res.json({ app: result.rows[0] });
  } catch (err) { next(err); }
});

// DELETE /admin/apps/:id
router.delete('/:id', adminOnly, async (req, res, next) => {
  try {
    const result = await db.query(
      'DELETE FROM mini_apps WHERE id = $1 RETURNING id', [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'App not found' });
    res.json({ deleted: result.rows[0].id });
  } catch (err) { next(err); }
});

module.exports = router;
