// All runtime settings live here. Each one can be overridden with an
// environment variable; the defaults are suitable for local development.

const isProduction = process.env.NODE_ENV === 'production';

const config = {
  isProduction,
  port: Number(process.env.PORT) || 3000,
  databasePath: process.env.DATABASE_PATH || 'data/game.sqlite',
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

function parseTrustProxy(value) {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

export default config;
