const db = require('../db');
const { v4: uuidv4 } = require('uuid');

// Autocreate the tasks table if not existing in multi-tenant PostgreSQL
db.query(`
  CREATE TABLE IF NOT EXISTS tasks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    country_code VARCHAR(10),
    title TEXT NOT NULL,
    due_at TIMESTAMPTZ NOT NULL,
    is_done BOOLEAN DEFAULT false,
    notified BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
`).then(() => {
  return db.query(`
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_type VARCHAR(50) DEFAULT 'Event';
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT '';
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS remind INTEGER DEFAULT 30;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS repeat_interval VARCHAR(20) DEFAULT 'none';
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_date VARCHAR(10);
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_time VARCHAR(8) DEFAULT '';
  `);
}).catch((err) => console.error('[Database] Error initializing/migrating tasks table:', err.message));

// 1. Tool Schemas for Anthropic Claude (Function Calling)
const CLAUDE_TOOL_SCHEMAS = [
  {
    name: 'fetchListing',
    description: 'Search and retrieve active business listings/merchants matching a keyword or category query within a country scope.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword or business name to search' },
        countryCode: { type: 'string', description: 'Normalized 3-letter country code (SVG, SLU, GRD)' }
      },
      required: ['query', 'countryCode']
    }
  },
  {
    name: 'createCalendarTask',
    description: 'Create a scheduled calendar task or voice reminder. ' +
      'For RELATIVE times ("in 5 minutes", "in 2 hours") — pass minutes_from_now and omit timestamp; the server computes the exact SVG local time. ' +
      'For ABSOLUTE times ("tomorrow at 3pm", "June 25th at 10am") — pass timestamp in ISO 8601 SVG local time (no Z suffix) and omit minutes_from_now.',
    input_schema: {
      type: 'object',
      properties: {
        taskDetails: { type: 'string', description: 'The text title/description of the reminder' },
        timestamp: { type: 'string', description: 'Use for ABSOLUTE times only. ISO 8601 in SVG local time, no Z suffix — e.g. "2026-06-25T14:30:00". Never use for relative phrases like "in 5 minutes".' },
        minutes_from_now: { type: 'integer', description: 'Use for RELATIVE times only ("in 5 minutes" → 5, "in 2 hours" → 120). Server computes the SVG timestamp. Do NOT use for absolute dates.' },
        taskType: { type: 'string', enum: ['Event', 'Reminder', 'Alert', 'Birthday', 'Meeting', 'Health', 'Travel', 'Personal'], description: 'The type category of event' },
        notes: { type: 'string', description: 'Extra details or description' },
        remind: { type: 'integer', description: 'Minutes before the task time to trigger notification reminder' },
        repeat: { type: 'string', enum: ['none', 'daily', 'weekly', 'monthly', 'yearly'], description: 'Repeat interval' }
      },
      required: ['taskDetails']
    }
  },
  {
    name: 'initiateProcurementWorkflow',
    description: 'Create a pending procurement order/enquiry for a provider/merchant for specific service/items.',
    input_schema: {
      type: 'object',
      properties: {
        providerId: { type: 'string', description: 'UUID of the merchant listing' },
        serviceItems: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Name of service or item' },
              quantity: { type: 'number', description: 'Quantity required' }
            },
            required: ['name', 'quantity']
          }
        }
      },
      required: ['providerId', 'serviceItems']
    }
  },
  {
    name: 'checkPendingActions',
    description: 'Check if there are any active/pending calendar tasks or enquiries/procurements with a provider to enforce Context Memory and prevent duplicates.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['tasks', 'enquiries', 'all'], description: 'Category to look up' }
      },
      required: ['type']
    }
  },
  {
    name: 'updateCalendarTask',
    description: 'Update or edit details of an existing calendar task or todo list item (e.g. mark it as done, change its title, notes, due date, time, reminder alert, or repeat interval).',
    input_schema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The UUID of the task to update' },
        title: { type: 'string', description: 'New title/description of the task' },
        date: { type: 'string', description: 'New scheduled date (YYYY-MM-DD)' },
        time: { type: 'string', description: 'New scheduled time (HH:MM)' },
        taskType: { type: 'string', enum: ['Event', 'Reminder', 'Alert', 'Birthday', 'Meeting', 'Health', 'Travel', 'Personal'], description: 'The type category of event' },
        notes: { type: 'string', description: 'Extra details or description' },
        remind: { type: 'integer', description: 'Minutes before to trigger notification reminder' },
        repeat: { type: 'string', enum: ['none', 'daily', 'weekly', 'monthly', 'yearly'], description: 'Repeat interval' },
        isDone: { type: 'boolean', description: 'Set to true to mark the task as complete/done, or false for incomplete' }
      },
      required: ['taskId']
    }
  },
  {
    name: 'deleteCalendarTask',
    description: 'Delete/remove an existing calendar task or todo list item.',
    input_schema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The UUID of the task to delete' }
      },
      required: ['taskId']
    }
  },
  {
    name: 'searchCalendarTask',
    description: 'Search for a calendar task or todo item by title keyword or date — including completed tasks. Use this before updating or deleting a task when the task ID is unknown.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Keyword to search for in the task title' },
        date: { type: 'string', description: 'Date (YYYY-MM-DD) to filter tasks by due date' },
        includeDone: { type: 'boolean', description: 'Set to true to include completed tasks in results (default: false)' }
      }
    }
  },
  {
    name: 'manageNewsFeed',
    description: 'Add, update, or delete RSS news feeds (available for admin/moderator roles).',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'delete'], description: 'The action to perform' },
        feedId: { type: 'string', description: 'Numeric ID of the feed (required for update/delete)' },
        name: { type: 'string', description: 'Name of the RSS news feed' },
        url: { type: 'string', description: 'The RSS feed URL' },
        category: { type: 'string', description: 'News category (default: caribbean)' },
        countryCode: { type: 'string', description: 'Country code or ALL (default: ALL)' },
        isActive: { type: 'boolean', description: 'Deactivate/activate the feed' }
      },
      required: ['action']
    }
  },
  {
    name: 'translateText',
    description: 'Translate text from one language to another (e.g. English to Spanish, French, etc.) using the translation engine.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text content to translate' },
        targetLang: { type: 'string', description: 'The 2-letter ISO language code to translate into (e.g., es, fr, de, it, ja, zh, pt, nl, ko)' },
        sourceLang: { type: 'string', description: 'The 2-letter ISO language code of the source text (default: en)' }
      },
      required: ['text', 'targetLang']
    }
  },
  {
    name: 'getReviews',
    description: 'Retrieve reviews for a provider listing.',
    input_schema: {
      type: 'object',
      properties: {
        listingId: { type: 'string', description: 'The UUID of the provider listing to fetch reviews for' }
      },
      required: ['listingId']
    }
  },
  {
    name: 'getRecommendations',
    description: 'Retrieve personalized concierge recommendations for service listings based on user interests or trending listings.',
    input_schema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'Optional target user UUID to query personalized interests for (defaults to current user)' }
      },
      required: []
    }
  },
  {
    name: 'proposeSlots',
    description: 'Query a provider\'s calendar for the next 7 days and suggest the 3 best available time slots.',
    input_schema: {
      type: 'object',
      properties: {
        providerId: { type: 'string', description: 'The UUID of the service provider to retrieve available slots for' }
      },
      required: ['providerId']
    }
  },
  {
    name: 'initiateBooking',
    description: 'Propose an appointment booking slot with a service provider, setting its status to pending provider approval.',
    input_schema: {
      type: 'object',
      properties: {
        providerId: { type: 'string', description: 'The UUID of the service provider to book with' },
        startTime: { type: 'string', description: 'ISO 8601 datetime format for the slot (e.g. "2026-06-25T14:00:00")' },
        title: { type: 'string', description: 'A short description/title for the appointment booking' }
      },
      required: ['providerId', 'startTime', 'title']
    }
  },
  {
    name: 'confirmBooking',
    description: 'Confirm a proposed pending appointment booking slot. Provider only.',
    input_schema: {
      type: 'object',
      properties: {
        appointmentId: { type: 'integer', description: 'The integer ID of the pending appointment to confirm' }
      },
      required: ['appointmentId']
    }
  },
  {
    name: 'msme_credit_export',
    description: 'Generate a structured MSME_Credit_Profile for a service provider — packages their verified transaction volume, job count, average ticket size, success rate, and customer reputation score into a format suitable for bank or lender submission. Admin and trusted lender partners only.',
    input_schema: {
      type: 'object',
      properties: {
        provider_id: { type: 'string', description: 'UUID of the service provider/merchant to profile' }
      },
      required: ['provider_id']
    }
  },
  {
    name: 'admin_get_expansion_config',
    description: 'List all 13 Caribbean islands in the Expansion Engine — shows which are live, their domain slugs, and currencies. Admin only.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'admin_set_island_status',
    description: 'Explicitly set a Caribbean island market live (true) or offline (false) in the Expansion Engine. SVG flagship cannot be set offline. Admin only.',
    input_schema: {
      type: 'object',
      properties: {
        code:    { type: 'string',  description: '3-letter BridgePro country code (e.g. GRD, SLU, JAM)' },
        is_live: { type: 'boolean', description: 'true to bring the island live, false to take it offline' }
      },
      required: ['code', 'is_live']
    }
  },
  {
    name: 'admin_toggle_market',
    description: 'Bring a country market live or take it offline. Admin only. SVG cannot be toggled.',
    input_schema: {
      type: 'object',
      properties: {
        countryCode: { type: 'string',  description: 'The 3-letter BridgePro country code (e.g. GRD, SLU, BRB, JAM)' },
        isLive:      { type: 'boolean', description: 'true to launch the market, false to take it offline' }
      },
      required: ['countryCode', 'isLive']
    }
  },
  {
    name: 'log_offplatform_transaction',
    description: 'Log an offline or cash transaction on behalf of the authenticated provider. Records it as a verified transaction in the BridgePro ledger, generates a receipt PDF, and immediately updates the provider\'s Trust Score / BridgePoints. Use this when a provider reports a completed job, cash sale, or any service rendered outside the platform. Provider role required.',
    input_schema: {
      type: 'object',
      properties: {
        customerName:  { type: 'string',  description: 'Full name of the customer or client served' },
        amount:        { type: 'number',  description: 'Transaction amount in XCD (Eastern Caribbean Dollars)' },
        description:   { type: 'string',  description: 'Brief description of the service or goods provided' },
        contactInfo:   { type: 'string',  description: 'Optional: customer email, phone, or other contact detail' }
      },
      required: ['customerName', 'amount', 'description']
    }
  },
  {
    name: 'autoListService',
    description: 'Automatically create a product/service listing from an image URL by analyzing its content. Provider only.',
    input_schema: {
      type: 'object',
      properties: {
        imageUrl: { type: 'string', description: 'URL of the uploaded image to analyze and list (e.g. "/tmp/agent-uploads/product.jpg" or full URL)' },
        providerId: { type: 'string', description: 'Optional provider UUID to associate the product/service with' },
        listingId: { type: 'string', description: 'Optional business listing ID to associate the product with' }
      },
      required: ['imageUrl']
    }
  }
];

// 2. Tool Executors
const CLAUDE_TOOL_EXECUTORS = {
  fetchListing: async ({ query, countryCode }) => {
    try {
      const { rows } = await db.query(
        `SELECT id, business_name, description, phone, email, category, country_code 
         FROM listings 
         WHERE country_code = $1 AND is_active = true 
           AND (business_name ILIKE $2 OR description ILIKE $2 OR category ILIKE $2) 
         LIMIT 5`,
        [countryCode, `%${query}%`]
      );
      return { success: true, listings: rows };
    } catch (err) {
      return { error: 'Failed to fetch listings: ' + err.message };
    }
  },

  createCalendarTask: async ({ taskDetails, timestamp, minutes_from_now, taskType = 'Event', notes = '', remind = 30, repeat = 'none' }, { userId, countryCode }) => {
    try {
      if (!userId) {
        return { error: 'Authentication required to schedule reminders.' };
      }

      // Check Context Memory: verify if a similar task is already pending in tasks database
      const checkRes = await db.query(
        `SELECT id FROM tasks
         WHERE user_id = $1 AND title ILIKE $2 AND is_done = false AND country_code = $3
         LIMIT 1`,
        [userId, `%${taskDetails.trim()}%`, countryCode]
      );
      if (checkRes.rows.length > 0) {
        return { success: false, duplicate: true, message: 'A similar calendar task is already pending in your schedules.' };
      }

      let dateStr, timeStr, dueAt;

      if (minutes_from_now != null) {
        // Relative time — server computes SVG local datetime via PostgreSQL to avoid clock drift
        const mins = parseInt(minutes_from_now, 10);
        if (isNaN(mins) || mins <= 0) return { error: 'minutes_from_now must be a positive integer' };
        const { rows: tr } = await db.query(
          `SELECT LOCALTIMESTAMP + ($1 * INTERVAL '1 minute') AS due_local,
                  TO_CHAR(LOCALTIMESTAMP + ($1 * INTERVAL '1 minute'), 'YYYY-MM-DD') AS date_str,
                  TO_CHAR(LOCALTIMESTAMP + ($1 * INTERVAL '1 minute'), 'HH24:MI') AS time_str`,
          [mins]
        );
        dateStr = tr[0].date_str;
        timeStr = tr[0].time_str;
        dueAt = tr[0].due_local;
      } else {
        // Absolute time — timestamp is SVG local (no Z suffix), parse directly
        if (!timestamp) return { error: 'Provide either minutes_from_now or a timestamp in SVG local time.' };
        const parsedTime = new Date(timestamp);
        if (isNaN(parsedTime.getTime())) return { error: 'Invalid timestamp format. Use ISO 8601 SVG local time, e.g. "2026-06-25T14:30:00".' };
        // timestamp has no Z, so JS Date treats it as local — extract the numbers directly
        const raw = timestamp.replace('T', ' ').slice(0, 16); // "YYYY-MM-DD HH:MM"
        dateStr = raw.slice(0, 10);
        timeStr = raw.slice(11, 16);
        dueAt = parsedTime;
      }

      const id = uuidv4();
      const { rows } = await db.query(
        `INSERT INTO tasks (id, user_id, country_code, title, due_at, is_done, notified, task_type, notes, remind, repeat_interval, task_date, task_time)
         VALUES ($1, $2, $3, $4, $5, false, false, $6, $7, $8, $9, $10, $11)
         RETURNING id, title, task_date, task_time, task_type, remind`,
        [id, userId, countryCode, taskDetails.trim(), dueAt, taskType, notes, remind, repeat, dateStr, timeStr]
      );

      return { success: true, task: rows[0], scheduled_for: `${dateStr} ${timeStr}` };
    } catch (err) {
      return { error: 'Failed to create calendar task: ' + err.message };
    }
  },

  initiateProcurementWorkflow: async ({ providerId, serviceItems }, { userId, countryCode }) => {
    try {
      if (!userId) {
        return { error: 'Authentication required to initiate procurement.' };
      }

      // Check listing details
      const listingRes = await db.query(
        'SELECT id, user_id, business_name FROM listings WHERE id = $1 AND country_code = $2 AND is_active = true',
        [providerId, countryCode]
      );
      if (!listingRes.rows.length) {
        return { error: `Merchant listing not found or inactive within country scope "${countryCode}".` };
      }
      const listing = listingRes.rows[0];

      if (listing.user_id === userId) {
        return { error: 'Cannot place procurement orders with your own business listing.' };
      }

      // Check Context Memory: verify if a similar procurement request is already pending
      const checkRes = await db.query(
        `SELECT id FROM enquiries 
         WHERE listing_id = $1 AND customer_id = $2 AND status = 'pending'
         LIMIT 1`,
        [listing.id, userId]
      );
      if (checkRes.rows.length > 0) {
        return { success: false, duplicate: true, message: `A draft procurement enquiry is already pending with "${listing.business_name}".` };
      }

      const cleanPoItems = (serviceItems || []).map(i => ({
        name: String(i.name || '').trim().slice(0, 200),
        quantity: Math.max(1, parseInt(i.quantity, 10) || 1),
        unit_price: null
      })).filter(i => i.name);

      if (cleanPoItems.length === 0) {
        return { error: 'Validation failed: Procurement order must contain at least one item.' };
      }

      const id = uuidv4();
      const message = `Automated procurement order for service items: ${cleanPoItems.map(i => i.name).join(', ')}.`;
      const { rows } = await db.query(
        `INSERT INTO enquiries (id, country_code, listing_id, customer_id, provider_id, message, po_items, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending') RETURNING *`,
        [id, countryCode, listing.id, userId, listing.user_id, message, JSON.stringify(cleanPoItems)]
      );

      // Notify the provider
      try {
        const customerRow = await db.query('SELECT full_name FROM users WHERE id = $1', [userId]);
        const { notify } = require('../services/notificationService');
        notify(listing.user_id, 'enquiry_new', '📬 New Purchase Order Request', `${customerRow.rows[0]?.full_name || 'A customer'} sent a draft purchase order`, { enquiry_id: id, url: '/dashboard' });
      } catch (e) {
        console.error('Failed to notify provider for draft PO:', e.message);
      }

      return { success: true, enquiry: rows[0], providerName: listing.business_name };
    } catch (err) {
      return { error: 'Procurement creation failed: ' + err.message };
    }
  },

  checkPendingActions: async ({ type }, { userId, countryCode, role }) => {
    try {
      let enquiries = [];
      let tasks = [];
      let chatConversations = [];
      let inventory = [];

      const isAdmin = role === 'admin';

      if (type === 'enquiries' || type === 'all') {
        const enqSql = `
          SELECT e.id, e.listing_id, e.message, e.po_items, e.status, l.business_name,
                 cu.full_name AS customer_name, pr.full_name AS provider_name
          FROM enquiries e
          JOIN listings l ON l.id = e.listing_id
          JOIN users cu ON cu.id = e.customer_id
          JOIN users pr ON pr.id = e.provider_id
          WHERE e.country_code = $2 AND e.status = 'pending'
          ${isAdmin ? '' : 'AND (e.customer_id = $1 OR e.provider_id = $1)'}
          ORDER BY e.created_at DESC`;

        const res = await db.query(enqSql, [userId, countryCode]);
        enquiries = res.rows;

        const chatSql = `
          SELECT c.id AS conversation_id, c.status, c.created_at,
                 COALESCE(l.business_name, jl.title, 'Chat Conversation') AS listing_title,
                 cu.full_name AS customer_name,
                 pr.full_name AS provider_name,
                 (
                   SELECT json_agg(msg) FROM (
                     SELECT m.id, m.sender_id, u.full_name AS sender_name, m.body, m.message_type, m.created_at, m.is_read
                     FROM bc_messages m
                     JOIN users u ON u.id = m.sender_id
                     WHERE m.conversation_id = c.id
                     ORDER BY m.created_at ASC
                     LIMIT 20
                   ) msg
                 ) AS messages
          FROM bc_conversations c
          LEFT JOIN listings l ON l.id = c.listing_id
          LEFT JOIN job_listings jl ON jl.id = c.job_id
          JOIN users cu ON cu.id = c.customer_id
          JOIN users pr ON pr.id = c.provider_id
          WHERE c.status = 'open'
          ${isAdmin ? '' : 'AND (c.customer_id = $1 OR c.provider_id = $1)'}
          ORDER BY c.created_at DESC`;

        const chatRes = await db.query(chatSql, [userId]);
        chatConversations = chatRes.rows;

        const invSql = `
          SELECT bp.id, bp.name, bp.price, bp.currency, bp.unit, bp.in_stock, bp.stock_quantity, l.business_name
          FROM business_products bp
          JOIN listings l ON l.id = bp.listing_id
          WHERE l.country_code = $2
          ${isAdmin ? '' : 'AND l.user_id = $1'}
          ORDER BY bp.name ASC`;

        const prodRes = await db.query(invSql, [userId, countryCode]);
        inventory = prodRes.rows;
      }

      if (type === 'tasks' || type === 'all') {
        const taskSql = `
          SELECT id, title, due_at, is_done, created_at
          FROM tasks
          WHERE country_code = $2 AND is_done = false
          ${isAdmin ? '' : 'AND user_id = $1'}
          ORDER BY due_at ASC`;

        const res = await db.query(taskSql, [userId, countryCode]);
        tasks = res.rows;
      }

      return { success: true, enquiries, tasks, chatConversations, inventory };
    } catch (err) {
      return { error: 'Failed to retrieve pending actions: ' + err.message };
    }
  },

  updateCalendarTask: async ({ taskId, title, date, time, taskType, notes, remind, repeat, isDone }, { userId, role }) => {
    try {
      if (!userId) {
        return { error: 'Authentication required to update tasks.' };
      }

      const isAdmin = role === 'admin';
      const checkSql = 'SELECT * FROM tasks WHERE id = $1' + (isAdmin ? '' : ' AND user_id = $2');
      const checkParams = isAdmin ? [taskId] : [taskId, userId];
      const checkRes = await db.query(checkSql, checkParams);
      if (!checkRes.rows.length) {
        return { error: 'Task not found or unauthorized.' };
      }

      const current = checkRes.rows[0];

      const newTitle = title !== undefined ? title : current.title;
      const newType = taskType !== undefined ? taskType : current.task_type;
      const newNotes = notes !== undefined ? notes : current.notes;
      const newRemind = remind !== undefined ? remind : current.remind;
      const newRepeat = repeat !== undefined ? repeat : current.repeat_interval;
      const newIsDone = isDone !== undefined ? isDone : current.is_done;

      const newDate = date !== undefined ? date : current.task_date;
      const newTime = time !== undefined ? time : current.task_time;

      let parsedDueAt = current.due_at;
      if (date !== undefined || time !== undefined) {
        parsedDueAt = new Date(`${newDate}T${newTime || '00:00'}`);
      }

      const updateSql = `
        UPDATE tasks 
        SET title = $1, task_type = $2, notes = $3, remind = $4, repeat_interval = $5,
            is_done = $6, task_date = $7, task_time = $8, due_at = $9
        WHERE id = $10
        RETURNING *
      `;
      const { rows } = await db.query(updateSql, [
        newTitle, newType, newNotes, newRemind, newRepeat, newIsDone, newDate, newTime, parsedDueAt, taskId
      ]);

      return { success: true, task: rows[0] };
    } catch (err) {
      return { error: 'Failed to update task: ' + err.message };
    }
  },

  deleteCalendarTask: async ({ taskId }, { userId, role }) => {
    try {
      if (!userId) {
        return { error: 'Authentication required to delete tasks.' };
      }

      const isAdmin = role === 'admin';
      let deleteSql = 'DELETE FROM tasks WHERE id = $1';
      let params = [taskId];

      if (!isAdmin) {
        deleteSql += ' AND user_id = $2';
        params.push(userId);
      }

      const { rowCount } = await db.query(deleteSql, params);
      if (rowCount === 0) {
        return { error: 'Task not found or unauthorized.' };
      }

      return { success: true, message: 'Task deleted successfully.' };
    } catch (err) {
      return { error: 'Failed to delete task: ' + err.message };
    }
  },

  searchCalendarTask: async ({ title, date, includeDone = false }, { userId, role }) => {
    try {
      if (!userId) {
        return { error: 'Authentication required to search tasks.' };
      }

      const isAdmin = role === 'admin';
      const conditions = [];
      const params = [];

      if (!isAdmin) {
        params.push(userId);
        conditions.push(`user_id = $${params.length}`);
      }

      if (!includeDone) {
        conditions.push('is_done = false');
      }

      if (title) {
        params.push(`%${title.trim()}%`);
        conditions.push(`title ILIKE $${params.length}`);
      }

      if (date) {
        params.push(date);
        conditions.push(`task_date = $${params.length}`);
      }

      const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
      const { rows } = await db.query(
        `SELECT id, title, task_date, task_time, task_type, notes, remind, repeat_interval, is_done, due_at
         FROM tasks
         ${where}
         ORDER BY due_at ASC
         LIMIT 10`,
        params
      );

      return { success: true, tasks: rows, count: rows.length };
    } catch (err) {
      return { error: 'Failed to search tasks: ' + err.message };
    }
  },

  manageNewsFeed: async ({ action, feedId, name, url, category = 'caribbean', countryCode = 'ALL', isActive }, { userId, role }) => {
    try {
      if (!userId) {
        return { error: 'Authentication required to manage news feeds.' };
      }
      if (role !== 'admin' && role !== 'moderator') {
        return { error: 'Admin or moderator permission required.' };
      }

      if (action === 'create') {
        if (!name || !url) return { error: 'name and url are required for creation.' };
        try {
          new URL(url);
        } catch {
          return { error: 'Invalid URL format.' };
        }

        const { rows } = await db.query(
          `INSERT INTO rss_feeds (name, url, category, country_code, added_by)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [name.trim(), url.trim(), category.toLowerCase(), countryCode.toUpperCase(), userId]
        );

        // Try populating articles from the new feed using rssService if available
        try {
          const { refreshFeed } = require('../services/rssService');
          await refreshFeed(rows[0]);
        } catch (e) {
          console.warn('Failed to immediately refresh feed:', e.message);
        }

        return { success: true, feed: rows[0], message: 'News feed created successfully.' };
      }

      if (action === 'update') {
        if (!feedId) return { error: 'feedId is required for update.' };
        const sets = [];
        const params = [];

        if (name !== undefined) { params.push(name.trim()); sets.push(`name = $${params.length}`); }
        if (url !== undefined) { params.push(url.trim()); sets.push(`url = $${params.length}`); }
        if (category !== undefined) { params.push(category.toLowerCase()); sets.push(`category = $${params.length}`); }
        if (countryCode !== undefined) { params.push(countryCode.toUpperCase()); sets.push(`country_code = $${params.length}`); }
        if (isActive !== undefined) { params.push(Boolean(isActive)); sets.push(`is_active = $${params.length}`); }

        if (!sets.length) return { error: 'No fields to update.' };

        params.push(parseInt(feedId, 10));
        const { rows } = await db.query(
          `UPDATE rss_feeds SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
          params
        );
        if (!rows.length) return { error: 'News feed not found.' };

        return { success: true, feed: rows[0], message: 'News feed updated successfully.' };
      }

      if (action === 'delete') {
        if (!feedId) return { error: 'feedId is required for deletion.' };
        // Soft delete
        const { rows } = await db.query(
          'UPDATE rss_feeds SET is_active = false WHERE id = $1 RETURNING id',
          [parseInt(feedId, 10)]
        );
        if (!rows.length) return { error: 'News feed not found.' };

        return { success: true, feedId: rows[0].id, message: 'News feed deactivated successfully.' };
      }

      return { error: 'Invalid action provided. Must be create, update, or delete.' };
    } catch (err) {
      return { error: 'News feed management failed: ' + err.message };
    }
  },

  translateText: async ({ text, targetLang, sourceLang = 'en' }) => {
    try {
      if (!text || !targetLang) {
        return { error: 'text and targetLang are required.' };
      }
      if (targetLang === sourceLang) return { success: true, translatedText: text };

      const response = await fetch('http://127.0.0.1:5100/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: text, source: sourceLang, target: targetLang, format: 'text' })
      });
      const data = await response.json();
      if (data.translatedText) {
        return { success: true, translatedText: data.translatedText };
      }
      return { success: false, translatedText: text, error: data.error || 'Translation engine returned empty response.' };
    } catch (err) {
      return { error: 'Translation failed: ' + err.message };
    }
  },

  getReviews: async ({ listingId }, { countryCode }) => {
    try {
      const { rows } = await db.query(
        `SELECT r.*, u.full_name AS reviewer_name
         FROM reviews r JOIN users u ON u.id = r.reviewer_id
         WHERE r.listing_id = $1 AND r.country_code = $2
         ORDER BY r.created_at DESC`,
        [listingId, countryCode]
      );
      return { success: true, reviews: rows };
    } catch (err) {
      return { error: 'Failed to fetch reviews: ' + err.message };
    }
  },

  getRecommendations: async ({ userId: inputUserId }, { userId, countryCode }) => {
    const targetUserId = inputUserId || userId;
    if (!targetUserId) return { error: 'userId is required' };

    let categories = [];
    try {
      const jobsRes = await db.query(
        `SELECT l.category, MAX(t.created_at) AS latest
         FROM transactions t
         JOIN listings l ON l.user_id = t.provider_id AND l.is_active = true
         WHERE t.customer_id = $1 AND t.is_verified = true
         GROUP BY l.category
         ORDER BY latest DESC
         LIMIT 5`,
        [targetUserId]
      );

      const enqRes = await db.query(
        `SELECT l.category, MAX(e.created_at) AS latest
         FROM enquiries e
         JOIN listings l ON l.id = e.listing_id
         WHERE e.customer_id = $1
         GROUP BY l.category
         ORDER BY latest DESC
         LIMIT 5`,
        [targetUserId]
      );

      categories = [...new Set([
        ...jobsRes.rows.map(r => r.category),
        ...enqRes.rows.map(r => r.category)
      ])].filter(Boolean);
    } catch (err) {
      console.error('getRecommendations: Failed to fetch history:', err.message);
    }

    let personalized = [];
    if (categories.length > 0) {
      try {
        const personalRes = await db.query(
          `SELECT l.id, l.business_name, l.category, l.description, u.full_name AS provider_name
           FROM listings l
           JOIN users u ON u.id = l.user_id
           WHERE l.category = ANY($1) AND l.is_active = true AND l.country_code = $2
           LIMIT 5`,
          [categories, countryCode]
        );
        personalized = personalRes.rows.map(item => ({
          id: item.id,
          business_name: item.business_name,
          category: item.category,
          description: item.description,
          provider_name: item.provider_name,
          reason: `Matches your interest in ${item.category}`
        }));
      } catch (err) {
        console.error('getRecommendations: Failed to fetch personalized:', err.message);
      }
    }

    let trending = [];
    try {
      const trendingRes = await db.query(
        `SELECT l.id, l.business_name, l.category, l.description, u.full_name AS provider_name,
                COALESCE(avg_rating.avg, 0) AS rating, COALESCE(enq_count.cnt, 0) AS enquiries
         FROM listings l
         JOIN users u ON u.id = l.user_id
         LEFT JOIN (
           SELECT listing_id, AVG(rating) AS avg
           FROM reviews
           WHERE created_at >= NOW() - INTERVAL '30 days'
           GROUP BY listing_id
         ) avg_rating ON avg_rating.listing_id = l.id
         LEFT JOIN (
           SELECT listing_id, COUNT(*) AS cnt
           FROM enquiries
           WHERE created_at >= NOW() - INTERVAL '30 days'
           GROUP BY listing_id
         ) enq_count ON enq_count.listing_id = l.id
         WHERE l.is_active = true AND l.country_code = $1
         ORDER BY rating DESC, enquiries DESC
         LIMIT 5`,
        [countryCode]
      );

      const countryName = countryCode === 'VC' ? 'St. Vincent' : countryCode === 'SLU' ? 'St. Lucia' : countryCode === 'BRB' ? 'Barbados' : countryCode === 'GRD' ? 'Grenada' : countryCode;
      trending = trendingRes.rows.map(item => ({
        id: item.id,
        business_name: item.business_name,
        category: item.category,
        description: item.description,
        provider_name: item.provider_name,
        reason: `Trending in ${countryName}`
      }));
    } catch (err) {
      console.error('getRecommendations: Failed to fetch trending:', err.message);
    }

    const recommendations = [];
    const seenIds = new Set();

    for (const item of personalized) {
      if (!seenIds.has(item.id)) {
        seenIds.add(item.id);
        recommendations.push(item);
        if (recommendations.length >= 5) break;
      }
    }

    if (recommendations.length < 5) {
      for (const item of trending) {
        if (!seenIds.has(item.id)) {
          seenIds.add(item.id);
          recommendations.push(item);
          if (recommendations.length >= 5) break;
        }
      }
    }

    return { success: true, recommendations };
  },

  proposeSlots: async ({ providerId }, { userId, countryCode }) => {
    try {
      const { rows } = await db.query(
        `SELECT appointment_at
         FROM appointments
         WHERE provider_id = $1
           AND status IN ('scheduled', 'confirmed', 'pending_approval')
           AND appointment_at BETWEEN LOCALTIMESTAMP AND LOCALTIMESTAMP + INTERVAL '7 days'
         ORDER BY appointment_at ASC`,
        [providerId]
      );

      const bookings = rows.map(r => new Date(r.appointment_at));
      const slots = [];
      const startDay = new Date();
      
      for (let d = 0; d < 7; d++) {
        const currentDay = new Date(startDay);
        currentDay.setDate(startDay.getDate() + d);
        
        for (let hour = 9; hour < 17; hour++) {
          const slotTime = new Date(currentDay);
          slotTime.setHours(hour, 0, 0, 0);

          if (slotTime <= new Date()) continue;

          const conflict = bookings.some(b => {
            const diffMs = Math.abs(b.getTime() - slotTime.getTime());
            return diffMs < 60 * 60 * 1000;
          });

          if (!conflict) {
            const pad = (n) => String(n).padStart(2, '0');
            const formatted = `${slotTime.getFullYear()}-${pad(slotTime.getMonth() + 1)}-${pad(slotTime.getDate())}T${pad(slotTime.getHours())}:00:00`;
            slots.push(formatted);
            if (slots.length >= 3) break;
          }
        }
        if (slots.length >= 3) break;
      }

      if (slots.length === 0) {
        return { success: true, slots: [], message: 'The provider is fully booked for the upcoming week.' };
      }

      return { success: true, slots };
    } catch (err) {
      return { error: 'Failed to propose slots: ' + err.message };
    }
  },

  initiateBooking: async ({ providerId, startTime, title }, { userId, countryCode }) => {
    try {
      const { rows } = await db.query(
        `INSERT INTO appointments (country_code, customer_id, provider_id, listing_id, title, appointment_at, reminder_minutes_before, status, created_via)
         VALUES ($1, $2, $3, null, $4, $5::timestamp, 60, 'pending_approval', 'ai_scheduler')
         RETURNING id, TO_CHAR(appointment_at, 'YYYY-MM-DD HH24:MI') AS appointment_at`,
        [countryCode, userId, providerId, title, startTime]
      );

      try {
        const customerRow = await db.query('SELECT full_name FROM users WHERE id = $1', [userId]);
        const customerName = customerRow.rows[0]?.full_name || 'A customer';
        const { notify } = require('../services/notificationService');
        await notify(providerId, 'appointment_pending', '📅 New Appointment Proposal', `${customerName} proposed an appointment for "${title}" on ${rows[0].appointment_at}.`, { url: '/dashboard' });
      } catch (notifyErr) {
        console.error('initiateBooking: Notification failed:', notifyErr.message);
      }

      return { success: true, appointment_id: rows[0].id, appointment_at: rows[0].appointment_at, status: 'PENDING_PROVIDER_APPROVAL' };
    } catch (err) {
      return { error: 'Failed to initiate booking: ' + err.message };
    }
  },

  confirmBooking: async ({ appointmentId }, { userId, role }) => {
    try {
      const check = await db.query(
        `SELECT id, provider_id, customer_id, title, TO_CHAR(appointment_at, 'YYYY-MM-DD HH24:MI') AS appointment_at 
         FROM appointments WHERE id = $1`,
        [appointmentId]
      );
      if (!check.rows.length) return { error: 'Appointment not found' };
      
      if (check.rows[0].provider_id !== userId && role !== 'admin') {
        return { error: 'Forbidden: you are not the provider for this appointment' };
      }

      await db.query(
        `UPDATE appointments SET status = 'scheduled', updated_at = NOW() WHERE id = $1`,
        [appointmentId]
      );

      try {
        const { notify } = require('../services/notificationService');
        const { rows: providerRow } = await db.query('SELECT full_name FROM users WHERE id = $1', [check.rows[0].provider_id]);
        const providerName = providerRow[0]?.full_name || 'Provider';
        const apptTime = check.rows[0].appointment_at;

        notify(check.rows[0].customer_id, 'appointment_confirmed', '✅ Appointment Confirmed', `${providerName} confirmed your appointment for "${check.rows[0].title}" on ${apptTime}.`, { url: '/dashboard' }).catch(() => {});
        notify(check.rows[0].provider_id, 'appointment_confirmed', '✅ Appointment Confirmed', `You have confirmed the appointment for "${check.rows[0].title}" on ${apptTime}.`, { url: '/dashboard' }).catch(() => {});
      } catch (notifyErr) {
        console.error('confirmBooking: Notification failed:', notifyErr.message);
      }

      return { success: true, status: 'CONFIRMED', appointment_id: appointmentId };
    } catch (err) {
      return { error: 'Failed to confirm booking: ' + err.message };
    }
  },

  msme_credit_export: async ({ provider_id }, { role }) => {
    if (role !== 'admin' && role !== 'partner') {
      return { error: 'Admin or lender-partner permission required.' };
    }
    try {
      const [txRes, apptRes, revRes, provRes] = await Promise.all([
        db.query(`
          SELECT COUNT(*) FILTER (WHERE is_verified = true) AS verified_count,
                 COUNT(*)                                    AS total_count,
                 COALESCE(SUM(amount) FILTER (WHERE is_verified = true), 0) AS total_volume,
                 COALESCE(AVG(amount) FILTER (WHERE is_verified = true), 0) AS avg_ticket,
                 MIN(created_at) FILTER (WHERE is_verified = true) AS first_tx,
                 MAX(created_at) FILTER (WHERE is_verified = true) AS last_tx
          FROM transactions WHERE provider_id = $1`, [provider_id]),
        db.query(`SELECT COUNT(*) AS engagements FROM appointments
          WHERE provider_id = $1 AND status IN ('scheduled','confirmed','pending_approval','completed')`,
          [provider_id]),
        db.query(`SELECT COUNT(*) AS review_count, COALESCE(AVG(r.rating),0) AS avg_rating,
                         COUNT(*) FILTER (WHERE r.rating >= 4) AS positive_count
                  FROM reviews r JOIN listings l ON l.id = r.listing_id WHERE l.user_id = $1`,
          [provider_id]),
        db.query(`SELECT u.full_name, u.created_at AS member_since, l.business_name, l.category
                  FROM users u LEFT JOIN listings l ON l.user_id = u.id AND l.is_active = true
                  WHERE u.id = $1 LIMIT 1`, [provider_id]),
      ]);

      if (!provRes.rows.length) return { error: 'Provider not found.' };
      const prov = provRes.rows[0];
      const tx   = txRes.rows[0];
      const rev  = revRes.rows[0];

      const verifiedCount = parseInt(tx.verified_count, 10) || 0;
      const totalCount    = parseInt(tx.total_count,    10) || 0;
      const totalVolume   = parseFloat(tx.total_volume)      || 0;
      const avgTicket     = parseFloat(tx.avg_ticket)         || 0;
      const avgRating     = parseFloat(rev.avg_rating)        || 0;
      const reviewCount   = parseInt(rev.review_count,  10) || 0;
      const successRate   = totalCount > 0 ? Math.round((verifiedCount / totalCount) * 100) : 0;
      const tenureDays    = prov.member_since
        ? Math.floor((Date.now() - new Date(prov.member_since).getTime()) / 86_400_000) : 0;

      return {
        success: true,
        MSME_Credit_Profile: {
          generated_at: new Date().toISOString(),
          provider: { id: provider_id, name: prov.full_name, business: prov.business_name, category: prov.category },
          financial_metrics: {
            total_volume:    `XCD $${totalVolume.toFixed(2)}`,
            job_count:       verifiedCount,
            avg_ticket_size: `XCD $${avgTicket.toFixed(2)}`,
            success_rate:    `${successRate}%`,
          },
          reputation: { avg_rating: avgRating.toFixed(2), total_reviews: reviewCount },
          creditworthiness: {
            tenure_days: tenureDays,
            consistent_activity: verifiedCount >= 5,
            strong_reputation: avgRating >= 4.0,
          },
          lender_summary: `${prov.business_name || prov.full_name} — ${tenureDays} days on platform, ` +
            `${verifiedCount} verified jobs, XCD $${totalVolume.toFixed(2)} total revenue, ` +
            `${avgRating.toFixed(1)}/5 rating (${reviewCount} reviews), ${successRate}% success rate.`,
        },
      };
    } catch (err) {
      return { error: 'Credit export failed: ' + err.message };
    }
  },

  admin_get_expansion_config: async (_args, { role }) => {
    if (role !== 'admin') return { error: 'Admin permission required.' };
    const { rows } = await db.query(
      'SELECT code, domain_slug, display_name, is_live, currency, flag FROM countries ORDER BY is_live DESC, code ASC'
    );
    const live    = rows.filter(r => r.is_live).map(r => r.display_name);
    const offline = rows.filter(r => !r.is_live).map(r => r.display_name);
    return { success: true, countries: rows, summary: { live, offline } };
  },

  admin_set_island_status: async ({ code, is_live }, { userId, role }) => {
    if (role !== 'admin') return { error: 'Admin permission required.' };
    const upper = (code || '').toUpperCase();
    if (upper === 'SVG') return { error: 'SVG is permanently live — flagship protection is active.' };
    const { REGISTRY, invalidateMarketCache } = require('./countries');
    if (!REGISTRY[upper]) return { error: `Unknown country code: ${upper}` };
    const { rows } = await db.query(
      'UPDATE countries SET is_live = $1, updated_at = NOW() WHERE code = $2 RETURNING display_name, domain_slug',
      [is_live, upper]
    );
    if (!rows.length) return { error: 'Country not found in expansion table.' };
    invalidateMarketCache();
    return { success: true, code: upper, name: rows[0].display_name, domainSlug: rows[0].domain_slug, is_live, message: `${rows[0].display_name} is now ${is_live ? 'LIVE 🚀' : 'OFFLINE'}.` };
  },

  admin_toggle_market: async ({ countryCode, isLive }, { userId, role }) => {
    if (role !== 'admin') return { error: 'Admin permission required.' };
    const upper = (countryCode || '').toUpperCase();
    if (upper === 'SVG') return { error: 'SVG is permanently live — flagship protection is active.' };
    const { REGISTRY, invalidateMarketCache } = require('./countries');
    if (!REGISTRY[upper]) return { error: `Unknown country code: ${upper}` };
    const { rows } = await db.query(
      'UPDATE countries SET is_live = $1, updated_at = NOW() WHERE code = $2 RETURNING display_name, domain_slug',
      [isLive, upper]
    );
    if (!rows.length) return { error: 'Country not found in expansion table.' };
    invalidateMarketCache();
    return { success: true, countryCode: upper, isLive, message: `${rows[0].display_name} is now ${isLive ? 'LIVE 🚀' : 'OFFLINE'}.` };
  },

  autoListService: async ({ imageUrl, providerId, listingId }, { userId, role, countryCode }) => {
    const targetUserId = providerId || userId;
    if (role !== 'provider' && role !== 'admin') return { error: 'Only providers can list services' };

    try {
      const fs = require('fs');
      const { v4: uuidv4 } = require('uuid');
      const { analyzeProductImage } = require('../services/geminiService');
      const { processItemImage } = require('../services/imageProcessor');
      const { uploadBuffer } = require('../services/storage');

      const filename = imageUrl.split('/').pop();
      const filepath = '/tmp/agent-uploads/' + filename;

      if (!fs.existsSync(filepath)) {
        return { error: 'Image file not found: ' + filename };
      }

      const imageBuffer = fs.readFileSync(filepath);
      const base64Image = imageBuffer.toString('base64');
      const mimeType = filename.endsWith('.png') ? 'image/png' : filename.endsWith('.webp') ? 'image/webp' : 'image/jpeg';

      const result = await analyzeProductImage(base64Image, mimeType);
      const confidence = result.confidence_score !== undefined ? result.confidence_score : 85;

      if (confidence < 80) {
        return {
          success: false,
          confidence_score: confidence,
          name: result.name,
          price: result.suggested_price,
          category: result.category,
          description: result.description,
          message: 'AI confidence score is below 80%. Please confirm or provide details manually.',
          needs_confirmation: true
        };
      }

      let listing_id = listingId || null;
      if (!listing_id) {
        const listingResult = await db.query(
          'SELECT id FROM listings WHERE user_id = $1 AND is_active = true LIMIT 1',
          [targetUserId]
        );
        listing_id = listingResult.rows[0]?.id;
      }

      if (!listing_id) {
        return { error: 'No active listing found — product not saved' };
      }

      const productId = uuidv4();
      await db.query(
        `INSERT INTO business_products (id, listing_id, country_code, name, description, price, currency, category, in_stock)
         VALUES ($1, $2, $3, $4, $5, $6, 'XCD', $7, true)`,
        [productId, listing_id, countryCode, result.name, result.description ?? null, result.suggested_price ?? null, result.category ?? null]
      );

      // Attach image
      if (imageUrl) {
        try {
          const { thumb, optimized } = await processItemImage(imageBuffer);
          const [thumbRes, imgRes] = await Promise.all([
            uploadBuffer(thumb,     `products/${listing_id}/thumbs`, '.webp', 'image/webp'),
            uploadBuffer(optimized, `products/${listing_id}/full`,   '.webp', 'image/webp'),
          ]);
          await db.query(
            'UPDATE business_products SET image_url = $1, thumb_url = $2, updated_at = NOW() WHERE id = $3',
            [imgRes.url, thumbRes.url, productId]
          );
        } catch (imgErr) {
          console.error('autoListService image upload failed:', imgErr.message);
          await db.query(
            'UPDATE business_products SET image_url = $1, updated_at = NOW() WHERE id = $2',
            [imageUrl, productId]
          );
        }
      }

      return {
        success: true,
        product_id: productId,
        name: result.name,
        price: result.suggested_price,
        category: result.category,
        description: result.description,
        confidence_score: confidence,
        message: 'Product listed successfully from image analysis'
      };
    } catch (err) {
      console.error('autoListService error:', err.message);
      return { error: 'Auto listing failed: ' + err.message };
    }
  },

  log_offplatform_transaction: async ({ customerName, amount, description, contactInfo }, { userId, countryCode }) => {
    try {
      if (!userId) return { error: 'Authentication required. Please log in as a provider.' };

      const userRes = await db.query(
        `SELECT role, full_name FROM users WHERE id = $1 LIMIT 1`,
        [userId]
      );
      if (!userRes.rows.length) return { error: 'User not found.' };
      const { role, full_name } = userRes.rows[0];
      if (role !== 'provider') return { error: 'Only providers can log off-platform transactions.' };

      const parsedAmount = parseFloat(amount);
      if (isNaN(parsedAmount) || parsedAmount <= 0) return { error: 'amount must be a positive number.' };

      const { v4: uuid } = require('uuid');
      const generateReceiptPdf = require('../utils/generateReceiptPdf');
      const { awardPointsForTransaction } = require('../services/pointsService');

      const transactionId = uuid();
      const receiptNumber = `MAN-${Date.now()}`;
      const cc = countryCode || 'SVG';

      await db.query(
        `INSERT INTO transactions
           (id, country_code, provider_id, amount, is_verified,
            provider_confirmed, customer_confirmed,
            verification_method, source,
            guest_customer_name, guest_customer_email,
            job_notes, created_at)
         VALUES ($1,$2,$3,$4,true,true,true,'manual_verified','manual_verified',$5,$6,$7,NOW())`,
        [transactionId, cc, userId, parsedAmount,
         customerName, contactInfo || null, description]
      );

      await db.query(
        `UPDATE users SET verified_transaction_count = COALESCE(verified_transaction_count, 0) + 1 WHERE id = $1`,
        [userId]
      );

      await awardPointsForTransaction(transactionId, userId, null, cc);

      await generateReceiptPdf({
        receipt_number: receiptNumber,
        issued_by:      full_name || 'Provider',
        issued_to:      customerName,
        date:           new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
        description,
        amount:         parsedAmount.toFixed(2),
        currency:       'XCD',
        status:         'PAID',
      });

      const receiptUrl = `/api/ai/receipt/pdf/${receiptNumber}`;
      await db.query(
        `UPDATE transactions SET receipt_doc_url = $1 WHERE id = $2`,
        [receiptUrl, transactionId]
      );

      // Track in provider_documents so it appears on the Documents page
      await db.query(
        `INSERT INTO provider_documents (user_id, type, label, download_url, meta)
         VALUES ($1, 'receipt', $2, $3, $4)`,
        [userId,
         `Receipt — ${customerName} (XCD $${parsedAmount.toFixed(2)})`,
         receiptUrl,
         JSON.stringify({ customer_name: customerName, amount: parsedAmount, transaction_id: transactionId })]
      ).catch(() => {});

      return {
        success:             true,
        transaction_id:      transactionId,
        receipt_number:      receiptNumber,
        receipt_url:         receiptUrl,
        amount:              parsedAmount,
        currency:            'XCD',
        trust_score_updated: true,
        message:             `Transaction of XCD $${parsedAmount.toFixed(2)} recorded for ${customerName}. Your Trust Score has been updated. Receipt: ${receiptUrl}`,
      };
    } catch (err) {
      console.error('log_offplatform_transaction error:', err.message);
      return { error: 'Failed to log transaction: ' + err.message };
    }
  }
};

module.exports = {
  CLAUDE_TOOL_SCHEMAS,
  CLAUDE_TOOL_EXECUTORS
};
