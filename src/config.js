// All runtime settings live here. Each one is read from an environment
// variable (npm scripts load .env automatically); the defaults are suitable
// for local development. Anything required is checked at startup so a
// misconfigured server fails immediately with a clear message.

const isProduction = process.env.NODE_ENV === 'production';

const config = {
  isProduction,
  port: Number(process.env.PORT) || 3000,
  // PostgreSQL connection string, e.g. postgres://user:pass@host:5432/dbname
  databaseUrl: process.env.DATABASE_URL,
  // A separate database for the test suite, which wipes it before each test.
  testDatabaseUrl: process.env.TEST_DATABASE_URL,
  sessionSecret: process.env.SESSION_SECRET || 'change-me-before-going-live',
  // Set TRUST_PROXY when nginx, Caddy or similar sits in front of the game.
  // It is passed straight to Express's 'trust proxy' setting: a hop count
  // such as 1, or a name such as 'loopback'. Without it, secure cookies are
  // never sent in production and every visitor shares the proxy's IP.
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
};

if (isProduction && config.sessionSecret === 'change-me-before-going-live') {
  throw new Error('SESSION_SECRET must be set when NODE_ENV=production');
}

// Called by server.js and the scripts; the tests check testDatabaseUrl
// themselves so that importing this module never throws for them.
export function requireDatabaseUrl() {
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  }
  return config.databaseUrl;
}

function parseTrustProxy(value) {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

export default config;
