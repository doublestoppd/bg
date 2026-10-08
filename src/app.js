import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import config from './config.js';
import site from './site.js';
import { navigationFor } from './navigation.js';
import { SqliteSessionStore } from './db/sessions.js';
import { csrfProtection } from './middleware/csrf.js';
import homeRoutes from './routes/home.js';

const srcDir = path.dirname(fileURLToPath(import.meta.url));

// Builds the Express application. server.js calls this and starts listening;
// the tests call it with an in-memory database and never touch the network.
export function createApp({ db }) {
  const app = express();

  app.locals.db = db;
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
      secure: config.isProduction,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    },
  }));

  app.use(csrfProtection);

  // Values every template can use.
  app.use((req, res, next) => {
    res.locals.site = site;
    res.locals.currentUser = null;
    res.locals.navigation = navigationFor(null);
    next();
  });

  // --- Routes ---

  app.use('/', homeRoutes);

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
