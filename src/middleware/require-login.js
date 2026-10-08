// Sends guests to the login page. Use on any route that needs a player.
export function requireLogin(req, res, next) {
  if (!req.currentUser) {
    return res.redirect('/login');
  }
  next();
}
