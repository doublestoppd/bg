import { incrementCounter } from '../db/request-counters.js';

// Rate limiting backed by the request_counters table, so limits hold
// across server restarts and between several server processes.
//
// Fixed windows: time is cut into slices of windowMs, and each slice has
// its own counter per key. A visitor may make maxAttempts requests per
// slice; further requests in that slice get a 429 page.
//
//   scope        names the limit in the table, e.g. 'login:ip'
//   keyFrom      picks who is being counted; defaults to the client IP.
//                Pass (req) => req.currentUser.id for per-account limits.
//   maxAttempts  requests allowed per window
//   windowMs     window length
export function createRateLimiter({ scope, keyFrom = (req) => req.ip, maxAttempts, windowMs }) {
  return async function rateLimit(req, res, next) {
    try {
      const key = String(keyFrom(req));
      const now = Date.now();
      const windowStart = new Date(now - (now % windowMs));
      const count = await incrementCounter(req.app.locals.db, scope, key, windowStart);

      if (count > maxAttempts) {
        const retryAfterSeconds = Math.ceil((windowStart.getTime() + windowMs - now) / 1000);
        res.set('Retry-After', String(retryAfterSeconds));
        return res.status(429).render('error', {
          title: 'Slow down',
          message: `Too many attempts. Please wait ${Math.ceil(retryAfterSeconds / 60)} minute(s) and try again.`,
        });
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
