const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { notify } = require('../services/notificationService');

const router = express.Router();

// POST /enquiries — any logged-in user can enquire (customers OR providers doing business with each other)
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { listing_id, message, item_id, po_items, po_delivery_date, po_notes } = req.body;
    if (!listing_id) return res.status(400).json({ error: 'listing_id is required' });
    if (!message || message.trim().length < 10) {
      return res.status(400).json({ error: 'message must be at least 10 characters' });
    }

    // Validate PO items if provided
    const poItems = Array.isArray(po_items) ? po_items : [];
    if (poItems.length > 50) {
      return res.status(400).json({ error: 'po_items cannot exceed 50 lines' });
    }
    const cleanPoItems = poItems.map((i) => ({
      name:       String(i.name || '').trim().slice(0, 200),
      quantity:   Math.max(1, parseInt(i.quantity) || 1),
      unit_price: i.unit_price != null ? parseFloat(i.unit_price) : null,
    })).filter((i) => i.name);

    const poDeliveryDate = po_delivery_date ? new Date(po_delivery_date) : null;
    if (poDeliveryDate && isNaN(poDeliveryDate.getTime())) {
      return res.status(400).json({ error: 'po_delivery_date is not a valid date' });
    }

    const listing = await db.query(
      'SELECT id, user_id FROM listings WHERE id = $1 AND country_code = $2 AND is_active = true',
      [listing_id, req.countryCode]
    );
    if (!listing.rows.length) return res.status(404).json({ error: 'Listing not found' });

    const provider_id = listing.rows[0].user_id;
    if (provider_id === req.user.id) {
      return res.status(400).json({ error: 'You cannot enquire about your own listing' });
    }

    // One open enquiry per customer per item (or per listing for non-item enquiries)
    const existing = await db.query(
      item_id
        ? `SELECT id FROM enquiries WHERE listing_id = $1 AND customer_id = $2 AND item_id = $3 AND status = 'pending'`
        : `SELECT id FROM enquiries WHERE listing_id = $1 AND customer_id = $2 AND item_id IS NULL AND status = 'pending'`,
      item_id ? [listing_id, req.user.id, item_id] : [listing_id, req.user.id]
    );
    if (existing.rows.length) {
      return res.status(409).json({ error: item_id ? 'You already have an open enquiry for this item' : 'You already have an open enquiry with this provider' });
    }

    // Validate item_id belongs to this listing if provided
    if (item_id) {
      const item = await db.query(
        'SELECT id FROM listing_items WHERE id = $1 AND listing_id = $2',
        [item_id, listing_id]
      );
      if (!item.rows.length) return res.status(400).json({ error: 'Item not found on this listing' });
    }

    const result = await db.query(
      `INSERT INTO enquiries (id, country_code, listing_id, customer_id, provider_id, message, item_id, po_items, po_delivery_date, po_notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [uuidv4(), req.countryCode, listing_id, req.user.id, provider_id, message.trim(), item_id || null,
       JSON.stringify(cleanPoItems), poDeliveryDate || null, po_notes?.trim() || null]
    );

    const enquiry = result.rows[0];

    // Notify provider of new request
    const customerRow = await db.query('SELECT full_name FROM users WHERE id = $1', [req.user.id]);
    notify(provider_id, 'enquiry_new', '📬 New Service Request', `${customerRow.rows[0]?.full_name} sent you a request`, { enquiry_id: enquiry.id, url: '/dashboard' });

    res.status(201).json({ enquiry });
  } catch (err) {
    next(err);
  }
});

// GET /enquiries — own enquiries (customer: sent, provider: received)
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const isProvider = req.user.role === 'provider' || req.user.role === 'admin';
    const field = isProvider ? 'provider_id' : 'customer_id';

    const result = await db.query(
      `SELECT e.*,
              l.business_name, l.category,
              cu.full_name AS customer_name, cu.email AS customer_email,
              cu.customer_verified,
              i.name AS item_name, i.price AS item_price, i.image_url AS item_image_url
       FROM enquiries e
       JOIN listings l ON l.id = e.listing_id
       JOIN users cu ON cu.id = e.customer_id
       LEFT JOIN listing_items i ON i.id = e.item_id
       WHERE e.${field} = $1 AND e.country_code = $2
       ORDER BY e.created_at DESC`,
      [req.user.id, req.countryCode]
    );

    res.json({ enquiries: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /enquiries/:id/accept — provider accepts, creates transaction
router.post('/:id/accept', ...requireRole('provider', 'admin'), async (req, res, next) => {
  try {
    const { amount } = req.body;

    const enq = await db.query(
      `SELECT * FROM enquiries WHERE id = $1 AND provider_id = $2 AND country_code = $3`,
      [req.params.id, req.user.id, req.countryCode]
    );
    if (!enq.rows.length) return res.status(404).json({ error: 'Enquiry not found' });
    if (enq.rows[0].status !== 'pending') {
      return res.status(400).json({ error: `Enquiry is already ${enq.rows[0].status}` });
    }

    const e = enq.rows[0];

    // Create transaction
    const txResult = await db.query(
      `INSERT INTO transactions (id, country_code, provider_id, customer_id, verification_method, amount, document_expires_at, provider_confirmed)
       VALUES ($1, $2, $3, $4, 'single_doc', $5, $6, true) RETURNING *`,
      [uuidv4(), req.countryCode, req.user.id, e.customer_id, amount || null,
       new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)]
    );

    await db.query(
      `UPDATE enquiries SET status = 'accepted', transaction_id = $1, updated_at = NOW() WHERE id = $2`,
      [txResult.rows[0].id, e.id]
    );

    const bizRow = await db.query('SELECT business_name FROM listings WHERE id = $1', [e.listing_id]);
    const bizName = bizRow.rows[0]?.business_name || 'Your provider';
    notify(e.customer_id, 'enquiry_accepted', '✅ Request Accepted', `${bizName} accepted your request — transaction created`, { enquiry_id: e.id, transaction_id: txResult.rows[0].id, url: '/dashboard' });

    res.json({ enquiry: { ...e, status: 'accepted', transaction_id: txResult.rows[0].id }, transaction: txResult.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /enquiries/:id/item-respond — provider confirms availability + shares contact, or marks item unavailable
router.post('/:id/item-respond', ...requireRole('provider', 'admin'), async (req, res, next) => {
  try {
    const enq = await db.query(
      `SELECT * FROM enquiries WHERE id = $1 AND provider_id = $2 AND country_code = $3`,
      [req.params.id, req.user.id, req.countryCode]
    );
    if (!enq.rows.length) return res.status(404).json({ error: 'Enquiry not found' });
    const e = enq.rows[0];
    if (!e.item_id) return res.status(400).json({ error: 'This is not an item enquiry' });
    if (e.status !== 'pending') return res.status(400).json({ error: `Enquiry is already ${e.status}` });

    const bizRow = await db.query('SELECT business_name FROM listings WHERE id = $1', [e.listing_id]);
    const bizName = bizRow.rows[0]?.business_name || 'The provider';
    const itemRow = await db.query('SELECT name FROM listing_items WHERE id = $1', [e.item_id]);
    const itemName = itemRow.rows[0]?.name || 'the item';

    const { available, phone, whatsapp, payment_methods, note } = req.body;

    if (available === false || available === 'false') {
      await db.query(
        `UPDATE enquiries SET status = 'item_unavailable', responded_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [e.id]
      );
      notify(e.customer_id, 'item_unavailable', '📦 Item Unavailable',
        `${bizName}: "${itemName}" is currently unavailable`,
        { enquiry_id: e.id, url: '/dashboard' });
      return res.json({ message: 'Marked as unavailable' });
    }

    // Share contact + availability confirmation
    if (!phone?.trim() && !whatsapp?.trim()) {
      return res.status(400).json({ error: 'Provide at least a phone number or WhatsApp number' });
    }

    const methods = Array.isArray(payment_methods)
      ? payment_methods.map(String).slice(0, 6)
      : [];

    await db.query(
      `UPDATE enquiries SET
         status = 'contact_shared',
         provider_phone = $1,
         provider_whatsapp = $2,
         provider_payment_methods = $3,
         provider_note = $4,
         responded_at = NOW(),
         updated_at = NOW()
       WHERE id = $5`,
      [phone?.trim() || null, whatsapp?.trim() || null, methods, note?.trim() || null, e.id]
    );

    const contactParts = [];
    if (phone?.trim()) contactParts.push(`📞 ${phone.trim()}`);
    if (whatsapp?.trim()) contactParts.push(`💬 WhatsApp: ${whatsapp.trim()}`);
    if (methods.length) contactParts.push(`💳 ${methods.join(', ')}`);

    notify(
      e.customer_id,
      'item_contact_shared',
      '✅ Item Available — Contact Info Sent',
      `${bizName} confirmed "${itemName}" is available. ${contactParts.join(' · ')}${note?.trim() ? ' — ' + note.trim() : ''}`,
      { enquiry_id: e.id, url: '/dashboard' }
    );

    res.json({ message: 'Contact shared with customer' });
  } catch (err) { next(err); }
});

// POST /enquiries/:id/decline — provider declines
router.post('/:id/decline', ...requireRole('provider', 'admin'), async (req, res, next) => {
  try {
    const { reason } = req.body;

    const enq = await db.query(
      `SELECT * FROM enquiries WHERE id = $1 AND provider_id = $2 AND country_code = $3`,
      [req.params.id, req.user.id, req.countryCode]
    );
    if (!enq.rows.length) return res.status(404).json({ error: 'Enquiry not found' });
    if (enq.rows[0].status !== 'pending') {
      return res.status(400).json({ error: `Enquiry is already ${enq.rows[0].status}` });
    }

    const result = await db.query(
      `UPDATE enquiries SET status = 'declined', decline_reason = $1, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [reason?.trim() || null, req.params.id]
    );

    const declined = result.rows[0];
    notify(declined.customer_id, 'enquiry_declined', '❌ Request Declined', reason?.trim() ? `Reason: ${reason.trim()}` : 'Your service request was declined', { enquiry_id: declined.id, url: '/dashboard' });

    res.json({ enquiry: declined });
  } catch (err) {
    next(err);
  }
});

// PUT /enquiries/:id/cancel — customer cancels/withdraws their own enquiry
router.put('/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const { reason } = req.body;
    const enq = await db.query(
      'SELECT id, customer_id, status FROM enquiries WHERE id = $1',
      [req.params.id]
    );
    if (!enq.rows.length) return res.status(404).json({ error: 'Enquiry not found' });
    if (enq.rows[0].customer_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden: you cannot cancel this enquiry' });
    }
    if (enq.rows[0].status !== 'pending') {
      return res.status(400).json({ error: `Enquiry is already ${enq.rows[0].status}` });
    }

    await db.query(
      `UPDATE enquiries SET status = 'cancelled', decline_reason = $1, updated_at = NOW() WHERE id = $2`,
      [reason || 'Cancelled by customer', req.params.id]
    );

    res.json({ success: true, message: 'Enquiry cancelled successfully' });
  } catch (err) {
    next(err);
  }
});

// POST /enquiries/connect/from-enquiry — find or create a Bridge Connect conversation for an enquiry
router.post('/connect/from-enquiry', requireAuth, async (req, res, next) => {
  try {
    const { enquiry_id } = req.body;
    if (!enquiry_id) return res.status(400).json({ error: 'enquiry_id is required' });

    const enq = await db.query(
      'SELECT listing_id, customer_id, provider_id FROM enquiries WHERE id = $1 AND country_code = $2',
      [enquiry_id, req.countryCode]
    );
    if (!enq.rows.length) return res.status(404).json({ error: 'Enquiry not found' });

    const { listing_id, customer_id, provider_id } = enq.rows[0];

    if (req.user.id !== customer_id && req.user.id !== provider_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const existing = await db.query(
      `SELECT id FROM bc_conversations WHERE listing_id = $1 AND customer_id = $2 AND provider_id = $3`,
      [listing_id, customer_id, provider_id]
    );

    if (existing.rows.length) {
      return res.json({ conversation_id: existing.rows[0].id });
    }

    const result = await db.query(
      `INSERT INTO bc_conversations (id, country_code, listing_id, customer_id, provider_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [uuidv4(), req.countryCode, listing_id, customer_id, provider_id]
    );

    res.status(201).json({ conversation_id: result.rows[0].id });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
