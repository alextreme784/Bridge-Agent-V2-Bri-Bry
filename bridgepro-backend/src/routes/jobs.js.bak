const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { notify } = require('../services/notificationService');

const router = express.Router();

const VALID_JOB_TYPES = ['one_off', 'part_time', 'full_time', 'contract', 'collaboration'];

// GET /jobs — browse all active job listings (requires login)
// hire_me listings are only visible to verified providers and admins
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { category, search } = req.query;
    const params = [req.countryCode];
    let where = 'j.country_code = $1 AND j.is_active = true';

    // hire_me listings are visible to all logged-in users

    if (category) {
      params.push(category);
      where += ` AND c.slug = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (j.title ILIKE $${params.length} OR j.description ILIKE $${params.length})`;
    }

    const result = await db.query(
      `SELECT j.*, u.full_name, u.account_type,
              c.name AS category_name, c.icon AS category_icon, c.slug AS category_slug,
              (SELECT COUNT(*) FROM job_interests ji WHERE ji.job_id = j.id) AS interest_count,
              EXISTS(SELECT 1 FROM job_interests ji WHERE ji.job_id = j.id AND ji.user_id = $${params.length + 1}) AS i_expressed_interest
       FROM job_listings j
       JOIN users u ON u.id = j.user_id
       LEFT JOIN categories c ON c.id = j.category_id
       WHERE ${where}
       ORDER BY j.created_at DESC
       LIMIT 50`,
      [...params, req.user.id]
    );
    res.json({ jobs: result.rows });
  } catch (err) { next(err); }
});

// GET /jobs/my — own job listings
router.get('/my', requireAuth, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT j.*, c.name AS category_name, c.icon AS category_icon,
              (SELECT COUNT(*) FROM job_interests ji WHERE ji.job_id = j.id) AS interest_count
       FROM job_listings j
       LEFT JOIN categories c ON c.id = j.category_id
       WHERE j.user_id = $1 AND j.country_code = $2
       ORDER BY j.created_at DESC`,
      [req.user.id, req.countryCode]
    );
    res.json({ jobs: result.rows });
  } catch (err) { next(err); }
});

// POST /jobs — post a new job listing
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { title, description, category_id, job_type, location, listing_type } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'Title is required' });
    if (!description?.trim()) return res.status(400).json({ error: 'Description is required' });

    const type = VALID_JOB_TYPES.includes(job_type) ? job_type : 'one_off';
    const lType = listing_type === 'hire_me' ? 'hire_me' : 'hiring';

    const userRow = await db.query('SELECT is_verified, customer_verified, role FROM users WHERE id = $1', [req.user.id]);
    const userInfo = userRow.rows[0];
    const isVerified = userInfo?.role === 'customer' ? !!userInfo?.customer_verified : !!userInfo?.is_verified;

    if (lType === 'hire_me') {
      // Unverified customers cannot post Hire Me listings at all
      if (userInfo?.role === 'customer' && !isVerified) {
        return res.status(403).json({
          error: 'You must verify your identity to post a Hire Me listing.',
        });
      }

      // Verified users: max 3 active Hire Me listings; unverified providers: max 1
      const hireLimit = isVerified ? 3 : 1;
      const count = await db.query(
        "SELECT COUNT(*) FROM job_listings WHERE user_id = $1 AND listing_type = 'hire_me' AND country_code = $2 AND is_active = true",
        [req.user.id, req.countryCode]
      );
      if (parseInt(count.rows[0].count) >= hireLimit) {
        return res.status(403).json({
          error: isVerified
            ? 'You have reached the maximum of 3 active Hire Me listings.'
            : 'Unverified providers can only have 1 active Hire Me listing. Verify your identity to post more.',
        });
      }
    }

    // Unverified users: max 3 hiring listings per calendar month
    if (lType === 'hiring' && !isVerified) {
      const monthCount = await db.query(
        `SELECT COUNT(*) FROM job_listings
         WHERE user_id = $1 AND listing_type = 'hiring' AND country_code = $2
           AND created_at >= date_trunc('month', CURRENT_DATE)`,
        [req.user.id, req.countryCode]
      );
      if (parseInt(monthCount.rows[0].count) >= 3) {
        return res.status(403).json({
          error: 'Unverified users can post a maximum of 3 hiring listings per month. Verify your identity to remove this limit.',
        });
      }
    }

    const result = await db.query(
      `INSERT INTO job_listings (id, user_id, country_code, title, description, category_id, job_type, location, listing_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [uuidv4(), req.user.id, req.countryCode, title.trim(), description.trim(),
       category_id || null, type, location?.trim() || null, lType]
    );
    res.status(201).json({ job: result.rows[0] });
  } catch (err) { next(err); }
});

// PUT /jobs/cv — update own CV profile fields (must be before /:id)
router.put('/cv', requireAuth, async (req, res, next) => {
  try {
    const { cv_skills, cv_experience, cv_availability } = req.body;
    const skills = Array.isArray(cv_skills)
      ? cv_skills.map((s) => s.trim()).filter(Boolean)
      : (typeof cv_skills === 'string' ? cv_skills.split(',').map((s) => s.trim()).filter(Boolean) : null);

    await db.query(
      `UPDATE users SET
         cv_skills       = COALESCE($1, cv_skills),
         cv_experience   = COALESCE($2, cv_experience),
         cv_availability = COALESCE($3, cv_availability)
       WHERE id = $4`,
      [skills, cv_experience?.trim() || null, cv_availability || null, req.user.id]
    );
    res.json({ message: 'CV updated' });
  } catch (err) { next(err); }
});

// POST /jobs/:id/interest — express interest in a job listing
router.post('/:id/interest', requireAuth, async (req, res, next) => {
  try {
    const job = await db.query(
      `SELECT j.*, u.full_name AS poster_name
       FROM job_listings j
       JOIN users u ON u.id = j.user_id
       WHERE j.id = $1 AND j.country_code = $2 AND j.is_active = true`,
      [req.params.id, req.countryCode]
    );
    if (!job.rows.length) return res.status(404).json({ error: 'Job listing not found' });

    const j = job.rows[0];
    if (j.user_id === req.user.id) {
      return res.status(400).json({ error: 'You cannot express interest in your own listing' });
    }

    await db.query(
      'INSERT INTO job_interests (id, job_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [uuidv4(), j.id, req.user.id]
    );

    const me = await db.query('SELECT full_name FROM users WHERE id = $1', [req.user.id]);
    const myName = me.rows[0]?.full_name || 'Someone';

    notify(
      j.user_id,
      'job_interest',
      '&#128588; Interest in your listing',
      `${myName} expressed interest in your job listing: "${j.title}"`,
      { job_id: j.id, url: '/jobs' }
    );

    res.json({ message: 'Interest expressed' });
  } catch (err) { next(err); }
});

// GET /jobs/:id/interests — list users who expressed interest (poster only)
router.get('/:id/interests', requireAuth, async (req, res, next) => {
  try {
    const job = await db.query(
      'SELECT id, user_id, title FROM job_listings WHERE id = $1 AND country_code = $2',
      [req.params.id, req.countryCode]
    );
    if (!job.rows.length) return res.status(404).json({ error: 'Job listing not found' });
    if (job.rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Not your listing' });

    const result = await db.query(
      `SELECT u.id, u.full_name, u.phone, u.email, u.role, u.account_type, ji.created_at
       FROM job_interests ji
       JOIN users u ON u.id = ji.user_id
       WHERE ji.job_id = $1
       ORDER BY ji.created_at DESC`,
      [req.params.id]
    );
    res.json({ interests: result.rows });
  } catch (err) { next(err); }
});

// POST /jobs/:id/contact — request contact info or share contact info (requires prior interest)
router.post('/:id/contact', requireAuth, async (req, res, next) => {
  try {
    const job = await db.query(
      `SELECT j.id, j.title, j.user_id
       FROM job_listings j
       WHERE j.id = $1 AND j.country_code = $2`,
      [req.params.id, req.countryCode]
    );
    if (!job.rows.length) return res.status(404).json({ error: 'Job listing not found' });

    const j = job.rows[0];
    if (j.user_id === req.user.id) return res.status(400).json({ error: 'Cannot contact your own listing' });

    const interest = await db.query(
      'SELECT id FROM job_interests WHERE job_id = $1 AND user_id = $2',
      [j.id, req.user.id]
    );
    if (!interest.rows.length) return res.status(403).json({ error: 'Express interest first' });

    const me = await db.query('SELECT full_name FROM users WHERE id = $1', [req.user.id]);
    const myName = me.rows[0]?.full_name || 'Someone';

    const { request_only, phone, whatsapp, email } = req.body;

    if (request_only) {
      notify(j.user_id, 'job_contact_request', '&#128222; Contact info requested',
        `${myName} would like your contact info for: "${j.title}"`,
        { job_id: j.id, url: '/jobs' });
    } else {
      const parts = [];
      if (phone) parts.push(`Phone: ${phone}`);
      if (whatsapp) parts.push(`WhatsApp: ${whatsapp}`);
      if (email) parts.push(`Email: ${email}`);
      if (!parts.length) return res.status(400).json({ error: 'No contact info provided' });
      notify(j.user_id, 'job_contact_shared', '&#128203; Contact info received',
        `${myName} shared contact info for "${j.title}": ${parts.join(' · ')}`,
        { job_id: j.id, url: '/jobs' });
    }

    res.json({ message: 'Sent' });
  } catch (err) { next(err); }
});

// PUT /jobs/:id — edit own job listing
router.put('/:id', requireAuth, async (req, res, next) => {
  try {
    const { title, description, category_id, job_type, location, is_active, listing_type } = req.body;
    const existing = await db.query(
      'SELECT id FROM job_listings WHERE id = $1 AND user_id = $2 AND country_code = $3',
      [req.params.id, req.user.id, req.countryCode]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Job listing not found' });

    const type = job_type && VALID_JOB_TYPES.includes(job_type) ? job_type : undefined;
    const lType = listing_type === 'hire_me' ? 'hire_me' : listing_type === 'hiring' ? 'hiring' : undefined;

    const result = await db.query(
      `UPDATE job_listings SET
         title        = COALESCE($1, title),
         description  = COALESCE($2, description),
         category_id  = COALESCE($3, category_id),
         job_type     = COALESCE($4, job_type),
         location     = COALESCE($5, location),
         is_active    = COALESCE($6, is_active),
         listing_type = COALESCE($7, listing_type),
         updated_at   = NOW()
       WHERE id = $8 RETURNING *`,
      [title?.trim() || null, description?.trim() || null, category_id || null,
       type || null, location?.trim() || null, is_active ?? null, lType || null, req.params.id]
    );
    res.json({ job: result.rows[0] });
  } catch (err) { next(err); }
});

// DELETE /jobs/:id — delete own job listing
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const result = await db.query(
      'DELETE FROM job_listings WHERE id = $1 AND user_id = $2 AND country_code = $3 RETURNING id',
      [req.params.id, req.user.id, req.countryCode]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Job listing not found' });
    res.json({ message: 'Job listing deleted' });
  } catch (err) { next(err); }
});

module.exports = router;
