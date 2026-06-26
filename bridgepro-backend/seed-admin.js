const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const db = require('./src/db');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error('Error: ADMIN_PASSWORD is not set in .env');
  process.exit(1);
}

const ADMIN = {
  email: process.env.ADMIN_EMAIL || 'traxy4444@gmail.com',
  password: ADMIN_PASSWORD,
  full_name: 'Admin',
  phone: null,
  country_code: 'SVG',
};

(async () => {
  const existing = await db.query('SELECT id FROM users WHERE email = $1', [ADMIN.email]);
  if (existing.rows.length) {
    const password_hash = await bcrypt.hash(ADMIN.password, 12);
    await db.query("UPDATE users SET role = 'admin', password_hash = $1 WHERE email = $2", [password_hash, ADMIN.email]);
    console.log(`User already exists — promoted ${ADMIN.email} to admin and updated password.`);
    process.exit(0);
  }

  const password_hash = await bcrypt.hash(ADMIN.password, 12);
  await db.query(
    `INSERT INTO users (id, country_code, email, password_hash, full_name, phone, role, is_verified)
     VALUES ($1, $2, $3, $4, $5, $6, 'admin', true)`,
    [uuidv4(), ADMIN.country_code, ADMIN.email, password_hash, ADMIN.full_name, ADMIN.phone]
  );

  console.log(`Admin created: ${ADMIN.email}`);
  process.exit(0);
})().catch((err) => { console.error(err.message); process.exit(1); });
