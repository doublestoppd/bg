import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import config from './config.js';
import site from './site.js';
import { SqliteSessionStore } from './db/sessions.js';
import { csrfProtection } from './middleware/csrf.js';
import { createRateLimiter } from './middleware/rate-limit.js';
import { loadCurrentUser } from './middleware/current-user.js';
import { flashMessages } from './middleware/flash.js';
import homeRoutes from './routes/home.js';
import authRoutes from './routes/auth.js';
import petRoutes from './routes/pets.js';
import inventoryRoutes from './routes/inventory.js';
import shopRoutes from './routes/shops.js';

const srcDir = path.dirname(fileURLToPath(import.meta.url));

// Builds the Express application. server.js calls this and starts listening;
// the tests call it with an in-memory database and never touch the network.
// trustProxy and secureCookies default to the config values; tests override
// them to check behaviour behind a reverse proxy.
export function createApp({ db, trustProxy = config.trustProxy, secureCookies = config.isProduction }) {
  const app = express();

  app.locals.db = db;
  // Lets req.ip and req.secure reflect the real client when a reverse proxy
  // forwards requests. express-session reads the same setting to decide
  // whether a 'secure' cookie may be sent.
  app.set('trust proxy', trustProxy);
  app.set('view engine', 'ejs');
  app.set('views', path.join(srcDir, 'views'));

  // --- Middleware, in the order every request passes through it ---

  app.use(express.static(path.join(srcDir, 'public')));
  app.use(express.urlencoded({ extended: false }));

  app.use(session({
    store: new SqliteSessionStore(db),
    secret: config.sessionSecret,
    name: 'bg.sid',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookies,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    },
  }));

  app.use((req, res, next) => {
    res.locals.site = site;
    next();
  });
  app.use(loadCurrentUser);
  app.use(flashMessages);

  // Must come after loadCurrentUser so that a rejected form can still
  // render the page frame with the right menu.
  app.use(csrfProtection);

  // --- Routes ---

  // Slow down password guessing and bulk account creation. These run before
  // the matching handlers in authRoutes and only count attempts per IP.
  app.post('/login', createRateLimiter({ maxAttempts: 10, windowMs: 15 * 60 * 1000 }));
  app.post('/register', createRateLimiter({ maxAttempts: 5, windowMs: 60 * 60 * 1000 }));

  app.use('/', homeRoutes);
  app.use('/', authRoutes);
  app.use('/pets', petRoutes);
  app.use('/inventory', inventoryRoutes);
  app.use('/shops', shopRoutes);

  // --- Error pages ---

  app.use((req, res) => {
    res.status(404).render('error', {
      title: 'Page not found',
      message: 'There is nothing here. Perhaps it wandered off.',
    });
  });

  // Express recognises an error handler by its four parameters.
  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    console.error(error);
    res.status(500).render('error', {
      title: 'Something went wrong',
      message: 'The game hiccuped. Please try again in a moment.',
    });
  });

  return app;
}
