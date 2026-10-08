import crypto from 'node:crypto';

// Cross-site request forgery protection using a token stored in the session.
// Every form in the site includes <input type="hidden" name="_csrf"> with the
// token (see views/partials/csrf.ejs). Any request that changes state must
// send it back, or it is rejected. Must run after the session and body
// parsing middleware.
export function csrfProtection(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;

  const isSafeMethod = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
  if (isSafeMethod) return next();

  const submitted = req.body && req.body._csrf;
  if (typeof submitted === 'string' && tokensMatch(submitted, req.session.csrfToken)) {
    return next();
  }

  res.status(403).render('error', {
    title: 'Form expired',
    message: 'That form has expired or was tampered with. Please go back and try again.',
  });
}

function tokensMatch(a, b) {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  return bufferA.length === bufferB.length && crypto.timingSafeEqual(bufferA, bufferB);
}
