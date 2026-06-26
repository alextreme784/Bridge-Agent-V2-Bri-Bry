const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const { isSponsoredEnabled, isFreePeriodActive } = require('../services/platformSettings');

const router = express.Router();

const ADDON_PRICES = {
  photo_gallery:    { monthly_xcd: 3,  label: 'Photo Gallery',        subtitle: 'Portfolio',     description: 'Add a portfolio gallery to your listing — upload up to 10 work photos showing what you do.' },
  item_display:     { monthly_xcd: 4,  label: 'Virtual Store',         subtitle: 'Up to 10 items',description: 'Add a price menu of your products or services. Customers can tap an item and send an enquiry directly.' },
  item_display_pro: { monthly_xcd: 10, label: 'Virtual Store Pro',     subtitle: 'Up to 25 items',description: 'Upgrade your Virtual Store to list up to 25 products or services.' },
  featured_listing: { monthly_xcd: 15, label: 'Sponsored Listing',     subtitle: 'Top of search', description: 'Pin your listing to the top of browse results with a Sponsored badge.' },
  bridgepro_plus:   { monthly_xcd: 20, label: 'BridgePro+',            subtitle: 'Caribbean-wide',description: 'Offer your services across the Caribbean. Accept cross-country enquiries and transactions from any BridgePro country. A regional fee applies to cross-country transactions.' },
  first_impression: { monthly_xcd: 18, label: 'First Impression',       subtitle: '15–30 sec intro video', description: 'Play a short video when customers open your listing — make a powerful first impression before they see your profile.' },
};

const ITEM_DISPLAY_CATEGORIES = [
  // New category names
  'Food & Catering', 'Beauty & Wellness', 'Landscaping & Outdoors',
  'Construction & Trades', 'Technology', 'Garment & Fashion',
  'Retail & Trade', 'Equipment & Rentals', 'Home Services', 'Marine & Fishing',
  'Entertainment & Events', 'Sports & Fitness', 'Education & Training',
  'Professional Services', 'Health & Medical', 'Transport & Logistics',
  // Legacy names (kept for existing listings)
  'Catering', 'Carpenter', 'Beauty', 'Painting', 'Landscaping', 'Other',
];

// GET /addons/my — current addon status for authenticated provider
router.get('/my', ...requireRole('provider', 'admin'), async (req, res, next) => {
  try {
    const listing = await db.query(
      'SELECT id, category, subscription_tier FROM listings WHERE user_id = $1 AND country_code = $2',
      [req.user.id, req.countryCode]
    );
    if (!listing.rows.length) return res.json({ listing_id: null, addons: [], available_addons: [] });

    const addons = await db.query(
      'SELECT addon_type, status, activated_at FROM listing_addons WHERE listing_id = $1',
      [listing.rows[0].id]
    );

    const category = listing.rows[0].category;
    const onFreeTrial = listing.rows[0].subscription_tier === 'free_period' || await isFreePeriodActive();
    const sponsoredOn = await isSponsoredEnabled();
    const itemDisplayEligible = ITEM_DISPLAY_CATEGORIES.includes(category);
    const trialMsg = 'Available to subscribed providers only. Subscribe to unlock.';
    const activeSet = new Set(addons.rows.filter((a) => a.status === 'active').map((a) => a.addon_type));
    const available = [
      { type: 'photo_gallery',    ...ADDON_PRICES.photo_gallery,    available: true },
      { type: 'item_display',     ...ADDON_PRICES.item_display,     available: itemDisplayEligible },
      { type: 'item_display_pro', ...ADDON_PRICES.item_display_pro, available: itemDisplayEligible && (!onFreeTrial || activeSet.has('item_display_pro')), unavailable_reason: onFreeTrial && !activeSet.has('item_display_pro') ? trialMsg : null },
      { type: 'featured_listing', ...ADDON_PRICES.featured_listing, available: sponsoredOn, unavailable_reason: sponsoredOn ? null : 'Sponsored listings are not yet available. Contact us to get set up.' },
      { type: 'bridgepro_plus',   ...ADDON_PRICES.bridgepro_plus,   available: !onFreeTrial || activeSet.has('bridgepro_plus'), unavailable_reason: onFreeTrial && !activeSet.has('bridgepro_plus') ? trialMsg : null },
      { type: 'first_impression', ...ADDON_PRICES.first_impression, available: true },
    ];

    res.json({
      listing_id: listing.rows[0].id,
      category,
      addons: addons.rows,
      available_addons: available,
    });
  } catch (err) {
    next(err);
  }
});

// POST /addons/activate — activate an addon (admin grants it, or self-serve after payment)
router.post('/activate', ...requireRole('provider', 'admin'), async (req, res, next) => {
  try {
    const { addon_type, listing_id: targetListingId } = req.body;
    if (!ADDON_PRICES[addon_type]) {
      return res.status(400).json({ error: `Unknown addon: ${addon_type}` });
    }

    let listingResult;
    if (req.user.role === 'admin' && targetListingId) {
      listingResult = await db.query(
        'SELECT id, category, subscription_tier FROM listings WHERE id = $1',
        [targetListingId]
      );
    } else {
      listingResult = await db.query(
        'SELECT id, category, subscription_tier FROM listings WHERE user_id = $1 AND country_code = $2',
        [req.user.id, req.countryCode]
      );
    }
    if (!listingResult.rows.length) return res.status(404).json({ error: 'No listing found' });
    const listing = listingResult.rows[0];

    if (req.user.role !== 'admin') {
      const TRIAL_RESTRICTED = ['bridgepro_plus', 'item_display_pro'];
      const freePeriodOn = listing.subscription_tier === 'free_period' || await isFreePeriodActive();
      if (TRIAL_RESTRICTED.includes(addon_type) && freePeriodOn) {
        return res.status(403).json({ error: 'This add-on is only available to subscribed providers. Please subscribe to unlock.' });
      }

      if (addon_type === 'item_display' && !ITEM_DISPLAY_CATEGORIES.includes(listing.category)) {
        return res.status(400).json({ error: `Item display is not available for the "${listing.category}" category` });
      }

      if (addon_type === 'featured_listing') {
        const sponsoredOn = await isSponsoredEnabled();
        if (!sponsoredOn) {
          return res.status(403).json({ error: 'Sponsored listings are not yet available. Contact us to get set up.' });
        }
      }
    }

    await db.query(
      `INSERT INTO listing_addons (id, listing_id, country_code, addon_type, status)
       VALUES ($1, $2, $3, $4, 'active')
       ON CONFLICT (listing_id, addon_type)
       DO UPDATE SET status = 'active', activated_at = NOW(), cancelled_at = NULL`,
      [uuidv4(), listing.id, req.countryCode, addon_type]
    );

    res.json({
      message: `${ADDON_PRICES[addon_type].label} activated`,
      addon_type,
      monthly_cost_xcd: ADDON_PRICES[addon_type].monthly_xcd,
    });
  } catch (err) {
    next(err);
  }
});

// POST /addons/cancel
router.post('/cancel', ...requireRole('provider', 'admin'), async (req, res, next) => {
  try {
    const { addon_type, listing_id: targetListingId } = req.body;

    let listingId;
    if (req.user.role === 'admin' && targetListingId) {
      listingId = targetListingId;
    } else {
      const listing = await db.query(
        'SELECT id FROM listings WHERE user_id = $1 AND country_code = $2',
        [req.user.id, req.countryCode]
      );
      if (!listing.rows.length) return res.status(404).json({ error: 'No listing found' });
      listingId = listing.rows[0].id;
    }

    await db.query(
      `UPDATE listing_addons SET status = 'cancelled', cancelled_at = NOW()
       WHERE listing_id = $1 AND addon_type = $2`,
      [listingId, addon_type]
    );

    res.json({ message: `${addon_type} cancelled` });
  } catch (err) {
    next(err);
  }
});

// Admin: get addon status for any listing
router.get('/admin/status/:listingId', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { listingId } = req.params;
    const addons = await db.query(
      'SELECT addon_type, status, activated_at FROM listing_addons WHERE listing_id = $1',
      [listingId]
    );
    res.json({ listing_id: listingId, addons: addons.rows });
  } catch (err) {
    next(err);
  }
});

// Admin: activate addon for any listing (after payment confirmed)
router.post('/admin/grant', ...requireRole('admin'), async (req, res, next) => {
  try {
    const { listing_id, addon_type } = req.body;
    if (!ADDON_PRICES[addon_type]) return res.status(400).json({ error: 'Unknown addon' });

    await db.query(
      `INSERT INTO listing_addons (id, listing_id, country_code, addon_type, status)
       VALUES ($1, $2, $3, $4, 'active')
       ON CONFLICT (listing_id, addon_type)
       DO UPDATE SET status = 'active', activated_at = NOW(), cancelled_at = NULL`,
      [uuidv4(), listing_id, req.countryCode, addon_type]
    );

    res.json({ message: `${addon_type} granted to listing ${listing_id}` });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
