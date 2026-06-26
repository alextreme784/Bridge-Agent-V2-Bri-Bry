require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const db = require('../src/db');
const slugify = require('../src/utils/slugify');

const COUNTRY_CODE = 'SVG';

const CATEGORIES = [
  {
    name: 'Construction & Trades',
    slug: 'construction-trades',
    icon: '🏗️',
    display_order: 0,
    subcategories: [
      'Plumbing', 'Electrical', 'Carpentry & Joinery', 'Masonry & Blockwork',
      'Roofing', 'Welding & Fabrication', 'Painting & Finishing', 'Tiling & Flooring',
      'AC Installation & Repair', 'Solar Panel Installation', 'General Construction', 'Scaffolding',
    ],
  },
  {
    name: 'Automotive',
    slug: 'automotive',
    icon: '🚗',
    display_order: 1,
    subcategories: [
      'Mechanic / Auto Repair', 'Auto Body & Panel Beating', 'Tinting & Detailing',
      'Tyre Services', 'Auto Electrical', 'Upholstery',
    ],
  },
  {
    name: 'Transport & Delivery',
    slug: 'transport-delivery',
    icon: '🚕',
    display_order: 2,
    subcategories: [
      'Taxi / Private Hire', 'Minibus / Charter', 'Courier & Delivery',
      'Moving & Relocation', 'Boat Charter & Water Taxi',
    ],
  },
  {
    name: 'Beauty & Wellness',
    slug: 'beauty-wellness',
    icon: '💇',
    display_order: 3,
    subcategories: [
      'Hair Salon / Braiding', 'Barbershop', 'Nail Technician', 'Makeup Artist',
      'Massage Therapy', 'Spa Services', 'Tattoo & Piercing',
    ],
  },
  {
    name: 'Landscaping & Outdoors',
    slug: 'landscaping-outdoors',
    icon: '🌿',
    display_order: 4,
    subcategories: [
      'Lawn Mowing & Gardening', 'Tree Cutting & Removal', 'Pest Control',
      'Pool Cleaning & Maintenance', 'Agricultural Services', 'Irrigation',
    ],
  },
  {
    name: 'Food & Catering',
    slug: 'food-catering',
    icon: '🍽️',
    display_order: 5,
    subcategories: [
      'Catering Services', 'Private Chef', 'Cake & Pastry', 'Food Vendor / Truck', 'Bartending',
    ],
  },
  {
    name: 'Technology',
    slug: 'technology',
    icon: '💻',
    display_order: 6,
    subcategories: [
      'Computer Repair', 'Phone Repair', 'CCTV & Security Systems', 'Networking & WiFi Setup',
      'Website & App Development', 'Graphic Design', 'Printing Services',
    ],
  },
  {
    name: 'Home Services',
    slug: 'home-services',
    icon: '🏠',
    display_order: 7,
    subcategories: [
      'Cleaning Services', 'Laundry & Ironing', 'Appliance Repair', 'Fumigation',
      'Interior Design', 'Furniture Assembly & Repair',
    ],
  },
  {
    name: 'Education & Training',
    slug: 'education-training',
    icon: '📚',
    display_order: 8,
    subcategories: [
      'Tutoring (Primary)', 'Tutoring (Secondary / CXC)', 'Music Lessons',
      'Driving Instructor', 'Martial Arts / Fitness Training', 'Vocational Training',
    ],
  },
  {
    name: 'Professional Services',
    slug: 'professional-services',
    icon: '⚖️',
    display_order: 9,
    subcategories: [
      'Accounting & Bookkeeping', 'Legal Services', 'Real Estate', 'Insurance Agent',
      'Event Planning', 'Photography & Videography', 'Security Services',
    ],
  },
  {
    name: 'Equipment & Rentals',
    slug: 'equipment-rentals',
    icon: '🔧',
    display_order: 10,
    subcategories: [
      'Tool & Equipment Rental', 'Party & Event Rentals', 'Heavy Equipment Operator',
    ],
  },
  {
    name: 'Garment & Fashion',
    slug: 'garment-fashion',
    icon: '🧵',
    display_order: 11,
    subcategories: [
      'Jersey & Garment Printing', 'Tailoring & Alterations', 'Clothing Design',
      'Embroidery & Customisation', 'Uniform Supplies',
    ],
  },
  {
    name: 'Retail & Trade',
    slug: 'retail-trade',
    icon: '🛒',
    display_order: 12,
    subcategories: [
      'General Retail / Shop', 'Wholesale & Distribution', 'Import & Export',
      'Haberdashery & Fabric', 'Hardware & Building Supplies',
    ],
  },
  {
    name: 'Health & Medical',
    slug: 'health-medical',
    icon: '🏥',
    display_order: 13,
    subcategories: [
      'Private Nursing', 'Physiotherapy', 'Dental Services',
      'Optician', 'Pharmacy', 'Mental Health & Counselling',
    ],
  },
  {
    name: 'Entertainment & Events',
    slug: 'entertainment-events',
    icon: '🎉',
    display_order: 14,
    subcategories: [
      'DJ Services', 'Live Music / Band', 'Event Decoration',
      'MC / Host', 'Sound System Rental', 'Photography & Videography',
    ],
  },
  {
    name: 'Marine & Fishing',
    slug: 'marine-fishing',
    icon: '⚓',
    display_order: 15,
    subcategories: [
      'Boat Repair & Maintenance', 'Fishing Equipment & Supplies',
      'Fish Sales / Vendor', 'Dive Services',
    ],
  },
  {
    name: 'Childcare & Domestic',
    slug: 'childcare-domestic',
    icon: '👶',
    display_order: 16,
    subcategories: [
      'Babysitting / Nanny', 'Domestic Worker / Housekeeper', 'Elderly Care',
    ],
  },
];

(async () => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    let newCats = 0;
    let newSubs = 0;

    for (const cat of CATEGORIES) {
      // Upsert category — skip if slug already exists for this country
      const catResult = await client.query(
        `INSERT INTO categories (id, name, slug, icon, country_code, display_order)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (slug, country_code) DO UPDATE SET updated_at = NOW()
         RETURNING id, (xmax = 0) AS inserted`,
        [uuidv4(), cat.name, cat.slug, cat.icon, COUNTRY_CODE, cat.display_order]
      );
      const categoryId = catResult.rows[0].id;
      const isNew = catResult.rows[0].inserted;
      if (isNew) newCats++;

      // Insert subcategories — skip any that already exist by name in this category
      for (const [i, subName] of cat.subcategories.entries()) {
        const exists = await client.query(
          'SELECT id FROM subcategories WHERE category_id = $1 AND LOWER(name) = LOWER($2)',
          [categoryId, subName]
        );
        if (!exists.rows.length) {
          await client.query(
            `INSERT INTO subcategories (id, category_id, name, slug, is_other, status, country_code, display_order)
             VALUES ($1, $2, $3, $4, false, 'active', $5, $6)`,
            [uuidv4(), categoryId, subName, slugify(subName), COUNTRY_CODE, i]
          );
          newSubs++;
        }
      }

      // Other subcategory
      const otherExists = await client.query(
        `SELECT id FROM subcategories WHERE category_id = $1 AND is_other = true`,
        [categoryId]
      );
      if (!otherExists.rows.length) {
        await client.query(
          `INSERT INTO subcategories (id, category_id, name, slug, is_other, status, country_code, display_order)
           VALUES ($1, $2, 'Other', 'other', true, 'active', $3, 999)`,
          [uuidv4(), categoryId, COUNTRY_CODE]
        );
        newSubs++;
      }

      console.log(`  ${isNew ? '✓' : '–'} ${cat.name}`);
    }

    await client.query('COMMIT');
    console.log(`\nDone. ${newCats} new categories, ${newSubs} new subcategories added.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await db.pool.end();
  }
})().catch((err) => { console.error('[SEED ERROR]', err.message); process.exit(1); });
