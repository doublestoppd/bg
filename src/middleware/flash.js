// A one-shot message shown on the next page, used after a form redirect
// ("Pebbles ate the Soggy Biscuit"). Routes set req.session.flash to
// { type: 'success' | 'error', text }; this moves it into the template
// variable `flash` and clears it so it shows exactly once.
export function flashMessages(req, res, next) {
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
}
