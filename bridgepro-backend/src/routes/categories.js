const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /categories — active categories for country with subcategory count
router.get('/', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT c.id, c.name, c.slug, c.icon, c.display_order,
              COUNT(s.id) FILTER (WHERE s.status = 'active' AND s.is_active = true) AS subcategory_count
       FROM categories c
       LEFT JOIN subcategories s ON s.category_id = c.id
       WHERE c.country_code = $1 AND c.is_active = true
       GROUP BY c.id
       ORDER BY c.display_order ASC`,
      [req.countryCode]
    );
    res.json({ categories: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /categories/all — full tree: categories with nested active subcategories
// MUST be defined before /:slug to prevent "all" being matched as a slug
router.get('/all', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT c.id, c.name, c.slug, c.icon, c.display_order,
              COALESCE(
                json_agg(
                  json_build_object('id', s.id, 'name', s.name, 'slug', s.slug, 'is_other', s.is_other)
                  ORDER BY s.is_other ASC, s.display_order ASC
                ) FILTER (WHERE s.id IS NOT NULL),
                '[]'::json
              ) AS subcategories
       FROM categories c
       LEFT JOIN subcategories s ON s.category_id = c.id AND s.status = 'active' AND s.is_active = true
       WHERE c.country_code = $1 AND c.is_active = true
       GROUP BY c.id
       ORDER BY c.display_order ASC`,
      [req.countryCode]
    );
    res.json({ categories: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /categories/:slug/subcategories — active subcategories for a category
router.get('/:slug/subcategories', async (req, res, next) => {
  try {
    const cat = await db.query(
      'SELECT id FROM categories WHERE slug = $1 AND country_code = $2 AND is_active = true',
      [req.params.slug, req.countryCode]
    );
    if (!cat.rows.length) return res.status(404).json({ error: 'Category not found' });

    const result = await db.query(
      `SELECT id, name, slug, is_other, display_order
       FROM subcategories
       WHERE category_id = $1 AND status = 'active' AND is_active = true
       ORDER BY is_other ASC, display_order ASC`,
      [cat.rows[0].id]
    );
    res.json({ subcategories: result.rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
