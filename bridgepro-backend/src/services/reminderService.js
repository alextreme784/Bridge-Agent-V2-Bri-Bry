const db = require('../db');
const { sendVapidPush } = require('./pushService');
const socketService = require('./socketService');

// Query and fire due reminders every 15 seconds
function startReminderScheduler() {
  setInterval(async () => {
    try {
      const now = new Date();
      // Get all tasks due now or in the past (respecting their configured alert offsets) that have not been notified
      const { rows } = await db.query(
        `SELECT t.*, l.id AS provider_id 
         FROM tasks t
         LEFT JOIN listings l ON l.user_id = t.user_id OR l.id::text = t.title
         WHERE (t.due_at - (COALESCE(t.remind, 30) * INTERVAL '1 minute')) <= $1 
           AND t.notified = false AND t.is_done = false`,
        [now]
      );

      for (const task of rows) {
        // Resolve a providerId if possible
        let providerId = task.provider_id || '';
        if (!providerId) {
          // Attempt parsing UUID from title if any
          const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
          const match = task.title.match(uuidRegex);
          if (match) providerId = match[0];
        }

        const payload = {
          message: `Reminder: ${task.title}`,
          actions: [
            { label: 'Yes', action: 'initiate_chat', params: { providerId } },
            { label: 'No', action: 'dismiss' }
          ]
        };

        // 1. Send VAPID Web Push Notification with snooze and dismiss actions
        try {
          await sendVapidPush(task.user_id, 'BridgePro Task Reminder ⏰', payload.message, {
            url: '/wpas/calendar.html',
            topic: `reminder_task_${task.id}`,
            tag: `reminder_task_${task.id}`,
            taskId: task.id,
            actions: [
              { action: 'snooze_10', title: 'Snooze 10m' },
              { action: 'dismiss', title: 'Dismiss' }
            ],
            ...payload
          });
        } catch (pushErr) {
          console.error('[ReminderService] VAPID push failed:', pushErr.message);
        }

        // 2. Send Real-Time Socket.io Alert to the user room
        try {
          socketService.getIO().to('user_' + task.user_id).emit('proactive_trigger', payload);
        } catch (socketErr) {
          // Socket service might not be initialized or user offline, silent ignore
        }

        // Handle repeating tasks or mark as notified
        if (task.repeat_interval && task.repeat_interval !== 'none') {
          const nextDue = new Date(task.due_at);
          if (task.repeat_interval === 'daily') {
            nextDue.setUTCDate(nextDue.getUTCDate() + 1);
          } else if (task.repeat_interval === 'weekly') {
            nextDue.setUTCDate(nextDue.getUTCDate() + 7);
          } else if (task.repeat_interval === 'monthly') {
            nextDue.setUTCMonth(nextDue.getUTCMonth() + 1);
          } else if (task.repeat_interval === 'yearly') {
            nextDue.setUTCFullYear(nextDue.getUTCFullYear() + 1);
          }
          
          const year = nextDue.getUTCFullYear();
          const month = String(nextDue.getUTCMonth() + 1).padStart(2, '0');
          const day = String(nextDue.getUTCDate()).padStart(2, '0');
          const nextDateStr = `${year}-${month}-${day}`;

          await db.query(
            `UPDATE tasks 
             SET due_at = $1, task_date = $2, notified = false 
             WHERE id = $3`,
            [nextDue, nextDateStr, task.id]
          );
        } else {
          await db.query('UPDATE tasks SET notified = true WHERE id = $1', [task.id]);
        }
        console.log(`[ReminderService] Fired reminder for task: ${task.id} (${task.title})`);
      }
    } catch (err) {
      console.error('[ReminderService] Error in reminder scheduler loop:', err.message);
    }
  }, 15000); // Check every 15 seconds
}

module.exports = { startReminderScheduler };
