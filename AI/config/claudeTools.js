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
    description: 'Create a scheduled calendar task or voice reminder to follow up on a job or service.',
    input_schema: {
      type: 'object',
      properties: {
        taskDetails: { type: 'string', description: 'The text title/description of the reminder' },
        timestamp: { type: 'string', description: 'Scheduled ISO 8601 timestamp for execution (e.g. 2026-06-19T09:00:00Z)' },
        taskType: { type: 'string', enum: ['Event', 'Reminder', 'Alert', 'Birthday', 'Meeting', 'Health', 'Travel', 'Personal'], description: 'The type category of event' },
        notes: { type: 'string', description: 'Extra details or description' },
        remind: { type: 'integer', description: 'Minutes before to trigger notification reminder' },
        repeat: { type: 'string', enum: ['none', 'daily', 'weekly', 'monthly', 'yearly'], description: 'Repeat interval' }
      },
      required: ['taskDetails', 'timestamp']
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

  createCalendarTask: async ({ taskDetails, timestamp, taskType = 'Event', notes = '', remind = 30, repeat = 'none' }, { userId, countryCode }) => {
    try {
      if (!userId) {
        return { error: 'Authentication required to schedule reminders.' };
      }
      const parsedTime = new Date(timestamp);
      if (isNaN(parsedTime.getTime())) {
        return { error: 'Invalid timestamp format provided.' };
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

      // Format local date/time for the DB cache from timestamp in GMT/UTC to keep sync stable
      const year = parsedTime.getUTCFullYear();
      const month = String(parsedTime.getUTCMonth() + 1).padStart(2, '0');
      const day = String(parsedTime.getUTCDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;
      const hours = String(parsedTime.getUTCHours()).padStart(2, '0');
      const minutes = String(parsedTime.getUTCMinutes()).padStart(2, '0');
      const timeStr = `${hours}:${minutes}`;

      const id = uuidv4();
      const { rows } = await db.query(
        `INSERT INTO tasks (id, user_id, country_code, title, due_at, is_done, notified, task_type, notes, remind, repeat_interval, task_date, task_time)
         VALUES ($1, $2, $3, $4, $5, false, false, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [id, userId, countryCode, taskDetails.trim(), parsedTime, taskType, notes, remind, repeat, dateStr, timeStr]
      );

      return { success: true, task: rows[0] };
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
  }
};

module.exports = {
  CLAUDE_TOOL_SCHEMAS,
  CLAUDE_TOOL_EXECUTORS
};
