const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { notify } = require('../services/notificationService');

const router = express.Router();

// GET /api/v1/appointments — upcoming appointments in tasks-compatible shape for Connek calendar
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, title,
              TO_CHAR(appointment_at, 'YYYY-MM-DD') AS date,
              TO_CHAR(appointment_at, 'HH24:MI')    AS time,
              notes,
              reminder_minutes_before,
              reminder_sent
       FROM appointments
       WHERE customer_id = $1
         AND status = 'scheduled'
         AND appointment_at > LOCALTIMESTAMP
       ORDER BY appointment_at ASC`,
      [req.user.id]
    );

    const tasks = rows.map(a => ({
      id: `appt_${a.id}`,
      type: 'Meeting',
      title: a.title,
      date: a.date,
      time: a.time,
      notes: a.notes || '',
      remind: a.reminder_minutes_before,
      repeat: 'none',
      notified: a.reminder_sent,
      source: 'bridgepro',
    }));

    res.json({ success: true, tasks });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/appointments/provider — provider's upcoming jobs
router.get('/provider', requireAuth, ...requireRole('provider', 'admin'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT a.id, a.title,
              TO_CHAR(a.appointment_at, 'YYYY-MM-DD HH24:MI') AS appointment_at,
              a.notes, a.status, u.full_name AS customer_name
       FROM appointments a
       JOIN users u ON u.id = a.customer_id
       WHERE a.provider_id = $1 AND a.status = 'scheduled'
       ORDER BY a.appointment_at ASC`,
      [req.user.id]
    );
    res.json({ jobs: rows });
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/appointments/:id/complete — mark appointment complete
router.put('/:id/complete', requireAuth, async (req, res, next) => {
  try {
    const { completion_note } = req.body;
    const appt = await db.query(
      'SELECT id, provider_id, customer_id, title FROM appointments WHERE id = $1',
      [req.params.id]
    );
    if (!appt.rows.length) return res.status(404).json({ error: 'Job not found' });

    // Check auth: only provider or admin can mark complete
    if (appt.rows[0].provider_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const noteText = completion_note ? `Completion Note: ${completion_note}` : '';
    await db.query(
      `UPDATE appointments
       SET status = 'completed',
           notes = CASE WHEN notes IS NULL OR notes = '' THEN $1 ELSE notes || E'\n' || $1 END,
           updated_at = NOW()
       WHERE id = $2`,
      [noteText, req.params.id]
    );

    // Notify customer
    notify(appt.rows[0].customer_id, 'job_completed', '✅ Job Completed', `Provider has marked "${appt.rows[0].title}" as complete.`, { url: '/dashboard' }).catch(() => {});

    res.json({ success: true, appointment_id: req.params.id });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
