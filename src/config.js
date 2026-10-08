// All runtime settings live here. Each one can be overridden with an
// environment variable; the defaults are suitable for local development.

const isProduction = process.env.NODE_ENV === 'production';

const config = {
  isProduction,
  port: Number(process.env.PORT) || 3000,
  databasePath: process.env.DATABASE_PATH || 'data/game.sqlite',
  sessionSecret: process.env.SESSION_SECRET || 'change-me-before-going-live',
};

if (isProduction && config.sessionSecret === 'change-me-before-going-live') {
  throw new Error('SESSION_SECRET must be set when NODE_ENV=production');
}

export default config;
