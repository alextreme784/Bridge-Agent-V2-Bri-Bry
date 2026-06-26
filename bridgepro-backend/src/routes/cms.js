const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const THEMES = {
  default:      { name: 'Default',      accent: '#009E60', accentDark: '#007a4b', emoji: '🌿' },
  christmas:    { name: 'Christmas',    accent: '#c0392b', accentDark: '#922b21', emoji: '🎄' },
  independence: { name: 'Independence', accent: '#0054A0', accentDark: '#003d7a', emoji: '🏴' },
  carnival:     { name: 'Carnival',     accent: '#e67e22', accentDark: '#ca6f1e', emoji: '🎉' },
  easter:       { name: 'Easter',       accent: '#8e44ad', accentDark: '#6c3483', emoji: '🐣' },
};

// ── Public: active theme + announcement ─────────────────────────────────────

router.get('/active', async (req, res, next) => {
  try {
    const [themeRow, annRow] = await Promise.all([
      db.query(
        `SELECT value FROM cms_settings WHERE key = $1`,
        [req.countryCode + ':theme']
      ),
      db.query(
        `SELECT * FROM announcements
         WHERE country_code = $1 AND is_active = true
           AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY created_at DESC LIMIT 1`,
        [req.countryCode]
      ),
    ]);

    const themeKey = (themeRow.rows[0]?.value ?? '"default"').replace(/"/g, '');
    const theme = { key: themeKey, ...(THEMES[themeKey] || THEMES.default) };
    const announcement = annRow.rows[0] || null;

    res.json({ theme, announcement });
  } catch (err) { next(err); }
});

// ── Admin: get available themes + current ────────────────────────────────────

router.get('/admin/theme', ...requireRole('admin'), async (req, res, next) => {
  try {
    const row = await db.query(
      `SELECT value FROM cms_settings WHERE key = $1`,
      [req.countryCode + ':theme']
    );
    const current = (row.rows[0]?.value ?? '"default"').replace(/"/g, '');
    res.json({ current, themes: THEMES });
  } catch (err) { next(err); }
});

// ── Admin: set theme ─────────────────────────────────────────────────────────

router.put('/admin/theme', ...requireRole('admin'), async (req, res, next) => {
  const { theme } = req.body;
  if (!THEMES[theme]) return res.status(400).json({ error: 'Unknown theme key' });
  try {
    await db.query(
      `INSERT INTO cms_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
      [req.countryCode + ':theme', JSON.stringify(theme)]
    );
    res.json({ message: `Theme set to ${THEMES[theme].name}`, theme, ...THEMES[theme] });
  } catch (err) { next(err); }
});

// ── Admin: list announcements ────────────────────────────────────────────────

router.get('/admin/announcements', ...requireRole('admin'), async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT a.*, u.full_name AS created_by_name
       FROM announcements a
       LEFT JOIN users u ON u.id = a.created_by
       WHERE a.country_code = $1
       ORDER BY a.created_at DESC LIMIT 50`,
      [req.countryCode]
    );
    res.json({ announcements: result.rows });
  } catch (err) { next(err); }
});

// ── Admin: create announcement ───────────────────────────────────────────────

router.post('/admin/announcements', ...requireRole('admin'), async (req, res, next) => {
  const { title, message, cta_text, cta_url, bg_color, text_color, expires_at } = req.body;
  if (!title?.trim() || !message?.trim()) {
    return res.status(400).json({ error: 'Title and message are required' });
  }
  try {
    const result = await db.query(
      `INSERT INTO announcements
         (id, country_code, title, message, cta_text, cta_url, bg_color, text_color, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        uuidv4(), req.countryCode,
        title.trim(), message.trim(),
        cta_text?.trim() || null,
        cta_url?.trim()  || null,
        bg_color   || '#1a1a2e',
        text_color || '#ffffff',
        expires_at || null,
        req.user.id,
      ]
    );
    res.status(201).json({ announcement: result.rows[0] });
  } catch (err) { next(err); }
});

// ── Admin: update announcement ───────────────────────────────────────────────

router.put('/admin/announcements/:id', ...requireRole('admin'), async (req, res, next) => {
  const { title, message, cta_text, cta_url, bg_color, text_color, is_active, expires_at } = req.body;
  try {
    const result = await db.query(
      `UPDATE announcements SET
         title      = COALESCE($1, title),
         message    = COALESCE($2, message),
         cta_text   = COALESCE($3, cta_text),
         cta_url    = COALESCE($4, cta_url),
         bg_color   = COALESCE($5, bg_color),
         text_color = COALESCE($6, text_color),
         is_active  = COALESCE($7, is_active),
         expires_at = $8
       WHERE id = $9 AND country_code = $10 RETURNING *`,
      [
        title?.trim()   || null,
        message?.trim() || null,
        cta_text?.trim() !== undefined ? (cta_text.trim() || null) : null,
        cta_url?.trim()  !== undefined ? (cta_url.trim()  || null) : null,
        bg_color   || null,
        text_color || null,
        is_active  ?? null,
        expires_at || null,
        req.params.id, req.countryCode,
      ]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ announcement: result.rows[0] });
  } catch (err) { next(err); }
});

// ── Admin: delete announcement ───────────────────────────────────────────────

router.delete('/admin/announcements/:id', ...requireRole('admin'), async (req, res, next) => {
  try {
    await db.query(
      `DELETE FROM announcements WHERE id = $1 AND country_code = $2`,
      [req.params.id, req.countryCode]
    );
    res.json({ message: 'Deleted' });
  } catch (err) { next(err); }
});

module.exports = router;
