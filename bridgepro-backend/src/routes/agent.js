const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { getToolsForRole, getGroqToolsForRole } = require('./agent-tools');
const { sendPush } = require('../services/pushService');
const { analyzeProductImage, analyzeListingImage } = require('../services/geminiService');
const { processItemImage } = require('../services/imageProcessor');
const { uploadBuffer } = require('../services/storage');

const router = express.Router();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// --- Translation helpers ---

const LANG_NAMES = {
  en: 'English', fr: 'French', es: 'Spanish', nl: 'Dutch',
  pt: 'Portuguese', zh: 'Chinese', ko: 'Korean',
  de: 'German', it: 'Italian', ar: 'Arabic', ja: 'Japanese',
};

async function translateText(text, targetLang, sourceLang = 'en') {
  if (!targetLang || targetLang === 'en') return text;
  try {
    const response = await fetch('http://127.0.0.1:5100/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, source: sourceLang, target: targetLang, format: 'text' })
    });
    const data = await response.json();
    return data.translatedText || text;
  } catch (err) {
    console.error('Translation error:', err.message);
    return text;
  }
}

async function detectLanguage(text) {
  try {
    const cleanText = text.replace(/["']/g, '').trim();
    const response = await fetch('http://127.0.0.1:5100/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: cleanText })
    });
    const data = await response.json();
    const detected = data[0]?.language || 'en';
    console.log('LANG DETECT:', cleanText.slice(0, 50), '→', detected);
    return detected;
  } catch (err) {
    return 'en';
  }
}

// --- Tool executor functions ---

async function search_providers({ query, category }, { country_code }) {
  const keywords = query.split(/\s+/).filter(w => w.length > 2);
  if (keywords.length === 0) return [];

  const searchTerms = keywords.map(k => `%${k}%`);

  let sql = `
    SELECT l.id, l.business_name, l.description, l.phone, l.whatsapp, l.service_areas,
           c.name AS category_name
    FROM listings l
    LEFT JOIN categories c ON c.id = l.category_id
    WHERE l.is_active = true
      AND l.country_code = $1
      AND (
        l.business_name ILIKE ANY($2::text[])
        OR l.description ILIKE ANY($2::text[])
      )
  `;
  const params = [country_code, searchTerms];

  if (category) {
    params.push(`%${category}%`);
    sql += ` AND c.name ILIKE $${params.length}`;
  }

  sql += ' ORDER BY l.created_at DESC LIMIT 8';

  const { rows } = await db.query(sql, params);
  return rows;
}

async function send_enquiry({ listing_id, message, conversation_id: inputConvId }, { userId, role }) {
  console.log('AGENT send_enquiry called with:', JSON.stringify({ listing_id, message, conversation_id: inputConvId, userId, role }));
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (listing_id && !uuidRegex.test(listing_id)) {
    return { error: 'Invalid listing ID. Please search for the provider first to get the correct ID.' };
  }
  try {
    let conversation_id;

    if (inputConvId) {
      const convCheck = await db.query(
        `SELECT id FROM bc_conversations WHERE id = $1 AND (customer_id = $2 OR provider_id = $2)`,
        [inputConvId, userId]
      );
      if (convCheck.rows.length === 0) return { error: 'Conversation not found or not authorised' };
      conversation_id = inputConvId;
      console.log('AGENT using provided conversation_id:', conversation_id);
    } else {
      const listingRes = await db.query('SELECT user_id FROM listings WHERE id = $1', [listing_id]);
      if (!listingRes.rows.length) return { error: 'Listing not found' };
      const provider_id = listingRes.rows[0].user_id;
      console.log('AGENT listing found:', { listing_id, provider_id });

      const existing = await db.query(
        'SELECT id FROM bc_conversations WHERE listing_id = $1 AND customer_id = $2',
        [listing_id, userId]
      );

      if (existing.rows.length) {
        conversation_id = existing.rows[0].id;
        console.log('AGENT existing conversation found:', conversation_id);
      } else {
        const convResult = await db.query(
          `INSERT INTO bc_conversations (listing_id, customer_id, provider_id, status)
           VALUES ($1, $2, $3, 'open')
           RETURNING id`,
          [listing_id, userId, provider_id]
        );
        conversation_id = convResult.rows[0].id;
        console.log('AGENT conversation created:', conversation_id);
      }
    }

    await db.query(
      `INSERT INTO bc_messages (conversation_id, sender_id, body, message_type)
       VALUES ($1, $2, $3, 'text')`,
      [conversation_id, userId, message]
    );
    console.log('AGENT message sent to conversation:', conversation_id);

    try {
      let notifyUserId = null;

      if (conversation_id) {
        const conv = await db.query(
          'SELECT customer_id, provider_id FROM bc_conversations WHERE id = $1',
          [parseInt(conversation_id)]
        );
        if (conv.rows[0]) {
          const isCustomer = userId === conv.rows[0].customer_id;
          notifyUserId = isCustomer ? conv.rows[0].provider_id : conv.rows[0].customer_id;
        }
      } else if (listing_id) {
        const listing = await db.query(
          'SELECT user_id FROM listings WHERE id = $1',
          [listing_id]
        );
        notifyUserId = listing.rows[0]?.user_id;
      }

      if (notifyUserId && notifyUserId !== userId) {
        console.log('PUSH: notifying user:', notifyUserId);
        await sendPush(notifyUserId, 'New Message on BridgePro 💬', message.slice(0, 100), { url: '/connect' });
        console.log('PUSH: notification sent successfully');
      }
    } catch(e) { console.error('PUSH ERROR:', e.message); }

    return { success: true, conversation_id };
  } catch (err) {
    console.error('AGENT send_enquiry ERROR:', err.message, err.stack);
    return { error: err.message };
  }
}

async function get_my_enquiries(_input, { userId, role }) {
  if (role === 'admin') {
    const { rows } = await db.query(
      `SELECT bc.id AS conversation_id, COALESCE(l.business_name, jl.title, 'Bridge Connect Conversation') AS business_name, u.full_name AS customer_name, bc.status, bc.created_at,
              (SELECT body FROM bc_messages WHERE conversation_id = bc.id ORDER BY created_at DESC LIMIT 1) AS last_message
       FROM bc_conversations bc
       LEFT JOIN listings l ON l.id = bc.listing_id
       LEFT JOIN job_listings jl ON jl.id = bc.job_id
       LEFT JOIN users u ON u.id = bc.customer_id
       ORDER BY bc.created_at DESC LIMIT 20`
    );
    return rows;
  }
  const { rows } = await db.query(
    `SELECT bc.id AS conversation_id, COALESCE(l.business_name, jl.title, 'Bridge Connect Conversation') AS business_name, bc.created_at,
            (SELECT body FROM bc_messages
             WHERE conversation_id = bc.id
             ORDER BY created_at DESC LIMIT 1) AS last_message
     FROM bc_conversations bc
     LEFT JOIN listings l ON l.id = bc.listing_id
     LEFT JOIN job_listings jl ON jl.id = bc.job_id
     WHERE bc.customer_id = $1
     ORDER BY bc.created_at DESC
     LIMIT 10`,
    [userId]
  );
  return rows;
}

async function get_my_listings(_input, { userId, role }) {
  if (role === 'admin') {
    const { rows } = await db.query(
      `SELECT l.id, l.business_name, l.is_active, l.created_at, u.full_name AS owner_name,
              c.name AS category_name
       FROM listings l
       LEFT JOIN categories c ON c.id = l.category_id
       LEFT JOIN users u ON u.id = l.user_id
       ORDER BY l.created_at DESC LIMIT 50`
    );
    return rows;
  }
  if (role !== 'provider') return { error: 'Only providers can view their listings' };
  const { rows } = await db.query(
    `SELECT l.id, l.business_name, l.is_active, l.created_at,
            c.name AS category_name
     FROM listings l
     LEFT JOIN categories c ON c.id = l.category_id
     WHERE l.user_id = $1
     ORDER BY l.created_at DESC`,
    [userId]
  );
  return rows;
}

async function respond_to_enquiry({ enquiry_id: rawId, message }, { userId, role }) {
  const enquiry_id = parseInt(rawId, 10);

  if (role !== 'admin') {
    const check = await db.query(
      `SELECT id FROM bc_conversations
       WHERE id = $1 AND (customer_id = $2 OR provider_id = $2)`,
      [enquiry_id, userId]
    );
    if (check.rows.length === 0) return { error: 'Conversation not found or not authorised' };
  } else {
    const check = await db.query(`SELECT id FROM bc_conversations WHERE id = $1`, [enquiry_id]);
    if (check.rows.length === 0) return { error: 'Conversation not found' };
  }

  await db.query(
    `INSERT INTO bc_messages (conversation_id, sender_id, body, message_type)
     VALUES ($1, $2, $3, 'text')`,
    [enquiry_id, userId, message]
  );

  try {
    console.log('PUSH: attempting to notify customer for conversation:', enquiry_id);
    const conv = await db.query('SELECT customer_id FROM bc_conversations WHERE id = $1', [enquiry_id]);
    console.log('PUSH: customer user_id:', conv.rows[0]?.customer_id);
    if (conv.rows[0]) {
      await sendPush(conv.rows[0].customer_id, 'New Reply on BridgePro 💬', message.slice(0, 100), { url: '/connect' });
      console.log('PUSH: notification sent to customer successfully');
    }
  } catch(e) { console.error('PUSH ERROR:', e.message, e.stack); }

  return { success: true };
}

async function draft_invoice({ enquiry_id: rawId, amount, description, currency }, { userId, role }) {
  const enquiry_id = parseInt(rawId, 10);
  if (role !== 'provider' && role !== 'admin') return { error: 'Only providers can draft invoices' };

  const listingRes = await db.query(
    role === 'admin'
      ? `SELECT l.business_name, l.logo_url FROM listings l JOIN bc_conversations bc ON bc.listing_id = l.id WHERE bc.id = $1`
      : `SELECT l.business_name, l.logo_url FROM listings l JOIN bc_conversations bc ON bc.listing_id = l.id WHERE bc.id = $1 AND l.user_id = $2`,
    role === 'admin' ? [enquiry_id] : [enquiry_id, userId]
  );
  const business_name = listingRes.rows[0]?.business_name || 'Your Business';
  const logo_url = listingRes.rows[0]?.logo_url || null;

  const receipt_number = 'BP-' + Date.now();
  const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const finalCurrency = currency || 'XCD';

  const receiptData = {
    receipt_number,
    issued_by: business_name,
    issued_to: 'Customer',
    date,
    description,
    amount,
    currency: finalCurrency,
    status: 'DRAFT',
  };

  const generateReceiptPdf = require('../utils/generateReceiptPdf');
  try {
    await generateReceiptPdf({ ...receiptData, logo_url });
  } catch (err) {
    console.error('Receipt pre-generation failed:', err);
  }

  const pdf_url = `/api/ai/receipt/pdf/${receipt_number}`;

  await db.query(
    `INSERT INTO provider_documents (user_id, type, label, download_url, meta)
     VALUES ($1, 'receipt', $2, $3, $4)`,
    [userId,
     `Receipt — ${business_name} (${finalCurrency} $${parseFloat(amount).toFixed(2)})`,
     pdf_url,
     JSON.stringify({ receipt_number, amount, currency: finalCurrency, enquiry_id: rawId })]
  ).catch(err => console.error('[draft_invoice] provider_documents insert failed:', err.message));

  return {
    draft: true,
    receipt: { ...receiptData, note: 'Generated by Bridge Agent' },
    pdf_url,
    formatted:
      `RECEIPT #${receipt_number}\n` +
      `From: ${business_name}\n` +
      `Date: ${date}\n` +
      `For: ${description}\n` +
      `Amount: $${amount} ${finalCurrency}\n` +
      `Status: DRAFT — pending customer payment\n\n` +
      `Download PDF: ${pdf_url}\n\n` +
      `Please share this invoice with your customer to request payment.`,
  };
}

async function update_listing_status({ listing_id, is_active }, { userId, role }) {
  if (role !== 'provider' && role !== 'admin') return { error: 'Only providers can update listing status' };

  if (role !== 'admin') {
    const check = await db.query(
      'SELECT id FROM listings WHERE id = $1 AND user_id = $2',
      [listing_id, userId]
    );
    if (check.rows.length === 0) return { error: 'Listing not found or not authorised' };
  }

  await db.query(
    'UPDATE listings SET is_active = $1 WHERE id = $2',
    [is_active, listing_id]
  );

  return { success: true, listing_id, is_active };
}

async function get_incoming_enquiries(_input, { userId, role }) {
  if (role === 'admin') {
    const { rows } = await db.query(
      `SELECT bc.id AS conversation_id, COALESCE(l.business_name, jl.title, 'Bridge Connect Conversation') AS business_name, u.full_name AS customer_name,
              bc.status, bc.created_at,
              (SELECT body FROM bc_messages WHERE conversation_id = bc.id ORDER BY created_at DESC LIMIT 1) AS last_message
       FROM bc_conversations bc
       LEFT JOIN listings l ON l.id = bc.listing_id
       LEFT JOIN job_listings jl ON jl.id = bc.job_id
       LEFT JOIN users u ON u.id = bc.customer_id
       ORDER BY bc.created_at DESC LIMIT 20`
    );
    return rows;
  }

  const { rows } = await db.query(
    `SELECT bc.id AS conversation_id, COALESCE(l.business_name, jl.title, 'Bridge Connect Conversation') AS business_name, bc.status, bc.created_at,
            (SELECT body FROM bc_messages
             WHERE conversation_id = bc.id
             ORDER BY created_at DESC LIMIT 1) AS last_message
     FROM bc_conversations bc
     LEFT JOIN listings l ON l.id = bc.listing_id
     LEFT JOIN job_listings jl ON jl.id = bc.job_id
     WHERE bc.provider_id = $1
     ORDER BY bc.created_at DESC
     LIMIT 10`,
    [userId]
  );
  return rows;
}

async function get_platform_stats(_input, { role }) {
  if (role !== 'admin') return { error: 'Admin access required' };

  const [
    listings,
    users,
    conversations,
    transactions,
    revenue,
    reviews,
    avgRating
  ] = await Promise.all([
    db.query('SELECT COUNT(*) FROM listings WHERE is_active = true'),
    db.query('SELECT COUNT(*) FROM users'),
    db.query("SELECT COUNT(*) FROM bc_conversations WHERE status = 'open'"),
    db.query('SELECT COUNT(*) FROM transactions WHERE is_verified = true'),
    db.query('SELECT SUM(amount) FROM transactions WHERE is_verified = true'),
    db.query('SELECT COUNT(*) FROM reviews'),
    db.query('SELECT AVG(rating) FROM reviews'),
  ]);

  return {
    total_listings: parseInt(listings.rows[0].count, 10),
    total_users: parseInt(users.rows[0].count, 10),
    active_conversations: parseInt(conversations.rows[0].count, 10),
    completed_jobs: parseInt(transactions.rows[0].count, 10),
    total_volume: parseFloat(revenue.rows[0].sum || 0),
    total_reviews: parseInt(reviews.rows[0].count, 10),
    average_rating: parseFloat(avgRating.rows[0].avg || 0).toFixed(2),
  };
}

async function get_pending_listings(_input, { role }) {
  if (role !== 'admin') return { error: 'Admin access required' };

  const { rows } = await db.query(
    `SELECT id, business_name, user_id, created_at
     FROM listings
     WHERE is_active = false
     ORDER BY created_at DESC
     LIMIT 20`
  );
  return rows;
}

async function view_audit_log({ limit = 50, action }, { role }) {
  if (role !== 'admin') return { error: 'Admin access required' };

  let queryStr = `
    SELECT a.id, a.action, a.detail, a.target_id, a.created_at,
           COALESCE(u.full_name, 'deleted admin') AS admin_name
    FROM admin_audit_log a
    LEFT JOIN users u ON u.id = a.admin_id
  `;
  const params = [];

  if (action) {
    params.push(action);
    queryStr += ` WHERE a.action = $1`;
  }

  queryStr += ` ORDER BY a.created_at DESC LIMIT $${params.length + 1}`;
  params.push(Math.min(200, parseInt(limit, 10) || 50));

  const result = await db.query(queryStr, params);
  return { success: true, logs: result.rows };
}

async function get_conversation_thread({ conversation_id }, { userId, role }) {
  const id = parseInt(conversation_id, 10);
  if (!id) return { error: 'conversation_id must be an integer' };

  if (role !== 'admin') {
    const access = await db.query(
      `SELECT id FROM bc_conversations WHERE id = $1 AND (customer_id = $2 OR provider_id = $2)`,
      [id, userId]
    );
    if (access.rows.length === 0) return { error: 'Conversation not found or not authorised' };
  }

  const { rows } = await db.query(
    `SELECT u.full_name AS sender_name, m.body, m.created_at, m.message_type
     FROM bc_messages m
     LEFT JOIN users u ON u.id = m.sender_id
     WHERE m.conversation_id = $1
     ORDER BY m.created_at ASC
     LIMIT 20`,
    [id]
  );
  return rows;
}

async function search_products({ query, max_price }, { country_code }) {
  const params = [country_code, `%${query}%`];
  let sql = `
    SELECT bp.name, bp.description, bp.price, bp.deal_price, bp.deal_expires,
           bp.currency, bp.unit, bp.in_stock, l.business_name
    FROM business_products bp
    JOIN listings l ON l.id = bp.listing_id
    WHERE l.is_active = true
      AND bp.country_code = $1
      AND (bp.name ILIKE $2 OR bp.description ILIKE $2 OR bp.category ILIKE $2)`;
  if (max_price != null) {
    params.push(max_price);
    sql += ` AND (bp.price <= $${params.length} OR (bp.deal_price IS NOT NULL AND bp.deal_price <= $${params.length}))`;
  }
  sql += ` ORDER BY bp.in_stock DESC, bp.deal_price NULLS LAST LIMIT 10`;
  const { rows } = await db.query(sql, params);
  return rows;
}

async function get_my_products({ listing_id }, { userId, role }) {
  if (role !== 'provider' && role !== 'admin') return { error: 'Only providers can view their products' };

  if (role === 'admin') {
    const params = [];
    let sql = `
      SELECT bp.id, bp.name, bp.description, bp.price, bp.currency, bp.unit, bp.category,
             bp.in_stock, bp.deal_price, bp.deal_expires, bp.listing_id, l.business_name
      FROM business_products bp
      JOIN listings l ON l.id = bp.listing_id`;
    if (listing_id) { params.push(listing_id); sql += ` WHERE bp.listing_id = $1`; }
    sql += ` ORDER BY bp.created_at DESC LIMIT 50`;
    const { rows } = await db.query(sql, params);
    return rows;
  }

  const params = [userId];
  let sql = `
    SELECT bp.id, bp.name, bp.description, bp.price, bp.currency, bp.unit, bp.category,
           bp.in_stock, bp.deal_price, bp.deal_expires, bp.listing_id, l.business_name
    FROM business_products bp
    JOIN listings l ON l.id = bp.listing_id
    WHERE l.user_id = $1`;
  if (listing_id) {
    params.push(listing_id);
    sql += ` AND bp.listing_id = $2`;
  }
  sql += ` ORDER BY bp.created_at DESC LIMIT 20`;
  const { rows } = await db.query(sql, params);
  return rows;
}

async function create_product({ listing_id, name, price, description, category, unit, in_stock, currency }, { userId, role, country_code }) {
  if (role !== 'provider' && role !== 'admin') return { error: 'Only providers can create products' };
  if (role !== 'admin') {
    const check = await db.query('SELECT id FROM listings WHERE id = $1 AND user_id = $2', [listing_id, userId]);
    if (check.rows.length === 0) return { error: 'Listing not found or not authorised' };
  }
  const { rows } = await db.query(
    `INSERT INTO business_products (listing_id, country_code, name, description, price, currency, unit, category, in_stock)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [listing_id, country_code, name, description ?? null, price ?? null,
     currency || 'XCD', unit ?? null, category ?? null, in_stock !== undefined ? in_stock : true]
  );
  return { success: true, product_id: rows[0].id, name, price };
}

async function update_product({ product_id, price, deal_price, deal_expires, in_stock, name, description }, { userId, role }) {
  if (role !== 'provider' && role !== 'admin') return { error: 'Only providers can update products' };
  if (role !== 'admin') {
    const check = await db.query(
      `SELECT bp.id FROM business_products bp
       JOIN listings l ON l.id = bp.listing_id
       WHERE bp.id = $1 AND l.user_id = $2`,
      [product_id, userId]
    );
    if (check.rows.length === 0) return { error: 'Product not found or not authorised' };
  }

  // Resolve natural-language deal_expires
  let resolvedExpires = deal_expires ?? null;
  if (deal_expires) {
    const lower = String(deal_expires).toLowerCase().trim();
    if (lower === 'end of month') {
      const n = new Date();
      resolvedExpires = new Date(n.getFullYear(), n.getMonth() + 1, 0).toISOString();
    } else if (lower === 'end of year') {
      resolvedExpires = new Date(new Date().getFullYear(), 11, 31).toISOString();
    } else {
      const p = new Date(deal_expires);
      resolvedExpires = isNaN(p) ? null : p.toISOString();
    }
  }

  const sets = [], params = [];
  const push = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (name        != null) push('name', name);
  if (description != null) push('description', description);
  if (price       != null) push('price', price);
  if (deal_price  != null) push('deal_price', deal_price);
  if (resolvedExpires != null) push('deal_expires', resolvedExpires);
  if (in_stock    != null) push('in_stock', in_stock);
  if (sets.length === 0) return { error: 'No fields to update' };
  sets.push('updated_at = NOW()');
  params.push(product_id);
  await db.query(`UPDATE business_products SET ${sets.join(', ')} WHERE id = $${params.length}`, params);

  const updated_fields = {};
  if (name        != null) updated_fields.name = name;
  if (description != null) updated_fields.description = description;
  if (price       != null) updated_fields.price = price;
  if (deal_price  != null) updated_fields.deal_price = deal_price;
  if (resolvedExpires != null) updated_fields.deal_expires = resolvedExpires;
  if (in_stock    != null) updated_fields.in_stock = in_stock;
  return { success: true, product_id, updated_fields };
}

async function create_appointment({ title, appointment_at, minutes_from_now, provider_id, listing_id, reminder_minutes_before }, { userId, country_code }) {
  const reminderMins = parseInt(reminder_minutes_before, 10);
  if (isNaN(reminderMins) || reminderMins < 1) {
    return { error: 'reminder_minutes_before must be at least 1. Ask the user how far in advance they want to be notified (e.g. 15 minutes, 1 hour, 1 day).' };
  }

  if (minutes_from_now != null) {
    // Relative time: let the DB compute the exact SVG timestamp so the LLM never touches clock math
    const mins = parseInt(minutes_from_now, 10);
    if (isNaN(mins) || mins <= 0) return { error: 'minutes_from_now must be a positive integer' };
    if (mins <= reminderMins) {
      return { error: `The appointment is only ${mins} minute(s) away but the reminder window is ${reminderMins} minute(s) — the reminder would fire in the past. Either move the appointment further out or reduce the reminder window.` };
    }
    const { rows } = await db.query(
      `INSERT INTO appointments (country_code, customer_id, provider_id, listing_id, title, appointment_at, reminder_minutes_before, status, created_via)
       VALUES ($1, $2, $3, $4, $5, LOCALTIMESTAMP + ($6 * INTERVAL '1 minute'), $7, 'scheduled', 'ai_assistant')
       RETURNING id, TO_CHAR(appointment_at, 'YYYY-MM-DD HH24:MI') AS appointment_at`,
      [country_code, userId, provider_id || null, listing_id || null, title, mins, reminderMins]
    );
    return { success: true, appointment_id: rows[0].id, appointment_at: rows[0].appointment_at, reminder_minutes_before: reminderMins };
  }

  if (!appointment_at || isNaN(new Date(appointment_at))) {
    return { error: 'Provide either minutes_from_now (for relative times) or appointment_at in ISO 8601 format (for absolute times)' };
  }
  const { rows } = await db.query(
    `INSERT INTO appointments (country_code, customer_id, provider_id, listing_id, title, appointment_at, reminder_minutes_before, status, created_via)
     VALUES ($1, $2, $3, $4, $5, $6::timestamp, $7, 'scheduled', 'ai_assistant')
     RETURNING id, TO_CHAR(appointment_at, 'YYYY-MM-DD HH24:MI') AS appointment_at`,
    [country_code, userId, provider_id || null, listing_id || null, title, appointment_at, reminderMins]
  );
  return { success: true, appointment_id: rows[0].id, appointment_at: rows[0].appointment_at, reminder_minutes_before: reminderMins };
}

async function list_upcoming_appointments(_input, { userId }) {
  const { rows } = await db.query(
    `SELECT id, title,
            TO_CHAR(appointment_at, 'YYYY-MM-DD HH24:MI') AS appointment_at,
            reminder_minutes_before, notes, status
     FROM appointments
     WHERE customer_id = $1
       AND status = 'scheduled'
       AND appointment_at > LOCALTIMESTAMP
     ORDER BY appointment_at ASC`,
    [userId]
  );
  return rows;
}

async function cancel_appointment({ appointment_id }, { userId }) {
  const check = await db.query(
    'SELECT id FROM appointments WHERE id = $1 AND customer_id = $2',
    [appointment_id, userId]
  );
  if (!check.rows.length) return { error: 'Appointment not found or not authorised' };
  await db.query(
    "UPDATE appointments SET status = 'cancelled', updated_at = NOW() WHERE id = $1",
    [appointment_id]
  );
  return { success: true, appointment_id };
}

async function approve_listing({ listing_id, action, reason }, { userId, role }) {
  if (role !== 'admin') return { error: 'Admin access required' };
  if (!listing_id) return { error: 'listing_id is required' };
  if (action === 'reject' && !reason) return { error: 'A reason is required when rejecting a listing' };

  const is_active = action === 'approve';

  const listing = await db.query(
    'SELECT id, user_id, business_name FROM listings WHERE id = $1',
    [listing_id]
  );
  if (!listing.rows.length) return { error: 'Listing not found' };

  await db.query('UPDATE listings SET is_active = $1, updated_at = NOW() WHERE id = $2', [is_active, listing_id]);

  const { user_id, business_name } = listing.rows[0];
  const msg = is_active
    ? `Your listing "${business_name}" has been approved and is now live.`
    : `Your listing "${business_name}" was not approved${reason ? ': ' + reason : ''}. Please update your details and resubmit.`;

  try {
    const { notify } = require('../services/notificationService');
    await notify(user_id, is_active ? 'listing_approved' : 'listing_rejected',
      is_active ? '✅ Listing Approved' : '❌ Listing Not Approved', msg, { url: '/dashboard' });
  } catch (err) {
    console.error('Notification failed:', err.message);
  }

  try {
    const { v4: uuidv4 } = require('uuid');
    await db.query(
      `INSERT INTO admin_audit_log (id, admin_id, action, target_id, detail)
       VALUES ($1, $2, $3, $4, $5)`,
      [uuidv4(), userId, is_active ? 'listing_approved' : 'listing_rejected', listing_id, reason || '']
    );
  } catch (err) {
    console.error('Audit log failed:', err.message);
  }

  return { success: true, listing_id, is_active };
}

async function mark_job_complete({ job_id, completion_note }, { userId, role }) {
  if (role !== 'provider' && role !== 'admin') return { error: 'Only providers can mark jobs as complete' };

  const check = await db.query(
    'SELECT id, provider_id, customer_id, title FROM appointments WHERE id = $1',
    [job_id]
  );
  if (!check.rows.length) return { error: 'Job not found' };
  if (check.rows[0].provider_id !== userId && role !== 'admin') {
    return { error: 'Forbidden: you are not the provider for this job' };
  }

  const noteText = completion_note ? `Completion Note: ${completion_note}` : '';
  await db.query(
    `UPDATE appointments
     SET status = 'completed',
         notes = CASE WHEN notes IS NULL OR notes = '' THEN $1 ELSE notes || E'\n' || $1 END,
         updated_at = NOW()
     WHERE id = $2`,
    [noteText, job_id]
  );

  try {
    const { notify } = require('../services/notificationService');
    notify(check.rows[0].customer_id, 'job_completed', '✅ Job Completed', `Provider has marked "${check.rows[0].title}" as complete.`, { url: '/dashboard' }).catch(() => {});
  } catch (err) {
    console.error('Notification failed:', err.message);
  }

  return { success: true, job_id };
}

async function cancel_enquiry({ enquiry_id, reason }, { userId }) {
  const id = parseInt(enquiry_id, 10);
  if (!id) return { error: 'enquiry_id must be a valid integer' };

  const check = await db.query(
    'SELECT id, customer_id, status FROM enquiries WHERE id = $1',
    [id]
  );
  if (!check.rows.length) return { error: 'Enquiry not found' };
  if (check.rows[0].customer_id !== userId) return { error: 'Forbidden: you cannot cancel this enquiry' };
  if (check.rows[0].status !== 'pending') return { error: `Enquiry is already ${check.rows[0].status}` };

  await db.query(
    `UPDATE enquiries SET status = 'cancelled', decline_reason = $1, updated_at = NOW() WHERE id = $2`,
    [reason || 'Cancelled by customer', id]
  );

  return { success: true, enquiry_id: id };
}

async function submit_review({ transaction_id, rating, body }, { userId, country_code }) {
  if (!transaction_id || !rating) {
    return { error: 'transaction_id and rating are required' };
  }
  const ratingInt = parseInt(rating, 10);
  if (ratingInt < 1 || ratingInt > 5) {
    return { error: 'rating must be between 1 and 5' };
  }

  const reviewer = await db.query('SELECT is_verified, customer_verified FROM users WHERE id = $1', [userId]);
  const r = reviewer.rows[0];
  if (!r?.is_verified && !r?.customer_verified) {
    return { error: 'You must verify your ID before leaving a review' };
  }

  const tx = await db.query(
    `SELECT * FROM transactions
     WHERE id = $1 AND is_verified = true
       AND (customer_id = $2 OR provider_id = $2)`,
    [transaction_id, userId]
  );
  if (!tx.rows.length) {
    return { error: 'No verified transaction found. Reviews require a verified transaction.' };
  }

  const t = tx.rows[0];
  const reviewedUserId = t.customer_id === userId ? t.provider_id : t.customer_id;

  const existing = await db.query(
    'SELECT id FROM reviews WHERE transaction_id = $1 AND reviewer_id = $2',
    [transaction_id, userId]
  );
  if (existing.rows.length) {
    return { error: 'Review already submitted for this transaction' };
  }

  const listing = await db.query(
    'SELECT id FROM listings WHERE user_id = $1 AND country_code = $2 AND is_active = true',
    [reviewedUserId, country_code]
  );
  if (!listing.rows.length) {
    return { error: 'The provider does not have an active listing to review' };
  }

  const { v4: uuidv4 } = require('uuid');
  const reviewId = uuidv4();

  const result = await db.query(
    `INSERT INTO reviews (id, transaction_id, reviewer_id, listing_id, country_code, rating, customer_care, quality, body)
     VALUES ($1, $2, $3, $4, $5, $6, false, false, $7) RETURNING *`,
    [reviewId, transaction_id, userId, listing.rows[0].id, country_code, ratingInt, body || null]
  );

  try {
    const { handleReviewCreated } = require('../services/points');
    await handleReviewCreated(result.rows[0], reviewedUserId, country_code);
  } catch (err) {
    console.error('handleReviewCreated failed:', err.message);
  }

  try {
    const reviewerNameRes = await db.query('SELECT full_name FROM users WHERE id = $1', [userId]);
    const { notify } = require('../services/notificationService');
    notify(reviewedUserId, 'review', '⭐ New Review', `${reviewerNameRes.rows[0]?.full_name || 'Customer'} left you a ${ratingInt}-star review`, { url: '/dashboard' }).catch(() => {});
  } catch (err) {
    console.error('Notification failed:', err.message);
  }

  return { success: true, review: result.rows[0] };
}

async function get_reviews({ listing_id }, { country_code }) {
  if (!listing_id) return { error: 'listing_id is required' };
  const result = await db.query(
    `SELECT r.*, u.full_name AS reviewer_name
     FROM reviews r JOIN users u ON u.id = r.reviewer_id
     WHERE r.listing_id = $1 AND r.country_code = $2
     ORDER BY r.created_at DESC`,
    [listing_id, country_code]
  );
  return { reviews: result.rows };
}

async function get_recommendations({ user_id }, { userId, country_code }) {
  const targetUserId = user_id || userId;
  if (!targetUserId) return { error: 'user_id or authenticated userId is required' };

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
    console.error('get_recommendations: Failed to fetch interaction history:', err.message);
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
        [categories, country_code]
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
      console.error('get_recommendations: Failed to fetch personalized listings:', err.message);
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
      [country_code]
    );

    const countryName = country_code === 'VC' ? 'St. Vincent' : country_code === 'SLU' ? 'St. Lucia' : country_code === 'BRB' ? 'Barbados' : country_code === 'GRD' ? 'Grenada' : country_code;
    trending = trendingRes.rows.map(item => ({
      id: item.id,
      business_name: item.business_name,
      category: item.category,
      description: item.description,
      provider_name: item.provider_name,
      reason: `Trending in ${countryName}`
    }));
  } catch (err) {
    console.error('get_recommendations: Failed to fetch trending listings:', err.message);
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
}

async function propose_slots({ provider_id }, { userId, country_code }) {
  if (!provider_id) return { error: 'provider_id is required' };

  const { rows } = await db.query(
    `SELECT appointment_at
     FROM appointments
     WHERE provider_id = $1
       AND status IN ('scheduled', 'confirmed', 'pending_approval')
       AND appointment_at BETWEEN LOCALTIMESTAMP AND LOCALTIMESTAMP + INTERVAL '7 days'
     ORDER BY appointment_at ASC`,
    [provider_id]
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
}

async function initiate_booking({ provider_id, start_time, title }, { userId, country_code }) {
  if (!provider_id || !start_time || !title) {
    return { error: 'provider_id, start_time, and title are required' };
  }

  const { rows } = await db.query(
    `INSERT INTO appointments (country_code, customer_id, provider_id, listing_id, title, appointment_at, reminder_minutes_before, status, created_via)
     VALUES ($1, $2, $3, null, $4, $5::timestamp, 60, 'pending_approval', 'ai_scheduler')
     RETURNING id, TO_CHAR(appointment_at, 'YYYY-MM-DD HH24:MI') AS appointment_at`,
    [country_code, userId, provider_id, title, start_time]
  );

  try {
    const customerRow = await db.query('SELECT full_name FROM users WHERE id = $1', [userId]);
    const customerName = customerRow.rows[0]?.full_name || 'A customer';
    const { notify } = require('../services/notificationService');
    await notify(provider_id, 'appointment_pending', '📅 New Appointment Proposal', `${customerName} proposed an appointment for "${title}" on ${rows[0].appointment_at}.`, { url: '/dashboard' });
  } catch (err) {
    console.error('initiate_booking: Notification failed:', err.message);
  }

  return { success: true, appointment_id: rows[0].id, appointment_at: rows[0].appointment_at, status: 'PENDING_PROVIDER_APPROVAL' };
}

async function confirm_booking({ appointment_id }, { userId, role }) {
  if (!appointment_id) return { error: 'appointment_id is required' };
  
  const check = await db.query(
    `SELECT id, provider_id, customer_id, title, TO_CHAR(appointment_at, 'YYYY-MM-DD HH24:MI') AS appointment_at 
     FROM appointments WHERE id = $1`,
    [appointment_id]
  );
  if (!check.rows.length) return { error: 'Appointment not found' };
  
  if (check.rows[0].provider_id !== userId && role !== 'admin') {
    return { error: 'Forbidden: you are not the provider for this appointment' };
  }

  await db.query(
    `UPDATE appointments SET status = 'scheduled', updated_at = NOW() WHERE id = $1`,
    [appointment_id]
  );

  try {
    const { notify } = require('../services/notificationService');
    const { rows: providerRow } = await db.query('SELECT full_name FROM users WHERE id = $1', [check.rows[0].provider_id]);
    const providerName = providerRow[0]?.full_name || 'Provider';
    const apptTime = check.rows[0].appointment_at;

    notify(check.rows[0].customer_id, 'appointment_confirmed', '✅ Appointment Confirmed', `${providerName} confirmed your appointment for "${check.rows[0].title}" on ${apptTime}.`, { url: '/dashboard' }).catch(() => {});
    notify(check.rows[0].provider_id, 'appointment_confirmed', '✅ Appointment Confirmed', `You have confirmed the appointment for "${check.rows[0].title}" on ${apptTime}.`, { url: '/dashboard' }).catch(() => {});
  } catch (err) {
    console.error('confirm_booking: Notification failed:', err.message);
  }

  return { success: true, status: 'CONFIRMED', appointment_id };
}


async function analyze_image({ image_url, type, listing_id: inputListingId, skip_save }, { role, userId, country_code }) {
  if (role !== 'provider' && role !== 'admin') return { error: 'Only providers can analyze images' };
  try {
    const fs = require('fs');
    const { v4: uuidv4 } = require('uuid');

    const filename = image_url.split('/').pop();
    const filepath = '/tmp/agent-uploads/' + filename;

    if (!fs.existsSync(filepath)) {
      return { error: 'Image file not found: ' + filename };
    }

    const imageBuffer = fs.readFileSync(filepath);
    const base64Image = imageBuffer.toString('base64');
    const mimeType = filename.endsWith('.png') ? 'image/png' : filename.endsWith('.webp') ? 'image/webp' : 'image/jpeg';

    if (type === 'listing') {
      return await analyzeListingImage(base64Image, mimeType);
    }

    const result = await analyzeProductImage(base64Image, mimeType);

    if (skip_save) {
      return {
        success: true,
        name: result.name,
        price: result.suggested_price,
        category: result.category,
        description: result.description,
        confidence_score: result.confidence_score !== undefined ? result.confidence_score : 85,
        message: 'Image analyzed successfully',
      };
    }

    // Auto-create product after successful analysis
    let listing_id = inputListingId || null;
    if (!listing_id) {
      const listingResult = await db.query(
        'SELECT id FROM listings WHERE user_id = $1 AND is_active = true LIMIT 1',
        [userId]
      );
      listing_id = listingResult.rows[0]?.id;
    }

    if (!listing_id) {
      return { ...result, product_created: false, message: 'No active listing found — product not saved' };
    }

    const productId = uuidv4();
    await db.query(
      `INSERT INTO business_products (id, listing_id, country_code, name, description, price, currency, category, in_stock)
       VALUES ($1, $2, $3, $4, $5, $6, 'XCD', $7, true)`,
      [productId, listing_id, country_code, result.name, result.description ?? null, result.suggested_price ?? null, result.category ?? null]
    );

    // Process image and upload thumbnail + full size
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
      console.log('analyze_image: product created with image:', result.name, '| listing:', listing_id);
    } catch (imgErr) {
      console.error('analyze_image: image upload failed (product still created):', imgErr.message);
    }

    return {
      success: true,
      product_created: true,
      name: result.name,
      price: result.suggested_price,
      category: result.category,
      description: result.description,
      message: 'Product created successfully with photo',
    };
  } catch (err) {
    console.error('analyze_image error:', err.message);
    return { error: 'Image analysis failed: ' + err.message };
  }
}

async function auto_list_service({ image_url, provider_id, listing_id: inputListingId }, { userId, role, country_code }) {
  const targetUserId = provider_id || userId;
  if (role !== 'provider' && role !== 'admin') return { error: 'Only providers can list services' };

  try {
    const analysis = await analyze_image(
      { image_url, type: 'product', skip_save: true },
      { role, userId: targetUserId, country_code }
    );
    if (analysis.error) return { error: 'Analysis failed: ' + analysis.error };

    const confidence = analysis.confidence_score !== undefined ? analysis.confidence_score : 85;
    if (confidence < 80) {
      return {
        success: false,
        confidence_score: confidence,
        name: analysis.name,
        price: analysis.price,
        category: analysis.category,
        description: analysis.description,
        message: 'AI confidence score is below 80%. Please confirm or provide details manually.',
        needs_confirmation: true
      };
    }

    let listing_id = inputListingId || null;
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

    const productResult = await create_product(
      {
        listing_id,
        name: analysis.name,
        price: analysis.price,
        description: analysis.description,
        category: analysis.category,
        in_stock: true
      },
      { userId: targetUserId, role, country_code }
    );

    if (productResult.error) return { error: 'Product creation failed: ' + productResult.error };

    // Attach image
    if (productResult.success && image_url) {
      const fs = require('fs');
      try {
        const filename = image_url.split('/').pop();
        const filepath = '/tmp/agent-uploads/' + filename;
        if (fs.existsSync(filepath)) {
          const imageBuffer = fs.readFileSync(filepath);
          const { thumb, optimized } = await processItemImage(imageBuffer);
          const [thumbRes, imgRes] = await Promise.all([
            uploadBuffer(thumb,     `products/${listing_id}/thumbs`, '.webp', 'image/webp'),
            uploadBuffer(optimized, `products/${listing_id}/full`,   '.webp', 'image/webp'),
          ]);
          await db.query(
            'UPDATE business_products SET image_url = $1, thumb_url = $2, updated_at = NOW() WHERE id = $3',
            [imgRes.url, thumbRes.url, productResult.product_id]
          );
        } else {
          await db.query(
            'UPDATE business_products SET image_url = $1, updated_at = NOW() WHERE id = $2',
            [image_url, productResult.product_id]
          );
        }
      } catch (imgErr) {
        console.error('auto_list_service: image upload failed:', imgErr.message);
      }
    }

    return {
      success: true,
      product_id: productResult.product_id,
      name: analysis.name,
      price: analysis.price,
      category: analysis.category,
      description: analysis.description,
      confidence_score: confidence,
      message: 'Product listed successfully from image analysis'
    };
  } catch (err) {
    console.error('auto_list_service error:', err.message);
    return { error: 'Auto listing failed: ' + err.message };
  }
}

const TOOL_EXECUTORS = {
  search_providers,
  send_enquiry,
  get_my_enquiries,
  get_my_listings,
  get_incoming_enquiries,
  respond_to_enquiry,
  draft_invoice,
  update_listing_status,
  get_platform_stats,
  get_pending_listings,
  get_conversation_thread,
  search_products,
  get_my_products,
  create_product,
  update_product,
  analyze_image,
  create_appointment,
  list_upcoming_appointments,
  cancel_appointment,
  approve_listing,
  mark_job_complete,
  cancel_enquiry,
  submit_review,
  get_reviews,
  view_audit_log,
  get_recommendations,
  propose_slots,
  initiate_booking,
  confirm_booking,
  auto_list_service,
};

async function saveMemory(userId, conversationMessages) {
  try {
    const summaryResp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [
        ...conversationMessages,
        { role: 'user', content: 'In 2-3 sentences, summarize the key facts from this conversation that would be useful to remember for next time. Include names, amounts, dates, businesses, and outcomes. Be concise.' },
      ],
    });
    const newSummary = summaryResp.content.find(b => b.type === 'text')?.text?.trim();
    if (!newSummary) return;

    await db.query(
      `INSERT INTO agent_memory (user_id, summary) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET
         summary = CASE
           WHEN length(agent_memory.summary || E'\n' || EXCLUDED.summary) > 500
           THEN right(agent_memory.summary || E'\n' || EXCLUDED.summary,
                      500 - length(EXCLUDED.summary) - 1) || E'\n' || EXCLUDED.summary
           ELSE agent_memory.summary || E'\n' || EXCLUDED.summary
         END,
         updated_at = NOW()`,
      [userId, newSummary]
    );
  } catch (err) {
    console.error('Agent memory save failed:', err.message);
  }
}

function parseActions(reply) {
  const match = reply.match(/ACTIONS:\[(.+?)\]/);
  if (!match) return { cleanReply: reply, actions: null };
  const actions = match[1].split('|').map(a => a.trim()).filter(Boolean);
  const cleanReply = reply.replace(/\n?ACTIONS:\[.+?\]\n?/g, '').trim();
  return { cleanReply, actions };
}

async function callClaude(messages, tools, systemPrompt) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: systemPrompt,
    tools,
    messages,
  });
  return response;
}

async function callGroq(messages, tools, systemPrompt) {
  const groqMessages = [{ role: 'system', content: systemPrompt }, ...messages];
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: groqMessages,
      tools,
      tool_choice: 'auto',
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error('Groq API ' + response.status + ': ' + JSON.stringify(data.error));
  return data;
}

// --- Route ---

router.post('/', requireAuth, async (req, res) => {
  const { message, conversationHistory = [], personality = 'bri' } = req.body;
  const userId = req.user.id;
  const role = req.user.role || 'customer';
  const country_code = req.user.country_code || 'VC';
  const useClaude = role === 'provider' || role === 'admin';
  console.log('AGENT using:', useClaude ? 'Claude' : 'Groq', '| role:', role);

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }

  const userLang = await detectLanguage(message.trim());
  const msgForClaude = userLang !== 'en'
    ? await translateText(message.trim(), 'en', userLang)
    : message.trim();
  const langName = LANG_NAMES[userLang] || userLang;
  console.log('AGENT TRANSLATE: user said in', userLang, '| translated to EN:', msgForClaude.slice(0, 100));

  const context    = { userId, role, country_code };
  const claudeTools = getToolsForRole(role);
  const groqTools   = getGroqToolsForRole(role);

  // Load visitor profile, memory, user info, and SVG local time in parallel
  const [visitorRow, memoryRow, userRow, svgTimeRow] = await Promise.all([
    db.query('SELECT is_visitor, visiting_country FROM users WHERE id = $1', [userId]),
    db.query('SELECT summary FROM agent_memory WHERE user_id = $1', [userId]),
    db.query('SELECT created_at, full_name FROM users WHERE id = $1', [userId]),
    db.query("SELECT TO_CHAR(LOCALTIMESTAMP, 'YYYY-MM-DD HH24:MI') AS local_time"),
  ]);
  const svgLocalTime    = svgTimeRow.rows[0]?.local_time || '';
  const isVisitor       = visitorRow.rows[0]?.is_visitor || false;
  const visitingCountry = visitorRow.rows[0]?.visiting_country || '';
  const memoryBlock = memoryRow.rows[0]?.summary
    ? `\nMEMORY OF PREVIOUS INTERACTIONS WITH THIS USER:\n${memoryRow.rows[0].summary}\nUse this context naturally in your responses. Reference it when relevant.\n`
    : '';

  const userCreatedAt = userRow.rows[0]?.created_at;
  const userName = userRow.rows[0]?.full_name || '';
  const accountAgeMs = userCreatedAt ? Date.now() - new Date(userCreatedAt).getTime() : Infinity;
  const isNewUser = accountAgeMs < 24 * 60 * 60 * 1000 && !memoryRow.rows[0]?.summary;

  const personalityPrefix = personality === 'bry'
    ? `Your name is Bry, short for Bryan. You are a confident, direct and action-oriented Caribbean male AI assistant. You are professional and efficient. Get things done.\n\n`
    : `Your name is Bri, short for Briana. You are a warm, encouraging, and friendly Caribbean female AI assistant. You use natural conversational language and make users feel supported. Sign off warmly.\n\n`;

  const visitorContext = isVisitor
    ? `\nThis user is a VISITOR to the Caribbean${visitingCountry ? ` from ${visitingCountry}` : ''}. Tailor ALL responses for a visitor experience. Prioritize: taxi services, tour guides, restaurants, hotels, beaches, activities, and local experiences. When they ask for services always think like a tourist concierge. Suggest local highlights. Be welcoming and helpful like a Caribbean host.\n`
    : '';

  const langContext = userLang !== 'en'
    ? `\nThe user is communicating in ${langName}. Respond naturally — the system will handle translation. Be aware of cultural context for this language.\n`
    : '';

  const onboardingContext = isNewUser ? (
    isVisitor
      ? `\nONBOARDING MODE: This is a NEW VISITOR to Saint Vincent and the Grenadines${userName ? ` named ${userName}` : ''}.\n` +
        `1. Welcome them to Saint Vincent and the Grenadines\n` +
        `2. Tell them you are their personal Caribbean guide\n` +
        `3. Ask what they are looking for — tours, restaurants, taxis, accommodation\n` +
        `4. Be warm and excited for their visit\n`
      : role === 'provider'
      ? `\nONBOARDING MODE: This is a NEW PROVIDER${userName ? ` named ${userName}` : ''} who just joined BridgePro.\n` +
        `1. Welcome them and congratulate them on joining\n` +
        `2. Ask if they have set up their listing yet\n` +
        `3. If not, offer to guide them through: business name, description, category, contact details\n` +
        `4. Tell them they can add products and photos to their store\n` +
        `5. Keep it conversational — one step at a time\n`
      : `\nONBOARDING MODE: This is a NEW CUSTOMER${userName ? ` named ${userName}` : ''} who just joined BridgePro.\n` +
        `1. Welcome them warmly${userName ? ` by name` : ''}\n` +
        `2. Explain they can search for any service in SVG\n` +
        `3. Show them an example: suggest they try asking for a popular service\n` +
        `4. Tell them about BridgeConnect messaging\n` +
        `5. Keep it to 3-4 sentences max — friendly not overwhelming\n`
  ) : '';

  const systemPrompt =
    personalityPrefix +
    (svgLocalTime ? `Current date and time in Saint Vincent is ${svgLocalTime} (UTC-4, no DST). Use this only to resolve day names and calendar phrases like "tomorrow", "next Tuesday", "June 25th" into ISO 8601 dates for appointment_at. For purely relative offsets like "in 5 minutes" or "in 2 hours", use minutes_from_now instead — the server handles the arithmetic.\n\n` : '') +
    `You are Bridge Agent, an autonomous AI assistant for BridgePro Caribbean marketplace. The user is a ${role} in ${country_code}.\n\n` +
    `CRITICAL RULES:\n` +
    `1. Call each tool ONLY ONCE per task. Never call the same tool twice in one conversation turn.\n` +
    `2. The listing_id is a UUID string from the search_providers result — use it exactly as returned.\n` +
    `3. After send_enquiry succeeds, tell the user the message was sent. Stop there.\n` +
    `4. Never call search_providers more than once per user request.\n` +
    `5. When a provider asks to check messages, enquiries, or conversations, always call get_incoming_enquiries. Never tell a provider they cannot check messages.\n` +
    `6. When a customer asks to check their messages or enquiries, call get_my_enquiries.\n` +
    `7. You CAN generate PDF receipts. The draft_invoice tool automatically generates a real PDF receipt and returns a pdf_url download link. When a provider asks to generate a receipt, invoice, or proof of payment — always call draft_invoice. Never tell the user you cannot generate PDFs — you can, via the draft_invoice tool.\n` +
    `8. After calling draft_invoice, always send the pdf_url to the customer by calling respond_to_enquiry with a message that includes the download link.\n` +
    `9. When user says help, what can you do, menu, options, or similar — respond with a structured feature menu based on their role. DO NOT use tools. Just respond with the menu as formatted text showing what you can help with. Format it clearly with emojis and short descriptions.\n` +
    `10. CRITICAL — IMAGE ANALYSIS: When analyze_image returns { product_created: true }, the product has ALREADY been saved to the database automatically. Do NOT call create_product after analyze_image succeeds. Simply tell the provider what was created (name, price, category) and offer next steps like adding a photo or editing the price. Never double-create.\n` +
    `11. APPOINTMENTS — three strict rules:\n` +
    `  a) REMINDER WINDOW: Before calling create_appointment, you MUST have a reminder_minutes_before value the user explicitly stated. If the user did not mention how far in advance to notify them, ask first: e.g. "How far ahead should I remind you — 15 minutes, an hour, a day?" Do NOT silently default to 15 minutes.\n` +
    `  b) DATETIME — two cases, never mix them:\n` +
    `     • RELATIVE ("in 5 minutes", "in 2 hours", "in 30 minutes"): pass minutes_from_now as an integer and omit appointment_at. The server computes the exact timestamp — do NOT do the clock math yourself.\n` +
    `     • ABSOLUTE ("tomorrow at 3pm", "next Tuesday", "June 25th at 10am"): pass appointment_at in ISO 8601 SVG local time (e.g. "2026-06-25T10:00:00") and omit minutes_from_now. Use the SVG current time shown at the top of this prompt to resolve "tomorrow" or day names.\n` +
    `  c) CONFIRMATION: After create_appointment succeeds, read appointment_at and reminder_minutes_before from the tool result and confirm back in natural language — e.g. "Done — I've set a reminder for 'Dentist appointment' on Wednesday June 25th at 3:00 PM. I'll notify you 1 hour before." Never guess or paraphrase — use the exact values returned by the tool.\n` +
    `  d) PAYMENT DISCLAIMER: Bridge AI does not process payments and has no payment tool. If a user asks about paying online, checkout, or similar, say plainly that payment isn't handled in-app yet and will be arranged directly between customer and provider — never imply otherwise or attempt to walk someone through a payment flow that doesn't exist.\n\n` +
    `CONFIRMATION RULES:\n` +
    `- Ask for confirmation ONCE only before any action\n` +
    `- After user says yes/confirm/ok/sure/do it/send it → IMMEDIATELY execute the tool. Zero exceptions.\n` +
    `- Never ask the same question twice\n` +
    `- Never say you will confirm and then ask again\n` +
    `- Read-only tools need NO confirmation: search_providers, get_my_enquiries, get_incoming_enquiries, get_my_listings, get_my_products, get_conversation_thread, list_upcoming_appointments\n` +
    `- Write tools need ONE confirmation: send_enquiry, respond_to_enquiry, draft_invoice, create_product, update_product, update_listing_status, create_appointment, cancel_appointment\n\n` +
    `FLOW FOR SENDING ENQUIRIES:\n` +
    `Step 1 — User asks to find a service → call search_providers ONCE → present result → ask if they want to send enquiry\n` +
    `Step 2 — User says yes → draft a message → ask for confirmation\n` +
    `Step 3 — User confirms → call send_enquiry with the listing_id UUID and the drafted message → report success\n\n` +
    `RESPONSE FORMAT: At the end of every response that expects user input or a decision, append this on its own line:\n` +
    `ACTIONS:[action1|action2|action3]\n\n` +
    `Examples:\n` +
    `- Found multiple results → ACTIONS:[Option 1: VC-TAC|Option 2: Delicious Dessertz|Something else...]\n` +
    `- Drafted a message → ACTIONS:[Send it ✅|Tweak it ✏️|Cancel ❌]\n` +
    `- Yes/no question → ACTIONS:[Yes ✅|No ❌|Something else...]\n` +
    `- Booking confirmation → ACTIONS:[Confirm ✅|Change something ✏️|Cancel ❌]\n` +
    `- After completing action → no ACTIONS line needed\n` +
    `Never show the ACTIONS line as visible text — it is metadata only.\n\n` +
    `You have these tools available based on the user role. Use them decisively and do not repeat tool calls.` +
    visitorContext +
    langContext +
    onboardingContext +
    (role === 'provider'
      ? `\nPROVIDER MENU (use this when asked for help or what you can do):\n` +
        `📝 Set up my Listing — create or update your business listing\n` +
        `📦 Manage my Products — add, edit or update your products\n` +
        `💬 Check my Enquiries — see messages from customers\n` +
        `📨 Reply to a Customer — respond to an enquiry\n` +
        `🧾 Generate a Receipt — create a receipt for a payment received\n` +
        `📊 My Business Summary — overview of your listings and activity\n` +
        `📅 Set an Appointment Reminder — schedule a reminder for any event or meeting\n` +
        `🗓️ View my Appointments — see upcoming scheduled reminders\n`
      : `\nCUSTOMER MENU (use this when asked for help or what you can do):\n` +
        `🔍 Find a Service — search for any local business or service\n` +
        `💬 Check my Messages — view your BridgeConnect conversations\n` +
        `📋 View my Enquiries — see businesses you have contacted\n` +
        `🛒 Find a Product — search for products from local stores\n` +
        `✈️ Things to do in SVG — activities, tours, restaurants for visitors\n` +
        `🧾 Check my Receipts — view payment receipts\n` +
        `📅 Set an Appointment Reminder — schedule a reminder for any event or meeting\n` +
        `🗓️ View my Appointments — see upcoming scheduled reminders\n`) +
    memoryBlock;

  const messages = [
    ...conversationHistory.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: msgForClaude },
  ];

  try {
    let iterations = 0;
    const MAX_ITERATIONS = 10;

    if (useClaude) {
      // --- Claude path ---
      while (iterations < MAX_ITERATIONS) {
        iterations++;

        const response = await callClaude(messages, claudeTools, systemPrompt);
        console.log('AGENT loop response:', JSON.stringify({ stop_reason: response.stop_reason, content_types: response.content.map(b => b.type) }));

        if (response.stop_reason === 'end_turn') {
          const textBlock = response.content.find(b => b.type === 'text');
          const raw = textBlock?.text || '';
          const { cleanReply, actions } = parseActions(raw);
          const translatedReply = await translateText(cleanReply, userLang);
          console.log('AGENT REPLY TRANSLATE: en→', userLang, '|', translatedReply.slice(0, 100));
          saveMemory(userId, [...messages, { role: 'assistant', content: cleanReply }]);
          return res.json({ reply: translatedReply, agentMode: true, ...(actions && { actions }) });
        }

        if (response.stop_reason === 'tool_use') {
          messages.push({ role: 'assistant', content: response.content });

          const toolResults = [];
          for (const block of response.content) {
            if (block.type !== 'tool_use') continue;

            const fnName = block.name;
            let result;
            try {
              console.log('AGENT executing tool:', fnName, JSON.stringify(block.input));
              const executor = TOOL_EXECUTORS[fnName];
              result = executor ? await executor(block.input, context) : { error: `Unknown tool: ${fnName}` };
              console.log('AGENT tool result:', JSON.stringify(result));
            } catch (toolErr) {
              console.error('AGENT tool executor crash:', fnName, toolErr.message, toolErr.stack);
              result = { error: toolErr.message };
            }

            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
          }

          messages.push({ role: 'user', content: toolResults });
          continue;
        }

        // Unexpected stop reason
        const textBlock = response.content.find(b => b.type === 'text');
        const raw = textBlock?.text || '';
        const { cleanReply, actions } = parseActions(raw);
        const translatedReply = await translateText(cleanReply, userLang);
        saveMemory(userId, [...messages, { role: 'assistant', content: cleanReply }]);
        return res.json({ reply: translatedReply, agentMode: true, ...(actions && { actions }) });
      }

    } else {
      // --- Groq path ---
      while (iterations < MAX_ITERATIONS) {
        iterations++;

        const response = await callGroq(messages, groqTools, systemPrompt);
        const choice = response.choices[0];
        console.log('AGENT loop response (Groq):', JSON.stringify({ finish_reason: choice.finish_reason }));

        if (choice.finish_reason === 'stop') {
          const raw = choice.message.content || '';
          const { cleanReply, actions } = parseActions(raw);
          const translatedReply = await translateText(cleanReply, userLang);
          console.log('AGENT REPLY TRANSLATE: en→', userLang, '|', translatedReply.slice(0, 100));
          saveMemory(userId, [...messages, { role: 'assistant', content: cleanReply }]);
          return res.json({ reply: translatedReply, agentMode: true, ...(actions && { actions }) });
        }

        if (choice.finish_reason === 'tool_calls') {
          const assistantMsg = choice.message;
          messages.push({ role: 'assistant', content: assistantMsg.content || null, tool_calls: assistantMsg.tool_calls });

          for (const toolCall of assistantMsg.tool_calls) {
            const fnName = toolCall.function.name;
            let result;
            try {
              const input = JSON.parse(toolCall.function.arguments);
              console.log('AGENT executing tool (Groq):', fnName, JSON.stringify(input));
              const executor = TOOL_EXECUTORS[fnName];
              result = executor ? await executor(input, context) : { error: `Unknown tool: ${fnName}` };
              console.log('AGENT tool result (Groq):', JSON.stringify(result));
            } catch (toolErr) {
              console.error('AGENT tool executor crash (Groq):', fnName, toolErr.message, toolErr.stack);
              result = { error: toolErr.message };
            }

            messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(result) });
          }

          continue;
        }

        // Unexpected finish_reason
        const raw = choice.message.content || '';
        const { cleanReply, actions } = parseActions(raw);
        const translatedReply = await translateText(cleanReply, userLang);
        saveMemory(userId, [...messages, { role: 'assistant', content: cleanReply }]);
        return res.json({ reply: translatedReply, agentMode: true, ...(actions && { actions }) });
      }
    }

    return res.json({ reply: 'Maximum steps reached. Please try a more specific request.', agentMode: true });

  } catch (err) {
    console.error('Bridge Agent error:', err.message);
    const msg = err.message || '';
    if (msg.includes('tool') || msg.includes('function')) {
      return res.json({ reply: 'I had trouble completing that action. Could you rephrase what you need or try again?', agentMode: true });
    }
    if (msg.includes('rate limit') || msg.includes('rate_limit')) {
      return res.json({ reply: 'I am processing too many requests right now. Please try again in a moment.', agentMode: true });
    }
    return res.json({ reply: 'Something went wrong on my end. Please try again.', agentMode: true });
  }
});

module.exports = router;
