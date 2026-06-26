const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const result = await db.query(
      'SELECT id, created_at FROM listings WHERE is_active = true ORDER BY created_at DESC'
    );

    const urls = [
      `  <url>
    <loc>https://bridgepro.a3tech.uk/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>`,
      ...result.rows.map((row) => {
        const lastmod = new Date(row.created_at).toISOString().split('T')[0];
        return `  <url>
    <loc>https://bridgepro.a3tech.uk/#/listing/${row.id}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`;
      }),
    ];

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>`;

    res.setHeader('Content-Type', 'application/xml');
    res.send(xml);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
