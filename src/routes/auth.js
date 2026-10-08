import { Router } from 'express';
import { GameRuleError } from '../game/errors.js';
import { registerAccount, authenticate } from '../game/accounts.js';

const router = Router();

router.get('/register', (req, res) => {
  if (req.currentUser) return res.redirect('/');
  res.render('register', { title: 'Create an account', error: null, username: '' });
});

router.post('/register', async (req, res, next) => {
  try {
    const user = await registerAccount(req.app.locals.db, {
      username: req.body.username,
      password: req.body.password,
    });
    logIn(req, res, next, user);
  } catch (error) {
    if (error instanceof GameRuleError) {
      return res.status(400).render('register', {
        title: 'Create an account',
        error: error.message,
        username: req.body.username || '',
      });
    }
    next(error);
  }
});

router.get('/login', (req, res) => {
  if (req.currentUser) return res.redirect('/');
  res.render('login', { title: 'Log in', error: null, username: '' });
});

router.post('/login', async (req, res, next) => {
  try {
    const user = await authenticate(req.app.locals.db, {
      username: req.body.username,
      password: req.body.password,
    });
    logIn(req, res, next, user);
  } catch (error) {
    if (error instanceof GameRuleError) {
      return res.status(400).render('login', {
        title: 'Log in',
        error: error.message,
        username: req.body.username || '',
      });
    }
    next(error);
  }
});

router.post('/logout', (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie('bg.sid');
    res.redirect('/');
  });
});

// Starts a fresh session for the user. Regenerating the session id on login
// prevents an attacker from planting a known session id in advance.
function logIn(req, res, next, user) {
  req.session.regenerate((error) => {
    if (error) return next(error);
    req.session.userId = user.id;
    res.redirect('/');
  });
}

export default router;
