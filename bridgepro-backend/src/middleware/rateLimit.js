const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const Redis = require('ioredis');

let redisReady = false;
let redisClient;

const _r = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  lazyConnect: true,
  enableOfflineQueue: false,
  retryStrategy: () => null,
});

// Error handler must be registered before connect() to avoid uncaught crash
_r.on('error', () => { redisReady = false; });

_r.connect()
  .then(() => { redisClient = _r; redisReady = true; })
  .catch(() => { console.warn('Redis unavailable — using in-memory rate limiting'); });

// Lazily creates the real store on the first request, by which time
// the async connect() will have resolved and redisReady will be accurate.
function makeLazyStore() {
  let inner = null;
  let savedOpts = {};

  return {
    init(options) { savedOpts = options; },
    async increment(key) {
      if (!inner) {
        inner = (redisReady && redisClient)
          ? new RedisStore({ sendCommand: (...args) => redisClient.call(...args) })
          : new rateLimit.MemoryStore();
        if (typeof inner.init === 'function') inner.init(savedOpts);
      }
      return inner.increment(key);
    },
    async decrement(key) { return inner?.decrement(key); },
    async resetKey(key) { return inner?.resetKey(key); },
  };
}

/* General auth route limit — covers refresh, profile, SSO, etc.
   Kept generous because every Connek boot makes several /auth hits. */
const authRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  store: makeLazyStore(),
  message: { error: 'Too many requests, please slow down' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { singleCount: false },
});

/* Strict limit on actual login attempts only */
const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  store: makeLazyStore(),
  message: { error: 'Too many login attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { singleCount: false },
});

const apiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  store: makeLazyStore(),
  message: { error: 'Too many requests, please slow down' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { singleCount: false },
});

module.exports = { authRateLimit, apiRateLimit, loginRateLimit };
