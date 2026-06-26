require('dotenv').config({ path: __dirname + '/.env' });
const http = require('http');
const app = require('./src/app');
const socketService = require('./src/services/socketService');
const cron = require('node-cron');
const db = require('./src/db');

const PORT = process.env.PORT || 3000;

const server = http.createServer(app);
socketService.init(server);

// Start proactive task reminder daemon
const { startReminderScheduler } = require('./src/services/reminderService');
startReminderScheduler();

server.listen(PORT, () => {
  console.log(`BridgePro API running on port ${PORT} [${process.env.NODE_ENV}]`);
});

// Daily at midnight: lapse providers whose free-period subscription_end_date has passed
// Also resets subscription_tier to 'level1' on lapse
cron.schedule('0 0 * * *', async () => {
  try {
    const result = await db.query(
      `UPDATE users
       SET subscription_status = 'lapsed',
           subscription_tier = 'level1'
       WHERE subscription_status = 'free_period'
         AND subscription_end_date IS NOT NULL
         AND subscription_end_date < NOW()
       RETURNING id, email`
    );
    if (result.rows.length > 0) {
      console.log(`[CRON] Lapsed ${result.rows.length} providers: ${result.rows.map((r) => r.email).join(', ')}`);
    }
  } catch (err) {
    console.error('[CRON] Free period expiry job failed:', err.message);
  }
});

// Daily at 1:00 AM: expire bridge points past their expires_at date
cron.schedule('0 1 * * *', async () => {
  const { expirePoints } = require('./src/services/pointsService');
  try {
    const result = await expirePoints();
    if (result.expired_count > 0) {
      console.log(`[CRON] Points expiry: ${result.expired_count} records expired, ${result.total_points_removed} total points removed`);
    }
  } catch (err) {
    console.error('[CRON] Points expiry job failed:', err.message);
  }
});
