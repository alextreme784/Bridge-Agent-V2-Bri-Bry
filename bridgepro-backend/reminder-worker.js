require('dotenv').config({ path: __dirname + '/.env' });

const cron = require('node-cron');
const db = require('./src/db');
const { sendPush } = require('./src/services/pushService');
const notificationService = require('./src/services/notificationService');

console.log('[ReminderWorker] Starting — will check appointments every minute');

// Add watchdog columns to tables that don't have them yet (idempotent)
(async () => {
  try {
    // listings has no updated_at — add it, backfill from created_at, then add last_notified_at
    await db.query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP`);
    await db.query(`UPDATE listings SET updated_at = created_at WHERE updated_at IS NULL`);
    await db.query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS last_notified_at TIMESTAMP`);
    await db.query(`ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS last_notified_at TIMESTAMP`);
    await db.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS last_notified_at TIMESTAMP`);
    console.log('[ReminderWorker] Watchdog columns verified');
  } catch (err) {
    console.error('[ReminderWorker] Watchdog column setup error:', err.message);
  }
})();

cron.schedule('* * * * *', async () => {
  try {
    // appointment_at is stored in SVG local time; LOCALTIMESTAMP returns SVG local time
    // because the DB session timezone is America/St_Vincent.
    const { rows } = await db.query(`
      SELECT id, customer_id, title, reminder_minutes_before
      FROM appointments
      WHERE status = 'scheduled'
        AND reminder_sent = FALSE
        AND (appointment_at - (reminder_minutes_before * INTERVAL '1 minute')) <= LOCALTIMESTAMP
        AND appointment_at > LOCALTIMESTAMP
    `);

    for (const appt of rows) {
      try {
        await sendPush(
          appt.customer_id,
          'Upcoming appointment',
          `${appt.title} in ${appt.reminder_minutes_before} minutes`
        );
      } catch (pushErr) {
        console.error('[ReminderWorker] Push failed for appointment', appt.id, ':', pushErr.message);
      }

      await db.query(
        'UPDATE appointments SET reminder_sent = TRUE, updated_at = NOW() WHERE id = $1',
        [appt.id]
      );
      console.log('[ReminderWorker] Reminder sent for appointment', appt.id, '—', appt.title);
    }
  } catch (err) {
    console.error('[ReminderWorker] Error in cron tick:', err.message);
  }
});

async function checkPendingDrafts() {
  let notifiedCount = 0;

  try {
    // Pending enquiries — nudge the provider who hasn't responded
    const { rows: pendingEnquiries } = await db.query(`
      SELECT id, provider_id
      FROM enquiries
      WHERE status = 'pending'
        AND updated_at < NOW() - INTERVAL '30 minutes'
        AND (last_notified_at IS NULL OR last_notified_at < NOW() - INTERVAL '2 hours')
    `);

    for (const enq of pendingEnquiries) {
      if (!enq.provider_id) continue;
      try {
        await notificationService.notify(
          enq.provider_id,
          'watchdog_draft',
          'Draft Unfinished',
          "You left a draft unfinished! Tap here to review your Enquiry.",
          { url: '/ai-chat' }
        );
        await db.query('UPDATE enquiries SET last_notified_at = NOW() WHERE id = $1', [enq.id]);
        notifiedCount++;
      } catch (e) {
        console.error('[Watchdog] Notify failed for enquiry', enq.id, ':', e.message);
      }
    }

    // Draft listings (is_public = false) — nudge the owner to publish
    const { rows: draftListings } = await db.query(`
      SELECT id, user_id
      FROM listings
      WHERE is_public = false
        AND updated_at < NOW() - INTERVAL '30 minutes'
        AND (last_notified_at IS NULL OR last_notified_at < NOW() - INTERVAL '2 hours')
    `);

    for (const listing of draftListings) {
      if (!listing.user_id) continue;
      try {
        await notificationService.notify(
          listing.user_id,
          'watchdog_draft',
          'Draft Unfinished',
          "You left a draft unfinished! Tap here to review your Listing.",
          { url: '/ai-chat' }
        );
        await db.query('UPDATE listings SET last_notified_at = NOW() WHERE id = $1', [listing.id]);
        notifiedCount++;
      } catch (e) {
        console.error('[Watchdog] Notify failed for listing', listing.id, ':', e.message);
      }
    }

    // Appointments with pending/draft status — forward-compatible for AI-created drafts
    const { rows: draftAppts } = await db.query(`
      SELECT id, customer_id
      FROM appointments
      WHERE status IN ('pending', 'draft')
        AND updated_at < NOW() - INTERVAL '30 minutes'
        AND (last_notified_at IS NULL OR last_notified_at < NOW() - INTERVAL '2 hours')
    `);

    for (const appt of draftAppts) {
      try {
        await notificationService.notify(
          appt.customer_id,
          'watchdog_draft',
          'Draft Unfinished',
          "You left a draft unfinished! Tap here to review your Appointment.",
          { url: '/ai-chat' }
        );
        await db.query('UPDATE appointments SET last_notified_at = NOW() WHERE id = $1', [appt.id]);
        notifiedCount++;
      } catch (e) {
        console.error('[Watchdog] Notify failed for appointment', appt.id, ':', e.message);
      }
    }
  } catch (err) {
    console.error('[Watchdog] Error in checkPendingDrafts:', err.message);
  }

  console.log(`[Watchdog] Checked pending drafts and notified ${notifiedCount} users`);
}

cron.schedule('*/30 * * * *', checkPendingDrafts);
