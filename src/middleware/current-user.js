import { findUserById } from '../db/users.js';
import { navigationFor } from '../navigation.js';

// If the session says someone is logged in, load their user row and make it
// available to routes (req.currentUser) and templates (currentUser). Also
// picks the right navigation menu for them.
export async function loadCurrentUser(req, res, next) {
  try {
    let user = null;
    if (req.session.userId) {
      user = await findUserById(req.app.locals.db, req.session.userId);
      if (!user) {
        // The account no longer exists; forget the stale session.
        delete req.session.userId;
      }
    }
    req.currentUser = user;
    res.locals.currentUser = user;
    res.locals.navigation = navigationFor(user);
    next();
  } catch (error) {
    next(error);
  }
}
