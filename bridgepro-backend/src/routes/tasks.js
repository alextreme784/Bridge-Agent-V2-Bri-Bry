const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

// GET /tasks - Get list of tasks
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const countryCode = req.countryCode || 'SVG';

    const sql = `
      SELECT id, user_id, country_code, title, due_at, is_done, notified, 
             task_type, notes, remind, repeat_interval, task_date, task_time, created_at
      FROM tasks
      WHERE country_code = $1
      ${isAdmin ? '' : 'AND user_id = $2'}
      ORDER BY due_at ASC
    `;
    const params = isAdmin ? [countryCode] : [countryCode, req.user.id];
    const { rows } = await db.query(sql, params);

    // Map database fields to the frontend expected names
    const tasks = rows.map(t => {
      let dateVal = t.task_date;
      let timeVal = t.task_time;
      if (!dateVal && t.due_at) {
        const dt = new Date(t.due_at);
        const year = dt.getUTCFullYear();
        const month = String(dt.getUTCMonth() + 1).padStart(2, '0');
        const day = String(dt.getUTCDate()).padStart(2, '0');
        dateVal = `${year}-${month}-${day}`;
        const hours = String(dt.getUTCHours()).padStart(2, '0');
        const minutes = String(dt.getUTCMinutes()).padStart(2, '0');
        timeVal = `${hours}:${minutes}`;
      }
      return {
        id: t.id,
        type: t.task_type || 'Event',
        title: t.title,
        date: dateVal,
        time: timeVal || '',
        notes: t.notes || '',
        remind: t.remind,
        repeat: t.repeat_interval || 'none',
        notified: t.notified,
        is_done: t.is_done,
        due_at: t.due_at,
        user_id: t.user_id
      };
    });

    res.json({ success: true, tasks });
  } catch (err) {
    next(err);
  }
});

// POST /tasks - Create a new task
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { title, date, time = '', type = 'Event', notes = '', remind = 30, repeat = 'none', due_at } = req.body;
    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }

    const countryCode = req.countryCode || 'SVG';
    const userId = req.user.id;

    // Calculate due_at timestamp
    let parsedDueAt;
    if (due_at) {
      parsedDueAt = new Date(due_at);
    } else if (date) {
      parsedDueAt = new Date(`${date}T${time || '00:00'}`);
    } else {
      parsedDueAt = new Date();
    }

    if (isNaN(parsedDueAt.getTime())) {
      return res.status(400).json({ error: 'Invalid date/time provided' });
    }

    const year = parsedDueAt.getUTCFullYear();
    const month = String(parsedDueAt.getUTCMonth() + 1).padStart(2, '0');
    const day = String(parsedDueAt.getUTCDate()).padStart(2, '0');
    const dateStr = date || `${year}-${month}-${day}`;
    const hours = String(parsedDueAt.getUTCHours()).padStart(2, '0');
    const minutes = String(parsedDueAt.getUTCMinutes()).padStart(2, '0');
    const timeStr = time || `${hours}:${minutes}`;

    const id = uuidv4();
    const { rows } = await db.query(
      `INSERT INTO tasks (id, user_id, country_code, title, due_at, is_done, notified, task_type, notes, remind, repeat_interval, task_date, task_time)
       VALUES ($1, $2, $3, $4, $5, false, false, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [id, userId, countryCode, title.trim(), parsedDueAt, type, notes, remind, repeat, dateStr, timeStr]
    );

    const t = rows[0];
    res.json({
      success: true,
      task: {
        id: t.id,
        type: t.task_type,
        title: t.title,
        date: t.task_date,
        time: t.task_time,
        notes: t.notes,
        remind: t.remind,
        repeat: t.repeat_interval,
        notified: t.notified,
        is_done: t.is_done,
        due_at: t.due_at
      }
    });
  } catch (err) {
    next(err);
  }
});

// PUT /tasks/:id - Update a task (e.g. marking it as done or changing details)
router.put('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, date, time, type, notes, remind, repeat, is_done, notified } = req.body;
    const isAdmin = req.user.role === 'admin';

    // Verify task ownership
    const checkSql = 'SELECT * FROM tasks WHERE id = $1' + (isAdmin ? '' : ' AND user_id = $2');
    const checkParams = isAdmin ? [id] : [id, req.user.id];
    const { rows } = await db.query(checkSql, checkParams);

    if (!rows.length) {
      return res.status(404).json({ error: 'Task not found or unauthorized' });
    }

    const current = rows[0];

    const newTitle = title !== undefined ? title : current.title;
    const newType = type !== undefined ? type : current.task_type;
    const newNotes = notes !== undefined ? notes : current.notes;
    const newRemind = remind !== undefined ? remind : current.remind;
    const newRepeat = repeat !== undefined ? repeat : current.repeat_interval;
    const newIsDone = is_done !== undefined ? is_done : current.is_done;
    const newNotified = notified !== undefined ? notified : current.notified;

    const newDate = date !== undefined ? date : current.task_date;
    const newTime = time !== undefined ? time : current.task_time;

    let parsedDueAt = current.due_at;
    if (date !== undefined || time !== undefined) {
      parsedDueAt = new Date(`${newDate}T${newTime || '00:00'}`);
    }

    const updateSql = `
      UPDATE tasks 
      SET title = $1, task_type = $2, notes = $3, remind = $4, repeat_interval = $5,
          is_done = $6, notified = $7, task_date = $8, task_time = $9, due_at = $10
      WHERE id = $11
      RETURNING *
    `;
    const { rows: updatedRows } = await db.query(updateSql, [
      newTitle, newType, newNotes, newRemind, newRepeat, newIsDone, newNotified, newDate, newTime, parsedDueAt, id
    ]);

    const t = updatedRows[0];
    res.json({
      success: true,
      task: {
        id: t.id,
        type: t.task_type,
        title: t.title,
        date: t.task_date,
        time: t.task_time,
        notes: t.notes,
        remind: t.remind,
        repeat: t.repeat_interval,
        notified: t.notified,
        is_done: t.is_done,
        due_at: t.due_at
      }
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /tasks/:id - Delete a task
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const isAdmin = req.user.role === 'admin';

    let sql = 'DELETE FROM tasks WHERE id = $1';
    let params = [id];

    if (!isAdmin) {
      sql += ' AND user_id = $2';
      params.push(req.user.id);
    }

    const { rowCount } = await db.query(sql, params);
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Task not found or unauthorized' });
    }

    res.json({ success: true, message: 'Task deleted successfully' });
  } catch (err) {
    next(err);
  }
});

// POST /tasks/:id/snooze - Snooze a task reminder by X minutes (accessible from Service Worker background click)
router.post('/:id/snooze', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { minutes = 10 } = req.body;

    const { rows } = await db.query('SELECT * FROM tasks WHERE id = $1', [id]);
    if (!rows.length) {
      return res.status(404).json({ error: 'Task not found' });
    }
    
    const newDue = new Date(Date.now() + minutes * 60000);
    const year = newDue.getUTCFullYear();
    const month = String(newDue.getUTCMonth() + 1).padStart(2, '0');
    const day = String(newDue.getUTCDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;
    const hours = String(newDue.getUTCHours()).padStart(2, '0');
    const minutesStr = String(newDue.getUTCMinutes()).padStart(2, '0');
    const timeStr = `${hours}:${minutesStr}`;

    await db.query(
      `UPDATE tasks 
       SET due_at = $1, task_date = $2, task_time = $3, notified = false, remind = 0
       WHERE id = $4`,
      [newDue, dateStr, timeStr, id]
    );

    res.json({ success: true, message: `Task snoozed by ${minutes} minutes` });
  } catch (err) {
    next(err);
  }
});

// POST /tasks/:id/dismiss - Dismiss a task reminder (accessible from Service Worker background click)
router.post('/:id/dismiss', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rowCount } = await db.query('UPDATE tasks SET notified = true WHERE id = $1', [id]);
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }
    res.json({ success: true, message: 'Task reminder dismissed' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
