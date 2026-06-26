const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');

const { authRateLimit, apiRateLimit } = require('./middleware/rateLimit');
const countryMiddleware = require('./middleware/country');
const marketGuard      = require('./middleware/marketGuard');
const { getMarketConfig, getAllMarketConfigs, getRegionalLink } = require('./config/countries');

const authRoutes = require('./routes/auth');
const listingRoutes = require('./routes/listings');
const transactionRoutes = require('./routes/transactions');
const reviewRoutes = require('./routes/reviews');
const verifyRoutes = require('./routes/verify');
const pointsRoutes = require('./routes/points');
const adminRoutes = require('./routes/admin');
const photosRoutes = require('./routes/photos');
const itemsRoutes = require('./routes/items');
const addonsRoutes = require('./routes/addons');
const providerRoutes = require('./routes/provider');
const customerRoutes = require('./routes/customer');
const categoriesRoutes = require('./routes/categories');
const enquiriesRoutes = require('./routes/enquiries');
const pushRoutes = require('./routes/push');
const notificationsRoutes = require('./routes/notifications');
const jobsRoutes = require('./routes/jobs');
const partnersRoutes = require('./routes/partners');
const reportsRoutes = require('./routes/reports');
const cmsRoutes     = require('./routes/cms');
const connectRoutes = require('./routes/connect');
const socialRoutes  = require('./routes/social');
const aiRoutes      = require('./routes/ai');
const agentRoutes   = require('./routes/agent');
const receiptRoutes = require('./routes/receipt');
const productsRoutes = require('./routes/products');
const adsRoutes      = require('./routes/ads');
const userRoutes     = require('./routes/user');
const walletRoutes   = require('./routes/wallet');
const activityRoutes = require('./routes/activity');
const vcleanRoutes   = require('./routes/vclean');
const widgetRoutes   = require('./routes/widget');
const ingestRoutes   = require('./routes/ingest');
const claimRoutes    = require('./routes/claim');
const newsRoutes     = require('./routes/news');
const financeRoutes  = require('./routes/finance');
const payrollRoutes  = require('./routes/payroll');
const { router: billingRoutes } = require('./routes/billing');

/* Start RSS background service (fetches every 6h, runs immediately on boot) */
require('./services/rssService');

const app = express();
app.set('trust proxy', 1);

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : [
      'https://bridgepro.a3tech.uk',
      'https://api.bridgepro.a3tech.uk',
      'https://connek.a3tech.uk',
      'http://localhost:3000',
      'http://localhost:5173',
    ];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-country-code', 'x-client'],
};

// Widget OPTIONS handled before global cors so it can use origin: '*'
app.options('/api/widget/*', cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.options('*', cors(corsOptions));
app.use(cors(corsOptions));

app.use(helmet());

app.use(express.json({ limit: '10mb' }));

// Local file serving (dev only — photos go to R2 in production)
const uploadsRoot = process.env.UPLOAD_DIR || path.join(__dirname, '../uploads');
app.use('/media',   express.static(path.join(uploadsRoot, 'media')));
app.use('/uploads', express.static(uploadsRoot));
app.use('/uploads/agent-temp', express.static('/tmp/agent-uploads'));

// Sitemap — registered before API routes and middleware
app.use('/sitemap.xml', require('./routes/sitemap'));

// Geolocate endpoint — registered before countryMiddleware to avoid header bootstrapping loops
app.get('/api/auth/geolocate', (req, res) => {
  const ipCountry = req.headers['cf-ipcountry'] || '';
  const mapping = { VC: 'SVG', LC: 'SLU', GD: 'GRD', BB: 'BRB' };
  const resolved = mapping[ipCountry.toUpperCase()] || 'SVG';
  res.json({ country: resolved });
});
app.get('/api/v1/auth/geolocate', (req, res) => {
  const ipCountry = req.headers['cf-ipcountry'] || '';
  const mapping = { VC: 'SVG', LC: 'SLU', GD: 'GRD', BB: 'BRB' };
  const resolved = mapping[ipCountry.toUpperCase()] || 'SVG';
  res.json({ country: resolved });
});

// Widget routes registered before countryMiddleware — no X-Country-Code required
app.use('/api/widget', widgetRoutes);
// Receipt downloads are public file-serve endpoints — no country header required
app.use('/api/ai/receipt', receiptRoutes);
// POS ingest uses x-api-key auth — no country header required from POS machines
app.use('/api/ingest', ingestRoutes);
// Document verification is a public page — no auth or country header required
// Also catch /verified/doc/:token (typo-friendly alias) and bare /verify/doc/:token
app.get(['/api/v1/verify/doc/:token', '/verify/doc/:token', '/verified/doc/:token'], async (req, res, next) => {
  try {
    const { verifyHtml, lookupSignature } = require('./routes/verify');
    const sig = await lookupSignature(req.params.token);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(verifyHtml(sig ? { valid: true, ...sig } : { valid: false, token: req.params.token }));
  } catch (err) { next(err); }
});

// Country header required on all API routes
app.use('/api', countryMiddleware);

// Public market config — must be registered BEFORE marketGuard so non-live
// countries can still fetch their own config (e.g. to render a coming-soon page)
app.get('/api/v1/config/market', async (req, res) => {
  try {
    const market = await getMarketConfig(req.countryCode);
    if (!market) return res.status(404).json({ error: 'Unknown country' });
    res.json({ market });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get('/api/v1/config/markets', async (_req, res) => {
  try {
    res.json({ markets: await getAllMarketConfigs() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// BridgePro+ inter-island deep-link resolver
app.get('/api/v1/regional-link/:listingId/:targetCode', (req, res) => {
  const link = getRegionalLink(req.params.listingId, req.params.targetCode.toUpperCase());
  res.json({ link, full: `${req.protocol}://${req.hostname}${link}` });
});

// Block all non-exempt routes for countries that are not yet live
app.use('/api', marketGuard);

// Rate limiting
app.use('/api/v1/auth', authRateLimit);
app.use('/api', apiRateLimit);

// Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/listings', listingRoutes);
app.use('/api/v1/transactions', transactionRoutes);
app.use('/api/v1/reviews', reviewRoutes);
app.use('/api/v1/verify', verifyRoutes);
app.use('/api/v1/points', pointsRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/photos', photosRoutes);
app.use('/api/v1/items', itemsRoutes);
app.use('/api/v1/addons', addonsRoutes);
app.use('/api/v1/provider', providerRoutes);
app.use('/api/v1/customer', customerRoutes);
app.use('/api/v1/categories', categoriesRoutes);
app.use('/api/v1/enquiries', enquiriesRoutes);
app.use('/api/v1/push', pushRoutes);
app.use('/api/v1/notifications', notificationsRoutes);
app.use('/api/v1/jobs', jobsRoutes);
app.use('/api/v1/partners', partnersRoutes);
app.use('/api/v1/reports', reportsRoutes);
app.use('/api/v1/cms',     cmsRoutes);
app.use('/api/connect',    connectRoutes);
app.use('/api/social',     socialRoutes);
app.use('/api/ai',         aiRoutes);
app.use('/api/v1/ai',      aiRoutes);
app.use('/api/ai/agent',   agentRoutes);
app.use('/api/v1/ai/agent', agentRoutes);
app.use('/api/v1/products', productsRoutes);
app.use('/api/v1/ads',     adsRoutes);
app.use('/api/v1/mini-apps', require('./routes/miniapps'));
app.use('/api/v1/tasks',        require('./routes/tasks'));
app.use('/api/v1/appointments', require('./routes/appointments'));
app.use('/api/v1/user',       userRoutes);
app.use('/api/v1/wallet',     walletRoutes);
app.use('/api/v1/activity',  activityRoutes);
app.use('/api/v1/vclean',    vcleanRoutes);
app.use('/api/claim',        claimRoutes);
app.use('/api/v1/claim',     claimRoutes);
app.use('/api/news',         newsRoutes);
app.use('/api/v1/finance',  financeRoutes);
app.use('/api/v1/payroll', payrollRoutes);
app.use('/api/v1/billing', billingRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

module.exports = app;
